"""Reference bots (§1-101): other bots in Hina's DB are READ-ONLY references.

    pyserver/.venv/Scripts/python.exe tests/test_reference_bots.py

The user asks, with bot A open, "B 봇의 상태창 기능 참고해서 구현해줘". The
agent finds B in Hina's DB, reads its card / Regex / Lua / lorebook, and
proposes the adapted result as NEW entries on A. Nothing may write to B: a
proposal carrying one of B's row ids is refused, whichever tool made it.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-refbots-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")

from app import actions, agent, config, db, workspace  # noqa: E402
from app import card as cardmod  # noqa: E402
from app import store  # noqa: E402
from pydantic_ai.models.test import TestModel  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if cond else 'FAIL'} {name}{'' if cond else (' - ' + detail[:300])}")
    if not cond:
        FAILURES.append(name)


def bot(cha_id: str, name: str, idx: int, extra: dict) -> str:
    card = {"name": name, "chaId": cha_id, "desc": f"{name} 설명", "firstMessage": "안녕", **extra}
    r = workspace.materialize({"charId": cha_id, "characterIndex": idx, "card": card,
                               "chats": [{"chat": {"id": cha_id + "-c", "name": "챗", "message": []}, "chatIndex": 0}]})
    return r["charKey"]


def main() -> int:
    config.load()
    db.connect()
    a = bot("cha-a", "알파", 0, {})
    b = bot("cha-b", "베타 기사단", 1, {
        "customscript": [{"comment": "상태창 HTML", "in": "<status>", "out": "<div class=hud>{{getvar::hp}}</div>", "type": "editdisplay"}],
        "triggerscript": [{"comment": "상태창 Lua", "type": "start", "conditions": [], "lowLevelAccess": False,
                           "effect": [{"type": "triggerlua", "code": "local hp = getChatVar(id, 'hp')\nprint(hp)"}]}],
        "globalLore": [{"key": "기사단", "comment": "기사단 규율", "content": "규율 본문", "insertorder": 100}],
    })
    print("rows: a=%s b=%s fields=%d scripts=%d lore=%d" % (
        a, b, len(cardmod.listing(b)["fields"]), len(cardmod.scripts(b, "customscript")), len(store.lore(b))))

    with patch.object(agent, "_model", return_value=TestModel()):
        ag = agent.build()
    tools = ag._function_toolset.tools
    ctx = SimpleNamespace(deps=agent.Deps(f"{a}:chat", a, "", Path(DATA.name), mode="bot", bot_key=a))

    def call(name: str, **kw):
        return tools[name].function(ctx, **kw)

    out = call("list_reference_bots")
    check("the other bot is listed, the open one is not", "베타 기사단" in out and "알파" not in out, out)
    check("a name filter narrows the list", "베타" in call("list_reference_bots", query="기사") and
          "없습니다" in call("list_reference_bots", query="없는이름"))

    ov = call("ref_bot_overview", bot="베타")
    check("the overview names its Regex, trigger and lore", "상태창 HTML" in ov and "상태창 Lua" in ov and "기사단 규율" in ov, ov)
    check("a reference is said to be read-only", "읽기 전용" in ov)
    check("the open bot is not a reference", "지금 연 봇" in call("ref_bot_overview", bot="알파"))
    check("an unknown name says how to find one", "list_reference_bots" in call("ref_bot_overview", bot="감마"))

    hits = json.loads(call("ref_search", bot="베타 기사단", query="getChatVar").split("\n", 1)[1])
    check("search finds text deep in the Lua", hits["total"] >= 1 and hits["items"][0]["readTool"] == "ref_read", json.dumps(hits)[:300])
    sid = hits["items"][0]["id"]
    body = call("ref_read", bot="베타", id=sid)
    check("ref_read returns the whole script entry", "triggerlua" in body and "getChatVar" in body, body)
    code = call("ref_read_script_text", bot="베타", script_id=sid, field="/effect/0/code")
    check("the Lua reads as raw text", "local hp = getChatVar(id, 'hp')\nprint(hp)" in code, code)

    regex = call("ref_list_scripts", bot="베타", kind="customscript")
    check("Regex entries list with ids", "상태창 HTML" in regex and "id=" in regex, regex)
    lore = call("ref_list_lore", bot="베타")
    lid = lore.split("id=", 1)[1].split()[0]
    check("lore lists and reads", "규율 본문" in call("ref_read", bot="베타", id=lid), lore)
    card = call("ref_read_card", bot="베타")
    fid = card.split("[desc] id=", 1)[1].split()[0]
    check("card rows read in full", "베타 기사단 설명" in call("ref_read", bot="베타", id=fid), card)
    a_field = cardmod.listing(a)["fields"][0]["id"]
    check("ref_read refuses an id from another bot", "없습니다" in call("ref_read", bot="베타", id=a_field))

    # Read-only: B's ids are refused by proposals, whatever the tool.
    try:
        actions.propose("lore_delete", chat_key=f"{a}:chat", char_key=a, summary="x", args={"id": lid})
        refused = False
    except actions.ActionError as e:
        refused = "읽기 전용" in str(e)
    check("a proposal on a reference bot's lore id is refused", refused)
    try:
        actions.propose("script_delete_many", chat_key=f"{a}:chat", char_key=a, summary="x", args={"ids": [sid]})
        refused = False
    except actions.ActionError:
        refused = True
    check("a bulk proposal with a reference bot's id is refused", refused)
    res = call("propose_card_edit", field_id=fid, new_body="덮어쓰기", reason="t")
    check("propose_card_edit on a reference field says read-only", "읽기 전용" in res, res)
    own = cardmod.listing(a)["fields"]
    own_desc = next(f for f in own if f["field"] == "desc")
    res = call("propose_card_edit", field_id=own_desc["id"], new_body="알파 새 설명", reason="t")
    check("the open bot's own rows still propose", "제안했습니다" in res, res)
    check("nothing on the reference bot changed", next(f for f in cardmod.listing(b)["fields"] if f["field"] == "desc")["body"] == "베타 기사단 설명")

    print()
    print("ALL OK" if not FAILURES else f"FAIL - {len(FAILURES)}")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
