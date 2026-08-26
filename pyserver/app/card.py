"""The character card as editable rows: prose fields and script items.

Bot editing follows the grammar chat editing already proved, one material at a
time. Card prose (desc, personality, greetings, ...) becomes `card_fields`
rows the way long-term memory became `memories` rows: one row is one thing a
person edits, `original` is the frozen baseline, and the diff is a string
comparison. Regex (customscript) and trigger (triggerscript) items become
`card_scripts` rows in `lore_entries`' grammar: whole-entry JSON with an
origin lifecycle, replaced whole so fields this module never modelled survive.

**There is deliberately no card shell.** Write-back does not reassemble a card
from parts the way memory.patch reassembles the hypa object - the plugin
re-reads the live character and overlays only the modelled fields, so every
unmodelled key (emotionImages, ccAssets, sdData, ...) rides along untouched.
`characters.card_json`, overwritten with the full card on every upload, is the
frozen reference copy, not a write-back source.
"""
from __future__ import annotations

import uuid
from typing import Any

from . import db, log, store

# Scalar prose fields, one row each at seq 0. Order here is display order.
#
# personality / scenario / exampleMessage / systemPrompt /
# postHistoryInstructions are NOT here on purpose: RisuAI keeps them only for
# card-import compatibility and its own editor no longer shows them
# (2026-08-24, user decision). They still ride along in card_json and survive
# every write-back - the overlay never touches a field without a row.
# backgroundHTML/backgroundCSS are card fields too (database.svelte.ts:1712,
# 1714) but the panel edits them on the Regex tab, next to the scripts that
# usually accompany them - the meta tab filters them out.
# replaceGlobalNote = RisuAI's "글로벌 노트 덮어쓰기" (post_history_instructions in a card).
SCALARS = ("name", "desc", "firstMessage", "creatorNotes", "characterVersion",
           "replaceGlobalNote", "backgroundHTML")
# backgroundCSS: RisuAI's UI has no field for it, so neither has this panel.
_RETIRED = ("personality", "scenario", "exampleMessage",
            "systemPrompt", "postHistoryInstructions", "backgroundCSS")
# characterVersion lives in two places on a RisuAI character: the UI edits
# `additionalData.character_version` (CharConfig.svelte), the importer also
# writes top-level `characterVersion`. Rows read the nested one; the write
# path sets both.
NESTED = {"characterVersion": ("additionalData", "character_version")}
# One row per greeting, seq = its index. Displayed right under firstMessage.
LIST_FIELD = "alternateGreetings"

# Asset references are card material too: emotionImages / additionalAssets /
# ccAssets are lists of (name, key[, ext]) the card carries, and the assets
# tab renames and removes entries in them. They ride in card_scripts under a
# kind of their own with the same lifecycle (original|edited|added|deleted)
# and go out in the same patch. Bytes are the asset store's business; this is
# only what the card says about them.
ASSET_KIND = "assetref"
SCRIPT_KINDS = ("customscript", "triggerscript", ASSET_KIND)


def scalar_of(card: dict, field: str) -> str:
    """A scalar's value on a character, nested ones included."""
    if field in NESTED:
        top, inner = NESTED[field]
        holder = card.get(top)
        v = holder.get(inner) if isinstance(holder, dict) else None
        if v in (None, ""):
            v = card.get(field)
        return "" if v is None else str(v)
    return str(card.get(field) or "")


def asset_entries(card: dict) -> list[dict]:
    """The card's asset references as assetref entries, in the order the
    assets tab shows them: emotion, additional, cc."""
    out: list[dict] = []
    for e in card.get("emotionImages") or []:
        if isinstance(e, list) and len(e) >= 2:
            out.append({"field": "emotion", "name": str(e[0] or ""), "key": str(e[1] or ""), "ext": "png"})
    for a in card.get("additionalAssets") or []:
        if isinstance(a, list) and len(a) >= 2:
            out.append({"field": "additional", "name": str(a[0] or ""), "key": str(a[1] or ""),
                        "ext": str(a[2]) if len(a) > 2 and a[2] else "png"})
    for c in card.get("ccAssets") or []:
        if isinstance(c, dict):
            out.append({"field": "cc", "name": str(c.get("name") or ""), "key": str(c.get("uri") or ""),
                        "ext": str(c.get("ext") or "png"), "type": str(c.get("type") or "asset")})
    return out


def asset_lists(entries: list[dict]) -> dict:
    """assetref entries back into the three character lists."""
    emotion: list = []
    additional: list = []
    cc: list = []
    for e in entries:
        f = e.get("field")
        if f == "emotion":
            emotion.append([e.get("name") or "", e.get("key") or ""])
        elif f == "cc":
            cc.append({"type": e.get("type") or "asset", "uri": e.get("key") or "",
                       "name": e.get("name") or "", "ext": e.get("ext") or "png"})
        else:
            additional.append([e.get("name") or "", e.get("key") or "", e.get("ext") or "png"])
    return {"emotionImages": emotion, "additionalAssets": additional, "ccAssets": cc}

# Whether the last upload carried the full character (vs the 13-field
# whitelist an older plugin sends). A patch built on whitelist-era rows may
# sit on baselines that never saw the real card, so write-back refuses it.
_FULL_KEY = "card_full:"


def set_full(ck: str, full: bool) -> None:
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_FULL_KEY + ck, "1" if full else "0"),
    )


def is_full(ck: str) -> bool:
    row = db.one("SELECT value FROM meta WHERE key = ?", (_FULL_KEY + ck,))
    return bool(row and row["value"] == "1")


def exists(ck: str) -> bool:
    return db.one("SELECT id FROM card_fields WHERE char_key = ? LIMIT 1", (ck,)) is not None


# --- ingest -----------------------------------------------------------------

def ingest(ck: str, card: dict, *, reset: bool) -> dict:
    """Load a card into rows.

    Same contract as memory.ingest: the panel re-uploads on every open, so
    with `reset` false the working text is left alone and only the baseline
    is refreshed - the user may have edited the card in RisuAI since, and a
    stale original makes the diff lie.
    """
    now = db.now()
    counts = {"fields": 0, "greetings": 0,
              "customscript": 0, "triggerscript": 0}

    # Rows for fields this schema no longer models (a deployed v8 DB made
    # them before the retirement) would otherwise haunt every listing.
    if _RETIRED:
        marks = ",".join("?" * len(_RETIRED))
        db.execute(
            f"DELETE FROM card_fields WHERE char_key = ? AND field IN ({marks})",
            (ck, *_RETIRED))

    field_rows: list[tuple[str, int, str]] = []
    for f in SCALARS:
        field_rows.append((f, 0, scalar_of(card, f)))
        counts["fields"] += 1
    greetings = card.get(LIST_FIELD)
    for i, g in enumerate(greetings if isinstance(greetings, list) else []):
        field_rows.append((LIST_FIELD, i, str(g or "")))
        counts["greetings"] += 1

    script_rows: list[tuple[str, int, dict]] = []
    for kind in SCRIPT_KINDS:
        items = asset_entries(card) if kind == ASSET_KIND else card.get(kind)
        for i, e in enumerate(items if isinstance(items, list) else []):
            if isinstance(e, dict):
                script_rows.append((kind, i, e))
                counts[kind] = counts.get(kind, 0) + 1

    if reset:
        db.execute("DELETE FROM card_fields WHERE char_key = ?", (ck,))
        db.executemany(
            "INSERT INTO card_fields(id, char_key, field, seq, body, original, "
            "extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [(uuid.uuid4().hex, ck, f, seq, body, body, None, now, now)
             for f, seq, body in field_rows],
        )
        db.execute("DELETE FROM card_scripts WHERE char_key = ?", (ck,))
        db.executemany(
            "INSERT INTO card_scripts(id, char_key, kind, seq, entry_json, "
            "original_json, origin, created_at) VALUES(?,?,?,?,?,?, 'original', ?)",
            [(uuid.uuid4().hex, ck, kind, seq, db.js(e), db.js(e), now)
             for kind, seq, e in script_rows],
        )
        log.info("card ingest char=%s %s reset", ck, counts)
        return {"charKey": ck, "counts": counts, "reset": True}

    added = rebased = 0
    for f, seq, body in field_rows:
        found = db.one(
            "SELECT id, original FROM card_fields WHERE char_key = ? AND field = ? AND seq = ?",
            (ck, f, seq))
        if found is None:
            db.execute(
                "INSERT INTO card_fields(id, char_key, field, seq, body, original, "
                "extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, ck, f, seq, body, body, None, now, now))
            added += 1
        elif (found["original"] or "") != body:
            db.execute(
                "UPDATE card_fields SET original = ?, updated_at = ? WHERE id = ?",
                (body, now, found["id"]))
            rebased += 1
    for kind, seq, e in script_rows:
        text = db.js(e)
        found = db.one(
            "SELECT id, original_json FROM card_scripts WHERE char_key = ? AND kind = ? AND seq = ?",
            (ck, kind, seq))
        if found is None:
            db.execute(
                "INSERT INTO card_scripts(id, char_key, kind, seq, entry_json, "
                "original_json, origin, created_at) VALUES(?,?,?,?,?,?, 'original', ?)",
                (uuid.uuid4().hex, ck, kind, seq, text, text, now))
            added += 1
        elif found["original_json"] != text:
            db.execute(
                "UPDATE card_scripts SET original_json = ? WHERE id = ?",
                (text, found["id"]))
            rebased += 1
    log.info("card refresh char=%s added=%s rebased=%s", ck, added, rebased)
    return {"charKey": ck, "counts": counts, "reset": False,
            "added": added, "rebased": rebased}


# --- fields -----------------------------------------------------------------

def _field_row(r) -> dict:
    d = db.row_to_dict(r) or {}
    body = d.get("body") or ""
    original = d.get("original")
    extra = db.unjs(d.get("extra_json"), {}) or {}
    return {
        "id": d.get("id"),
        "field": d.get("field") or "",
        "seq": int(d.get("seq") or 0),
        "body": body,
        "original": original,
        "changed": original is not None and original != body,
        "isNew": original is None,
        "deleted": bool(extra.get("deleted")),
        "updatedAt": d.get("updated_at"),
    }


def listing(ck: str) -> dict:
    rows = db.query(
        "SELECT * FROM card_fields WHERE char_key = ? ORDER BY field, seq", (ck,))
    items = [_field_row(r) for r in rows]
    # Declaration order with greetings tucked under firstMessage - the ORDER BY
    # above is alphabetical, which is nobody's mental model of a card.
    order = {f: i * 2 for i, f in enumerate(SCALARS)}
    order[LIST_FIELD] = order.get("firstMessage", len(order) * 2) + 1
    items.sort(key=lambda x: (order.get(x["field"], 99), x["seq"]))
    return {
        "charKey": ck,
        "full": is_full(ck),
        "fields": items,
        "changed": sum(1 for i in items if i["changed"] or i["isNew"] or i["deleted"]),
    }


def get_field(field_id: str) -> dict | None:
    r = db.one("SELECT * FROM card_fields WHERE id = ?", (field_id,))
    return _field_row(r) if r is not None else None


def update_field(field_id: str, body: str) -> dict:
    """Set the working text. Editing a deleted greeting revives it - touching
    a thing is the opposite of wanting it gone."""
    cur = get_field(field_id)
    if cur is None:
        raise LookupError("없는 카드 필드입니다")
    db.execute(
        "UPDATE card_fields SET body = ?, extra_json = NULL, updated_at = ? WHERE id = ?",
        (body, db.now(), field_id))
    return get_field(field_id) or {}


def add_greeting(ck: str, body: str) -> dict:
    r = db.one(
        "SELECT COALESCE(MAX(seq), -1) AS m FROM card_fields WHERE char_key = ? AND field = ?",
        (ck, LIST_FIELD))
    seq = int((r["m"] if r else -1) or -1) + 1
    fid = uuid.uuid4().hex
    now = db.now()
    # original stays NULL: no frozen counterpart is what marks it as added.
    db.execute(
        "INSERT INTO card_fields(id, char_key, field, seq, body, original, "
        "extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (fid, ck, LIST_FIELD, seq, body, None, None, now, now))
    return get_field(fid) or {}


def delete_greeting(field_id: str) -> dict:
    """An added greeting is simply gone; an original one is marked, so the
    change summary can say so and the write-back knows to omit it."""
    cur = get_field(field_id)
    if cur is None or cur["field"] != LIST_FIELD:
        raise LookupError("없는 인사말입니다")
    if cur["isNew"]:
        db.execute("DELETE FROM card_fields WHERE id = ?", (field_id,))
        return {"deleted": field_id, "kept": False}
    db.execute(
        "UPDATE card_fields SET extra_json = ?, updated_at = ? WHERE id = ?",
        (db.js({"deleted": True}), db.now(), field_id))
    return {"deleted": field_id, "kept": True}


# --- scripts ----------------------------------------------------------------

def _script_row(r) -> dict:
    d = db.row_to_dict(r) or {}
    return {
        "id": d.get("id"),
        "kind": d.get("kind") or "",
        "seq": int(d.get("seq") or 0),
        "origin": d.get("origin") or "original",
        "entry": db.unjs(d.get("entry_json"), {}),
    }


def scripts(ck: str, kind: str) -> list[dict]:
    if kind not in SCRIPT_KINDS:
        raise ValueError(f"모르는 스크립트 종류입니다: {kind}")
    return [
        _script_row(r)
        for r in db.query(
            "SELECT * FROM card_scripts WHERE char_key = ? AND kind = ? "
            "AND origin <> 'deleted' ORDER BY seq", (ck, kind))
    ]


def script_entry(script_id: str) -> dict | None:
    row = db.one("SELECT * FROM card_scripts WHERE id = ? AND origin <> 'deleted'", (script_id,))
    return _script_row(row) if row is not None else None


def update_script(script_id: str, entry: dict) -> dict:
    """Replace one item whole - same reasoning as store.update_lore: items
    carry fields we do not model, and a merge would have to know them all."""
    row = db.one("SELECT * FROM card_scripts WHERE id = ? AND origin <> 'deleted'", (script_id,))
    if row is None:
        raise LookupError("없는 스크립트 항목입니다")
    text = db.js(entry)
    if row["origin"] == "added":
        origin = "added"
    elif row["original_json"] is not None and row["original_json"] == text:
        origin = "original"
    else:
        origin = "edited"
    db.execute("UPDATE card_scripts SET entry_json = ?, origin = ? WHERE id = ?",
               (text, origin, script_id))
    return {"id": script_id, "entry": entry, "origin": origin}


def add_script(ck: str, kind: str, entry: dict) -> str:
    if kind not in SCRIPT_KINDS:
        raise ValueError(f"모르는 스크립트 종류입니다: {kind}")
    row = db.one(
        "SELECT COALESCE(MAX(seq), -1) AS m FROM card_scripts WHERE char_key = ? AND kind = ?",
        (ck, kind))
    seq = int((row["m"] if row else -1) or -1) + 1
    sid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO card_scripts(id, char_key, kind, seq, entry_json, origin, created_at) "
        "VALUES(?,?,?,?,?, 'added', ?)",
        (sid, ck, kind, seq, db.js(entry), db.now()))
    return sid


def delete_script(script_id: str) -> int:
    row = db.one("SELECT origin FROM card_scripts WHERE id = ?", (script_id,))
    if row is None or row["origin"] == "deleted":
        return 0
    if row["origin"] == "added":
        return db.execute("DELETE FROM card_scripts WHERE id = ?", (script_id,)).rowcount or 0
    return db.execute("UPDATE card_scripts SET origin = 'deleted' WHERE id = ?",
                      (script_id,)).rowcount or 0


def move_script(script_id: str, to_seq: int) -> dict:
    """Reorder within the item's kind. Order is meaning for regex - later
    scripts see earlier scripts' output - so this is part of editing, not
    cosmetics. Dense renumber, same policy as turns."""
    row = db.one("SELECT * FROM card_scripts WHERE id = ? AND origin <> 'deleted'", (script_id,))
    if row is None:
        raise LookupError("없는 스크립트 항목입니다")
    ck, kind = row["char_key"], row["kind"]
    ids = [r["id"] for r in db.query(
        "SELECT id FROM card_scripts WHERE char_key = ? AND kind = ? AND origin <> 'deleted' "
        "ORDER BY seq", (ck, kind))]
    ids.remove(script_id)
    pos = max(0, min(int(to_seq), len(ids)))
    ids.insert(pos, script_id)
    for i, sid in enumerate(ids):
        db.execute("UPDATE card_scripts SET seq = ? WHERE id = ?", (i, sid))
    return {"id": script_id, "seq": pos}


def rename_assets(ck: str, mode: str, pattern: str = "", repl: str = "",
                  fields: tuple[str, ...] | None = None) -> dict:
    """Bulk-rename asset references in the working copy.

    mode 'strip-ext'  'face.png' -> 'face' (a trailing .<ext> of 1-8 chars)
    mode 'regex'      re.sub(pattern, repl, name)
    Names are what CBS and emotion detection look up, so this is a card
    edit like any other: rows move to 'edited' and go out on 반영.
    """
    import re as _re
    if mode not in ("strip-ext", "regex"):
        raise ValueError("mode 는 strip-ext 또는 regex 여야 합니다")
    rx = None
    if mode == "regex":
        try:
            rx = _re.compile(pattern)
        except _re.error as e:
            raise ValueError(f"정규식 오류: {e}")
    changed = 0
    for row in scripts(ck, ASSET_KIND):
        e = dict(row["entry"])
        if fields and e.get("field") not in fields:
            continue
        name = str(e.get("name") or "")
        if mode == "strip-ext":
            new = _re.sub(r"\.[A-Za-z0-9]{1,8}$", "", name)
        else:
            new = rx.sub(repl, name) if rx else name
        if new == name or not new:
            continue
        e["name"] = new
        update_script(row["id"], e)
        changed += 1
    return {"changed": changed}


# --- diff / write-back / baseline -------------------------------------------

def changes(ck: str) -> dict:
    """What a card write-back would change, as counts for the bot bar."""
    fields = greet_edit = greet_add = greet_del = 0
    for r in db.query("SELECT * FROM card_fields WHERE char_key = ?", (ck,)):
        row = _field_row(r)
        if row["field"] == LIST_FIELD:
            if row["deleted"]:
                greet_del += 1
            elif row["isNew"]:
                greet_add += 1
            elif row["changed"]:
                greet_edit += 1
        elif row["changed"]:
            fields += 1
    out: dict[str, Any] = {
        "fields": fields,
        "greetings": {"added": greet_add, "edited": greet_edit, "deleted": greet_del,
                      "total": greet_add + greet_edit + greet_del},
    }
    for kind in SCRIPT_KINDS:
        counts = {"added": 0, "edited": 0, "deleted": 0}
        for r in db.query(
                "SELECT origin FROM card_scripts WHERE char_key = ? AND kind = ?", (ck, kind)):
            if r["origin"] in counts:
                counts[r["origin"]] += 1
        counts["total"] = counts["added"] + counts["edited"] + counts["deleted"]
        out[kind] = counts
    out["lore"] = store.lore_changes_global(ck)
    out["total"] = (fields + out["greetings"]["total"] + out["customscript"]["total"]
                    + out["triggerscript"]["total"] + out[ASSET_KIND]["total"] + out["lore"]["total"])
    return out


def patch(ck: str) -> dict:
    """Everything one card write-back sends, in one response.

    Changed scalars come as before/after pairs so the host can verify each
    live value against `before` and refuse a stale snapshot. The three list
    materials (greetings, global lore, scripts) are whole lists - the same
    acceptance the chat path already gives localLore.
    """
    char = db.one("SELECT cha_id FROM characters WHERE char_key = ?", (ck,))
    fields = []
    greet_rows: list[tuple[int, str]] = []
    greet_changed = False
    rows = db.query("SELECT * FROM card_fields WHERE char_key = ? ORDER BY field, seq", (ck,))
    for r in rows:
        row = _field_row(r)
        if row["field"] == LIST_FIELD:
            if row["deleted"]:
                greet_changed = True
                continue
            greet_rows.append((row["seq"], row["body"]))
            if row["changed"] or row["isNew"]:
                greet_changed = True
        elif row["changed"]:
            fields.append({"field": row["field"], "before": row["original"] or "",
                           "after": row["body"]})
    greetings_list = [b for _s, b in sorted(greet_rows)]

    lore_counts = store.lore_changes_global(ck)
    out: dict[str, Any] = {
        "charKey": ck,
        "chaId": (char["cha_id"] if char else "") or "",
        "full": is_full(ck),
        "fields": fields,
        "alternateGreetings": {"changed": greet_changed, "list": greetings_list},
        "globalLore": {"changed": lore_counts["total"],
                       "list": [x["entry"] for x in store.lore(ck, "global")]},
    }
    total = len(fields) + (1 if greet_changed else 0) + lore_counts["total"]
    for kind in SCRIPT_KINDS:
        counts = {"added": 0, "edited": 0, "deleted": 0}
        for r in db.query("SELECT origin FROM card_scripts WHERE char_key = ? AND kind = ?",
                          (ck, kind)):
            if r["origin"] in counts:
                counts[r["origin"]] += 1
        n = counts["added"] + counts["edited"] + counts["deleted"]
        out[kind] = {"changed": n, "list": [x["entry"] for x in scripts(ck, kind)]}
        total += n
    # The asset references go out as the three character lists RisuAI keeps,
    # rebuilt from the working entries - the plugin writes lists, never rows.
    out["assets"] = {"changed": out[ASSET_KIND]["changed"],
                     **asset_lists([x["entry"] for x in scripts(ck, ASSET_KIND)])}
    out["total"] = total
    return out


def rebase(ck: str) -> dict:
    """Working copy becomes the baseline, after the host confirmed the write.

    Same contract as store.rebase_original: never automatic on write - only
    the client knows the write landed. Global lore is rebased by the caller
    (store.rebase_lore_global), keeping the same shape h_commit has.
    """
    # Exact-string match on the marker delete_greeting wrote: json_extract
    # would be cleaner but JSON1 is not guaranteed on the SQLite 3.31 floor.
    deleted = db.execute(
        "DELETE FROM card_fields WHERE char_key = ? AND extra_json = ?",
        (ck, db.js({"deleted": True}))).rowcount or 0
    fields = db.execute(
        "UPDATE card_fields SET original = body WHERE char_key = ? AND "
        "(original IS NULL OR original <> body)", (ck,)).rowcount or 0
    s_del = db.execute(
        "DELETE FROM card_scripts WHERE char_key = ? AND origin = 'deleted'", (ck,)).rowcount or 0
    s_norm = db.execute(
        "UPDATE card_scripts SET origin = 'original', original_json = entry_json "
        "WHERE char_key = ? AND origin <> 'original'", (ck,)).rowcount or 0
    log.info("card rebase char=%s fields=%s greet_del=%s scripts=%s+%s",
             ck, fields, deleted, s_norm, s_del)
    return {"fields": fields, "greetingsDeleted": deleted, "scripts": s_norm + s_del}


def reset_working(ck: str) -> dict:
    """Back to the baseline: added rows go, everything else returns to its
    original. Global lore is reset by the caller (store.reset_lore_global)."""
    added = db.execute(
        "DELETE FROM card_fields WHERE char_key = ? AND original IS NULL", (ck,)).rowcount or 0
    fields = db.execute(
        "UPDATE card_fields SET body = original, extra_json = NULL "
        "WHERE char_key = ? AND (body <> original OR extra_json IS NOT NULL)", (ck,)).rowcount or 0
    s_added = db.execute(
        "DELETE FROM card_scripts WHERE char_key = ? AND origin = 'added'", (ck,)).rowcount or 0
    s_rest = db.execute(
        "UPDATE card_scripts SET entry_json = original_json, origin = 'original' "
        "WHERE char_key = ? AND origin <> 'original' AND original_json IS NOT NULL",
        (ck,)).rowcount or 0
    return {"fields": fields + added, "scripts": s_added + s_rest}


# --- checkpoints ------------------------------------------------------------

def rows_for_checkpoint(ck: str) -> dict:
    """Whole rows, ids included - agent proposals point at ids, and a restore
    must leave them pointing at the same things."""
    return {
        "fields": [dict(db.row_to_dict(r) or {}) for r in db.query(
            "SELECT * FROM card_fields WHERE char_key = ? ORDER BY field, seq", (ck,))],
        "scripts": [dict(db.row_to_dict(r) or {}) for r in db.query(
            "SELECT * FROM card_scripts WHERE char_key = ? ORDER BY kind, seq", (ck,))],
    }


def restore_rows(ck: str, snap: dict) -> dict:
    fields = list(snap.get("fields") or [])
    scripts_ = list(snap.get("scripts") or [])
    db.execute("DELETE FROM card_fields WHERE char_key = ?", (ck,))
    if fields:
        cols = ("id", "char_key", "field", "seq", "body", "original",
                "extra_json", "created_at", "updated_at")
        db.executemany(
            f"INSERT INTO card_fields({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
            [tuple(ck if c == "char_key" else r.get(c) for c in cols) for r in fields])
    db.execute("DELETE FROM card_scripts WHERE char_key = ?", (ck,))
    if scripts_:
        cols = ("id", "char_key", "kind", "seq", "entry_json", "original_json",
                "origin", "created_at")
        db.executemany(
            f"INSERT INTO card_scripts({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
            [tuple(ck if c == "char_key" else r.get(c) for c in cols) for r in scripts_])
    return {"fields": len(fields), "scripts": len(scripts_)}
