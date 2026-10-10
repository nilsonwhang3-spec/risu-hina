"""Bots RisuAI no longer has (§1-102): presence, the orphan list, forgetting one.

    pyserver/.venv/Scripts/python.exe tests/test_bot_presence.py

The field case: Over The Next 0.2 imported, trashed in PocketRisu, 0.3
imported - two rows in Hina with the same name, one of them gone from
RisuAI. The panel compares Hina's bots with RisuAI's `characters`; what is
not live is listed, can be saved as .charx and forgotten. A live bot can't be.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-presence-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")

from app import actions, agent, config, db, presence, workspace  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else (' - ' + str(detail)[:300])}")
    if not cond:
        FAILURES.append(name)


def bot(cha_id: str, name: str, idx: int, card: dict | None = None) -> str:
    c = {"name": name, "chaId": cha_id, "desc": name + " 설명", **(card or {})}
    r = workspace.materialize({"charId": cha_id, "characterIndex": idx, "card": c,
                               "chats": [{"chat": {"id": cha_id + "-c", "name": "챗",
                                                   "message": [{"role": "user", "data": "hi", "time": 1, "chatId": "m1"}]},
                                          "chatIndex": 0}]})
    return r["charKey"]


def state(ck: str) -> str:
    return next((b["state"] for b in presence.listing() if b["charKey"] == ck), "?")


def main() -> int:
    config.load()
    db.connect()
    old = bot("cha-otn-02", "Over The Next", 0)
    new = bot("cha-otn-03", "Over The Next", 1)
    trashed = bot("cha-trash", "휴지통 봇", 2)
    live = bot("cha-live", "살아 있는 봇", 3)
    check("opening a bot marks it live", state(old) == "live" and state(new) == "live")

    try:
        presence.record([])
        refused = False
    except presence.PresenceError:
        refused = True
    check("an empty RisuAI list is refused, not read as 'everything is gone'", refused)
    check("and nothing changed", state(old) == "live")

    r = presence.record([{"chaId": "cha-otn-03", "name": "Over The Next"},
                         {"chaId": "cha-trash", "name": "휴지통 봇", "trashTime": 1_790_000_000_000},
                         {"chaId": "cha-live", "name": "살아 있는 봇"},
                         {"chaId": "§temp"}])
    check("counts by state", r["counts"] == {"live": 2, "trash": 1, "missing": 1}, r["counts"])
    rows = {b["charKey"]: b for b in r["bots"]}
    check("the old version is missing, the new one live", rows[old]["state"] == "missing" and rows[new]["state"] == "live")
    check("the missing one says a live bot of its name exists", rows[old]["liveNamesake"] is True)
    check("RisuAI trash carries its time and purge date",
          rows[trashed]["state"] == "trash" and rows[trashed]["purgeAt"] == 1_790_000_000_000 + 3 * 86400 * 1000)
    check("rows report chats and turns", rows[old]["chats"] == 1 and rows[old]["turns"] == 1, rows[old])

    # The reference tools pick the live one of two namesakes.
    with patch.object(agent, "_model", return_value=TestModel()):
        ag = agent.build()
    tools = ag._function_toolset.tools
    ctx = SimpleNamespace(deps=agent.Deps(f"{live}:c", live, "", Path(DATA.name), mode="bot", bot_key=live))
    ov = tools["ref_bot_overview"].function(ctx, bot="Over The Next")
    check("a name shared by a live bot and its leftover resolves to the live one", "Over The Next" in ov and "여러 개" not in ov, ov)
    lst = tools["list_reference_bots"].function(ctx)
    check("the leftover is tagged in the reference list", "RisuAI에 없음" in lst and "RisuAI 휴지통" in lst, lst)

    # A .charx of a leftover, from Hina's copy alone (no RisuAI, no panel).
    from app import charx
    full = workspace.materialize({"charId": "cha-full", "characterIndex": 6, "cardFull": True,
                                  "card": {"name": "온전한 카드", "chaId": "cha-full", "desc": "본문"}, "chats": []})["charKey"]
    presence.record([{"chaId": "cha-otn-03"}, {"chaId": "cha-trash", "trashTime": 1}, {"chaId": "cha-live"}])
    rows = {b["charKey"]: b for b in presence.listing()}
    check("a full card is charx-ready, an old partial upload is not",
          rows[full]["charxReady"] is True and rows[old]["charxReady"] is False)
    built = charx.build(full, allow_missing=True)
    check("a leftover builds a .charx from Hina alone", built.get("ok") and str(built.get("path", "")).endswith(".charx"), built)

    # Forget: never a live bot.
    try:
        presence.forget(new)
        refused = False
    except presence.PresenceError:
        refused = True
    check("a live bot cannot be forgotten", refused and state(new) == "live")

    actions.propose("card_edit", chat_key=f"{old}:x", char_key=old, summary="x", args={})
    sys_dir = workspace.root(old)
    sys_dir.mkdir(parents=True, exist_ok=True)
    out = presence.forget(old)
    check("forgetting removes the bot and its rows", db.one("SELECT 1 FROM characters WHERE char_key = ?", (old,)) is None
          and db.one("SELECT 1 FROM chats WHERE char_key = ?", (old,)) is None
          and db.one("SELECT 1 FROM card_fields WHERE char_key = ?", (old,)) is None
          and db.one("SELECT 1 FROM pending_actions WHERE char_key = ?", (old,)) is None, out)
    check("and its own system folder", not sys_dir.exists(), str(sys_dir))
    check("the live namesake is untouched", state(new) == "live")
    check("the trashed bot can be forgotten too", presence.forget(trashed)["name"] == "휴지통 봇")

    # A family directory shared with a live copy stays.
    fam_a = bot("cha-fam-a", "가족 원본", 4)
    fam_b = workspace.materialize({"charId": "cha-fam-b", "characterIndex": 5,
                                   "card": {"name": "가족 사본", "chaId": "cha-fam-b",
                                            "extentions": {"risu_hina": {"family": fam_a}}},
                                   "chats": []})["charKey"]
    presence.record([{"chaId": "cha-fam-b"}, {"chaId": "cha-otn-03"}, {"chaId": "cha-live"}])
    shared = workspace.root(fam_a)
    shared.mkdir(parents=True, exist_ok=True)
    check("the copy lives in the original's folder", workspace.root(fam_b) == shared)
    presence.forget(fam_a)
    check("forgetting the original keeps the folder its live copy uses", shared.exists())

    print()
    print("ALL OK" if not FAILURES else f"FAIL - {len(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
