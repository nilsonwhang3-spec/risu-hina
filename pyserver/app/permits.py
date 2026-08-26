"""Permission prompts: a tool that must not run unasked, asked in the panel.

The approval queue (actions.py) is for things that happen AFTER a turn:
the agent proposes, the turn ends, the user decides, the next turn sees the
result. That shape is wrong for a shell command or a package install the
agent needs *now* to finish what it is doing. So these block the tool call
instead: the request is registered here, the panel (which polls
`GET /permits` while a turn runs) shows 허용 / 거부 / 이번 턴 항상 허용, and
the tool continues with the answer - or gives up after the timeout, which
counts as a refusal.

"이번 턴 항상 허용" is per session and per turn: session.run clears it when
the turn ends, so the standing permission never outlives the request the
user was looking at.
"""
from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from . import config, log

KINDS = ("shell", "pip")
WAIT_S = 600
MAX_OUTPUT = 60_000

_lock = threading.Lock()
_pending: dict[str, dict] = {}          # id -> request
_always: dict[str, set[str]] = {}       # session_id -> kinds allowed for the rest of the turn


def _now() -> float:
    return time.time()


def request(session_id: str, kind: str, summary: str, detail: str) -> dict:
    """Register a prompt and return it (the tool then waits on `decision`)."""
    if kind not in KINDS:
        raise ValueError(f"unknown permit kind: {kind}")
    rid = uuid.uuid4().hex
    with _lock:
        auto = kind in _always.get(session_id, set())
        req = {
            "id": rid, "sessionId": session_id, "kind": kind, "summary": summary,
            "detail": detail[:4000], "createdAt": _now(),
            "decided": auto, "allow": auto, "always": False, "auto": auto,
        }
        _pending[rid] = req
    return dict(req)


def pending(session_id: str) -> list[dict]:
    with _lock:
        return [dict(r) for r in _pending.values()
                if r["sessionId"] == session_id and not r["decided"]]


def decide(rid: str, allow: bool, always: bool = False) -> dict:
    with _lock:
        r = _pending.get(rid)
        if r is None:
            raise LookupError("없는 요청입니다 (이미 끝났거나 시간이 지났습니다)")
        r["decided"] = True
        r["allow"] = bool(allow)
        r["always"] = bool(always and allow)
        if r["always"]:
            _always.setdefault(r["sessionId"], set()).add(r["kind"])
        return dict(r)


async def decision(rid: str, timeout_s: float = WAIT_S) -> bool:
    """Wait for the user's answer. Refused on timeout."""
    deadline = _now() + timeout_s
    while _now() < deadline:
        with _lock:
            r = _pending.get(rid)
            if r is None:
                return False
            if r["decided"]:
                allow = bool(r["allow"])
                _pending.pop(rid, None)
                return allow
        await asyncio.sleep(0.5)
    with _lock:
        _pending.pop(rid, None)
    return False


def end_turn(session_id: str) -> None:
    """The turn is over: standing permissions and unanswered prompts go."""
    with _lock:
        _always.pop(session_id, None)
        for rid in [k for k, v in _pending.items() if v["sessionId"] == session_id]:
            _pending.pop(rid, None)


# --- what gets run once allowed ------------------------------------------------------

def _env() -> dict[str, str]:
    """A plain environment for child processes: PATH, the OS basics, and the
    bundled interpreter first on PATH so `python` means ours."""
    env = {k: v for k, v in os.environ.items()
           if k.upper() in ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL",
                            "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA")}
    env["PYTHONIOENCODING"] = "utf-8"
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    return env


def run_shell(command: str, cwd: Path, timeout_s: int = 300) -> dict:
    """Run one command line in the workspace, through the OS shell."""
    t0 = _now()
    try:
        proc = subprocess.run(
            command, shell=True, cwd=str(cwd), env=_env(), capture_output=True,
            timeout=timeout_s, text=True, encoding="utf-8", errors="replace",
        )
        out, err, code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        err = (e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
        code = -1
        err += f"\n(시간 초과: {timeout_s}초)"
    log.info("shell cwd=%s code=%s %.1fs: %s", cwd.name, code, _now() - t0, command[:120])
    return {"code": code, "stdout": out[-MAX_OUTPUT:], "stderr": err[-MAX_OUTPUT:], "seconds": round(_now() - t0, 1)}


def pip_install(packages: list[str], timeout_s: int = 600) -> dict:
    """`python -m pip install <pkgs>` with the interpreter the agent's scripts
    use. The bundled interpreter carries a pip wheel on its path
    (tools/bundle.py), so this works on an install without a system Python."""
    pkgs = [p.strip() for p in packages if p.strip()]
    if not pkgs:
        return {"code": 1, "stdout": "", "stderr": "패키지 이름이 없습니다", "seconds": 0}
    for p in pkgs:
        if any(ch in p for ch in " ;&|<>`$") or p.startswith("-"):
            return {"code": 1, "stdout": "", "stderr": f"패키지 이름이 이상합니다: {p!r}", "seconds": 0}
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", *pkgs]
    t0 = _now()
    try:
        proc = subprocess.run(cmd, env=_env(), capture_output=True, timeout=timeout_s,
                              text=True, encoding="utf-8", errors="replace")
        out, err, code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired:
        out, err, code = "", f"시간 초과 ({timeout_s}초)", -1
    if code != 0 and "No module named pip" in (err + out):
        err += "\n이 인터프리터에 pip 이 없습니다. 0.5.1 이후 설치본은 pip 을 동봉합니다; 그 전 설치본은 시스템 파이썬의 pip 으로 설치해 주세요."
    log.info("pip install %s -> %s %.1fs", pkgs, code, _now() - t0)
    return {"code": code, "stdout": out[-MAX_OUTPUT:], "stderr": err[-MAX_OUTPUT:], "seconds": round(_now() - t0, 1),
            "python": sys.executable}


def describe(req: dict) -> str:
    return f"[{req['kind']}] {req['summary']}"


def safe_summary(command: str) -> str:
    try:
        parts = shlex.split(command, posix=(os.name != "nt"))
    except ValueError:
        parts = command.split()
    return " ".join(parts)[:160]


__all__ = ["request", "pending", "decide", "decision", "end_turn", "run_shell", "pip_install", "KINDS"]
_ = Any
