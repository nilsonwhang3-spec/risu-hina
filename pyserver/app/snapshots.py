"""Checkpoints: take one, list them, go back to one.

Lifted out of `main.py` when the agent gained the ability to propose a restore.
The logic had to be callable from two places - an HTTP handler and an action
executor - and a copy in each is how the two stop agreeing about what "restore"
means.
"""
from __future__ import annotations

import uuid

from . import chatfmt, config, db, log, store


def create(chat_key: str, label: str) -> str:
    md = store.export_markdown(chat_key)
    row = store.chat_row(chat_key) or {}
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO checkpoints(id, chat_key, label, markdown, meta_json, message_count, created_at) "
        "VALUES(?,?,?,?,?,?,?)",
        (cid, chat_key, label, md, row.get("meta_json") or "{}",
         chatfmt.message_count(md), db.now()),
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
    log.info("restored chat=%s checkpoint=%s messages=%s",
             chat_key, checkpoint_id, row["message_count"])
    return {"ok": True, "restored": checkpoint_id, "messageCount": row["message_count"]}
