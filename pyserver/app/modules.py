"""RisuAI modules as working copies, next to the bot and the personas.

A module (RisuAI `RisuModule`, process/modules.ts) is a bundle meant to be
COMBINED with a bot, a persona or a prompt preset: lorebook, Regex, triggers,
assets, a toggle definition, a background embedding. RisuAI keeps them in
`db.modules` (on the plugin allow-list) and turns them on per character
(`character.modules`), per chat (`chat.modules`) or globally
(`enabledModules`).

**A module is edited as a card.** Its materials are exactly a card's, under
other names, and RisuAI itself converts one into the other
(interchangeability.ts convertModuleToCharacter / convertCharacterToModule -
which is also why the recommended file format is now a `.charx`):

    module                card (Hina rows)
    name                  name
    description           creatorNotes
    lorebook              globalLore
    regex                 customscript
    trigger               triggerscript
    assets [name,key,ext] additionalAssets
    lowLevelAccess        lowLevelAccess
    hideIcon              hideChatIcon
    backgroundEmbedding   backgroundHTML
    namespace             moduleNamespace
    customModuleToggle    customModuleToggle
    icon                  image

So a module gets a `characters` row of its own under a key of its own
(`m<hash>`, never a bot's `c<hash>`), and every card route, snapshot, merge,
diff, conflict and agent tool works on it unchanged. Only two things differ:
the scalars (card.MODULE_SCALARS) and 반영, which the plugin writes into
`db.modules` instead of a character (plugin/src/modules.ts - the mirror of
the table above; keep the two identical).

Which modules are opened together with a bot or a persona (the "combination")
is remembered per owner in `meta` (`module_combo:<owner>`).

Files: `.risum` (the legacy format - rpack-obfuscated JSON plus asset blobs),
`.charx` (a module exported by RisuAI is a charx of the converted character)
and `.json` (`{type: 'risuModule', ...}`) are read here for import, and a
working copy is written back out as either `.risum` or `.charx`.
"""
from __future__ import annotations

import base64
import hashlib
import json
import struct
import zipfile
from typing import Any

from . import assets, db, log, store, workspace
from . import card as cardmod

PREFIX = "m"
SOURCE = "risu-hina-module"

# card field -> module key (the scalars), and the lists. See the module doc.
SCALAR_MAP = {
    "name": "name", "creatorNotes": "description", "customModuleToggle": "customModuleToggle",
    "moduleNamespace": "namespace", "lowLevelAccess": "lowLevelAccess", "hideChatIcon": "hideIcon",
    "backgroundHTML": "backgroundEmbedding", "image": "icon",
}
LIST_MAP = {"globalLore": "lorebook", "customscript": "regex", "triggerscript": "trigger",
            "additionalAssets": "assets"}

# rpack (RisuAI src/ts/rpack): a fixed byte permutation, encode map first and
# decode map second. The same table seeds/charx_unpack.py carries for reading.
_RPACK_B64 = "xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA="
_RPACK = base64.b64decode(_RPACK_B64)
_ENCODE = _RPACK[:256]
_DECODE = _RPACK[256:512]


class ModuleError(ValueError):
    pass


# --- keys ---------------------------------------------------------------------

def key_of(module_id: str) -> str:
    return PREFIX + store._key("module", str(module_id or ""))


def is_module_key(ck: str) -> bool:
    """A working copy that is a module (not a bot). Checked against the row,
    not only the prefix: a key that merely starts with 'm' is not enough."""
    if not ck or not ck.startswith(PREFIX):
        return False
    row = db.one("SELECT value FROM meta WHERE key = ?", (_META + ck,))
    return row is not None


_META = "module:"
_COMBO = "module_combo:"


def _meta_get(ck: str) -> dict:
    row = db.one("SELECT value FROM meta WHERE key = ?", (_META + ck,))
    return (db.unjs(row["value"], {}) or {}) if row else {}


def _meta_set(ck: str, value: dict) -> None:
    db.execute("INSERT INTO meta(key, value) VALUES(?, ?) "
               "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (_META + ck, db.js(value)))


# --- conversion ----------------------------------------------------------------

def _list(v: Any) -> list:
    return [x for x in v if x is not None] if isinstance(v, list) else []


def to_card(module: dict) -> dict:
    """A RisuAI module as the character-shaped dict the card rows read."""
    m = module if isinstance(module, dict) else {}
    assets_ = []
    for a in _list(m.get("assets")):
        if isinstance(a, list) and len(a) >= 2:
            assets_.append([str(a[0] or ""), str(a[1] or ""), str(a[2]) if len(a) > 2 and a[2] else "png"])
    return {
        "chaId": str(m.get("id") or ""),
        "name": str(m.get("name") or ""),
        "creatorNotes": str(m.get("description") or ""),
        "globalLore": [e for e in _list(m.get("lorebook")) if isinstance(e, dict)],
        "customscript": [e for e in _list(m.get("regex")) if isinstance(e, dict)],
        "triggerscript": [e for e in _list(m.get("trigger")) if isinstance(e, dict)],
        "additionalAssets": assets_,
        "lowLevelAccess": bool(m.get("lowLevelAccess")),
        "hideChatIcon": bool(m.get("hideIcon")),
        "backgroundHTML": str(m.get("backgroundEmbedding") or ""),
        "moduleNamespace": str(m.get("namespace") or ""),
        "customModuleToggle": str(m.get("customModuleToggle") or ""),
        "image": str(m.get("icon") or ""),
        # charx.create_base_v3 copies these into the exported card.
        "extentions": {"risu_hina": {"module": True}},
    }


def from_card(card: dict, base: dict | None = None) -> dict:
    """The working character back into a module, over `base` (unknown keys of
    the original module - mcp, folderId, ... - ride along)."""
    out = dict(base or {})
    for f, k in SCALAR_MAP.items():
        v = card.get(f)
        if f in ("lowLevelAccess", "hideChatIcon"):
            out[k] = bool(v)
        else:
            out[k] = "" if v is None else str(v)
    for f, k in LIST_MAP.items():
        out[k] = list(card.get(f) or [])
    if not out.get("namespace"):
        out.pop("namespace", None)
    if not out.get("icon"):
        out.pop("icon", None)
    out["id"] = str(out.get("id") or card.get("chaId") or "")
    return out


# --- the working copy ----------------------------------------------------------

def sync(module: dict, *, reset: bool = False) -> dict:
    """RisuAI's module as the panel just read it -> its working copy.

    Same contract as a bot's upload: the first read loads, a later one merges
    (RisuAI's side moved: untouched rows follow it, rows edited on both sides
    become conflicts), and `reset` (after a verified 반영) reloads outright.
    """
    if not isinstance(module, dict) or not module.get("id"):
        raise ModuleError("module.id 가 필요합니다")
    if module.get("mcp"):
        raise ModuleError("MCP 모듈은 편집할 내용이 없습니다 (RisuAI 모듈 설정에서 다뤄 주세요)")
    mid = str(module["id"])
    ck = key_of(mid)
    card = to_card(module)
    now = db.now()
    db.execute(
        "INSERT INTO characters(char_key, cha_id, name, char_index, card_json, family_key, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(char_key) DO UPDATE SET "
        "  cha_id=excluded.cha_id, name=excluded.name, card_json=excluded.card_json, updated_at=excluded.updated_at",
        (ck, mid, card["name"], None, db.js(card), "", now, now))
    meta = _meta_get(ck)
    meta.update({"id": mid, "name": card["name"], "syncedAt": now})
    _meta_set(ck, meta)
    first = not cardmod.exists(ck)
    card_reset = reset or first
    summary = cardmod.ingest(ck, card, reset=card_reset)
    cardmod.set_full(ck, True)
    lore_merge = store.ingest_lore(ck, card["globalLore"], {}, global_reset=card_reset)
    # Its system directory, like a bot's: run_python and the agent's scratch
    # work from there while the module is the target.
    base = workspace.root(ck)
    for sub in ("scripts", "out"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    merged = dict(summary.get("merge") or {})
    for k, v in (lore_merge or {}).items():
        merged[k] = merged.get(k, 0) + v
    log.info("module sync key=%s name=%s reset=%s merge=%s", ck, card["name"], card_reset, merged or "-")
    return {**row(ck), "merge": {k: v for k, v in merged.items() if v and k != "keep"}, "reset": card_reset}


def row(ck: str) -> dict:
    """One module as the panel lists it."""
    meta = _meta_get(ck)
    r = store.character_row(ck) or {}
    card = db.unjs(r.get("card_json"), {}) or {}
    ch = cardmod.changes(ck) if cardmod.exists(ck) else {"total": 0}
    from . import conflicts
    return {
        "key": ck, "id": meta.get("id") or r.get("cha_id") or "",
        "name": (_working_scalar(ck, "name") or r.get("name") or ""),
        "baseName": r.get("name") or "",
        "description": (_working_scalar(ck, "creatorNotes") or "")[:300],
        "lore": len(card.get("globalLore") or []), "regex": len(card.get("customscript") or []),
        "trigger": len(card.get("triggerscript") or []), "assets": len(card.get("additionalAssets") or []),
        "toggles": bool((card.get("customModuleToggle") or "").strip()),
        "lowLevelAccess": bool(card.get("lowLevelAccess")),
        "total": int(ch.get("total") or 0), "dirty": bool(ch.get("total")),
        "conflicts": conflicts.count_for_card(ck),
        "folder": workspace.bot_folder(ck),
        "syncedAt": meta.get("syncedAt") or 0,
    }


def _working_scalar(ck: str, field: str) -> str:
    r = db.one("SELECT body FROM card_fields WHERE char_key = ? AND field = ? AND seq = 0", (ck, field))
    return str(r["body"] or "") if r else ""


def listing(query: str = "") -> list[dict]:
    keys = [r["key"][len(_META):] for r in db.query(
        "SELECT key FROM meta WHERE key LIKE ? ORDER BY key", (_META + "%",))]
    out = []
    q = (query or "").strip().casefold()
    for ck in keys:
        if store.character_row(ck) is None:
            continue
        r = row(ck)
        if q and q not in r["name"].casefold() and q not in r["description"].casefold():
            continue
        out.append(r)
    out.sort(key=lambda r: r["name"].casefold())
    return out


def resolve(ref: str) -> str:
    """A module key from a key, a RisuAI id or a (unique) name."""
    ref = str(ref or "").strip()
    if not ref:
        raise ModuleError("모듈을 지정해 주세요 (이름·id·key)")
    if is_module_key(ref):
        return ref
    ck = key_of(ref)
    if is_module_key(ck):
        return ck
    hits = [r for r in listing() if r["name"] == ref] or [r for r in listing(ref)]
    if len(hits) == 1:
        return hits[0]["key"]
    if not hits:
        raise ModuleError(f"모듈을 찾지 못했습니다: {ref} - 패널에서 모듈 목록을 한 번 읽어야 알 수 있습니다")
    raise ModuleError(f"'{ref}' 에 맞는 모듈이 {len(hits)}개입니다: " + ", ".join(h["name"] for h in hits[:8]))


def dirty() -> list[dict]:
    return [{"key": r["key"], "name": r["name"], "total": r["total"], "conflicts": r["conflicts"]}
            for r in listing() if r["dirty"] or r["conflicts"]]


def forget(ck: str) -> None:
    """RisuAI no longer has the module: drop its working copy."""
    if not is_module_key(ck):
        return
    db.execute("DELETE FROM meta WHERE key = ?", (_META + ck,))
    db.execute("DELETE FROM characters WHERE char_key = ?", (ck,))
    db.execute("DELETE FROM card_fields WHERE char_key = ?", (ck,))
    db.execute("DELETE FROM card_scripts WHERE char_key = ?", (ck,))


# --- combinations ---------------------------------------------------------------

def _owner_ok(owner: str) -> str:
    owner = str(owner or "").strip()
    if not owner or len(owner) > 200:
        raise ModuleError("owner 가 필요합니다 (bot:<key> / persona:<key> / module)")
    return owner


def combo(owner: str) -> list[str]:
    """The module ids opened with this owner last time, in tab order."""
    r = db.one("SELECT value FROM meta WHERE key = ?", (_COMBO + _owner_ok(owner),))
    ids = db.unjs(r["value"], []) if r else []
    return [str(i) for i in ids if i] if isinstance(ids, list) else []


def set_combo(owner: str, ids: list) -> list[str]:
    clean: list[str] = []
    for i in ids or []:
        s = str(i or "").strip()
        if s and s not in clean:
            clean.append(s)
    db.execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
               (_COMBO + _owner_ok(owner), db.js(clean[:40])))
    return clean


# --- files ---------------------------------------------------------------------------

def rpack_encode(data: bytes) -> bytes:
    return data.translate(_ENCODE)


def rpack_decode(data: bytes) -> bytes:
    return data.translate(_DECODE)


def read_risum(blob: bytes) -> tuple[dict, list[bytes]]:
    """(module JSON, asset blobs in order) of a .risum (modules.ts readModule)."""
    if len(blob) < 6 or blob[0] != 111:
        raise ModuleError("risum 파일이 아닙니다 (매직 넘버가 다릅니다)")
    if blob[1] != 0:
        raise ModuleError(f"지원하지 않는 risum 버전입니다: {blob[1]}")
    pos = 2
    (n,) = struct.unpack_from("<I", blob, pos)
    pos += 4
    main = json.loads(rpack_decode(blob[pos:pos + n]).decode("utf-8"))
    pos += n
    if not isinstance(main, dict) or main.get("type") != "risuModule" or not isinstance(main.get("module"), dict):
        raise ModuleError("risum 안의 데이터가 모듈이 아닙니다")
    blobs: list[bytes] = []
    while pos < len(blob):
        mark = blob[pos]
        pos += 1
        if mark == 0:
            break
        if mark != 1:
            raise ModuleError("risum 에셋 영역이 깨졌습니다")
        (n,) = struct.unpack_from("<I", blob, pos)
        pos += 4
        blobs.append(rpack_decode(blob[pos:pos + n]))
        pos += n
    return main["module"], blobs


def write_risum(module: dict, blobs: list[bytes]) -> bytes:
    """modules.ts exportModuleLegacy: asset keys are blanked, the bytes follow."""
    m = json.loads(json.dumps(module))
    m["assets"] = [[a[0], "", a[2] if len(a) > 2 else "png"] for a in (m.get("assets") or [])
                   if isinstance(a, list) and a]
    main = rpack_encode(json.dumps({"module": m, "type": "risuModule"}, ensure_ascii=False, indent=2).encode("utf-8"))
    out = bytearray([111, 0])
    out += struct.pack("<I", len(main)) + main
    for b in blobs:
        enc = rpack_encode(b)
        out += bytes([1]) + struct.pack("<I", len(enc)) + enc
    out += bytes([0])
    return bytes(out)


def _ext_of(data: bytes, fallback: str = "png") -> str:
    if data.startswith(b"\x89PNG"):
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    return fallback or "bin"


def _stage(data: bytes, ext: str) -> str:
    """Bytes into the store under a pending key the plugin turns into a real
    RisuAI asset when it imports (same as a studio adoption)."""
    ext = "".join(c for c in (ext or "png").lower() if c.isalnum())[:8] or "png"
    key = assets.PENDING_PREFIX + hashlib.sha256(data).hexdigest() + "." + ext
    assets.store_bytes(key, data)
    return key


def _charx_module(z: zipfile.ZipFile) -> dict:
    """A module from a charx: RisuAI exports a module as the charx of the
    converted character (exportModule), and convertCharacterToModule reads it."""
    try:
        card = json.loads(z.read("card.json"))
    except KeyError as e:
        raise ModuleError("charx 안에 card.json 이 없습니다") from e
    data = card.get("data") if isinstance(card, dict) else None
    if not isinstance(data, dict):
        raise ModuleError("charx card.json 의 형식을 모르겠습니다")
    ext = (data.get("extensions") or {}).get("risuai") or {}
    names = set(z.namelist())
    lore = []
    for e in ((data.get("character_book") or {}).get("entries") or []):
        if not isinstance(e, dict):
            continue
        x = dict(e.get("extensions") or {})
        entry = {
            "key": ", ".join(k for k in (e.get("keys") or []) if k) if isinstance(e.get("keys"), list) else str(e.get("keys") or ""),
            "secondkey": ", ".join(k for k in (e.get("secondary_keys") or []) if k) if isinstance(e.get("secondary_keys"), list) else "",
            "insertorder": e.get("insertion_order", 100), "comment": e.get("name") or e.get("comment") or "",
            "content": e.get("content") or "", "mode": e.get("mode") or "normal",
            "alwaysActive": bool(e.get("constant")), "selective": bool(e.get("selective")),
            "useRegex": bool(e.get("use_regex")),
        }
        if e.get("folder"):
            entry["folder"] = e["folder"]
        if x.get("risu_activationPercent") is not None:
            entry["activationPercent"] = x.pop("risu_activationPercent")
        x.pop("risu_loreCache", None)
        if e.get("case_sensitive"):
            x["risu_case_sensitive"] = True
        if x:
            entry["extentions"] = x
        lore.append(entry)
    module_assets: list[list[str]] = []
    icon = ""
    for a in data.get("assets") or []:
        if not isinstance(a, dict):
            continue
        uri = str(a.get("uri") or "")
        if not uri.startswith("embeded://"):
            continue
        path = uri[len("embeded://"):]
        if path not in names:
            raise ModuleError(f"charx 안에 에셋 파일이 없습니다: {path}")
        blob = z.read(path)
        key = _stage(blob, str(a.get("ext") or _ext_of(blob)))
        if a.get("type") == "icon" and a.get("name") == "main":
            icon = key
        else:
            module_assets.append([str(a.get("name") or ""), key, str(a.get("ext") or _ext_of(blob))])
    module: dict[str, Any] = {
        "name": data.get("name") or "", "description": data.get("creator_notes") or "",
        "lorebook": lore, "regex": ext.get("customScripts") or [], "trigger": ext.get("triggerscript") or [],
        "lowLevelAccess": bool(ext.get("lowLevelAccess")), "hideIcon": bool(ext.get("hideChatIcon")),
        "backgroundEmbedding": ext.get("backgroundHTML") or "", "assets": module_assets,
        "customModuleToggle": ext.get("toggles") if isinstance(ext.get("toggles"), str) else "",
    }
    if ext.get("moduleNamespace"):
        module["namespace"] = ext["moduleNamespace"]
    if icon:
        module["icon"] = icon
    # The fields convertCharacterToModule folds into lorebook markers.
    if data.get("description"):
        module["lorebook"].append({"key": "", "secondkey": "", "insertorder": 0, "comment": "From Character Description",
                                   "content": "@@indicator character_desc\n\n" + str(data["description"]),
                                   "mode": "constant", "alwaysActive": True, "selective": False})
    if "module.risum" in names:
        # A bot charx exported by RisuAI moves its scripts into an embedded module.
        inner, blobs = read_risum(z.read("module.risum"))
        module["regex"] = module["regex"] or inner.get("regex") or []
        module["trigger"] = module["trigger"] or inner.get("trigger") or []
        if not module["lorebook"]:
            module["lorebook"] = inner.get("lorebook") or []
    return module


def parse_file(rel: str) -> dict:
    """A module file in the space -> {module, assets, file}, its asset bytes in
    the store under pending keys (the plugin's import resolves them)."""
    from . import files
    p = files._resolve(files.SPACE, rel)
    if not p.is_file():
        raise ModuleError(f"파일이 없습니다: {rel}")
    name = p.name.lower()
    blob = p.read_bytes()
    if name.endswith(".risum"):
        module, blobs = read_risum(blob)
        out_assets = []
        for i, a in enumerate(module.get("assets") or []):
            if not isinstance(a, list) or not a:
                continue
            data = blobs[i] if i < len(blobs) else b""
            if not data:
                continue
            ext = str(a[2]) if len(a) > 2 and a[2] else _ext_of(data)
            out_assets.append([str(a[0] or ""), _stage(data, ext), ext])
        module["assets"] = out_assets
    elif name.endswith(".charx") or blob[:2] == b"PK":
        import io
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            module = _charx_module(z)
    elif name.endswith(".json"):
        try:
            data = json.loads(blob.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            raise ModuleError(f"JSON 을 읽지 못했습니다: {e}") from e
        if isinstance(data, dict) and data.get("type") == "risuModule" and isinstance(data.get("module"), dict):
            module = data["module"]
        elif isinstance(data, dict) and data.get("type") == "risuModule":
            module = {k: v for k, v in data.items() if k != "type"}
        else:
            raise ModuleError("risuModule 형식의 JSON 이 아닙니다")
    else:
        raise ModuleError("모듈 파일은 .risum · .charx · .json 이어야 합니다")
    if module.get("mcp"):
        raise ModuleError("MCP 모듈은 가져올 수 없습니다")
    module.pop("id", None)
    summary = {"name": module.get("name") or p.stem, "lore": len(module.get("lorebook") or []),
               "regex": len(module.get("regex") or []), "trigger": len(module.get("trigger") or []),
               "assets": len(module.get("assets") or []), "lowLevelAccess": bool(module.get("lowLevelAccess"))}
    module["name"] = summary["name"]
    log.info("module parse %s %s", rel, summary)
    return {"module": module, "summary": summary, "file": rel}


def working_module(ck: str) -> dict:
    """The working copy as a RisuAI module (over the last-read original)."""
    from . import charx
    if not is_module_key(ck):
        raise ModuleError("모듈 작업본이 아닙니다")
    char = charx.working_character(ck)
    meta = _meta_get(ck)
    return from_card(char, {"id": meta.get("id") or char.get("chaId") or ""})


def export(ck: str, fmt: str, *, filename: str = "", allow_missing: bool = False) -> dict:
    """Write the working copy as `<name>.risum` or `<name>.module.charx` into
    the module's project out/ folder."""
    from . import charx
    fmt = (fmt or "charx").lower().lstrip(".")
    if fmt not in ("charx", "risum"):
        raise ModuleError("형식은 charx 또는 risum 입니다")
    module = working_module(ck)
    base = charx._safe_filename(filename or str(module.get("name") or "module"))
    for tail in (".risum", ".charx", ".module"):
        if base.lower().endswith(tail):
            base = base[: -len(tail)]
    if fmt == "charx":
        r = charx.build(ck, allow_missing=allow_missing, filename=base + ".module.charx")
        return {**r, "format": "charx"}
    blobs: list[bytes] = []
    missing: list[dict] = []
    kept: list[list] = []
    for a in module.get("assets") or []:
        got = assets.read_bytes(str(a[1] or "")) if isinstance(a, list) and len(a) > 1 else None
        if got is None:
            missing.append({"name": a[0] if isinstance(a, list) and a else "", "key": a[1] if isinstance(a, list) and len(a) > 1 else ""})
            continue
        kept.append(a)
        blobs.append(got[0])
    if missing and not allow_missing:
        return {"ok": False, "charKey": ck, "missing": missing, "assets": len(module.get("assets") or []),
                "hint": "에셋 동기화를 끝내거나, allowMissing 으로 빠진 항목을 제외하고 만들 수 있습니다"}
    module["assets"] = kept
    module.pop("icon", None)  # a risum carries no icon (exportModuleLegacy)
    data = write_risum(module, blobs)
    out_dir = workspace.out_dir(ck)
    target = out_dir / (base + ".risum")
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(target)
    rel = f"{workspace.out_rel(ck)}/{target.name}"
    log.info("module risum key=%s file=%s assets=%s bytes=%s", ck, target.name, len(kept), len(data))
    return {"ok": True, "charKey": ck, "format": "risum", "file": target.name, "path": rel, "size": len(data),
            "assets": len(kept), "dropped": len(missing), "missing": missing if allow_missing else []}


def describe(r: dict) -> str:
    """One line per module for the agent."""
    bits = [f"로어북 {r['lore']}", f"Regex {r['regex']}", f"트리거 {r['trigger']}", f"에셋 {r['assets']}"]
    if r.get("toggles"):
        bits.append("토글 있음")
    if r.get("lowLevelAccess"):
        bits.append("저수준 접근")
    tail = f" · 미반영 {r['total']}" if r.get("total") else ""
    return f"- {r['name'] or '(이름 없음)'} key={r['key']} ({' · '.join(bits)}){tail}"

