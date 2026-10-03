"""A bot's project folder: renaming it as a project, and persona folders.

The folder name is pinned in space/.hina/bots.json and several stores are
keyed by it (agent notes, asset rules, studio output + review sidecars,
skills' learned_project). A rename has to carry all of them; a plain folder
move of a pinned root used to orphan them and let out_dir() regrow an empty
folder under the old name.

    python tests/test_project_folder.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-projfolder-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import (agentnotes, assetrules, config, db, files, skills, store,  # noqa: E402
                 studio, workspace)
from app import main  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def raises(name: str, fn, *args, exc=(files.FileError, ValueError), **kw):
    try:
        fn(*args, **kw)
    except exc as e:
        print(f"  ok   {name}")
        return e
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL {name} - raised {type(e).__name__}: {e}")
        FAILURES.append(name)
        return None
    print(f"  FAIL {name} - no error")
    FAILURES.append(name)
    return None


def status_of(fn, arg: dict) -> int:
    try:
        fn(arg)
    except main.ApiError as e:
        return e.status
    return 200


config.load()
db.connect()
space = workspace.ensure_space()
workspace.ensure_studio()

print("test_hash_named_folder")
CK = store.upsert_character("cha-proj-1", "", {"name": ""}, 0)
workspace.root(CK).mkdir(parents=True, exist_ok=True)
old = workspace.bot_folder(CK)
check("a nameless bot's folder is its key", old == CK, old)
out = workspace.out_dir(CK)
(out / "보고서.md").write_text("x", encoding="utf-8")
hina = workspace.hina_dir(CK)
(hina / "scripts" / "a.py").write_text("print(1)", encoding="utf-8")
outdir = space / "studio" / "output" / old / "고르기"
outdir.mkdir(parents=True)
img = outdir / "a.png"
img.write_bytes(b"\x89PNG\r\n\x1a\nnot-really")

info = workspace.folder_info(CK)
check("hashLike while the bot has no name", info["hashLike"] and info["suggested"] == "", str(info))

store.upsert_character("cha-proj-1", "미도리", {"name": "미도리"}, 0)
info = workspace.folder_info(CK)
check("the current name is suggested", info["suggested"] == "미도리" and info["name"] == "미도리"
      and info["folder"] == old and info["key"] == CK, str(info))

# Stores keyed by the folder name.
agentnotes.save(agentnotes.scope(CK), "호칭", "미도리는 반말", "사용자 지시")
asset = {"project": old, "setId": "s", "slotId": "x", "fields": {"character": "미도리"}, "rule": {"id": "r"}}
rules_dir = assetrules._root()
(rules_dir / "projects").mkdir(parents=True, exist_ok=True)
(rules_dir / "projects" / (assetrules._hash(old) + ".json")).write_text(
    json.dumps({"project": old, "revision": 3, "rules": [{"id": "r"}], "sets": []}), encoding="utf-8")
assetrules.remember(img, asset)
studio.write_selection(f"studio/output/{old}/고르기", {"a.png": {"use": True}})
studio.save_group_profile(f"projects/{old}/out", "x", "emotion")
sk = skills.save("폴더 테스트 스킬", "테스트할 때", "본문", extra_meta={"learned_project": old})

print("\ntest_rename_hash_folder")
r = workspace.rename_bot_folder(CK, "미도리")
check("the result names old and new", r["old"] == old and r["folder"] == "미도리", str(r))
check("projects/, hina/ and studio/output/ moved",
      {m["to"] for m in r["moved"]} == {"projects/미도리", "hina/미도리", "studio/output/미도리"}, str(r["moved"]))
check("deliverables are under the new name", (space / "projects" / "미도리" / "out" / "보고서.md").is_file())
check("hina work area followed", (space / "hina" / "미도리" / "scripts" / "a.py").is_file())
check("studio output followed", (space / "studio" / "output" / "미도리" / "고르기" / "a.png").is_file())
check("old folders are gone", not (space / "projects" / old).exists() and not (space / "hina" / old).exists()
      and not (space / "studio" / "output" / old).exists())
bots = json.loads((space / ".hina" / "bots.json").read_text(encoding="utf-8"))
check("bots.json is re-pinned", bots[CK]["folder"] == "미도리" and bots[CK]["renamedFrom"] == old, str(bots))
check("notes re-keyed", [n["title"] for n in agentnotes.listing("project:미도리")["notes"]] == ["호칭"]
      and not agentnotes.listing("project:" + old)["notes"])
check("notes follow scope()", agentnotes.scope(CK) == "project:미도리")
doc = assetrules.read("미도리")
check("asset rules re-keyed", doc["revision"] == 3 and doc["rules"] == [{"id": "r"}] and doc["project"] == "미도리",
      str(doc))
check("old asset rules gone", assetrules.read(old)["revision"] == 0)
moved_img = space / "studio" / "output" / "미도리" / "고르기" / "a.png"
md = assetrules.metadata(moved_img)
check("the moved image's binding names the new project", (md or {}).get("project") == "미도리", str(md))
check("selection sidecar followed the folder",
      studio.read_selection("studio/output/미도리/고르기").get("a.png", {}).get("use") is True)
check("old selection sidecar gone", studio.read_selection(f"studio/output/{old}/고르기") == {})
check("group sidecar followed", studio.group_profile("projects/미도리/out")["pattern"] == "x")
check("skill learned_project follows", (skills.get(sk["id"]) or {}).get("meta", {}).get("learned_project") == "미도리")
check("out_dir uses the new folder", workspace.out_dir(CK) == space / "projects" / "미도리" / "out")
check("and does not regrow the old one", not (space / "projects" / old).exists())
check("a manifest is kept", (space / ".hina" / "folder-renames.json").is_file())
check("same name is a no-op", workspace.rename_bot_folder(CK, "미도리")["moved"] == [])
info = workspace.folder_info(CK)
check("folder_info after rename", info["folder"] == "미도리" and not info["hashLike"] and info["suggested"] == "",
      str(info))

print("\ntest_rename_refusals")
CK2 = store.upsert_character("cha-proj-2", "유키", {"name": "유키"}, 1)
workspace.root(CK2).mkdir(parents=True, exist_ok=True)
check("second bot pinned", workspace.bot_folder(CK2) == "유키")
raises("a name another bot holds is refused", workspace.rename_bot_folder, CK2, "미도리",
       exc=workspace.FolderConflict)
raises("the persona top folder is reserved", workspace.rename_bot_folder, CK2, workspace.PERSONA_TOP,
       exc=workspace.FolderConflict)
raises("an empty name is refused", workspace.rename_bot_folder, CK2, "  ::  ", exc=workspace.WorkspaceError)
(space / "projects" / "남의폴더").mkdir()
(space / "projects" / "남의폴더" / "x.md").write_text("x", encoding="utf-8")
raises("an existing foreign folder is refused (no merge)", workspace.rename_bot_folder, CK2, "남의폴더",
       exc=workspace.FolderConflict)
check("the foreign folder is untouched", (space / "projects" / "남의폴더" / "x.md").is_file())
store.upsert_character("cha-proj-2", "남의폴더", {"name": "남의폴더"}, 1)
check("a taken name is not suggested", workspace.folder_info(CK2)["suggested"] == "")
store.upsert_character("cha-proj-2", "유키", {"name": "유키"}, 1)
check("route: taken name -> 409", status_of(main.h_workspace_folder_rename,
                                           {"charKey": CK2, "folder": "미도리"}) == 409)
check("route: empty -> 400", status_of(main.h_workspace_folder_rename, {"charKey": CK2, "folder": ""}) == 400)
check("route: GET /workspace/folder", main.h_workspace_folder({"charKey": CK2})["folder"] == "유키")

CK3 = store.upsert_character("cha-proj-3", workspace.PERSONA_TOP, {"name": workspace.PERSONA_TOP}, 2)
check("a bot named 페르소나 gets 페르소나~2", workspace.bot_folder(CK3) == workspace.PERSONA_TOP + "~2",
      workspace.bot_folder(CK3))

print("\ntest_files_move_pinned_root")
workspace.out_dir(CK2)
workspace.hina_dir(CK2)
r = files.move(files.SPACE, "projects/유키", "projects/유키짱")
check("a top-level rename of a pinned project is a project rename",
      r["to"] == "projects/유키짱" and r.get("project", {}).get("folder") == "유키짱", str(r))
check("bots.json follows the file move", workspace.bot_folder(CK2) == "유키짱")
check("hina/ followed too", (space / "hina" / "유키짱").is_dir() and not (space / "hina" / "유키").exists())
(space / "projects" / "보관").mkdir()
raises("moving a pinned project into another folder is refused",
       files.move, files.SPACE, "projects/유키짱", "projects/보관")
raises("moving hina/<bot> directly is refused", files.move, files.SPACE, "hina/미도리", "hina/다른이름")
res = files.move_many(files.SPACE, ["projects/유키짱"], "projects/보관")
check("move_many reports the refusal per item", res["done"] == 0 and len(res["failed"]) == 1, str(res))
r = files.move(files.SPACE, "projects/남의폴더", "projects/보관")
check("an ordinary folder still moves", r["to"] == "projects/보관/남의폴더", str(r))

print("\ntest_persona_folder")
p1 = workspace.persona_folder("pid-1", "아키라")
check("persona folder path", p1 == f"projects/{workspace.PERSONA_TOP}/아키라", p1)
check("and it exists", (space / p1).is_dir())
check("pinned by id across renames of the input", workspace.persona_folder("pid-1", "다른이름") == p1)
p2 = workspace.persona_folder("pid-2", "아키라")
check("a collision counts up", p2 == f"projects/{workspace.PERSONA_TOP}/아키라~2", p2)
p3 = workspace.persona_folder("", "무명")
check("no id -> keyed by name", p3.endswith("/무명")
      and "name:무명" in json.loads((space / ".hina" / "personas.json").read_text(encoding="utf-8")))
check("empty name -> persona", workspace.persona_folder("pid-4", "  ").endswith("/persona"))
(space / p1 / "설정.md").write_text("x", encoding="utf-8")
rr = workspace.rename_persona_folder("pid-1", "아키라", "아키라2")
check("persona rename moves the folder", rr["old"] == "아키라" and rr["folder"] == "아키라2"
      and (space / rr["path"] / "설정.md").is_file() and not (space / p1).exists(), str(rr))
raises("persona rename onto another persona's folder is refused", workspace.rename_persona_folder,
       "pid-2", "아키라", "아키라2", exc=workspace.FolderConflict)
rr = workspace.rename_persona_folder("", "무명", "유명")
check("a name-keyed persona is re-keyed by its new name", rr["folder"] == "유명"
      and workspace.persona_folder("", "유명") == rr["path"], str(rr))
raises("the persona top folder cannot be moved", files.move, files.SPACE,
       f"projects/{workspace.PERSONA_TOP}", "projects/p2")
raises("a persona's folder cannot be moved directly", files.move, files.SPACE,
       f"projects/{workspace.PERSONA_TOP}/아키라2", "projects")
out = main.h_persona_folder({"id": "pid-9", "name": "카이"})
check("route: POST /persona/folder", out == {"path": f"projects/{workspace.PERSONA_TOP}/카이", "folder": "카이"},
      str(out))
out = main.h_persona_folder_rename({"id": "pid-9", "name": "카이", "folder": "카이토"})
check("route: POST /persona/folder/rename", out["folder"] == "카이토" and out["old"] == "카이", str(out))
check("route: persona rename conflict -> 409", status_of(main.h_persona_folder_rename,
      {"id": "pid-9", "name": "카이토", "folder": "아키라2"}) == 409)
raises("a bot cannot take the persona top name via files.move", files.move, files.SPACE,
       "projects/미도리", f"projects/{workspace.PERSONA_TOP}")

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - project folder renames carry their stores; persona folders are pinned")
