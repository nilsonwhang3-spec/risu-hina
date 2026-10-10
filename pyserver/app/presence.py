"""Which of Hina's bots RisuAI still has (§1-102).

Hina keeps a working copy for every bot ever opened in the panel, keyed by the
RisuAI chaId. RisuAI and PocketRisu give an imported .charx a NEW chaId, so a
bot imported again (Over The Next 0.2 → 0.3) is a second row here, and the old
one stays after the user deletes or trashes it in RisuAI. Nothing told the two
apart, and the reference tools (and the AI) saw both.

What a plugin can see, measured against the upstream sources (2026-10-10):

- RisuAI: the trash is the live `characters` entry carrying `trashTime`; the
  boot after three days removes it for good (src/ts/bootstrap.ts).
- PocketRisu: trash and 비활성화 move the character OUT of `characters` into
  `nodeOnlyArchivedCharacters` (a stub; trash = stub + `trashedAt`), and
  가리기 lists its chaId in `nodeOnlyHiddenCharacterIds`. Neither key is in the
  plugin API's allowed list - so to a plugin a PocketRisu trashed or
  deactivated bot is simply gone, and a hidden one is live.

Hence three states, recorded when the panel compares (POST /bots/presence):
`live`, `trash` (RisuAI trash, with its time), `missing` (not in this RisuAI:
deleted, PocketRisu 휴지통/비활성화, or another device's). '' = never compared.
Opening a bot in the panel (workspace.materialize) marks it live.

`forget` removes Hina's copy of a bot RisuAI no longer has. It never touches
RisuAI, and the user's files under projects/ stay.
"""
from __future__ import annotations

import shutil
import time

from . import db, log

STATES = ("live", "trash", "missing")
# RisuAI empties its trash this long after trashTime (bootstrap.ts).
TRASH_DAYS = 3


class PresenceError(Exception):
    pass


def _bots() -> list[dict]:
    from . import home
    from . import modules as modmod
    out = []
    for r in db.query("SELECT char_key, cha_id, name, updated_at, risu_state, risu_trash_time, risu_checked_at "
                      "FROM characters ORDER BY updated_at DESC"):
        ck = r["char_key"]
        if home.is_home(ck) or modmod.is_module_key(ck):
            continue
        out.append(dict(r))
    return out


def mark_live(char_key: str) -> None:
    """The panel just read this bot from RisuAI: it is there, not in the trash."""
    db.execute("UPDATE characters SET risu_state = 'live', risu_trash_time = 0, risu_checked_at = ? "
               "WHERE char_key = ?", (time.time(), char_key))


def record(characters: list[dict]) -> dict:
    """Compare Hina's bots with RisuAI's list as the plugin read it.

    `characters`: [{chaId, name?, trashTime?}] - every entry of RisuAI's
    `characters` (the trash included). An empty list is refused: a failed
    read must not turn every bot into an orphan."""
    seen: dict[str, int] = {}
    for c in characters or []:
        cid = str((c or {}).get("chaId") or "")
        if not cid or cid in ("§temp", "§playground"):
            continue
        try:
            tt = int(float((c or {}).get("trashTime") or 0))
        except (TypeError, ValueError):
            tt = 0
        seen[cid] = tt
    if not seen:
        raise PresenceError("RisuAI 캐릭터 목록이 비어 있습니다 - 대조하지 않았습니다")
    now = time.time()
    counts = {s: 0 for s in STATES}
    with db.transaction():
        for b in _bots():
            cid = str(b["cha_id"] or "")
            if cid in seen:
                state, tt = ("trash", seen[cid]) if seen[cid] else ("live", 0)
            else:
                state, tt = "missing", 0
            counts[state] += 1
            db.execute("UPDATE characters SET risu_state = ?, risu_trash_time = ?, risu_checked_at = ? "
                       "WHERE char_key = ?", (state, tt, now, b["char_key"]))
    log.info("bot presence: %s (RisuAI %d)", counts, len(seen))
    return {"counts": counts, "risuCount": len(seen), "bots": listing()}


def _norm(name: str) -> str:
    return "".join(ch for ch in (name or "").casefold() if ch.isalnum())


def state_of(char_key: str) -> str:
    r = db.one("SELECT risu_state FROM characters WHERE char_key = ?", (char_key,))
    return (r["risu_state"] if r else "") or ""


def listing() -> list[dict]:
    """Every bot with its RisuAI state, the work Hina holds for it, and
    whether a live bot of the same name exists (the usual reason for an
    orphan: the same bot imported again as a new version)."""
    from . import card as cardmod
    bots = _bots()
    live_names = {}
    for b in bots:
        if b["risu_state"] == "live":
            live_names.setdefault(_norm(b["name"]), []).append(b["name"])
    out = []
    for b in bots:
        ck = b["char_key"]
        chats = db.one("SELECT COUNT(*) AS n, COALESCE(SUM((SELECT COUNT(*) FROM turns t WHERE t.chat_key = c.chat_key)), 0) AS t "
                       "FROM chats c WHERE c.char_key = ?", (ck,))
        pending = db.one("SELECT COUNT(*) AS n FROM pending_actions WHERE char_key = ? AND status = 'pending'", (ck,))["n"]
        same = [n for n in live_names.get(_norm(b["name"]), [])] if b["risu_state"] != "live" else []
        tt = int(b["risu_trash_time"] or 0)
        out.append({
            "charKey": ck, "chaId": b["cha_id"], "name": b["name"] or "",
            "state": b["risu_state"] or "", "trashTime": tt,
            "purgeAt": (tt + TRASH_DAYS * 86400 * 1000) if tt else 0,
            "checkedAt": b["risu_checked_at"] or 0, "updatedAt": b["updated_at"],
            "chats": chats["n"], "turns": chats["t"], "pendingActions": pending,
            "liveNamesake": bool(same),
            # A card uploaded before the full-card format cannot become a .charx.
            "charxReady": cardmod.is_full(ck),
        })
    return out


def _shares_dir(char_key: str) -> bool:
    """Whether another bot's working copy lives in the same system directory
    (copies and new versions share their family's - workspace.root)."""
    r = db.one("SELECT family_key FROM characters WHERE char_key = ?", (char_key,))
    fam = (r["family_key"] if r else "") or ""
    dir_key = fam or char_key
    other = db.one("SELECT 1 FROM characters WHERE char_key <> ? AND (char_key = ? OR family_key = ?)",
                   (char_key, dir_key, dir_key))
    return other is not None


def forget(char_key: str) -> dict:
    """Remove Hina's copy of a bot RisuAI no longer has (or holds in its trash).

    Refused for a bot RisuAI has live, or one never compared: deleting the
    working copy of a live bot would throw away edits not yet 반영.
    The RisuAI side is never touched; files under projects/ stay."""
    from . import home, workspace
    from . import modules as modmod
    row = db.one("SELECT char_key, name, risu_state FROM characters WHERE char_key = ?", (char_key,))
    if row is None:
        raise PresenceError("없는 봇입니다")
    if home.is_home(char_key) or modmod.is_module_key(char_key):
        raise PresenceError("봇이 아닙니다")
    state = row["risu_state"] or ""
    if state not in ("missing", "trash"):
        raise PresenceError("RisuAI에 있는 봇(또는 아직 대조하지 않은 봇)은 지울 수 없습니다 - 먼저 'RisuAI와 대조'를 눌러 주세요")
    sys_dir = None
    try:
        if not _shares_dir(char_key):
            sys_dir = workspace.root(char_key)
    except Exception:  # noqa: BLE001 - an odd key: rows still go
        sys_dir = None
    chat_keys = [r["chat_key"] for r in db.query("SELECT chat_key FROM chats WHERE char_key = ?", (char_key,))]
    removed: dict[str, int] = {}
    with db.transaction():
        def gone(table: str, sql: str, params) -> None:
            cur = db.execute(sql, params)
            n = getattr(cur, "rowcount", 0) or 0
            if n:
                removed[table] = removed.get(table, 0) + n
        for ck in chat_keys:
            sids = [r["id"] for r in db.query("SELECT id FROM sessions WHERE chat_key = ?", (ck,))]
            for sid in sids:
                gone("agent_messages", "DELETE FROM agent_messages WHERE session_id = ?", (sid,))
            gone("sessions", "DELETE FROM sessions WHERE chat_key = ?", (ck,))
            for table in ("turns_original", "staged_edits", "checkpoints"):
                gone(table, f"DELETE FROM {table} WHERE chat_key = ?", (ck,))
        for table in ("memories", "pending_actions", "card_checkpoints"):
            gone(table, f"DELETE FROM {table} WHERE char_key = ?", (char_key,))
        # chats (→ turns), lore, card fields/scripts and asset refs cascade.
        gone("characters", "DELETE FROM characters WHERE char_key = ?", (char_key,))
    if sys_dir is not None and sys_dir.is_dir():
        shutil.rmtree(sys_dir, ignore_errors=True)
    log.info("forgot bot %s (%s, %s): %s", char_key, row["name"], state, removed)
    return {"charKey": char_key, "name": row["name"], "removed": removed,
            "systemDir": str(sys_dir) if sys_dir else "",
            "note": "RisuAI 쪽은 건드리지 않았습니다. projects/ 의 파일은 남아 있습니다. "
                    "이미지 저장소는 '스토어 정리 (GC)'가 7일 뒤 정리합니다."}
