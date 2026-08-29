"""The asset studio's domain: prompts in, named images out.

Storage is `files.py` with `scope=STUDIO` (one file API, two roots); NovelAI is
`nai.py` (written from `docs/09`). What is left is the part in between, and it
is mostly about **names**:

    styles/      a style, as front matter + ## positive / ## negative
    characters/  a character: prompt, negative, reference image, position
    fragments/   snippets spliced into either
    emotions/    emotion name -> prompt fragment. **This is how expression sets
                 are made** - one ordinary generation per entry with the
                 character and seed held fixed - not with the `emotion`
                 director tool, which costs ten times as much and infers the
                 emotion from a finished image rather than stating it.
    presets/     NovelAI model and parameters, as data
    images/      the output, plus a `.json` sidecar per file

A generated file's name is what the comparison selector later parses back into
character and emotion, so the naming template and that parser are one decision,
not two. The default template is a starting point: **names are not
deterministic in practice**, which is exactly why the selector parses with a
regex and why Hina has to be able to rename in bulk.
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any

from . import files, log, nai, workspace

SCOPE = files.STUDIO

# `skills.py` already parses this shape; the studio reuses it rather than
# inventing a second front-matter dialect.
FRONT = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n?", re.S)
SECTION = re.compile(r"^##+\s*(positive|negative|프롬프트|네거티브)\s*$", re.I | re.M)

DEFAULT_TEMPLATE = "{character}-{outfit}-{emotion}-{stamp}-{n}"

# What the selector parses back out. Kept beside the template on purpose: the
# two have to agree, and a reader who changes one must see the other.
DEFAULT_PARSE = r"^(?P<character>[^-]+)-(?P<outfit>[^-]+)-(?P<emotion>[^-]+)-"


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
            "positive": positive, "negative": negative}


def read_json(rel: str) -> dict:
    try:
        return json.loads(_read_text(rel))
    except ValueError as e:
        raise StudioError(f"{rel} 을 읽지 못했습니다 (JSON 아님): {e}") from e


def _read_text(rel: str) -> str:
    p = files._resolve(SCOPE, rel)
    if not p.is_file():
        raise StudioError(f"파일이 없습니다: {rel}")
    return p.read_text(encoding="utf-8", errors="replace")


def read_bytes(rel: str) -> bytes:
    p = files._resolve(SCOPE, rel)
    if not p.is_file():
        raise StudioError(f"파일이 없습니다: {rel}")
    return p.read_bytes()


def listing(area: str) -> list[dict]:
    """Everything in one area, with just enough of each to choose by."""
    out = []
    base = root() / area
    if not base.is_dir():
        return out
    for p in sorted(base.rglob("*")):
        if not p.is_file() or p.name.startswith("."):
            continue
        rel = p.relative_to(root()).as_posix()
        item = {"path": rel, "name": p.stem, "folder": p.parent.relative_to(base).as_posix()}
        if p.suffix.lower() == ".md" and area == "styles":
            try:
                s = read_style(rel)
                item.update(name=s["name"], description=s["description"])
            except StudioError:
                pass
        elif p.suffix.lower() == ".json":
            try:
                d = read_json(rel)
                item["name"] = str(d.get("name") or p.stem)
                if area == "emotions":
                    item["count"] = len(d.get("emotions") or {})
            except StudioError:
                pass
        out.append(item)
    return out


# --- assembling one request ---------------------------------------------------

def compose(spec: dict) -> tuple[str, str, list[dict]]:
    """(positive, negative, char_captions) for one image.

    Order is style, then character, then fragments, then the emotion - the
    emotion last because it is the thing that varies across a batch and the
    thing a reader is looking for when they check what was sent.
    """
    pos: list[str] = []
    neg: list[str] = []

    style_rel = str(spec.get("style") or "")
    if style_rel:
        s = read_style(style_rel)
        if s["positive"]:
            pos.append(s["positive"])
        if s["negative"]:
            neg.append(s["negative"])

    captions: list[dict] = []
    for ch in spec.get("characters") or []:
        c = ch if isinstance(ch, dict) else read_json(str(ch))
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
    a character name would silently shift every field the parser reads."""
    return _UNSAFE.sub("", str(text or "")).replace("-", "_").strip() or "무제"


def build_name(template: str, *, character: str = "", outfit: str = "",
               emotion: str = "", index: int = 0, stamp: str = "") -> str:
    t = template or DEFAULT_TEMPLATE
    stamp = stamp or time.strftime("%Y%m%d-%H%M%S")
    name = (t.replace("{character}", safe_part(character))
             .replace("{outfit}", safe_part(outfit))
             .replace("{emotion}", safe_part(emotion))
             .replace("{stamp}", stamp)
             .replace("{n}", str(index + 1)))
    return name + ".png"


def parse_names(names: list[str], pattern: str = "") -> dict:
    """Split filenames into fields with a regex. Reports what did NOT match.

    The unmatched list is the point. Names are not deterministic - that is why
    this app exists - so the selector has to show what it could not read and
    hand it to Hina to rename, rather than quietly dropping those files.
    """
    rx = re.compile(pattern or DEFAULT_PARSE)
    matched: list[dict] = []
    unmatched: list[str] = []
    for n in names:
        m = rx.search(n)
        if not m:
            unmatched.append(n)
            continue
        d = {k: v for k, v in (m.groupdict() or {}).items() if v is not None}
        d["filename"] = n
        matched.append(d)
    return {"matched": matched, "unmatched": unmatched,
            "pattern": pattern or DEFAULT_PARSE,
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

def save_image(folder: str, name: str, png: bytes, sidecar: dict) -> dict:
    """The PNG plus its sidecar.

    The sidecar is an **index, not the truth**: a NovelAI PNG already carries
    every applied parameter in its own metadata (docs/09 §5b). This records
    what we asked for and which library files it came from, which the PNG
    cannot know.
    """
    folder = (folder or "images").strip("/")
    if not folder.startswith("images"):
        folder = "images/" + folder
    dest = files._resolve(SCOPE, folder) / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(png)
    side = dest.with_suffix(".json")
    side.write_text(json.dumps({**sidecar, "file": name,
                                "createdAt": time.time()},
                               ensure_ascii=False, indent=2), encoding="utf-8")
    rel = dest.relative_to(root()).as_posix()
    log.info("studio image %s (%d bytes)", rel, len(png))
    return {"path": rel, "size": len(png)}


def stage_to_bot(char_key: str, rel: str) -> dict:
    """Copy one studio image into a bot's workspace so it can be adopted.

    The whole adoption chain downstream - `propose_asset_add`, the approval
    queue, `saveAsset`, the card write - already exists and takes a *workspace*
    path. This is the one hop between the two scopes, and it is a copy: the
    library keeps its own.
    """
    src = files._resolve(SCOPE, rel)
    if not src.is_file():
        raise StudioError(f"파일이 없습니다: {rel}")
    if src.read_bytes()[:4] != b"\x89PNG":
        raise StudioError(f"PNG 만 에셋으로 넣을 수 있습니다: {rel}")
    dest = files._resolve(char_key, "out/studio") / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())
    out = dest.relative_to(files._root(char_key)).as_posix()
    log.info("studio -> bot %s: %s", char_key, out)
    return {"path": out, "size": dest.stat().st_size}


# --- one batch ----------------------------------------------------------------

def plan(spec: dict) -> list[dict]:
    """A batch, expanded into the images it will make.

    One entry per (emotion x count). Expanded before anything is sent so the
    caller can be told how many images and what they will be called before it
    spends anything.
    """
    emotions: dict[str, str] = {}
    if spec.get("emotionPreset"):
        d = read_json(str(spec["emotionPreset"]))
        emotions = {str(k): str(v) for k, v in (d.get("emotions") or {}).items()}
    if spec.get("emotions"):
        emotions = {str(k): str(v) for k, v in dict(spec["emotions"]).items()}
    if not emotions:
        emotions = {"": ""}

    count = max(1, int(spec.get("count") or 1))
    template = str(spec.get("template") or DEFAULT_TEMPLATE)
    character = str(spec.get("characterName") or "")
    outfit = str(spec.get("outfit") or "")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    seed = spec.get("seed")

    out = []
    for emotion, fragment in emotions.items():
        for i in range(count):
            one = {**spec, "emotion": fragment}
            pos, neg, captions = compose(one)
            out.append({
                "name": build_name(template, character=character, outfit=outfit,
                                   emotion=emotion, index=i, stamp=stamp),
                "emotion": emotion,
                "prompt": pos,
                "negative": neg,
                "charCaptions": captions,
                # A fixed seed across a batch is what makes an expression set
                # look like one character; varying it is what makes candidates
                # to choose between. Both are legitimate, so both are explicit.
                "seed": (int(seed) + i) if seed not in (None, "") else None,
            })
    return out


def estimate(spec: dict, images: int) -> dict:
    """What a batch will cost, said before it runs.

    Generation was free throughout the probe, but that is an Opus entitlement
    and not a property of the API, so this never claims free - it names what is
    certainly charged and leaves the rest to the before/after reading.
    """
    encodes = len([v for v in (spec.get("vibes") or []) if not v.get("cached")])
    return {
        "images": images,
        "vibeEncodes": encodes,
        "anlasCertain": encodes * 2,
        "note": "생성 비용은 구독 등급에 따라 다릅니다 (Opus 는 0). "
                "레퍼런스 인코딩은 회당 2 Anlas 로 확정입니다. 배치 전후 잔량을 대조해 실제 차액을 보고합니다.",
    }
