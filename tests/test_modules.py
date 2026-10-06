"""RisuAI modules as working copies (app/modules.py).

A module is edited as a card under a key of its own: sync and merge, the
module-only scalars, the patch the plugin writes into db.modules, the
remembered combinations, .risum / .charx files both ways, and the agent's
target (the card tools follow the module the panel shows; focus_target moves).

    python tests/test_modules.py
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-modules-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import actions, assets, config, db, store, workspace  # noqa: E402
from app import agent, main  # noqa: E402
from app import card as cardmod  # noqa: E402
from app import modules  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def status_of(fn, arg: dict) -> int:
    try:
        fn(arg)
    except main.ApiError as e:
        return e.status
    return 200


config.load()
db.connect()
space = workspace.ensure_space()

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 40
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 24


def lore(comment: str, content: str) -> dict:
    return {"key": comment, "secondkey": "", "insertorder": 100, "comment": comment, "content": content,
            "mode": "normal", "alwaysActive": False, "selective": False}


def regex(name: str, find: str) -> dict:
    return {"comment": name, "in": find, "out": "X", "type": "editdisplay", "ableFlag": False}


MOD = {
    "id": "11111111-2222-4333-8444-555555555555", "name": "인벤토리", "description": "범용 인벤토리 모듈",
    "lorebook": [lore("가방", "가방 설명"), lore("금화", "금화 설명")],
    "regex": [regex("상태창", "\\[STATUS\\]")],
    "trigger": [{"comment": "t", "type": "start", "conditions": [], "effect": [], "lowLevelAccess": False}],
    "assets": [["coin", "assets/coin.png", "png"]],
    "customModuleToggle": "inv_on=인벤토리 표시",
    "namespace": "inv", "lowLevelAccess": False, "hideIcon": False,
    "backgroundEmbedding": "<style>.inv{}</style>",
    "folderId": "keep-me",
}

print("== sync ==")
r = main.h_module_sync({"module": MOD})
MK = r["key"]
check("module key is its own kind", MK.startswith("m") and modules.is_module_key(MK) and MK == modules.key_of(MOD["id"]), MK)
check("row counts", (r["lore"], r["regex"], r["trigger"], r["assets"]) == (2, 1, 1, 1) and r["toggles"], str(r))
fields = {f["field"]: f for f in main.h_card({"charKey": MK})["fields"]}
check("module scalars, no greetings/desc", set(fields) == set(cardmod.MODULE_SCALARS)
      and fields["creatorNotes"]["body"] == "범용 인벤토리 모듈"
      and fields["customModuleToggle"]["body"] == "inv_on=인벤토리 표시"
      and fields["moduleNamespace"]["body"] == "inv" and fields["hideChatIcon"]["body"] == "0", str(sorted(fields)))
check("bot keys are not modules", not modules.is_module_key(store.char_key("x")) and not modules.is_module_key("mfake"))
lo = main.h_lore_list({"charKey": MK, "scope": "global"})["lore"]
check("lorebook loaded as global lore", len(lo) == 2, str(len(lo)))

print("== edit, changes, patch ==")
cardmod.update_field(fields["customModuleToggle"]["id"], "inv_on=인벤토리 표시\ninv_gold=금화 표시")
cardmod.update_field(fields["hideChatIcon"]["id"], "1")
rx = cardmod.scripts(MK, "customscript")[0]
cardmod.update_script(rx["id"], {**rx["entry"], "out": "Y"})
ch = main.h_card_changes({"charKey": MK})
check("changes count module edits", ch["fields"] == 2 and ch["customscript"]["edited"] == 1 and ch["total"] == 3, str(ch))
patch = main.h_card_patch({"charKey": MK})
fset = {f["field"]: f for f in patch["fields"]}
check("patch carries before/after per field", fset["hideChatIcon"]["before"] == "0" and fset["hideChatIcon"]["after"] == "1"
      and "inv_gold" in fset["customModuleToggle"]["after"], str(patch["fields"]))
check("patch lists use card names", patch["customscript"]["changed"] == 1 and patch["customscript"]["list"][0]["out"] == "Y"
      and patch["assets"]["additionalAssets"] == [["coin", "assets/coin.png", "png"]], str(patch["assets"]))
wm = modules.working_module(MK)
check("working module maps back", wm["customModuleToggle"].endswith("금화 표시") and wm["hideIcon"] is True
      and wm["regex"][0]["out"] == "Y" and wm["namespace"] == "inv" and wm["id"] == MOD["id"]
      and len(wm["lorebook"]) == 2 and wm["assets"][0][0] == "coin", str({k: wm[k] for k in ("hideIcon", "namespace")}))

print("== re-sync merges ==")
moved = {**MOD, "lorebook": MOD["lorebook"] + [lore("열쇠", "열쇠 설명")], "description": "RisuAI 에서 고침"}
r2 = main.h_module_sync({"module": moved})
fields = {f["field"]: f for f in main.h_card({"charKey": MK})["fields"]}
check("RisuAI-side change follows, local edit kept", fields["creatorNotes"]["body"] == "RisuAI 에서 고침"
      and "inv_gold" in fields["customModuleToggle"]["body"] and len(store.lore(MK, "global")) == 3, str(r2.get("merge")))
check("listing + dirty", any(m["key"] == MK and m["dirty"] for m in main.h_modules({})["modules"])
      and main.h_module_dirty({})["modules"][0]["key"] == MK)
main.h_card_reset({"charKey": MK})
check("reset returns to RisuAI's", main.h_card_changes({"charKey": MK})["total"] == 0)
r3 = main.h_module_sync({"module": moved, "reset": True})
check("reset sync", r3["reset"] is True and r3["total"] == 0, str(r3))
check("mcp module refused", status_of(main.h_module_sync, {"module": {"id": "m2", "name": "mcp", "mcp": {"url": "x"}}}) == 400)

print("== combinations ==")
check("empty combo", main.h_module_combo({"owner": "bot:c1"})["ids"] == [])
main.h_module_combo({"owner": "bot:c1", "ids": ["a", "b", "a", ""]})
check("combo remembered, deduplicated, ordered", main.h_module_combo({"owner": "bot:c1"})["ids"] == ["a", "b"])
check("owners are separate", main.h_module_combo({"owner": "persona:p1"})["ids"] == [])

print("== risum ==")
raw = modules.write_risum({"name": "r", "description": "", "id": "x", "regex": [regex("a", "b")],
                           "assets": [["one", "assets/k1.png", "png"], ["two", "assets/k2.webp", "webp"]]}, [PNG, WEBP])
m, blobs = modules.read_risum(raw)
check("risum round trip", m["name"] == "r" and m["assets"][0] == ["one", "", "png"] and blobs == [PNG, WEBP], str(m["assets"]))
(space / "projects").mkdir(parents=True, exist_ok=True)
(space / "projects" / "in.risum").write_bytes(raw)
got = main.h_module_parse({"path": "projects/in.risum"})
keys = [a[1] for a in got["module"]["assets"]]
check("parse stages asset bytes under pending keys", all(k.startswith(assets.PENDING_PREFIX) for k in keys)
      and assets.read_bytes(keys[0])[0] == PNG and "id" not in got["module"], str(keys))
sample = ROOT.parent / "vepo-bot" / "RisuAI" / "v194" / "module.risum"
if sample.is_file():
    real, _ = modules.read_risum(sample.read_bytes())
    check("a real RisuAI .risum reads", real.get("name") and len(real.get("lorebook") or []) > 0, str(real.get("name")))

print("== export ==")
assets.store_bytes("assets/coin.png", PNG)
ex = main.h_module_export({"charKey": MK, "format": "risum"})
check("risum export", ex["ok"] and ex["path"].endswith(".risum") and ex["assets"] == 1, str(ex))
back, blobs = modules.read_risum((space / ex["path"]).read_bytes())
check("exported risum reads back", back["name"] == "인벤토리" and len(back["lorebook"]) == 3 and blobs == [PNG]
      and back.get("folderId") is None, str(back.get("name")))
ex2 = main.h_module_export({"charKey": MK, "format": "charx"})
check("charx export", ex2["ok"] and ex2["path"].endswith(".module.charx"), str(ex2))
with zipfile.ZipFile(space / ex2["path"]) as z:
    import json
    card = json.loads(z.read("card.json"))
risu = card["data"]["extensions"]["risuai"]
check("charx carries module fields", risu["toggles"] == "inv_on=인벤토리 표시" and risu["moduleNamespace"] == "inv"
      and card["data"]["creator_notes"] == "RisuAI 에서 고침" and len(card["data"]["character_book"]["entries"]) == 3, str(risu.get("toggles")))
parsed = main.h_module_parse({"path": ex2["path"]})["module"]
check("charx parses back to a module", parsed["name"] == "인벤토리" and parsed["lowLevelAccess"] is False and risu["lowLevelAccess"] is False and parsed["customModuleToggle"] == "inv_on=인벤토리 표시"
      and len(parsed["lorebook"]) == 3 and parsed["regex"][0]["comment"] == "상태창"
      and parsed["assets"][0][0] == "coin" and parsed["assets"][0][1].startswith(assets.PENDING_PREFIX), str(parsed["assets"]))
check("bot key refused for module export", status_of(main.h_module_export, {"charKey": store.upsert_character("cha-b", "봇", {"name": "봇"}, 0), "format": "risum"}) == 400)

print("== bot toggles (a charx carries them too) ==")
from app import charx as charxmod  # noqa: E402
BK = store.upsert_character("cha-toggle-bot", "토글봇", {"name": "토글봇"}, 0)
cardmod.ingest(BK, {"name": "토글봇", "customModuleToggle": "mood=기분=select=좋음,나쁨", "hideChatIcon": True}, reset=True)
cardmod.set_full(BK, True)
bf = {f["field"]: f for f in cardmod.listing(BK)["fields"]}
check("a bot has toggle and icon rows", bf["customModuleToggle"]["body"].startswith("mood=") and bf["hideChatIcon"]["body"] == "1"
      and "desc" in bf, str(sorted(bf)))
cardmod.update_field(bf["customModuleToggle"]["id"], "mood=기분")
bp = cardmod.patch(BK)
check("the bot patch carries the toggle edit", any(f["field"] == "customModuleToggle" and f["after"] == "mood=기분" for f in bp["fields"]), str(bp["fields"]))
risu_b = charxmod.create_base_v3(charxmod.working_character(BK))["data"]["extensions"]["risuai"]
check("the bot charx exports toggles and the icon switch", risu_b["toggles"] == "mood=기분" and risu_b["hideChatIcon"] is True, str(risu_b.get("toggles")))
cardmod.ingest(BK, {"name": "토글봇"}, reset=False)
bf = {f["field"]: f for f in cardmod.listing(BK)["fields"]}
check("an older bot card gains the rows on re-read", "customModuleToggle" in bf and bf["hideChatIcon"]["body"] == "0", str(sorted(bf)))

print("== agent target ==")
CK = store.upsert_character("cha-mod-bot", "봇", {"name": "봇"}, 0)
TK = "chat-modules"


def call_tool(name: str, args: dict, deps=None) -> tuple[str, object]:
    import asyncio
    from pydantic_ai import RunContext
    from pydantic_ai.models.test import TestModel
    from pydantic_ai.usage import RunUsage
    ag = agent.build(model=TestModel())
    deps = deps or agent.Deps(chat_key=TK, char_key=CK, session_id=None, workspace_dir=DATA, mode="bot")
    rctx = RunContext(deps=deps, model=ag.model, usage=RunUsage())
    ts = ag._function_toolset

    async def go():
        tools = await ts.get_tools(rctx)
        tool = tools[name]
        return await ts.call_tool(name, tool.args_validator.validate_python(args), rctx, tool)
    return str(asyncio.run(go())), deps


deps = agent.Deps(chat_key=TK, char_key=CK, session_id=None, workspace_dir=DATA, mode="bot", bot_key=CK, modules=[MK])
txt, deps = call_tool("list_modules", {}, deps)
check("list_modules marks the opened module", "인벤토리" in txt and "[열림]" in txt, txt)
txt, deps = call_tool("focus_target", {"target": "인벤토리"}, deps)
check("focus_target moves the card tools to the module", deps.char_key == MK and "모듈 '인벤토리'" in txt, txt)
txt, deps = call_tool("propose_greeting_add", {"body": "hi", "reason": "x"}, deps)
check("greetings refused for a module", "인사말이 없고" in txt, txt)
txt, deps = call_tool("read_card", {}, deps)
check("read_card reads the module", "customModuleToggle" in txt and "desc" not in txt.split(), txt[:300])
screen = agent.module_screen(deps)
check("screen line names the module", "모듈 편집" in screen and "인벤토리" in screen and "focus_target" in screen, screen[:120])
txt, deps = call_tool("focus_target", {"target": "bot"}, deps)
check("focus_target back to the bot", deps.char_key == CK, txt)
other = modules.sync({"id": "99999999-0000-4000-8000-000000000000", "name": "닫힌 모듈"})["key"]
txt, deps = call_tool("focus_target", {"target": "닫힌 모듈"}, deps)
check("a module not opened is refused", deps.char_key == CK and "열려 있지 않습니다" in txt, txt)

print("== open a linked module (§1-97) ==")
deps = agent.Deps(chat_key=TK, char_key=CK, session_id=None, workspace_dir=DATA, mode="bot", bot_key=CK,
                  modules=[], linked=[{"id": "lnk-1", "name": "에셋봇 모듈"}])
check("the screen line names the linked module and the tool", "에셋봇 모듈" in agent.linked_line(deps)
      and "propose_open_module" in agent.linked_line(deps))
txt, deps = call_tool("propose_open_module", {"module": "에셋봇 모듈", "reason": "열어서 확인"}, deps)
check("propose_open_module queues host_open_module", "제안했습니다" in txt
      and any(a["kind"] == "host_open_module" and a["args"]["id"] == "lnk-1" for a in actions.pending(TK)), txt)
pend = [a for a in actions.pending(TK) if a["kind"] == "host_open_module"][0]
out = actions.decide(pend["id"], True, mode="persona")
check("it is handed to the plugin from any screen", out.get("host", {}).get("kind") == "host_open_module", str(out))
txt, deps = call_tool("focus_target", {"target": "닫힌 모듈"}, deps)
check("focus_target on an unopened module points at propose_open_module", "propose_open_module" in txt, txt)
txt, _ = call_tool("propose_open_module", {"module": "인벤토리", "reason": "x"},
                   agent.Deps(chat_key=TK, char_key=CK, session_id=None, workspace_dir=DATA, mode="bot", bot_key=CK, modules=[MK]))
check("an already open module says use focus_target", "이미 패널에 열려" in txt, txt)

print("== files from the agent (§1-97) ==")
d2 = agent.Deps(chat_key=TK, char_key=MK, session_id=None, workspace_dir=DATA, mode="bot", bot_key=BK, modules=[MK])
txt, d2 = call_tool("save_module_file", {"format": "risum"}, d2)
check("save_module_file writes the target module", "만들었습니다" in txt and ".risum" in txt, txt)
txt, d2 = call_tool("save_module_file", {"module": "인벤토리", "format": "charx"}, d2)
check("save_module_file by name as .module.charx", ".module.charx" in txt, txt)
txt, d2 = call_tool("save_bot_charx", {}, d2)
check("save_bot_charx builds the bot even while a module is the target", "만들었습니다" in txt and "토글봇" in txt, txt)

print("== approvals ==")
db.execute("INSERT INTO chats(chat_key, char_key, chat_id, chat_index, name, meta_json, orig_count, created_at, updated_at) "
           "VALUES(?,?,?,?,?,?,?,?,?)", (TK, CK, "chat-1", 0, "챗", "{}", 0, db.now(), db.now()))
f = {x["field"]: x for x in main.h_card({"charKey": MK})["fields"]}
pr = actions.propose("card_edit", chat_key=TK, char_key=MK, summary="모듈 설명", args={"id": f["creatorNotes"]["id"], "body": "AI 가 고침"})
listed = main.h_actions({"charKey": CK, "modules": MK})["actions"]
check("bot listing includes module proposals", any(a["id"] == pr["id"] and a.get("moduleName") == "인벤토리" for a in listed), str(listed))
check("without modules param they are not listed", not any(a["id"] == pr["id"] for a in main.h_actions({"charKey": CK})["actions"]))
out = main.h_action_decide({"chatKey": TK, "id": pr["id"], "approve": True, "mode": "bot"})
f = {x["field"]: x for x in main.h_card({"charKey": MK})["fields"]}
check("a module proposal is approved from the bot's chat", out.get("approved") and f["creatorNotes"]["body"] == "AI 가 고침", str(out))
pr2 = actions.propose("card_edit", chat_key=TK, char_key=store.upsert_character("cha-other", "남", {"name": "남"}, 0),
                      summary="x", args={"id": "nope", "body": "x"})
check("another bot's proposal still refused", status_of(main.h_action_decide, {"chatKey": TK, "id": pr2["id"], "approve": True}) == 400)

if FAILURES:
    print(f"\nFAIL - {len(FAILURES)}: {', '.join(FAILURES)}")
    sys.exit(1)
print("\nPASS - RisuAI modules: sync, merge, patch, combos, risum/charx, agent target")
