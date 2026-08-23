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

from . import chatfmt, config, db, store
from . import memory as mem

SAFE = re.compile(r"[^A-Za-z0-9_.-]")


class WorkspaceError(ValueError):
    pass


def root(char_key: str) -> Path:
    if not char_key or SAFE.sub("", char_key) != char_key:
        raise WorkspaceError(f"unsafe workspace key: {char_key!r}")
    return config.WORKSPACE_DIR / char_key


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
        out.append({"chat": chat, "chatIndex": (it or {}).get("chatIndex")})
    return out


def materialize(payload: dict, *, force: bool = False) -> dict:
    card = payload.get("card") if isinstance(payload.get("card"), dict) else {}
    cha_id = str(payload.get("charId") or card.get("chaId") or "")
    if not cha_id:
        raise WorkspaceError("charId is required")

    items = _normalise_chats(payload)
    ck = store.upsert_character(
        cha_id, str(card.get("name") or ""), card, payload.get("characterIndex")
    )
    base = root(ck)

    _write(base / "card.md", card_markdown(card))

    ingested = []
    local_lore: dict[str, tuple[list, bool]] = {}
    any_reset = False
    for it in items:
        chat = it["chat"]
        summary = store.ingest_chat(cha_id, chat, it["chatIndex"], force=force)
        tk = summary["chatKey"]

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
        mem.ingest(ck, tk, memory, reset=reset)
        summary["memoryKinds"] = sorted(memory.keys())
        ingested.append(summary)
        # Every chat's own lorebook, under the same reset rule as its turns and
        # memory. The earlier version kept only the first chat that had any.
        local_lore[tk] = (list(chat.get("localLore") or []), reset)
        any_reset = any_reset or reset

    store.ingest_lore(ck, list(card.get("globalLore") or []), local_lore, global_reset=any_reset)
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
