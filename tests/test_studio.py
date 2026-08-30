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

print("\ntest_studio_is_a_folder_of_the_space")
lib = workspace.ensure_studio()
check("the library lives at space/studio", lib == config.DATA_DIR / "space" / "studio", str(lib))
check("the library areas were created", all((lib / a).is_dir() for a in workspace.STUDIO_SUBDIRS),
      str(sorted(p.name for p in lib.iterdir())))
check("the SYSTEM dir stays outside the space",
      files._root(files.SPACE) not in files._root(CK).parents
      and files._root(CK) != files._root(files.SPACE))

print("\ntest_area_tables")
check("the space's areas", set(files.areas_for(files.SPACE)) == set(files.SPACE_AREAS))
check("a bot's SYSTEM areas are the old table", set(files.areas_for(CK)) == set(files.AREAS))
# The user tree is the user's own; "정리" must never be able to sweep it.
check("nothing visible in the space is cleanable",
      not any(c for a, (_d, c) in files.SPACE_AREAS.items() if not a.startswith(".")),
      str(files.SPACE_AREAS))

print("\ntest_the_wall_holds")
# The containment check compares resolved paths, so these must fail whatever
# shape the escape takes. The wall is around the space now - the SYSTEM dirs
# (scope.db, original/) are what must stay out of reach.
raises("../ out of the space", files.read, files.SPACE, "../workspace/x.txt")
raises("absolute path into a SYSTEM dir", files.read, files.SPACE,
       str(workspace.root(CK) / "uploads" / "secret.txt"))
raises("deep ../ chain", files.read, files.SPACE, "studio/images/../../../../../etc/passwd")
raises("a SYSTEM view cannot read into the space", files.read, CK, "../space/studio/styles/x.md")

print("\ntest_files_api_over_the_space")
files.upload(files.SPACE, "note.md", text="# hi", into="studio/styles/테스트")
raises("the SYSTEM view takes no uploads",
       lambda: files.upload(CK, "note.md", text="# bot", into="uploads"))
s_listing = files.listing(files.SPACE)
b_listing = files.listing(CK)
s_paths = [f["path"] for a in s_listing["areas"] for f in a["files"]]
b_paths = [f["path"] for a in b_listing["areas"] for f in a["files"]]
check("the upload landed in the library", "studio/styles/테스트/note.md" in s_paths, str(s_paths))
check("the space listing does not show SYSTEM files", "uploads/secret.txt" not in s_paths, str(s_paths))
check("a SYSTEM listing does not show the space",
      not any(p.startswith("studio/") for p in b_paths), str(b_paths))
check("nested folders survive", (lib / "styles" / "테스트" / "note.md").is_file())

files.mkdir(files.SPACE, "studio/images/보관")
files.move(files.SPACE, "studio/styles/테스트/note.md", "studio/images/보관/note.md")
check("move works inside the space", (lib / "images" / "보관" / "note.md").is_file())
files.delete(files.SPACE, "studio/images/보관/note.md")
check("delete works inside the space", not (lib / "images" / "보관" / "note.md").exists())

print("\ntest_clean_never_touches_the_library")
files.upload(files.SPACE, "keep.md", text="x", into="studio/images")
before = files.clean(files.SPACE)
check("a space-wide clean can only touch the machine area",
      set(before["areas"]) <= {".hina"}, str(before))
check("and the library file is still there", (lib / "images" / "keep.md").is_file())

print("\ntest_space_path_is_configurable")
elsewhere = Path(tempfile.mkdtemp(prefix="risuhina-space-"))
config.update({"workspace": {"globalPath": str(elsewhere)}})
check("the space follows the setting", workspace.space_root() == elsewhere, str(workspace.space_root()))
workspace.ensure_studio()
files.upload(files.SPACE, "far.md", text="x", into="studio/styles")
check("and files land there", (elsewhere / "studio" / "styles" / "far.md").is_file())
# Containment is against the configured root, not the data dir, so an escape
# attempt from a space outside data/ still has to fail.
raises("the wall holds outside the data dir", files.read, files.SPACE, "../../etc/passwd")
config.update({"workspace": {"globalPath": ""}})
check("clearing the setting restores the default",
      workspace.space_root() == config.DATA_DIR / "space")

print("\ntest_prompt_assembly")
from app import studio  # noqa: E402

files.upload(files.SPACE, "수채화.md", text=(
    "---\nname: 수채화\ndescription: 부드러운 수채\n---\n"
    "## positive\n스타일A, 스타일B\n\n## negative\n제외A, 제외B\n"), into="studio/styles")
files.upload(files.SPACE, "히나.json", text=json.dumps(
    {"name": "히나", "caption": "캐릭터A", "negative": "제외C"},
    ensure_ascii=False), into="studio/characters")
files.upload(files.SPACE, "기본.json", text=json.dumps(
    {"version": 1, "scenes": [
        {"name": "happy", "prompt": "<조각프롬.a>, 씬A", "negativePrompt": "", "width": 832, "height": 1216},
        {"name": "sad", "prompt": "씬B", "negativePrompt": "제외D", "width": 512, "height": 512},
        {"name": "angry", "prompt": "{{강조}}, 씬C", "negativePrompt": "", "width": 0, "height": 0}]},
    ensure_ascii=False), into="studio/scenes")
files.upload(files.SPACE, "조각프롬.json", text=json.dumps(
    {"a": "조각A"}, ensure_ascii=False), into="studio/fragments")

s = studio.read_style("styles/수채화.md")
check("front matter is read", s["name"] == "수채화", s["name"])
check("positive and negative are split",
      s["positive"] == "스타일A, 스타일B" and s["negative"] == "제외A, 제외B",
      f"{s['positive']!r} / {s['negative']!r}")
# A file someone pasted a prompt into, with no headings at all, must still work.
files.upload(files.SPACE, "민무늬.md", text="본문만 있는 파일", into="studio/styles")
check("a heading-less style is all positive",
      studio.read_style("styles/민무늬.md")["positive"] == "본문만 있는 파일")

pos, neg, caps = studio.compose({
    "style": "styles/수채화.md", "characters": ["characters/히나.json"], "emotion": "씬A"})
check("style, character and emotion are composed in order",
      pos == "스타일A, 스타일B, 캐릭터A, 씬A", pos)
check("negatives are collected too", "제외A" in neg and "제외C" in neg, neg)
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
text, missing = studio.resolve_refs("<조각프롬.a>, {{강조}}")
check("a fragment reference is resolved", text == "조각A, {{강조}}", text)
check("NovelAI emphasis is untouched", "{{강조}}" in text)
check("nothing was missing", missing == [], str(missing))
# A whole file by name, and a folder-qualified one. File wins over a key.
files.upload(files.SPACE, "조각파일.md", text="조각B", into="studio/fragments")
files.upload(files.SPACE, "조각파일.md", text="조각C", into="studio/fragments/폴더")
whole, _ = studio.resolve_refs("<조각파일>, 씬A")
check("a whole .md fragment is called by name", whole == "조각B, 씬A", whole)
nested, _ = studio.resolve_refs("<폴더/조각파일>, 씬A")
check("and a folder-qualified one", nested == "조각C, 씬A", nested)
allof, _ = studio.resolve_refs("<조각프롬>")
check("a whole .json collection joins its values", allof == "조각A", allof)

text, missing = studio.resolve_refs("<없는것.x>, 씬A")
check("an unknown reference is reported", missing == ["<없는것.x>"], str(missing))
check("and left in the prompt rather than dropped", "<없는것.x>" in text, text)

# The card's front-matter name is an address too: rename the card in the
# editor and `<새이름>` keeps working without touching the filename.
files.upload(files.SPACE, "eye-detail.md",
             text="---\nname: 눈 디테일\n---\n섬세한 눈", into="studio/fragments")
byname, byname_missing = studio.resolve_refs("<눈 디테일>")
check("a fragment resolves by its front-matter name", byname == "섬세한 눈", byname)
check("with nothing reported missing", byname_missing == [], str(byname_missing))
bystem, _ = studio.resolve_refs("<eye-detail>")
check("the stem still resolves as before", bystem == "섬세한 눈", bystem)
# A stem always beats a display name: a name that shadows another file's stem
# must not hijack that file's references.
files.upload(files.SPACE, "shadow.md",
             text="---\nname: 조각파일\n---\n가짜", into="studio/fragments")
shadowed, _ = studio.resolve_refs("<조각파일>")
check("a display name never shadows a real stem", shadowed == "조각B", shadowed)
frag_rows = {i["path"]: i for i in studio.listing("fragments")}
check("the fragment listing shows the front-matter name",
      frag_rows["studio/fragments/eye-detail.md"]["name"] == "눈 디테일",
      str(frag_rows.get("studio/fragments/eye-detail.md")))
check("and falls back to the stem without one",
      frag_rows["studio/fragments/조각파일.md"]["name"] == "조각파일")
files.delete(files.SPACE, "studio/fragments/shadow.md")
files.delete(files.SPACE, "studio/fragments/eye-detail.md")

print("\ntest_batch_plan")
items = studio.plan({"style": "styles/수채화.md", "characters": ["characters/히나.json"],
                     "scenePreset": "scenes/기본.json", "characterName": "히나",
                     "outfit": "교복", "count": 2, "seed": 7})
check("one entry per scene x count", len(items) == 6, str(len(items)))
check("every scene is present", {i["scene"] for i in items} == {"happy", "sad", "angry"},
      str({i["scene"] for i in items}))
check("the scene's prompt lands in the composed prompt",
      any("씬B" in i["prompt"] for i in items), items[0]["prompt"])
check("its fragment reference was resolved",
      any("조각A" in i["prompt"] for i in items),
      next(i["prompt"] for i in items if i["scene"] == "happy"))
check("the scene's own negative is carried",
      any("제외D" in i["negative"] for i in items),
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

print("\ntest_adoption_needs_no_copy")
# The library and the workspace are one space: an image is adopted by its own
# global path, checked (PNG-ness) rather than copied.
from app import assets  # noqa: E402

png = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 40
(studio.root() / "images").mkdir(parents=True, exist_ok=True)
(studio.root() / "images" / "hop.png").write_bytes(png)
staged = assets.stage_file(studio._rel("images/hop.png"))
check("the checked path is the global path", staged["path"] == "studio/images/hop.png", staged["path"])
check("and the library keeps its own", (studio.root() / "images" / "hop.png").is_file())


def _stage_md() -> None:
    assets.stage_file(studio._rel("styles/수채화.md"))


def _raises_asset(name: str, fn) -> None:
    try:
        fn()
    except assets.AssetError:
        print(f"  ok   {name}")
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL {name} - raised {type(e).__name__}: {e}")
        FAILURES.append(name)
    else:
        print(f"  FAIL {name} - no error")
        FAILURES.append(name)


_raises_asset("a non-PNG is refused", _stage_md)

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
files.upload(files.SPACE, "12종.json", text=json.dumps(
    {"version": 1, "scenes": [{"name": "happy", "prompt": "씬A"},
                              {"name": "sad", "prompt": "씬B"},
                              {"name": "angry", "prompt": "씬C"}]},
    ensure_ascii=False), into="studio/scenes")
db.execute("INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) "
           "VALUES(?,?,?,?,?,?)", (CK, 0, "emotion", "happy", "png", "assets/x.png"))
db.execute("INSERT INTO char_assets(char_key, seq, field, name, ext, risu_key) "
           "VALUES(?,?,?,?,?,?)", (CK, 1, "emotion", "떠돌이", "png", "assets/y.png"))
e = studio.emotion_check(CK, "scenes/12종.json")
check("what the card has is listed", set(e["have"]) == {"happy", "떠돌이"}, str(e["have"]))
check("slots with no asset are named", set(e["missing"]) == {"sad", "angry"}, str(e["missing"]))
check("and the note counts them", "2개가 카드에 없습니다" in e["note"], e["note"])

# The card model: a style or a character carries its own on/off and order in
# its front matter, the way a lorebook entry carries alwaysActive/insertorder.
print("\ntest_prompt_cards")
files.upload(files.SPACE, "카드A.md", text="---\nname: 카드A\nenabled: true\norder: 20\n---\n스타일A2",
             into="studio/styles")
files.upload(files.SPACE, "카드B.md", text="---\nname: 카드B\nenabled: true\n---\n스타일B2\n## negative\n제외B2",
             into="studio/styles")
sA = studio.read_style("styles/카드A.md")
check("enabled and order come from the front matter", sA["enabled"] is True and sA["order"] == 20)
check("an absent enabled means OFF", studio.read_style("styles/수채화.md")["enabled"] is False)
check("active styles come in (order, path) order",
      studio.active("styles") == ["studio/styles/카드A.md", "studio/styles/카드B.md"],
      str(studio.active("styles")))

r = studio.set_meta("styles/카드A.md", {"enabled": False})
check("set_meta flips the switch", r["enabled"] is False)
check("and preserves the body byte for byte",
      studio._read_text("styles/카드A.md").endswith("---\n스타일A2"))
studio.set_meta("styles/카드A.md", {"enabled": True, "order": 20})

pos, neg, _caps = studio.compose({"styles": ["styles/카드A.md", "styles/카드B.md"], "characters": []})
check("plural styles concatenate in order", pos == "스타일A2, 스타일B2", pos)
check("their negatives collect too", neg == "제외B2", neg)
pos, _n, _c = studio.compose({"style": "styles/카드B.md", "characters": []})
check("the legacy singular style still folds in", pos == "스타일B2", pos)
pos, _n, _c = studio.compose({"characters": []})
check("unstated styles mean the active cards", pos == "스타일A2, 스타일B2", pos)
pos, _n, _c = studio.compose({"styles": [], "characters": []})
check("an explicit empty list means none", pos == "", pos)

print("\ntest_character_folder_cards")
files.upload(files.SPACE, "레거시.json", text=json.dumps(
    {"name": "레거시", "caption": "캐릭터B", "negative": "제외D2"}, ensure_ascii=False),
    into="studio/characters")
(studio.root() / "characters" / "레거시.png").write_bytes(PNG)
moved = studio.migrate_characters()
check("a legacy stem-pair becomes a folder card", moved >= 1
      and (studio.root() / "characters" / "레거시" / "prompt.md").is_file()
      and (studio.root() / "characters" / "레거시" / "레거시.png").is_file(),
      str(moved))
check("and the legacy files are gone", not (studio.root() / "characters" / "레거시.json").exists())
check("migration is idempotent", studio.migrate_characters() == 0)

c = studio.read_character("characters/레거시")
check("the folder card reads whole", c["name"] == "레거시" and c["caption"] == "캐릭터B"
      and c["negative"] == "제외D2", json.dumps(c, ensure_ascii=False)[:200])
check("the migrated png became a vibe entry", len(c["vibe"]) == 1
      and c["vibe"][0]["file"] == "레거시.png" and c["vibe"][0]["strength"] == 0.6, str(c["vibe"]))
check("a card starts disabled", c["enabled"] is False)
studio.set_meta("characters/레거시", {"enabled": True})
check("the folder toggle lands in prompt.md", studio.read_character("characters/레거시")["enabled"] is True)
lst = studio.listing("characters")
check("the listing is one card per folder",
      any(i["path"] == "studio/characters/레거시" and i["vibe"] == 1 for i in lst), str(lst)[:300])

# 히나.json was itself migrated by the earlier listing call - the folder is
# the card now, and this asserts both folder cards compose together.
pos, neg, caps = studio.compose({"styles": [], "characters": ["characters/레거시", "characters/히나"]})
check("two characters become char_captions", len(caps) == 2, str(caps))
check("no centers means no captions with coords", all(not cc["centers"] for cc in caps))

print("\ntest_character_reference")
from app import nai  # noqa: E402

check("charref is v4.5 only", nai.supports_charref("nai-diffusion-4-5-full")
      and not nai.supports_charref("nai-diffusion-5-full"))
bucket = studio.make_mask(1024, 1536, [])
wrong = studio.make_mask(1024, 1024, [])
try:
    nai.check_charref_png(bucket)
    print("  ok   a bucket-sized PNG passes the check")
except nai.NaiError as e:
    check("a bucket-sized PNG passes the check", False, str(e))
try:
    nai.check_charref_png(wrong, "x.png")
    check("an off-bucket PNG is refused with the buckets named", False)
except nai.NaiError as e:
    check("an off-bucket PNG is refused with the buckets named",
          "1024x1536" in str(e) and "x.png" in str(e), str(e))

p = nai.build_parameters("1girl", "blurry", {}, None,
                         [{"image": "AAAA", "description": "red hair", "strength": 0.6}])
check("the director request shape is 7d verbatim",
      p["director_reference_images"] == ["AAAA"]
      and p["director_reference_descriptions"][0]["caption"]["base_caption"] == "red hair"
      and p["director_reference_information_extracted"] == [1.0]
      and p["director_reference_strength_values"] == [0.6],
      json.dumps({k: v for k, v in p.items() if "director" in k}, ensure_ascii=False)[:200])

est = studio.estimate({"charrefs": [{"path": "x"}]}, 3)
check("a charref batch names its certain cost", est["anlasCertain"] == 15
      and "5 Anlas" in est["note"], json.dumps(est, ensure_ascii=False)[:200])

print("\ntest_selection_slugs")
check("korean folders no longer share one slug",
      studio._slug("images/고르기") != studio._slug("images/버리기"),
      studio._slug("images/고르기"))

# The studio is a third screen, not a half. Adopting an image into the card is
# the studio's own verb, so it passes the gate there; everything else still
# belongs to its edit screen, and the refusal names where the user actually is.
print("\ntest_screen_gate")
from app.agent import screen_gate  # noqa: E402

check("adopt passes on the studio screen", screen_gate("studio", "host_asset_add") is None)
_r = screen_gate("studio", "card_edit")
check("a card edit from the studio is refused by name",
      _r is not None and "에셋 스튜디오" in _r, str(_r))
_r = screen_gate("chat", "host_asset_add")
check("adopt from the chat screen still needs the bot screen",
      _r is not None and "봇 편집" in _r, str(_r))
# The wire filter must not drop the third screen on the floor (it did once).
from app import session as _session  # noqa: E402

check("the session accepts the studio screen", "studio" in _session.SCREEN_MODES,
      str(_session.SCREEN_MODES))

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - the studio is a folder of the one space, and the SYSTEM wall holds")
