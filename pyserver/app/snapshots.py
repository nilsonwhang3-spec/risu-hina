"""Checkpoints: take one, list them, go back to one.

Lifted out of `main.py` when the agent gained the ability to propose a restore.
The logic had to be callable from two places - an HTTP handler and an action
executor - and a copy in each is how the two stop agreeing about what "restore"
means.
"""
from __future__ import annotations

import uuid

from . import chatfmt, config, db, log, store
from . import memory as mem


def create(chat_key: str, label: str) -> str:
    """Snapshot the whole chat: turns, this chat's lorebook, its memory.

    One unit, because that is what the user restores. A snapshot that put the
    turns back but left the lorebook holding summaries of turns that had just
    reappeared would be worse than no snapshot.
    """
    md = store.export_markdown(chat_key)
    row = store.chat_row(chat_key) or {}
    ck = row.get("char_key") or ""
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO checkpoints(id, chat_key, label, markdown, meta_json, message_count, created_at, "
        "lore_json, memory_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (cid, chat_key, label, md, row.get("meta_json") or "{}",
         chatfmt.message_count(md), db.now(),
         db.js(store.lore_rows(ck, chat_key)), db.js(mem.rows_for_checkpoint(chat_key))),
    )
    keep = int((config.section("limits") or {}).get("checkpointKeep") or 50)
    db.execute(
        "DELETE FROM checkpoints WHERE chat_key = ? AND id NOT IN "
        "(SELECT id FROM checkpoints WHERE chat_key = ? ORDER BY created_at DESC LIMIT ?)",
        (chat_key, chat_key, keep),
    )
    return cid


def listing(chat_key: str) -> list[dict]:
    rows = db.query(
        "SELECT id, label, message_count, created_at FROM checkpoints "
        "WHERE chat_key = ? ORDER BY created_at DESC",
        (chat_key,),
    )
    return [dict(r) for r in rows]


def restore(chat_key: str, checkpoint_id: str) -> dict:
    row = db.one("SELECT * FROM checkpoints WHERE id = ? AND chat_key = ?",
                 (checkpoint_id, chat_key))
    if row is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    # Snapshot the current state first, so restoring is itself undoable.
    create(chat_key, "restore 직전")
    env = chatfmt.encode(row["markdown"], db.unjs(row["meta_json"], {}) or {})
    chat_row = store.chat_row(chat_key) or {}
    store.ingest_chat(
        (store.character_row(chat_row.get("char_key") or "") or {}).get("cha_id") or "",
        {**env["data"], "id": chat_row.get("chat_id")},
        chat_row.get("chat_index"),
        force=True,
    )
    # Older checkpoints carry turns only; they restore what they have and say so.
    ck = chat_row.get("char_key") or ""
    lore_n = mem_n = None
    if row["lore_json"] is not None:
        lore_n = store.restore_lore_rows(ck, chat_key, db.unjs(row["lore_json"], []) or [])
    if row["memory_json"] is not None:
        mem_n = mem.restore_rows(ck, chat_key, db.unjs(row["memory_json"], {}) or {})
    log.info("restored chat=%s checkpoint=%s messages=%s lore=%s memory=%s",
             chat_key, checkpoint_id, row["message_count"], lore_n, mem_n)
    return {"ok": True, "restored": checkpoint_id, "messageCount": row["message_count"],
            "lore": lore_n, "memory": mem_n}
