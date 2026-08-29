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


def _check_kind(kind: str) -> str:
    # Two values, checked at the door: everything downstream (the version
    # list, pruning, the restore dedup) branches on this column.
    if kind not in ("user", "auto"):
        raise ValueError(f"unknown snapshot kind: {kind}")
    return kind


def create(chat_key: str, label: str, kind: str = "user") -> str:
    """Snapshot the whole chat: turns, this chat's lorebook, its memory.

    One unit, because that is what the user restores. A snapshot that put the
    turns back but left the lorebook holding summaries of turns that had just
    reappeared would be worse than no snapshot.

    `kind='user'` is a save the user asked for by name - the version list.
    `kind='auto'` is the code protecting itself before something destructive -
    an internal backup, pruned to the newest few right here, so no caller can
    forget to.
    """
    _check_kind(kind)
    md = store.export_markdown(chat_key)
    row = store.chat_row(chat_key) or {}
    ck = row.get("char_key") or ""
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO checkpoints(id, chat_key, label, markdown, meta_json, message_count, created_at, "
        "lore_json, memory_json, kind) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (cid, chat_key, label, md, row.get("meta_json") or "{}",
         chatfmt.message_count(md), db.now(),
         db.js(store.lore_rows(ck, chat_key)), db.js(mem.rows_for_checkpoint(chat_key)), kind),
    )
    if kind == "auto":
        prune_auto(chat_key)
    keep = int((config.section("limits") or {}).get("checkpointKeep") or 50)
    db.execute(
        "DELETE FROM checkpoints WHERE chat_key = ? AND id NOT IN "
        "(SELECT id FROM checkpoints WHERE chat_key = ? ORDER BY created_at DESC LIMIT ?)",
        (chat_key, chat_key, keep),
    )
    return cid


def prune_auto(chat_key: str, keep: int | None = None) -> int:
    """Automatic snapshots are internal backups, not the user's version list,
    so only the newest few earn their keep. Never touches a 'user' row, and
    never prunes to zero: RisuAI has no undo of its own for a plugin write,
    so the backup taken before the last 반영 must stay reachable."""
    if keep is None:
        keep = int((config.section("limits") or {}).get("autoBackupKeep") or 5)
    keep = max(1, int(keep))
    cur = db.execute(
        "DELETE FROM checkpoints WHERE chat_key = ? AND kind = 'auto' AND id NOT IN "
        "(SELECT id FROM checkpoints WHERE chat_key = ? AND kind = 'auto' "
        "ORDER BY created_at DESC LIMIT ?)",
        (chat_key, chat_key, keep),
    )
    return cur.rowcount or 0


def listing(chat_key: str) -> list[dict]:
    rows = db.query(
        "SELECT id, label, message_count, created_at, kind FROM checkpoints "
        "WHERE chat_key = ? ORDER BY created_at DESC",
        (chat_key,),
    )
    return [dict(r) for r in rows]


def rename(chat_key: str, checkpoint_id: str, label: str) -> None:
    """Relabel a snapshot. The label is the only thing about a snapshot the
    user can change - the content is what it was."""
    text = (label or "").strip()[:80]
    if not text:
        raise ValueError("스냅샷 이름을 입력해 주세요")
    if db.one("SELECT id FROM checkpoints WHERE id = ? AND chat_key = ?", (checkpoint_id, chat_key)) is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    db.execute("UPDATE checkpoints SET label = ? WHERE id = ? AND chat_key = ?", (text, checkpoint_id, chat_key))


def delete(chat_key: str, checkpoint_id: str) -> None:
    if db.one("SELECT id FROM checkpoints WHERE id = ? AND chat_key = ?", (checkpoint_id, chat_key)) is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    db.execute("DELETE FROM checkpoints WHERE id = ? AND chat_key = ?", (checkpoint_id, chat_key))


def clear(chat_key: str, keep: int = 0) -> int:
    """Delete this chat's snapshots, keeping the `keep` newest. Returns how
    many went."""
    keep = max(0, int(keep))
    before = db.one("SELECT COUNT(*) AS n FROM checkpoints WHERE chat_key = ?", (chat_key,))
    db.execute(
        "DELETE FROM checkpoints WHERE chat_key = ? AND id NOT IN "
        "(SELECT id FROM checkpoints WHERE chat_key = ? ORDER BY created_at DESC LIMIT ?)",
        (chat_key, chat_key, keep),
    )
    after = db.one("SELECT COUNT(*) AS n FROM checkpoints WHERE chat_key = ?", (chat_key,))
    return int((before["n"] if before else 0) - (after["n"] if after else 0))


def restore(chat_key: str, checkpoint_id: str) -> dict:
    row = db.one("SELECT * FROM checkpoints WHERE id = ? AND chat_key = ?",
                 (checkpoint_id, chat_key))
    if row is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    # Snapshot the current state first, so restoring is itself undoable - but
    # only ever one of them. Five restores in a row left five identical
    # "restore 직전" rows, which is most of what made the list unreadable, and
    # only the newest was ever any use: the one before the restore you just
    # regretted.
    db.execute("DELETE FROM checkpoints WHERE chat_key = ? AND label = 'restore 직전' "
               "AND kind = 'auto'", (chat_key,))
    create(chat_key, "restore 직전", kind="auto")
    env = chatfmt.encode(row["markdown"], db.unjs(row["meta_json"], {}) or {})
    chat_row = store.chat_row(chat_key) or {}
    # The working copy only. This used to go through `ingest_chat(force=True)`,
    # which rewrites the baseline too - see `store.restore_turns` for what that
    # cost: a restore that 반영 reported as 0 changes and that the next re-open
    # silently threw away in favour of RisuAI's version.
    store.restore_turns(chat_key, (env["data"] or {}).get("message") or [])
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

def create_card(char_key: str, label: str, kind: str = "user") -> str:
    """Snapshot the bot as one unit: card fields, scripts, global lorebook.
    `kind` as in create()."""
    _check_kind(kind)
    rows = cardmod.rows_for_checkpoint(char_key)
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO card_checkpoints(id, char_key, label, fields_json, scripts_json, "
        "lore_json, created_at, kind) VALUES(?,?,?,?,?,?,?,?)",
        (cid, char_key, label, db.js(rows["fields"]), db.js(rows["scripts"]),
         db.js(store.lore_rows_global(char_key)), db.now(), kind),
    )
    if kind == "auto":
        prune_auto_card(char_key)
    keep = int((config.section("limits") or {}).get("checkpointKeep") or 50)
    db.execute(
        "DELETE FROM card_checkpoints WHERE char_key = ? AND id NOT IN "
        "(SELECT id FROM card_checkpoints WHERE char_key = ? ORDER BY created_at DESC LIMIT ?)",
        (char_key, char_key, keep),
    )
    return cid


def prune_auto_card(char_key: str, keep: int | None = None) -> int:
    """prune_auto's bot twin - see there for why keep never reaches zero."""
    if keep is None:
        keep = int((config.section("limits") or {}).get("autoBackupKeep") or 5)
    keep = max(1, int(keep))
    cur = db.execute(
        "DELETE FROM card_checkpoints WHERE char_key = ? AND kind = 'auto' AND id NOT IN "
        "(SELECT id FROM card_checkpoints WHERE char_key = ? AND kind = 'auto' "
        "ORDER BY created_at DESC LIMIT ?)",
        (char_key, char_key, keep),
    )
    return cur.rowcount or 0


def listing_card(char_key: str) -> list[dict]:
    rows = db.query(
        "SELECT id, label, created_at, kind FROM card_checkpoints "
        "WHERE char_key = ? ORDER BY created_at DESC",
        (char_key,),
    )
    return [dict(r) for r in rows]


def rename_card(char_key: str, checkpoint_id: str, label: str) -> None:
    text = (label or "").strip()[:80]
    if not text:
        raise ValueError("스냅샷 이름을 입력해 주세요")
    if db.one("SELECT id FROM card_checkpoints WHERE id = ? AND char_key = ?", (checkpoint_id, char_key)) is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    db.execute("UPDATE card_checkpoints SET label = ? WHERE id = ? AND char_key = ?",
               (text, checkpoint_id, char_key))


def delete_card(char_key: str, checkpoint_id: str) -> None:
    if db.one("SELECT id FROM card_checkpoints WHERE id = ? AND char_key = ?", (checkpoint_id, char_key)) is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    db.execute("DELETE FROM card_checkpoints WHERE id = ? AND char_key = ?", (checkpoint_id, char_key))


def clear_card(char_key: str, keep: int = 0) -> int:
    keep = max(0, int(keep))
    before = db.one("SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ?", (char_key,))
    db.execute(
        "DELETE FROM card_checkpoints WHERE char_key = ? AND id NOT IN "
        "(SELECT id FROM card_checkpoints WHERE char_key = ? ORDER BY created_at DESC LIMIT ?)",
        (char_key, char_key, keep),
    )
    after = db.one("SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ?", (char_key,))
    return int((before["n"] if before else 0) - (after["n"] if after else 0))


def restore_card(char_key: str, checkpoint_id: str) -> dict:
    row = db.one("SELECT * FROM card_checkpoints WHERE id = ? AND char_key = ?",
                 (checkpoint_id, char_key))
    if row is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    # Same as chat restore: snapshot first so restoring is undoable, and only
    # ever one of them (see restore()).
    db.execute("DELETE FROM card_checkpoints WHERE char_key = ? AND label = 'restore 직전' "
               "AND kind = 'auto'", (char_key,))
    create_card(char_key, "restore 직전", kind="auto")
    counts = cardmod.restore_rows(char_key, {
        "fields": db.unjs(row["fields_json"], []) or [],
        "scripts": db.unjs(row["scripts_json"], []) or [],
    })
    lore_n = store.restore_lore_rows_global(char_key, db.unjs(row["lore_json"], []) or [])
    log.info("restored card char=%s checkpoint=%s fields=%s scripts=%s lore=%s",
             char_key, checkpoint_id, counts["fields"], counts["scripts"], lore_n)
    return {"ok": True, "restored": checkpoint_id, **counts, "lore": lore_n}
