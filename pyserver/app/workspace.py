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
import time
from pathlib import Path
from typing import Any

from . import card as cardmod
from . import chatfmt, config, db, log, store
from . import memory as mem

SAFE = re.compile(r"[^A-Za-z0-9_.-]")


class WorkspaceError(ValueError):
    pass


# Windows-forbidden filename characters plus control bytes. Korean stays: the
# bot's own name is the folder name, that is the point of the hina/ area.
_FOLDER_BAD = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def space_root() -> Path:
    """The ONE global file space (`workspace.globalPath`, or `<data>/space`).

    Every bot's agent sees the same root: projects/ the user manages, studio/
    the image library, hina/<봇이름>/ the agent's own work area. Configurable
    for the same drive reason as the studio library; `files._resolve` compares
    resolved paths against whatever this returns, so containment holds
    wherever it points.
    """
    raw = str((config.section("workspace") or {}).get("globalPath") or "").strip()
    return (Path(raw).expanduser() if raw else config.DATA_DIR / "space")


def ensure_space() -> Path:
    """Create the space's top-level areas, on the first request that needs it."""
    from . import files
    base = space_root()
    for area in files.SPACE_AREAS:
        (base / area).mkdir(parents=True, exist_ok=True)
    return base


def _bots_map_path() -> Path:
    return space_root() / ".hina" / "bots.json"


def _bots_map() -> dict:
    try:
        return json.loads(_bots_map_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_bots_map(mapping: dict) -> None:
    p = _bots_map_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(mapping, ensure_ascii=False, indent=1), encoding="utf-8")


def bot_folder(char_key: str) -> str:
    """The bot-named folder under projects/ and hina/, pinned in bots.json.

    Pinned so a rename does not orphan the folder; family bots share one
    folder by the family key, the same sharing rule root() applies. A name
    collision takes `이름~2` rather than merging two bots' work.
    """
    key = family_of(char_key) or char_key
    if not key or SAFE.sub("", key) != key:
        raise WorkspaceError(f"unsafe workspace key: {char_key!r}")
    mapping = _bots_map()
    hit = mapping.get(key)
    if isinstance(hit, dict) and str(hit.get("folder") or ""):
        return str(hit["folder"])
    name = ""
    try:
        row = db.one("SELECT name FROM characters WHERE char_key = ?", (key,))
        name = str(row["name"] if row else "") or ""
    except Exception:  # noqa: BLE001 - before the table exists (first boot)
        name = ""
    folder = _FOLDER_BAD.sub("", name).strip().strip(".") or key
    taken = {str(v.get("folder") or "") for v in mapping.values() if isinstance(v, dict)}
    base, n = folder, 2
    while folder in taken:
        folder = f"{base}~{n}"
        n += 1
    mapping[key] = {"folder": folder, "createdAt": time.time()}
    _save_bots_map(mapping)
    return folder


def hina_dir(char_key: str) -> Path:
    """The agent's own work area for one bot: hina/<봇폴더>/{scripts,scratch}.

    Internal by design (§1-33): the panel hides hina/ behind the 숨김 toggle,
    so nothing the user is meant to pick up lives here any more - the
    deliverables moved to `out_dir` (projects/<봇>/out/).
    """
    base = space_root() / "hina" / bot_folder(char_key)
    for sub in ("scripts", "scratch"):
        (base / sub).mkdir(parents=True, exist_ok=True)
    return base


def out_dir(char_key: str) -> Path:
    """Where this bot's deliverables land: projects/<봇폴더>/out/.

    The user's ask (§1-33): the agent's scratch and scripts stay out of sight,
    and what it produces for the user sits inside the bot's own project
    folder, beside the material the user manages. The only place under
    projects/ the agent may write.
    """
    base = space_root() / "projects" / bot_folder(char_key) / "out"
    base.mkdir(parents=True, exist_ok=True)
    return base


def out_rel(char_key: str) -> str:
    """`out_dir` as a space-relative path (what the tools say out loud)."""
    return f"projects/{bot_folder(char_key)}/out"


# The studio's own areas. Owned here rather than in files.py because they are
# subfolders of one SPACE area now, not a scope of their own.
#
# Two tiers since studio_v2 (the user's ask): `config/` holds the material
# (prompt cards, presets, our .studio machinery) and `output/` the results.
# The old flat layout put images/ beside styles/ as if a generated batch were
# one more kind of card.
STUDIO_SUBDIRS = ("config/styles", "config/characters", "config/fragments",
                  "config/scenes", "config/.studio", "output")

# The flat-era area names, still arriving from old sidecars, agent habits and
# saved specs. `studio_canon` folds them into the two-tier layout.
_STUDIO_LEGACY_AREAS = {"styles", "characters", "fragments", "scenes"}


def studio_canon(rel: str) -> str:
    """A studio path in its two-tier form; anything else passes untouched.

    "studio/styles/x.md" → "studio/config/styles/x.md", "studio/images/고르기"
    → "studio/output/고르기", "studio/.studio/…" → "studio/config/.studio/…".
    Applied at `files._resolve` for the whole space, so every old reference -
    a sidecar, a saved spec, a script the agent wrote last week - keeps
    landing on the file that actually moved.
    """
    r = (rel or "").replace("\\", "/").lstrip("/")
    if r != "studio" and not r.startswith("studio/"):
        return rel
    rest = r[len("studio/"):]
    head, sep, tail = rest.partition("/")
    if head in _STUDIO_LEGACY_AREAS or head == ".studio":
        return "studio/config/" + rest
    if head == "images":
        return "studio/output" + (("/" + tail) if sep else "")
    return r


def studio_root() -> Path:
    """The asset studio library: the `studio/` folder of the global space.

    It used to be its own root (`studio.libraryPath`); that setting now only
    feeds the migration warning. A separate drive is chosen for the whole
    space (`workspace.globalPath`), not for the studio alone.
    """
    return space_root() / "studio"


def ensure_studio() -> Path:
    """Create the library's areas. Called on the first studio request rather
    than at boot: an install that never opens the studio grows no folders."""
    ensure_space()
    base = studio_root()
    for area in STUDIO_SUBDIRS:
        (base / area).mkdir(parents=True, exist_ok=True)
    return base


def root(char_key: str) -> Path:
    """The SYSTEM directory of one bot - the machinery, not the user's files.

    card.md, lore.json, the frozen original/ transcripts and .scratch/ (the
    scoped DB snapshot and the proposal spool) live here, OUTSIDE the global
    space on purpose: everything inside the space is readable by every bot's
    sandbox, and another bot's scope.db must not be.

    Copies and new versions of one bot (a clone made here, a charx exported
    here and imported again) carry the original's key in
    `extentions.risu_hina.family`, and every one of them lands in that
    directory. Rows (turns, card, lore) stay per bot - they are keyed in the
    database, not by directory.
    """
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
    # Korean names survive (the old ASCII-only SAFE turned 보고서.md into
    # ___.md); only what a filesystem refuses is dropped.
    safe = _FOLDER_BAD.sub("", name.split("/")[-1]).strip().strip(".") or "export"
    # Deliverables live in the bot's project folder (projects/<봇>/out/).
    path = out_dir(char_key) / safe
    _write(path, text)
    return path.relative_to(space_root()).as_posix()


def write_artifact(char_key: str, title: str, text: str) -> str:
    """An artifact the agent wants shown: a file first, an event second.

    It lands under the bot's own deliverables (projects/<봇>/out/artifacts/) so
    it survives the session, shows in the files tab, and is the user's to
    manage. The slug is the title; a taken name counts up rather than
    overwriting - two artifacts titled 비교 보고서 are two files. Returns the
    space-relative path the stream event (and the viewer) uses.
    """
    slug = _FOLDER_BAD.sub("", title).strip().strip(".").replace(" ", "-")[:60] or "artifact"
    base = out_dir(char_key) / "artifacts"
    base.mkdir(parents=True, exist_ok=True)
    path = base / f"{slug}.md"
    n = 2
    while path.exists():
        path = base / f"{slug}-{n}.md"
        n += 1
    _write(path, text)
    return path.relative_to(space_root()).as_posix()


def destroy(char_key: str) -> None:
    shutil.rmtree(root(char_key), ignore_errors=True)
    db.execute("DELETE FROM characters WHERE char_key = ?", (char_key,))


# --- the space_v1 migration ---------------------------------------------------

def _move_tree(src: Path, dst: Path, moves: list[dict]) -> None:
    """Move every file under src into dst, never overwriting: an occupied
    target shifts the incomer to `이름~1`. Emptied directories are swept."""
    if not src.is_dir():
        return
    for f in sorted(src.rglob("*")):
        if not f.is_file():
            continue
        target = dst / f.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        stem, suf, n = target.stem, target.suffix, 1
        while target.exists():
            target = target.with_name(f"{stem}~{n}{suf}")
            n += 1
        shutil.move(str(f), str(target))
        moves.append({"from": str(f), "to": str(target)})
    for d in sorted((p for p in src.rglob("*") if p.is_dir()), reverse=True):
        try:
            d.rmdir()
        except OSError:
            pass
    try:
        src.rmdir()
    except OSError:
        pass


def migrate_to_space() -> dict | None:
    """One-time move of the per-bot user files and the old studio library
    into the global space.

    Move + manifest only, never a delete, never an overwrite. The manifest
    (`space/.hina/migration-space_v1.json`) is what `tools/rollback_space.py`
    replays in reverse, which is why every single file move is recorded.

    What moves: each bot's uploads/ into projects/<봇폴더>/uploads/, its
    out/, scratch/ and scripts/ into hina/<봇폴더>/, and `data/studio/` into
    the space's studio/. What stays: card.md, lore.json, original/, .scratch/
    (SYSTEM machinery, deliberately outside the space) and skills/ (rebuilt
    per run). A studio on a configured `studio.libraryPath` is NOT moved -
    gigabytes across drives is the user's call, and the boot log says so.
    """
    if db.has_migration("space_v1"):
        return None
    space = ensure_space()
    moves: list[dict] = []

    studio_note = ""
    legacy = str((config.section("studio") or {}).get("libraryPath") or "").strip()
    old_studio = Path(legacy).expanduser() if legacy else config.DATA_DIR / "studio"
    if legacy:
        if old_studio.is_dir():
            studio_note = (f"스튜디오 라이브러리가 {old_studio} 에 그대로 있습니다. 직접 "
                           f"{studio_root()} 로 옮기거나, 그 드라이브를 쓰려면 workspace.globalPath 를 지정하세요.")
            log.warn("space_v1: studio.libraryPath is set (%s) - not moved", old_studio)
    elif old_studio.is_dir():
        _move_tree(old_studio, studio_root(), moves)

    keys: set[str] = set()
    try:
        for r in db.query("SELECT char_key FROM characters"):
            k = str(r["char_key"])
            keys.add(family_of(k) or k)
    except Exception:  # noqa: BLE001 - before the table exists
        pass
    if config.WORKSPACE_DIR.is_dir():
        for d in config.WORKSPACE_DIR.iterdir():
            if d.is_dir() and SAFE.sub("", d.name) == d.name:
                keys.add(d.name)

    bots: dict[str, str] = {}
    for key in sorted(keys):
        wdir = config.WORKSPACE_DIR / key
        if not wdir.is_dir():
            continue
        folder = bot_folder(key)
        bots[key] = folder
        _move_tree(wdir / "uploads", space / "projects" / folder / "uploads", moves)
        for area in ("out", "scratch", "scripts"):
            _move_tree(wdir / area, space / "hina" / folder / area, moves)

    manifest = {"version": 1, "movedAt": time.time(), "moves": moves,
                "bots": bots, "studio": {"legacyPath": legacy, "note": studio_note}}
    mpath = space / ".hina" / "migration-space_v1.json"
    mpath.parent.mkdir(parents=True, exist_ok=True)
    mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    db.mark_migration("space_v1")
    log.info("space_v1: moved %d files across %d bots%s", len(moves), len(bots),
             "; studio left in place (libraryPath)" if studio_note else "")
    return manifest


def migrate_studio_v2() -> dict | None:
    """One-time fold of the flat studio layout into config/ + output/.

    Move + manifest, never a delete or an overwrite (`_move_tree` shifts a
    taken name to `이름~1`). Runs after `migrate_to_space`, so a legacy
    `data/studio` has already arrived at `space/studio` in the flat shape.
    """
    if db.has_migration("studio_v2"):
        return None
    base = studio_root()
    moves: list[dict] = []
    if base.is_dir():
        for area in sorted(_STUDIO_LEGACY_AREAS | {".studio"}):
            _move_tree(base / area, base / "config" / area, moves)
        _move_tree(base / "images", base / "output", moves)
    if moves:
        manifest = {"version": 1, "movedAt": time.time(), "moves": moves}
        mpath = space_root() / ".hina" / "migration-studio_v2.json"
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    db.mark_migration("studio_v2")
    log.info("studio_v2: %d files moved into config/ + output/", len(moves))
    return {"moves": len(moves)}


def migrate_out_v3() -> dict | None:
    """One-time move of every bot's deliverables out of hina/ (§1-33).

    hina/<봇>/out/ → projects/<봇>/out/, move + manifest, never an overwrite
    (`_move_tree`). hina/ is hidden from the panel from now on, so a file
    left there would be a file the user could no longer find.
    """
    if db.has_migration("out_v3"):
        return None
    base = space_root() / "hina"
    moves: list[dict] = []
    if base.is_dir():
        for bot in sorted(p for p in base.iterdir() if p.is_dir()):
            _move_tree(bot / "out", space_root() / "projects" / bot.name / "out", moves)
    if moves:
        manifest = {"version": 1, "movedAt": time.time(), "moves": moves}
        mpath = space_root() / ".hina" / "migration-out_v3.json"
        mpath.parent.mkdir(parents=True, exist_ok=True)
        mpath.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    db.mark_migration("out_v3")
    log.info("out_v3: %d deliverables moved into projects/<봇>/out", len(moves))
    return {"moves": len(moves)}


def space_note() -> str:
    """The migration warning the studio status line carries, if any."""
    try:
        m = json.loads((space_root() / ".hina" / "migration-space_v1.json").read_text(encoding="utf-8"))
        return str((m.get("studio") or {}).get("note") or "")
    except (OSError, ValueError):
        return ""
