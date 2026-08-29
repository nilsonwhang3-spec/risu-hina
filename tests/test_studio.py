"""The asset studio's storage: a second file scope, and the wall between them.

`files.py` used to serve exactly one root, a bot's workspace. The studio added
a second — global, bot-independent, and optionally on another drive — by making
the root a parameter rather than by growing a second file API. That is a good
trade only if the wall between the two scopes holds, so this is mostly a test
about paths that must not resolve:

    python tests/test_studio.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-studio-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to cp949
except Exception:  # noqa: BLE001
    pass

from app import config, db, files, store, workspace  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def raises(name: str, fn, *args) -> None:
    try:
        fn(*args)
    except (files.FileError, ValueError):
        print(f"  ok   {name}")
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL {name} - raised {type(e).__name__}: {e}")
        FAILURES.append(name)
    else:
        print(f"  FAIL {name} - no error")
        FAILURES.append(name)


config.load()
db.connect()

# A real bot workspace to be walled off from.
CK = store.upsert_character("cha-studio-test", "Studio Test", {"name": "Studio Test"}, 0)
workspace.root(CK).mkdir(parents=True, exist_ok=True)
(workspace.root(CK) / "uploads").mkdir(exist_ok=True)
(workspace.root(CK) / "uploads" / "secret.txt").write_text("bot only", encoding="utf-8")

print("\ntest_roots_are_separate")
lib = workspace.ensure_studio()
check("studio defaults under the data dir", lib == config.DATA_DIR / "studio", str(lib))
check("studio is not inside any workspace", config.WORKSPACE_DIR not in lib.parents)
check("the areas were created", all((lib / a).is_dir() for a in files.STUDIO_AREAS),
      str(sorted(p.name for p in lib.iterdir())))
check("a bot workspace is elsewhere", files._root(CK) != files._root(files.STUDIO))

print("\ntest_area_tables_differ")
check("studio areas are the studio's", set(files.areas_for(files.STUDIO)) == set(files.STUDIO_AREAS))
check("bot areas are unchanged", set(files.areas_for(CK)) == set(files.AREAS))
# The library is the user's own; "정리" must never be able to sweep it.
check("nothing in the studio is cleanable",
      not any(c for (_d, c) in files.STUDIO_AREAS.values()),
      str(files.STUDIO_AREAS))

print("\ntest_the_wall_holds")
# The containment check compares resolved paths, so these must fail whatever
# shape the escape takes.
raises("../ out of the studio", files.read, files.STUDIO, "../workspace/x.txt")
raises("absolute path into a workspace", files.read, files.STUDIO,
       str(workspace.root(CK) / "uploads" / "secret.txt"))
raises("deep ../ chain", files.read, files.STUDIO, "images/../../../../etc/passwd")
raises("a bot cannot read into the studio", files.read, CK, "../studio/styles/x.md")

print("\ntest_files_api_works_in_both_scopes")
files.upload(files.STUDIO, "note.md", text="# hi", into="styles/테스트")
files.upload(CK, "note.md", text="# bot", into="uploads")
s_listing = files.listing(files.STUDIO)
b_listing = files.listing(CK)
s_paths = [f["path"] for a in s_listing["areas"] for f in a["files"]]
b_paths = [f["path"] for a in b_listing["areas"] for f in a["files"]]
check("studio upload landed in its own tree", "styles/테스트/note.md" in s_paths, str(s_paths))
check("studio listing does not show the bot's files", "uploads/secret.txt" not in s_paths, str(s_paths))
check("bot listing does not show the studio's files",
      not any(p.startswith("styles/") for p in b_paths), str(b_paths))
check("nested folders survive", (lib / "styles" / "테스트" / "note.md").is_file())

files.mkdir(files.STUDIO, "images/보관")
files.move(files.STUDIO, "styles/테스트/note.md", "images/보관/note.md")
check("move works inside the studio", (lib / "images" / "보관" / "note.md").is_file())
files.delete(files.STUDIO, "images/보관/note.md")
check("delete works inside the studio", not (lib / "images" / "보관" / "note.md").exists())

print("\ntest_clean_never_touches_the_library")
files.upload(files.STUDIO, "keep.md", text="x", into="images")
before = files.clean(files.STUDIO)
check("clean removes nothing in the studio", before["removed"] == 0, str(before))
check("and the file is still there", (lib / "images" / "keep.md").is_file())

print("\ntest_library_path_is_configurable")
elsewhere = Path(tempfile.mkdtemp(prefix="risuhina-lib-"))
config.update({"studio": {"libraryPath": str(elsewhere)}})
check("root follows the setting", workspace.studio_root() == elsewhere, str(workspace.studio_root()))
workspace.ensure_studio()
files.upload(files.STUDIO, "far.md", text="x", into="styles")
check("and files land there", (elsewhere / "styles" / "far.md").is_file())
# Containment is against the configured root, not the data dir, so an escape
# attempt from a library outside data/ still has to fail.
raises("the wall holds outside the data dir", files.read, files.STUDIO, "../../etc/passwd")
config.update({"studio": {"libraryPath": ""}})
check("clearing the setting restores the default", workspace.studio_root() == config.DATA_DIR / "studio")

print("\ntest_prompt_assembly")
from app import studio  # noqa: E402

files.upload(files.STUDIO, "수채화.md", text=(
    "---\nname: 수채화\ndescription: 부드러운 수채\n---\n"
    "## positive\nmasterpiece, watercolor\n\n## negative\nlowres, bad anatomy\n"), into="styles")
files.upload(files.STUDIO, "히나.json", text=json.dumps(
    {"name": "히나", "caption": "1girl, silver hair", "negative": "multiple girls"},
    ensure_ascii=False), into="characters")
files.upload(files.STUDIO, "기본.json", text=json.dumps(
    {"version": 1, "scenes": [
        {"name": "happy", "prompt": "<조각.eyes>, smile", "negativePrompt": "", "width": 832, "height": 1216},
        {"name": "sad", "prompt": "teary eyes", "negativePrompt": "blurry", "width": 512, "height": 512},
        {"name": "angry", "prompt": "{{angry}}, frown", "negativePrompt": "", "width": 0, "height": 0}]},
    ensure_ascii=False), into="scenes")
files.upload(files.STUDIO, "조각.json", text=json.dumps(
    {"eyes": "blue eyes"}, ensure_ascii=False), into="fragments")

s = studio.read_style("styles/수채화.md")
check("front matter is read", s["name"] == "수채화", s["name"])
check("positive and negative are split",
      s["positive"] == "masterpiece, watercolor" and s["negative"] == "lowres, bad anatomy",
      f"{s['positive']!r} / {s['negative']!r}")
# A file someone pasted a prompt into, with no headings at all, must still work.
files.upload(files.STUDIO, "민무늬.md", text="just a prompt, nothing else", into="styles")
check("a heading-less style is all positive",
      studio.read_style("styles/민무늬.md")["positive"] == "just a prompt, nothing else")

pos, neg, caps = studio.compose({
    "style": "styles/수채화.md", "characters": ["characters/히나.json"], "emotion": "smile"})
check("style, character and emotion are composed in order",
      pos == "masterpiece, watercolor, 1girl, silver hair, smile", pos)
check("negatives are collected too", "lowres" in neg and "multiple girls" in neg, neg)
check("one character needs no char_captions", caps == [], str(caps))

print("\ntest_naming_and_parsing")
name = studio.build_name(studio.DEFAULT_TEMPLATE, character="히나", outfit="교복",
                         emotion="happy", index=0, stamp="20260829-1200")
check("the template fills in", name == "히나-교복-happy-20260829-1200-1.png", name)
# The delimiter inside a field would shift every field the parser reads.
check("a hyphen in a name is neutralised",
      "_" in studio.build_name("{character}-x", character="a-b"),
      studio.build_name("{character}-x", character="a-b"))
r = studio.parse_names([name, "엉망진창.png"])
check("a well-formed name parses", r["matched"] and r["matched"][0]["emotion"] == "happy",
      str(r["matched"]))
# The whole reason the app exists: names are not deterministic, so what did
# NOT parse has to be reported rather than dropped.
check("what did not parse is reported", r["unmatched"] == ["엉망진창.png"], str(r["unmatched"]))

print("\ntest_scene_presets")
sc = studio.read_scenes("scenes/기본.json")
check("the NAIS3 file is read verbatim", len(sc["scenes"]) == 3, str(len(sc["scenes"])))
check("each scene carries its own size",
      sc["scenes"][1]["width"] == 512 and sc["scenes"][0]["width"] == 832)
check("a zero size means 'use the run\'s'", sc["scenes"][2]["width"] is None)

# `<collection.key>` is spliced in; `{{…}}` is NovelAI's own emphasis and has to
# reach NovelAI exactly as written - this file never parses or rewrites it.
text, missing = studio.resolve_refs("<조각.eyes>, {{angry}}")
check("a fragment reference is resolved", text == "blue eyes, {{angry}}", text)
check("NovelAI emphasis is untouched", "{{angry}}" in text)
check("nothing was missing", missing == [], str(missing))
# A whole file by name, and a folder-qualified one. File wins over a key.
files.upload(files.STUDIO, "눈.md", text="wide eyes", into="fragments")
files.upload(files.STUDIO, "눈.md", text="narrow eyes", into="fragments/밤")
whole, _ = studio.resolve_refs("<눈>, smile")
check("a whole .md fragment is called by name", whole == "wide eyes, smile", whole)
nested, _ = studio.resolve_refs("<밤/눈>, smile")
check("and a folder-qualified one", nested == "narrow eyes, smile", nested)
allof, _ = studio.resolve_refs("<조각>")
check("a whole .json collection joins its values", allof == "blue eyes", allof)

text, missing = studio.resolve_refs("<없는것.x>, smile")
check("an unknown reference is reported", missing == ["<없는것.x>"], str(missing))
check("and left in the prompt rather than dropped", "<없는것.x>" in text, text)

print("\ntest_batch_plan")
items = studio.plan({"style": "styles/수채화.md", "characters": ["characters/히나.json"],
                     "scenePreset": "scenes/기본.json", "characterName": "히나",
                     "outfit": "교복", "count": 2, "seed": 7})
check("one entry per scene x count", len(items) == 6, str(len(items)))
check("every scene is present", {i["scene"] for i in items} == {"happy", "sad", "angry"},
      str({i["scene"] for i in items}))
check("the scene's prompt lands in the composed prompt",
      any("teary eyes" in i["prompt"] for i in items), items[0]["prompt"])
check("its fragment reference was resolved",
      any("blue eyes" in i["prompt"] for i in items),
      next(i["prompt"] for i in items if i["scene"] == "happy"))
check("the scene's own negative is carried",
      any("blurry" in i["negative"] for i in items),
      next(i["negative"] for i in items if i["scene"] == "sad"))
check("a scene's size overrides the run's",
      next(i for i in items if i["scene"] == "sad")["size"] == {"width": 512, "height": 512})
check("a scene with no size leaves it to the run",
      "size" not in next(i for i in items if i["scene"] == "angry"))
check("seeds advance within a group, not across it",
      sorted({i["seed"] for i in items}) == [7, 8], str(sorted({i["seed"] for i in items})))
check("names are unique", len({i["name"] for i in items}) == 6)
check("only= picks a subset",
      len(studio.plan({"scenePreset": "scenes/기본.json", "only": ["sad"]})) == 1)
est = studio.estimate({"vibes": []}, len(items))
check("an estimate never claims generation is free",
      est["anlasCertain"] == 0 and "등급" in est["note"], json.dumps(est, ensure_ascii=False))
check("but names the certain cost when references are used",
      studio.estimate({"vibes": [{"path": "x"}, {"path": "y"}]}, 1)["anlasCertain"] == 4)

print("\ntest_staging_crosses_scopes_by_copy")
png = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 40
(studio.root() / "images").mkdir(parents=True, exist_ok=True)
(studio.root() / "images" / "hop.png").write_bytes(png)
staged = studio.stage_to_bot(CK, "images/hop.png")
check("it lands in the bot's workspace", staged["path"].startswith("out/studio/"), staged["path"])
check("and the library keeps its own", (studio.root() / "images" / "hop.png").is_file())
raises("a non-PNG is refused", studio.stage_to_bot, CK, "styles/수채화.md")

print("\ntest_grouping_and_selection")
shots = studio.root() / "images" / "고르기"
shots.mkdir(parents=True, exist_ok=True)
PNG = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 40
for n in ("히나-교복-happy-20260829-1200-1.png", "히나-교복-happy-20260829-1200-2.png",
          "히나-교복-sad-20260829-1200-1.png", "제멋대로 지은 이름.png"):
    (shots / n).write_bytes(PNG)

g = studio.group("images/고르기")
check("groups come from the filename", [x["key"] for x in g["groups"]] == ["happy", "sad"],
      str([x["key"] for x in g["groups"]]))
check("candidates land in their group",
      len(g["groups"][0]["items"]) == 2 and len(g["groups"][1]["items"]) == 1)
# The point of the whole design: a name the regex cannot read is SHOWN, not
# dropped, because that is the file that needs attention.
check("what did not parse is carried, not dropped",
      [u["filename"] for u in g["unmatched"]] == ["제멋대로 지은 이름.png"],
      str(g["unmatched"]))

studio.write_selection("images/고르기", {
    "히나-교복-happy-20260829-1200-1.png": {"use": True, "inpaint": False, "delete": False},
    "히나-교복-happy-20260829-1200-2.png": {"use": False, "inpaint": True, "delete": False},
})
back = studio.group("images/고르기")
picked = [i for grp in back["groups"] for i in grp["items"] if i["selection"]["use"]]
check("a selection survives a round trip", len(picked) == 1, str(len(picked)))
check("the three flags are independent",
      back["groups"][0]["items"][1]["selection"] == {"use": False, "inpaint": True, "delete": False},
      str(back["groups"][0]["items"][1]["selection"]))

print("\ntest_export")
r = studio.export_selected("images/고르기", character="히나")
sel_dir = shots / "selected"
names = sorted(p.name for p in sel_dir.iterdir())
check("the chosen one gets the canonical name", "히나-happy.png" in names, str(names))
check("the one to fix goes to inpaint/", (sel_dir / "inpaint").is_dir() and
      any((sel_dir / "inpaint").iterdir()))
# The empty .txt is what sends you back to generate just that slot.
check("a group with nothing chosen leaves a placeholder",
      "히나-sad.txt" in names, str(names))
check("the counts are reported", r["used"] == 1 and r["inpaint"] == 1 and r["empty"] == 1,
      json.dumps(r, ensure_ascii=False))
# `<character>-<emotion>` is exactly RisuAI's emotionImages naming, which is
# why the export is directly adoptable.
check("export names match the emotionImages convention",
      all(("-" in n) for n in names if n.endswith(".png")), str(names))

print("\ntest_bulk_rename")
plan = studio.rename_plan("images/고르기", [
    {"from": "제멋대로 지은 이름.png", "to": "히나-교복-angry-20260829-1200-1.png"}])
check("a clean rename plans", plan["rename"] and not plan["problems"], json.dumps(plan, ensure_ascii=False))
bad = studio.rename_plan("images/고르기", [
    {"from": "없는파일.png", "to": "x.png"},
    {"from": "히나-교복-sad-20260829-1200-1.png", "to": "히나-교복-happy-20260829-1200-1.png"},
    {"from": "히나-교복-sad-20260829-1200-1.png", "to": "../탈출.png"}])
check("every problem is named", len(bad["problems"]) == 3, json.dumps(bad, ensure_ascii=False))
check("a rename cannot leave the folder",
      any("폴더" in p["why"] for p in bad["problems"]), str(bad["problems"]))
# All or nothing: a half-applied rename is worse than none.
raises("a plan with problems applies nothing", studio.rename_apply, "images/고르기",
       [{"from": "없는파일.png", "to": "x.png"}])
studio.rename_apply("images/고르기", plan["rename"])
check("the rename landed", (shots / "히나-교복-angry-20260829-1200-1.png").is_file())
check("and it now parses into a group",
      "angry" in [x["key"] for x in studio.group("images/고르기")["groups"]])

print("\ntest_inpaint_mask")
from app import nai  # noqa: E402

mask = studio.make_mask(64, 48, [{"x": 0.25, "y": 0.5, "w": 0.5, "h": 0.25}])
check("it is a PNG", mask[:8] == b"\x89PNG\r\n\x1a\n")
check("of the size asked for", nai.png_size(mask) == (64, 48), str(nai.png_size(mask)))
# Written with zlib alone on purpose: Pillow is not in the release bundle, and
# the one image operation on the core path must not need it.
check("it needs no image library",
      "PIL" not in sys.modules and "Pillow" not in sys.modules)
# White is what gets repainted (docs/09 §7c), so an empty box list would
# repaint nothing and is refused rather than silently doing a no-op.
raises("no region is refused",
       lambda: studio.inpaint("images/고르기/히나-교복-sad-20260829-1200-1.png", [], "x",
                              model="nai-diffusion-4-5-full"))
check("the inpainting model is derived, not guessed",
      nai.inpaint_model("nai-diffusion-4-5-full") == "nai-diffusion-4-5-full-inpainting")
check("and an inpainting id is left alone",
      nai.inpaint_model("nai-diffusion-3-inpainting") == "nai-diffusion-3-inpainting")

print("\ntest_duplicates_and_emotion_check")
dup = studio.root() / "images" / "중복"
dup.mkdir(parents=True, exist_ok=True)
same = PNG + b"same"
for n in ("a.png", "aa-longer-name.png", "b.png"):
    (dup / n).write_bytes(same)
(dup / "different.png").write_bytes(PNG + b"other")
d = studio.duplicates("images/중복")
check("identical files are grouped", len(d["groups"]) == 1, str(d["groups"]))
check("the shortest name is kept", d["groups"][0]["keep"].endswith("a.png"), d["groups"][0]["keep"])
check("the rest are candidates, not casualties", len(d["groups"][0]["others"]) == 2)
check("a different file is not a duplicate", d["duplicateFiles"] == 2, str(d["duplicateFiles"]))
check("nothing was deleted", len(list(dup.iterdir())) == 4, str(len(list(dup.iterdir()))))

# Both directions matter and they look nothing alike: a slot with no asset is
# work to do, an asset nothing names is dead weight.
files.upload(files.STUDIO, "12종.json", text=json.dumps(
    {"version": 1, "scenes": [{"name": "happy", "prompt": "smile"},
                              {"name": "sad", "prompt": "tears"},
                              {"name": "angry", "prompt": "frown"}]},
    ensure_ascii=False), into="scenes")
db.execute("INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) "
           "VALUES(?,?,?,?,?,?)", (CK, 0, "emotion", "happy", "png", "assets/x.png"))
db.execute("INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) "
           "VALUES(?,?,?,?,?,?)", (CK, 1, "emotion", "떠돌이", "png", "assets/y.png"))
e = studio.emotion_check(CK, "scenes/12종.json")
check("what the card has is listed", set(e["have"]) == {"happy", "떠돌이"}, str(e["have"]))
check("slots with no asset are named", set(e["missing"]) == {"sad", "angry"}, str(e["missing"]))
check("and the note counts them", "2개가 카드에 없습니다" in e["note"], e["note"])

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - the studio is a second scope and the wall between them holds")
