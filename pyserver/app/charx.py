"""Build a `.charx` from the working card and the asset store.

This file is the assembly spec. What RisuAI does (characterCards.ts
`createBaseV3` + the charx branch of `exportCharacterCard`, read at
c0ed1026) and what this does differently, in one place:

    card.json        chara_card_v3 from createBaseV3, ported below. The
                     WORKING copy - card fields, greetings, global lore,
                     Regex, triggers - overlays the baseline character, so
                     the charx is what the user edited, not what RisuAI last
                     saved. Written last, like RisuAI.
    assets/          one file per `data.assets[]` entry, at
                     `assets/<type dir>/<ext dir>/<name>.<ext>`, name made
                     unique with `_1`, `_2`... exactly as RisuAI does (a
                     random pool is several entries with the same NAME and
                     different files). Bytes come from the asset store,
                     STORED not deflated - they are images already.
    x_meta/          `{"type": "<PNG|JPEG|...>"}` per asset, interleaved
                     before its file as RisuAI writes them. The importer
                     ignores every .json but card.json, so this is
                     compatibility dressing, kept because tools read it.
    module.risum     OMITTED. RisuAI's charx export duplicates triggers,
                     Regex and lorebook into a module and then DELETES them
                     from card.json; its importer (importCharacterProcess ->
                     importCharacterCardSpec) takes the inline
                     `extensions.risuai.triggerscript` / `customScripts` and
                     `character_book` when there is no module, so leaving
                     them inline needs no rpack encoder and imports the same.
                     (charx-cards.md: a module's namespace is lost on charx
                     round-trip anyway.)
    icon             RisuAI adds the `ccdefault:` icon entry only when the
                     bot has emotion images; here the portrait is always an
                     entry (`assets/icon/image/main.png`), because the
                     importer maps `icon`+`main` to the character image and a
                     charx without one has no portrait.
    vits             `{}`, as createBaseV3 writes it - v3 does not carry VITS
                     files.

Missing assets: the importer THROWS on an `embeded://` path that is not in
the zip, so an entry whose bytes the store does not have cannot be written
as-is. Default is to refuse and list them (the plugin's importer can fetch
them); `allow_missing` drops those entries instead, which imports cleanly
and simply lacks those images.
"""
from __future__ import annotations

import json
import re
import time
import zipfile
from pathlib import Path
from typing import Any

from . import assets, db, log, store, workspace
from . import card as cardmod

SPEC = "chara_card_v3"
SPEC_VERSION = "3.0"

# type -> first path segment, ext -> second (exportCharacterCard, v3 branch)
TYPE_DIRS = {"emotion": "emotion", "background": "background", "user_icon": "user_icon", "icon": "icon"}
EXT_DIRS = {
    "image": ("png", "jpg", "jpeg", "gif", "webp", "avif"),
    "audio": ("mp3", "wav", "ogg", "flac"),
    "video": ("mp4", "webm", "mov", "avi", "mkv"),
    "model": ("mmd", "obj"),
    "ai": ("safetensors", "cpkt", "onnx"),
    "fonts": ("otf", "ttf", "woff", "woff2"),
    "code": ("js", "ts", "lua"),
}
_EXT_DIR = {e: d for d, exts in EXT_DIRS.items() for e in exts}


class CharxError(Exception):
    pass


# --- the working character -----------------------------------------------------

def working_character(ck: str) -> dict:
    """The baseline character (full, minus chats) with the working copy laid
    over it - the same overlay `card.patch` sends to RisuAI on 반영."""
    row = store.character_row(ck)
    if row is None:
        raise CharxError(f"unknown workspace: {ck}")
    char = db.unjs(row.get("card_json"), {}) or {}
    if not isinstance(char, dict):
        char = {}
    if not cardmod.is_full(ck):
        raise CharxError("구버전 업로드 상태의 카드라 charx 를 만들 수 없습니다. 패널을 닫았다 다시 열어 주세요")

    greetings: list[tuple[int, str]] = []
    for r in db.query("SELECT * FROM card_fields WHERE char_key = ? ORDER BY field, seq", (ck,)):
        f = cardmod._field_row(r)
        if f["field"] == cardmod.LIST_FIELD:
            if not f["deleted"]:
                greetings.append((f["seq"], f["body"]))
        elif f["field"] in cardmod.NESTED:
            top, inner = cardmod.NESTED[f["field"]]
            holder = char.get(top) if isinstance(char.get(top), dict) else {}
            holder[inner] = f["body"]
            char[top] = holder
            char[f["field"]] = f["body"]
        else:
            char[f["field"]] = f["body"]
    char[cardmod.LIST_FIELD] = [b for _s, b in sorted(greetings)]
    char["globalLore"] = [x["entry"] for x in store.lore(ck, "global")]
    for kind in cardmod.SCRIPT_KINDS:
        entries = [x["entry"] for x in cardmod.scripts(ck, kind)]
        if kind == cardmod.ASSET_KIND:
            # The working asset references, back in the shape createBaseV3 reads.
            char.update(cardmod.asset_lists(entries))
        else:
            char[kind] = entries
    return char


# --- createBaseV3, ported ---------------------------------------------------------

def _lore_v3(lore: dict) -> dict:
    ext = dict(lore.get("extentions") or {}) if isinstance(lore.get("extentions"), dict) else {}
    case_sensitive = bool(ext.pop("risu_case_sensitive", False))
    ext["risu_activationPercent"] = lore.get("activationPercent")
    ext["risu_loreCache"] = lore.get("loreCache")
    key = str(lore.get("key") or "")
    secondkey = str(lore.get("secondkey") or "")
    selective = bool(lore.get("selective", False))
    out: dict[str, Any] = {
        "keys": [k.strip() for k in key.split(",")],
        "secondary_keys": [k.strip() for k in secondkey.split(",")] if selective else None,
        "content": lore.get("content") or "",
        "extensions": ext,
        "enabled": True,
        "insertion_order": lore.get("insertorder"),
        "constant": bool(lore.get("alwaysActive", False)),
        "selective": selective,
        "name": lore.get("comment") or "",
        "comment": lore.get("comment") or "",
        "case_sensitive": case_sensitive,
        "use_regex": bool(lore.get("useRegex", False)),
        "mode": lore.get("mode") or "normal",
        "folder": lore.get("folder"),
    }
    # JS `undefined` fields are simply absent in JSON.
    return {k: v for k, v in out.items() if v is not None or k in ("folder",)}


def create_base_v3(char: dict) -> dict:
    cc = char.get("ccAssets")
    asset_list: list[dict] = [dict(a) for a in cc if isinstance(a, dict)] if isinstance(cc, list) else []
    for a in char.get("additionalAssets") or []:
        if isinstance(a, list) and len(a) >= 2:
            asset_list.append({"type": "x-risu-asset", "uri": a[1], "name": a[0],
                               "ext": (a[2] if len(a) > 2 and a[2] else "png")})
    for e in char.get("emotionImages") or []:
        if isinstance(e, list) and len(e) >= 2:
            asset_list.append({"type": "emotion", "uri": e[1], "name": e[0], "ext": "png"})
    if char.get("image"):
        asset_list.append({"type": "icon", "uri": "ccdefault:", "name": "main", "ext": "png"})

    lore_settings = char.get("loreSettings") if isinstance(char.get("loreSettings"), dict) else {}
    lore_ext = dict(char.get("loreExt") or {}) if isinstance(char.get("loreExt"), dict) else {}
    lore_ext["risu_fullWordMatching"] = bool(lore_settings.get("fullWordMatching", False))

    add = char.get("additionalData") if isinstance(char.get("additionalData"), dict) else {}
    ver = add.get("character_version")
    risuai = {
        "bias": char.get("bias"),
        "viewScreen": char.get("viewScreen"),
        "customScripts": char.get("customscript"),
        "utilityBot": char.get("utilityBot"),
        "sdData": char.get("sdData"),
        "backgroundHTML": char.get("backgroundHTML"),
        "license": char.get("license"),
        "triggerscript": char.get("triggerscript"),
        "additionalText": char.get("additionalText"),
        "virtualscript": "",
        "largePortrait": char.get("largePortrait"),
        "lorePlus": char.get("lorePlus"),
        "inlayViewScreen": char.get("inlayViewScreen"),
        "newGenData": char.get("newGenData"),
        "vits": {},
        "lowLevelAccess": bool(char.get("lowLevelAccess", False)),
        "defaultVariables": char.get("defaultVariables") or "",
        "prebuiltAssetCommand": char.get("prebuiltAssetCommand") or "",
        "prebuiltAssetExclude": char.get("prebuiltAssetExclude") or [],
        "prebuiltAssetStyle": char.get("prebuiltAssetStyle") or "",
        "toggles": char.get("customModuleToggle") or "",
        "moduleNamespace": char.get("moduleNamespace"),
        "hideChatIcon": bool(char.get("hideChatIcon", False)),
    }
    extensions: dict[str, Any] = {"risuai": risuai, "depth_prompt": char.get("depth_prompt")}
    for k, v in (char.get("extentions") or {}).items() if isinstance(char.get("extentions"), dict) else []:
        if k not in ("risuai", "depth_prompt"):
            extensions[k] = v

    data = {
        "name": char.get("name") or "",
        "description": char.get("desc") or "",
        "personality": char.get("personality") or "",
        "scenario": char.get("scenario") or "",
        "first_mes": char.get("firstMessage") or "",
        "mes_example": char.get("exampleMessage") or "",
        "creator_notes": char.get("creatorNotes") or "",
        "system_prompt": char.get("systemPrompt") or "",
        "post_history_instructions": char.get("replaceGlobalNote") or "",
        "alternate_greetings": list(char.get("alternateGreetings") or []),
        "character_book": {
            "scan_depth": lore_settings.get("scanDepth"),
            "token_budget": lore_settings.get("tokenBudget"),
            "recursive_scanning": lore_settings.get("recursiveScanning"),
            "extensions": lore_ext,
            "entries": [_lore_v3(l) for l in (char.get("globalLore") or []) if isinstance(l, dict)],
        },
        "tags": list(char.get("tags") or []),
        "creator": add.get("creator") or "",
        "character_version": f"{ver}" if ver is not None else "",
        "extensions": extensions,
        "group_only_greetings": list(char.get("group_only_greetings") or []),
        "nickname": char.get("nickname") or "",
        "source": list(char.get("source") or []),
        "creation_date": char.get("creation_date") or 0,
        "modification_date": int(time.time()),
        "assets": asset_list,
    }
    return {"spec": SPEC, "spec_version": SPEC_VERSION, "data": data}


# --- assembly --------------------------------------------------------------------

def _image_type(head: bytes) -> str:
    if head.startswith(b"\x89PNG"):
        return "PNG"
    if head[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    if head[4:12] in (b"ftypavif", b"ftypavis"):
        return "AVIF"
    return "Unknown"


def _zip_path(entry: dict, index: int, seen: set[str]) -> tuple[str, str]:
    """(zip path, unique stem) the way exportCharacterCard names them."""
    tdir = TYPE_DIRS.get(str(entry.get("type") or ""), "other")
    ext = str(entry.get("ext") or "unknown").lower()
    if ext == "unknown":
        ext, edir = "png", "image"
    else:
        edir = _EXT_DIR.get(ext, "other")
    name = str(entry.get("name") or f"asset_{index}")[:100]
    base = f"assets/{tdir}/{edir}"
    unique = name
    n = 0
    while f"{base}/{unique}.{ext}" in seen:
        n += 1
        unique = f"{name}_{n}"
    path = f"{base}/{unique}.{ext}"
    seen.add(path)
    return path, unique


def _safe_filename(name: str) -> str:
    s = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(". ")
    return s or "character"


def build(ck: str, *, allow_missing: bool = False, filename: str | None = None) -> dict:
    """Write `out/<name>.charx` in the bot's workspace. Returns what went in
    and what did not; refuses (`ok: False`, nothing written) when assets are
    missing and `allow_missing` is off."""
    char = working_character(ck)
    card = create_base_v3(char)
    entries: list[dict] = card["data"]["assets"]

    # Resolve every entry to a file in the store before writing anything.
    resolved: list[tuple[dict, Path]] = []
    missing: list[dict] = []
    for i, e in enumerate(entries):
        uri = str(e.get("uri") or "")
        key = str(char.get("image") or "") if uri == "ccdefault:" else uri
        if uri.startswith(("http://", "https://", "embeded://")) or not key:
            # isKnownUri: left as-is by RisuAI's exporter too.
            if uri == "ccdefault:":
                missing.append({"name": e.get("name"), "type": e.get("type"), "key": ""})
            continue
        located = assets.locate(key)
        if located is None:
            missing.append({"name": e.get("name"), "type": e.get("type"), "key": key})
            continue
        resolved.append((e, located))
    if missing and not allow_missing:
        return {"ok": False, "charKey": ck, "missing": missing, "assets": len(entries),
                "hint": "에셋 동기화를 끝내거나, allowMissing 으로 빠진 항목을 제외하고 만들 수 있습니다"}

    kept = [e for e, _p in resolved]
    dropped = len(entries) - len(kept)
    card["data"]["assets"] = kept

    # The deliverable goes to the bot's project out/ in the global space, so
    # the files tab (and the download route, which serves the space) can reach it.
    out_dir = workspace.out_dir(ck)
    name = _safe_filename(filename or f"{char.get('name') or 'character'}")
    if not name.lower().endswith(".charx"):
        name += ".charx"
    target = out_dir / name
    tmp = target.with_name(target.name + ".part")

    seen: set[str] = set()
    written_bytes = 0
    t0 = time.time()
    with zipfile.ZipFile(tmp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for i, (e, path) in enumerate(resolved):
            zpath, stem = _zip_path(e, i, seen)
            e["uri"] = "embeded://" + zpath
            with path.open("rb") as fh:
                head = fh.read(16)
            z.writestr(f"x_meta/{stem}.json", json.dumps({"type": _image_type(head)}, separators=(",", ":")))
            # Stored, not deflated: images are already compressed and a 150MB
            # bot would otherwise spend a minute re-compressing them for nothing.
            z.write(path, zpath, compress_type=zipfile.ZIP_STORED)
            written_bytes += path.stat().st_size
        z.writestr("card.json", json.dumps(card, ensure_ascii=False, indent=4))
    tmp.replace(target)
    size = target.stat().st_size
    log.info("charx char=%s file=%s assets=%s dropped=%s bytes=%s %.1fs",
             ck, name, len(kept), dropped, size, time.time() - t0)
    rel = f"{workspace.out_rel(ck)}/{name}"
    return {
        "ok": True, "charKey": ck, "file": name, "path": rel, "size": size,
        "assets": len(kept), "dropped": dropped, "missing": missing if allow_missing else [],
        "assetBytes": written_bytes, "seconds": round(time.time() - t0, 1),
    }


def preview(ck: str) -> dict:
    """What a build would contain, without writing: counts and missing keys."""
    char = working_character(ck)
    card = create_base_v3(char)
    entries = card["data"]["assets"]
    missing = []
    present = 0
    for e in entries:
        uri = str(e.get("uri") or "")
        key = str(char.get("image") or "") if uri == "ccdefault:" else uri
        if uri.startswith(("http://", "https://", "embeded://")):
            continue
        if key and assets.locate(key) is not None:
            present += 1
        else:
            missing.append({"name": e.get("name"), "type": e.get("type"), "key": key})
    return {
        "charKey": ck, "name": char.get("name") or "", "assets": len(entries), "present": present,
        "missing": missing, "lore": len(card["data"]["character_book"]["entries"]),
        "regex": len(char.get("customscript") or []), "triggers": len(char.get("triggerscript") or []),
        "greetings": len(card["data"]["alternate_greetings"]),
    }
