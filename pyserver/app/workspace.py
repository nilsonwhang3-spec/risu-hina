"""The filesystem side of a workspace, scoped to a character.

    workspace/<char_key>/
        card.md            bot card as prose, reference only
        lore.json          globalLore + localLore as uploaded
        original/<chat_key>.md     frozen transcript, never regenerated
        original/<chat_key>.hypa.json
        scripts/           whatever the agent writes
        out/               exports the user asked for

The DB owns turns; these files are the *frozen* originals plus a scratch area.
There is deliberately no `working/messages.md`: having both a file and a table
claim to be the current transcript would make "which one is right" a question
someone has to answer on every read, and that is where silent corruption lives.
Anything the agent wants as a file it generates into out/ or scripts/.

Scope is the character rather than the chat because that is the host's save
unit (globalApi.svelte.ts:360-366) and because the jobs are cross-chat:
checking continuity across several playthroughs, or summarising one chat's
early turns into lore the whole character shares.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any

from . import card as cardmod
from . import chatfmt, config, db, store
from . import memory as mem

SAFE = re.compile(r"[^A-Za-z0-9_.-]")


class WorkspaceError(ValueError):
    pass


STUDIO = "studio"


def studio_root() -> Path:
    """The asset studio library: `studio.libraryPath`, or `<data>/studio`.

    Configurable and therefore allowed to sit outside the data directory - a
    few thousand generated images is a drive decision. `files._resolve`
    compares *resolved* paths against whatever this returns, so containment
    holds wherever it points.
    """
    raw = str((config.section("studio") or {}).get("libraryPath") or "").strip()
    return (Path(raw).expanduser() if raw else config.DATA_DIR / "studio")


def ensure_studio() -> Path:
    """Create the library's areas. Called on the first studio request rather
    than at boot: an install that never opens the studio grows no folders."""
    from . import files
    base = studio_root()
    for area in files.STUDIO_AREAS:
        (base / area).mkdir(parents=True, exist_ok=True)
    return base


def root(char_key: str) -> Path:
    """The workspace directory - the bot's own, or its family's.

    `STUDIO` is the one key that is not a bot: it answers with the studio
    library instead. It cannot collide with a real key, because `store.char_key`
    always produces "c<hash>".

    Copies and new versions of one bot (a clone made here, a charx exported
    here and imported again) carry the original's key in
    `extentions.risu_hina.family`, and every one of them lands in that
    directory: uploads, outputs, scratch and skills are shared across the
    versions automatically. Rows (turns, card, lore) stay per bot - they are
    keyed in the database, not by directory.
    """
    if char_key == STUDIO:
        return studio_root()
    if not char_key or SAFE.sub("", char_key) != char_key:
        raise WorkspaceError(f"unsafe workspace key: {char_key!r}")
    fam = family_of(char_key)
    return config.WORKSPACE_DIR / (fam or char_key)


def family_of(char_key: str) -> str:
    """The family key a bot belongs to ('' when it is its own)."""
    try:
        row = db.one("SELECT family_key FROM characters WHERE char_key = ?", (char_key,))
    except Exception:  # noqa: BLE001 - before the table exists (first boot)
        return ""
    fam = (row["family_key"] if row else "") or ""
    if not fam or fam == char_key or SAFE.sub("", fam) != fam:
        return ""
    return fam


def family_from_card(card: dict) -> str:
    """The family stamp a card carries, if any (see root)."""
    ext = card.get("extentions")
    if not isinstance(ext, dict):
        return ""
    ours = ext.get("risu_hina")
    fam = ours.get("family") if isinstance(ours, dict) else ""
    fam = str(fam or "")
    return fam if fam and SAFE.sub("", fam) == fam else ""


def _tally(into: dict[str, int], counts: dict | None) -> None:
    for k, v in (counts or {}).items():
        if v:
            into[k] = into.get(k, 0) + int(v)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline='' keeps exactly the bytes we composed. Letting Python translate
    # to CRLF on Windows would rewrite every message body's line endings and
    # show up as a diff on every single turn.
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def card_markdown(card: dict) -> str:
    def block(title: str, body: Any) -> str:
        if body in (None, "", [], {}):
            return ""
        if isinstance(body, (list, dict)):
            body = json.dumps(body, ensure_ascii=False, indent=2)
        return f"## {title}\n\n{body}\n\n"

    parts = [f"# {card.get('name') or 'character'}\n\n"]
    for field in ("desc", "personality", "scenario", "firstMessage",
                  "exampleMessage", "systemPrompt", "postHistoryInstructions",
                  "creatorNotes"):
        parts.append(block(field, card.get(field)))
    for i, g in enumerate(card.get("alternateGreetings") or []):
        parts.append(block(f"alternateGreeting[{i}]", g))
    return "".join(p for p in parts if p)


def _normalise_chats(payload: dict) -> list[dict]:
    """Accept one chat or many; the multi-chat form is the general case."""
    if isinstance(payload.get("chats"), list):
        items = payload["chats"]
    elif isinstance(payload.get("chat"), dict):
        items = [{"chat": payload["chat"], "chatIndex": payload.get("chatIndex")}]
    else:
        raise WorkspaceError("payload needs chat or chats[]")

    out = []
    for it in items:
        chat = it.get("chat") if isinstance(it, dict) else None
        if not isinstance(chat, dict) or not isinstance(chat.get("message"), list):
            raise WorkspaceError("each entry needs chat.message[]")
        # `live` = the chat RisuAI has open right now, the plugin's word. A
        # lazy host never stubs that one, so an empty live chat is real.
        out.append({"chat": chat, "chatIndex": (it or {}).get("chatIndex"),
                    "live": bool((it or {}).get("live"))})
    return out


def materialize(payload: dict, *, force: bool = False) -> dict:
    card = payload.get("card") if isinstance(payload.get("card"), dict) else {}
    cha_id = str(payload.get("charId") or card.get("chaId") or "")
    if not cha_id:
        raise WorkspaceError("charId is required")

    items = _normalise_chats(payload)
    # A copy or new version of a bot made here carries the original's key
    # (host.cloneBot / charx round-trip stamp it); it shares that workspace.
    family = family_from_card(card)
    ck = store.upsert_character(
        cha_id, str(card.get("name") or ""), card, payload.get("characterIndex"),
        family_key=family if family != store.char_key(cha_id) else "",
    )
    base = root(ck)

    _write(base / "card.md", card_markdown(card))

    ingested = []
    local_lore: dict[str, tuple[list, bool]] = {}
    any_reset = False
    # What the merge did across every material, for the panel's one-line
    # notice. Empty on a first load and on a repeat open where nothing moved.
    merged: dict[str, int] = {}
    # A write-back re-reads only what it wrote: `chatReset` after a chat was
    # written, `cardReset` after the card. `force` (the 🔄 button) is both.
    chat_reset = force or bool(payload.get("chatReset"))
    for it in items:
        chat = it["chat"]
        summary = store.ingest_chat(cha_id, chat, it["chatIndex"],
                                    force=chat_reset, live=it["live"])
        tk = summary["chatKey"]
        _tally(merged, summary.get("merge"))
        if summary.get("skipped"):
            # A refused stub: nothing about this chat may move - not the
            # frozen original (an empty transcript over the real one), not
            # the memory rows, not its local lorebook. The summary still
            # rides along so the panel can show the refusal.
            ingested.append(summary)
            continue

        # Frozen original: written every time, because the user may have edited
        # in RisuAI since, and a stale original makes every diff wrong.
        _write(base / "original" / f"{tk}.md", chatfmt.decode(chat)["markdown"])

        # Chat variables (`scriptstate`) travel with the memory: same chat
        # object, same per-entry rows, same write-back.
        memory = {
            k: chat.get(k) for k in
            ("hypaV3Data", "hypaV2Data", "supaMemory", "supaMemoryData", "lastMemory", "scriptstate")
            if chat.get(k) not in (None, "", [], {})
        }
        _write(base / "original" / f"{tk}.hypa.json",
               json.dumps(memory, ensure_ascii=False, indent=2))
        # Also as rows, so the summaries can be read and edited one at a time.
        # The file stays as the frozen reference; the rows are the working copy.
        # Same reset rule as the turns, decided by the same call - otherwise
        # re-opening the panel would discard memory edits while keeping turn
        # edits, which is the kind of inconsistency nobody would guess at.
        reset = bool(summary.get("workingReset"))
        _tally(merged, (mem.ingest(ck, tk, memory, reset=reset) or {}).get("merge"))
        summary["memoryKinds"] = sorted(memory.keys())
        ingested.append(summary)
        # Every chat's own lorebook, under the same reset rule as its turns and
        # memory. The earlier version kept only the first chat that had any.
        local_lore[tk] = (list(chat.get("localLore") or []), reset)
        any_reset = any_reset or reset

    # The card (and with it the global lorebook) resets on its own rule, not on
    # the chats' OR. `any_reset` used to govern global lore too, which meant
    # opening a brand-new chat of an existing bot (first-seen -> reset) threw
    # away global-lore edits in progress. A card that has never been ingested
    # loads regardless of the flag, same as a first-seen chat.
    card_reset = force or bool(payload.get("cardReset")) or not cardmod.exists(ck)
    card_summary = cardmod.ingest(ck, card, reset=card_reset)
    _tally(merged, card_summary.get("merge"))
    cardmod.set_full(ck, bool(payload.get("cardFull")))

    _tally(merged, store.ingest_lore(ck, list(card.get("globalLore") or []), local_lore,
                                     global_reset=card_reset))
    _write(base / "lore.json", json.dumps(
        {"globalLore": card.get("globalLore") or [],
         "localLore": {tk: entries for tk, (entries, _) in local_lore.items()}},
        ensure_ascii=False, indent=2))

    (base / "scripts").mkdir(parents=True, exist_ok=True)
    (base / "out").mkdir(parents=True, exist_ok=True)

    info = {
        "charKey": ck,
        "charId": cha_id,
        "characterName": card.get("name") or "",
        "characterIndex": payload.get("characterIndex"),
        "chats": ingested,
        "totalTurns": sum(c["turns"] for c in ingested),
        "cardReset": card_reset,
        "cardFull": bool(payload.get("cardFull")),
        # The workspace this bot shares with its other versions ('' = its own).
        "familyKey": family_of(ck),
        "cardCounts": card_summary.get("counts"),
        # adopt / conflict / insert / delete, summed over every material.
        "merge": merged,
        "loreCounts": {
            "global": len(card.get("globalLore") or []),
            "local": len(local_lore),
        },
        "paths": {
            "root": str(base),
            "scripts": str(base / "scripts"),
            "out": str(base / "out"),
            "original": str(base / "original"),
        },
    }
    _write(base / "workspace.json", json.dumps(info, ensure_ascii=False, indent=2))
    return info


def dirty_summary(char_key: str) -> dict:
    """What is pending where, for the whole bot - the leave guard's one call.

    The active scope's counts the plugin already tracks (`/changes` and
    `/card/changes` follow every edit); what it cannot know is a chat left
    dirty by an earlier session. One shape for both: the card and every
    loaded chat, each with its pending total and conflict count.
    """
    from . import conflicts
    card_pending = cardmod.changes(char_key)
    card_conf = conflicts.count_for_card(char_key)
    card = {"dirty": bool(card_pending.get("total")) or card_conf > 0,
            "total": card_pending.get("total") or 0, "conflicts": card_conf}
    chats = []
    for row in store.chats_of(char_key):
        tk = str(row.get("chat_key") or "")
        p = store.patch(tk)
        t_total = (len(p["edits"]) + len(p["added"]) + len(p["removed"])
                   + (1 if p["reordered"] else 0))
        total = t_total + store.lore_changes(char_key, tk)["total"] + mem.changes(tk)["total"]
        conf = conflicts.count_for_chat(tk)
        chats.append({
            "chatKey": tk, "chatId": row.get("chat_id"), "name": row.get("name") or "",
            "dirty": bool(total or conf), "total": total, "conflicts": conf,
        })
    return {"charKey": char_key, "card": card, "chats": chats}


def cross_scope_blocker(char_key: str, scope: str, chat_key: str = "") -> str:
    """The one-dirty-thing-at-a-time rule, as a refusal message ('' = go).

    `scope` is what the caller is about to write. Writing the chat is refused
    while the card holds unapplied edits (and the other way round), and while
    any *other* chat does - the write would open a second dirty front behind
    the user's back, which is exactly what the leave guard exists to prevent.
    Write-backs and resets are never passed through here: they resolve
    pending state rather than create it.
    """
    summary = dirty_summary(char_key)
    if scope == "chat" and summary["card"]["dirty"]:
        return "봇 카드에 미반영 변경이 있습니다. 먼저 반영하거나 취소해 주세요."
    # Only a chat write is at home in its own chat; a card write is blocked
    # by *every* dirty chat, the acting one included - that pairing is the
    # reported bug ("saving the bot quietly re-saved the chat").
    exempt = chat_key if scope == "chat" else ""
    others = [c for c in summary["chats"] if c["dirty"] and c["chatKey"] != exempt]
    if others:
        name = others[0]["name"] or "다른 챗"
        return f"'{name}' 챗에 미반영 변경이 있습니다. 먼저 반영하거나 취소해 주세요."
    return ""


def info(char_key: str) -> dict | None:
    row = store.character_row(char_key)
    if row is None:
        return None
    return {
        "charKey": char_key,
        "charId": row["cha_id"],
        "characterName": row["name"],
        "characterIndex": row["char_index"],
        "chats": [
            {"chatKey": c["chat_key"], "chatId": c["chat_id"], "chatIndex": c["chat_index"],
             "name": c["name"], "turns": c["turns"], "originalTurns": c["orig_count"]}
            for c in store.chats_of(char_key)
        ],
        "paths": {
            "root": str(root(char_key)),
            "scripts": str(root(char_key) / "scripts"),
            "out": str(root(char_key) / "out"),
            "original": str(root(char_key) / "original"),
        },
    }


def list_all() -> list[dict]:
    rows = db.query("SELECT char_key FROM characters ORDER BY updated_at DESC")
    return [i for i in (info(r["char_key"]) for r in rows) if i]


def chat_owner(chat_key: str) -> str | None:
    row = store.chat_row(chat_key)
    return row["char_key"] if row else None


def write_out(char_key: str, filename: str, text: str) -> str:
    # The agent is told "save it in out/" and often says so in the name; that
    # prefix is the folder, not part of the file name.
    name = filename.strip().replace("\\", "/")
    while name.startswith("out/"):
        name = name[4:]
    safe = SAFE.sub("_", name) or "export"
    path = root(char_key) / "out" / safe
    _write(path, text)
    return str(path)


def destroy(char_key: str) -> None:
    shutil.rmtree(root(char_key), ignore_errors=True)
    db.execute("DELETE FROM characters WHERE char_key = ?", (char_key,))
