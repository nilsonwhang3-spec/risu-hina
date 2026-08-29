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

from . import db, log, merge, store

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
            "INSERT INTO card_fields(id, char_key, field, seq, base_seq, body, original, "
            "conflict_json, extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)",
            [(uuid.uuid4().hex, ck, f, seq, seq, body, body, None, now, now)
             for f, seq, body in field_rows],
        )
        db.execute("DELETE FROM card_scripts WHERE char_key = ?", (ck,))
        db.executemany(
            "INSERT INTO card_scripts(id, char_key, kind, seq, base_seq, entry_json, "
            "original_json, origin, conflict_json, created_at) VALUES(?,?,?,?,?,?,?,'original',NULL,?)",
            [(uuid.uuid4().hex, ck, kind, seq, seq, db.js(e), db.js(e), now)
             for kind, seq, e in script_rows],
        )
        log.info("card ingest char=%s %s reset", ck, counts)
        return {"charKey": ck, "counts": counts, "reset": True}

    merged = _merge_card(ck, card, field_rows, script_rows, now)
    log.info("card refresh char=%s %s", ck, merged or "no change")
    return {"charKey": ck, "counts": counts, "reset": False, "merge": merged}


def _merge_card(ck: str, card: dict, field_rows: list, script_rows: list, now: float) -> dict[str, int]:
    """Three-way merge of the card on re-open (app/merge.py).

    The old code moved only the baseline and left the working copy behind, so
    a field the user changed in RisuAI came back as "edited here" with the
    diff inverted - and `patch` then shipped the stale text as an edit whose
    `before` matched live, which is how a write-back silently reverted the
    user's own RisuAI edit.

    Scalars are addressed by name. Greetings and scripts are lists, and index
    addressing is what made one insertion in RisuAI rebase every later row
    onto its neighbour, so they go through the matcher instead.
    """
    out: dict[str, int] = {}
    scalars = [(f, seq, body) for f, seq, body in field_rows if f != LIST_FIELD]
    added = rebased = 0
    for f, seq, body in scalars:
        found = db.one(
            "SELECT id, body, original, conflict_json FROM card_fields WHERE char_key = ? AND field = ? AND seq = ?",
            (ck, f, seq))
        if found is None:
            db.execute(
                "INSERT INTO card_fields(id, char_key, field, seq, base_seq, body, original, "
                "conflict_json, extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,NULL,?,?,?)",
                (uuid.uuid4().hex, ck, f, seq, seq, body, body, None, now, now))
            added += 1
            continue
        row = merge.Row(id=found["id"], ours=found["body"] or "",
                        base=found["original"], dirty=False)
        if row.base is None:
            # Cannot happen for a scalar (ingest always writes both), but a
            # half-finished older ingest could leave one. Take RisuAI's.
            db.execute("UPDATE card_fields SET original = ?, updated_at = ? WHERE id = ?",
                       (body, now, found["id"]))
            continue
        op = merge.decide(row, body, merge.TIER_KEYED)
        if op.action == merge.ADOPT:
            db.execute("UPDATE card_fields SET body = ?, original = ?, base_seq = ?, "
                       "conflict_json = NULL, updated_at = ? WHERE id = ?",
                       (body, body, seq, now, found["id"]))
            out[merge.ADOPT] = out.get(merge.ADOPT, 0) + 1
        elif op.action == merge.CONFLICT:
            db.execute("UPDATE card_fields SET original = ?, base_seq = ?, conflict_json = ?, "
                       "updated_at = ? WHERE id = ?",
                       (body, seq, db.js(op.conflict), now, found["id"]))
            out[merge.CONFLICT] = out.get(merge.CONFLICT, 0) + 1
        else:
            if (found["original"] or "") != body:
                db.execute("UPDATE card_fields SET original = ?, base_seq = ?, updated_at = ? WHERE id = ?",
                           (body, seq, now, found["id"]))
                rebased += 1
            out[merge.KEEP] = out.get(merge.KEEP, 0) + 1

    _merge_greetings(ck, [body for f, _, body in field_rows if f == LIST_FIELD], now, out)
    for kind in SCRIPT_KINDS:
        _merge_scripts(ck, kind, [e for k, _, e in script_rows if k == kind], now, out)
    if added:
        out["added"] = added
    return {k: v for k, v in out.items() if v}


def _merge_greetings(ck: str, greetings: list[str], now: float, out: dict) -> None:
    rows = [db.row_to_dict(r) for r in db.query(
        "SELECT * FROM card_fields WHERE char_key = ? AND field = ? ORDER BY COALESCE(base_seq, seq)",
        (ck, LIST_FIELD))]
    based, extra = [], []
    for r in rows:
        deleted = db.unjs(r["extra_json"], {}) == {"deleted": True}
        if r["original"] is None:
            extra.append(merge.Row(id=r["id"], ours=r["body"] or "", base=None, dirty=True))
        else:
            based.append(merge.Row(id=r["id"], ours=r["body"] or "", base=r["original"],
                                   dirty=deleted, order=r["base_seq"] if r["base_seq"] is not None else r["seq"]))
    ops = merge.plan(based, greetings, merge.GREETING)
    same = merge.adopted_additions(extra, [o for o in ops if o.action == merge.INSERT], merge.GREETING)
    folded = {id(o) for o in same.values()}
    seq = max([int(r["seq"]) for r in rows], default=-1)
    for op in ops:
        out[op.action] = out.get(op.action, 0) + 1
        if op.action == merge.INSERT:
            if id(op) in folded:
                continue
            seq += 1
            db.execute(
                "INSERT INTO card_fields(id, char_key, field, seq, base_seq, body, original, "
                "conflict_json, extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?)",
                (uuid.uuid4().hex, ck, LIST_FIELD, seq, op.seq, op.theirs, op.theirs, now, now))
        elif op.action == merge.DELETE:
            db.execute("DELETE FROM card_fields WHERE id = ?", (op.row.id,))
        elif op.action == merge.ADOPT:
            db.execute("UPDATE card_fields SET body = ?, original = ?, base_seq = ?, "
                       "conflict_json = NULL, updated_at = ? WHERE id = ?",
                       (op.theirs, op.theirs, op.seq, now, op.row.id))
        elif op.action == merge.CONFLICT:
            db.execute("UPDATE card_fields SET original = COALESCE(?, original), base_seq = ?, "
                       "conflict_json = ?, updated_at = ? WHERE id = ?",
                       (op.theirs, op.seq, db.js(op.conflict), now, op.row.id))
        else:
            db.execute("UPDATE card_fields SET original = COALESCE(?, original), base_seq = ?, "
                       "updated_at = ? WHERE id = ?", (op.theirs, op.seq, now, op.row.id))
    for row_id, op in same.items():
        db.execute("UPDATE card_fields SET original = ?, base_seq = ?, updated_at = ? WHERE id = ?",
                   (op.theirs, op.seq, now, row_id))


_SPECS = {"customscript": merge.REGEX, "triggerscript": merge.TRIGGER}


def _merge_scripts(ck: str, kind: str, entries: list[dict], now: float, out: dict) -> None:
    spec = _SPECS.get(kind, merge.ASSET)
    rows = [db.row_to_dict(r) for r in db.query(
        "SELECT * FROM card_scripts WHERE char_key = ? AND kind = ? ORDER BY COALESCE(base_seq, seq)",
        (ck, kind))]
    based, extra = [], []
    for r in rows:
        if r["original_json"] is None:
            extra.append(merge.Row(id=r["id"], ours=db.unjs(r["entry_json"], {}), base=None, dirty=True))
        else:
            based.append(merge.Row(id=r["id"], ours=db.unjs(r["entry_json"], {}),
                                   base=db.unjs(r["original_json"], None),
                                   dirty=r["origin"] != "original",
                                   order=r["base_seq"] if r["base_seq"] is not None else r["seq"]))
    ops = merge.plan(based, entries, spec)
    same = merge.adopted_additions(extra, [o for o in ops if o.action == merge.INSERT], spec)
    folded = {id(o) for o in same.values()}
    seq = max([int(r["seq"]) for r in rows], default=-1)
    for op in ops:
        out[op.action] = out.get(op.action, 0) + 1
        text = db.js(op.theirs) if op.theirs is not None else None
        if op.action == merge.INSERT:
            if id(op) in folded:
                continue
            seq += 1
            db.execute(
                "INSERT INTO card_scripts(id, char_key, kind, seq, base_seq, entry_json, "
                "original_json, origin, conflict_json, created_at) VALUES(?,?,?,?,?,?,?,'original',NULL,?)",
                (uuid.uuid4().hex, ck, kind, seq, op.seq, text, text, now))
        elif op.action == merge.DELETE:
            db.execute("DELETE FROM card_scripts WHERE id = ?", (op.row.id,))
        elif op.action == merge.ADOPT:
            db.execute("UPDATE card_scripts SET entry_json = ?, original_json = ?, base_seq = ?, "
                       "origin = 'original', conflict_json = NULL WHERE id = ?",
                       (text, text, op.seq, op.row.id))
        elif op.action == merge.CONFLICT:
            db.execute("UPDATE card_scripts SET original_json = COALESCE(?, original_json), "
                       "base_seq = ?, conflict_json = ? WHERE id = ?",
                       (text, op.seq, db.js(op.conflict), op.row.id))
        else:
            db.execute("UPDATE card_scripts SET original_json = COALESCE(?, original_json), "
                       "base_seq = ? WHERE id = ?", (text, op.seq, op.row.id))
    for row_id, op in same.items():
        db.execute("UPDATE card_scripts SET original_json = ?, base_seq = ?, origin = 'original' WHERE id = ?",
                   (db.js(op.theirs), op.seq, row_id))


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
        "conflict": db.unjs(d.get("conflict_json"), None),
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
        "conflict": db.unjs(d.get("conflict_json"), None),
        # The frozen counterpart, for the panel's diff view - edited or
        # conflicted rows, which are the two cases where the sides differ.
        "original": (db.unjs(d.get("original_json"), None)
                     if ((d.get("origin") == "edited" or d.get("conflict_json")) and d.get("original_json")) else None),
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
    live value against `before` and refuse a stale snapshot. The list
    materials go out whole, and since 0.9 they carry a `before` too: the
    baseline list, in the order RisuAI last showed it. Without it a list was
    replaced with no comparison at all, so an entry the user added in RisuAI
    while the panel was open disappeared with no error and no warning.

    `before` is ordered by `base_seq`, never by `seq`: `seq` is the working
    order and the panel's move buttons renumber it.
    """
    char = db.one("SELECT cha_id FROM characters WHERE char_key = ?", (ck,))
    fields = []
    greet_rows: list[tuple[int, str]] = []
    greet_changed = False
    rows = db.query("SELECT * FROM card_fields WHERE char_key = ? ORDER BY field, seq", (ck,))
    greet_before: list[tuple[int, str]] = []
    for r in rows:
        row = _field_row(r)
        d = db.row_to_dict(r) or {}
        if row["field"] == LIST_FIELD:
            # The baseline list includes a greeting queued for deletion (RisuAI
            # still has it) and excludes one added here (RisuAI does not).
            if row["original"] is not None:
                greet_before.append((_order(d), row["original"]))
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
        "alternateGreetings": {"changed": greet_changed, "list": greetings_list,
                               "before": [b for _s, b in sorted(greet_before)]},
        "globalLore": {"changed": lore_counts["total"],
                       "list": [x["entry"] for x in store.lore(ck, "global")],
                       "before": store.lore_baseline(ck, "global")},
    }
    total = len(fields) + (1 if greet_changed else 0) + lore_counts["total"]
    for kind in SCRIPT_KINDS:
        counts = {"added": 0, "edited": 0, "deleted": 0}
        for r in db.query("SELECT origin FROM card_scripts WHERE char_key = ? AND kind = ?",
                          (ck, kind)):
            if r["origin"] in counts:
                counts[r["origin"]] += 1
        n = counts["added"] + counts["edited"] + counts["deleted"]
        out[kind] = {"changed": n, "list": [x["entry"] for x in scripts(ck, kind)],
                     "before": _script_baseline(ck, kind)}
        total += n
    # The asset references go out as the three character lists RisuAI keeps,
    # rebuilt from the working entries - the plugin writes lists, never rows.
    out["assets"] = {"changed": out[ASSET_KIND]["changed"],
                     **asset_lists([x["entry"] for x in scripts(ck, ASSET_KIND)]),
                     # Built through the same function, so the two sides of the
                     # comparison cannot differ by how they were assembled.
                     "before": asset_lists(_script_baseline(ck, ASSET_KIND))}
    out["total"] = total
    return out


def _order(d: dict) -> int:
    """A row's position in the baseline list."""
    v = d.get("base_seq")
    return int(v) if v is not None else int(d.get("seq") or 0)


def _script_baseline(ck: str, kind: str) -> list[dict]:
    """The list as RisuAI last showed it: baselined rows in base_seq order."""
    rows = [db.row_to_dict(r) for r in db.query(
        "SELECT * FROM card_scripts WHERE char_key = ? AND kind = ? AND original_json IS NOT NULL "
        "AND origin <> 'added'", (ck, kind))]
    rows.sort(key=_order)
    return [db.unjs(r["original_json"], {}) for r in rows]


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
    # Conflict marks go with the changes they marked: the baseline already
    # holds RisuAI's side, so discarding *is* taking theirs - a conflict left
    # standing here would block 반영 over rows that no longer differ.
    db.execute("UPDATE card_fields SET conflict_json = NULL "
               "WHERE char_key = ? AND conflict_json IS NOT NULL", (ck,))
    db.execute("UPDATE card_scripts SET conflict_json = NULL "
               "WHERE char_key = ? AND conflict_json IS NOT NULL", (ck,))
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
