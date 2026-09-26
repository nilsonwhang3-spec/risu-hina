"""The optional MCP add-on: the `mcp` package, installed on request.

**Why not in the bundle.** The release zips are hash-pinned and wheels-only,
and most users never point an MCP client at their backend. `mcp` drags in
about thirty packages (pywin32 and cryptography among them), so it is an
opt-in: 설정 → 고급 기능 → MCP 설치.

**Where it goes.** Not into `python/Lib/site-packages`: the updater replaces
`python/` whenever the dependency lock changes (updater.py, python.new), and
an add-on living there would vanish on the next update. It goes into
`<data>/addons/mcp/<python tag>/` with `pip install --target`, and startup
adds that folder with `site.addsitedir` - which also runs its `.pth` files
(pywin32 needs them) and APPENDS, so the bundle's own starlette / pydantic /
anyio always win over any copy pip put in the target.

**Why constraints.** `--target` resolves against an empty folder, so pip
would happily pick a newer starlette than FastAPI accepts. Every package the
running interpreter already has is pinned to its installed version with `-c`,
so the resolution matches what will actually be imported; those duplicate
copies are then deleted from the target (they would only ever be shadowed).

`MCP_VERSION` is pinned because the server code is written against the 2.x
lowlevel API (`Server(on_list_tools=..., on_call_tool=...)`), which differs
from 1.x.
"""
from __future__ import annotations

import importlib
import importlib.metadata as md
import shutil
import site
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

from . import config, log

MCP_VERSION = "2.2.0"
PY_TAG = f"py{sys.version_info.major}{sys.version_info.minor}"

_lock = threading.Lock()
_job: dict[str, Any] = {"running": False, "startedAt": 0.0, "finishedAt": 0.0, "ok": None, "output": "", "error": ""}
_loaded = False
_load_error = ""
REMOVE_MARK = "REMOVE_ON_START"


def root() -> Path:
    return config.DATA_DIR / "addons" / "mcp"


def target() -> Path:
    """One folder per interpreter version: compiled wheels (pydantic-core's
    cousins rpds, cffi, cryptography) are ABI-bound, so an interpreter upgrade
    must not load the old ones - it shows 재설치 필요 instead."""
    return root() / PY_TAG


def _installed_version() -> str:
    t = target()
    if not t.is_dir():
        return ""
    for d in md.distributions(path=[str(t)]):
        if (d.metadata.get("Name") or "").lower() == "mcp":
            return d.version
    return ""


def load() -> bool:
    """Make an installed add-on importable. Called at startup and after an
    install; idempotent. Returns whether `mcp` can be imported."""
    global _loaded, _load_error
    if _loaded:
        return True
    t = target()
    if not t.is_dir() or not _installed_version():
        return False
    try:
        if str(t) not in sys.path:
            site.addsitedir(str(t))
        importlib.invalidate_caches()
        importlib.import_module("mcp.server.lowlevel")
        importlib.import_module("mcp.server.streamable_http_manager")
        _loaded = True
        _load_error = ""
        log.info("mcp add-on loaded from %s", t)
    except Exception as e:  # noqa: BLE001 - a broken add-on must not take the backend down
        _load_error = f"{type(e).__name__}: {e}"
        log.warn("mcp add-on failed to load: %s", _load_error)
    return _loaded


def status() -> dict:
    if (root() / REMOVE_MARK).is_file():
        return {"installed": False, "version": "", "wanted": MCP_VERSION, "loaded": _loaded, "loadError": "",
                "reinstallNeeded": False, "removalPending": True, "path": str(target()),
                "python": sys.executable, "job": {**_job, "output": ""}}
    other = sorted(p.name for p in root().iterdir() if p.is_dir() and p.name != PY_TAG) if root().is_dir() else []
    with _lock:
        job = dict(_job)
    version = _installed_version()
    return {
        "installed": bool(version),
        "version": version,
        "wanted": MCP_VERSION,
        "loaded": _loaded,
        "loadError": _load_error,
        # Installed for another interpreter only: the backend was updated to a
        # new Python since. Offer a reinstall rather than pretending it works.
        "reinstallNeeded": (not version) and bool(other),
        "path": str(target()),
        "python": sys.executable,
        "job": {**job, "output": job["output"][-4000:]},
    }


def _constraints_file() -> Path:
    """Pin every distribution the running interpreter has to its version."""
    lines = []
    seen: set[str] = set()
    t = str(target())
    for d in md.distributions():
        name = (d.metadata.get("Name") or "").strip()
        # Only the interpreter's own packages - not a previous add-on copy.
        loc = str(d.locate_file(""))
        if not name or name.lower() in seen or name.lower() in ("pip", "setuptools", "wheel") or loc.startswith(t):
            continue
        seen.add(name.lower())
        lines.append(f"{name}=={d.version}")
    out = root() / "constraints.txt"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def _prune_duplicates() -> int:
    """Delete target copies of packages the interpreter already provides at
    the same version. They are always shadowed (addsitedir appends), so they
    are dead weight - and a trap if someone ever reorders sys.path."""
    t = target()
    base = {}
    for d in md.distributions():
        loc = str(d.locate_file(""))
        if not loc.startswith(str(t)):
            base[(d.metadata.get("Name") or "").lower()] = d.version
    removed = 0
    for d in list(md.distributions(path=[str(t)])):
        name = (d.metadata.get("Name") or "").lower()
        if name == "mcp" or base.get(name) != d.version:
            continue
        for f in d.files or []:
            p = Path(d.locate_file(f))
            try:
                if p.is_file() and str(p).startswith(str(t)):
                    p.unlink()
            except OSError:
                pass
        removed += 1
    # Directories left empty by the deletions.
    for p in sorted(t.rglob("*"), key=lambda x: len(x.parts), reverse=True):
        if p.is_dir():
            try:
                p.rmdir()
            except OSError:
                pass
    return removed


def _run_install() -> None:
    t0 = time.time()
    t = target()
    staging = t.with_name(t.name + ".new")
    shutil.rmtree(staging, ignore_errors=True)
    ok = False
    output = ""
    error = ""
    try:
        cons = _constraints_file()
        cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input",
               "--only-binary=:all:", "--target", str(staging), "-c", str(cons), f"mcp=={MCP_VERSION}"]
        from .permits import _env
        proc = subprocess.run(cmd, env=_env(), capture_output=True, timeout=900,
                              text=True, encoding="utf-8", errors="replace")
        output = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            error = "pip 설치에 실패했습니다 (코드 %s)." % proc.returncode
            if "No module named pip" in output:
                error += " 이 인터프리터에 pip 이 없습니다."
        else:
            # Swap in only a finished install: a half-written target must never
            # be what the next start loads.
            shutil.rmtree(t, ignore_errors=True)
            staging.rename(t)
            n = _prune_duplicates()
            output += f"\n(중복 패키지 {n}개 정리)"
            ok = True
    except subprocess.TimeoutExpired:
        error = "시간 초과 (15분)"
    except Exception as e:  # noqa: BLE001
        error = f"{type(e).__name__}: {e}"
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    if ok:
        if not load():
            ok = False
            error = "설치는 끝났지만 불러오지 못했습니다: " + _load_error
    log.info("mcp add-on install -> %s %.1fs %s", "ok" if ok else "failed", time.time() - t0, error)
    with _lock:
        _job.update(running=False, finishedAt=time.time(), ok=ok, output=output, error=error)
    if ok:
        from . import mcpserver
        try:
            mcpserver.enable()
        except Exception as e:  # noqa: BLE001
            log.warn("mcp server enable after install failed: %s", e)


def install() -> dict:
    """Start the install in the background; the panel polls status()."""
    with _lock:
        if _job["running"]:
            return {"started": False, "reason": "이미 설치 중입니다."}
        if _loaded:
            # Its .pyd files are open in this process; Windows will not let
            # them be replaced. Nothing to do anyway - it is installed.
            return {"started": False, "reason": "이미 설치되어 동작 중입니다."}
        _job.update(running=True, startedAt=time.time(), finishedAt=0.0, ok=None, output="", error="")
    threading.Thread(target=_run_install, name="mcp-addon-install", daemon=True).start()
    return {"started": True}


def uninstall() -> dict:
    """Delete the add-on. A loaded module cannot be unloaded, so the route
    stays until the next restart; say so instead of pretending."""
    with _lock:
        if _job["running"]:
            return {"removed": False, "reason": "설치 중에는 제거할 수 없습니다."}
    from . import mcpserver
    mcpserver.disable()
    if _loaded:
        # Loaded extension modules are locked on Windows; delete at the next
        # start, before anything imports them (sweep_pending_removal).
        root().mkdir(parents=True, exist_ok=True)
        (root() / REMOVE_MARK).write_text("remove\n", encoding="utf-8")
        log.info("mcp add-on marked for removal at next start")
        return {"removed": True, "restartNeeded": True}
    shutil.rmtree(root(), ignore_errors=True)
    log.info("mcp add-on removed")
    return {"removed": True, "restartNeeded": False}


def sweep_pending_removal() -> None:
    if (root() / REMOVE_MARK).is_file():
        shutil.rmtree(root(), ignore_errors=True)
        log.info("mcp add-on removed (marked before restart)")


def loaded() -> bool:
    return _loaded
