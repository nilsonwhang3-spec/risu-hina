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

from . import db, log

# Which key holds a list of summaries, and what each one calls its text.
SCHEMES: dict[str, tuple[str, str]] = {
    "hypaV3Data": ("summaries", "text"),
    "hypaV2Data": ("summaries", "text"),
}

# Schemes that are one lump of prose rather than a list.
FLAT = ("supaMemoryData", "supaMemory", "lastMemory")

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

    # Refresh in place, matched on (kind, seq) - the address a summary keeps
    # across regenerations. New summaries are added; rows RisuAI no longer has
    # are left, because deleting one would throw away an edit rather than an
    # absence the user asked for.
    added = 0
    rebased = 0
    for r in rows:
        _, _, _, kind, seq, title, body, _original, extra, _c, _u = r
        found = db.one(
            "SELECT id, original FROM memories WHERE chat_key = ? AND kind = ? AND seq = ?",
            (chat_key, kind, seq))
        if found is None:
            db.execute(
                "INSERT INTO memories(id, chat_key, char_key, kind, seq, title, body, "
                "original, extra_json, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                r)
            added += 1
        elif (found["original"] or "") != body:
            db.execute(
                "UPDATE memories SET original = ?, extra_json = ?, updated_at = ? WHERE id = ?",
                (body, extra, now, found["id"]))
            rebased += 1
    log.info("memory refresh chat=%s added=%s rebased=%s", chat_key, added, rebased)
    return {"chatKey": chat_key, "counts": counts, "total": len(rows),
            "reset": False, "added": added, "rebased": rebased}


def _shell(memory: dict) -> dict:
    """The original object with the summary lists emptied, kept for write-back."""
    shell: dict[str, Any] = {}
    for key, value in (memory or {}).items():
        if key in SCHEMES and isinstance(value, dict):
            list_key = SCHEMES[key][0]
            shell[key] = {k: v for k, v in value.items() if k != list_key}
        elif key in FLAT:
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
        "updatedAt": d.get("updated_at"),
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
    db.execute(
        "UPDATE memories SET body = ?, title = ?, updated_at = ? WHERE id = ?",
        (body, (title if title is not None else _title(body, cur["seq"])), db.now(), memory_id),
    )
    return get(memory_id) or {}


def add(char_key: str, chat_key: str, kind: str, body: str, title: str = "") -> dict:
    if kind not in SCHEMES and kind not in FLAT:
        raise ValueError(f"모르는 기억 종류입니다: {kind}")
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
         None, db.js({}), now, now),
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
    """What a write-back of this chat's memory would change, as counts."""
    rows = db.query("SELECT body, original FROM memories WHERE chat_key = ?", (chat_key,))
    changed = sum(1 for r in rows if (r["original"] or "") != (r["body"] or ""))
    return {"changed": changed, "total": changed, "entries": len(rows)}


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


def rebase(chat_key: str) -> int:
    """Make the current text the new baseline, after a successful write-back."""
    n = db.execute(
        "UPDATE memories SET original = body WHERE chat_key = ? AND "
        "(original IS NULL OR original <> body)", (chat_key,)).rowcount or 0
    log.info("memory rebase chat=%s rows=%s", chat_key, n)
    return n
