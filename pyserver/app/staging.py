"""Staged edits: the approval gate between the agent and the transcript.

The agent never writes to `turns`. It writes proposals here, and a proposal
becomes an edit only when a person approves it.

This lives in a table rather than in the agent framework's own deferred-tool
mechanism on purpose. The approver is a human on the other side of an HTTP
boundary, so the state has to survive a backend restart, a closed panel, and a
library upgrade. A staged batch that outlives the run that produced it is the
normal case, not an edge case.

Batches are all-or-nothing on apply: a bulk rewrite that lands halfway is worse
than one that does not land at all, because the half that landed is invisible.
"""
from __future__ import annotations

import uuid
from typing import Any, Iterable

from . import db, log, store

# op values, and what each carries:
#   edit        target_msg_id, before, after
#   insert      target_msg_id = anchor (may be empty for head), after, role
#   delete      target_msg_id, before
OPS = ("edit", "insert", "delete")

PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
APPLIED = "applied"


def new_batch() -> str:
    return uuid.uuid4().hex


def stage(
    chat_key: str,
    op: str,
    *,
    session_id: str | None = None,
    batch_id: str | None = None,
    msg_id: str = "",
    before: str | None = None,
    after: str | None = None,
    reason: str = "",
    seq: int | None = None,
) -> str:
    if op not in OPS:
        raise ValueError(f"unknown op: {op}")
    sid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO staged_edits(id, session_id, chat_key, op, target_chat_id, turn_index, "
        "before, after, reason, status, batch_id, created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        (sid, session_id, chat_key, op, msg_id, seq, before, after, reason, PENDING,
         batch_id, db.now()),
    )
    return sid


def stage_many(chat_key: str, items: Iterable[dict], *, session_id: str | None = None,
               reason: str = "") -> dict:
    """Stage a group that must be approved and applied together."""
    batch = new_batch()
    ids = []
    for it in items:
        ids.append(stage(
            chat_key,
            str(it.get("op") or "edit"),
            session_id=session_id,
            batch_id=batch,
            msg_id=str(it.get("msgId") or ""),
            before=it.get("before"),
            after=it.get("after"),
            reason=str(it.get("reason") or reason),
            seq=it.get("seq"),
        ))
    log.info("staged batch=%s chat=%s items=%s", batch, chat_key, len(ids))
    return {"batchId": batch, "staged": len(ids), "ids": ids}


def pending(chat_key: str) -> list[dict]:
    rows = db.query(
        "SELECT * FROM staged_edits WHERE chat_key = ? AND status = ? ORDER BY created_at, turn_index",
        (chat_key, PENDING),
    )
    return [_row(r) for r in rows]


def by_batch(batch_id: str) -> list[dict]:
    return [_row(r) for r in db.query(
        "SELECT * FROM staged_edits WHERE batch_id = ? ORDER BY turn_index, created_at", (batch_id,)
    )]


def _row(r: Any) -> dict:
    return {
        "id": r["id"],
        "sessionId": r["session_id"],
        "chatKey": r["chat_key"],
        "op": r["op"],
        "msgId": r["target_chat_id"],
        "seq": r["turn_index"],
        "before": r["before"],
        "after": r["after"],
        "reason": r["reason"],
        "status": r["status"],
        "batchId": r["batch_id"],
        "createdAt": r["created_at"],
    }


def decide(ids: list[str], approve: bool) -> int:
    if not ids:
        return 0
    marks = ",".join("?" * len(ids))
    cur = db.execute(
        f"UPDATE staged_edits SET status = ?, decided_at = ? "
        f"WHERE id IN ({marks}) AND status = ?",
        (APPROVED if approve else REJECTED, db.now(), *ids, PENDING),
    )
    return cur.rowcount or 0


def decide_batch(batch_id: str, approve: bool) -> int:
    cur = db.execute(
        "UPDATE staged_edits SET status = ?, decided_at = ? WHERE batch_id = ? AND status = ?",
        (APPROVED if approve else REJECTED, db.now(), batch_id, PENDING),
    )
    return cur.rowcount or 0


def apply_approved(chat_key: str) -> dict:
    """Commit every approved-but-unapplied proposal for this chat.

    Verifies each `before` against the live turn first and refuses the whole set
    on any mismatch. A staged batch can be minutes old; if the transcript moved
    underneath it, applying part of it would silently produce something nobody
    reviewed.
    """
    rows = db.query(
        "SELECT * FROM staged_edits WHERE chat_key = ? AND status = ? ORDER BY turn_index, created_at",
        (chat_key, APPROVED),
    )
    if not rows:
        return {"applied": 0, "conflicts": [], "ops": {}}

    conflicts = []
    for r in rows:
        if r["op"] in ("edit", "delete"):
            cur = store.turn_by_msg(chat_key, r["target_chat_id"] or "")
            if cur is None:
                conflicts.append({"id": r["id"], "msgId": r["target_chat_id"], "reason": "턴이 없습니다"})
            elif r["before"] is not None and str(cur["body"]) != str(r["before"]):
                conflicts.append({"id": r["id"], "msgId": r["target_chat_id"],
                                  "reason": "승인 이후 턴이 바뀌었습니다"})
    if conflicts:
        log.warn("apply refused chat=%s conflicts=%s", chat_key, len(conflicts))
        return {"applied": 0, "conflicts": conflicts, "ops": {}}

    counts = {"edit": 0, "insert": 0, "delete": 0}
    # Deletes last: applying them first would renumber seq under the inserts.
    for r in [x for x in rows if x["op"] == "edit"]:
        store.set_body(chat_key, r["target_chat_id"], str(r["after"] or ""))
        counts["edit"] += 1
    for r in [x for x in rows if x["op"] == "insert"]:
        store.insert_turn(
            chat_key,
            (r["target_chat_id"] or None),
            "char",
            str(r["after"] or ""),
        )
        counts["insert"] += 1
    dels = [r["target_chat_id"] for r in rows if r["op"] == "delete" and r["target_chat_id"]]
    if dels:
        counts["delete"] = store.delete_turns(chat_key, dels)

    ids = [r["id"] for r in rows]
    marks = ",".join("?" * len(ids))
    db.execute(
        f"UPDATE staged_edits SET status = ? WHERE id IN ({marks})", (APPLIED, *ids)
    )
    log.info("applied chat=%s %s", chat_key, counts)
    return {"applied": sum(counts.values()), "conflicts": [], "ops": counts}


def clear(chat_key: str, *, only_pending: bool = True) -> int:
    sql = "DELETE FROM staged_edits WHERE chat_key = ?"
    params: list[Any] = [chat_key]
    if only_pending:
        sql += " AND status = ?"
        params.append(PENDING)
    return db.execute(sql, params).rowcount or 0
