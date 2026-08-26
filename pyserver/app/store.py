"""Turn/chat/character/lore storage. The DB side of the workspace.

Addressing rule, applied everywhere: **turns are addressed by `msg_id`**
(RisuAI's `Message.chatId`), never by position. `seq` is dense and gets
renumbered whenever a turn is inserted or deleted, and the host's own message
array shifts under us whenever the user edits in RisuAI. `msg_id` is the only
identifier that survives both, and it is also what hypa's `chatMemos` join on.

Structural edits (insert / delete / split / merge / reorder) are first-class
because the target jobs need them: summarising the early turns of a long chat
into lorebook entries and then cutting those turns is the whole point.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any, Iterable

from . import chatfmt, db

INLINE = ("role", "data", "time", "chatId", "name")


def _key(*parts: str) -> str:
    raw = "::".join(p or "" for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def char_key(cha_id: str) -> str:
    return "c" + _key(cha_id)


def chat_key(cha_id: str, chat_id: str) -> str:
    return "t" + _key(cha_id, chat_id)


def new_msg_id() -> str:
    # v4-shaped, because RisuAI generates chatIds with uuidv4 and anything we
    # insert has to look native to every other plugin reading the chat.
    return str(uuid.uuid4())


# --- ingest -----------------------------------------------------------------

def upsert_character(cha_id: str, name: str, card: dict, char_index: int | None,
                     family_key: str = "") -> str:
    ck = char_key(cha_id)
    now = db.now()
    db.execute(
        "INSERT INTO characters(char_key, cha_id, name, char_index, card_json, family_key, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?) "
        "ON CONFLICT(char_key) DO UPDATE SET "
        "  cha_id=excluded.cha_id, name=excluded.name, char_index=excluded.char_index, "
        "  card_json=excluded.card_json, family_key=excluded.family_key, updated_at=excluded.updated_at",
        (ck, cha_id, name, char_index, db.js(card), family_key or "", now, now),
    )
    return ck


def ingest_chat(cha_id: str, chat: dict, chat_index: int | None, *, force: bool = False) -> dict:
    """Load a Chat object into the store. Returns a summary.

    Re-ingesting an existing chat leaves the working turns alone unless `force`
    is set: re-opening the panel must not silently discard edits in progress.
    The original snapshot is always refreshed, because the user may have edited
    in RisuAI since, and a stale original would make every diff wrong.
    """
    ck = char_key(cha_id)
    tk = chat_key(cha_id, str(chat.get("id") or ""))
    doc = chatfmt.decode(chat)
    messages = chat.get("message") or []
    now = db.now()

    exists = db.one("SELECT chat_key FROM chats WHERE chat_key = ?", (tk,)) is not None
    db.execute(
        "INSERT INTO chats(chat_key, char_key, chat_id, chat_index, name, meta_json, orig_count, created_at, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(chat_key) DO UPDATE SET "
        "  chat_index=excluded.chat_index, name=excluded.name, meta_json=excluded.meta_json, "
        "  orig_count=excluded.orig_count, updated_at=excluded.updated_at",
        (tk, ck, str(chat.get("id") or ""), chat_index, str(chat.get("name") or ""),
         db.js(doc["meta"]), len(messages), now, now),
    )

    rows = []
    for i, m in enumerate(messages):
        extras = {k: v for k, v in m.items() if k not in INLINE}
        rows.append((
            tk, i, str(m.get("chatId") or ""), str(m.get("role") or "char"),
            str(m.get("data") or ""), _int_or_none(m.get("time")),
            m.get("name"), db.js(extras) if extras else None,
        ))

    db.execute("DELETE FROM turns_original WHERE chat_key = ?", (tk,))
    db.executemany(
        "INSERT INTO turns_original(chat_key, seq, msg_id, role, body, time, name, extras_json) "
        "VALUES(?,?,?,?,?,?,?,?)",
        rows,
    )

    reset = force or not exists
    if reset:
        db.execute("DELETE FROM turns WHERE chat_key = ?", (tk,))
        db.executemany(
            "INSERT INTO turns(chat_key, seq, msg_id, role, body, time, name, extras_json, origin, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,'original',?)",
            [r + (now,) for r in rows],
        )

    return {
        "chatKey": tk,
        "charKey": ck,
        "chatId": chat.get("id"),
        "chatIndex": chat_index,
        "name": chat.get("name") or "",
        "turns": count_turns(tk),
        "originalTurns": len(messages),
        "workingReset": reset,
    }


def _int_or_none(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


# --- reads ------------------------------------------------------------------

def count_turns(tk: str) -> int:
    row = db.one("SELECT COUNT(*) AS n FROM turns WHERE chat_key = ?", (tk,))
    return int(row["n"]) if row else 0


def chat_row(tk: str) -> dict | None:
    return db.row_to_dict(db.one("SELECT * FROM chats WHERE chat_key = ?", (tk,)))


def character_row(ck: str) -> dict | None:
    return db.row_to_dict(db.one("SELECT * FROM characters WHERE char_key = ?", (ck,)))


def chats_of(ck: str) -> list[dict]:
    rows = db.query(
        "SELECT c.*, (SELECT COUNT(*) FROM turns t WHERE t.chat_key = c.chat_key) AS turns "
        "FROM chats c WHERE c.char_key = ? ORDER BY c.chat_index",
        (ck,),
    )
    return [dict(r) for r in rows]


def turns(tk: str, start: int = 0, limit: int = 100) -> dict:
    total = count_turns(tk)
    rows = db.query(
        "SELECT * FROM turns WHERE chat_key = ? ORDER BY seq LIMIT ? OFFSET ?",
        (tk, max(1, min(2000, limit)), max(0, start)),
    )
    orig = {
        r["msg_id"]: dict(r)
        for r in db.query("SELECT * FROM turns_original WHERE chat_key = ?", (tk,))
        if r["msg_id"]
    }
    out = []
    changed_count = 0
    for r in rows:
        was = orig.get(r["msg_id"])
        changed = bool(was) and was["body"] != r["body"]
        if changed:
            changed_count += 1
        item = {
            "seq": r["seq"],
            "msgId": r["msg_id"],
            "role": r["role"],
            "time": r["time"],
            "name": r["name"],
            "body": r["body"],
            "changed": changed,
            "isNew": was is None,
            "origin": r["origin"],
        }
        # `original` is only carried for turns that actually differ. Sending it
        # for every turn doubled the payload: a real 394-turn chat is 1.7MB of
        # text, and the response was measured at 3.4MB - paid on every open and,
        # before the client learned to patch locally, on every single edit.
        if changed:
            item["original"] = was["body"]
        out.append(item)
    return {
        "chatKey": tk,
        "total": total,
        "start": start,
        "count": len(out),
        "changed": changed_count,
        "turns": out,
    }


def turn_by_msg(tk: str, msg_id: str) -> dict | None:
    return db.row_to_dict(
        db.one("SELECT * FROM turns WHERE chat_key = ? AND msg_id = ?", (tk, msg_id))
    )


# --- writes -----------------------------------------------------------------

def set_body(tk: str, msg_id: str, body: str, *, expect: str | None = None) -> None:
    row = turn_by_msg(tk, msg_id)
    if row is None:
        raise LookupError(f"turn not found: {msg_id}")
    if expect is not None and row["body"] != expect:
        raise ValueError("turn changed since it was read")
    db.execute(
        "UPDATE turns SET body = ?, updated_at = ? WHERE chat_key = ? AND msg_id = ?",
        (body, db.now(), tk, msg_id),
    )


def _renumber(tk: str) -> None:
    """Make seq dense again. Cheap at these sizes and keeps ordering exact."""
    rows = db.query("SELECT id FROM turns WHERE chat_key = ? ORDER BY seq, id", (tk,))
    with db.LOCK:
        conn = db.connect()
        # Two passes through a disjoint range: a single pass would collide with
        # the (chat_key, seq) unique index partway through.
        for i, r in enumerate(rows):
            conn.execute("UPDATE turns SET seq = ? WHERE id = ?", (-(i + 1), r["id"]))
        for i, r in enumerate(rows):
            conn.execute("UPDATE turns SET seq = ? WHERE id = ?", (i, r["id"]))
        conn.commit()


def delete_turns(tk: str, msg_ids: Iterable[str]) -> int:
    ids = [m for m in msg_ids if m]
    if not ids:
        return 0
    marks = ",".join("?" * len(ids))
    cur = db.execute(
        f"DELETE FROM turns WHERE chat_key = ? AND msg_id IN ({marks})", (tk, *ids)
    )
    _renumber(tk)
    return cur.rowcount or 0


def delete_range(tk: str, start_seq: int, end_seq: int) -> int:
    """Delete an inclusive seq range - the 'cut the early turns' primitive."""
    cur = db.execute(
        "DELETE FROM turns WHERE chat_key = ? AND seq >= ? AND seq <= ?",
        (tk, start_seq, end_seq),
    )
    _renumber(tk)
    return cur.rowcount or 0


def insert_turn(tk: str, after_msg_id: str | None, role: str, body: str,
                name: str | None = None) -> str:
    """Insert a new turn after the given one (or at the head when None)."""
    if after_msg_id:
        anchor = turn_by_msg(tk, after_msg_id)
        if anchor is None:
            raise LookupError(f"anchor turn not found: {after_msg_id}")
        at = int(anchor["seq"]) + 1
    else:
        at = 0
    with db.LOCK:
        conn = db.connect()
        # Shift into a negative range first for the same unique-index reason.
        tail = conn.execute(
            "SELECT id, seq FROM turns WHERE chat_key = ? AND seq >= ? ORDER BY seq DESC",
            (tk, at),
        ).fetchall()
        for r in tail:
            conn.execute("UPDATE turns SET seq = ? WHERE id = ?", (-(int(r["seq"]) + 2), r["id"]))
        for r in tail:
            conn.execute("UPDATE turns SET seq = ? WHERE id = ?", (int(r["seq"]) + 1, r["id"]))
        mid = new_msg_id()
        conn.execute(
            "INSERT INTO turns(chat_key, seq, msg_id, role, body, time, name, extras_json, origin, updated_at) "
            "VALUES(?,?,?,?,?,?,?,NULL,'inserted',?)",
            (tk, at, mid, role, body, None, name, db.now()),
        )
        conn.commit()
    _renumber(tk)
    return mid


def merge_turns(tk: str, msg_ids: list[str], separator: str = "\n\n") -> str:
    """Fold several turns into the first. Keeps the first turn's identity.

    Keeping the earliest msg_id rather than minting a new one matters: hypa
    summaries and our own patch targeting both reference it, and a merge that
    orphaned all of them would be a far bigger edit than the user asked for.
    """
    rows = [turn_by_msg(tk, m) for m in msg_ids]
    if any(r is None for r in rows) or len(rows) < 2:
        raise LookupError("merge needs at least two existing turns")
    rows.sort(key=lambda r: r["seq"])  # type: ignore[index]
    keep = rows[0]
    body = separator.join(str(r["body"]) for r in rows)  # type: ignore[index]
    db.execute(
        "UPDATE turns SET body = ?, updated_at = ? WHERE id = ?",
        (body, db.now(), keep["id"]),  # type: ignore[index]
    )
    delete_turns(tk, [str(r["msg_id"]) for r in rows[1:]])  # type: ignore[index]
    return str(keep["msg_id"])  # type: ignore[index]


def split_turn(tk: str, msg_id: str, at: int) -> str:
    """Split one turn in two at a character offset. Returns the new turn's id."""
    row = turn_by_msg(tk, msg_id)
    if row is None:
        raise LookupError(f"turn not found: {msg_id}")
    body = str(row["body"])
    at = max(0, min(len(body), at))
    head, tail = body[:at], body[at:]
    db.execute("UPDATE turns SET body = ?, updated_at = ? WHERE id = ?", (head, db.now(), row["id"]))
    return insert_turn(tk, msg_id, str(row["role"]), tail, row["name"])


def bulk_replace(
    tk: str,
    pattern: str,
    replacement: str,
    *,
    regex: bool = False,
    seq_from: int | None = None,
    seq_to: int | None = None,
    role: str | None = None,
    dry_run: bool = True,
    limit: int = 5000,
) -> dict:
    """Replace across many turns at once - the medium-sized job's workhorse.

    Always computes the full before/after set first and returns it; applying is
    a separate decision. A bulk edit is the operation most likely to do more
    than intended, so "show me what this would do" is the default and the
    caller has to ask for the write.

    Note on regex: a pathological pattern can spin. This is not treated as a
    security boundary - `run_python` next door has no limits at all by explicit
    decision - but the work is bounded by `limit` turns so a mistake stays a
    slow request rather than an unbounded one.
    """
    if not pattern:
        raise ValueError("pattern is required")

    if regex:
        try:
            rx = re.compile(pattern, re.MULTILINE)
        except re.error as e:
            raise ValueError(f"정규식이 올바르지 않습니다: {e}") from e
    else:
        rx = re.compile(re.escape(pattern))

    sql = "SELECT * FROM turns WHERE chat_key = ?"
    params: list[Any] = [tk]
    if seq_from is not None:
        sql += " AND seq >= ?"
        params.append(seq_from)
    if seq_to is not None:
        sql += " AND seq <= ?"
        params.append(seq_to)
    if role:
        sql += " AND role = ?"
        params.append(role)
    sql += " ORDER BY seq LIMIT ?"
    params.append(max(1, min(20000, limit)))

    changes = []
    for r in db.query(sql, params):
        body = str(r["body"])
        try:
            new_body, n = rx.subn(replacement, body)
        except re.error as e:
            raise ValueError(f"치환 중 정규식 오류가 났습니다: {e}") from e
        if n and new_body != body:
            changes.append({
                "msgId": r["msg_id"],
                "seq": r["seq"],
                "role": r["role"],
                "hits": n,
                "before": body,
                "after": new_body,
            })

    applied = 0
    if not dry_run and changes:
        now = db.now()
        db.executemany(
            "UPDATE turns SET body = ?, updated_at = ? WHERE chat_key = ? AND msg_id = ?",
            [(c["after"], now, tk, c["msgId"]) for c in changes],
        )
        applied = len(changes)

    return {
        "chatKey": tk,
        "dryRun": dry_run,
        "matchedTurns": len(changes),
        "totalHits": sum(c["hits"] for c in changes),
        "applied": applied,
        "changes": changes,
    }


def bulk_set(tk: str, edits: list[dict], *, expect: bool = True) -> dict:
    """Apply an explicit list of per-turn bodies in one transaction.

    This is what an agent's staged batch lands through, and what a bulk preview
    turns into once approved. `expect` re-verifies each turn's current body
    against the `before` the caller was shown; a batch computed against a stale
    read is rejected whole rather than applied halfway.
    """
    if not edits:
        return {"applied": 0, "conflicts": []}

    conflicts = []
    rows = {r["msg_id"]: r for r in db.query("SELECT * FROM turns WHERE chat_key = ?", (tk,))}
    for e in edits:
        mid = str(e.get("msgId") or "")
        row = rows.get(mid)
        if row is None:
            conflicts.append({"msgId": mid, "reason": "not found"})
        elif expect and "before" in e and str(e["before"]) != str(row["body"]):
            conflicts.append({"msgId": mid, "reason": "changed since read"})
    if conflicts:
        return {"applied": 0, "conflicts": conflicts}

    now = db.now()
    db.executemany(
        "UPDATE turns SET body = ?, updated_at = ? WHERE chat_key = ? AND msg_id = ?",
        [(str(e.get("after") or ""), now, tk, str(e["msgId"])) for e in edits],
    )
    return {"applied": len(edits), "conflicts": []}


def rebase_original(tk: str) -> dict:
    """Make the current working turns the new baseline.

    Called once the plugin has actually written the chat back to RisuAI (or
    saved it as a copy). Until this runs, every edited turn keeps diffing
    against the pre-edit text, so a chat where a bulk replace touched all 394
    turns renders as 394 strike-through rows *after* the edit already shipped -
    which reads as "everything is still pending" when nothing is.

    Deliberately not automatic on write: the baseline may only move once the
    host confirms the write landed, and only the client knows that.
    """
    before = db.one(
        "SELECT COUNT(*) AS n FROM turns_original WHERE chat_key = ?", (tk,)
    )
    rows = db.query("SELECT * FROM turns WHERE chat_key = ? ORDER BY seq", (tk,))
    db.execute("DELETE FROM turns_original WHERE chat_key = ?", (tk,))
    db.executemany(
        "INSERT INTO turns_original(chat_key, seq, msg_id, role, body, time, name, extras_json) "
        "VALUES(?,?,?,?,?,?,?,?)",
        [(tk, r["seq"], r["msg_id"], r["role"], r["body"], r["time"], r["name"], r["extras_json"])
         for r in rows],
    )
    db.execute(
        "UPDATE chats SET orig_count = ?, updated_at = ? WHERE chat_key = ?",
        (len(rows), db.now(), tk),
    )
    return {
        "chatKey": tk,
        "previousBaseline": int(before["n"]) if before else 0,
        "newBaseline": len(rows),
    }


def reset_working(tk: str) -> None:
    rows = db.query("SELECT * FROM turns_original WHERE chat_key = ? ORDER BY seq", (tk,))
    now = db.now()
    db.execute("DELETE FROM turns WHERE chat_key = ?", (tk,))
    db.executemany(
        "INSERT INTO turns(chat_key, seq, msg_id, role, body, time, name, extras_json, origin, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,'original',?)",
        [(tk, r["seq"], r["msg_id"], r["role"], r["body"], r["time"], r["name"], r["extras_json"], now)
         for r in rows],
    )


# --- lorebook ---------------------------------------------------------------

def ingest_lore(ck: str, global_lore: list, local_by_chat: dict[str, tuple[list, bool]],
                *, global_reset: bool) -> None:
    """Load lorebook entries the same way turns and memory are loaded.

    Same reset rule as the turns, decided by the same call: a chat whose
    working turns were kept also keeps its working lore. The previous version
    deleted only the `original` rows and re-inserted them, which left every
    edited row beside a fresh copy of what it was edited from - the entry
    showed twice, and one of the two was a stale original.

    `local_by_chat` maps chat_key -> (entries, reset). A chat seen for the first
    time has no rows and is loaded regardless of the flag.
    """
    now = db.now()
    rows = []
    have_global = db.one("SELECT 1 AS x FROM lore_entries WHERE char_key = ? AND scope = 'global' LIMIT 1", (ck,))
    if global_reset or have_global is None:
        db.execute("DELETE FROM lore_entries WHERE char_key = ? AND scope = 'global'", (ck,))
        for i, e in enumerate(global_lore or []):
            rows.append((uuid.uuid4().hex, ck, "global", None, i, db.js(e), db.js(e), "original", now))
    for tk, (entries, reset) in local_by_chat.items():
        have = db.one("SELECT 1 AS x FROM lore_entries WHERE char_key = ? AND scope = 'local' "
                      "AND chat_key = ? LIMIT 1", (ck, tk))
        if not (reset or have is None):
            continue
        db.execute("DELETE FROM lore_entries WHERE char_key = ? AND scope = 'local' AND chat_key = ?", (ck, tk))
        for i, e in enumerate(entries or []):
            rows.append((uuid.uuid4().hex, ck, "local", tk, i, db.js(e), db.js(e), "original", now))
    if rows:
        db.executemany(
            "INSERT INTO lore_entries(id, char_key, scope, chat_key, seq, entry_json, original_json, "
            "origin, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            rows,
        )


def add_lore(ck: str, entry: dict, scope: str = "global", tk: str | None = None) -> str:
    row = db.one(
        "SELECT COALESCE(MAX(seq), -1) AS m FROM lore_entries WHERE char_key = ? AND scope = ?",
        (ck, scope),
    )
    seq = int(row["m"]) + 1 if row else 0
    lid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO lore_entries(id, char_key, scope, chat_key, seq, entry_json, origin, created_at) "
        "VALUES(?,?,?,?,?,?,'added',?)",
        (lid, ck, scope, tk, seq, db.js(entry), db.now()),
    )
    return lid


def lore(ck: str, scope: str | None = None) -> list[dict]:
    """Live entries only: a deleted original stays as a row until the deletion
    is committed (see `delete_lore`), but it is not something to list."""
    sql = "SELECT * FROM lore_entries WHERE char_key = ? AND origin <> 'deleted'"
    params: list[Any] = [ck]
    if scope:
        sql += " AND scope = ?"
        params.append(scope)
    sql += " ORDER BY scope, seq"
    return [
        {"id": r["id"], "scope": r["scope"], "chatKey": r["chat_key"], "seq": r["seq"],
         "origin": r["origin"], "entry": db.unjs(r["entry_json"], {})}
        for r in db.query(sql, params)
    ]


def update_lore(lore_id: str, entry: dict) -> dict:
    """Replace one lorebook entry.

    The whole entry is replaced rather than merged: a lorebook entry has fields
    we do not model (`selective`, `insertorder`, fork-specific extras), and a
    field-wise merge would have to know all of them to avoid dropping one. The
    caller reads, changes, and writes the object back whole.
    """
    row = db.one("SELECT * FROM lore_entries WHERE id = ? AND origin <> 'deleted'", (lore_id,))
    if row is None:
        raise LookupError("없는 로어북 항목입니다")
    text = db.js(entry)
    # Against the baseline, not against the last save: editing an entry back
    # to what RisuAI holds is not a change, and must not be written as one.
    if row["origin"] == "added":
        origin = "added"
    elif row["original_json"] is not None and row["original_json"] == text:
        origin = "original"
    else:
        origin = "edited"
    db.execute("UPDATE lore_entries SET entry_json = ?, origin = ? WHERE id = ?",
               (text, origin, lore_id))
    return {"id": lore_id, "entry": entry}


def lore_entry(lore_id: str) -> dict | None:
    row = db.one("SELECT * FROM lore_entries WHERE id = ? AND origin <> 'deleted'", (lore_id,))
    if row is None:
        return None
    d = db.row_to_dict(row) or {}
    return {
        "id": d["id"], "scope": d["scope"], "chatKey": d.get("chat_key"),
        "seq": d["seq"], "origin": d["origin"], "entry": db.unjs(d.get("entry_json"), {}),
    }


def delete_lore(lore_id: str) -> int:
    """Delete from the working copy.

    An entry we added is simply gone. One that came from RisuAI is kept as a
    `deleted` row instead: the write-back sends the whole list, so the deletion
    reaches RisuAI either way, but keeping the row is what lets the change
    summary say "1 deleted", a snapshot bring it back, and a commit know the
    baseline it is moving from.
    """
    row = db.one("SELECT origin FROM lore_entries WHERE id = ?", (lore_id,))
    if row is None or row["origin"] == "deleted":
        return 0
    if row["origin"] == "added":
        return db.execute("DELETE FROM lore_entries WHERE id = ?", (lore_id,)).rowcount or 0
    return db.execute("UPDATE lore_entries SET origin = 'deleted' WHERE id = ?", (lore_id,)).rowcount or 0


def move_lore(lore_id: str, to_seq: int) -> dict:
    """Reorder one entry within its scope. Dense renumber over the live rows,
    the same policy card.move_script uses - order is part of the material."""
    row = db.one("SELECT * FROM lore_entries WHERE id = ? AND origin <> 'deleted'", (lore_id,))
    if row is None:
        raise LookupError("없는 로어북 항목입니다")
    if row["scope"] == "local":
        where, params = "scope = 'local' AND chat_key = ?", (row["char_key"], row["chat_key"])
    else:
        where, params = "scope = 'global' AND chat_key IS NULL", (row["char_key"],)
    ids = [r["id"] for r in db.query(
        f"SELECT id FROM lore_entries WHERE char_key = ? AND {where} "
        "AND origin <> 'deleted' ORDER BY seq", params)]
    ids.remove(lore_id)
    pos = max(0, min(int(to_seq), len(ids)))
    ids.insert(pos, lore_id)
    for i, lid in enumerate(ids):
        db.execute("UPDATE lore_entries SET seq = ? WHERE id = ?", (i, lid))
    return {"id": lore_id, "seq": pos}


def lore_changes(ck: str, tk: str) -> dict:
    """What a write-back of this chat's lorebook would change, as counts."""
    rows = db.query(
        "SELECT origin FROM lore_entries WHERE char_key = ? AND scope = 'local' AND chat_key = ?",
        (ck, tk))
    out = {"added": 0, "edited": 0, "deleted": 0}
    for r in rows:
        if r["origin"] in out:
            out[r["origin"]] += 1
    out["total"] = out["added"] + out["edited"] + out["deleted"]
    return out


def rebase_lore(ck: str, tk: str) -> int:
    """Make the working lorebook the baseline, after RisuAI accepted it.

    Same meaning as `rebase_original` for turns and `memory.rebase`: deleted
    rows go for good, everything else becomes `original` as it stands now.
    """
    n = db.execute(
        "DELETE FROM lore_entries WHERE char_key = ? AND scope = 'local' AND chat_key = ? "
        "AND origin = 'deleted'", (ck, tk)).rowcount or 0
    n += db.execute(
        "UPDATE lore_entries SET origin = 'original', original_json = entry_json "
        "WHERE char_key = ? AND scope = 'local' AND chat_key = ? AND origin <> 'original'",
        (ck, tk)).rowcount or 0
    return n


def lore_rows(ck: str, tk: str) -> list[dict]:
    """This chat's local entries, whole rows, for a checkpoint."""
    return [
        dict(db.row_to_dict(r) or {})
        for r in db.query(
            "SELECT * FROM lore_entries WHERE char_key = ? AND scope = 'local' AND chat_key = ? "
            "ORDER BY seq", (ck, tk))
    ]


def restore_lore_rows(ck: str, tk: str, rows: list[dict]) -> int:
    """Put back exactly the rows a checkpoint captured, ids included, so an
    agent proposal that names an entry still names the same one afterwards."""
    db.execute("DELETE FROM lore_entries WHERE char_key = ? AND scope = 'local' AND chat_key = ?", (ck, tk))
    if rows:
        db.executemany(
            "INSERT INTO lore_entries(id, char_key, scope, chat_key, seq, entry_json, original_json, "
            "origin, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["id"], ck, "local", tk, int(r.get("seq") or 0), r.get("entry_json") or "{}",
              r.get("original_json"), r.get("origin") or "original",
              float(r.get("created_at") or db.now())) for r in rows],
        )
    return len(rows)


# The character-level (scope='global', chat_key IS NULL) twins of the four
# local functions above. Twins rather than a scope parameter on the originals:
# the local ones are called from the chat pipeline with a chat_key that the
# global scope must never see, and a shared function with an optional tk is
# exactly the kind of call site where a None slips in and matches every row.

def lore_changes_global(ck: str) -> dict:
    rows = db.query(
        "SELECT origin FROM lore_entries WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL",
        (ck,))
    out = {"added": 0, "edited": 0, "deleted": 0}
    for r in rows:
        if r["origin"] in out:
            out[r["origin"]] += 1
    out["total"] = out["added"] + out["edited"] + out["deleted"]
    return out


def rebase_lore_global(ck: str) -> int:
    n = db.execute(
        "DELETE FROM lore_entries WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL "
        "AND origin = 'deleted'", (ck,)).rowcount or 0
    n += db.execute(
        "UPDATE lore_entries SET origin = 'original', original_json = entry_json "
        "WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL AND origin <> 'original'",
        (ck,)).rowcount or 0
    return n


def lore_rows_global(ck: str) -> list[dict]:
    return [
        dict(db.row_to_dict(r) or {})
        for r in db.query(
            "SELECT * FROM lore_entries WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL "
            "ORDER BY seq", (ck,))
    ]


def restore_lore_rows_global(ck: str, rows: list[dict]) -> int:
    db.execute("DELETE FROM lore_entries WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL", (ck,))
    if rows:
        db.executemany(
            "INSERT INTO lore_entries(id, char_key, scope, chat_key, seq, entry_json, original_json, "
            "origin, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [(r["id"], ck, "global", None, int(r.get("seq") or 0), r.get("entry_json") or "{}",
              r.get("original_json"), r.get("origin") or "original",
              float(r.get("created_at") or db.now())) for r in rows],
        )
    return len(rows)


def reset_lore_global(ck: str) -> int:
    """Working copy back to the baseline: added rows go, everything else
    becomes its original again. Rows that predate original_json are left as
    they stand - there is nothing recorded to return them to."""
    n = db.execute(
        "DELETE FROM lore_entries WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL "
        "AND origin = 'added'", (ck,)).rowcount or 0
    n += db.execute(
        "UPDATE lore_entries SET entry_json = original_json, origin = 'original' "
        "WHERE char_key = ? AND scope = 'global' AND chat_key IS NULL "
        "AND origin <> 'original' AND original_json IS NOT NULL",
        (ck,)).rowcount or 0
    return n


# --- search -----------------------------------------------------------------

_TERM = re.compile(r"[^\s]+")


def search(char_key_: str, query: str, chat_keys: list[str] | None = None,
           limit: int = 40) -> list[dict]:
    """Cross-chat body search.

    A plain LIKE scan, scoped to one character. There was an FTS5 trigram index
    here; it was measured at 2 ms for three queries over 60,000 turns versus
    the same 2 ms for LIKE, and removed. See db.py for the rest of that.

    Every term is matched independently and results are ranked by how many
    terms hit, so a two-syllable Korean word - which trigram could not match at
    all - works the same as any other.
    """
    terms = [t for t in _TERM.findall(query or "") if t]
    if not terms:
        return []

    scope_sql = "t.chat_key IN (SELECT chat_key FROM chats WHERE char_key = ?)"
    params: list[Any] = [char_key_]
    if chat_keys:
        marks = ",".join("?" * len(chat_keys))
        scope_sql = f"t.chat_key IN ({marks})"
        params = list(chat_keys)

    hits: dict[int, dict] = {}
    for term in terms:
        rows = db.query(
            f"SELECT t.* FROM turns t WHERE {scope_sql} AND t.body LIKE ? LIMIT ?",
            [*params, f"%{term}%", limit * 4],
        )
        for r in rows:
            h = hits.setdefault(int(r["id"]), {"row": r, "matched": 0})
            h["matched"] += 1

    ordered = sorted(
        hits.values(),
        key=lambda h: (-h["matched"], -int(h["row"]["seq"])),
    )[:limit]

    out = []
    for h in ordered:
        r = h["row"]
        out.append({
            "chatKey": r["chat_key"],
            "seq": r["seq"],
            "msgId": r["msg_id"],
            "role": r["role"],
            "matchedTerms": h["matched"],
            "excerpt": _excerpt(str(r["body"]), terms),
        })
    return out


def _excerpt(body: str, terms: list[str], width: int = 160) -> str:
    lower = body.lower()
    at = -1
    for t in terms:
        at = lower.find(t.lower())
        if at >= 0:
            break
    if at < 0:
        return body[:width]
    start = max(0, at - width // 3)
    end = min(len(body), start + width)
    return ("…" if start else "") + body[start:end] + ("…" if end < len(body) else "")


# --- diff / patch -----------------------------------------------------------

def patch(tk: str) -> dict:
    """What the plugin must write back, including structural change.

    When turns were inserted, deleted or reordered, a per-turn patch cannot
    express the result, so the full ordered message array is returned instead
    and the plugin rebuilds `chat.message` wholesale. `edits` alone is only
    valid when `structural` is false - the client checks that flag, rather than
    guessing from whether the lists are empty.
    """
    cur = db.query("SELECT * FROM turns WHERE chat_key = ? ORDER BY seq", (tk,))
    orig = db.query("SELECT * FROM turns_original WHERE chat_key = ? ORDER BY seq", (tk,))
    orig_by = {r["msg_id"]: r for r in orig if r["msg_id"]}
    cur_ids = [r["msg_id"] for r in cur]

    edits, added = [], []
    for r in cur:
        was = orig_by.get(r["msg_id"])
        if was is None:
            added.append({"msgId": r["msg_id"], "seq": r["seq"], "role": r["role"], "after": r["body"]})
        elif was["body"] != r["body"]:
            edits.append({"msgId": r["msg_id"], "seq": r["seq"],
                          "before": was["body"], "after": r["body"]})

    removed = [
        {"msgId": r["msg_id"], "seq": r["seq"], "before": r["body"]}
        for r in orig if r["msg_id"] and r["msg_id"] not in set(cur_ids)
    ]
    reordered = [r["msg_id"] for r in orig if r["msg_id"] in set(cur_ids)] != \
                [m for m in cur_ids if m in orig_by]
    structural = bool(added or removed or reordered)

    out: dict[str, Any] = {
        "chatKey": tk,
        "edits": edits,
        "added": added,
        "removed": removed,
        "reordered": reordered,
        "structural": structural,
        "warnings": [],
    }
    if structural:
        out["messages"] = [_to_message(r) for r in cur]
        out["warnings"].extend(_hypa_warnings(tk, set(cur_ids)))
    return out


def _to_message(r: Any) -> dict:
    m: dict[str, Any] = {
        "role": r["role"],
        "data": r["body"],
        "chatId": r["msg_id"],
    }
    if r["time"] is not None:
        m["time"] = r["time"]
    if r["name"]:
        m["name"] = r["name"]
    extras = db.unjs(r["extras_json"], None)
    if isinstance(extras, dict):
        m.update(extras)
    return m


def _hypa_warnings(tk: str, live_ids: set[str]) -> list[str]:
    """Deleting turns orphans the summaries that cite them.

    hypa keys its summaries by Message.chatId, so cutting the early turns of a
    chat - exactly the job this feature exists for - leaves those summaries
    pointing at messages that no longer exist. Silent is not an option here.
    """
    row = db.one("SELECT meta_json FROM chats WHERE chat_key = ?", (tk,))
    if row is None:
        return []
    meta = db.unjs(row["meta_json"], {}) or {}
    chat_fields = (meta.get("chat") or {}) if isinstance(meta, dict) else {}
    warnings = []
    for key in ("hypaV3Data", "hypaV2Data"):
        data = chat_fields.get(key)
        if not isinstance(data, dict):
            continue
        cited: set[str] = set()
        for group in ("summaries", "mainChunks"):
            for s in data.get(group) or []:
                if isinstance(s, dict):
                    cited.update(str(m) for m in (s.get("chatMemos") or []))
        orphans = cited - live_ids
        if orphans:
            warnings.append(
                f"{key}: 삭제된 턴을 인용하는 요약 {len(orphans)}건이 고아가 됩니다"
            )
    return warnings


def export_envelope(tk: str) -> dict:
    row = chat_row(tk)
    if row is None:
        raise LookupError(f"unknown chat: {tk}")
    meta = db.unjs(row["meta_json"], {}) or {}
    cur = db.query("SELECT * FROM turns WHERE chat_key = ? ORDER BY seq", (tk,))
    chat_fields = dict((meta.get("chat") or {}) if isinstance(meta, dict) else {})
    chat_fields["message"] = [_to_message(r) for r in cur]
    envelope_rest = dict((meta.get("envelope") or {}) if isinstance(meta, dict) else {})
    out = {"type": chatfmt.ENVELOPE_TYPE, "ver": chatfmt.ENVELOPE_VER}
    out.update(envelope_rest)
    out["data"] = chat_fields
    return out


def export_markdown(tk: str) -> str:
    return chatfmt.decode(export_envelope(tk))["markdown"]
