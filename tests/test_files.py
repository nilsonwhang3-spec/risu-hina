"""The global file space: one root for every bot, and the rules over it.

SPACE is the scope every bot shares (projects/ the user manages, studio/ the
library, hina/<bot>/ the agent's work). These tests pin the parts that carry
policy: where uploads land, what 정리 may touch (per bot, never the space),
and that the two search functions count everything they did not show -
docs/07 §3-3: a clipped listing that does not say so is a wrong answer.

    python tests/test_files.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-files-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
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


def raises(name: str, fn, *args, **kw) -> None:
    try:
        fn(*args, **kw)
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

CK = store.upsert_character("cha-files-test", "파일 봇", {"name": "파일 봇"}, 0)
workspace.root(CK).mkdir(parents=True, exist_ok=True)

print("test_space_scope")
space = workspace.ensure_space()
check("the space root is under data/ by default", space == config.DATA_DIR / "space", str(space))
for area in ("projects", "studio", "hina", ".hina"):
    check(f"{area}/ exists", (space / area).is_dir())

up = files.upload(files.SPACE, "참고.md", text="# 자료", into="")
check("an upload lands in projects/ by default", up["path"].startswith("projects/"), up["path"])
up2 = files.upload(files.SPACE, "조각.md", text="x", into="studio/fragments")
check("an explicit studio folder is honoured (and canonicalised)",
      up2["path"] == "studio/config/fragments/조각.md", up2["path"])
raises("the machine area refuses uploads", files.upload, files.SPACE, "x.md", text="x", into=".hina")
raises("escapes are refused on the resolved path", files._resolve, files.SPACE, "../risuhina.db")
raises("a space path cannot climb into a bot workspace",
       files._resolve, files.SPACE, "../workspace/" + CK + "/card.md")

print("\ntest_bot_folder")
f1 = workspace.bot_folder(CK)
check("the folder is the bot's own name", f1 == "파일 봇", f1)
check("and it is pinned across calls", workspace.bot_folder(CK) == f1)
CK2 = store.upsert_character("cha-files-test-2", "파일 봇", {"name": "파일 봇"}, 1)
f2 = workspace.bot_folder(CK2)
check("a name collision takes ~2, not a merge", f2 == "파일 봇~2", f2)
CK3 = store.upsert_character("cha-files-test-3", 'A\\/:*?"<>|B', {"name": "x"}, 2)
f3 = workspace.bot_folder(CK3)
check("forbidden filename characters are stripped", f3 == "AB", f3)
hd = workspace.hina_dir(CK)
check("hina_dir creates the two internal work areas",
      all((hd / s).is_dir() for s in ("scripts", "scratch")) and not (hd / "out").exists(), str(hd))
od = workspace.out_dir(CK)
check("deliverables live in the bot's project folder (out_v3)",
      od == workspace.space_root() / "projects" / f1 / "out" and od.is_dir(), str(od))
check("write_out says the space-relative path",
      workspace.write_out(CK, "out/보고.md", "x") == f"projects/{f1}/out/보고.md"
      and (od / "보고.md").read_text(encoding="utf-8") == "x")

print("\ntest_clean_bot")
(hd / "scratch" / "임시.txt").write_text("x", encoding="utf-8")
(hd / "scripts" / "일.py").write_text("pass", encoding="utf-8")
(od / "산출.md").write_text("keep", encoding="utf-8")
sysdir = workspace.root(CK) / ".scratch"
sysdir.mkdir(parents=True, exist_ok=True)
(sysdir / "scope.db").write_bytes(b"x")
r = files.clean_bot(CK)
check("default clean sweeps scratch and scripts", not (hd / "scratch" / "임시.txt").exists()
      and not (hd / "scripts" / "일.py").exists(), str(r))
check("out/ survives a default clean", (od / "산출.md").exists())
check("the SYSTEM .scratch went with it", not (sysdir / "scope.db").exists())
r = files.clean_bot(CK, ["out"])
check("out/ is swept only on request", not (od / "산출.md").exists(), str(r))

print("\ntest_migrate_out_v3")
legacy = workspace.space_root() / "hina" / f1 / "out"
legacy.mkdir(parents=True, exist_ok=True)
(legacy / "옛산출.md").write_text("old", encoding="utf-8")
(od / "옛산출.md").write_text("new", encoding="utf-8")
db.execute("DELETE FROM meta WHERE key = ?", ("mig_out_v3",))
r = workspace.migrate_out_v3()
check("hina/<bot>/out moved into projects/<bot>/out", r is not None and r["moves"] == 1, str(r))
check("a taken name shifts instead of overwriting",
      (od / "옛산출.md").read_text(encoding="utf-8") == "new" and (od / "옛산출~1.md").exists(),
      str(sorted(p.name for p in od.iterdir())))
check("the emptied legacy folder is gone", not legacy.exists())
check("it runs once", workspace.migrate_out_v3() is None)

print("\ntest_search_names")
base = space / "projects" / "파일 봇"
(base / "메모").mkdir(parents=True, exist_ok=True)
for i in range(7):
    (base / "메모" / f"노트-{i}.md").write_text(f"내용 {i}", encoding="utf-8")
(space / ".hina").mkdir(exist_ok=True)
(space / ".hina" / "숨은노트.md").write_text("기계", encoding="utf-8")
r = files.search_names(files.SPACE, "노트-*.md")
check("a name glob finds the files", r["total"] == 7, str(r["total"]))
check("dot-areas are excluded", all(".hina" not in f["path"] for f in r["files"]))
r = files.search_names(files.SPACE, "노트-*.md", limit=3)
check("the limit clips rows but not the count", r["total"] == 7 and len(r["files"]) == 3,
      f"total={r['total']} shown={len(r['files'])}")
r = files.search_names(files.SPACE, "projects/*/메모/*.md")
check("a slashed pattern matches the whole path", r["total"] == 7, str(r["total"]))

print("\ntest_listing_prefix")
(space / "studio" / "output" / "셋").mkdir(parents=True, exist_ok=True)
(space / "studio" / "output" / "셋" / "한장.png").write_bytes(b"\x89PNG\r\n\x1a\npad")
(space / "studio" / "config" / "styles").mkdir(parents=True, exist_ok=True)
(space / "studio" / "config" / "styles" / "무관.md").write_text("x", encoding="utf-8")
full = files.listing(files.SPACE)
# The flat-era prefix still slices the moved tree (studio_canon at the door).
sliced = files.listing(files.SPACE, "studio/images")
check("a prefix keeps only its area", [a["area"] for a in sliced["areas"]] == ["studio"],
      str([a["area"] for a in sliced["areas"]]))
sfiles = sliced["areas"][0]["files"]
check("and only the subtree's files, root-relative paths intact",
      all(f["path"].startswith("studio/output/") for f in sfiles)
      and any(f["path"] == "studio/output/셋/한장.png" for f in sfiles), str(sfiles)[:200])
check("the style file is out of the slice",
      not any("styles" in f["path"] for f in sfiles))
check("the unfiltered listing still carries everything",
      any(a["area"] == "projects" for a in full["areas"]))
check("subtree dirs stay root-relative",
      "studio/output/셋" in sliced["areas"][0]["dirs"], str(sliced["areas"][0]["dirs"])[:160])

print("\ntest_listing_hidden")
# Machinery is default-hidden from the tree (usability batch item 1): any dot
# component (leaf included), hina/<bot>/skills/**, and the three regenerated
# helper scripts. hidden=1 reveals everything; sizes stay disk-truth.
(space / "studio" / "config" / ".studio" / "selection").mkdir(parents=True, exist_ok=True)
(space / "studio" / "config" / ".studio" / "selection" / "숨김.json").write_text("{}", encoding="utf-8")
(space / "hina" / "봇A" / "skills" / "스킬").mkdir(parents=True, exist_ok=True)
(space / "hina" / "봇A" / "skills" / "스킬" / "SKILL.md").write_text("x", encoding="utf-8")
(space / "hina" / "봇A" / "scripts").mkdir(parents=True, exist_ok=True)
(space / "hina" / "봇A" / "scripts" / "risuhina.py").write_text("x", encoding="utf-8")
(space / "hina" / "봇A" / "scripts" / "내가쓴.py").write_text("x", encoding="utf-8")
vis = files.listing(files.SPACE)
vpaths = [f["path"] for a in vis["areas"] for f in a["files"]]
check("dot components are hidden by default",
      not any(".studio" in q for q in vpaths), str([q for q in vpaths if ".studio" in q]))
check("skills and helper scripts hide, user scripts stay",
      not any("/skills/" in q for q in vpaths)
      and not any(q.endswith("scripts/risuhina.py") for q in vpaths)
      and any(q.endswith("scripts/내가쓴.py") for q in vpaths),
      str([q for q in vpaths if "봇A" in q]))
check("the held-back files are counted per area",
      sum(a.get("hidden", 0) for a in vis["areas"]) >= 3,
      str([(a["area"], a.get("hidden")) for a in vis["areas"]]))
check(".studio dirs are out of the folder list",
      not any(".studio" in dd for a in vis["areas"] for dd in a.get("dirs", [])))
allv = files.listing(files.SPACE, include_hidden=True)
apaths = [f["path"] for a in allv["areas"] for f in a["files"]]
check("include_hidden reveals them",
      any(".studio" in q for q in apaths) and any("/skills/" in q for q in apaths))
check("sizes count the hidden bytes either way",
      vis["totalSize"] == allv["totalSize"], f"{vis['totalSize']} vs {allv['totalSize']}")

print("\ntest_batch_verbs")
# One round trip for N paths; a per-item failure lands in `failed` and the
# batch continues (move's name-clash refusal must not abort the rest).
bsrc = space / "projects" / "배치테스트"
bsrc.mkdir(parents=True, exist_ok=True)
for n in ("갑.txt", "을.txt", "병.txt"):
    (bsrc / n).write_text(n, encoding="utf-8")
bdst = space / "projects" / "배치목적지"
bdst.mkdir(parents=True, exist_ok=True)
(bdst / "을.txt").write_text("자리 차지", encoding="utf-8")
r = files.move_many(files.SPACE, ["projects/배치테스트/갑.txt", "projects/배치테스트/을.txt",
                                  "projects/배치테스트/병.txt"], "projects/배치목적지")
check("a clash is reported, the rest still move",
      r["done"] == 2 and len(r["failed"]) == 1 and r["failed"][0]["path"].endswith("을.txt"),
      str(r))
check("the moved files landed", (bdst / "갑.txt").is_file() and (bdst / "병.txt").is_file())
r = files.copy_many(files.SPACE, ["projects/배치목적지/갑.txt"], "projects/배치목적지")
check("a batched copy dedupes like the single verb",
      r["done"] == 1 and r["results"][0]["to"].endswith("갑 (2).txt"), str(r))
r = files.delete_many(files.SPACE, ["projects/배치목적지/갑 (2).txt", "projects/없는파일.txt"])
check("delete reports the missing one and removes the real one",
      r["done"] == 1 and len(r["failed"]) == 1 and not (bdst / "갑 (2).txt").exists(),
      str(r))

print("\ntest_copy")
r = files.copy(files.SPACE, "studio/output/셋/한장.png", "studio/output/셋")
check("a paste into the same folder counts up",
      r["to"] == "studio/output/셋/한장 (2).png"
      and (space / "studio" / "output" / "셋" / "한장 (2).png").is_file(), str(r))
r2 = files.copy(files.SPACE, "studio/output/셋", "projects")
check("a folder copies whole", r2["to"] == "projects/셋"
      and (space / "projects" / "셋" / "한장.png").is_file(), str(r2))
raises("a folder cannot be copied into itself",
       files.copy, files.SPACE, "studio/output/셋", "studio/output/셋")
raises("the machine area refuses copies",
       files.copy, files.SPACE, "studio/output/셋/한장.png", ".hina")

print("\ntest_search_content")
(base / "긴자료.md").write_text("\n".join(f"줄 {i}: 미도리" for i in range(9)), encoding="utf-8")
(base / "다른.md").write_text("여기도 미도리 한 번", encoding="utf-8")
big = base / "너무큼.md"
big.write_text("미도리" + "x" * (files.MAX_SEARCH_FILE + 10), encoding="utf-8")
r = files.search_content(files.SPACE, "미도리")
check("hits carry path and line", any(h["path"].endswith("다른.md") and h["line"] == 1 for h in r["hits"]),
      str(r["hits"][:2]))
check("a file yields at most 5 rows", sum(1 for h in r["hits"] if h["path"].endswith("긴자료.md")) == 5)
check("but every hit is counted", r["totalHits"] == 10, str(r["totalHits"]))
check("the oversized file is a counted skip, not a silence", r["skipped"] == 1, str(r["skipped"]))
r = files.search_content(files.SPACE, "미도리", glob="*다른*")
check("a glob narrows the scan", r["scanned"] == 1 and r["totalHits"] == 1,
      f"scanned={r['scanned']} hits={r['totalHits']}")
raises("an empty needle is refused", files.search_content, files.SPACE, "  ")

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - one space, per-bot cleanup, and searches that state their cuts")
