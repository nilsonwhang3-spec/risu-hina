"""File management for a scope: list, read, upload, delete, clean.

A **scope** is one of two roots, and every function here takes one:

    SPACE                   the ONE global space every bot shares - the default
    a bot's workspace key   `data/workspace/<key>/` - the bot's SYSTEM dir
                            (frozen originals, machinery), read-only on the wire

The space holds everything the user and the agent actually work with:
projects/ the user manages, studio/ the image library, hina/<봇이름>/ the
agent's per-bot work areas. The SYSTEM directories stay outside it on purpose -
everything inside the space is readable by every bot's sandbox, and another
bot's scope.db must not be.

Every path here is resolved and checked against that scope's root before it is
touched. The check uses the *resolved* path, so `../` and symlinks are caught -
a relative path that looks contained can still point anywhere. That check is
what keeps the SYSTEM dirs out of the space's reach as well.
"""
from __future__ import annotations

import base64
import hashlib
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import log, workspace

# Directory -> (may the panel delete files here, is it cleaned by "정리").
# The SYSTEM view: frozen originals (the diff baseline) and our machinery.
AREAS: dict[str, tuple[bool, bool]] = {
    "original": (False, False),
    # The scoped snapshot and the proposal spool - regenerated on the next run.
    ".scratch": (False, True),
}

# The ONE global space every bot shares. Not a workspace key: `store.char_key`
# always produces "c<hash>", so this can never collide with a bot.
SPACE = "space"

# The space's areas. Nothing here is cleanable globally: projects/ and studio/
# are the user's own material, and hina/ holds every bot's work at once -
# cleanup is a per-bot verb (`clean_bot`), never a broom over the whole space.
SPACE_AREAS: dict[str, tuple[bool, bool]] = {
    # The user's own project folders, one per bot by convention (they manage
    # the structure; the default upload landing).
    "projects": (True, False),
    # The asset studio library (styles/characters/fragments/scenes/images).
    "studio": (True, False),
    # The agent's work areas, one folder per bot name: scripts/scratch/out.
    "hina": (True, False),
    # Ours: the bots.json map and migration manifests. Hidden from the panel
    # by the same rule that hides .scratch.
    ".hina": (False, True),
}

def areas_for(scope: str) -> dict[str, tuple[bool, bool]]:
    return SPACE_AREAS if scope == SPACE else AREAS


def upload_targets(scope: str) -> tuple[tuple[str, ...], str]:
    """Where an upload may land, and where it goes when the caller says nothing.

    Narrower than "deletable" on purpose: in a bot's SYSTEM view nothing is a
    place a person legitimately puts files any more; in the space, everything
    but our own `.hina` is, and projects/ is where reference material arrives.
    """
    if scope == SPACE:
        return tuple(a for a in SPACE_AREAS if not a.startswith(".")), "projects"
    # The SYSTEM view takes no uploads at all.
    return (), ""

# Preview and upload ceilings. A transcript export can legitimately be large,
# but nothing here needs to be read into a JSON response whole.
MAX_PREVIEW = 256 * 1024
MAX_UPLOAD = 32 * 1024 * 1024

TEXTUAL = {".md", ".txt", ".json", ".jsonl", ".py", ".csv", ".html", ".htm",
           ".css", ".js", ".yaml", ".yml", ".xml", ".log", ".sql"}


class FileError(ValueError):
    pass


def _root(scope: str) -> Path:
    if scope == SPACE:
        return workspace.space_root().resolve()
    return workspace.root(scope).resolve()


def _resolve(scope: str, rel: str) -> Path:
    """Resolve a workspace-relative path, refusing anything that escapes."""
    root = _root(scope)
    if not rel or rel in (".", "/"):
        return root
    # Flat-era studio paths (studio/styles, studio/images, studio/.studio)
    # keep resolving after the config/output split - old sidecars, saved
    # specs and the agent's habits all still say them.
    if scope == SPACE:
        rel = workspace.studio_canon(rel)
    candidate = (root / rel.replace("\\", "/").lstrip("/")).resolve()
    # Compare resolved paths: `../` and symlinks both disappear into the
    # resolution, so checking the raw string would miss them.
    if candidate != root and root not in candidate.parents:
        raise FileError(f"워크스페이스 밖의 경로입니다: {rel}")
    return candidate


# The three helper files pyexec.layout()/run_python rewrite on EVERY run -
# hidden by exact name, so agent-authored scripts stay visible (and the @docs
# surfacing keeps seeing them). See pyserver/app/pyexec.py.
_MACHINERY_SCRIPTS = {"risuhina.py", "realooc.py", "_agent_run.py"}


def _machinery(rel: str) -> bool:
    """Regenerated-every-run machinery: hina/<bot>/skills/** (rmtree+copytree
    per run) and the helper scripts. scratch/ and user scripts stay visible."""
    parts = rel.split("/")
    if len(parts) >= 3 and parts[0] == "hina" and parts[2] == "skills":
        return True
    return (len(parts) == 4 and parts[0] == "hina" and parts[2] == "scripts"
            and parts[3] in _MACHINERY_SCRIPTS)


def _listing_hidden(rel: str) -> bool:
    """Default-hidden in the tree (usability batch item 1): any dot component
    - the LEAF included, unlike `_hidden`, which spares it for search - or
    machinery. `include_hidden` (the panel's one toggle) reveals them."""
    return any(p.startswith(".") for p in rel.split("/")) or _machinery(rel)


def listing(scope: str, prefix: str = "", include_hidden: bool = False) -> dict:
    """Every file in the workspace, grouped by area, with sizes.

    `prefix` narrows the walk to one subtree ("studio/images"): the studio tab
    only ever consumes that slice, and without the filter every refresh
    shipped the entire space - every bot's hina/, every project - to throw it
    away. Paths in the result stay root-relative either way.

    Hidden files (see `_listing_hidden`) are skipped unless `include_hidden`,
    but their bytes still count into `size`/`totalSize` - the footer's disk
    usage stays the truth. Each area reports how many it held back.
    """
    root = _root(scope)
    prefix = (prefix or "").strip("/").replace("\\", "/")
    if scope == SPACE and prefix:
        prefix = workspace.studio_canon(prefix)
    areas = []
    total = 0
    for name, (deletable, cleanable) in areas_for(scope).items():
        if prefix and prefix != name and not prefix.startswith(name + "/"):
            continue
        d = root / prefix if prefix else root / name
        files = []
        size = 0
        hidden_n = 0
        if d.is_dir():
            for f in sorted(d.rglob("*")):
                if not f.is_file() or f.name.endswith(PART_SUFFIX):
                    continue  # an upload still arriving in chunks
                try:
                    st = f.stat()
                except OSError:
                    continue
                size += st.st_size
                rel_p = f.relative_to(root).as_posix()
                if not include_hidden and _listing_hidden(rel_p):
                    hidden_n += 1
                    continue
                files.append({
                    "path": rel_p,
                    "name": f.name,
                    "size": st.st_size,
                    "modified": st.st_mtime,
                    "textual": f.suffix.lower() in TEXTUAL,
                })
        total += size
        dirs = sorted(
            q.relative_to(root).as_posix() for q in (d.rglob("*") if d.is_dir() else [])
            if q.is_dir() and (include_hidden or not _listing_hidden(q.relative_to(root).as_posix()))
        ) if d.is_dir() else []
        areas.append({
            "area": name,
            "deletable": deletable,
            "cleanable": cleanable,
            "count": len(files),
            "size": size,
            "hidden": hidden_n,
            "files": files,
            # Folders, empty ones included - the files tab draws them and
            # offers them as move targets.
            "dirs": dirs,
        })
    return {"charKey": scope, "root": str(root), "totalSize": total, "areas": areas}


def read(scope: str, rel: str) -> dict:
    path = _resolve(scope, rel)
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


def upload(scope: str, name: str, *, text: str | None = None,
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
    root = _root(scope)
    # `into` is a folder the files tab chose; it has to stay inside a
    # writable area (uploads/ is the default; out/ is allowed so a person can
    # put a deliverable back where the agent left it).
    allowed, default = upload_targets(scope)
    target = into or default
    area = target.replace("\\", "/").lstrip("/").split("/")[0]
    if area not in allowed:
        raise FileError(f"{' / '.join(allowed)} 안의 폴더여야 합니다: {into}")
    dest = _folder(scope, target, area) / safe
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
            return _extract_zip(scope, dest.parent, safe, raw)
        dest.write_bytes(raw)
        size = len(raw)
    elif text is not None:
        if len(text.encode("utf-8")) > MAX_UPLOAD:
            raise FileError("파일이 너무 큽니다")
        dest.write_text(text, encoding="utf-8")
        size = dest.stat().st_size
    else:
        raise FileError("text 또는 base64 중 하나가 필요합니다")

    log.info("upload scope=%s path=%s size=%s", scope, rel, size)
    return {"path": rel, "name": safe, "size": size}


def upload_many(scope: str, into: str, entries: list[dict], data: bytes, *, extract: bool = False) -> dict:
    """Many files from one binary body - the folder drop.

    `entries` is the header's list ({name, rel, size}) and `data` the files'
    bytes back to back in that order. One request per file was the reason a
    thousand-asset folder took minutes: each file cost a base64 encode, a
    JSON parse, and a round trip through the tunnel. This costs one round
    trip per ~16MB and no encoding at all.
    """
    root = _root(scope)
    allowed, default = upload_targets(scope)
    target = (into or default).replace("\\", "/").strip("/")
    area = target.split("/")[0]
    if area not in allowed:
        raise FileError(f"{' / '.join(allowed)} 안의 폴더여야 합니다: {into}")
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
        folder = _folder(scope, target + ("/" + rel if rel else ""), area)
        if size > MAX_UPLOAD:
            raise FileError(f"{safe}: 파일이 너무 큽니다 ({size} 바이트, 최대 {MAX_UPLOAD})")
        if extract and safe.lower().endswith(".zip"):
            r = _extract_zip(scope, folder, safe, bytes(chunk))
            extracted += int(r.get("extracted") or 0)
            out.append(r)
            continue
        dest = folder / safe
        dest.write_bytes(chunk)
        total += size
        out.append({"path": dest.relative_to(root).as_posix(), "name": safe, "size": size})
    log.info("upload-many scope=%s into=%s files=%s size=%s extracted=%s", scope, target, len(out), total, extracted)
    return {"files": out, "count": len(out), "size": total, "extracted": extracted}


# A file that arrives in pieces is written to <name>.part and renamed when the
# last piece lands, so a listing never shows a half-written file and an
# interrupted upload leaves something obviously unfinished rather than a
# plausible-looking truncated one.
PART_SUFFIX = ".part"
# The whole-file cap for the chunked path. A .charx of a big character is
# 140-180MB in practice, which the single-shot path could never take: the body
# limit is 64MB and the plugin had to read the file into one array.
MAX_CHUNKED = 2 * 1024 * 1024 * 1024


def upload_chunk(scope: str, into: str, name: str, rel: str, offset: int, total: int,
                 data: bytes, *, last: bool = False, extract: bool = False) -> dict:
    """One piece of a large file, appended at `offset`.

    The offset is checked against what is already on disk rather than trusted:
    two workers racing on the same name, or a retried chunk, would otherwise
    interleave into a corrupt file that looks complete.
    """
    root = _root(scope)
    allowed, default = upload_targets(scope)
    target = (into or default).replace("\\", "/").strip("/")
    area = target.split("/")[0]
    if area not in allowed:
        raise FileError(f"{' / '.join(allowed)} 안의 폴더여야 합니다: {into}")
    if total < 0 or total > MAX_CHUNKED:
        raise FileError(f"파일이 너무 큽니다 ({total} 바이트, 최대 {MAX_CHUNKED})")
    safe = Path(str(name or "upload")).name.strip() or "upload"
    rel = str(rel or "").replace("\\", "/").strip("/")
    if ".." in rel.split("/"):
        raise FileError(f"잘못된 하위 경로입니다: {rel}")
    folder = _folder(scope, target + ("/" + rel if rel else ""), area)
    part = folder / (safe + PART_SUFFIX)

    have = part.stat().st_size if part.exists() else 0
    if offset == 0:
        part.write_bytes(b"")
        have = 0
    if offset != have:
        raise FileError(f"{safe}: 조각 순서가 어긋났습니다 (기대 {have}, 받은 {offset})")
    with open(part, "ab") as f:
        f.write(data)
    have += len(data)

    if not last:
        return {"name": safe, "received": have, "total": total, "done": False}
    if total and have != total:
        part.unlink(missing_ok=True)
        raise FileError(f"{safe}: 크기가 맞지 않습니다 ({have} / {total})")
    if extract and safe.lower().endswith(".zip"):
        blob = part.read_bytes()
        part.unlink(missing_ok=True)
        r = _extract_zip(scope, folder, safe, blob)
        log.info("upload-chunk scope=%s %s extracted=%s", scope, safe, r.get("extracted"))
        return {**r, "done": True}
    dest = folder / safe
    part.replace(dest)
    log.info("upload-chunk scope=%s %s size=%s", scope, safe, have)
    return {"path": dest.relative_to(root).as_posix(), "name": safe, "size": have,
            "received": have, "total": total, "done": True}


# An extracted archive may not exceed this, however small the zip was: a
# zip bomb is the one upload that could fill the disk from a JSON body.
MAX_EXTRACT = 512 * 1024 * 1024
MAX_EXTRACT_FILES = 5000


def _extract_zip(scope: str, parent: Path, zip_name: str, raw: bytes) -> dict:
    """Unpack `raw` into parent/<zip stem>/, refusing anything that would
    land outside it. Directory entries and OS junk (__MACOSX, .DS_Store) are
    skipped; nested folders are kept."""
    import io
    import zipfile

    root = _root(scope)
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
    log.info("upload scope=%s zip=%s -> %s files=%s size=%s", scope, zip_name, rel, count, total)
    return {"path": rel, "name": stem, "size": total, "extracted": count}


def zip_paths(scope: str, rels: list[str]) -> tuple[Path, int]:
    """A zip of the given workspace paths (files or folders), written to a
    temp file the caller streams and deletes. Names inside the archive are
    relative to the paths' common parent, so one folder unpacks as itself
    rather than as `uploads/<folder>`."""
    import tempfile
    import zipfile

    targets: list[Path] = []
    for rel in rels:
        p = _resolve(scope, rel)
        if p == _root(scope):
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
    log.info("zip scope=%s paths=%s files=%s size=%s", scope, len(rels), count, out.stat().st_size)
    return out, count


def _folder(scope: str, rel: str, area: str) -> Path:
    """A folder path inside one area (uploads/, out/ ...), created on demand."""
    path = _resolve(scope, rel)
    root = _root(scope)
    parts = path.relative_to(root).parts if path != root else ()
    if not parts or parts[0] != area:
        raise FileError(f"{area}/ 안의 폴더여야 합니다: {rel}")
    if path.exists() and not path.is_dir():
        raise FileError(f"폴더가 아닙니다: {rel}")
    path.mkdir(parents=True, exist_ok=True)
    return path


def _area_of(scope: str, path: Path) -> str:
    root = _root(scope)
    try:
        return path.relative_to(root).parts[0]
    except (ValueError, IndexError) as e:
        raise FileError("워크스페이스 밖의 경로입니다") from e


def mkdir(scope: str, rel: str) -> dict:
    """A new folder inside a deletable area. Folders are how the user keeps
    fifty uploads and a season of outputs apart; the agent sees them as paths."""
    path = _resolve(scope, rel)
    area = _area_of(scope, path)
    if not areas_for(scope).get(area, (False, False))[0]:
        raise FileError(f"{area}/ 안에는 폴더를 만들 수 없습니다")
    if path.exists():
        raise FileError(f"이미 있습니다: {rel}")
    path.mkdir(parents=True)
    log.info("mkdir scope=%s path=%s", scope, rel)
    return {"path": path.relative_to(_root(scope)).as_posix()}


def move(scope: str, src_rel: str, dst_rel: str) -> dict:
    """Move a file or folder within the deletable areas (uploads <-> out is
    fine; nothing enters original/ or leaves the workspace). `dst_rel` may be
    a folder (the name is kept) or a full new path."""
    src = _resolve(scope, src_rel)
    if not src.exists():
        raise FileError(f"없습니다: {src_rel}")
    if src == _root(scope):
        raise FileError("워크스페이스 자체는 옮길 수 없습니다")
    dst = _resolve(scope, dst_rel)
    if dst.is_dir():
        dst = dst / src.name
    for p in (src, dst):
        area = _area_of(scope, p)
        if not areas_for(scope).get(area, (False, False))[0]:
            raise FileError(f"{area}/ 는 옮길 수 없는 영역입니다")
    if dst.exists():
        raise FileError(f"같은 이름이 이미 있습니다: {dst.relative_to(_root(scope)).as_posix()}")
    if src.is_dir() and (dst == src or src in dst.parents):
        raise FileError("폴더를 자기 안으로 옮길 수 없습니다")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    out = dst.relative_to(_root(scope)).as_posix()
    log.info("move scope=%s %s -> %s", scope, src_rel, out)
    return {"from": src_rel, "to": out}


def copy(scope: str, src_rel: str, dst_rel: str) -> dict:
    """Copy a file or folder within the deletable areas (the context menu's
    복사/붙여넣기). `dst_rel` may be a folder (the name is kept) or a full new
    path; a taken name counts up to `이름 (2)` rather than refusing - a paste
    into the same folder is the common case, and it should just work."""
    src = _resolve(scope, src_rel)
    if not src.exists():
        raise FileError(f"없습니다: {src_rel}")
    if src == _root(scope):
        raise FileError("워크스페이스 자체는 복사할 수 없습니다")
    dst = _resolve(scope, dst_rel)
    if dst.is_dir():
        dst = dst / src.name
    for p in (src, dst):
        area = _area_of(scope, p)
        if not areas_for(scope).get(area, (False, False))[0]:
            raise FileError(f"{area}/ 는 복사할 수 없는 영역입니다")
    if src.is_dir() and (dst == src or src in dst.parents):
        raise FileError("폴더를 자기 안으로 복사할 수 없습니다")
    stem, suffix = (dst.stem, dst.suffix) if src.is_file() else (dst.name, "")
    n = 2
    while dst.exists():
        dst = dst.with_name(f"{stem} ({n}){suffix}")
        n += 1
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dst)
    else:
        shutil.copy2(src, dst)
    out = dst.relative_to(_root(scope)).as_posix()
    log.info("copy scope=%s %s -> %s", scope, src_rel, out)
    return {"from": src_rel, "to": out}


def delete(scope: str, rel: str) -> dict:
    path = _resolve(scope, rel)
    root = _root(scope)
    if path == root:
        raise FileError("워크스페이스 자체는 지울 수 없습니다")
    try:
        area = path.relative_to(root).parts[0]
    except ValueError as e:
        raise FileError("워크스페이스 밖의 경로입니다") from e
    if not areas_for(scope).get(area, (False, False))[0]:
        raise FileError(f"{area}/ 안의 파일은 지울 수 없습니다")
    if not path.exists():
        raise FileError(f"파일이 없습니다: {rel}")
    if path.is_dir():
        shutil.rmtree(path, ignore_errors=True)
    else:
        path.unlink()
    log.info("delete scope=%s path=%s", scope, rel)
    return {"deleted": rel}


def _many(rels: list[str], fn) -> dict:
    """Batch wrapper: one HTTP round trip instead of N (a 300-file paste used
    to be 300 requests). A per-item failure lands in `failed` and the batch
    goes on - move's name-clash refusal must not abort the other 299."""
    results, failed = [], []
    for rel in rels:
        try:
            results.append(fn(rel))
        except FileError as e:
            failed.append({"path": rel, "error": str(e)})
    return {"done": len(results), "results": results, "failed": failed}


def delete_many(scope: str, rels: list[str]) -> dict:
    return _many(rels, lambda r: delete(scope, r))


def move_many(scope: str, rels: list[str], dst_rel: str) -> dict:
    return _many(rels, lambda r: move(scope, r, dst_rel))


def copy_many(scope: str, rels: list[str], dst_rel: str) -> dict:
    return _many(rels, lambda r: copy(scope, r, dst_rel))


def clean(scope: str, areas: list[str] | None = None) -> dict:
    """Empty the cleanable areas. Never touches original/ or uploads/."""
    root = _root(scope)
    table = areas_for(scope)
    targets = [a for a in (areas or [a for a, (_, c) in table.items() if c])
               if table.get(a, (False, False))[1]]
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
    log.info("clean scope=%s areas=%s removed=%s freed=%s", scope, targets, removed, freed)
    return {"areas": targets, "removed": removed, "freed": freed}


def _sweep(d: Path) -> tuple[int, int]:
    """Empty one directory tree, keeping the directory itself. (removed, freed)."""
    removed = freed = 0
    if not d.is_dir():
        return 0, 0
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
    return removed, freed


def clean_bot(char_key: str, areas: list[str] | None = None) -> dict:
    """정리, per bot, in the global space: this bot's hina/ scratch and
    scripts by default, out/ only on request (the user may not have taken the
    deliverables yet), plus its SYSTEM .scratch/ (regenerated next run).

    There is deliberately no global clean: hina/ holds every bot's work at
    once, and projects/ and studio/ are the user's own material.
    """
    allowed = ("scratch", "scripts", "out")
    targets = [a for a in (areas or ["scratch", "scripts"]) if a in allowed]
    base = workspace.space_root() / "hina" / workspace.bot_folder(char_key)
    removed = freed = 0
    for area in targets:
        r, f = _sweep(base / area)
        removed += r
        freed += f
    r, f = _sweep(workspace.root(char_key) / ".scratch")
    removed += r
    freed += f
    log.info("clean-bot key=%s areas=%s removed=%s freed=%s", char_key, targets, removed, freed)
    return {"areas": targets, "removed": removed, "freed": freed}


def _hidden(rel: str) -> bool:
    """True when any directory component is a dot-name (.hina, .studio, …)."""
    return any(p.startswith(".") for p in rel.split("/")[:-1])


def search_names(scope: str, pattern: str, base: str = "", limit: int = 200) -> dict:
    """Filename glob over one scope's tree, dot-areas excluded.

    Returns every match count but at most `limit` rows - the caller must state
    the truncation (docs/07 §3-3: a clipped listing that does not say so is a
    wrong answer, not a short one).
    """
    import fnmatch

    root = _root(scope)
    start = _resolve(scope, base)
    if not start.is_dir():
        raise FileError(f"디렉터리가 아닙니다: {base or '.'}")
    pat = (pattern or "*").strip() or "*"
    # A pattern with a slash matches the whole relative path; a bare name
    # pattern matches the filename, wherever it lives.
    on_path = "/" in pat
    rows: list[dict] = []
    total = 0
    for f in sorted(start.rglob("*")):
        if not f.is_file() or f.name.endswith(PART_SUFFIX):
            continue
        rel = f.relative_to(root).as_posix()
        if _hidden(rel):
            continue
        if not fnmatch.fnmatch((rel if on_path else f.name).lower(), pat.lower()):
            continue
        total += 1
        if len(rows) < max(1, limit):
            try:
                st = f.stat()
            except OSError:
                continue
            rows.append({"path": rel, "size": st.st_size, "modified": st.st_mtime})
    return {"total": total, "files": rows}


# Content search skips anything bigger than this rather than choking on it -
# the skip is counted and reported, never silent.
MAX_SEARCH_FILE = 4 * 1024 * 1024


def search_content(scope: str, needle: str, glob: str = "", limit: int = 50) -> dict:
    """Substring search over the scope's textual files, dot-areas excluded.

    At most 5 hits per file and `limit` rows overall; every hit is still
    counted, and skipped files (too big, unreadable) are counted too, so the
    caller can state exactly what was and was not looked at.
    """
    import fnmatch

    if not (needle or "").strip():
        raise FileError("검색어가 필요합니다")
    root = _root(scope)
    low = needle.lower()
    rows: list[dict] = []
    total_hits = scanned = skipped = 0
    for f in sorted(root.rglob("*")):
        if not f.is_file() or f.name.endswith(PART_SUFFIX):
            continue
        rel = f.relative_to(root).as_posix()
        if _hidden(rel):
            continue
        if glob and not fnmatch.fnmatch(rel.lower(), glob.lower()):
            continue
        if f.suffix.lower() not in TEXTUAL:
            continue
        try:
            if f.stat().st_size > MAX_SEARCH_FILE:
                skipped += 1
                continue
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            skipped += 1
            continue
        scanned += 1
        per = 0
        for ln, line in enumerate(text.splitlines(), 1):
            if low in line.lower():
                total_hits += 1
                if per < 5 and len(rows) < max(1, limit):
                    rows.append({"path": rel, "line": ln, "text": line.strip()[:160]})
                    per += 1
    return {"hits": rows, "totalHits": total_hits, "scanned": scanned, "skipped": skipped}


def agent_list(scope: str, rel: str = "") -> str:
    """Directory listing for the agent, as text."""
    path = _resolve(scope, rel)
    if not path.is_dir():
        raise FileError(f"디렉터리가 아닙니다: {rel or '.'}")
    root = _root(scope)
    rows = []
    for f in sorted(path.iterdir()):
        try:
            st = f.stat()
        except OSError:
            continue
        kind = "dir " if f.is_dir() else f"{st.st_size:>8}"
        rows.append(f"{kind}  {f.relative_to(root).as_posix()}")
    return "\n".join(rows) or "(비어 있습니다)"


def agent_read(scope: str, rel: str, limit: int = 40000) -> str:
    path = _resolve(scope, rel)
    if not path.is_file():
        raise FileError(f"파일이 없습니다: {rel}")
    if path.suffix.lower() not in TEXTUAL:
        return f"({path.name} 은 텍스트 파일이 아닙니다)"
    text = path.read_text(encoding="utf-8", errors="replace")
    if len(text) > limit:
        return text[:limit] + f"\n… ({len(text)}자 중 {limit}자만 표시)"
    return text


def stats(scope: str) -> dict[str, Any]:
    data = listing(scope)
    return {
        "totalSize": data["totalSize"],
        "byArea": {a["area"]: {"count": a["count"], "size": a["size"]} for a in data["areas"]},
        "generatedAt": time.time(),
    }


# --- thumbnails -------------------------------------------------------------------

_THUMB_KEEP = 2000
_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"}


def _thumb_dir() -> Path:
    return workspace.space_root() / "studio" / "config" / ".studio" / "thumbs"


def thumb_bytes(target: Path, width: int = 360) -> tuple[bytes, str | None]:
    """A small WebP preview of an image, disk-cached by (path, mtime, width).

    Returns (bytes, mime). Anything that cannot be thumbed - not an image,
    Pillow missing, decode failure - returns the ORIGINAL bytes with mime None
    (the caller picks its own): a broken thumbnailer must never turn into a
    broken picture that /files/download could have served.
    """
    if target.suffix.lower() not in _IMAGE_SUFFIXES:
        return target.read_bytes(), None
    try:
        from PIL import Image  # optional dependency: pillow (requirements.in)
    except Exception:
        return target.read_bytes(), None
    try:
        st = target.stat()
        key = hashlib.sha1(f"{target}|{st.st_mtime_ns}|{width}".encode()).hexdigest()
        cdir = _thumb_dir()
        cp = cdir / f"{key}.webp"
        if cp.is_file():
            return cp.read_bytes(), "image/webp"
        with Image.open(target) as im:
            if im.mode not in ("RGB", "RGBA"):
                im = im.convert("RGBA")
            im.thumbnail((width, width * 2))
            cdir.mkdir(parents=True, exist_ok=True)
            tmp = cp.with_name(cp.name + ".tmp")
            im.save(tmp, "WEBP", quality=82)
            tmp.replace(cp)
        _prune_thumbs(cdir)
        return cp.read_bytes(), "image/webp"
    except Exception:
        return target.read_bytes(), None


def _prune_thumbs(cdir: Path) -> None:
    """Opportunistic cap: drop the oldest entries once the cache passes ~2000."""
    try:
        entries = sorted(cdir.glob("*.webp"), key=lambda q: q.stat().st_mtime)
        for q in entries[: max(0, len(entries) - _THUMB_KEEP)]:
            q.unlink(missing_ok=True)
    except OSError:
        pass
