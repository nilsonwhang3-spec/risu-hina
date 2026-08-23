"""Backend self-update from a GitHub release.

The order the user actually works in is: update the plugin from RisuAI's own
plugin screen, then open the plugin and update the backend from there. So the
plugin's `//@update-url` must be somewhere that works when the backend is down
or out of date - a GitHub release - and this module is the second half.

## What it does

    check()   ask GitHub for the latest release, compare tags
    apply()   download, verify, install, and ask the process to exit 75

Exit 75 rather than restarting ourselves: whatever supervises this - PM2, NSSM,
a systemd unit, or `start.bat` in a loop - is the thing that knows how to start
it, and a process that re-executes itself fights every one of them. The launcher
loop treats 75 as "install finished, come back up"; any other code exits for
real, so a crash still stops rather than spinning.

## Two layouts

The plan's install layout is `versions/<v>/` with a `current` pointer. What is
deployed today is flat - `pyserver/app/` in place. Rather than require a
migration before updates can work at all, `_layout()` detects which one it is
in and installs accordingly. A flat install keeps a timestamped `app.bak-*` so
the previous version is one rename away, which is what a rollback needs when
there is no version directory to point back at.

## What is verified

The release must publish `SHA256SUMS.txt`. The archive's digest has to match
the line for its filename, and a mismatch aborts before anything is unpacked.
Without that this is a remote-code-execution endpoint with extra steps: the
whole point of the download is that its contents become the running server.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any

from . import config, log

# The exit code the launcher loop watches for.
RESTART_CODE = 75

API = "https://api.github.com/repos/{repo}/releases/latest"
ASSET_SUMS = "SHA256SUMS.txt"

# Anything larger is not our backend.
MAX_ASSET = 200 * 1024 * 1024

_state: dict[str, Any] = {"pending": None}


class UpdateError(RuntimeError):
    pass


def repo() -> str:
    return str((config.section("update") or {}).get("repo") or "").strip().strip("/")


def _http_json(url: str, timeout: int = 20) -> dict:
    import httpx
    headers = {"Accept": "application/vnd.github+json",
               "User-Agent": f"{config.APP_NAME}/{config.VERSION}"}
    token = str((config.section("update") or {}).get("githubToken") or "").strip()
    if token:
        # Only for a private repo or to lift the anonymous rate limit; never
        # required, and never logged.
        headers["Authorization"] = f"Bearer {token}"
    r = httpx.get(url, headers=headers, timeout=timeout, follow_redirects=True)
    if r.status_code == 404:
        raise UpdateError("릴리스를 찾을 수 없습니다. 레포 이름과 공개 여부를 확인해 주세요")
    if r.status_code >= 400:
        raise UpdateError(f"GitHub 응답 {r.status_code}")
    return r.json()


def _http_bytes(url: str, timeout: int = 120) -> bytes:
    import httpx
    headers = {"User-Agent": f"{config.APP_NAME}/{config.VERSION}"}
    token = str((config.section("update") or {}).get("githubToken") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with httpx.stream("GET", url, headers=headers, timeout=timeout,
                      follow_redirects=True) as r:
        if r.status_code >= 400:
            raise UpdateError(f"내려받지 못했습니다 (HTTP {r.status_code})")
        buf = io.BytesIO()
        for chunk in r.iter_bytes():
            buf.write(chunk)
            if buf.tell() > MAX_ASSET:
                raise UpdateError("내려받은 파일이 너무 큽니다")
        return buf.getvalue()


def _ver_tuple(v: str) -> tuple:
    """Compare versions numerically, so 0.10.0 is newer than 0.9.0."""
    nums = [int(x) for x in re.findall(r"\d+", v or "")]
    return tuple(nums) if nums else (0,)


def check() -> dict:
    name = repo()
    if not name:
        return {"ok": False, "configured": False,
                "current": config.VERSION,
                "error": "업데이트 레포가 설정되지 않았습니다 (설정 → 정보 · 로그)"}
    try:
        rel = _http_json(API.format(repo=name))
    except UpdateError as e:
        return {"ok": False, "configured": True, "current": config.VERSION, "error": str(e)}
    except Exception as e:  # noqa: BLE001 - network shapes vary
        return {"ok": False, "configured": True, "current": config.VERSION,
                "error": f"{type(e).__name__}: {e}"}

    tag = str(rel.get("tag_name") or "").lstrip("vV")
    assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets") or []}
    archive = next((n for n in assets if n.endswith(".zip") and "backend" in n.lower()), None)
    archive = archive or next((n for n in assets if n.endswith(".zip")), None)

    newer = _ver_tuple(tag) > _ver_tuple(config.VERSION)
    return {
        "ok": True,
        "configured": True,
        "current": config.VERSION,
        "latest": tag,
        "newer": newer,
        "notes": str(rel.get("body") or "")[:4000],
        "publishedAt": rel.get("published_at"),
        "asset": archive,
        "verifiable": ASSET_SUMS in assets,
        "installable": bool(archive) and ASSET_SUMS in assets,
        "reason": None if (archive and ASSET_SUMS in assets) else (
            "릴리스에 백엔드 zip이 없습니다" if not archive
            else f"릴리스에 {ASSET_SUMS} 가 없어 검증할 수 없습니다"),
    }


def _layout() -> dict:
    """Where this install keeps its code, and how a new version replaces it."""
    pkg_root = Path(__file__).resolve().parent.parent      # .../pyserver or versions/<v>
    parent = pkg_root.parent
    if parent.name.lower() == "versions":
        return {"mode": "versioned", "versions": parent, "root": parent.parent,
                "current": parent.parent / "current"}
    return {"mode": "flat", "root": parent, "pkg": pkg_root}


def _verify(blob: bytes, filename: str, sums_text: str) -> None:
    want = ""
    for line in sums_text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == filename:
            want = parts[0].lower()
            break
    if not want:
        raise UpdateError(f"{ASSET_SUMS} 에 {filename} 항목이 없습니다")
    got = hashlib.sha256(blob).hexdigest()
    if got != want:
        raise UpdateError(f"해시가 맞지 않습니다 (기대 {want[:12]}…, 실제 {got[:12]}…)")


def _safe_extract(zf: zipfile.ZipFile, dest: Path) -> None:
    """Extract, refusing any member that would land outside dest.

    A zip can name `../../etc/passwd`, and Python's extractall has historically
    obliged. The archive here comes from a release we published, but a check
    that only holds while nothing goes wrong is not a check.
    """
    dest = dest.resolve()
    for member in zf.infolist():
        target = (dest / member.filename).resolve()
        if target != dest and dest not in target.parents:
            raise UpdateError(f"압축 파일에 이상한 경로가 있습니다: {member.filename}")
    zf.extractall(dest)


def apply() -> dict:
    """Install the latest release. Returns before the process exits."""
    info = check()
    if not info.get("ok"):
        raise UpdateError(info.get("error") or "업데이트를 확인하지 못했습니다")
    if not info.get("newer"):
        return {"updated": False, "reason": "이미 최신입니다", **info}
    if not info.get("installable"):
        raise UpdateError(info.get("reason") or "설치할 수 없는 릴리스입니다")

    name = repo()
    rel = _http_json(API.format(repo=name))
    assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets") or []}
    archive_name = info["asset"]

    log.info("update: downloading %s from %s", archive_name, name)
    blob = _http_bytes(assets[archive_name])
    sums = _http_bytes(assets[ASSET_SUMS], timeout=30).decode("utf-8", "replace")
    _verify(blob, archive_name, sums)
    log.info("update: %s verified (%s bytes)", archive_name, len(blob))

    staging = Path(tempfile.mkdtemp(prefix="risuelf-update-"))
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as zf:
            _safe_extract(zf, staging)
        payload = _find_payload(staging)
        target = _install(payload, info["latest"])
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    _state["pending"] = {"version": info["latest"], "at": time.time(), "path": str(target)}
    log.info("update: installed %s -> %s; requesting restart", info["latest"], target)
    return {"updated": True, "version": info["latest"], "path": str(target),
            "restartCode": RESTART_CODE,
            "note": "설치했습니다. 백엔드가 재시작되어야 적용됩니다."}


def _find_payload(staging: Path) -> Path:
    """The directory in the archive that actually holds `app/`."""
    if (staging / "app").is_dir():
        return staging
    for child in sorted(staging.iterdir()):
        if child.is_dir() and (child / "app").is_dir():
            return child
    raise UpdateError("압축 파일 안에서 app/ 을 찾지 못했습니다")


def _install(payload: Path, version: str) -> Path:
    lay = _layout()
    if lay["mode"] == "versioned":
        dest = lay["versions"] / version
        if dest.exists():
            shutil.rmtree(dest, ignore_errors=True)
        shutil.copytree(payload, dest)
        # A file, not a symlink: Windows needs a privilege for symlinks that a
        # background service does not reliably have.
        (lay["current"]).write_text(str(dest), encoding="utf-8")
        return dest

    pkg = lay["pkg"]
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = pkg / f"app.bak-{stamp}"
    if (pkg / "app").is_dir():
        shutil.copytree(pkg / "app", backup)
        shutil.rmtree(pkg / "app", ignore_errors=True)
    shutil.copytree(payload / "app", pkg / "app")
    for extra in ("run.py", "requirements.in", "requirements.lock",
                  "start.bat", "start.sh", "risuelf_ctl.ps1"):
        src = payload / extra
        if src.is_file():
            shutil.copy2(src, pkg / extra)
    # Stale bytecode from the version being replaced would shadow the new code.
    shutil.rmtree(pkg / "app" / "__pycache__", ignore_errors=True)
    log.info("update: previous version kept at %s", backup)
    return pkg


def pending() -> dict | None:
    return _state.get("pending")


def restart_now() -> None:
    """Leave with the code the launcher loop is watching for."""
    log.info("update: exiting %s for the launcher to restart", RESTART_CODE)
    os._exit(RESTART_CODE)
