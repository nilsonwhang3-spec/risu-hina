"""Logging.

Exists because the first time a real user hit a problem, the log held only
start/exit markers: uvicorn's access log is off (noisy, and it duplicates the
dispatcher's own line) and nothing replaced it. Now every request, every
mutation, and every client-side error lands here with enough context to
reconstruct what happened without asking the user to reproduce it.

Two levels:
    info   requests, mutations, lifecycle - always on
    debug  payload shapes, decisions, timings - RISUELF_DEBUG=1

Never logs the agent API key or the auth token. Bodies are summarised by shape
and size rather than dumped, because a single request here can carry a
multi-megabyte transcript.

The last few thousand lines are also kept in memory. Once this ships, a user
hitting a problem cannot be asked to find a log file on a machine they may be
addressing over Tailscale from a phone - the panel has to be able to hand them
the text. `recent()` is what the settings panel copies out.
"""
from __future__ import annotations

import os
import sys
import threading
import time
from collections import deque
from typing import Any

DEBUG = (os.environ.get("RISUELF_DEBUG") or "").strip().lower() in ("1", "true", "yes", "on")

_lock = threading.Lock()

# Bounded on purpose: this is a debugging aid, not an archive, and an unbounded
# buffer in a long-running process is a slow leak.
RING_SIZE = 4000
_ring: deque[str] = deque(maxlen=RING_SIZE)


def _emit(level: str, msg: str, *args: Any) -> None:
    try:
        text = msg % args if args else msg
    except (TypeError, ValueError):
        text = f"{msg} {args!r}"
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] {level:<5} {text}"
    with _lock:
        _ring.append(line)
        print(line, flush=True)


def recent(limit: int = 500, level: str = "") -> list[str]:
    """The tail of the log, newest last.

    `level` filters to that level and above, using the order below; an unknown
    value means no filtering, because a typo should not silently return
    nothing when someone is trying to diagnose a problem.
    """
    order = {"debug": 0, "info": 1, "warn": 2, "error": 3}
    floor = order.get(level.strip().lower())
    with _lock:
        lines = list(_ring)
    if floor is not None:
        lines = [
            ln for ln in lines
            if order.get(ln[22:27].strip().lower(), 1) >= floor
        ]
    return lines[-max(1, min(limit, RING_SIZE)):]


def info(msg: str, *args: Any) -> None:
    _emit("info", msg, *args)


def warn(msg: str, *args: Any) -> None:
    _emit("warn", msg, *args)


def error(msg: str, *args: Any) -> None:
    _emit("error", msg, *args)


def debug(msg: str, *args: Any) -> None:
    if DEBUG:
        _emit("debug", msg, *args)


def exception(prefix: str) -> None:
    import traceback
    with _lock:
        print(f"[{time.strftime('%H:%M:%S')}] error {prefix}", flush=True)
        traceback.print_exc(file=sys.stdout)
        sys.stdout.flush()


SECRET_HINTS = ("apikey", "token", "secret", "password", "authorization")


def shape(value: Any, depth: int = 0) -> str:
    """Describe a payload without printing it.

    A request body here can be a whole transcript, so the log gets the shape
    and the sizes - which is what actually answers "why did that fail" - and
    never the content.
    """
    if depth > 3:
        return "..."
    if value is None:
        return "null"
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return f"str({len(value)})"
    if isinstance(value, list):
        if not value:
            return "[]"
        return f"[{len(value)} x {shape(value[0], depth + 1)}]"
    if isinstance(value, dict):
        parts = []
        for k, v in list(value.items())[:12]:
            if any(h in str(k).lower() for h in SECRET_HINTS):
                parts.append(f"{k}=<redacted>")
            else:
                parts.append(f"{k}={shape(v, depth + 1)}")
        more = "" if len(value) <= 12 else f", +{len(value) - 12}"
        return "{" + ", ".join(parts) + more + "}"
    return type(value).__name__
