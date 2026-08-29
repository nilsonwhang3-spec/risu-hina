"""The asset studio's storage: a second file scope, and the wall between them.

`files.py` used to serve exactly one root, a bot's workspace. The studio added
a second — global, bot-independent, and optionally on another drive — by making
the root a parameter rather than by growing a second file API. That is a good
trade only if the wall between the two scopes holds, so this is mostly a test
about paths that must not resolve:

    python tests/test_studio.py
"""
from __future__ import annotations

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
    except files.FileError:
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
studio = workspace.ensure_studio()
check("studio defaults under the data dir", studio == config.DATA_DIR / "studio", str(studio))
check("studio is not inside any workspace", config.WORKSPACE_DIR not in studio.parents)
check("the areas were created", all((studio / a).is_dir() for a in files.STUDIO_AREAS),
      str(sorted(p.name for p in studio.iterdir())))
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
check("nested folders survive", (studio / "styles" / "테스트" / "note.md").is_file())

files.mkdir(files.STUDIO, "images/보관")
files.move(files.STUDIO, "styles/테스트/note.md", "images/보관/note.md")
check("move works inside the studio", (studio / "images" / "보관" / "note.md").is_file())
files.delete(files.STUDIO, "images/보관/note.md")
check("delete works inside the studio", not (studio / "images" / "보관" / "note.md").exists())

print("\ntest_clean_never_touches_the_library")
files.upload(files.STUDIO, "keep.md", text="x", into="images")
before = files.clean(files.STUDIO)
check("clean removes nothing in the studio", before["removed"] == 0, str(before))
check("and the file is still there", (studio / "images" / "keep.md").is_file())

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

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - the studio is a second scope and the wall between them holds")
