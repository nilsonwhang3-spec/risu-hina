"""RisuAI personas as a working copy: sync, edits, snapshots, 반영, AI proposals.

A persona lives in RisuAI and only the plugin can read or write it; the
backend keeps a working copy with a baseline (personas.py), the same loop a
bot has. These tests drive the module and the route handlers directly.

    python tests/test_personas.py
"""
from __future__ import annotations

import base64
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-personas-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import actions, config, db, personas, store, workspace  # noqa: E402
from app import agent, main, session  # noqa: E402

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

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 16
b64 = lambda b: base64.b64encode(b).decode()  # noqa: E731


def sync(*items) -> dict:
    out = main.h_persona_sync({"personas": list(items)})["personas"]
    return {p["key"]: p for p in out}


print("test_sync")
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "검사.\n둘째 줄", "icon": "assets/a.png", "selected": True},
         {"id": "p2", "index": 1, "name": "카이", "prompt": "학생", "icon": "", "selected": False})
a = r["p1"]
check("new persona: work = base, image ''", a["work"] == {"name": "아키라", "prompt": "검사.\n둘째 줄", "image": ""}
      and a["base"] == {"name": "아키라", "prompt": "검사.\n둘째 줄"} and not a["dirty"] and a["total"] == 0, str(a))
check("folder under projects/페르소나", a["folder"] == f"projects/{workspace.PERSONA_TOP}/아키라", a["folder"])
check("selected flag", a["selected"] and not r["p2"]["selected"])
check("needIcon when a picture is set and not cached", a["needIcon"] and not r["p2"]["needIcon"])

print("\ntest_icon")
ic = main.h_persona_icon({"key": "p1", "iconKey": "assets/a.png", "base64": b64(PNG)})
check("icon cached as RisuAI 프로필.png", ic["iconPath"] == f"{a['folder']}/RisuAI 프로필.png"
      and (space / ic["iconPath"]).read_bytes() == PNG, str(ic))
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "검사.\n둘째 줄", "icon": "assets/a.png", "selected": True},
         {"id": "p2", "index": 1, "name": "카이", "prompt": "학생", "icon": "", "selected": False})
check("no needIcon once cached under the same key", not r["p1"]["needIcon"])
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "검사.\n둘째 줄", "icon": "assets/b.png", "selected": True},
         {"id": "p2", "index": 1, "name": "카이", "prompt": "학생", "icon": "", "selected": False})
check("needIcon when RisuAI's icon key changed", r["p1"]["needIcon"])
ic = main.h_persona_icon({"key": "p1", "iconKey": "assets/b.png", "base64": "data:image/webp;base64," + b64(WEBP)})
check("webp sniffed, old png cache removed", ic["iconPath"].endswith("RisuAI 프로필.webp")
      and not (space / a["folder"] / "RisuAI 프로필.png").exists(), str(ic))
check("icon of an unknown persona -> 404", status_of(main.h_persona_icon, {"key": "nope", "base64": b64(PNG)}) == 404)

print("\ntest_edit")
img = space / "studio" / "output" / "persona-new.png"
img.parent.mkdir(parents=True, exist_ok=True)
img.write_bytes(PNG)
(space / "projects" / "note.txt").write_text("x", encoding="utf-8")
e = main.h_persona_edit({"key": "p2", "prompt": "대학생"})
check("only the given field changes", e["work"] == {"name": "카이", "prompt": "대학생", "image": ""}
      and e["dirty"] and e["total"] == 1, str(e))
e = main.h_persona_edit({"key": "p2", "image": "studio/output/persona-new.png"})
check("an existing space image is accepted (copied into the persona folder)",
      e["work"]["image"] == f"{e['folder']}/프로필 1.png" and e["total"] == 2, str(e["work"]))
check("a text file is refused", status_of(main.h_persona_edit, {"key": "p2", "image": "projects/note.txt"}) == 400)
check("a missing file is refused", status_of(main.h_persona_edit, {"key": "p2", "image": "studio/none.png"}) == 400)
check("a path outside the space is refused", status_of(main.h_persona_edit, {"key": "p2", "image": "../../x.png"}) == 400)
check("an empty name is refused", status_of(main.h_persona_edit, {"key": "p2", "name": "  "}) == 400)
e = main.h_persona_edit({"key": "p2", "image": ""})
check("image '' clears the pending picture", e["work"]["image"] == "" and e["total"] == 1)

print("\ntest_sync_follow_and_keep")
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "RisuAI 에서 고침", "icon": "assets/b.png", "selected": True},
         {"id": "p2", "index": 1, "name": "카이", "prompt": "RisuAI 쪽 변경", "icon": "", "selected": False})
check("clean working copy follows RisuAI's change", r["p1"]["work"]["prompt"] == "RisuAI 에서 고침" and not r["p1"]["dirty"])
check("dirty working copy is kept", r["p2"]["work"]["prompt"] == "대학생"
      and r["p2"]["base"]["prompt"] == "RisuAI 쪽 변경" and r["p2"]["dirty"], str(r["p2"]))
check("both sides changed -> risuChanged, the clean one is not", r["p2"]["risuChanged"] and not r["p1"]["risuChanged"], str(r["p2"]))
cps = main.h_persona_checkpoints({"key": "p2"})["checkpoints"]
check("RisuAI's version is kept as an auto snapshot", any(c["kind"] == "auto" and "RisuAI 쪽 변경" in c["label"] for c in cps), str(cps))
check("read_persona warns about it", "덮어씁니다" in personas.describe_full(main.h_persona_get({"key": "p2"}), 0))
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "RisuAI 에서 고침", "icon": "assets/b.png", "selected": True},
         {"id": "p2", "index": 1, "name": "카이", "prompt": "RisuAI 쪽 변경", "icon": "", "selected": False})
check("the flag survives an unchanged re-read", r["p2"]["risuChanged"])
r = sync({"id": "p1", "index": 0, "name": "아키라", "prompt": "RisuAI 에서 고침", "icon": "", "selected": False},
         {"id": "p3", "index": 1, "name": "세라", "prompt": "의사", "icon": "", "selected": True})
check("unlisted persona -> gone, kept", main.h_persona_get({"key": "p2"})["gone"]
      and main.h_persona_get({"key": "p2"})["work"]["prompt"] == "대학생")
check("icon '' clears the cache pointer", r["p1"]["iconPath"] == "" and r["p1"]["iconKey"] == ""
      and (space / a["folder"] / "RisuAI 프로필.webp").exists())
check("gone personas leave the dirty list", all(d["key"] != "p2" for d in main.h_persona_dirty({})["personas"]))

print("\ntest_checkpoints")
main.h_persona_edit({"key": "p3", "prompt": "외과 의사"})
cid = main.h_persona_checkpoint_create({"key": "p3", "label": "첫 버전"})["id"]
main.h_persona_edit({"key": "p3", "prompt": "내과 의사", "name": "세라2"})
rows = main.h_persona_checkpoints({"key": "p3"})["checkpoints"]
check("manual checkpoint listed", rows and rows[0]["id"] == cid and rows[0]["kind"] == "manual"
      and rows[0]["label"] == "첫 버전", str(rows))
back = main.h_persona_checkpoint_restore({"key": "p3", "id": cid})
rows = main.h_persona_checkpoints({"key": "p3"})["checkpoints"]
check("restore puts the stored work back", back["work"] == {"name": "세라", "prompt": "외과 의사", "image": ""}, str(back))
check("restore keeps the current work as auto '복원 직전'", rows[0]["label"] == "복원 직전" and rows[0]["kind"] == "auto",
      str(rows))
check("GET /persona counts snapshots", main.h_persona_get({"key": "p3"})["checkpoints"] == 2)
main.h_persona_checkpoint_rename({"key": "p3", "id": cid, "label": "의사 버전"})
check("rename", any(x["label"] == "의사 버전" for x in main.h_persona_checkpoints({"key": "p3"})["checkpoints"]))
check("rename to '' -> 400", status_of(main.h_persona_checkpoint_rename, {"key": "p3", "id": cid, "label": ""}) == 400)
main.h_persona_checkpoint_delete({"key": "p3", "id": cid})
check("delete", all(x["id"] != cid for x in main.h_persona_checkpoints({"key": "p3"})["checkpoints"]))
check("restore unknown -> 404", status_of(main.h_persona_checkpoint_restore, {"key": "p3", "id": "x"}) == 404)
for i in range(personas.AUTO_KEEP + 5):
    personas.checkpoint_create("p3", f"auto {i}", kind="auto")
n_auto = sum(1 for x in main.h_persona_checkpoints({"key": "p3"})["checkpoints"] if x["kind"] == "auto")
check("auto checkpoints pruned", n_auto == personas.AUTO_KEEP, str(n_auto))

print("\ntest_reset")
rs = main.h_persona_reset({"key": "p3"})
check("reset: work = base, discarded = total", rs["work"] == {"name": "세라", "prompt": "의사", "image": ""}
      and rs["discarded"] == 1 and not rs["dirty"], str(rs))
check("reset kept '버리기 직전'", main.h_persona_checkpoints({"key": "p3"})["checkpoints"][0]["label"] == "버리기 직전")
rs = main.h_persona_reset({"key": "p3"})
check("reset of a clean copy takes no snapshot", rs["discarded"] == 0
      and main.h_persona_checkpoints({"key": "p3"})["checkpoints"][0]["label"] == "버리기 직전")

print("\ntest_commit")
main.h_persona_edit({"key": "p1", "name": "아키라 改", "prompt": "새 설명", "image": "studio/output/persona-new.png"})
check("dirty list names it", [d for d in main.h_persona_dirty({})["personas"] if d["key"] == "p1"]
      == [{"key": "p1", "name": "아키라 改", "total": 3}], str(main.h_persona_dirty({})))
c = main.h_persona_commit({"key": "p1", "name": "아키라 改", "prompt": "새 설명", "iconKey": "assets/c.png"})
check("baseline moved, work clean", c["base"] == {"name": "아키라 改", "prompt": "새 설명"} and not c["dirty"]
      and c["work"]["image"] == "" and c["iconKey"] == "assets/c.png", str(c))
check("folder renamed with the name", c["folder"] == f"projects/{workspace.PERSONA_TOP}/아키라 改"
      and (space / c["folder"]).is_dir() and not (space / a["folder"]).exists(), c["folder"])
cps = main.h_persona_checkpoints({"key": "p1"})["checkpoints"]
check("auto '반영 직전' of the old base", cps[0]["label"] == "반영 직전" and cps[0]["kind"] == "auto")
old = db.unjs(db.one("SELECT data_json FROM persona_checkpoints WHERE id = ?", (cps[0]["id"],))["data_json"])
check("... holding the old base", old == {"name": "아키라", "prompt": "RisuAI 에서 고침", "image": ""}, str(old))
r = sync({"id": "p1", "index": 0, "name": "아키라 改", "prompt": "새 설명", "icon": "assets/c.png", "selected": False})
check("icon cache stale after commit -> needIcon", r["p1"]["needIcon"])
check("commit unknown -> 404", status_of(main.h_persona_commit, {"key": "zz", "name": "a"}) == 404)

print("\ntest_list_search_read")
sync({"id": "p1", "index": 0, "name": "아키라 改", "prompt": "새 설명", "icon": "", "selected": False},
     {"id": "p4", "index": 1, "name": "미나", "prompt": "Pianist 피아니스트", "icon": "", "selected": True},
     {"id": "p5", "index": 2, "name": "미나토", "prompt": "어부", "icon": "", "selected": False})
names = [p["name"] for p in main.h_personas({})["personas"]]
check("list = non-gone personas in RisuAI order", names == ["아키라 改", "미나", "미나토"], str(names))
check("search is case-insensitive over the description",
      [p["key"] for p in main.h_personas({"query": "pianist"})["personas"]] == ["p4"])
check("read by exact name beats a partial match", personas.resolve("미나")["key"] == "p4")
check("read by unique partial name", personas.resolve("나토")["key"] == "p5")
try:
    personas.resolve("미")
    check("ambiguous partial is refused", False)
except personas.PersonaError as e:
    check("ambiguous partial is refused with candidates", "p4" in str(e) and "p5" in str(e), str(e))
txt = agent.persona_list_text("")
check("list_personas text: key, selected flag, first line", "key=p4" in txt and "[RisuAI 선택 중]" in txt
      and "Pianist" in txt and "마지막으로" in txt, txt)
txt = agent.persona_read_text("미나토")
check("read_persona text: full description and snapshot count", "어부" in txt and "스냅샷: 0개" in txt, txt)

print("\ntest_proposals")
CK = store.upsert_character("cha-persona", "", {"name": "봇"}, 0)
TK = "chat-persona"  # pending_actions only records the key
pr = actions.propose("persona_edit", chat_key=TK, char_key=CK, summary="설명 고치기",
                     args={"key": "p5", "prompt": "늙은 어부"})
check("persona_edit scope is ''", actions.scope_of({"kind": "persona_edit", "args": {}}) == "")
out = actions.decide(pr["id"], True, mode="chat")
check("persona_edit applies from the chat screen", main.h_persona_get({"key": "p5"})["work"]["prompt"] == "늙은 어부"
      and "고쳤습니다" in str(out.get("result")), str(out))
pr = actions.propose("persona_checkpoint_create", chat_key=TK, char_key=CK, summary="s", args={"key": "p5", "label": "AI 저장"})
actions.decide(pr["id"], True, mode="bot")
cps = main.h_persona_checkpoints({"key": "p5"})["checkpoints"]
check("persona_checkpoint_create from the bot screen", cps and cps[0]["label"] == "AI 저장")
main.h_persona_edit({"key": "p5", "prompt": "젊은 어부"})
pr = actions.propose("persona_checkpoint_restore", chat_key=TK, char_key=CK, summary="r",
                     args={"key": "p5", "id": cps[0]["id"]})
actions.decide(pr["id"], True, mode="persona")
check("persona_checkpoint_restore", main.h_persona_get({"key": "p5"})["work"]["prompt"] == "늙은 어부")
pr = actions.propose("host_persona_writeback", chat_key=TK, char_key=CK, summary="w", args={"key": "p5"})
out = actions.decide(pr["id"], True, mode="studio")
check("host_persona_writeback is handed to the plugin", out.get("host") == {"kind": "host_persona_writeback",
                                                                           "args": {"key": "p5"}, "charKey": CK}, str(out))
for mode in ("bot", "chat", "persona", "studio", ""):
    check(f"screen gate passes persona kinds on '{mode or '-'}'",
          all(agent.screen_gate(mode, k) is None for k in agent.PERSONA_KINDS))
check("the session accepts the persona screen", "persona" in session.SCREEN_MODES)
check("Deps carries the open persona", agent.Deps(chat_key="", char_key="", session_id=None,
                                                  workspace_dir=DATA, mode="persona", persona="p4").persona == "p4")
scr = agent._persona_screen("p4")
check("persona screen names the open persona and the tools", "미나" in scr and "key=p4" in scr
      and "propose_persona_edit" in scr and "사본" in scr, scr)

print("\ntest_new_persona")
check("create with an empty name -> 400", status_of(main.h_persona_create, {"name": " "}) == 400)
n = main.h_persona_create({"name": "레아", "prompt": "모험가"})
check("new persona: isNew, dirty, key new:, idx -1", n["isNew"] and n["dirty"] and n["key"].startswith("new:")
      and n["index"] == -1 and n["base"] == {"name": "", "prompt": ""} and n["total"] == 2, str(n))
check("its folder is pinned under the new key",
      n["folder"] == f"projects/{workspace.PERSONA_TOP}/레아" and workspace._personas().get(n["key"], {}).get("folder") == "레아")
keys = [p["key"] for p in main.h_personas({})["personas"]]
check("listed after RisuAI's personas", keys[-1] == n["key"] and keys[:3] == ["p1", "p4", "p5"], str(keys))
check("in the dirty list", any(d["key"] == n["key"] and d["name"] == "레아" for d in main.h_persona_dirty({})["personas"]))
sync({"id": "p1", "index": 0, "name": "아키라 改", "prompt": "새 설명", "icon": "", "selected": False},
     {"id": "p4", "index": 1, "name": "미나", "prompt": "Pianist 피아니스트", "icon": "", "selected": True},
     {"id": "p5", "index": 2, "name": "미나토", "prompt": "늙은 어부", "icon": "", "selected": False})
check("sync does not mark a new persona gone", not main.h_persona_get({"key": n["key"]})["gone"])
e = main.h_persona_edit({"key": n["key"], "image": "studio/output/persona-new.png"})
check("an image outside the folder is copied in as 프로필 1", e["work"]["image"] == f"{n['folder']}/프로필 1.png"
      and (space / e["work"]["image"]).read_bytes() == PNG and img.exists(), str(e["work"]))
e = main.h_persona_edit({"key": n["key"], "image": "studio/output/persona-new.png"})
check("... and the next one as 프로필 2", e["work"]["image"].endswith("/프로필 2.png"), e["work"]["image"])
e = main.h_persona_edit({"key": n["key"], "image": f"{n['folder']}/프로필 1.png"})
check("an image inside the folder is stored as is", e["work"]["image"] == f"{n['folder']}/프로필 1.png")
check("total counts the non-empty fields", e["total"] == 3)
cp = main.h_persona_checkpoint_create({"key": n["key"], "label": "초안"})["id"]
c = main.h_persona_commit({"key": n["key"], "name": "레아", "prompt": "모험가", "iconKey": "assets/r.png",
                           "id": "risu-id-9", "index": 3})
check("commit with id re-keys the row", c["key"] == "risu-id-9" and c["id"] == "risu-id-9" and c["index"] == 3
      and not c["isNew"] and not c["dirty"] and c["base"] == {"name": "레아", "prompt": "모험가"}, str(c))
check("the old key is gone", status_of(main.h_persona_get, {"key": n["key"]}) == 404)
check("checkpoints follow the new key", [x["id"] for x in main.h_persona_checkpoints({"key": "risu-id-9"})["checkpoints"]] == [cp])
pins = workspace._personas()
check("folder pin re-keyed, folder not moved", n["key"] not in pins and pins.get("risu-id-9", {}).get("folder") == "레아"
      and c["folder"] == n["folder"] and (space / n["folder"]).is_dir(), str(pins.get("risu-id-9")))
check("commit of a new persona without id -> 400",
      status_of(main.h_persona_commit, {"key": main.h_persona_create({"name": "임시"})["key"], "name": "임시"}) == 400)
n2 = main.h_persona_create({"name": "버릴 것"})
rs = main.h_persona_reset({"key": n2["key"]})
check("reset deletes a new persona", rs == {"deleted": True, "key": n2["key"]}
      and status_of(main.h_persona_get, {"key": n2["key"]}) == 404 and (space / n2["folder"]).is_dir(), str(rs))
pr = actions.propose("persona_create", chat_key=TK, char_key=CK, summary="새 페르소나",
                     args={"name": "유나", "prompt": "기사", "image": "studio/output/persona-new.png"})
out = actions.decide(pr["id"], True, mode="bot")
made = personas.resolve("유나")
check("persona_create proposal makes a new persona", made["isNew"] and made["work"]["prompt"] == "기사"
      and made["work"]["image"].startswith(made["folder"] + "/") and "만들었습니다" in str(out.get("result")), str(made))


def call_tool(name: str, args: dict) -> str:
    """Run one agent tool the way mcpserver does (stand-in model, real Deps)."""
    import asyncio
    from pydantic_ai import RunContext
    from pydantic_ai.models.test import TestModel
    from pydantic_ai.usage import RunUsage
    ag = agent.build(model=TestModel())
    deps = agent.Deps(chat_key=TK, char_key=CK, session_id=None, workspace_dir=DATA, mode="chat")
    rctx = RunContext(deps=deps, model=ag.model, usage=RunUsage())
    ts = ag._function_toolset

    async def go():
        tools = await ts.get_tools(rctx)
        tool = tools[name]
        return await ts.call_tool(name, tool.args_validator.validate_python(args), rctx, tool)
    return str(asyncio.run(go()))


txt = call_tool("propose_persona_writeback", {"persona": made["key"], "reason": "추가"})
check("writeback tool accepts a new persona", "제안했습니다" in txt and "RisuAI 페르소나 목록에 추가" in txt, txt)
main.h_persona_edit({"key": "p4", "prompt": "재즈 피아니스트"})
txt = call_tool("propose_persona_writeback", {"persona": "미나", "reason": "x"})
check("writeback tool proposes the selected persona as a copy", "제안했습니다" in txt and "사본" in txt, txt)
txt = call_tool("propose_persona_create", {"name": "하루", "reason": "후보 1"})
check("propose_persona_create tool queues a persona_create", "제안했습니다" in txt
      and any(a["kind"] == "persona_create" for a in actions.pending(TK)), txt)

print("\ntest_odd_ids")
# A fork (field report: PocketRisu 1.13) handed over ids the key check refused,
# and one such persona failed the whole list with "페르소나 id 가 올바르지 않습니다".
long_id, ctrl_id = "x" * 500, "abc\ndef"
r = sync({"id": long_id, "index": 0, "name": "긴아이디", "prompt": "a", "icon": "", "selected": False},
         {"id": ctrl_id, "index": 1, "name": "줄바꿈", "prompt": "b", "icon": "", "selected": False},
         {"id": "ok1", "index": 2, "name": "정상", "prompt": "c", "icon": "", "selected": False})
odd = [p for p in r.values() if p["key"].startswith("idh:")]
check("odd ids do not fail the list", len(r) == 3 and len(odd) == 2 and "ok1" in r, str(list(r)))
check("the row keeps the id as RisuAI has it", {p["id"] for p in odd} == {long_id, ctrl_id})
k_long = next(p["key"] for p in odd if p["id"] == long_id)
r2 = sync({"id": long_id, "index": 0, "name": "긴아이디", "prompt": "a", "icon": "", "selected": False})
check("an odd id keys the same persona on the next sync", k_long in r2 and len(k_long) < 64, str(list(r2)))
main.h_persona_edit({"key": k_long, "prompt": "수정"})
check("an odd-id persona is editable", main.h_persona_get({"key": k_long})["work"]["prompt"] == "수정")

if FAILURES:
    print(f"\nFAIL - {len(FAILURES)}: {', '.join(FAILURES)}")
    sys.exit(1)
print("\nPASS - persona working copies: sync, snapshots, 반영, AI proposals")
