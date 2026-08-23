"""The approval gate for everything the agent writes that is not a turn.

`staging.py` already gates edits to the transcript. This is the same idea for
the rest: lorebook entries, long-term memory, snapshot restores, exports, and
the two things only the plugin can do - writing back to RisuAI and saving a
copy of the chat.

**Why a queue rather than "the agent asks in prose".**

Telling a model to confirm before writing is an instruction, and instructions
are followed most of the time. That is fine for tone and wrong for a write: the
one run in twenty that skips the question is the run that silently rewrites a
lorebook. So the tool physically cannot perform the write. It records what it
intends to do and returns "승인이 필요합니다"; the act happens when a person
clicks, in `decide()`.

**Two executors, one queue.**

Some actions the backend can perform itself. Two cannot: writing to the live
RisuAI chat and saving a copy both go through host APIs that exist only inside
the plugin's iframe. Those are marked `host` and `decide()` hands them back to
the plugin to carry out. Pretending the backend could do them - or hiding them
from the agent entirely - would both be worse than saying which side acts.
"""
from __future__ import annotations

import uuid
from typing import Any, Callable

from . import db, log

PENDING = "pending"
APPROVED = "approved"
REJECTED = "rejected"
DONE = "done"
FAILED = "failed"

# Actions the plugin has to carry out, because the capability lives there.
HOST_KINDS = ("host_writeback", "host_save_copy")


class ActionError(ValueError):
    pass


def propose(kind: str, *, chat_key: str, char_key: str, summary: str,
            args: dict | None = None, session_id: str | None = None) -> dict:
    """Record an intent. Nothing happens until someone approves it."""
    if kind not in EXECUTORS and kind not in HOST_KINDS:
        raise ActionError(f"모르는 작업입니다: {kind}")
    aid = uuid.uuid4().hex
    db.execute(
        "INSERT INTO pending_actions(id, session_id, chat_key, char_key, kind, "
        "args_json, summary, status, created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (aid, session_id, chat_key, char_key, kind, db.js(args or {}), summary,
         PENDING, db.now()),
    )
    log.info("action proposed id=%s kind=%s chat=%s", aid, kind, chat_key)
    return {"id": aid, "kind": kind, "summary": summary}


def _row(r: Any) -> dict:
    d = db.row_to_dict(r) or {}
    return {
        "id": d.get("id"),
        "chatKey": d.get("chat_key"),
        "charKey": d.get("char_key"),
        "kind": d.get("kind"),
        "summary": d.get("summary") or "",
        "args": db.unjs(d.get("args_json"), {}),
        "status": d.get("status"),
        "byHost": d.get("kind") in HOST_KINDS,
        "result": d.get("result") or "",
        "createdAt": d.get("created_at"),
    }


def pending(chat_key: str) -> list[dict]:
    rows = db.query(
        "SELECT * FROM pending_actions WHERE chat_key = ? AND status = ? "
        "ORDER BY created_at", (chat_key, PENDING))
    return [_row(r) for r in rows]


def get(action_id: str) -> dict | None:
    r = db.one("SELECT * FROM pending_actions WHERE id = ?", (action_id,))
    return _row(r) if r is not None else None


def clear(chat_key: str) -> int:
    return db.execute(
        "DELETE FROM pending_actions WHERE chat_key = ? AND status = ?",
        (chat_key, PENDING)).rowcount or 0


def decide(action_id: str, approve: bool) -> dict:
    """Approve and run, or reject. The only place an action actually happens."""
    act = get(action_id)
    if act is None:
        raise ActionError("없는 작업입니다")
    if act["status"] != PENDING:
        raise ActionError(f"이미 처리된 작업입니다 ({act['status']})")

    if not approve:
        _finish(action_id, REJECTED, "")
        return {"id": action_id, "approved": False, "kind": act["kind"]}

    if act["kind"] in HOST_KINDS:
        # Approved, but the plugin has to do it and report back. Leaving it
        # APPROVED rather than DONE is what makes a failure on that side
        # visible instead of a queue entry that claims success.
        db.execute("UPDATE pending_actions SET status = ?, decided_at = ? WHERE id = ?",
                   (APPROVED, db.now(), action_id))
        return {"id": action_id, "approved": True, "kind": act["kind"],
                "host": {"kind": act["kind"], "args": act["args"]}}

    try:
        result = EXECUTORS[act["kind"]](act)
    except Exception as e:  # noqa: BLE001 - the message goes back to the user
        _finish(action_id, FAILED, f"{type(e).__name__}: {e}")
        raise ActionError(f"실행하지 못했습니다: {e}") from e
    _finish(action_id, DONE, str(result)[:500])
    return {"id": action_id, "approved": True, "kind": act["kind"], "result": result}


def complete(action_id: str, ok: bool, detail: str = "") -> dict:
    """The plugin reporting back on a host action it just carried out."""
    act = get(action_id)
    if act is None:
        raise ActionError("없는 작업입니다")
    _finish(action_id, DONE if ok else FAILED, detail[:500])
    return {"id": action_id, "status": DONE if ok else FAILED}


def _finish(action_id: str, status: str, result: str) -> None:
    db.execute(
        "UPDATE pending_actions SET status = ?, result = ?, decided_at = ? WHERE id = ?",
        (status, result, db.now(), action_id),
    )


# --- executors ---------------------------------------------------------------
#
# Imported lazily inside each function: actions.py is imported by agent.py,
# which is imported by session.py, and a module-level import of store/memory
# here would close that loop.

def _memory_edit(a: dict) -> str:
    from . import memory as mem
    got = mem.update(a["args"]["id"], a["args"]["body"])
    return f"[{got['kind']} #{got['seq']}] 을(를) 고쳤습니다"


def _memory_delete(a: dict) -> str:
    from . import memory as mem
    mem.delete(a["args"]["id"])
    return "장기기억 항목을 지웠습니다"


def _lore_edit(a: dict) -> str:
    from . import store
    store.update_lore(a["args"]["id"], a["args"]["entry"])
    return "로어북 항목을 고쳤습니다"


def _lore_add(a: dict) -> str:
    from . import store
    args = a["args"]
    lid = store.add_lore(a["charKey"], args["entry"],
                         args.get("scope") or "local", a["chatKey"])
    return f"로어북 항목을 추가했습니다 (id={lid})"


def _lore_delete(a: dict) -> str:
    from . import store
    store.delete_lore(a["args"]["id"])
    return "로어북 항목을 지웠습니다"


def _checkpoint_restore(a: dict) -> str:
    from . import snapshots
    out = snapshots.restore(a["chatKey"], a["args"]["id"])
    return f"스냅샷으로 되돌렸습니다 ({out['messageCount']}턴)"


def _checkpoint_create(a: dict) -> str:
    from . import snapshots
    cid = snapshots.create(a["chatKey"], a["args"].get("label") or "에이전트")
    return f"스냅샷을 저장했습니다 (id={cid})"


EXECUTORS: dict[str, Callable[[dict], str]] = {
    "memory_edit": _memory_edit,
    "memory_delete": _memory_delete,
    "lore_edit": _lore_edit,
    "lore_add": _lore_add,
    "lore_delete": _lore_delete,
    "checkpoint_restore": _checkpoint_restore,
    "checkpoint_create": _checkpoint_create,
}
