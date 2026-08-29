"""Long-term memory: the hypa/supa summaries, as editable rows.

RisuAI keeps a chat's long-term memory in whichever scheme the user turned on -
`hypaV3Data`, `hypaV2Data`, `supaMemoryData`, `lastMemory`. The workspace has
always frozen that blob to `original/<chat>.hypa.json`, which is enough to read
and useless to edit: a summary is prose someone wants to fix, and fixing it
inside a JSON blob means the agent rewriting a structure it does not own.

So the summaries become rows, the same way turns did, for the same reason:

  - a person can edit one entry without touching the others,
  - a diff against the frozen original is a string comparison rather than a
    JSON diff,
  - and the write-back can put the structure back together exactly, because the
    parts it did not touch were never taken apart.

**The shell is kept verbatim.** Everything in the original object that is not a
summary - and there is more of it in hypaV3 than the interface admits - is
stored untouched and restored on the way out. Rebuilding a memory blob from
what we understood of it is how a fork's extra field disappears silently.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

from . import db, log, merge

# Which key holds a list of summaries, and what each one calls its text.
SCHEMES: dict[str, tuple[str, str]] = {
    "hypaV3Data": ("summaries", "text"),
    "hypaV2Data": ("summaries", "text"),
}

# Schemes that are one lump of prose rather than a list.
FLAT = ("supaMemoryData", "supaMemory", "lastMemory")

# Chat variables. RisuAI keeps them on `chat.scriptstate` as one object -
# `{{setvar::x::1}}` writes `scriptstate["$x"]`, triggers and Lua write their
# own keys. One row per key, the key as the title, the value as the body.
# Values are not all strings, so the type rides along in extra_json and the
# write-back converts back; a number that came out as "3" would otherwise go
# back in as the string "3", which `{{calc}}` treats differently.
VARS = "scriptstate"


def _var_encode(value: Any) -> tuple[str, str]:
    """A scriptstate value as (body text, type tag)."""
    if isinstance(value, bool):
        return ("true" if value else "false"), "bool"
    if isinstance(value, (int, float)):
        return json.dumps(value), "number"
    if value is None:
        return "", "null"
    if isinstance(value, str):
        return value, "string"
    return json.dumps(value, ensure_ascii=False), "json"


def _var_decode(body: str, kind: str) -> Any:
    try:
        if kind == "bool":
            return body.strip().lower() in ("true", "1", "yes")
        if kind == "number":
            n = json.loads(body)
            return n if isinstance(n, (int, float)) else body
        if kind == "null":
            return None if body == "" else body
        if kind == "json":
            return json.loads(body)
    except (ValueError, TypeError):
        pass
    return body

SHELL_KEY = "hypa_shell:"


def _shell_key(chat_key: str) -> str:
    return SHELL_KEY + chat_key


def ingest(char_key: str, chat_key: str, memory: dict, *, reset: bool = True) -> dict:
    """Load a RisuAI memory object into rows.

    `reset` follows `store.ingest_chat`, and for the same reason: the panel
    re-uploads the whole workspace every time it opens, so an unconditional
    rebuild would silently throw away an edit the user had not written back
    yet. With `reset` false the **baseline** is still refreshed - the user may
    have regenerated summaries in RisuAI since, and a stale original makes the
    diff lie - but the working text is left alone.
    """
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_shell_key(chat_key), db.js(_shell(memory))),
    )
    if reset:
        db.execute("DELETE FROM memories WHERE chat_key = ?", (chat_key,))

    rows: list[tuple] = []
    now = db.now()
    counts: dict[str, int] = {}

    for scheme, (list_key, text_key) in SCHEMES.items():
        block = memory.get(scheme)
        if not isinstance(block, dict):
            continue
        items = block.get(list_key)
        if not isinstance(items, list):
            continue
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                # A bare string is legal in some exports; keep it addressable.
                item = {text_key: str(item)}
            text = str(item.get(text_key) or "")
            extra = {k: v for k, v in item.items() if k != text_key}
            rows.append((uuid.uuid4().hex, chat_key, char_key, scheme, i,
                         _title(text, i), text, text, db.js(extra), now, now))
        counts[scheme] = len(items)

    for scheme in FLAT:
        raw = memory.get(scheme)
        if isinstance(raw, str) and raw.strip():
            rows.append((uuid.uuid4().hex, chat_key, char_key, scheme, 0,
                         _title(raw, 0), raw, raw, db.js({}), now, now))
            counts[scheme] = 1

    state = memory.get(VARS)
    if isinstance(state, dict):
        for i, (key, value) in enumerate(state.items()):
            body, vtype = _var_encode(value)
            rows.append((uuid.uuid4().hex, chat_key, char_key, VARS, i,
                         str(key), body, body, db.js({"key": str(key), "type": vtype}), now, now))
        counts[VARS] = len(state)

    if reset:
        if rows:
            db.executemany(
                "INSERT INTO memories(id, chat_key, char_key, kind, seq, title, body, "
                "original, extra_json, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                rows,
            )
        log.info("memory ingest chat=%s %s", chat_key, counts or "none")
        return {"chatKey": chat_key, "counts": counts, "total": len(rows), "reset": True}

    # Three-way merge, per kind (app/merge.py). Variables keep their name as
    # the address; summaries are matched on the turns they cover, because
    # `(kind, seq)` - the old address - shifts under every regeneration, and
    # one insertion at the head rebased every summary onto its neighbour.
    merged = _merge_memory(chat_key, rows, now)
    log.info("memory refresh chat=%s %s", chat_key, merged or "no change")
    return {"chatKey": chat_key, "counts": counts, "total": len(rows),
            "reset": False, "merge": merged}


def _merge_memory(chat_key: str, incoming: list[tuple], now: float) -> dict[str, int]:
    out: dict[str, int] = {}
    by_kind: dict[str, list[tuple]] = {}
    for r in incoming:
        by_kind.setdefault(r[3], []).append(r)
    kinds = set(by_kind) | {
        str(r["kind"]) for r in db.query(
            "SELECT DISTINCT kind FROM memories WHERE chat_key = ?", (chat_key,))}

    for kind in sorted(kinds):
        items = by_kind.get(kind, [])
        spec = merge.VAR if kind == VARS else merge.MEMO
        rows = [db.row_to_dict(r) for r in db.query(
            "SELECT * FROM memories WHERE chat_key = ? AND kind = ? ORDER BY seq", (chat_key, kind))]
        # A summary's identity lives in its extras (`chatMemos`), a variable's
        # in its title, so both travel with the value being matched.
        def shape(title: str, body: str, extra: Any) -> Any:
            # The identity travels with the value: a variable is keyed by its
            # name and a summary by the turns it covers (`chatMemos`), while
            # what the three-way compares is the text either way.
            if kind == VARS:
                return {"key": title, "text": body}
            return {"text": body, **(db.unjs(extra, {}) if isinstance(extra, str) else (extra or {}))}

        based, added_here = [], []
        for r in rows:
            ours = shape(r["title"], r["body"] or "", r["extra_json"])
            if r["original"] is None:
                added_here.append(merge.Row(id=r["id"], ours=ours, base=None, dirty=True))
            else:
                based.append(merge.Row(id=r["id"], ours=ours,
                                       base=shape(r["title"], r["original"] or "", r["extra_json"]),
                                       dirty=False, order=int(r["seq"] or 0)))
        theirs = [shape(t[5], t[6], t[8]) for t in items]
        ops = merge.plan(based, theirs, spec)
        same = merge.adopted_additions(added_here, [o for o in ops if o.action == merge.INSERT], spec)
        folded = {id(o) for o in same.values()}
        for op in ops:
            out[op.action] = out.get(op.action, 0) + 1
            row = items[op.seq] if op.seq is not None and op.seq < len(items) else None
            if op.action == merge.INSERT:
                if id(op) in folded:
                    continue
                db.execute(
                    "INSERT INTO memories(id, chat_key, char_key, kind, seq, title, body, "
                    "original, conflict_json, extra_json, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?)",
                    (row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], now, now))
                continue
            body = row[6] if row is not None else None
            extra = row[8] if row is not None else None
            if op.action == merge.DELETE:
                db.execute("DELETE FROM memories WHERE id = ?", (op.row.id,))
            elif op.action == merge.ADOPT:
                db.execute("UPDATE memories SET body = ?, original = ?, title = ?, extra_json = ?, "
                           "conflict_json = NULL, updated_at = ? WHERE id = ?",
                           (body, body, row[5], extra, now, op.row.id))
            elif op.action == merge.CONFLICT:
                db.execute("UPDATE memories SET original = COALESCE(?, original), conflict_json = ?, "
                           "updated_at = ? WHERE id = ?",
                           (body, db.js(op.conflict), now, op.row.id))
            elif body is not None:
                db.execute("UPDATE memories SET original = ?, updated_at = ? WHERE id = ?",
                           (body, now, op.row.id))
        for row_id, op in same.items():
            row = items[op.seq]
            db.execute("UPDATE memories SET original = ?, updated_at = ? WHERE id = ?",
                       (row[6], now, row_id))
    return {k: v for k, v in out.items() if v}


def _shell(memory: dict) -> dict:
    """The original object with the summary lists emptied, kept for write-back."""
    shell: dict[str, Any] = {}
    for key, value in (memory or {}).items():
        if key in SCHEMES and isinstance(value, dict):
            list_key = SCHEMES[key][0]
            shell[key] = {k: v for k, v in value.items() if k != list_key}
        elif key in FLAT or key == VARS:
            continue
        else:
            shell[key] = value
    return shell


def _title(text: str, i: int) -> str:
    head = (text or "").strip().split("\n", 1)[0].strip()
    return (head[:60] or f"항목 {i + 1}")


def _row(r) -> dict:
    d = db.row_to_dict(r) or {}
    body = d.get("body") or ""
    original = d.get("original")
    extra = db.unjs(d.get("extra_json"), {}) or {}
    return {
        "id": d.get("id"),
        "chatKey": d.get("chat_key"),
        "kind": d.get("kind") or "",
        "seq": int(d.get("seq") or 0),
        "title": d.get("title") or "",
        "body": body,
        "original": original,
        "changed": original is not None and original != body,
        "isNew": original is None,
        "conflict": db.unjs(d.get("conflict_json"), None),
        "updatedAt": d.get("updated_at"),
        "valueType": extra.get("type") if d.get("kind") == VARS else None,
    }


def listing(chat_key: str) -> dict:
    rows = db.query(
        "SELECT * FROM memories WHERE chat_key = ? ORDER BY kind, seq", (chat_key,))
    items = [_row(r) for r in rows]
    return {
        "chatKey": chat_key,
        "items": items,
        "changed": sum(1 for i in items if i["changed"] or i["isNew"]),
    }


def get(memory_id: str) -> dict | None:
    r = db.one("SELECT * FROM memories WHERE id = ?", (memory_id,))
    return _row(r) if r is not None else None


def update(memory_id: str, body: str, title: str | None = None) -> dict:
    cur = get(memory_id)
    if cur is None:
        raise LookupError("없는 항목입니다")
    if cur["kind"] == VARS:
        # The title is the key and the key is the address; it does not move.
        new_title = cur["title"]
    else:
        new_title = title if title is not None else _title(body, cur["seq"])
    db.execute(
        "UPDATE memories SET body = ?, title = ?, updated_at = ? WHERE id = ?",
        (body, new_title, db.now(), memory_id),
    )
    return get(memory_id) or {}


def add(char_key: str, chat_key: str, kind: str, body: str, title: str = "") -> dict:
    if kind not in SCHEMES and kind not in FLAT and kind != VARS:
        raise ValueError(f"모르는 기억 종류입니다: {kind}")
    extra: dict[str, Any] = {}
    if kind == VARS:
        key = (title or "").strip()
        if not key:
            raise ValueError("변수 이름이 필요합니다")
        if db.one("SELECT id FROM memories WHERE chat_key = ? AND kind = ? AND title = ?",
                  (chat_key, kind, key)) is not None:
            raise ValueError(f"이미 있는 변수입니다: {key}")
        title = key
        extra = {"key": key, "type": "string"}
    r = db.one(
        "SELECT COALESCE(MAX(seq), -1) AS m FROM memories WHERE chat_key = ? AND kind = ?",
        (chat_key, kind))
    seq = int((r["m"] if r else -1) or -1) + 1
    mid = uuid.uuid4().hex
    now = db.now()
    db.execute(
        "INSERT INTO memories(id, chat_key, char_key, kind, seq, title, body, "
        "original, extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        # original stays NULL: this entry has no frozen counterpart, which is
        # exactly what marks it as added rather than edited.
        (mid, chat_key, char_key, kind, seq, title or _title(body, seq), body,
         None, db.js(extra), now, now),
    )
    return get(mid) or {}


def delete(memory_id: str) -> dict:
    if get(memory_id) is None:
        raise LookupError("없는 항목입니다")
    db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    return {"deleted": memory_id}


def patch(chat_key: str) -> dict:
    """Rebuild the RisuAI memory object for write-back."""
    shell_row = db.one("SELECT value FROM meta WHERE key = ?", (_shell_key(chat_key),))
    out: dict[str, Any] = db.unjs(shell_row["value"] if shell_row else None, {}) or {}

    rows = db.query(
        "SELECT * FROM memories WHERE chat_key = ? ORDER BY kind, seq", (chat_key,))
    changed = 0
    for r in rows:
        d = db.row_to_dict(r) or {}
        kind = d["kind"]
        body = d.get("body") or ""
        if (d.get("original") or "") != body:
            changed += 1
        if kind == VARS:
            # The whole object, so a deleted row is a deleted variable. Only
            # emitted when there are rows: a chat without variables must not
            # gain an empty scriptstate from us.
            extra = db.unjs(d.get("extra_json"), {}) or {}
            state = out.setdefault(VARS, {})
            if not isinstance(state, dict):
                state = {}
                out[VARS] = state
            state[str(extra.get("key") or d.get("title") or "")] = _var_decode(body, str(extra.get("type") or "string"))
            continue
        if kind in SCHEMES:
            list_key, text_key = SCHEMES[kind]
            block = out.setdefault(kind, {})
            if not isinstance(block, dict):
                block = {}
                out[kind] = block
            items = block.setdefault(list_key, [])
            # The per-item extras - chatMemos above all - are restored verbatim.
            # Dropping chatMemos is how a summary loses its link to the turns it
            # summarises, which is not visible until the next generation.
            item = dict(db.unjs(d.get("extra_json"), {}) or {})
            item[text_key] = body
            items.append(item)
        else:
            out[kind] = body

    return {"chatKey": chat_key, "memory": out, "changed": changed, "entries": len(rows)}


def changes(chat_key: str) -> dict:
    """What a write-back of this chat's memory would change, as counts.

    Variables are counted apart from summaries: they are written together
    (same chat object, same call) but the bar names them apart, because a
    person thinks of "the summary I fixed" and "the flag I flipped" as two
    different things.
    """
    rows = db.query("SELECT kind, body, original FROM memories WHERE chat_key = ?", (chat_key,))
    changed = vars_changed = 0
    for r in rows:
        if (r["original"] or "") == (r["body"] or ""):
            continue
        if r["kind"] == VARS:
            vars_changed += 1
        else:
            changed += 1
    return {"changed": changed, "vars": vars_changed, "total": changed + vars_changed,
            "entries": len(rows)}


def rows_for_checkpoint(chat_key: str) -> dict:
    """The memory as whole rows plus its shell, so a checkpoint can put back
    exactly this - ids included, because proposals name entries by id."""
    shell_row = db.one("SELECT value FROM meta WHERE key = ?", (_shell_key(chat_key),))
    return {
        "shell": db.unjs(shell_row["value"] if shell_row else None, {}) or {},
        "rows": [dict(db.row_to_dict(r) or {}) for r in db.query(
            "SELECT * FROM memories WHERE chat_key = ? ORDER BY kind, seq", (chat_key,))],
    }


def restore_rows(char_key: str, chat_key: str, snap: dict) -> int:
    rows = list(snap.get("rows") or [])
    db.execute("DELETE FROM memories WHERE chat_key = ?", (chat_key,))
    if rows:
        cols = ("id", "chat_key", "char_key", "kind", "seq", "title", "body",
                "original", "extra_json", "created_at", "updated_at")
        db.executemany(
            f"INSERT INTO memories({', '.join(cols)}) VALUES({', '.join('?' * len(cols))})",
            [tuple(r.get(c) if c not in ("chat_key", "char_key") else (chat_key if c == "chat_key" else char_key)
                   for c in cols) for r in rows],
        )
    db.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (_shell_key(chat_key), db.js(snap.get("shell") or {})),
    )
    return len(rows)


def reset_working(chat_key: str) -> int:
    """Working copy back to the baseline: rows added here go, everything else
    returns to its original text, and conflict marks are cleared. The memory
    leg of `POST /reset`, which used to return the turns alone and leave
    memory edits silently pending behind a chat the user had just declared
    clean. A row whose baseline was hard-deleted is already gone and stays
    gone - nothing records what to bring back."""
    n = db.execute(
        "DELETE FROM memories WHERE chat_key = ? AND original IS NULL", (chat_key,)).rowcount or 0
    n += db.execute(
        "UPDATE memories SET body = original, updated_at = ? "
        "WHERE chat_key = ? AND body <> original", (db.now(), chat_key)).rowcount or 0
    db.execute(
        "UPDATE memories SET conflict_json = NULL WHERE chat_key = ? AND conflict_json IS NOT NULL",
        (chat_key,))
    return n


def rebase(chat_key: str) -> int:
    """Make the current text the new baseline, after a successful write-back."""
    n = db.execute(
        "UPDATE memories SET original = body WHERE chat_key = ? AND "
        "(original IS NULL OR original <> body)", (chat_key,)).rowcount or 0
    log.info("memory rebase chat=%s rows=%s", chat_key, n)
    return n
