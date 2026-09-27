"""RisuAI's own server save, read from its save folder (§1-80).

A fake RisuAI save folder: a SQLite `kv` table shaped like NodeOnly's
(key, value, updated_at ms). Checks the stamp is read, that "saved after a
moment" is judged against it, and that a missing folder means "cannot tell".

    python tests/test_risupersist.py
"""
from __future__ import annotations

import asyncio
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = Path(tempfile.mkdtemp(prefix="risuhina-persist-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)

from app import config, risupersist  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else f" - {detail}"))
    if not cond:
        FAILURES.append(name)


config.load()
save = Path(tempfile.mkdtemp(prefix="risu-save-"))
db = save / "risuai.db"


def stamp(t: float) -> None:
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value BLOB, updated_at INTEGER)")
    con.execute("INSERT INTO kv(key, value, updated_at) VALUES('database/database.bin', x'00', ?) "
                "ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at", (int(t * 1000),))
    con.commit()
    con.close()


print("test_unavailable_without_save_folder")
st = risupersist.status()
check("no save folder configured = cannot tell", st["available"] is False and st["reason"], str(st))
check("and says nothing in a tool result", risupersist.describe({**st, "saved": False}) == "")

print("test_reads_the_stamp")
t0 = time.time() - 100
stamp(t0)
config.update({"pocketrisu": {"savePath": str(save)}})
st = risupersist.status()
check("the save time is read (ms -> s)", st["available"] and abs((st["savedAt"] or 0) - t0) < 0.01, str(st))

print("test_wait_saved")
since = time.time()
r = asyncio.run(risupersist.wait_saved(since, timeout=1.0))
check("an older save is not taken for this write", r["saved"] is False, str(r))
check("and the note warns not to reload", "새로고침" in risupersist.describe(r), risupersist.describe(r))


async def save_soon() -> dict:
    async def later():
        await asyncio.sleep(0.5)
        stamp(time.time())
    task = asyncio.create_task(later())
    got = await risupersist.wait_saved(since, timeout=6.0)
    await task
    return got

r = asyncio.run(save_soon())
check("a save after the write is seen", r["saved"] is True, str(r))
check("and the note confirms it", "저장 확인됨" in risupersist.describe(r), risupersist.describe(r))

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - RisuAI's own server save is read, judged against the write, and silent when unknown")
