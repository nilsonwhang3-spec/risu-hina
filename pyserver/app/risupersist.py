"""Did RisuAI actually keep it? The server-side save time of its database (§1-80).

Every write-back is verified by reading the character back - but that read
goes to the RisuAI TAB's memory. On 2026-09-27 a RisuAI (NodeOnly) tab's save
to its server failed once with a Cloudflare 524 while the machine was
thrashing, and the tab then saved nothing for three hours with no visible
warning; every Risu Hina write in that window "verified" and was lost on the
next reload (docs/06 §1-80).

When the RisuAI save directory is on this machine (the same `pocketrisu.
savePath` the asset fast path reads), its SQLite `kv` table carries
`database/database.bin` with an `updated_at` stamp that moves each time the
tab's save reaches the server. Comparing that stamp with the time of our
write tells whether the write was persisted. Read-only; any failure means
"cannot tell", never an error - on a setup without the save directory the
check is simply unavailable.
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

from . import assets, log

DB_KEY = "database/database.bin"


def status() -> dict:
    """{available, savedAt (epoch s or None), now, reason}."""
    now = time.time()
    info = assets.fast_path_info()
    if not info.get("fastPath"):
        return {"available": False, "savedAt": None, "now": now,
                "reason": "RisuAI 저장 폴더(pocketrisu.savePath)가 이 백엔드에 설정돼 있지 않습니다"}
    dbfile = Path(info["savePath"]) / "risuai.db"
    try:
        con = sqlite3.connect(f"file:{dbfile.as_posix()}?mode=ro", uri=True, timeout=5)
        try:
            con.execute("PRAGMA query_only = 1")
            con.execute("PRAGMA busy_timeout = 5000")
            cols = [r[1] for r in con.execute("PRAGMA table_info('kv')")]
            if "updated_at" not in cols or "key" not in cols:
                return {"available": False, "savedAt": None, "now": now, "reason": "RisuAI DB 형식을 알 수 없습니다"}
            row = con.execute("SELECT updated_at FROM kv WHERE key = ?", (DB_KEY,)).fetchone()
        finally:
            con.close()
    except sqlite3.Error as e:
        log.warn("risu persist check: %s", e)
        return {"available": False, "savedAt": None, "now": now, "reason": f"RisuAI DB 를 읽지 못했습니다: {e}"}
    if not row or row[0] is None:
        return {"available": False, "savedAt": None, "now": now, "reason": "RisuAI DB 에 저장 기록이 없습니다"}
    raw = float(row[0])
    return {"available": True, "savedAt": raw / 1000 if raw > 1e11 else raw, "now": now, "reason": ""}


async def wait_saved(since: float, timeout: float = 45.0) -> dict:
    """Wait until RisuAI's server save is newer than `since`. Returns the last
    status plus `saved` (True/False) - or `available: False` when it cannot tell."""
    deadline = time.time() + timeout
    st = await asyncio.to_thread(status)
    while st["available"] and (st["savedAt"] or 0) < since and time.time() < deadline:
        await asyncio.sleep(2.0)
        st = await asyncio.to_thread(status)
    st["saved"] = bool(st["available"] and (st["savedAt"] or 0) >= since)
    return st


def describe(st: dict) -> str:
    """One sentence for a tool result or a notice."""
    if not st.get("available"):
        return ""
    saved_at = time.strftime("%H:%M:%S", time.localtime(st["savedAt"])) if st.get("savedAt") else "?"
    if st.get("saved"):
        return f"RisuAI 서버 저장 확인됨 ({saved_at})."
    return (f"⚠ RisuAI 가 아직 서버에 저장하지 않았습니다 (마지막 서버 저장 {saved_at}). RisuAI 탭의 저장이 멈췄을 수 "
            "있으니 새로고침하거나 창을 닫지 말고 사용자에게 알리세요 - 새로고침하면 이 변경이 사라질 수 있습니다.")
