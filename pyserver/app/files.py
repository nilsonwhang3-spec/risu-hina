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
        areas.append({
            "area": name,
            "deletable": deletable,
            "cleanable": cleanable,
            "count": len(files),
            "size": size,
            "files": files,
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
           base64_data: str | None = None) -> dict:
    """Store a user-provided file under uploads/.

    The name is reduced to its basename: an upload is never allowed to choose
    where in the tree it lands.
    """
    safe = Path(name or "upload").name.strip() or "upload"
    root = _root(char_key)
    dest = root / "uploads" / safe
    dest.parent.mkdir(parents=True, exist_ok=True)

    if base64_data is not None:
        try:
            raw = base64.b64decode(base64_data, validate=True)
        except Exception as e:  # noqa: BLE001
            raise FileError(f"base64 를 해석하지 못했습니다: {e}") from e
        if len(raw) > MAX_UPLOAD:
            raise FileError(f"파일이 너무 큽니다 ({len(raw)} 바이트, 최대 {MAX_UPLOAD})")
        dest.write_bytes(raw)
        size = len(raw)
    elif text is not None:
        if len(text.encode("utf-8")) > MAX_UPLOAD:
            raise FileError("파일이 너무 큽니다")
        dest.write_text(text, encoding="utf-8")
        size = dest.stat().st_size
    else:
        raise FileError("text 또는 base64 중 하나가 필요합니다")

    log.info("upload char=%s name=%s size=%s", char_key, safe, size)
    return {"path": f"uploads/{safe}", "name": safe, "size": size}


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
