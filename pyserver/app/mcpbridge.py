"""The panel side of MCP: who is holding the door open, and on which bot.

An MCP client reaches the backend directly, but two things only the plugin
has: **which bot and chat the user has open** (the host cannot be told to
select another one - docs/08 §1), and the host APIs that write to RisuAI.
So MCP works only while a panel has pressed 'MCP 연결' and keeps polling:

- `poll()` is a long poll. The panel sends its current context (bot, chat,
  screen) and the backend holds the request until a host job arrives or ~20s
  pass. A held fetch is not a timer, so a hidden or occluded RisuAI tab -
  where browsers throttle setTimeout to once a minute - keeps its lease.
- The lease is alive while a poll is in flight or ended less than LEASE_S
  ago. Tool calls check it and refuse with a sentence the MCP client can
  relay ("켜 주세요"), rather than acting on a bot nobody is looking at.
- Host jobs (today: the user-requested card save) are queued here and
  handed to the next poll, the MCP twin of `session.push_stream_event`.

The MCP bearer token is separate from the backend token and ALWAYS required,
loopback included: behind a same-host tunnel (cloudflared → 127.0.0.1)
every request looks like loopback, and the MCP surface includes the whole
agent toolset. Rotating it cuts off every configured client at once.
"""
from __future__ import annotations

import asyncio
import secrets
import threading
import time
from typing import Any

from . import config, db, log

# How long after the last poll ended the lease still holds. The panel re-polls
# at once, so the normal gap is one round trip; this only has to cover a retry
# after a network error. Short, because closing the RisuAI window cannot send
# anything - the lease running out (or the held poll's disconnect) is what
# switches MCP off then.
LEASE_S = 15.0
HOLD_S = 20.0
TOKEN_FILE = "mcp_token.txt"
MCP_SESSION_TITLE = "__mcp__"

_lock = threading.Lock()
_state: dict[str, Any] = {
    "enabled": False,       # the panel's switch
    "pollAt": 0.0,          # last poll start or end
    "inFlight": 0,          # polls currently held
    "context": {},          # {charKey, chatKey, botName, chatName, mode}
    "calls": 0,
    "lastCall": None,       # {tool, at, ok}
    "clientName": "",
}
_jobs: list[dict] = []
_wake: asyncio.Event | None = None
_loop: asyncio.AbstractEventLoop | None = None
_token = ""


# --- token -----------------------------------------------------------------

def token(rotate: bool = False) -> str:
    global _token
    path = config.DATA_DIR / TOKEN_FILE
    with _lock:
        if rotate or not _token:
            existing = ""
            if not rotate:
                try:
                    existing = path.read_text(encoding="utf-8").strip()
                except OSError:
                    existing = ""
            _token = existing or ("hmcp_" + secrets.token_urlsafe(32))
            if rotate or not existing:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(_token + "\n", encoding="utf-8")
                if rotate:
                    log.info("mcp token rotated")
        return _token


def check_token(header: str) -> bool:
    import hmac
    return hmac.compare_digest((header or "").strip(), f"Bearer {token()}")


# --- lease and context -------------------------------------------------------

def active() -> bool:
    with _lock:
        if not _state["enabled"]:
            return False
        alive = _state["inFlight"] > 0 or (time.time() - _state["pollAt"]) < LEASE_S
        if not alive and _state["context"]:
            # The panel is gone (window closed): forget what it had open. A
            # returning poll sets it again.
            _state["context"] = {}
        return alive


def context() -> dict:
    with _lock:
        return dict(_state["context"])


def set_enabled(on: bool, ctx: dict | None = None) -> dict:
    with _lock:
        _state["enabled"] = bool(on)
        _state["pollAt"] = time.time() if on else 0.0
        if ctx is not None:
            _state["context"] = _clean_ctx(ctx)
        if not on:
            _jobs.clear()
            # Off means a token holder learns nothing: not even which bot and
            # chat were open last (hina_status would have said).
            _state["context"] = {}
    if not on:
        # Outstanding download/upload URLs die with the switch.
        from . import mcpserver
        mcpserver.clear_tickets()
    log.info("mcp bridge %s", "enabled" if on else "disabled")
    _notify()
    return status()


def _clean_ctx(ctx: dict) -> dict:
    # persona: the key of the persona open in the panel's persona tab.
    keep = ("charKey", "chatKey", "botName", "chatName", "mode", "persona")
    return {k: str(ctx.get(k) or "")[:200] for k in keep}


def note_call(tool: str, ok: bool) -> None:
    with _lock:
        _state["calls"] += 1
        _state["lastCall"] = {"tool": tool, "at": time.time(), "ok": ok}


def note_client(name: str) -> None:
    with _lock:
        _state["clientName"] = (name or "")[:80]


def status() -> dict:
    from . import mcpaddon, mcpserver
    with _lock:
        st = {k: v for k, v in _state.items() if k != "inFlight"}
        st["polling"] = _state["inFlight"] > 0
        st["pendingJobs"] = len(_jobs)
    st["active"] = active()
    st["addon"] = {"installed": mcpaddon.status()["installed"], "loaded": mcpaddon.loaded()}
    st["mounted"] = mcpserver.mounted()
    return st


# --- host jobs ----------------------------------------------------------------

def _notify() -> None:
    if _wake is not None and _loop is not None:
        try:
            _loop.call_soon_threadsafe(_wake.set)
        except RuntimeError:
            pass


def push_job(job: dict) -> None:
    """Queue one host job for the panel. Called from tool threads."""
    with _lock:
        _jobs.append(dict(job, queuedAt=time.time()))
    _notify()


def is_mcp_session(session_id: str | None) -> bool:
    if not session_id:
        return False
    row = db.one("SELECT title FROM sessions WHERE id = ?", (session_id,))
    return bool(row and row["title"] == MCP_SESSION_TITLE)


def _pending_actions(chat_key: str, char_key: str) -> dict:
    """A cheap fingerprint of what awaits approval, so the panel refreshes its
    proposal list when an MCP call adds one - it has no turn stream to hear it."""
    if not char_key:
        return {"actions": 0, "staged": 0, "rev": ""}
    a = db.one("SELECT COUNT(*) AS n, MAX(created_at) AS m FROM pending_actions "
               "WHERE char_key = ? AND status = 'pending'", (char_key,))
    s = db.one("SELECT COUNT(*) AS n, MAX(created_at) AS m FROM staged_edits "
               "WHERE chat_key = ? AND status = 'pending'", (chat_key,)) if chat_key else None
    na, ma = (a["n"] or 0, a["m"] or 0) if a else (0, 0)
    ns, ms = (s["n"] or 0, s["m"] or 0) if s else (0, 0)
    return {"actions": na, "staged": ns, "rev": f"{na}:{ma}:{ns}:{ms}"}


async def poll(ctx: dict, disconnected: Any = None) -> dict:
    """One long poll from the panel. Returns early when a job arrives.
    `disconnected` is the request's is_disconnected: a client that went away
    (window closed) ends the lease at once instead of after LEASE_S."""
    global _wake, _loop
    loop = asyncio.get_running_loop()
    if _wake is None or _loop is not loop:
        _wake, _loop = asyncio.Event(), loop
    with _lock:
        if not _state["enabled"]:
            return {"enabled": False, "jobs": []}
        _state["context"] = _clean_ctx(ctx)
        _state["pollAt"] = time.time()
        _state["inFlight"] += 1
    gone = False
    try:
        deadline = time.time() + HOLD_S
        while True:
            with _lock:
                if _jobs or not _state["enabled"]:
                    break
            left = deadline - time.time()
            if left <= 0:
                break
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), timeout=min(left, 2.0))
            except asyncio.TimeoutError:
                pass
            if disconnected is not None:
                try:
                    gone = bool(await disconnected())
                except Exception:  # noqa: BLE001 - no probe, no early end
                    gone = False
                if gone:
                    break
            # Proposal counts are sampled every couple of seconds so a new
            # proposal reaches the panel without a job being queued.
            if time.time() - (deadline - HOLD_S) >= 2.0:
                c = ctx.get("pendingRev")
                now = _pending_actions(str(ctx.get("chatKey") or ""), str(ctx.get("charKey") or ""))["rev"]
                if c is not None and now != c:
                    break
    finally:
        with _lock:
            _state["inFlight"] -= 1
            if gone:
                # Undelivered jobs stay queued; a lapsed lease is what makes
                # tool calls refuse from here on.
                _state["pollAt"] = 0.0
                if _state["inFlight"] == 0:
                    _state["context"] = {}
                log.info("mcp bridge: panel poll disconnected - lease ended")
            else:
                _state["pollAt"] = time.time()
            jobs = [] if gone else list(_jobs)
            if not gone:
                _jobs.clear()
            enabled = _state["enabled"]
            last = _state["lastCall"]
            calls = _state["calls"]
    pend = _pending_actions(str(ctx.get("chatKey") or ""), str(ctx.get("charKey") or ""))
    return {"enabled": enabled, "jobs": jobs, "pending": pend, "lastCall": last, "calls": calls}
