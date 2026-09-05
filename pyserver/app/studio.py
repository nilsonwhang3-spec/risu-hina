"""The asset studio's domain: prompts in, named images out.

Storage is the `studio/` folder of the ONE global space (`files.py`, scope
SPACE); NovelAI is `nai.py` (written from `docs/09`). What is left is the part
in between, and it is mostly about **names**:

    config/styles/      a style, as front matter + ## positive / ## negative
    config/characters/  a character: prompt, negative, reference image, position
    config/fragments/   named pieces, spliced in by `<조각>`, `<폴더/조각>` or `<컬렉션.키>`
    config/scenes/      the reference tool scene presets, read verbatim. One scene is one image in
                 a batch and carries its own prompt, negative and size. **This
                 is how expression sheets are made** - an ordinary generation
                 per scene with the character and seed held fixed - not with
                 the `emotion` director tool, which costs ten times as much and
                 infers the emotion from a finished image rather than stating
                 it. Generation parameters (model, steps, CFG) are not in here:
                 they are the run, not the scene, and live on the panel.
    config/.studio/     our machinery (selection files, vibe cache, adhoc specs)
    output/      the results (was images/; the material and the results were
                 one flat level, which is what the config/output split fixes)

A generated file's name is what the comparison selector later parses back into
character and emotion, so the naming template and that parser are one decision,
not two. The default template is a starting point: **names are not
deterministic in practice**, which is exactly why the selector parses with a
regex and why Hina has to be able to rename in bulk.
"""
from __future__ import annotations

import base64
import hashlib
import json
import random
import re
import shutil
import time
import zlib
from pathlib import Path
from typing import Any

from . import files, log, nai, workspace

# The studio lives inside the ONE global space, as its studio/ folder. Wire
# paths are space-rooted ("studio/images/…"); the studio's own scope is gone.
SCOPE = files.SPACE

# The library's areas (subfolders of studio/), in panel order.
AREAS = ("styles", "characters", "fragments", "scenes", "images")

# The prefix every studio path carries in the space.
BASE = "studio"


def _rel(rel: str) -> str:
    """A studio path in its space-rooted, two-tier form.

    The studio used to be its own root, so bare area paths ("images/고르기")
    still arrive from old sidecars and Hina's habits; they gain the studio/
    prefix, and `workspace.studio_canon` folds the flat-era layout into
    config/ + output/. Anything else (projects/…, hina/…) passes through
    untouched - a generated image may legitimately land outside the library.
    """
    r = (rel or "").replace("\\", "/").strip("/")
    head = r.split("/", 1)[0]
    if head in AREAS or head == ".studio":
        r = f"{BASE}/{r}"
    if r == BASE or r.startswith(BASE + "/"):
        return workspace.studio_canon(r)
    return r


def _unstudio(rel: str) -> str:
    """The flat-era library-relative form - the slug key, so selection files
    written before the config/output split (and before the space) resolve."""
    r = _rel(rel)
    if r.startswith(BASE + "/"):
        r = r[len(BASE) + 1:]
    if r == "output" or r.startswith("output/"):
        r = "images" + r[len("output"):]
    elif r.startswith("config/"):
        r = r[len("config/"):]
    return r


def config_dir(area: str) -> Path:
    """One material area's directory (config/<area>)."""
    return root() / "config" / area

# `skills.py` already parses this shape; the studio reuses it rather than
# inventing a second front-matter dialect.
FRONT = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)
SECTION = re.compile(r"^##+\s*(positive|negative|프롬프트|네거티브)\s*$", re.I | re.M)

DEFAULT_TEMPLATE = "{character}-{emotion}-{stamp}-{n}"

# What the selector parses back out of a default-named file. The template
# drops empty fields (no more 무제-무제 padding), so the token count varies:
# the stamp anchors the parse and what precedes it is [character-][emotion-].
# Kept beside the template on purpose: the two have to agree, and a reader
# who changes one must see the other. A caller-supplied regex still wins.
STAMP_RE = re.compile(r"\d{8}-\d{6}")
DEFAULT_PARSE_NOTE = "[캐릭터-][감정-]날짜-시각-번호 (기본 규칙)"


class StudioError(ValueError):
    pass


def root() -> Path:
    return workspace.ensure_studio()


# --- reading the library ------------------------------------------------------

def _front_matter(text: str) -> tuple[dict, str]:
    """Front matter as a flat dict, plus the body. Same shape as SKILL.md."""
    m = FRONT.match(text)
    if not m:
        return {}, text
    meta: dict[str, Any] = {}
    for line in m.group(1).splitlines():
        key, _, value = line.partition(":")
        if not _:
            continue
        v = value.strip().strip('"').strip("'")
        meta[key.strip()] = v
    return meta, text[m.end():]


def _bool(meta: dict, key: str, default: bool = False) -> bool:
    v = str(meta.get(key, "")).strip().lower()
    if not v:
        return default
    return v in ("true", "1", "yes", "on")


def _order(meta: dict, default: int = 100) -> int:
    try:
        return int(str(meta.get("order", "")).strip())
    except (TypeError, ValueError):
        return default


def read_style(rel: str) -> dict:
    """A style file: front matter, then `## positive` / `## negative`.

    A style with no headings at all is treated as one positive block - a person
    pasting a prompt into a new file should get something that works, not a
    parse error about a heading they have never seen.
    """
    text = _read_text(rel)
    meta, body = _front_matter(text)
    parts = SECTION.split(body)
    positive, negative = "", ""
    if len(parts) == 1:
        positive = body.strip()
    else:
        it = iter(parts[1:])
        head = parts[0].strip()
        if head:
            positive = head
        for name, chunk in zip(it, it):
            if name.lower() in ("negative", "네거티브"):
                negative = chunk.strip()
            else:
                positive = (positive + ", " + chunk.strip()).strip(", ") if positive else chunk.strip()
    return {"path": rel, "name": meta.get("name") or Path(rel).stem,
            "description": meta.get("description", ""),
            # The card's own switch, lorebook-style. Absent means OFF: before
            # the cards, a style was picked explicitly per run, and an upgrade
            # that silently concatenated every existing file would change what
            # gets sent without anyone choosing it.
            "enabled": _bool(meta, "enabled"),
            "order": _order(meta),
            "positive": positive, "negative": negative}


def read_json(rel: str) -> dict:
    try:
        return json.loads(_read_text(rel))
    except ValueError as e:
        raise StudioError(f"{rel} 을 읽지 못했습니다 (JSON 아님): {e}") from e


def _read_text(rel: str) -> str:
    p = files._resolve(SCOPE, _rel(rel))
    if not p.is_file():
        raise StudioError(f"파일이 없습니다: {rel}")
    return p.read_text(encoding="utf-8", errors="replace")


def read_bytes(rel: str) -> bytes:
    p = files._resolve(SCOPE, _rel(rel))
    if not p.is_file():
        raise StudioError(f"파일이 없습니다: {rel}")
    return p.read_bytes()


# --- cards: the lorebook model over prompt files -------------------------------
#
# A style or a character is a CARD: it carries its own on/off (`enabled`) and
# its own place in the concatenation (`order`) in its front matter, the way a
# lorebook entry carries alwaysActive and insertorder. The file is the card -
# a .studio map would dangle the moment a file is renamed by hand.

META_KEYS = ("enabled", "order", "name", "description")


def _card_md(rel: str) -> str:
    """The .md that carries a card's front matter: the file itself, or the
    folder character's prompt.md."""
    r = _rel(rel)
    p = files._resolve(SCOPE, r)
    if p.is_dir():
        return r + "/prompt.md"
    return r


def set_meta(rel: str, changes: dict) -> dict:
    """Rewrite a card's front matter, byte-preserving the body.

    One writer for the toggle and the editor both: a panel doing its own
    read-modify-write of the whole file would race a concurrent edit.
    """
    md = _card_md(rel)
    p = files._resolve(SCOPE, md)
    if not p.is_file():
        raise StudioError(f"파일이 없습니다: {md}")
    text = p.read_text(encoding="utf-8", errors="replace")
    meta, body = _front_matter(text)
    for k, v in (changes or {}).items():
        if k not in META_KEYS:
            raise StudioError(f"front matter 로 바꿀 수 없는 키입니다: {k}")
        if v is None or v == "":
            meta.pop(k, None)
        elif k == "enabled":
            meta[k] = "true" if v in (True, "true", "True", 1, "1") else "false"
        elif k == "order":
            try:
                meta[k] = str(int(v))
            except (TypeError, ValueError) as e:
                raise StudioError(f"order 는 정수여야 합니다: {v!r}") from e
        else:
            meta[k] = str(v)
    fm = "---\n" + "".join(f"{k}: {v}\n" for k, v in meta.items()) + "---\n"
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(fm + body)
    return {"path": md, "enabled": _bool(meta, "enabled"), "order": _order(meta),
            "name": meta.get("name", ""), "description": meta.get("description", "")}


def read_character(rel: str) -> dict:
    """A character card.

    The folder form is the card: `characters/<이름>/` holding `prompt.md`
    (front matter + ## 프롬프트 / ## 네거티브) and `preset.json` (position and
    the reference lists). The legacy stem-pair `.json` is still read so old
    specs and sidecars keep resolving; `migrate_characters` folds them away.
    """
    r = _rel(rel)
    p = files._resolve(SCOPE, r)
    if p.is_dir() or not r.lower().endswith(".json"):
        base = r
        s = read_style(base + "/prompt.md")
        preset: dict = {}
        try:
            preset = read_json(base + "/preset.json")
        except StudioError:
            pass
        vibe = [v for v in (preset.get("vibe") or [])
                if isinstance(v, dict) and v.get("enabled", True)]
        charref = [v for v in (preset.get("charref") or [])
                   if isinstance(v, dict) and v.get("enabled", True)]
        # 바이브와 캐릭터 레퍼런스는 함께 실리지 않는다: refMode 가 고르고,
        # 반대쪽 목록은 비워서 돌려준다. 명시가 없는 옛 preset 은 "차 있는
        # 쪽" - 바이브만 있던 카드가 업그레이드로 조용히 꺼지면 안 된다.
        mode = str(preset.get("refMode") or "").strip()
        if mode not in ("charref", "vibe"):
            mode = "vibe" if (vibe and not charref) else "charref"
        if mode == "vibe":
            charref = []
        else:
            vibe = []
        return {
            "path": base,
            "name": s["name"] if s["name"] != "prompt" else Path(base).name,
            "caption": s["positive"], "negative": s["negative"],
            "enabled": s["enabled"], "order": s["order"],
            "description": s["description"],
            "position": preset.get("position"),
            "refMode": mode,
            "vibe": vibe,
            "charref": charref,
        }
    d = read_json(r)
    return {
        "path": r, "name": str(d.get("name") or Path(r).stem),
        "caption": str(d.get("caption") or d.get("prompt") or ""),
        "negative": str(d.get("negative") or ""),
        "enabled": bool(d.get("enabled")), "order": int(d.get("order") or 100),
        "description": str(d.get("description") or ""),
        "position": d.get("position"), "refMode": "charref", "vibe": [], "charref": [],
    }


def migrate_characters() -> int:
    """Legacy stem-pair characters become folder cards, once each.

    Idempotent: a folder that already exists is left alone (with a log line),
    and nothing is deleted until its replacement is written. The vibe cache
    keys by content hash, so moving the png invalidates nothing.
    """
    base = config_dir("characters")
    if not base.is_dir():
        return 0
    moved = 0
    for p in sorted(base.glob("*.json")):
        try:
            d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except ValueError:
            continue
        if not isinstance(d, dict) or ("caption" not in d and "prompt" not in d):
            continue
        folder = base / p.stem
        if folder.exists():
            log.warn("studio: %s already has a folder card; the legacy file is left as is", p.stem)
            continue
        folder.mkdir()
        name = str(d.get("name") or p.stem)
        body = str(d.get("caption") or d.get("prompt") or "")
        neg = str(d.get("negative") or "")
        text = f"---\nname: {name}\n---\n## 프롬프트\n{body}\n"
        if neg:
            text += f"\n## 네거티브\n{neg}\n"
        (folder / "prompt.md").write_text(text, encoding="utf-8")
        vibe = []
        png = p.with_suffix(".png")
        if png.is_file():
            png.rename(folder / png.name)
            vibe = [{"file": png.name, "strength": 0.6, "informationExtracted": 1.0, "enabled": True}]
        (folder / "preset.json").write_text(json.dumps(
            {"version": 1, "position": d.get("position"), "vibe": vibe, "charref": []},
            ensure_ascii=False, indent=2), encoding="utf-8")
        p.unlink()
        moved += 1
        log.info("studio: character %s migrated to a folder card", p.stem)
    return moved


def active(area: str) -> list[str]:
    """The enabled cards' paths, in (order, path) order - what a run uses
    when the spec does not choose explicitly."""
    rows = [(i.get("order", 100), i["path"]) for i in listing(area) if i.get("enabled")]
    return [path for _o, path in sorted(rows)]


_MIGRATED_ONCE = False


def _character_listing() -> list[dict]:
    # The legacy sweep is idempotent but not free (it opens every loose .json
    # under characters/), and it used to run on EVERY listing call - toggling
    # one checkbox re-ran it five times. Once per process is what "migration"
    # means; a legacy file dropped in later is picked up on the next restart.
    global _MIGRATED_ONCE
    if not _MIGRATED_ONCE:
        migrate_characters()
        _MIGRATED_ONCE = True
    base = config_dir("characters")
    out: list[dict] = []
    if not base.is_dir():
        return out
    sproot = files._root(SCOPE)

    # A card is a directory with a prompt.md; anything else that is a
    # directory is a GROUPING folder and is walked into, so characters can be
    # sorted into studio/characters/<폴더>/<카드>. `folder` is the grouping
    # path ('' at the top), which is what the panel groups the list by.
    def walk(d, folder: str) -> None:
        for p in sorted(d.iterdir()):
            if p.name.startswith(".") or not p.is_dir():
                continue  # loose files (a stray png, an unmigratable json) are not cards
            rel = p.relative_to(sproot).as_posix()
            if not (p / "prompt.md").is_file():
                walk(p, (folder + "/" + p.name).lstrip("/"))
                continue
            try:
                c = read_character(rel)
            except StudioError:
                continue
            out.append({
                "path": rel, "name": c["name"], "folder": folder,
                "description": c["description"],
                "enabled": c["enabled"], "order": c["order"],
                "vibe": len(c["vibe"]), "charref": len(c["charref"]),
                "position": c["position"],
            })

    walk(base, "")
    return out


def listing(area: str) -> list[dict]:
    """Everything in one area, with just enough of each to choose by."""
    if area == "characters":
        return _character_listing()
    out = []
    base = root() / "output" if area == "images" else config_dir(area)
    if not base.is_dir():
        return out
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(files._root(SCOPE)).as_posix()
        item = {"path": rel, "name": p.stem, "folder": p.parent.relative_to(base).as_posix()}
        if p.suffix.lower() == ".md" and area == "styles":
            try:
                s = read_style(rel)
                item.update(name=s["name"], description=s["description"],
                            enabled=s["enabled"], order=s["order"])
            except StudioError:
                pass
        elif p.suffix.lower() == ".md" and area == "fragments":
            # A fragment row shows its front-matter name like every other card;
            # the resolver accepts that name too (see FragmentTable).
            try:
                meta, _body = _front_matter(_read_text(rel))
                if str(meta.get("name") or "").strip():
                    item["name"] = str(meta["name"]).strip()
            except StudioError:
                pass
        elif p.suffix.lower() == ".json":
            try:
                d = read_json(rel)
                item["name"] = str(d.get("name") or p.stem)
                if area == "scenes":
                    item["count"] = len(d.get("scenes") or [])
            except StudioError:
                pass
        out.append(item)
    return out


# --- fragments and scenes ------------------------------------------------------
#
# A scene file is the reference tool's, read verbatim rather than converted:
#
#     {"version": 1, "scenes": [
#        {"name": "angry", "prompt": "<조각프롬>, angry, frown",
#         "negativePrompt": "", "width": 832, "height": 1216}]}
#
# (An invented example. Scene files are the user's own material and none of
#  anyone's ships with this code.)
#
# Two things in those prompts are not ours and must survive untouched:
#
#   {{…}}   NovelAI's own emphasis. It goes to NovelAI exactly as written; this
#           file never parses or rewrites it.
#   <…>     a fragment reference. Resolved here - see FragmentTable.

REF = re.compile(r"<([^<>]+)>")


class FragmentTable:
    """What `<…>` can name.

    Three forms, and a whole file wins over a key inside one:

        <조각>            fragments/조각.md   (or .json) - the whole file,
                          or a card whose front-matter `name` is 조각
        <폴더/조각>       fragments/폴더/조각.md
        <컬렉션.키>       one entry of fragments/컬렉션.json

    File-first is what makes the ordering predictable: `<a.b>` is a file called
    `a.b` if there is one, and only otherwise the `b` entry of collection `a`.
    Without that rule a new file could silently shadow a key, or the reverse,
    depending on which lookup happened to run first. A front-matter name is the
    weakest key of all (setdefault after path and stem) for the same reason.
    """

    def __init__(self) -> None:
        self.files: dict[str, str] = {}          # "폴더/조각" -> text
        self.collections: dict[str, dict[str, str]] = {}

    def get(self, name: str) -> str | None:
        name = name.strip().strip("/")
        hit = self.files.get(name)
        if hit is not None:
            return hit
        if "." in name:
            coll, _, key = name.rpartition(".")
            entry = (self.collections.get(coll.strip()) or {}).get(key.strip())
            if entry is not None:
                return entry
        return None


def fragments() -> FragmentTable:
    """Everything under `fragments/`, as both whole files and collections.

    A `.md` is a whole fragment. A `.json` is both: the file as a whole (its
    values joined, so `<컬렉션>` means "all of it") and each key on its own.
    """
    table = FragmentTable()
    base = config_dir("fragments")
    if not base.is_dir():
        return table
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(files._root(SCOPE)).as_posix()
        # The name a reference uses: path under fragments/, without extension.
        key = p.relative_to(base).as_posix()
        key = key[: -len(p.suffix)] if p.suffix else key
        try:
            if p.suffix.lower() == ".json":
                d = read_json(rel)
                flat = {str(k): str(v) for k, v in d.items() if not isinstance(v, (dict, list))}
                table.collections[key] = flat
                # Also addressable by its bare name (the stem) when it is in a
                # folder, so `<조각>` works wherever the file happens to live.
                table.collections.setdefault(p.stem, flat)
                table.files[key] = ", ".join(v for v in flat.values() if v)
            elif p.suffix.lower() == ".md":
                meta, body = _front_matter(_read_text(rel))
                body = body.strip()
                table.files[key] = body
                table.files.setdefault(p.stem, body)
                # The card's front-matter name is addressable too, so renaming
                # a card in the editor does not orphan `<이름>` references.
                # setdefault: a real path/stem always wins over a display name.
                fm_name = str(meta.get("name") or "").strip().strip("/")
                if fm_name:
                    table.files.setdefault(fm_name, body)
        except StudioError:
            continue
    return table


def _fragment_lines(text: str) -> list[str]:
    """The substitution candidates of one fragment body (the reference tool's
    contentToLines, adopted): lines trimmed, blank lines and `#` comment
    lines out. A multi-line fragment is a RANDOM POOL - one line per image -
    not a block."""
    return [ln.strip() for ln in text.split("\n")
            if ln.strip() and not ln.strip().startswith("#")]


# A fragment line may itself reference fragments; recursion is depth-guarded
# so a self-referencing pool cannot loop forever (the reference tool's guard, same value).
MAX_REF_DEPTH = 10


def resolve_refs(text: str, table: FragmentTable | None = None,
                 rng=None) -> tuple[str, list[str]]:
    """Splice fragment references in. Returns (text, unresolved references).

    An unknown reference is **left in the text and reported**, never dropped:
    a prompt silently missing its eye description would generate happily and
    wrongly, and the caller could not tell. Same rule as the selector's
    unreadable filenames.

    A fragment whose body has several lines contributes **one line, picked at
    random per call** - plan() resolves per image, so every image of a batch
    rolls its own (the the reference tool wildcard semantic the fragments came from).
    Comment (`#`) and blank lines are never candidates, and the picked line's
    own `<참조>` are resolved recursively (depth-guarded).

    `{{…}}` is NovelAI's emphasis and is not a reference - the pattern only
    matches `<…>`, so emphasis passes through untouched. `rng` is a
    `random.random`-shaped hook for deterministic tests.
    """
    table = fragments() if table is None else table
    roll = rng or random.random
    missing: list[str] = []

    def expand(s: str, depth: int) -> str:
        def sub(m: re.Match[str]) -> str:
            hit = table.get(m.group(1))
            if hit is None:
                missing.append(m.group(0))
                return m.group(0)
            lines = _fragment_lines(hit)
            if not lines:
                return ""  # a body of comments alone contributes nothing
            picked = lines[int(roll() * len(lines)) % len(lines)] if len(lines) > 1 else lines[0]
            return expand(picked, depth + 1) if depth < MAX_REF_DEPTH else picked
        return REF.sub(sub, s)

    return expand(text, 0), missing


def read_scenes(rel: str) -> dict:
    """A scene preset file, in the reference tool's shape."""
    d = read_json(rel)
    raw = d.get("scenes")
    if not isinstance(raw, list):
        raise StudioError(f"{rel}: scenes[] 가 없습니다 (씬 프리셋 형식이어야 합니다)")
    scenes = []
    for s in raw:
        if not isinstance(s, dict) or not str(s.get("name") or "").strip():
            continue
        scenes.append({
            "name": str(s["name"]).strip(),
            "prompt": str(s.get("prompt") or ""),
            "negativePrompt": str(s.get("negativePrompt") or ""),
            "width": int(s.get("width") or 0) or None,
            "height": int(s.get("height") or 0) or None,
        })
    return {"path": rel, "version": d.get("version"), "name": d.get("name") or Path(rel).stem,
            "scenes": scenes}


# --- assembling one request ---------------------------------------------------

def _by_name(area: str, entry: str) -> str:
    """A card named without a path ("오피스 카운셀링") resolved to its path.

    Exact display-name match only; ambiguity is an error that names the
    candidates rather than a silent first-wins. Anything containing a slash
    is already a path and passes through untouched.
    """
    if "/" in entry:
        return entry
    hits = [i["path"] for i in listing(area) if i.get("name") == entry]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise StudioError(f"{area} 에 그런 이름의 카드가 없습니다: {entry}")
    raise StudioError(f"{area} 에 같은 이름이 여럿입니다: {entry} — 경로로 지정하세요: " + ", ".join(hits))


def normalize_spec(spec: dict) -> dict:
    """One spec shape for plan() and the job runner.

    `styles` is plural now (active styles concatenate in card order, like a
    lorebook); the legacy singular `style` folds in. Styles and characters
    left unstated default to the ACTIVE cards; an explicit empty list means
    "none" - the difference between not choosing and choosing nothing. An
    entry without a slash is a card NAME and is resolved against the listing,
    so 히나 can say "오피스 카운셀링" instead of hunting for the path first.
    """
    out = dict(spec)
    if "styles" not in out:
        out["styles"] = [out["style"]] if out.get("style") else active("styles")
    elif out.get("style"):
        out["styles"] = list(out["styles"] or []) + [out["style"]]
    out.pop("style", None)
    if "characters" not in out:
        out["characters"] = active("characters")
    out["styles"] = [_by_name("styles", s) if isinstance(s, str) else s
                     for s in (out.get("styles") or [])]
    out["characters"] = [_by_name("characters", c) if isinstance(c, str) else c
                         for c in (out.get("characters") or [])]
    if isinstance(out.get("scenePreset"), str) and out["scenePreset"]:
        out["scenePreset"] = _by_name("scenes", str(out["scenePreset"]))
    return out


def compose(spec: dict) -> tuple[str, str, list[dict]]:
    """(positive, negative, char_captions) for one image.

    Order is styles (in card order), then characters, then fragments, then
    the emotion - the emotion last because it is the thing that varies across
    a batch and the thing a reader is looking for when they check what was
    sent.
    """
    spec = normalize_spec(spec)
    pos: list[str] = []
    neg: list[str] = []

    for style_rel in spec.get("styles") or []:
        s = read_style(str(style_rel))
        if s["positive"]:
            pos.append(s["positive"])
        if s["negative"]:
            neg.append(s["negative"])

    captions: list[dict] = []
    for ch in spec.get("characters") or []:
        c = ch if isinstance(ch, dict) else read_character(str(ch))
        caption = str(c.get("caption") or c.get("prompt") or "").strip()
        if not caption:
            continue
        entry: dict[str, Any] = {"char_caption": caption, "centers": []}
        p = c.get("position") or {}
        if isinstance(p, dict) and "x" in p and "y" in p:
            entry["centers"] = [{"x": float(p["x"]), "y": float(p["y"])}]
        captions.append(entry)
        # A single character also reads better in the base caption: with one
        # subject the coords machinery buys nothing.
        if len(spec.get("characters") or []) == 1:
            pos.append(caption)
        if c.get("negative"):
            neg.append(str(c["negative"]))

    for fr in spec.get("fragments") or []:
        text = _read_text(str(fr)) if isinstance(fr, str) and fr.endswith(".md") else str(fr)
        meta, body = _front_matter(text)
        if body.strip():
            pos.append(body.strip())

    if spec.get("emotion"):
        pos.append(str(spec["emotion"]))
    if spec.get("extra"):
        pos.append(str(spec["extra"]))
    if spec.get("negativeExtra"):
        neg.append(str(spec["negativeExtra"]))

    return (", ".join(x for x in pos if x),
            ", ".join(x for x in neg if x),
            captions if len(captions) > 1 else [])


# --- naming -------------------------------------------------------------------

_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_part(text: str) -> str:
    """One field of a filename. The delimiter is stripped too: a hyphen inside
    a character name would silently shift every field the parser reads. An
    empty field stays empty - build_name drops it rather than padding with a
    placeholder nobody typed."""
    return _UNSAFE.sub("", str(text or "")).replace("-", "_").strip()


def build_name(template: str, *, character: str = "", outfit: str = "",
               emotion: str = "", index: int = 0, stamp: str = "") -> str:
    # `outfit` stays accepted for custom templates that still say {outfit};
    # the default template no longer has the field.
    t = template or DEFAULT_TEMPLATE
    stamp = stamp or time.strftime("%Y%m%d-%H%M%S")
    name = (t.replace("{character}", safe_part(character))
             .replace("{outfit}", safe_part(outfit))
             .replace("{emotion}", safe_part(emotion))
             .replace("{stamp}", stamp)
             .replace("{n}", str(index + 1)))
    # Empty fields leave doubled delimiters behind; collapse them so a run
    # with no character name is 감정-날짜-… rather than -감정--….
    name = re.sub(r"-{2,}", "-", name).strip("-")
    return name + ".png"


def _parse_default(n: str) -> dict | None:
    """A default-templated name back into fields, anchored on the stamp.

    Legacy three-token names ({character}-{outfit}-{emotion}) still read
    correctly: the character is first and the emotion last either way, and no
    field can contain the delimiter (safe_part neutralises it)."""
    m = STAMP_RE.search(n)
    if not m:
        # No stamp (a custom template, renamed files): the shape the user's
        # own regex spelled out - `character-emotion-n.ext`, where the last
        # token is the copy number (§1-39). Two tokens = character-emotion.
        # This used to be an unmatched file, which put a whole folder into
        # 못 읽음 and one image per "group" in the selector.
        stem = re.sub(r"\.[A-Za-z0-9]+$", "", n)
        stem = re.sub(r" \(\d+\)$", "", stem)      # the never-overwrite suffix
        tokens = [t for t in stem.split("-") if t]
        if len(tokens) >= 3 and tokens[-1].isdigit():
            return {"character": tokens[0], "emotion": "-".join(tokens[1:-1]), "n": tokens[-1]}
        if len(tokens) == 2 and tokens[-1].isdigit():
            return {"emotion": tokens[0], "n": tokens[1]}       # emotion-n
        if len(tokens) == 2:
            return {"character": tokens[0], "emotion": tokens[1]}
        return None
    tokens = [t for t in n[:m.start()].split("-") if t]
    d: dict[str, str] = {}
    if len(tokens) == 1:
        d["emotion"] = tokens[0]
    elif len(tokens) >= 2:
        d["character"] = tokens[0]
        d["emotion"] = tokens[-1]
    return d


def parse_names(names: list[str], pattern: str = "") -> dict:
    """Split filenames into fields. Reports what did NOT match.

    The unmatched list is the point. Names are not deterministic - that is why
    this app exists - so the selector has to show what it could not read and
    hand it to Hina to rename, rather than quietly dropping those files.

    With no pattern the default token rule runs (see DEFAULT_TEMPLATE); a
    caller-supplied regex replaces it entirely.
    """
    rx = re.compile(pattern) if pattern else None
    matched: list[dict] = []
    unmatched: list[str] = []
    for n in names:
        if rx is not None:
            m = rx.search(n)
            d = None if not m else {k: v for k, v in (m.groupdict() or {}).items() if v is not None}
        else:
            d = _parse_default(n)
        if d is None:
            unmatched.append(n)
            continue
        d["filename"] = n
        matched.append(d)
    return {"matched": matched, "unmatched": unmatched,
            "pattern": pattern or DEFAULT_PARSE_NOTE,
            "fields": sorted({k for d in matched for k in d if k != "filename"})}


def naming_from_bot(char_key: str) -> dict:
    """What this bot actually calls its emotion assets.

    The convention differs per bot, so it is read rather than assumed: the
    manifest holds the names the card really uses. With none, the caller falls
    back to the default template. Hina turns this into a regex.
    """
    from . import db
    rows = db.query(
        "SELECT name FROM char_assets WHERE char_key = ? AND field = 'emotion' ORDER BY seq",
        (char_key,))
    names = [str(r["name"] or "") for r in rows if r["name"]]
    return {"charKey": char_key, "emotionNames": names,
            "hasConvention": bool(names),
            "template": DEFAULT_TEMPLATE if not names else "",
            "note": "이 봇의 감정 에셋 이름입니다. 이 이름들에 맞는 정규식과 이름 규칙을 정하세요."
                    if names else "이 봇에는 감정 에셋이 없습니다 — 기본 규칙을 씁니다."}


# --- writing a result ---------------------------------------------------------

PARAMS_KEYWORD = "hina-params"


def png_embed(png: bytes, payload: dict, keyword: str = PARAMS_KEYWORD) -> bytes:
    """One tEXt chunk right after IHDR, value = base64 of the payload JSON.

    tEXt is Latin-1 only, hence the base64 (the same trick the reference
    tool's params chunk uses). Anything that is not a PNG comes back unchanged: the image
    is the deliverable and the metadata is best-effort.
    """
    if png[:8] != b"\x89PNG\r\n\x1a\n" or len(png) < 33:
        return png
    # IHDR is required to be the first chunk; splice in right behind it.
    ihdr_end = 8 + 12 + int.from_bytes(png[8:12], "big")
    data = (keyword.encode("latin-1") + b"\x00"
            + base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")))
    chunk = len(data).to_bytes(4, "big") + b"tEXt" + data \
        + zlib.crc32(b"tEXt" + data).to_bytes(4, "big")
    return png[:ihdr_end] + chunk + png[ihdr_end:]


def save_image(folder: str, name: str, png: bytes, sidecar: dict) -> dict:
    """The PNG, carrying its own record.

    What we asked for and which library files it came from is embedded as a
    `hina-params` tEXt chunk - the PNG's own NovelAI `Comment` (docs/09 §5b)
    stays the truth about applied parameters; ours is the index. It used to be
    a .json sidecar beside every image, which doubled every folder; legacy
    sidecars are left alone (user decision) and nothing ever read them back.
    """
    # Anywhere in the space the user may write (3-4): studio/output is the
    # default, projects/<봇>/… is legitimate, the machine areas are not.
    folder = _rel((folder or "").strip("/")) or f"{BASE}/output"
    area = folder.split("/", 1)[0]
    if not files.areas_for(SCOPE).get(area, (False, False))[0]:
        raise StudioError(f"저장할 수 없는 영역입니다: {folder}")
    dest = files._resolve(SCOPE, folder) / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    # Never overwrite (§1-39): a template without {stamp}, or two batches in
    # the same second, produced the same name and the newer image silently
    # replaced the older. A taken name counts up: 이름 (2).png, (3)…
    if dest.exists():
        stem, suf, k = dest.stem, dest.suffix, 2
        while dest.exists():
            dest = dest.with_name(f"{stem} ({k}){suf}")
            k += 1
        name = dest.name
    body = png_embed(png, {**sidecar, "file": name, "createdAt": time.time()})
    dest.write_bytes(body)
    rel = dest.relative_to(files._root(SCOPE)).as_posix()
    log.info("studio image %s (%d bytes)", rel, len(body))
    return {"path": rel, "size": len(body)}


# --- one batch ----------------------------------------------------------------

def refs_for_characters(paths: list) -> tuple[list[dict], list[dict]]:
    """The reference images a set of character cards carries, resolved to
    library paths. What rides a generation follows the CARDS (each card's
    refMode and per-image enabled flags) - there is no separate switch."""
    vibes: list[dict] = []
    charrefs: list[dict] = []
    for ch in paths or []:
        try:
            c = read_character(str(ch)) if isinstance(ch, str) else ch
        except StudioError:
            continue
        if not c.get("path"):
            continue
        for v in c.get("vibe") or []:
            if not v.get("file"):
                continue
            vibes.append({"path": f"{c['path']}/{v.get('file')}",
                          "strength": float(v.get("strength", 0.6)),
                          "informationExtracted": float(v.get("informationExtracted", 1.0))})
        for cr in c.get("charref") or []:
            if not cr.get("file"):
                continue
            charrefs.append({"path": f"{c['path']}/{cr.get('file')}",
                             "mode": str(cr.get("mode") or "character"),
                             "strength": float(cr.get("strength", 0.6)),
                             "fidelity": float(cr.get("fidelity", 0.6))})
    return vibes, charrefs


def _entry_scene(entry: dict, spec: dict, cache: dict) -> dict:
    """One entry's scene: an inline object, or a name looked up in the
    entry's (or the spec's) scene preset. No scene at all is the plain
    one-shot composition."""
    sc = entry.get("scene")
    if isinstance(sc, dict):
        return {"name": str(sc.get("name") or ""), "prompt": str(sc.get("prompt") or ""),
                "negativePrompt": str(sc.get("negativePrompt") or ""),
                "width": sc.get("width") or None, "height": sc.get("height") or None}
    if not sc:
        return {"name": "", "prompt": "", "negativePrompt": "", "width": None, "height": None}
    preset = str(entry.get("scenePreset") or spec.get("scenePreset") or "")
    if not preset:
        raise StudioError(f"씬 이름만으로는 부족합니다 — scenePreset 이 필요합니다: {sc}")
    preset = _by_name("scenes", preset)
    if preset not in cache:
        cache[preset] = read_scenes(preset)["scenes"]
    for s in cache[preset]:
        if s["name"] == str(sc):
            return s
    raise StudioError(f"프리셋에 그런 씬이 없습니다: {preset} / {sc}")


def _plan_entries(spec: dict) -> list[dict]:
    """The v2 batch shape: an explicit LIST of (scene × characters × count)
    entries, accumulated as reservations in the panel and submitted as one
    job. Not a multiplication - each entry carries its own count and its own
    character combination, so 씬 A 4장 + 씬 B 1장 with different casts is one
    batch, consumed in order.
    """
    template = str(spec.get("template") or DEFAULT_TEMPLATE)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    table = fragments()
    scene_cache: dict[str, list[dict]] = {}
    # The {n} index counts per (character, emotion) so two entries that land
    # on the same name key keep distinct filenames within one stamp.
    counters: dict[tuple[str, str], int] = {}

    out: list[dict] = []
    for ix, entry in enumerate(spec.get("entries") or []):
        if not isinstance(entry, dict):
            raise StudioError(f"entries[{ix}] 는 객체여야 합니다")
        scene = _entry_scene(entry, spec, scene_cache)
        raw_chars = entry.get("characters")
        chars = ([_by_name("characters", c) if isinstance(c, str) else c for c in raw_chars]
                 if raw_chars is not None else list(spec.get("characters") or []))
        cast = str(entry.get("cast") or "")
        # The filename's {character}: the cast label, else the first card's
        # own name (the 캐릭터명 form is gone - cards name their output).
        character = cast
        if not character and chars:
            try:
                character = read_character(str(chars[0]))["name"]
            except StudioError:
                character = ""
        count = max(1, int(entry.get("count") or 1))
        seed = entry.get("seed", spec.get("seed"))
        for i in range(count):
            one = {**spec, "characters": chars,
                   "emotion": scene.get("prompt") or "",
                   "negativeExtra": scene.get("negativePrompt") or ""}
            pos, neg, captions = compose(one)
            pos, missing = resolve_refs(pos, table)
            neg, missing2 = resolve_refs(neg, table)
            key = (character, scene["name"])
            n = counters.get(key, 0)
            counters[key] = n + 1
            item: dict[str, Any] = {
                "name": build_name(template, character=character,
                                   emotion=scene["name"], index=n, stamp=stamp),
                "scene": scene["name"],
                "prompt": pos,
                "negative": neg,
                "charCaptions": captions,
                "characters": [c if isinstance(c, str) else str(c.get("path") or "") for c in chars],
                "cast": cast,
                "entryIx": ix,
                "seed": (int(seed) + i) if seed not in (None, "") else None,
            }
            if scene.get("width") and scene.get("height"):
                item["size"] = {"width": scene["width"], "height": scene["height"]}
            if missing or missing2:
                item["unresolved"] = sorted(set(missing + missing2))
            out.append(item)
    return out


def plan(spec: dict) -> list[dict]:
    """A batch, expanded into the images it will make.

    One entry per (emotion x count) - or, with `entries`, exactly the list
    the caller queued (see _plan_entries). Expanded before anything is sent
    so the caller can be told how many images and what they will be called
    before it spends anything.
    """
    spec = normalize_spec(spec)
    if spec.get("entries"):
        return _plan_entries(spec)
    scenes: list[dict] = []
    if spec.get("scenes"):
        picked = spec["scenes"]
        scenes = picked if isinstance(picked, list) and picked and isinstance(picked[0], dict) else []
    if not scenes and spec.get("scenePreset"):
        scenes = read_scenes(str(spec["scenePreset"]))["scenes"]
        only = spec.get("only")
        if isinstance(only, list) and only:
            keep = {str(n) for n in only}
            scenes = [s for s in scenes if s["name"] in keep]
    if not scenes:
        scenes = [{"name": "", "prompt": "", "negativePrompt": "", "width": None, "height": None}]

    count = max(1, int(spec.get("count") or 1))
    template = str(spec.get("template") or DEFAULT_TEMPLATE)
    character = str(spec.get("characterName") or "")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    seed = spec.get("seed")
    table = fragments()

    out = []
    for scene in scenes:
        for i in range(count):
            one = {**spec, "emotion": scene.get("prompt") or "",
                   "negativeExtra": scene.get("negativePrompt") or ""}
            pos, neg, captions = compose(one)
            # References are spliced after composing, so a fragment may be
            # named from a style or a character as well as from a scene.
            pos, missing = resolve_refs(pos, table)
            neg, missing2 = resolve_refs(neg, table)
            entry = {
                "name": build_name(template, character=character,
                                   emotion=scene["name"], index=i, stamp=stamp),
                "scene": scene["name"],
                "prompt": pos,
                "negative": neg,
                "charCaptions": captions,
                # A fixed seed across a batch is what makes an expression sheet
                # look like one character; varying it is what makes candidates
                # to choose between. Both are legitimate, so both are explicit.
                "seed": (int(seed) + i) if seed not in (None, "") else None,
            }
            # Size travels with the scene, because it does in the file: a
            # portrait and a wide shot are different scenes, not different runs.
            if scene.get("width") and scene.get("height"):
                entry["size"] = {"width": scene["width"], "height": scene["height"]}
            if missing or missing2:
                entry["unresolved"] = sorted(set(missing + missing2))
            out.append(entry)
    return out


# --- inpainting ---------------------------------------------------------------

def make_mask(width: int, height: int, boxes: list[dict]) -> bytes:
    """A mask PNG: white where it should be repainted, black elsewhere.

    Written with `zlib` and nothing else **on purpose**. Pillow is not in the
    release bundle - it is installed through the pip permission prompt when a
    workflow actually needs it - so the one image operation that is part of the
    core path must not depend on it. Rectangles are enough for the job this
    serves (a hand, a background corner, a badly drawn eye); anything cleverer
    is a `run_python` script's business, where Pillow is available.

    Boxes are fractions of the image (0..1) so a caller can say "the top third"
    without knowing the resolution.
    """
    import struct
    import zlib

    px = bytearray(width * height)
    for b in boxes:
        x0 = max(0, min(width, int(float(b.get("x", 0)) * width)))
        y0 = max(0, min(height, int(float(b.get("y", 0)) * height)))
        x1 = max(x0, min(width, int((float(b.get("x", 0)) + float(b.get("w", 0))) * width)))
        y1 = max(y0, min(height, int((float(b.get("y", 0)) + float(b.get("h", 0))) * height)))
        for y in range(y0, y1):
            base = y * width
            for x in range(x0, x1):
                px[base + x] = 255

    rows = bytearray()
    for y in range(height):
        rows.append(0)  # filter: none
        line = px[y * width:(y + 1) * width]
        for v in line:
            rows += bytes((v, v, v))

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
            + chunk(b"IEND", b""))


def inpaint(rel: str, boxes: list[dict], prompt: str, *, model: str,
            negative: str = "", params: dict | None = None, suffix: str = "-fix") -> dict:
    """Repaint part of a library image and save the result beside it.

    A new file, never in place: the original is a candidate someone may still
    prefer, and an inpaint that overwrote it would remove the comparison the
    selector exists to make.
    """
    rel = _rel(rel)
    png = read_bytes(rel)
    w, h = nai.png_size(png)
    if not w or not h:
        raise StudioError(f"PNG 이 아닙니다: {rel}")
    if not boxes:
        raise StudioError("다시 그릴 영역이 필요합니다 (x, y, w, h — 0~1 비율)")
    mask = make_mask(w, h, boxes)
    out = nai.infill(model, png, mask, prompt, negative, params)
    src = Path(rel)
    name = f"{src.stem}{suffix}.png"
    folder = str(src.parent).replace("\\", "/")
    saved = save_image(folder, name, out, {
        "inpaintOf": rel, "boxes": boxes, "prompt": prompt, "negative": negative,
        "model": nai.inpaint_model(model),
    })
    return saved


# --- choosing between candidates ----------------------------------------------
#
# The model is `C:\code\image-selector`, which the user built and uses: three
# independent flags per file rather than one "representative" radio, kept per
# folder. `use` is what goes to the bot, `inpaint` is what needs fixing first,
# `delete` is what to throw away - a file can legitimately be none of them,
# which is why one radio would not do.

SELECTION_DIR = "config/.studio/selection"
GROUP_DIR = "config/.studio/groups"
NAMING_DIR = "config/.studio/naming"


def _slug(folder: str) -> str:
    # Slugs are computed on the bare library-relative form so selection files
    # made before the space unification keep resolving. Hangul survives: the
    # old ASCII-only pattern collapsed every Korean folder name to the same
    # underscores, so images/고르기 and images/버리기 shared one selection file.
    return re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", _unstudio(folder).strip("/")) or "root"


def _legacy_slug(folder: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", _unstudio(folder).strip("/")) or "root"


def _side(kind: str, folder: str) -> Path:
    return root() / kind / f"{_slug(folder)}.json"


def read_selection(folder: str) -> dict:
    p = _side(SELECTION_DIR, folder)
    if not p.is_file():
        # A selection saved under the old ASCII-collapsed slug is still read
        # (never written back there - the first save moves it forward).
        p = root() / SELECTION_DIR / f"{_legacy_slug(folder)}.json"
        if not p.is_file():
            return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return {}


def write_selection(folder: str, selections: dict) -> dict:
    p = _side(SELECTION_DIR, folder)
    p.parent.mkdir(parents=True, exist_ok=True)
    # `rep` (the group's representative) is written only when set, so files
    # and tests from the three-flag era keep their exact shape.
    clean = {str(k): {"use": bool(v.get("use")), "inpaint": bool(v.get("inpaint")),
                      "delete": bool(v.get("delete")),
                      **({"rep": True} if v.get("rep") else {})}
             for k, v in (selections or {}).items() if isinstance(v, dict)}
    p.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"folder": folder, "count": len(clean)}


def naming_profile(char_key: str) -> dict:
    """The regex this bot's names are read with, if one has been decided."""
    p = _side(NAMING_DIR, char_key)
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        return {}


def save_naming_profile(char_key: str, profile: dict) -> dict:
    p = _side(NAMING_DIR, char_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
    return profile


def _group_key(fields: dict, group_by: str) -> str:
    """One field, or a `+`-joined composite (usability §1-30): 1-2-3.webp can
    group by token 1, by token 2, or by 1 AND 2 together. Composite parts join
    with '-' - it is a display/grouping key, not a filename."""
    if "+" not in group_by:
        return fields.get(group_by) or "(없음)"
    parts = [fields.get(f) or "" for f in group_by.split("+")]
    joined = "-".join([q for q in parts if q])
    return joined or "(없음)"


def group(folder: str, pattern: str = "", group_by: str = "emotion") -> dict:
    """The folder's images, gathered into groups to choose between.

    Groups come from parsing the filenames, and **what failed to parse is
    returned too**. That list is the honest part: names are not deterministic,
    so a selector that silently showed only the files it understood would hide
    exactly the ones needing attention.
    """
    folder = _rel(folder)
    base = files._resolve(SCOPE, folder)
    if not base.is_dir():
        raise StudioError(f"폴더가 없습니다: {folder}")
    names = sorted(p.name for p in base.iterdir()
                   if p.is_file() and p.suffix.lower() in (".png", ".jpg", ".jpeg", ".webp"))
    parsed = parse_names(names, pattern)
    sel = read_selection(folder)

    groups: dict[str, list[dict]] = {}
    for m in parsed["matched"]:
        key = _group_key(m, group_by)
        groups.setdefault(key, []).append({
            "filename": m["filename"],
            "path": f"{folder.strip('/')}/{m['filename']}",
            "fields": {k: v for k, v in m.items() if k != "filename"},
            "selection": sel.get(m["filename"], {"use": False, "inpaint": False, "delete": False}),
        })
    return {
        "folder": folder,
        "pattern": parsed["pattern"],
        "groupBy": group_by,
        "fields": parsed["fields"],
        "groups": [{"key": k, "items": v} for k, v in sorted(groups.items())],
        # Shown as its own group so it cannot be missed.
        "unmatched": [{"filename": n, "path": f"{folder.strip('/')}/{n}",
                       "selection": sel.get(n, {"use": False, "inpaint": False, "delete": False})}
                      for n in parsed["unmatched"]],
        "total": len(names),
    }


def rename_plan(folder: str, pairs: list[dict]) -> dict:
    """Check a bulk rename before anything moves.

    Bulk renaming is not a convenience here - it is what makes the regex above
    work at all, because the names it has to read were not made by us. So the
    plan is computed first and every problem is reported by name: a collision,
    a missing source, a name that escapes the folder.
    """
    folder = _rel(folder)
    base = files._resolve(SCOPE, folder)
    ok, problems = [], []
    taken = {p.name for p in base.iterdir() if p.is_file()} if base.is_dir() else set()
    for pair in pairs:
        src = str(pair.get("from") or "").strip()
        dst = str(pair.get("to") or "").strip()
        if not src or not dst:
            problems.append({"from": src, "to": dst, "why": "이름이 비었습니다"})
            continue
        if "/" in dst or "\\" in dst or dst != Path(dst).name:
            problems.append({"from": src, "to": dst, "why": "폴더를 옮길 수는 없습니다"})
            continue
        if not (base / src).is_file():
            problems.append({"from": src, "to": dst, "why": "원본이 없습니다"})
            continue
        if dst in taken and dst != src:
            problems.append({"from": src, "to": dst, "why": "같은 이름이 이미 있습니다"})
            continue
        taken.discard(src)
        taken.add(dst)
        ok.append({"from": src, "to": dst})
    return {"folder": folder, "rename": ok, "problems": problems}


def rename_apply(folder: str, pairs: list[dict]) -> dict:
    """Apply a checked rename. The sidecar follows its image."""
    folder = _rel(folder)
    plan = rename_plan(folder, pairs)
    if plan["problems"]:
        raise StudioError(f"{len(plan['problems'])}건에 문제가 있어 아무것도 바꾸지 않았습니다")
    base = files._resolve(SCOPE, folder)
    done = 0
    for pair in plan["rename"]:
        src, dst = base / pair["from"], base / pair["to"]
        if src == dst:
            continue
        src.rename(dst)
        side = src.with_suffix(".json")
        if side.is_file():
            side.rename(dst.with_suffix(".json"))
        done += 1
    log.info("studio rename %s: %d files", folder, done)
    return {"folder": folder, "renamed": done}


def export_selected(folder: str, *, pattern: str = "", group_by: str = "emotion",
                    character: str = "", delimiter: str = "-") -> dict:
    """Write the chosen images into `selected/` under canonical names.

    Mirrors `image-selector`'s export, which the user already works with:

      selected/<character><delim><group><ext>    the chosen one
      selected/<...>.2<ext>                      a second choice for the same group
      selected/inpaint/<...>                     flagged as needing a fix first
      selected/<character><delim><group>.txt     **nothing chosen for this group**

    The empty `.txt` is the useful part: it makes a slot with no answer visible,
    which is what sends you back to generate just that one.
    """
    folder = _rel(folder)
    g = group(folder, pattern, group_by)
    base = files._resolve(SCOPE, folder)
    out = base / "selected"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True, exist_ok=True)

    def name_for(key: str, index: int, ext: str) -> str:
        stem = f"{character}{delimiter}{key}" if character else key
        return f"{stem}{ext}" if index == 0 else f"{stem}.{index + 1}{ext}"

    used = inpainted = placeholders = 0
    for grp in g["groups"]:
        chosen = [i for i in grp["items"] if i["selection"].get("use")]
        fixing = [i for i in grp["items"] if i["selection"].get("inpaint")]
        # The representative (if flagged) takes the canonical name; without
        # one this degenerates to the old filename order exactly.
        for i, item in enumerate(sorted(chosen, key=lambda x: (not x["selection"].get("rep"), x["filename"]))):
            ext = Path(item["filename"]).suffix
            shutil.copy2(base / item["filename"], out / name_for(grp["key"], i, ext))
            used += 1
        if fixing:
            (out / "inpaint").mkdir(exist_ok=True)
            for i, item in enumerate(sorted(fixing, key=lambda x: x["filename"])):
                ext = Path(item["filename"]).suffix
                shutil.copy2(base / item["filename"], out / "inpaint" / name_for(grp["key"], i, ext))
                inpainted += 1
        if not chosen and not fixing:
            stem = f"{character}{delimiter}{grp['key']}" if character else grp["key"]
            (out / f"{stem}.txt").write_text("", encoding="utf-8")
            placeholders += 1

    rel = out.relative_to(files._root(SCOPE)).as_posix()
    log.info("studio export %s: %d used, %d inpaint, %d empty", rel, used, inpainted, placeholders)
    return {"folder": rel, "used": used, "inpaint": inpainted, "empty": placeholders,
            "groups": len(g["groups"]), "unmatched": len(g["unmatched"])}


# --- tidying ------------------------------------------------------------------

def duplicates(folder: str) -> dict:
    """Byte-identical images in one folder, grouped.

    Free to find: the same content hashing the same way is the store's whole
    premise. Re-running a batch with the same seed, or copying a keeper into a
    second folder, both leave duplicates that a grid cannot show you.

    Nothing is deleted here. The list names a keeper (the shortest name, which
    is usually the deliberate one) and the rest as candidates, and the caller
    decides - a duplicate is not automatically waste.
    """
    folder = _rel(folder)
    base = files._resolve(SCOPE, folder)
    if not base.is_dir():
        raise StudioError(f"폴더가 없습니다: {folder}")
    seen: dict[str, list[str]] = {}
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            continue
        h = hashlib.sha256(p.read_bytes()).hexdigest()
        seen.setdefault(h, []).append(p.relative_to(files._root(SCOPE)).as_posix())
    groups = []
    wasted = 0
    for h, paths in seen.items():
        if len(paths) < 2:
            continue
        keep = min(paths, key=lambda x: (len(Path(x).name), x))
        others = [p for p in paths if p != keep]
        size = (files._root(SCOPE) / keep).stat().st_size
        wasted += size * len(others)
        groups.append({"hash": h[:16], "keep": keep, "others": others, "size": size})
    return {"folder": folder, "groups": groups,
            "duplicateFiles": sum(len(g["others"]) for g in groups), "wastedBytes": wasted}


def emotion_check(char_key: str, preset: str = "") -> dict:
    """What the bot has, against what it is supposed to have.

    Two directions, because both are real problems and they look nothing alike:

      missing   an emotion the preset (or the card's own scripts) expects and
                the card has no asset for - the slot to go and generate.
      unused    an emotion asset on the card that nothing refers to - dead
                weight in a charx, or a rename that only half happened.

    The card's scripts are searched for each asset name because that is where
    RisuAI actually reaches for an emotion; an asset nothing names is unused
    whatever the list says.
    """
    from . import db
    rows = db.query(
        "SELECT name FROM char_assets WHERE char_key = ? AND field = 'emotion' ORDER BY seq",
        (char_key,))
    have = [str(r["name"] or "") for r in rows if r["name"]]

    wanted: list[str] = []
    if preset:
        wanted = [s["name"] for s in read_scenes(preset)["scenes"]]

    # Where an emotion name can actually be reached from: the scripts (Regex
    # and triggers, whose bodies live in entry_json) and the card's own text.
    blob = "\n".join(
        [str(r["entry_json"] or "") for r in
         db.query("SELECT entry_json FROM card_scripts WHERE char_key = ?", (char_key,))]
        + [str(r["body"] or "") for r in
           db.query("SELECT body FROM card_fields WHERE char_key = ?", (char_key,))])
    referenced = [n for n in have if n and n in blob]

    return {
        "charKey": char_key,
        "have": have,
        "wanted": wanted,
        "missing": [n for n in wanted if n not in have],
        # Only meaningful when there are scripts to be referenced from.
        "unreferenced": [n for n in have if n not in referenced] if blob.strip() else [],
        "note": ("감정 프리셋을 주면 빠진 슬롯도 알려줍니다."
                 if not preset else
                 f"프리셋의 씬 {len(wanted)}개 중 {len([n for n in wanted if n not in have])}개가 카드에 없습니다."),
    }


def estimate(spec: dict, images: int) -> dict:
    """What a batch will cost, said before it runs.

    Generation was free throughout the probe, but that is an Opus entitlement
    and not a property of the API, so this never claims free - it names what is
    certainly charged and leaves the rest to the before/after reading.
    """
    encodes = len([v for v in (spec.get("vibes") or []) if not v.get("cached")])
    charref = bool(spec.get("charrefs"))
    certain = encodes * 2 + (nai.CHARREF_ANLAS * images if charref else 0)
    note = ("생성 비용은 구독 등급에 따라 다릅니다 (Opus 는 0). "
            "레퍼런스 인코딩은 회당 2 Anlas 로 확정입니다.")
    if charref:
        note += f" 캐릭터 레퍼런스는 장당 {nai.CHARREF_ANLAS} Anlas 가 확정으로 나갑니다 (Opus 포함)."
    note += " 배치 전후 잔량을 대조해 실제 차액을 보고합니다."
    return {
        "images": images,
        "vibeEncodes": encodes,
        "anlasCertain": certain,
        "note": note,
    }
