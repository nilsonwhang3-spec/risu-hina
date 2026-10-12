"""저장공간 정리 (§1-106): orphan chats and modules, the snapshot list, temp files by kind.

    pyserver/.venv/Scripts/python.exe tests/test_storage_cleanup.py

Bots RisuAI no longer has are test_bot_presence.py's. Here: the same
comparison judging a live bot's chats (by chat.id) and the module working
copies (by module id); forgetting each; every snapshot table in one list
with deletion by {type, id}; and the temp scan - kinds, per-bot groups, a
clean that deletes only what was scanned and skips files changed since.
"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-storage-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")

from app import config, db, personas, presence, snapshots, storage, workspace  # noqa: E402
from app import modules as modmod  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else (' - ' + str(detail)[:300])}")
    if not cond:
        FAILURES.append(name)


def chat(cid: str, n: int = 2) -> dict:
    return {"id": cid, "name": "챗 " + cid,
            "message": [{"role": "user", "data": f"m{i}", "time": i, "chatId": f"{cid}-m{i}"} for i in range(n)]}


def main() -> int:
    config.load()
    db.connect()
    r = workspace.materialize({"charId": "cha-a", "characterIndex": 0,
                               "card": {"name": "봇 A", "chaId": "cha-a", "desc": "x"},
                               "chats": [{"chat": chat("a1"), "chatIndex": 0}, {"chat": chat("a2"), "chatIndex": 1}]})
    a = r["charKey"]
    keys = {c["chatId"]: c["chatKey"] for c in db.query("SELECT chat_key AS chatKey, chat_id AS chatId FROM chats")}
    a1, a2 = keys["a1"], keys["a2"]
    gone_bot = workspace.materialize({"charId": "cha-b", "characterIndex": 1,
                                      "card": {"name": "봇 B", "chaId": "cha-b"},
                                      "chats": [{"chat": chat("b1"), "chatIndex": 0}]})["charKey"]
    st = lambda tk: db.one("SELECT risu_state FROM chats WHERE chat_key = ?", (tk,))["risu_state"]  # noqa: E731
    check("an uploaded chat is live", st(a1) == "live" and st(a2) == "live")

    m_live = modmod.sync({"id": "11111111-0000-4000-8000-000000000001", "name": "쓰는 모듈"})["key"]
    m_gone = modmod.sync({"id": "11111111-0000-4000-8000-000000000002", "name": "지운 모듈"})["key"]
    check("a synced module is live", modmod.meta(m_gone).get("risuState") == "live")

    # RisuAI: bot A without chat a2, bot B gone, one module gone.
    out = presence.record([{"chaId": "cha-a", "chats": ["a1"]}],
                          ["11111111-0000-4000-8000-000000000001"])
    check("a chat its bot no longer has is missing", st(a2) == "missing" and st(a1) == "live")
    check("a gone bot's chats are not judged on their own",
          st(next(iter(c["chat_key"] for c in db.query("SELECT chat_key FROM chats WHERE char_key = ?", (gone_bot,))))) == "")
    check("counts come back", out["chatCounts"]["missing"] == 1 and out["moduleCounts"] == {"live": 1, "missing": 1}, out)
    orphans = presence.chat_listing()
    check("the orphan chat list has a2 with its bot and turns",
          [c["chatKey"] for c in orphans] == [a2] and orphans[0]["bot"] == "봇 A" and orphans[0]["turns"] == 2, orphans)

    # Without chat ids (an older panel), chats keep their state unjudged... reset to ''.
    presence.record([{"chaId": "cha-a"}])
    check("no chat list = not judged", st(a2) == "")
    check("no module list = modules untouched", modmod.meta(m_gone).get("risuState") == "missing")
    presence.record([{"chaId": "cha-a", "chats": ["a1"]}], ["11111111-0000-4000-8000-000000000001"])

    try:
        presence.forget_chat(a1)
        refused = False
    except presence.PresenceError:
        refused = True
    check("a live chat cannot be forgotten", refused)
    snapshots.create(a2, "내 스냅샷")
    sys_orig = workspace.root(a) / "original" / f"{a2}.md"
    check("the chat's frozen original exists", sys_orig.exists(), str(sys_orig))
    presence.forget_chat(a2)
    check("forgetting a chat removes its rows, snapshots and original",
          db.one("SELECT 1 FROM chats WHERE chat_key = ?", (a2,)) is None
          and db.one("SELECT 1 FROM turns WHERE chat_key = ?", (a2,)) is None
          and db.one("SELECT 1 FROM checkpoints WHERE chat_key = ?", (a2,)) is None
          and not sys_orig.exists())
    check("the other chat stays", db.one("SELECT 1 FROM turns WHERE chat_key = ?", (a1,)) is not None)

    check("the orphan module list has only the gone one", [m["key"] for m in presence.module_listing()] == [m_gone])
    try:
        presence.forget_module(m_live)
        refused = False
    except presence.PresenceError:
        refused = True
    check("a live module cannot be forgotten", refused)
    snapshots.create_card(m_gone, "모듈 스냅샷")
    presence.forget_module(m_gone)
    check("forgetting a module drops its copy and snapshots",
          not modmod.meta(m_gone) and db.one("SELECT 1 FROM characters WHERE char_key = ?", (m_gone,)) is None
          and db.one("SELECT 1 FROM card_checkpoints WHERE char_key = ?", (m_gone,)) is None)
    modmod.sync({"id": "11111111-0000-4000-8000-000000000001", "name": "쓰는 모듈"})
    check("opening a module again marks it live", modmod.meta(m_live).get("risuState") == "live")

    # --- the snapshot list ---------------------------------------------------
    snapshots.create(a1, "챗 스냅샷")
    snapshots.create(a1, "반영 직전", kind="auto")
    bot_snap = snapshots.create_card(a, "봇 스냅샷")
    personas.sync([{"id": "p1", "name": "나", "personaPrompt": "hi"}])
    pk = personas.listing()[0]["key"]
    personas.checkpoint_create(pk, "페르소나 스냅샷")
    db.execute("INSERT INTO checkpoints(id, chat_key, label, markdown, meta_json, message_count, created_at, kind) "
               "VALUES('orph', 'tgone', '주인 없음', 'x', '{}', 0, ?, 'user')", (time.time(),))
    rows = storage.snapshot_listing()
    by = {(x["type"], x["label"]): x for x in rows}
    check("all four kinds listed", {"bot", "chat", "persona"} <= {x["type"] for x in rows}, [x["type"] for x in rows])
    check("auto vs user", by[("chat", "반영 직전")]["auto"] is True and by[("chat", "챗 스냅샷")]["auto"] is False)
    check("owners named", by[("bot", "봇 스냅샷")]["owner"] == "봇 A" and by[("persona", "페르소나 스냅샷")]["owner"] == "나")
    check("a snapshot whose chat is gone is an orphan", by[("chat", "주인 없음")]["orphan"] is True
          and by[("chat", "챗 스냅샷")]["orphan"] is False)
    check("sizes counted", by[("bot", "봇 스냅샷")]["bytes"] > 0)
    d = storage.snapshot_delete([{"type": "bot", "id": bot_snap}, {"type": "chat", "id": "orph"}, {"type": "chat", "id": "nope"}])
    check("delete by type and id", d["removed"] == 2 and d["missing"] == ["nope"], d)
    check("and they are gone", not any(x["id"] in (bot_snap, "orph") for x in storage.snapshot_listing()))

    # --- temp files ------------------------------------------------------------
    space = workspace.space_root()
    hina_bot = workspace.hina_dir(a)
    (hina_bot / "scratch" / "deep").mkdir(parents=True, exist_ok=True)
    (hina_bot / "scratch" / "deep" / "x.json").write_text("x" * 100, encoding="utf-8")
    (hina_bot / "scripts" / "_agent_run.py").write_text("print(1)", encoding="utf-8")
    (hina_bot / "scripts" / "risuhina.py").write_text("helper", encoding="utf-8")
    (space / "hina" / ".cleanup" / "old").mkdir(parents=True, exist_ok=True)
    (space / "hina" / ".cleanup" / "old" / "a.bin").write_bytes(b"z" * 500)
    keep = space / "projects" / "봇 A" / "keep.txt"
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_text("mine", encoding="utf-8")
    part = space / "projects" / "봇 A" / "up.part"
    part.write_bytes(b"p" * 10)
    fresh_part = space / "projects" / "봇 A" / "now.part"
    fresh_part.write_bytes(b"p")
    old = time.time() - 3 * 86400
    os.utime(part, (old, old))
    thumbs = space / "studio" / "config" / ".studio" / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    (thumbs / "t.webp").write_bytes(b"t" * 40)
    sysscr = workspace.root(a) / "scratch" / "assets"
    sysscr.mkdir(parents=True, exist_ok=True)
    (sysscr / "old.png").write_bytes(b"i" * 70)
    tr = config.DATA_DIR / "tool-results" / ("f" * 64)
    tr.mkdir(parents=True, exist_ok=True)
    (tr / "r.txt").write_text("result", encoding="utf-8")

    scan = storage.temp_scan()
    k = {x["id"]: x for x in scan["kinds"]}
    check("scratch counted per bot", k["scratch"]["count"] == 1 and k["scratch"]["groups"][0]["group"] == hina_bot.name, k["scratch"])
    check("scripts without the helper", k["scripts"]["count"] == 1, k["scripts"])
    check("the old quarantine", k["cleanup"]["count"] == 1 and k["cleanup"]["bytes"] == 500)
    check("a stale upload fragment, not a fresh one", k["caches"]["count"] == 1, k["caches"])
    check("thumbnails", k["thumbs"]["count"] == 1)
    check("system scratch named by bot", k["system"]["count"] == 1 and k["system"]["groups"][0]["group"] == "봇 A", k["system"])
    check("tool results of finished sessions", k["toolresults"]["count"] == 1)

    # A file changed after the scan is skipped, not deleted.
    (space / "hina" / ".cleanup" / "old" / "a.bin").write_bytes(b"z" * 501)
    res = storage.temp_clean(scan["plan"], [{"kind": "cleanup"}, {"kind": "scratch", "group": hina_bot.name},
                                            {"kind": "caches"}, {"kind": "system", "group": "다른 봇"}])
    check("changed file skipped", res["skipped"] == 1 and (space / "hina" / ".cleanup" / "old" / "a.bin").exists(), res)
    check("picked kinds removed", not (hina_bot / "scratch" / "deep" / "x.json").exists() and not part.exists(), res)
    check("emptied folders go, the scratch root stays", not (hina_bot / "scratch" / "deep").exists() and (hina_bot / "scratch").is_dir())
    check("a group not picked stays", (sysscr / "old.png").exists())
    check("unpicked kinds and the user's files stay",
          (thumbs / "t.webp").exists() and keep.exists() and fresh_part.exists() and (hina_bot / "scripts" / "risuhina.py").exists())
    try:
        storage.temp_clean(scan["plan"], [{"kind": "thumbs"}])
        stale = False
    except storage.StorageError:
        stale = True
    check("a plan is used once", stale)

    print()
    print("ALL OK" if not FAILURES else f"FAIL - {len(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
