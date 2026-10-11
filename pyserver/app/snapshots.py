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
    """Delete this chat's saved snapshots, keeping the `keep` newest. Returns
    how many went. 'user' rows only: the automatic backups are the backend's
    to prune (prune_auto), and "전부 삭제" must not quietly take the safety
    net taken before the last 반영 with it."""
    keep = max(0, int(keep))
    before = db.one(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE chat_key = ? AND kind = 'user'", (chat_key,))
    db.execute(
        "DELETE FROM checkpoints WHERE chat_key = ? AND kind = 'user' AND id NOT IN "
        "(SELECT id FROM checkpoints WHERE chat_key = ? AND kind = 'user' "
        "ORDER BY created_at DESC LIMIT ?)",
        (chat_key, chat_key, keep),
    )
    after = db.one(
        "SELECT COUNT(*) AS n FROM checkpoints WHERE chat_key = ? AND kind = 'user'", (chat_key,))
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

def create_card(char_key: str, label: str, kind: str = "user", *, baseline: bool = False) -> str:
    """Snapshot the bot as one unit: card fields, scripts, global lorebook.
    `kind` as in create().

    `baseline=True` snapshots what RisuAI holds as of the last read rather
    than the working copy - the card as it was before a 반영 that is about
    to be (or has just been) written (§1-103)."""
    _check_kind(kind)
    rows = cardmod.rows_for_checkpoint(char_key)
    lore = store.lore_rows_global(char_key)
    if baseline:
        rows, lore = _as_baseline(rows, lore)
    cid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO card_checkpoints(id, char_key, label, fields_json, scripts_json, "
        "lore_json, created_at, kind) VALUES(?,?,?,?,?,?,?,?)",
        (cid, char_key, label, db.js(rows["fields"]), db.js(rows["scripts"]),
         db.js(lore), db.now(), kind),
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


def _as_baseline(rows: dict, lore: list[dict]) -> tuple[dict, list[dict]]:
    """Working rows turned into the baseline they sit on: added rows dropped,
    every other row back to its original, in RisuAI's order."""
    def order(r: dict) -> int:
        return int(r["base_seq"]) if r.get("base_seq") is not None else int(r.get("seq") or 0)
    fields = []
    for r in rows["fields"]:
        if r.get("original") is None:
            continue
        fields.append({**r, "body": r["original"], "extra_json": None,
                       "seq": order(r) if r.get("field") == cardmod.LIST_FIELD else r.get("seq")})
    scripts_ = [{**r, "entry_json": r["original_json"], "origin": "original", "seq": order(r)}
                for r in rows["scripts"] if r.get("original_json") is not None and r.get("origin") != "added"]
    lore_ = [{**r, "entry_json": r["original_json"], "origin": "original", "seq": order(r)}
             for r in lore if r.get("original_json") is not None and r.get("origin") != "added"]
    return {"fields": fields, "scripts": scripts_}, lore_


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


def mates(char_key: str) -> list[str]:
    """The bots whose snapshots this bot shares: itself, then every bot in
    the same project folder - its family and the bots of (almost) the same
    name (workspace.folder_mates, §1-94). A creator keeps v0.2 and v0.3 of
    one bot as two RisuAI characters; a snapshot taken on either is the
    same bot's history (§1-103). A module or the home chat shares nothing."""
    from . import home, workspace
    from . import modules as modmod
    if home.is_home(char_key) or modmod.is_module_key(char_key):
        return [char_key]
    try:
        return workspace.folder_mates(char_key)
    except Exception:  # noqa: BLE001 - a folder problem must not hide the bot's own list
        return [char_key]


def listing_card(char_key: str) -> list[dict]:
    """This bot's snapshots and its folder mates', newest first. A mate's row
    says whose it is (`from`), so the list can tell them apart."""
    keys = mates(char_key)
    marks = ",".join("?" * len(keys))
    rows = db.query(
        f"SELECT c.id, c.label, c.created_at, c.kind, c.char_key, c.source_name, "
        f"       COALESCE(ch.name, '') AS bot_name "
        f"FROM card_checkpoints c LEFT JOIN characters ch ON ch.char_key = c.char_key "
        f"WHERE c.char_key IN ({marks}) ORDER BY c.created_at DESC",
        keys,
    )
    out = []
    for r in rows:
        d = {"id": r["id"], "label": r["label"], "created_at": r["created_at"], "kind": r["kind"]}
        own = r["char_key"] == char_key
        if not own or r["source_name"]:
            d["from"] = r["source_name"] or r["bot_name"] or r["char_key"]
            d["fromKey"] = r["char_key"]
        d["own"] = own
        out.append(d)
    return out


def _card_row(char_key: str, checkpoint_id: str):
    """A snapshot this bot may use: its own or a folder mate's."""
    keys = mates(char_key)
    marks = ",".join("?" * len(keys))
    row = db.one(f"SELECT * FROM card_checkpoints WHERE id = ? AND char_key IN ({marks})",
                 (checkpoint_id, *keys))
    if row is None:
        raise LookupError(f"unknown checkpoint: {checkpoint_id}")
    return row


def rename_card(char_key: str, checkpoint_id: str, label: str) -> None:
    text = (label or "").strip()[:80]
    if not text:
        raise ValueError("스냅샷 이름을 입력해 주세요")
    _card_row(char_key, checkpoint_id)
    db.execute("UPDATE card_checkpoints SET label = ? WHERE id = ?", (text, checkpoint_id))


def delete_card(char_key: str, checkpoint_id: str) -> None:
    _card_row(char_key, checkpoint_id)
    db.execute("DELETE FROM card_checkpoints WHERE id = ?", (checkpoint_id,))


def clear_card(char_key: str, keep: int = 0) -> int:
    """clear()'s bot twin: 'user' rows only, for the same reason."""
    keep = max(0, int(keep))
    before = db.one(
        "SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ? AND kind = 'user'", (char_key,))
    db.execute(
        "DELETE FROM card_checkpoints WHERE char_key = ? AND kind = 'user' AND id NOT IN "
        "(SELECT id FROM card_checkpoints WHERE char_key = ? AND kind = 'user' "
        "ORDER BY created_at DESC LIMIT ?)",
        (char_key, char_key, keep),
    )
    after = db.one(
        "SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ? AND kind = 'user'", (char_key,))
    return int((before["n"] if before else 0) - (after["n"] if after else 0))


def restore_card(char_key: str, checkpoint_id: str) -> dict:
    """Make the working copy what the snapshot holds, over today's baseline
    (card.restore_content), so the change list is exactly what 반영 will do -
    this works after a 반영 and from a folder mate's snapshot alike (§1-103).

    Asset references RisuAI's card does not hold now come back as pending
    keys over the bytes Hina stored, so 반영 registers the images again:
    RisuAI deletes unreferenced asset files when it boots."""
    row = _card_row(char_key, checkpoint_id)
    # Same as chat restore: snapshot first so restoring is undoable, and only
    # ever one of them (see restore()).
    db.execute("DELETE FROM card_checkpoints WHERE char_key = ? AND label = 'restore 직전' "
               "AND kind = 'auto'", (char_key,))
    create_card(char_key, "restore 직전", kind="auto")
    with db.transaction():
        counts = cardmod.restore_content(char_key, {
            "fields": db.unjs(row["fields_json"], []) or [],
            "scripts": db.unjs(row["scripts_json"], []) or [],
        })
        lore_n = store.restore_lore_content_global(char_key, db.unjs(row["lore_json"], []) or [])
        assets_out = _revive_assets(char_key)
    log.info("restored card char=%s checkpoint=%s (from %s) %s lore=%s assets=%s",
             char_key, checkpoint_id, row["char_key"], counts, lore_n, assets_out)
    out = {"ok": True, "restored": checkpoint_id, **counts, "lore": lore_n, **assets_out,
           "changes": cardmod.changes(char_key)}
    if row["char_key"] != char_key:
        bot = db.one("SELECT name FROM characters WHERE char_key = ?", (row["char_key"],))
        out["from"] = row["source_name"] or (bot["name"] if bot else "") or row["char_key"]
    return out


def _revive_assets(char_key: str) -> dict:
    """Point every working asset reference RisuAI's card lacks at a pending
    key over the stored bytes (assets.revive). Counts what came back and what
    could not: a key whose bytes Hina never stored shows only if RisuAI
    still has the file."""
    from . import assets
    have = cardmod.baseline_asset_keys(char_key)
    revived = lost = 0
    for r in cardmod.scripts(char_key, cardmod.ASSET_KIND):
        key = str(r["entry"].get("key") or "")
        if not key or key in have or key.startswith(assets.PENDING_PREFIX):
            continue
        pending = assets.revive(key)
        if pending is None:
            lost += 1
            continue
        db.execute("UPDATE card_scripts SET entry_json = ? WHERE id = ?",
                   (db.js({**r["entry"], "key": pending}), r["id"]))
        revived += 1
    img = db.one("SELECT id, body FROM card_fields WHERE char_key = ? AND field = 'image' AND seq = 0", (char_key,))
    if img is not None and img["body"] and img["body"] not in have:
        pending = assets.revive(str(img["body"]))
        if pending is None:
            lost += 1
        elif pending != img["body"]:
            db.execute("UPDATE card_fields SET body = ? WHERE id = ?", (pending, img["id"]))
            revived += 1
    return {"assetsRevived": revived, "assetsLost": lost}
