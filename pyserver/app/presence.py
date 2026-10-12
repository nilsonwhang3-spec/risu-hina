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

§1-106 widens the same comparison to chats and modules, from the same read:
- a chat of a LIVE bot whose `chat.id` the RisuAI character no longer has is
  `missing` (chats.risu_state). Chats of a trashed / missing bot follow their
  bot and are not listed on their own; a chat Hina has no id for is never
  judged.
- a module working copy (modules.py) whose id is not in RisuAI's `modules`
  is `missing` (its meta row's `risuState`). Opening it marks it live again.
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


def record(characters: list[dict], modules: list | None = None) -> dict:
    """Compare Hina's bots with RisuAI's list as the plugin read it.

    `characters`: [{chaId, name?, trashTime?, chats?}] - every entry of
    RisuAI's `characters` (the trash included); `chats` is the list of that
    character's chat ids, and without it the bot's chats are not judged.
    `modules`: RisuAI's module ids, or None when they were not read.
    An empty character list is refused: a failed read must not turn every
    bot into an orphan."""
    seen: dict[str, int] = {}
    chat_ids: dict[str, set[str]] = {}
    for c in characters or []:
        cid = str((c or {}).get("chaId") or "")
        if not cid or cid in ("§temp", "§playground"):
            continue
        try:
            tt = int(float((c or {}).get("trashTime") or 0))
        except (TypeError, ValueError):
            tt = 0
        seen[cid] = tt
        if isinstance((c or {}).get("chats"), list):
            chat_ids[cid] = {str(x) for x in c["chats"] if x}
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
            _record_chats(b["char_key"], chat_ids.get(cid) if state == "live" else None, now)
        mod_counts = _record_modules(modules, now)
    chat_counts = {"missing": db.one("SELECT COUNT(*) AS n FROM chats WHERE risu_state = 'missing'")["n"]}
    log.info("bot presence: %s, chats %s, modules %s (RisuAI %d)", counts, chat_counts, mod_counts, len(seen))
    return {"counts": counts, "risuCount": len(seen), "bots": listing(),
            "chatCounts": chat_counts, "moduleCounts": mod_counts}


def _record_chats(char_key: str, ids: set[str] | None, now: float) -> None:
    """A live bot's chats against its RisuAI chat ids; anything else is
    reset to '' (a trashed bot's chats go with the bot, and a bot whose
    chats were not sent is not judged)."""
    if ids is None:
        db.execute("UPDATE chats SET risu_state = '', risu_checked_at = 0 WHERE char_key = ?", (char_key,))
        return
    for r in db.query("SELECT chat_key, chat_id FROM chats WHERE char_key = ?", (char_key,)):
        cid = str(r["chat_id"] or "")
        st = "" if not cid else ("live" if cid in ids else "missing")
        db.execute("UPDATE chats SET risu_state = ?, risu_checked_at = ? WHERE chat_key = ?",
                   (st, now if st else 0, r["chat_key"]))


def _record_modules(ids: list | None, now: float) -> dict:
    from . import modules as modmod
    if ids is None:
        return {}
    have = {str(x) for x in ids if x}
    counts = {"live": 0, "missing": 0}
    for ck in modmod.keys():
        meta = modmod.meta(ck)
        st = "live" if str(meta.get("id") or "") in have else "missing"
        counts[st] += 1
        modmod.set_presence(ck, st, now)
    return counts


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
        snaps = db.one("SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ?", (ck,))["n"]
        heir = _snapshot_heir(ck) if snaps and b["risu_state"] in ("missing", "trash") else None
        out.append({
            "charKey": ck, "chaId": b["cha_id"], "name": b["name"] or "",
            "state": b["risu_state"] or "", "trashTime": tt,
            "purgeAt": (tt + TRASH_DAYS * 86400 * 1000) if tt else 0,
            "checkedAt": b["risu_checked_at"] or 0, "updatedAt": b["updated_at"],
            "chats": chats["n"], "turns": chats["t"], "pendingActions": pending,
            "liveNamesake": bool(same),
            # A card uploaded before the full-card format cannot become a .charx.
            "charxReady": cardmod.is_full(ck),
            # Bot snapshots, and the live bot of the same name they go to
            # when this one is forgotten (forget, §1-103).
            "snapshots": snaps, "snapshotHeir": heir["name"] if heir else "",
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
    heir = _snapshot_heir(char_key)
    removed: dict[str, int] = {}
    handed = 0
    with db.transaction():
        if heir:
            # The bot's snapshots are the history of the bot the user still
            # has (§1-103): they move to it, labelled with where they came from.
            handed = db.execute(
                "UPDATE card_checkpoints SET char_key = ?, "
                "source_name = CASE WHEN source_name = '' THEN ? ELSE source_name END WHERE char_key = ?",
                (heir["char_key"], row["name"] or char_key, char_key)).rowcount or 0
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
    log.info("forgot bot %s (%s, %s): %s; snapshots handed to %s: %s", char_key, row["name"], state,
             removed, heir["char_key"] if heir else "-", handed)
    note = "RisuAI 쪽은 건드리지 않았습니다. projects/ 의 파일은 남아 있습니다. "
    if handed:
        note += f"봇 스냅샷 {handed}개는 '{heir['name']}'(으)로 넘겼습니다. "
    note += "이 봇만 쓰던 이미지는 '이미지 저장소 정리'가 정리합니다 (스냅샷이 가진 이미지는 남습니다)."
    return {"charKey": char_key, "name": row["name"], "removed": removed,
            "snapshotsHanded": handed, "heir": heir["name"] if heir else "",
            "systemDir": str(sys_dir) if sys_dir else "", "note": note}


# --- chats and modules (§1-106) -------------------------------------------------

def chat_listing() -> list[dict]:
    """Chats of live bots that RisuAI no longer has, with the work Hina holds."""
    out = []
    for r in db.query("SELECT c.chat_key, c.char_key, c.chat_id, c.name, c.updated_at, c.risu_checked_at, "
                      "ch.name AS bot FROM chats c JOIN characters ch ON ch.char_key = c.char_key "
                      "WHERE c.risu_state = 'missing' AND ch.risu_state = 'live' ORDER BY c.updated_at DESC"):
        tk = r["chat_key"]
        n = lambda sql: db.one(sql, (tk,))["n"]  # noqa: E731
        out.append({
            "chatKey": tk, "charKey": r["char_key"], "chatId": r["chat_id"], "name": r["name"] or "",
            "bot": r["bot"] or "", "updatedAt": r["updated_at"], "checkedAt": r["risu_checked_at"] or 0,
            "turns": n("SELECT COUNT(*) AS n FROM turns WHERE chat_key = ?"),
            "staged": n("SELECT COUNT(*) AS n FROM staged_edits WHERE chat_key = ? AND status = 'pending'"),
            "snapshots": n("SELECT COUNT(*) AS n FROM checkpoints WHERE chat_key = ?"),
            "sessions": n("SELECT COUNT(*) AS n FROM sessions WHERE chat_key = ?"),
        })
    return out


def forget_chat(chat_key: str) -> dict:
    """Remove Hina's copy of a chat RisuAI no longer has: its turns, the AI
    conversations about it, its edits, local lore, memory and snapshots.
    Refused unless the last comparison found it missing."""
    from . import workspace
    row = db.one("SELECT chat_key, char_key, name, risu_state FROM chats WHERE chat_key = ?", (chat_key,))
    if row is None:
        raise PresenceError("없는 챗입니다")
    if (row["risu_state"] or "") != "missing":
        raise PresenceError("RisuAI에 있는 챗(또는 아직 대조하지 않은 챗)은 지울 수 없습니다 - 먼저 'RisuAI와 대조'를 눌러 주세요")
    removed: dict[str, int] = {}

    def gone(table: str, sql: str, params) -> None:
        n = getattr(db.execute(sql, params), "rowcount", 0) or 0
        if n:
            removed[table] = removed.get(table, 0) + n
    with db.transaction():
        for sid in [r["id"] for r in db.query("SELECT id FROM sessions WHERE chat_key = ?", (chat_key,))]:
            gone("agent_messages", "DELETE FROM agent_messages WHERE session_id = ?", (sid,))
        for table in ("sessions", "turns_original", "staged_edits", "checkpoints", "memories",
                      "lore_entries", "pending_actions"):
            gone(table, f"DELETE FROM {table} WHERE chat_key = ?", (chat_key,))
        gone("chats", "DELETE FROM chats WHERE chat_key = ?", (chat_key,))  # turns cascade
    try:
        orig = workspace.root(row["char_key"]) / "original"
        for f in (orig / f"{chat_key}.md", orig / f"{chat_key}.hypa.json"):
            f.unlink(missing_ok=True)
    except (OSError, Exception):  # noqa: BLE001 - the rows are what matters
        pass
    log.info("forgot chat %s (%s of %s): %s", chat_key, row["name"], row["char_key"], removed)
    return {"chatKey": chat_key, "name": row["name"] or "", "removed": removed}


def module_listing() -> list[dict]:
    """Module working copies RisuAI no longer has."""
    from . import modules as modmod
    out = []
    for ck in modmod.keys():
        m = modmod.meta(ck)
        if m.get("risuState") != "missing":
            continue
        r = modmod.row(ck)
        out.append({**r, "checkedAt": m.get("checkedAt") or 0,
                    "snapshots": db.one("SELECT COUNT(*) AS n FROM card_checkpoints WHERE char_key = ?", (ck,))["n"]})
    out.sort(key=lambda r: r["name"].casefold())
    return out


def forget_module(ck: str) -> dict:
    """Remove Hina's copy of a module RisuAI no longer has (refused unless
    the last comparison found it missing): working copy, snapshots,
    proposals and its system folder. RisuAI is not touched."""
    from . import workspace
    from . import modules as modmod
    if not modmod.is_module_key(ck) or not modmod.meta(ck):
        raise PresenceError("없는 모듈입니다")
    m = modmod.meta(ck)
    if m.get("risuState") != "missing":
        raise PresenceError("RisuAI에 있는 모듈(또는 아직 대조하지 않은 모듈)은 지울 수 없습니다 - 먼저 'RisuAI와 대조'를 눌러 주세요")
    sys_dir = None
    try:
        sys_dir = workspace.root(ck)
    except Exception:  # noqa: BLE001
        sys_dir = None
    with db.transaction():
        snaps = db.execute("DELETE FROM card_checkpoints WHERE char_key = ?", (ck,)).rowcount or 0
        db.execute("DELETE FROM pending_actions WHERE char_key = ?", (ck,))
        db.execute("DELETE FROM lore_entries WHERE char_key = ?", (ck,))
        modmod.forget(ck)
    if sys_dir is not None and sys_dir.is_dir():
        shutil.rmtree(sys_dir, ignore_errors=True)
    log.info("forgot module %s (%s), snapshots %s", ck, m.get("name"), snaps)
    return {"key": ck, "name": m.get("name") or "", "snapshots": snaps}


def _snapshot_heir(char_key: str) -> dict | None:
    """The bot that inherits a forgotten bot's snapshots: a folder mate
    (same family or (almost) the same name) that RisuAI has live, the most
    recently used first. None = the snapshots go with the bot."""
    from . import snapshots
    for ck in snapshots.mates(char_key):
        if ck == char_key:
            continue
        r = db.one("SELECT char_key, name, risu_state FROM characters WHERE char_key = ?", (ck,))
        if r is not None and (r["risu_state"] or "") == "live":
            return {"char_key": r["char_key"], "name": r["name"] or r["char_key"]}
    return None
