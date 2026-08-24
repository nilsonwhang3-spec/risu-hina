"""Checkpoints: take one, list them, go back to one.

Lifted out of `main.py` when the agent gained the ability to propose a restore.
The logic had to be callable from two places - an HTTP handler and an action
executor - and a copy in each is how the two stop agreeing about what "restore"
means.
"""
from __future__ import annotations

import uuid

from . import card as cardmod
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


# --- bot-level checkpoints ---------------------------------------------------
#
# Same three verbs over card_checkpoints. A separate table and separate
# functions rather than nullable-ing chat_key: every consumer above assumes a
# chat (markdown, message_count), and a bot snapshot has neither.

def create_card(char_key: str, label: str) -> str:
    """Snapshot the bot as one unit: card fields, scripts, global lorebook."""
    rows = cardmod.rows_for_checkpoint(char_key)
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO card_checkpoints(id, char_key, label, fields_json, scripts_json, "
        "lore_json, created_at) VALUES(?,?,?,?,?,?,?)",
        (cid, char_key, label, db.js(rows["fields"]), db.js(rows["scripts"]),
         db.js(store.lore_rows_global(char_key)), db.now()),
    )
    keep = int((config.section("limits") or {}).get("checkpointKeep") or 50)
    db.execute(
        "DELETE FROM card_checkpoints WHERE char_key = ? AND id NOT IN "
        "(SELECT id FROM card_checkpoints WHERE char_key = ? ORDER BY created_at DESC LIMIT ?)",
        (char_key, char_key, keep),
    )
    return cid


def listing_card(char_key: str) -> list[dict]:
    rows = db.query(
        "SELECT id, label, created_at FROM card_checkpoints "
        "WHERE char_key = ? ORDER BY created_at DESC",
        (char_key,),
    )
    return [dict(r) for r in rows]


def restore_card(char_key: str, checkpoint_id: str) -> dict:
    row = db.one("SELECT * FROM card_checkpoints WHERE id = ? AND char_key = ?",
                 (checkpoint_id, char_key))
    if row is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    # Same as chat restore: snapshot first, so restoring is itself undoable.
    create_card(char_key, "restore 직전")
    counts = cardmod.restore_rows(char_key, {
        "fields": db.unjs(row["fields_json"], []) or [],
        "scripts": db.unjs(row["scripts_json"], []) or [],
    })
    lore_n = store.restore_lore_rows_global(char_key, db.unjs(row["lore_json"], []) or [])
    log.info("restored card char=%s checkpoint=%s fields=%s scripts=%s lore=%s",
             char_key, checkpoint_id, counts["fields"], counts["scripts"], lore_n)
    return {"ok": True, "restored": checkpoint_id, **counts, "lore": lore_n}
