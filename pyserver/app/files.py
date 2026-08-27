"""Workspace file management: list, read, upload, delete, clean.

Every path here is resolved and checked against the workspace root before it is
touched. The check uses the *resolved* path, so `../` and symlinks are caught -
a relative path that looks contained can still point anywhere.

Directories carry meaning, and the cleanup rules follow it:

    original/   frozen source snapshots. Never cleaned; losing these loses the
                only reference the diff is computed against.
    uploads/    files the user provided. Never cleaned - only they can delete
                what they chose to put here.
    scripts/    agent-written .py plus the generated helper. Cleanable.
    skills/     the user's enabled script skills, copied in per run. Read-only
                here; the source of truth is the skills table.
    scratch/    throwaway. Cleanable, and that is what it is for.
    out/        deliverables. Cleanable, but only on request: the user may not
                have downloaded them yet.
    .scratch/   ours - the scoped snapshot and the proposal spool. Cleanable
                and regenerated on the next run.
"""
from __future__ import annotations

import base64
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import log, workspace

# Directory -> (may the panel delete files here, is it cleaned by "정리")
AREAS: dict[str, tuple[bool, bool]] = {
    "original": (False, False),
    "uploads": (True, False),
    "scripts": (True, True),
    # Rebuilt from the skills table on every run, so deleting a file here is
    # pointless rather than harmful - the panel shows them read-only.
    "skills": (False, True),
    "scratch": (True, True),
    "out": (True, True),
    ".scratch": (False, True),
}

# Preview and upload ceilings. A transcript export can legitimately be large,
# but nothing here needs to be read into a JSON response whole.
MAX_PREVIEW = 256 * 1024
MAX_UPLOAD = 32 * 1024 * 1024

TEXTUAL = {".md", ".txt", ".json", ".jsonl", ".py", ".csv", ".html", ".htm",
           ".css", ".js", ".yaml", ".yml", ".xml", ".log", ".sql"}


class FileError(ValueError):
    pass


def _root(char_key: str) -> Path:
    return workspace.root(char_key).resolve()


def _resolve(char_key: str, rel: str) -> Path:
    """Resolve a workspace-relative path, refusing anything that escapes."""
    root = _root(char_key)
    if not rel or rel in (".", "/"):
        return root
    candidate = (root / rel.replace("\\", "/").lstrip("/")).resolve()
    # Compare resolved paths: `../` and symlinks both disappear into the
    # resolution, so checking the raw string would miss them.
    if candidate != root and root not in candidate.parents:
        raise FileError(f"워크스페이스 밖의 경로입니다: {rel}")
    return candidate


def listing(char_key: str) -> dict:
    """Every file in the workspace, grouped by area, with sizes."""
    root = _root(char_key)
    areas = []
    total = 0
    for name, (deletable, cleanable) in AREAS.items():
        d = root / name
        files = []
        size = 0
        if d.is_dir():
            for f in sorted(d.rglob("*")):
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                except OSError:
                    continue
                size += st.st_size
                files.append({
                    "path": f.relative_to(root).as_posix(),
                    "name": f.name,
                    "size": st.st_size,
                    "modified": st.st_mtime,
                    "textual": f.suffix.lower() in TEXTUAL,
                })
        total += size
        dirs = sorted(
            d.relative_to(root).as_posix() for d in (d.rglob("*") if d.is_dir() else [])
            if d.is_dir() and not d.name.startswith(".")
        ) if d.is_dir() else []
        areas.append({
            "area": name,
            "deletable": deletable,
            "cleanable": cleanable,
            "count": len(files),
            "size": size,
            "files": files,
            # Folders, empty ones included - the files tab draws them and
            # offers them as move targets.
            "dirs": dirs,
        })
    return {"charKey": char_key, "root": str(root), "totalSize": total, "areas": areas}


def read(char_key: str, rel: str) -> dict:
    path = _resolve(char_key, rel)
    if not path.is_file():
        raise FileError(f"파일이 없습니다: {rel}")
    size = path.stat().st_size
    if path.suffix.lower() not in TEXTUAL:
        return {"path": rel, "size": size, "textual": False,
                "content": "", "note": "텍스트 파일이 아니라 미리보기를 건너뛰었습니다"}
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "path": rel,
        "size": size,
        "textual": True,
        "truncated": len(text) > MAX_PREVIEW,
        "content": text[:MAX_PREVIEW],
    }


def upload(char_key: str, name: str, *, text: str | None = None,
           base64_data: str | None = None, into: str = "", extract: bool = False) -> dict:
    """Store a user-provided file under uploads/ (or out/).

    The name is reduced to its basename: an upload is never allowed to choose
    where in the tree it lands. `into` picks the folder, which may be nested
    (`uploads/참고/2장`) and is created on demand - a dropped folder tree
    arrives as one upload per file, each naming its own subfolder.

    `extract` unpacks a .zip into a folder named after it instead of storing
    the archive: the way to bring fifty files over in one drop.
    """
    safe = Path(name or "upload").name.strip() or "upload"
    root = _root(char_key)
    # `into` is a folder the files tab chose; it has to stay inside a
    # writable area (uploads/ is the default; out/ is allowed so a person can
    # put a deliverable back where the agent left it).
    target = into or "uploads"
    area = target.replace("\\", "/").lstrip("/").split("/")[0]
    if area not in ("uploads", "out"):
        raise FileError(f"uploads/ 또는 out/ 안의 폴더여야 합니다: {into}")
    dest = _folder(char_key, target, area) / safe
    dest.parent.mkdir(parents=True, exist_ok=True)
    rel = dest.relative_to(root).as_posix()

    if base64_data is not None:
        try:
            raw = base64.b64decode(base64_data, validate=True)
        except Exception as e:  # noqa: BLE001
            raise FileError(f"base64 를 해석하지 못했습니다: {e}") from e
        if len(raw) > MAX_UPLOAD:
            raise FileError(f"파일이 너무 큽니다 ({len(raw)} 바이트, 최대 {MAX_UPLOAD})")
        if extract and safe.lower().endswith(".zip"):
            return _extract_zip(char_key, dest.parent, safe, raw)
        dest.write_bytes(raw)
        size = len(raw)
    elif text is not None:
        if len(text.encode("utf-8")) > MAX_UPLOAD:
            raise FileError("파일이 너무 큽니다")
        dest.write_text(text, encoding="utf-8")
        size = dest.stat().st_size
    else:
        raise FileError("text 또는 base64 중 하나가 필요합니다")

    log.info("upload char=%s path=%s size=%s", char_key, rel, size)
    return {"path": rel, "name": safe, "size": size}


def upload_many(char_key: str, into: str, entries: list[dict], data: bytes, *, extract: bool = False) -> dict:
    """Many files from one binary body - the folder drop.

    `entries` is the header's list ({name, rel, size}) and `data` the files'
    bytes back to back in that order. One request per file was the reason a
    thousand-asset folder took minutes: each file cost a base64 encode, a
    JSON parse, and a round trip through the tunnel. This costs one round
    trip per ~16MB and no encoding at all.
    """
    root = _root(char_key)
    target = (into or "uploads").replace("\\", "/").strip("/")
    area = target.split("/")[0]
    if area not in ("uploads", "out"):
        raise FileError(f"uploads/ 또는 out/ 안의 폴더여야 합니다: {into}")
    out: list[dict] = []
    offset = 0
    total = 0
    extracted = 0
    for e in entries:
        size = int(e.get("size") or 0)
        if size < 0 or offset + size > len(data):
            raise FileError("본문 길이가 헤더와 맞지 않습니다")
        chunk = data[offset:offset + size]
        offset += size
        safe = Path(str(e.get("name") or "upload")).name.strip() or "upload"
        rel = str(e.get("rel") or "").replace("\\", "/").strip("/")
        if ".." in rel.split("/"):
            raise FileError(f"잘못된 하위 경로입니다: {rel}")
        folder = _folder(char_key, target + ("/" + rel if rel else ""), area)
        if size > MAX_UPLOAD:
            raise FileError(f"{safe}: 파일이 너무 큽니다 ({size} 바이트, 최대 {MAX_UPLOAD})")
        if extract and safe.lower().endswith(".zip"):
            r = _extract_zip(char_key, folder, safe, bytes(chunk))
            extracted += int(r.get("extracted") or 0)
            out.append(r)
            continue
        dest = folder / safe
        dest.write_bytes(chunk)
        total += size
        out.append({"path": dest.relative_to(root).as_posix(), "name": safe, "size": size})
    log.info("upload-many char=%s into=%s files=%s size=%s extracted=%s", char_key, target, len(out), total, extracted)
    return {"files": out, "count": len(out), "size": total, "extracted": extracted}


# An extracted archive may not exceed this, however small the zip was: a
# zip bomb is the one upload that could fill the disk from a JSON body.
MAX_EXTRACT = 512 * 1024 * 1024
MAX_EXTRACT_FILES = 5000


def _extract_zip(char_key: str, parent: Path, zip_name: str, raw: bytes) -> dict:
    """Unpack `raw` into parent/<zip stem>/, refusing anything that would
    land outside it. Directory entries and OS junk (__MACOSX, .DS_Store) are
    skipped; nested folders are kept."""
    import io
    import zipfile

    root = _root(char_key)
    stem = Path(zip_name).stem.strip() or "zip"
    folder = parent / stem
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise FileError(f"zip 파일을 읽지 못했습니다: {e}") from e
    total = 0
    count = 0
    with zf:
        members = [m for m in zf.infolist() if not m.is_dir()]
        if len(members) > MAX_EXTRACT_FILES:
            raise FileError(f"zip 안의 파일이 너무 많습니다 ({len(members)}개, 최대 {MAX_EXTRACT_FILES})")
        if sum(m.file_size for m in members) > MAX_EXTRACT:
            raise FileError("zip 을 풀면 너무 큽니다 (최대 512MB)")
        folder.mkdir(parents=True, exist_ok=True)
        for m in members:
            name = m.filename.replace("\\", "/")
            raw_parts = [p for p in name.split("/") if p and p != "."]
            # A member that climbs is dropped whole, not flattened into the
            # folder: an archive that tries to escape is not one to trust.
            if not raw_parts or ".." in raw_parts or name.startswith("/") or ":" in raw_parts[0]:
                continue
            parts = raw_parts
            if parts[0] == "__MACOSX" or parts[-1] == ".DS_Store":
                continue
            out = (folder / Path(*parts)).resolve()
            if folder.resolve() != out and folder.resolve() not in out.parents:
                continue
            out.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(m) as src, out.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            total += m.file_size
            count += 1
    rel = folder.relative_to(root).as_posix()
    log.info("upload char=%s zip=%s -> %s files=%s size=%s", char_key, zip_name, rel, count, total)
    return {"path": rel, "name": stem, "size": total, "extracted": count}


def zip_paths(char_key: str, rels: list[str]) -> tuple[Path, int]:
    """A zip of the given workspace paths (files or folders), written to a
    temp file the caller streams and deletes. Names inside the archive are
    relative to the paths' common parent, so one folder unpacks as itself
    rather than as `uploads/<folder>`."""
    import tempfile
    import zipfile

    targets: list[Path] = []
    for rel in rels:
        p = _resolve(char_key, rel)
        if p == _root(char_key):
            raise FileError("워크스페이스 전체는 받을 수 없습니다")
        if not p.exists():
            raise FileError(f"없습니다: {rel}")
        targets.append(p)
    if not targets:
        raise FileError("받을 파일을 고르지 않았습니다")
    base = targets[0].parent if len(targets) == 1 else Path(os.path.commonpath([str(t.parent) for t in targets]))

    fd, tmp = tempfile.mkstemp(prefix="risuhina-", suffix=".zip")
    os.close(fd)
    out = Path(tmp)
    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        for t in targets:
            files_in = [t] if t.is_file() else sorted(f for f in t.rglob("*") if f.is_file())
            for f in files_in:
                zf.write(f, f.relative_to(base).as_posix())
                count += 1
    log.info("zip char=%s paths=%s files=%s size=%s", char_key, len(rels), count, out.stat().st_size)
    return out, count


def _folder(char_key: str, rel: str, area: str) -> Path:
    """A folder path inside one area (uploads/, out/ ...), created on demand."""
    path = _resolve(char_key, rel)
    root = _root(char_key)
    parts = path.relative_to(root).parts if path != root else ()
    if not parts or parts[0] != area:
        raise FileError(f"{area}/ 안의 폴더여야 합니다: {rel}")
    if path.exists() and not path.is_dir():
        raise FileError(f"폴더가 아닙니다: {rel}")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _area_of(char_key: str, path: Path) -> str:
    root = _root(char_key)
    try:
        return path.relative_to(root).parts[0]
    except (ValueError, IndexError) as e:
        raise FileError("워크스페이스 밖의 경로입니다") from e


def mkdir(char_key: str, rel: str) -> dict:
    """A new folder inside a deletable area. Folders are how the user keeps
    fifty uploads and a season of outputs apart; the agent sees them as paths."""
    path = _resolve(char_key, rel)
    area = _area_of(char_key, path)
    if not AREAS.get(area, (False, False))[0]:
        raise FileError(f"{area}/ 안에는 폴더를 만들 수 없습니다")
    if path.exists():
        raise FileError(f"이미 있습니다: {rel}")
    path.mkdir(parents=True)
    log.info("mkdir char=%s path=%s", char_key, rel)
    return {"path": path.relative_to(_root(char_key)).as_posix()}


def move(char_key: str, src_rel: str, dst_rel: str) -> dict:
    """Move a file or folder within the deletable areas (uploads <-> out is
    fine; nothing enters original/ or leaves the workspace). `dst_rel` may be
    a folder (the name is kept) or a full new path."""
    src = _resolve(char_key, src_rel)
    if not src.exists():
        raise FileError(f"없습니다: {src_rel}")
    if src == _root(char_key):
        raise FileError("워크스페이스 자체는 옮길 수 없습니다")
    dst = _resolve(char_key, dst_rel)
    if dst.is_dir():
        dst = dst / src.name
    for p in (src, dst):
        area = _area_of(char_key, p)
        if not AREAS.get(area, (False, False))[0]:
            raise FileError(f"{area}/ 는 옮길 수 없는 영역입니다")
    if dst.exists():
        raise FileError(f"같은 이름이 이미 있습니다: {dst.relative_to(_root(char_key)).as_posix()}")
    if src.is_dir() and (dst == src or src in dst.parents):
        raise FileError("폴더를 자기 안으로 옮길 수 없습니다")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    out = dst.relative_to(_root(char_key)).as_posix()
    log.info("move char=%s %s -> %s", char_key, src_rel, out)
    return {"from": src_rel, "to": out}


def delete(char_key: str, rel: str) -> dict:
    path = _resolve(char_key, rel)
    root = _root(char_key)
    if path == root:
        raise FileError("워크스페이스 자체는 지울 수 없습니다")
    try:
        area = path.relative_to(root).parts[0]
    except ValueError as e:
        raise FileError("워크스페이스 밖의 경로입니다") from e
    if not AREAS.get(area, (False, False))[0]:
        raise FileError(f"{area}/ 안의 파일은 지울 수 없습니다")
    if not path.exists():
        raise FileError(f"파일이 없습니다: {rel}")
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink()
    log.info("delete char=%s path=%s", char_key, rel)
    return {"deleted": rel}


def clean(char_key: str, areas: list[str] | None = None) -> dict:
    """Empty the cleanable areas. Never touches original/ or uploads/."""
    root = _root(char_key)
    targets = [a for a in (areas or [a for a, (_, c) in AREAS.items() if c])
               if AREAS.get(a, (False, False))[1]]
    removed, freed = 0, 0
    for area in targets:
        d = root / area
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*"), reverse=True):
            try:
                if f.is_file():
                    freed += f.stat().st_size
                    f.unlink()
                    removed += 1
                elif f.is_dir():
                    f.rmdir()
            except OSError:
                continue
    log.info("clean char=%s areas=%s removed=%s freed=%s", char_key, targets, removed, freed)
    return {"areas": targets, "removed": removed, "freed": freed}


def agent_list(char_key: str, rel: str = "") -> str:
    """Directory listing for the agent, as text."""
    path = _resolve(char_key, rel)
    if not path.is_dir():
        raise FileError(f"디렉터리가 아닙니다: {rel or '.'}")
    root = _root(char_key)
    rows = []
    for f in sorted(path.iterdir()):
        try:
            st = f.stat()
        except OSError:
            continue
        kind = "dir " if f.is_dir() else f"{st.st_size:>8}"
        rows.append(f"{kind}  {f.relative_to(root).as_posix()}")
    return "\n".join(rows) or "(비어 있습니다)"


def agent_read(char_key: str, rel: str, limit: int = 40000) -> str:
    path = _resolve(char_key, rel)
    if not path.is_file():
        raise FileError(f"파일이 없습니다: {rel}")
    if path.suffix.lower() not in TEXTUAL:
        return f"({path.name} 은 텍스트 파일이 아닙니다)"
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) > limit:
        return text[:limit] + f"\n… ({len(text)}자 중 {limit}자만 표시)"
    return text


def stats(char_key: str) -> dict[str, Any]:
    data = listing(char_key)
    return {
        "totalSize": data["totalSize"],
        "byArea": {a["area"]: {"count": a["count"], "size": a["size"]} for a in data["areas"]},
        "generatedAt": time.time(),
    }
