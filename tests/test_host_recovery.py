"""§1-100: lost answers, user-requested host actions, MCP file refresh, carried conversations.

- A repeated approval answers with the recorded outcome instead of "이미 처리된 작업입니다".
- write_card_to_risu with nothing to write says so (no action, no failure).
- A host action the panel does not start in time is cancelled with a clear reason.
- create_module runs through the panel and opens the module for focus_target.
- The turn handover carries proposal outcomes, unshipped counts and session moves.
- A conversation moves to another chat (session.move) and is listed there.
- MCP uploads / tool calls / batch images queue one coalesced 'files' job.

    python tests/test_host_recovery.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = Path(tempfile.mkdtemp(prefix="risuhina-hostrec-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import actions, agent, config, continuity, db, hostwriteback, main, mcpbridge, session, store, workspace  # noqa: E402
from app import card as cardmod  # noqa: E402
from app import modules as modmod  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


config.load()
db.connect()
workspace.ensure_space()

CK = store.upsert_character("cha-hostrec", "복구봇", {"name": "복구봇"}, 0)
CK2 = store.upsert_character("cha-hostrec-2", "다른봇", {"name": "다른봇"}, 1)
cardmod.ingest(CK, {"name": "복구봇", "desc": "설명"}, reset=True)


def add_chat(tk: str, ck: str, name: str) -> None:
    db.execute("INSERT INTO chats(chat_key, char_key, name, created_at, updated_at) VALUES(?,?,?,?,?)",
               (tk, ck, name, db.now(), db.now()))


TK, TK2 = "chat-hostrec-a", "chat-hostrec-b"
add_chat(TK, CK, "첫 챗")
add_chat(TK2, CK2, "둘째 챗")
SID = session.create(TK)["sessionId"]

print("== repeated decisions ==")
a = actions.propose("checkpoint_create", chat_key=TK, char_key=CK, summary="스냅샷", session_id=SID)
first = actions.decide(a["id"], True)
again = actions.decide(a["id"], True)
check("a repeated approval answers with the recorded result", again.get("already") is True
      and again.get("approved") is True and "스냅샷" in str(again.get("result")), str(again))
h = actions.propose("host_card_writeback", chat_key=TK, char_key=CK, summary="반영", session_id=SID)
actions.decide(h["id"], True)
rerun = actions.decide(h["id"], True)
check("an approved write-back whose report was lost is handed out again", rerun.get("host", {}).get("kind") == "host_card_writeback", str(rerun))
actions.complete(h["id"], True, "카드 변경 1건을 반영")
c = actions.propose("host_save_copy", chat_key=TK, char_key=CK, summary="사본", session_id=SID)
actions.decide(c["id"], True)
try:
    actions.decide(c["id"], True)
    check("a copy is never made twice", False, "no error")
except actions.ActionError as e:
    check("a copy is never made twice", "승인됨" in str(e), str(e))
r = actions.propose("checkpoint_create", chat_key=TK, char_key=CK, summary="거절할 것", session_id=SID)
actions.decide(r["id"], False)
check("a repeated rejection is quiet", actions.decide(r["id"], False).get("already") is True)
st = main.h_action_status({"id": h["id"]})
check("GET /actions/status reports the outcome", st["status"] == "done" and "반영" in st["result"], str(st))

print("== write_card_to_risu with nothing to write ==")
before = db.one("SELECT COUNT(*) AS n FROM pending_actions")["n"]
out = asyncio.run(hostwriteback.save_card(SID, CK, TK, "반영해줘"))
after = db.one("SELECT COUNT(*) AS n FROM pending_actions")["n"]
check("nothing unshipped: done, nothing queued", out.get("status") == "done" and out.get("nothing") and before == after, str(out))

print("== a host action the panel never starts ==")
hostwriteback.START_S = 0.6
out = asyncio.run(hostwriteback.run_host(SID, "host_module_create", CK, TK, "모듈 만들기", {"name": "x"}, timeout=5))
check("cancelled with the reason", out["status"] == "rejected" and "시작하지 않아" in out["result"], str(out))
try:
    actions.decide(out["id"], True)
    check("the panel's late approval is refused with the state", False, "no error")
except actions.ActionError as e:
    check("the panel's late approval is refused with the state", "거절됨" in str(e), str(e))

print("== create_module through the panel ==")
hostwriteback.START_S = 10
MOD_ID = "abcdef01-2345-4678-9abc-def012345678"


def fake_panel() -> None:
    """What the plugin does on 'host-run': approve, create + open the module, report."""
    for _ in range(100):
        rows = [x for x in actions.pending(TK) if x["kind"] == "host_module_create"]
        if rows:
            act = rows[0]
            d = actions.decide(act["id"], True)
            assert d["host"]["args"]["name"] == "메로 에셋" and d["host"]["args"]["link"] is True
            modmod.sync({"id": MOD_ID, "name": "메로 에셋", "lorebook": [], "regex": [], "trigger": [], "assets": []})
            actions.complete(act["id"], True, f"RisuAI에 새 모듈 '메로 에셋' 을(를) 만들고 패널에 열었습니다 (id={MOD_ID}, key=x)")
            return
        time.sleep(0.05)


def call_tool(name: str, args: dict, deps) -> str:
    from pydantic_ai import RunContext
    from pydantic_ai.models.test import TestModel
    from pydantic_ai.usage import RunUsage
    ag = agent.build(model=TestModel())
    rctx = RunContext(deps=deps, model=ag.model, usage=RunUsage())
    ts = ag._function_toolset

    async def go():
        tools = await ts.get_tools(rctx)
        tool = tools[name]
        return await ts.call_tool(name, tool.args_validator.validate_python(args), rctx, tool)
    return str(asyncio.run(go()))


deps = agent.Deps(chat_key=TK, char_key=CK, session_id=SID, workspace_dir=DATA, mode="bot", bot_key=CK)
t = threading.Thread(target=fake_panel)
t.start()
txt = call_tool("create_module", {"name": "메로 에셋", "reason": "감정셋 26장을 모듈로"}, deps)
t.join()
key = modmod.key_of(MOD_ID)
check("create_module waits for the panel and points at focus_target", "focus_target" in txt and key in deps.modules, txt)
txt = call_tool("focus_target", {"target": "메로 에셋"}, deps)
check("the new module is a focus target in the same turn", deps.char_key == key, txt)
deps.char_key = CK
txt = call_tool("create_module", {"name": "메로 에셋", "reason": "again"}, deps)
check("an existing module of that name is not made twice", "이미 있습니다" in txt, txt)
check("the instructions say to create modules, not to ask for one", "create_module" in agent.INSTRUCTIONS)

print("== handover and moving a conversation ==")
session._save_message(SID, "user", "에셋 모듈로 만들어서 추가해줘")
session._save_message(SID, "assistant", "만들었습니다")
parts = continuity.build(SID, CK, [])
snap = json.loads(parts[-1].split("\n", 2)[-1]) if parts else {}
outcomes = snap.get("proposalOutcomes") or []
check("the handover lists recorded proposal outcomes", any(o["kind"] == "host_card_writeback" and o["status"] == "완료" for o in outcomes), str(outcomes)[:300])
check("the handover counts what is not yet in RisuAI", snap.get("unshippedToRisu", {}).get("card") == 0, str(snap.get("unshippedToRisu")))
moved = session.move(SID, TK2)
check("session.move re-points the session", moved["moved"] and db.one("SELECT chat_key FROM sessions WHERE id=?", (SID,))["chat_key"] == TK2, str(moved))
check("it names from where", moved["from"]["bot"] == "복구봇" and moved["to"]["chat"] == "둘째 챗", str(moved))
got = main.h_session_get({"chatKey": TK2, "sessionId": SID})
check("the conversation now opens from the new chat", got["session"]["sessionId"] == SID and len(got["messages"]) == 2, str(got["session"]))
check("and is latest there", session.latest(TK2)["id"] == SID)
parts = continuity.build(SID, CK2, [])
snap = json.loads(parts[-1].split("\n", 2)[-1])
check("the next handover says it was carried", snap.get("sessionMoves") and snap["sessionMoves"][-1]["from"]["chatKey"] == TK, str(snap.get("sessionMoves")))
check("shown messages exclude the move record", all(m["role"] in ("user", "assistant") for m in session.messages(SID)))
try:
    main.h_session_move({"chatKey": TK2, "sessionId": "nope"})
    check("unknown session refused", False)
except main.ApiError as e:
    check("unknown session refused", e.status == 404)
ev = asyncio.Event()
session._ACTIVE[SID] = ev
try:
    session.move(SID, TK)
    check("a running turn is not moved", False)
except ValueError:
    check("a running turn is not moved", True)
ev.set()

print("== MCP: files changed ==")
mcpbridge.set_enabled(True, {"chatKey": TK, "charKey": CK})
mcpbridge._jobs.clear()
mcpbridge.files_changed(["studio/a.png"])
mcpbridge.files_changed(["studio/b.png", "studio/a.png"])
mcpbridge.files_changed()
jobs = [j for j in mcpbridge._jobs if j.get("type") == "files"]
check("one coalesced files job with every path", len(jobs) == 1 and jobs[0]["paths"] == ["studio/a.png", "studio/b.png"], str(jobs))
msid = session.create(TK)["sessionId"]
db.execute("UPDATE sessions SET title=? WHERE id=?", (mcpbridge.MCP_SESSION_TITLE, msid))
session.push_stream_event(msid, {"type": "images", "paths": ["studio/c.png"]})
check("a batch's images over MCP join the files job", "studio/c.png" in jobs[0]["paths"], str(mcpbridge._jobs))
session.push_stream_event(msid, {"type": "host-run", "id": "x", "kind": "host_module_create", "charKey": CK, "chatKey": TK})
check("a host-run over MCP is a panel job", any(j.get("type") == "host-run" for j in mcpbridge._jobs))
mcpbridge._jobs.clear()
mcpbridge.set_enabled(False)
mcpbridge.files_changed(["x"])
check("nothing queued while MCP is off", not mcpbridge._jobs)

print("== settings and agent-panel reads stay small ==")
space = workspace.ensure_space()
for rel in ("projects/봇A/out/report.md", "projects/봇A/out/img/a.png", "projects/봇A/notes.md", "studio/images/x.png"):
    (space / rel).parent.mkdir(parents=True, exist_ok=True)
    (space / rel).write_text("x", encoding="utf-8")
outs = main.h_files_outputs({})
paths = [f["path"] for a in outs["areas"] for f in a["files"]]
check("/files/outputs lists only out/ folders", sorted(paths) == ["projects/봇A/out/img/a.png", "projects/봇A/out/report.md"], str(paths))
light = main.h_diag({"space": "0"})
check("/diag?space=0 skips the space walk", light["space"]["areas"] == {} and light["space"]["path"], str(light["space"]))
full = main.h_diag({})
check("the full /diag still sizes the areas", full["space"]["areas"].get("studio", {}).get("count", 0) >= 1, str(full["space"]))

if FAILURES:
    print(f"\nFAIL - {len(FAILURES)}: {', '.join(FAILURES)}")
    sys.exit(1)
print("\nPASS - lost answers, user-requested host actions, MCP file refresh, carried conversations")
