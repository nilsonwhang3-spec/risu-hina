"""Merge conflicts: listing them, and resolving one.

A conflict is recorded by `app/merge.py` when a row and RisuAI's copy of it
both moved away from the same baseline. The row keeps **our** text - nothing
is ever overwritten to make a conflict - and the baseline moves to RisuAI's
current value, so the two sides of the diff are exactly "mine" and "RisuAI's",
with the common ancestor kept in `conflict_json.base`.

Five tables carry the flag rather than one central table, because each of them
already has delete-and-recreate paths (restore, reset, force reload) and a
separate table would need a matching cleanup in every one of them. A column
cannot be forgotten.

Resolving is deliberately small:

    mine    drop the flag. The row already holds our text and the baseline
            already holds RisuAI's, so it goes back to reading as an ordinary
            edited row - which is true, and write-back will ship it.
    theirs  put the baseline into the working copy and drop the flag. This is
            the only path here that discards work, so it snapshots first.
"""
from __future__ import annotations

from . import db, log, snapshots

# kind -> (table, working column, baseline column, label column)
TABLES: dict[str, tuple[str, str, str, str]] = {
    "turn": ("turns", "body", "", "msg_id"),
    "card_field": ("card_fields", "body", "original", "field"),
    "card_script": ("card_scripts", "entry_json", "original_json", "kind"),
    "lore": ("lore_entries", "entry_json", "original_json", "scope"),
    "memory": ("memories", "body", "original", "title"),
}


class ConflictError(ValueError):
    pass


def _rows(kind: str, where: str, params: tuple) -> list[dict]:
    table = TABLES[kind][0]
    return [db.row_to_dict(r) for r in db.query(
        f"SELECT * FROM {table} WHERE conflict_json IS NOT NULL AND {where}", params)]


def listing(char_key: str = "", chat_key: str = "") -> dict:
    """Every open conflict for a bot and/or one of its chats."""
    out: list[dict] = []
    if chat_key:
        for kind in ("turn", "memory"):
            for r in _rows(kind, "chat_key = ?", (chat_key,)):
                out.append(_public(kind, r))
        for r in _rows("lore", "chat_key = ?", (chat_key,)):
            out.append(_public("lore", r))
    if char_key:
        for kind in ("card_field", "card_script"):
            for r in _rows(kind, "char_key = ?", (char_key,)):
                out.append(_public(kind, r))
        for r in _rows("lore", "char_key = ? AND scope = 'global'", (char_key,)):
            out.append(_public("lore", r))
    return {"conflicts": out, "total": len(out)}


def count_for_chat(chat_key: str) -> int:
    n = 0
    for kind in ("turn", "memory"):
        n += len(_rows(kind, "chat_key = ?", (chat_key,)))
    n += len(_rows("lore", "chat_key = ?", (chat_key,)))
    return n


def count_for_card(char_key: str) -> int:
    n = 0
    for kind in ("card_field", "card_script"):
        n += len(_rows(kind, "char_key = ?", (char_key,)))
    n += len(_rows("lore", "char_key = ? AND scope = 'global'", (char_key,)))
    return n


def _public(kind: str, r: dict) -> dict:
    _, work_col, base_col, label_col = TABLES[kind]
    c = db.unjs(r.get("conflict_json"), {}) or {}
    mine = r.get(work_col)
    theirs = c.get("theirs")
    return {
        "kind": kind,
        "id": str(r.get("id")),
        "label": str(r.get(label_col) or ""),
        "charKey": r.get("char_key"),
        "chatKey": r.get("chat_key"),
        # `theirs` is None when RisuAI no longer has the item at all.
        "reason": c.get("kind"),
        "tier": c.get("tier"),
        "mine": db.unjs(mine, mine) if work_col.endswith("_json") else mine,
        "theirs": theirs,
        "base": c.get("base"),
        "canTakeTheirs": theirs is not None or c.get("kind") == "deleted-upstream",
    }


def resolve(kind: str, row_id: str, choice: str) -> dict:
    if kind not in TABLES:
        raise ConflictError(f"모르는 종류입니다: {kind}")
    if choice not in ("mine", "theirs"):
        raise ConflictError("choice 는 mine 또는 theirs 여야 합니다")
    table, work_col, base_col, _ = TABLES[kind]
    row = db.one(f"SELECT * FROM {table} WHERE id = ?", (row_id,))
    if row is None or row["conflict_json"] is None:
        raise ConflictError("이미 정리된 충돌입니다")
    r = db.row_to_dict(row) or {}
    info = db.unjs(r.get("conflict_json"), {}) or {}

    if choice == "mine":
        db.execute(f"UPDATE {table} SET conflict_json = NULL WHERE id = ?", (row_id,))
        log.info("conflict kept-mine %s %s", kind, row_id)
        return {"ok": True, "kind": kind, "id": row_id, "choice": choice}

    # Taking RisuAI's copy overwrites work, so it is undoable.
    _snapshot(kind, r)
    if info.get("kind") == "deleted-upstream":
        if kind in ("lore", "card_script"):
            # Same tombstone the panel's own delete uses, so the write-back
            # leaves it out of the list instead of the row simply vanishing.
            db.execute(f"UPDATE {table} SET origin = 'deleted', conflict_json = NULL WHERE id = ?", (row_id,))
        else:
            db.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
        log.info("conflict took-theirs(delete) %s %s", kind, row_id)
        return {"ok": True, "kind": kind, "id": row_id, "choice": choice, "deleted": True}

    if kind == "turn":
        # Turns keep their baseline in turns_original, not on the row.
        was = db.one("SELECT body FROM turns_original WHERE chat_key = ? AND msg_id = ?",
                     (r.get("chat_key"), r.get("msg_id")))
        if was is None:
            raise ConflictError("RisuAI 쪽 값을 찾지 못했습니다")
        db.execute("UPDATE turns SET body = ?, conflict_json = NULL, updated_at = ? WHERE id = ?",
                   (was["body"], db.now(), row_id))
    else:
        base = r.get(base_col)
        if base is None:
            raise ConflictError("RisuAI 쪽 값이 없어 되돌릴 수 없습니다")
        extra = ", origin = 'original'" if kind in ("lore", "card_script") else ""
        db.execute(f"UPDATE {table} SET {work_col} = ?, conflict_json = NULL{extra} WHERE id = ?",
                   (base, row_id))
    log.info("conflict took-theirs %s %s", kind, row_id)
    return {"ok": True, "kind": kind, "id": row_id, "choice": choice}


def resolve_all(kind_filter: str, choice: str, *, char_key: str = "", chat_key: str = "") -> dict:
    """One click for a whole material - the escape from a list of forty."""
    items = listing(char_key, chat_key)["conflicts"]
    done = 0
    for c in items:
        if kind_filter and c["kind"] != kind_filter:
            continue
        try:
            resolve(c["kind"], c["id"], choice)
            done += 1
        except ConflictError:
            continue
    return {"ok": True, "resolved": done}


def _snapshot(kind: str, row: dict) -> None:
    try:
        if kind in ("turn", "memory") or (kind == "lore" and row.get("chat_key")):
            if row.get("chat_key"):
                snapshots.create(str(row["chat_key"]), "충돌 해결 직전", kind="auto")
        elif row.get("char_key"):
            snapshots.create_card(str(row["char_key"]), "충돌 해결 직전", kind="auto")
    except Exception as e:  # noqa: BLE001 - a snapshot failure must not block the fix
        log.warn("conflict snapshot failed: %s", e)
