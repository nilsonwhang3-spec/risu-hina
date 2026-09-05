"""SQLite state: sessions, staged edits, checkpoints, cost ledger, jobs.

One connection guarded by one RLock, exactly as active-recall settled on. The
reasoning transfers: FastAPI runs sync handlers in a threadpool, so unlike a
single-threaded Node server nothing prevents interleaving on its own. One lock
removes a whole class of interleaving bugs for a sub-millisecond cost, and this
workload is one user editing one chat - there is no contention to optimise for.

What is NOT here: the transcript, the hypa snapshot, the card, and the working
copy. Those live as files under data/workspace/<chat_key>/ because they are
large, because the agent reads and writes them with ordinary file tools, and
because the user should be able to open them in an editor.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import threading
import time
from typing import Any, Iterable, Iterator

from . import config

SCHEMA_VERSION = 13

LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None


def connect() -> sqlite3.Connection:
    global _conn
    with LOCK:
        if _conn is not None:
            return _conn
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        _adopt_legacy_db()
        _wal_report()
        conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        _conn = conn
        _migrate(conn)
        # Fold the WAL into the main file on every boot. Between runs the
        # database is then one file, so copying data/ to another install moves
        # the data and not a WAL and a wal-index that belong to a process that
        # no longer exists. See `_wal_report` for what a carried-over
        # wal-index did once.
        try:
            conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error as e:
            print(f"[{config.APP_NAME}] wal checkpoint at boot failed: {e}", flush=True)
        return conn


def close() -> None:
    """Checkpoint and close, so a clean stop leaves a single file behind."""
    global _conn
    with LOCK:
        if _conn is None:
            return
        try:
            _conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
        try:
            _conn.close()
        finally:
            _conn = None


def _wal_report() -> None:
    """Say what a leftover WAL holds before SQLite opens it.

    2026-08-23: a data/ folder copied from another install - WAL and wal-index
    included - was opened by a new server. The stale wal-index made it append
    its commits under a salt the WAL header had never seen. Everything it
    wrote was readable through that index and invisible to the next process,
    which rebuilt the index from the file and found only the header's chain:
    two hours of edits gone on restart, with nothing in the log.

    SQLite is right to drop frames it cannot verify. What this adds is the
    sentence that was missing: if the WAL holds committed frames under a salt
    that is neither the header's nor one of the header's predecessors, say so
    loudly and keep a copy of the WAL, so the data is at least recoverable by
    hand instead of silently overwritten by the next checkpoint.
    """
    import shutil
    import struct
    import time

    wal = config.DB_PATH.with_name(config.DB_PATH.name + "-wal")
    try:
        if not wal.exists() or wal.stat().st_size < 32:
            return
        data = wal.read_bytes()
    except OSError:
        return
    try:
        magic, _ver, psz, _ck, s1, s2, _c1, _c2 = struct.unpack(">IIIIIIII", data[:32])
    except struct.error:
        return
    if magic not in (0x377F0682, 0x377F0683) or psz < 512:
        return
    frame = 24 + psz
    groups: dict[tuple[int, int], list[int]] = {}
    off, n = 32, 0
    while off + frame <= len(data):
        pg, commit, fs1, fs2 = struct.unpack(">IIII", data[off:off + 16])
        g = groups.setdefault((fs1, fs2), [0, 0])
        g[0] += 1
        g[1] += 1 if commit else 0
        off += frame
        n += 1
    # A WAL restart bumps salt-1 by one and draws a fresh salt-2, so frames
    # from earlier generations sit just below the header's salt-1. Anything
    # else was written under a header this file no longer has.
    strangers = {k: v for k, v in groups.items()
                 if k != (s1, s2) and not (0 < (s1 - k[0]) & 0xFFFFFFFF <= 64) and v[1] > 0}
    print(f"[{config.APP_NAME}] wal: {len(data)} bytes, {n} frames, "
          f"{groups.get((s1, s2), [0, 0])[0]} under the header salt", flush=True)
    if not strangers:
        return
    keep = config.DATA_DIR / f"orphaned-wal-{time.strftime('%Y%m%d-%H%M%S')}.db-wal"
    try:
        shutil.copy2(wal, keep)
    except OSError as e:
        keep = None  # type: ignore[assignment]
        print(f"[{config.APP_NAME}] could not keep a copy of the WAL: {e}", flush=True)
    for k, v in strangers.items():
        print(f"[{config.APP_NAME}] WARNING: the WAL holds {v[0]} frames / {v[1]} commits under a "
              f"foreign salt ({k[0]:#x},{k[1]:#x}) - written through a stale wal-index, unreachable "
              f"now. Copy kept at {keep}. Usually data/ was copied from another install with its "
              f"-wal/-shm; stop the server before copying.", flush=True)


def _adopt_legacy_db() -> None:
    """Move a pre-rename database to the new name, sidecars included.

    Renaming the project must not orphan someone's chats. This runs before the
    connection is opened, so the WAL and shm files can move with it - renaming
    a database out from under an open connection is how a WAL gets separated
    from the file it belongs to.
    """
    if config.DB_PATH.exists():
        return
    old = next((p for p in getattr(config, "LEGACY_DB_PATHS", ()) if p.exists()), None)
    if old is None:
        return
    for suffix in ("", "-wal", "-shm"):
        src = old.with_name(old.name + suffix)
        if src.exists():
            src.replace(config.DB_PATH.with_name(config.DB_PATH.name + suffix))
    print(f"[{config.APP_NAME}] adopted {old.name} -> {config.DB_PATH.name}", flush=True)


DDL = [
    # --- the transcript itself -------------------------------------------
    #
    # The turns table is the authority for bodies and order; the markdown file
    # is a derived export. That inversion is deliberate. The target jobs are
    # query-shaped ("every turn across these four chats that places Federico in
    # the temple") and structurally destructive ("summarise turns 1..200 into
    # lorebook entries, then delete them"). Both are one statement here and
    # string surgery on a multi-megabyte document otherwise - and that document
    # is one the agent also writes, which is where silent corruption lives.
    #
    # The scope is a character, not a chat, because that is the host's own save
    # unit: RisuAI's autosave effect snapshots the selected character's entire
    # `chats` array and all its other keys (globalApi.svelte.ts:360-366). So
    # cross-chat edits and lorebook writes persist for one character, and
    # nothing persists for any other.
    """
    CREATE TABLE IF NOT EXISTS characters (
        char_key    TEXT PRIMARY KEY,
        cha_id      TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL DEFAULT '',
        char_index  INTEGER,
        card_json   TEXT NOT NULL DEFAULT '{}',
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS chats (
        chat_key    TEXT PRIMARY KEY,
        char_key    TEXT NOT NULL REFERENCES characters(char_key) ON DELETE CASCADE,
        chat_id     TEXT NOT NULL DEFAULT '',
        chat_index  INTEGER,
        name        TEXT NOT NULL DEFAULT '',
        meta_json   TEXT NOT NULL DEFAULT '{}',
        orig_count  INTEGER NOT NULL DEFAULT 0,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS chats_char ON chats(char_key)",

    # `seq` is a dense integer that gets renumbered on insert/delete rather than
    # a fractional index: renumbering a few hundred rows costs nothing and keeps
    # ordering exact, where fractional keys drift after enough splits. Callers
    # address turns by `msg_id` (RisuAI's Message.chatId), which is stable
    # across renumbering and is also what hypa's chatMemos join on.
    """
    CREATE TABLE IF NOT EXISTS turns (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key    TEXT NOT NULL REFERENCES chats(chat_key) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        msg_id      TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'char',
        body        TEXT NOT NULL DEFAULT '',
        time        INTEGER,
        name        TEXT,
        extras_json TEXT,
        origin      TEXT NOT NULL DEFAULT 'original',
        -- Set when this row and RisuAI's copy both moved away from the same
        -- baseline (app/merge.py). NULL is the normal state.
        conflict_json TEXT,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS turns_order ON turns(chat_key, seq)",
    "CREATE INDEX IF NOT EXISTS turns_msg ON turns(chat_key, msg_id)",

    # Frozen at materialise time and never written again. Diffs, quote checking
    # and recovery all compare against this rather than against a file, so a
    # damaged working copy can never make the original unavailable.
    """
    CREATE TABLE IF NOT EXISTS turns_original (
        chat_key    TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        msg_id      TEXT NOT NULL DEFAULT '',
        role        TEXT NOT NULL DEFAULT 'char',
        body        TEXT NOT NULL DEFAULT '',
        time        INTEGER,
        name        TEXT,
        extras_json TEXT,
        PRIMARY KEY (chat_key, seq)
    )
    """,
    "CREATE INDEX IF NOT EXISTS turns_original_msg ON turns_original(chat_key, msg_id)",

    # Lorebook entries, so "summarise the early turns into lore, then cut them"
    # has somewhere to land. scope='global' writes to character.globalLore via
    # setCharacterToIndex; scope='local' writes to chat.localLore via
    # setChatToIndex. Both persist for the selected character.
    """
    CREATE TABLE IF NOT EXISTS lore_entries (
        id          TEXT PRIMARY KEY,
        char_key    TEXT NOT NULL REFERENCES characters(char_key) ON DELETE CASCADE,
        scope       TEXT NOT NULL DEFAULT 'global',
        chat_key    TEXT,
        seq         INTEGER NOT NULL DEFAULT 0,
        -- `seq` is the WORKING order and move_lore renumbers it. `base_seq` is
        -- the position RisuAI last showed this entry in, which is what the
        -- write-back guard's `before` list has to be built from.
        base_seq    INTEGER,
        entry_json  TEXT NOT NULL,
        original_json TEXT,
        origin      TEXT NOT NULL DEFAULT 'original',
        conflict_json TEXT,
        created_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS lore_scope ON lore_entries(char_key, scope, seq)",

    # --- agent-side state -------------------------------------------------
    # A session is one agent conversation scoped to one chat workspace.
    """
    CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT PRIMARY KEY,
        chat_key    TEXT NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS sessions_chat ON sessions(chat_key, updated_at DESC)",

    # The agent transcript. content_json holds the provider-shaped message so a
    # session can be replayed without re-deriving it from rendered text.
    """
    CREATE TABLE IF NOT EXISTS agent_messages (
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        role        TEXT NOT NULL,
        content_json TEXT NOT NULL,
        usage_json  TEXT,
        cost_usd    REAL,
        ts          REAL NOT NULL,
        PRIMARY KEY (session_id, seq)
    )
    """,

    # Approval lives here rather than inside the agent framework (plan 5.2):
    # the approver is a human on the other side of an HTTP boundary, so the
    # state has to survive a backend restart and must not be tied to a library
    # version. `target_chat_id` is Message.chatId - the stable join key.
    """
    CREATE TABLE IF NOT EXISTS staged_edits (
        id          TEXT PRIMARY KEY,
        session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        chat_key    TEXT NOT NULL,
        op          TEXT NOT NULL,
        target_chat_id TEXT,
        turn_index  INTEGER,
        before      TEXT,
        after       TEXT,
        reason      TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        batch_id    TEXT,
        created_at  REAL NOT NULL,
        decided_at  REAL
    )
    """,
    "CREATE INDEX IF NOT EXISTS staged_pending ON staged_edits(chat_key, status, created_at)",
    "CREATE INDEX IF NOT EXISTS staged_batch ON staged_edits(batch_id)",

    # Skills live as folders under data/skills/; only what the folder cannot
    # hold - whether it is on, and its order - is a row.
    """
    CREATE TABLE IF NOT EXISTS skill_state (
        slug        TEXT PRIMARY KEY,
        enabled     INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        updated_at  REAL NOT NULL
    )
    """,

    # A checkpoint is the full working document plus its sidecar, so restoring
    # never depends on replaying edits in order.
    """
    CREATE TABLE IF NOT EXISTS checkpoints (
        id          TEXT PRIMARY KEY,
        chat_key    TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        markdown    TEXT NOT NULL,
        meta_json   TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        created_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS checkpoints_chat ON checkpoints(chat_key, created_at DESC)",

    # Per-call cost. Kept separate from agent_messages so a turn that fans out
    # into several provider calls still totals correctly.
    """
    CREATE TABLE IF NOT EXISTS cost_ledger (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT,
        chat_key    TEXT,
        model       TEXT NOT NULL DEFAULT '',
        in_tokens   INTEGER NOT NULL DEFAULT 0,
        out_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd    REAL,
        priced      INTEGER NOT NULL DEFAULT 0,
        ts          REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS cost_session ON cost_ledger(session_id, ts)",

    """
    CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        kind        TEXT NOT NULL,
        state       TEXT NOT NULL DEFAULT 'pending',
        payload_json TEXT,
        result_json TEXT,
        error       TEXT,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,

    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",

    # --- agent configuration ----------------------------------------------
    #
    # A preset is a saved copy of config.json's agent section, never a second
    # live configuration - see presets.py for why that distinction is load
    # bearing. The API key sits here in the clear because it already sits in
    # config.json in the clear, two files in the same data directory.
    """
    CREATE TABLE IF NOT EXISTS agent_presets (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        base_url    TEXT NOT NULL DEFAULT '',
        api_key     TEXT NOT NULL DEFAULT '',
        model       TEXT NOT NULL DEFAULT '',
        temperature REAL NOT NULL DEFAULT 0.2,
        max_tokens  INTEGER NOT NULL DEFAULT 32000,
        reasoning   TEXT NOT NULL DEFAULT '',
        cache       INTEGER NOT NULL DEFAULT 0,
        flex        INTEGER NOT NULL DEFAULT 0,
        instructions TEXT NOT NULL DEFAULT '',
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS presets_name ON agent_presets(name COLLATE NOCASE)",

    # Written procedures appended to the agent instructions. Disabled rows are
    # kept but not sent, because the cost of a skill is paid on every request.
    """
    CREATE TABLE IF NOT EXISTS skills (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        body        TEXT NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        -- 'md'     the body is instructions, appended to the system prompt.
        -- 'script' the body is Python, written into the workspace for the
        --          agent to run; only a one-line reference goes in the prompt.
        kind        TEXT NOT NULL DEFAULT 'md',
        filename    TEXT NOT NULL DEFAULT '',
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS skills_order ON skills(sort_order)",

    # --- long-term memory --------------------------------------------------
    #
    # The hypa/supa summaries, taken apart into rows for the same reason turns
    # are rows: they are prose a person edits one at a time, and a diff against
    # a frozen original is a string comparison rather than a JSON diff. What is
    # NOT here is the surrounding structure - see memory.py's shell.
    """
    CREATE TABLE IF NOT EXISTS memories (
        id          TEXT PRIMARY KEY,
        chat_key    TEXT NOT NULL,
        char_key    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        title       TEXT NOT NULL DEFAULT '',
        body        TEXT NOT NULL DEFAULT '',
        -- NULL means "added here", which is what distinguishes a new entry
        -- from an edited one when the diff is drawn.
        original    TEXT,
        conflict_json TEXT,
        extra_json  TEXT,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS memories_chat ON memories(chat_key, kind, seq)",

    # --- the approval queue for non-transcript writes -----------------------
    #
    # staged_edits gates the transcript; this gates everything else the agent
    # can change - lorebook, long-term memory, snapshots - plus the two things
    # only the plugin can do (write back to RisuAI, save a copy). See actions.py
    # for why a queue rather than an instruction to ask first.
    """
    CREATE TABLE IF NOT EXISTS pending_actions (
        id          TEXT PRIMARY KEY,
        session_id  TEXT,
        chat_key    TEXT NOT NULL,
        char_key    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        args_json   TEXT,
        summary     TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'pending',
        result      TEXT,
        created_at  REAL NOT NULL,
        decided_at  REAL
    )
    """,
    "CREATE INDEX IF NOT EXISTS actions_chat ON pending_actions(chat_key, status, created_at)",

    # --- provider tool-call signatures (§1-38) ------------------------------
    #
    # Gemini's thought_signature per tool_call_id, replayed on the next
    # request (toolsigs.py). Its own table rather than a column on the stored
    # history: the history is opaque pydantic-ai JSON, and a signature has to
    # survive compaction and re-serialisation of that JSON unchanged.
    """
    CREATE TABLE IF NOT EXISTS tool_sigs (
        tool_call_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at   REAL NOT NULL
    )
    """,

    # --- the card itself (schema 8, bot editing) ----------------------------
    #
    # Card prose fields as rows, for the same reason memories are rows: they
    # are text a person edits one at a time, and the diff against a frozen
    # original is a string comparison. Scalars sit at seq 0 under their field
    # name; alternateGreetings is one row per greeting. `original IS NULL`
    # means "added here"; a deleted greeting is marked in extra_json rather
    # than removed, so the diff can say so.
    #
    # There is deliberately NO card shell: write-back re-reads the live
    # character and overlays only modelled fields, so unmodelled keys
    # (emotionImages, ccAssets, ...) ride along untouched. characters.card_json
    # (overwritten with the full card on every upload) is the frozen reference.
    """
    CREATE TABLE IF NOT EXISTS card_fields (
        id          TEXT PRIMARY KEY,
        char_key    TEXT NOT NULL REFERENCES characters(char_key) ON DELETE CASCADE,
        field       TEXT NOT NULL,
        seq         INTEGER NOT NULL DEFAULT 0,
        base_seq    INTEGER,
        body        TEXT NOT NULL DEFAULT '',
        original    TEXT,
        conflict_json TEXT,
        extra_json  TEXT,
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS card_fields_char ON card_fields(char_key, field, seq)",

    # Regex (customscript) and trigger (triggerscript) items, in lore_entries'
    # grammar: whole-entry JSON with a frozen original_json and an origin
    # lifecycle (original|edited|added|deleted). Item-whole replacement is what
    # preserves fields this schema never modelled.
    """
    CREATE TABLE IF NOT EXISTS card_scripts (
        id          TEXT PRIMARY KEY,
        char_key    TEXT NOT NULL REFERENCES characters(char_key) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        seq         INTEGER NOT NULL DEFAULT 0,
        base_seq    INTEGER,
        entry_json  TEXT NOT NULL,
        original_json TEXT,
        origin      TEXT NOT NULL DEFAULT 'original',
        conflict_json TEXT,
        created_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS card_scripts_char ON card_scripts(char_key, kind, seq)",

    # Bot-level snapshots. A separate table rather than nullable-ing
    # checkpoints' chat_key: that table's consumers all assume a chat, and a
    # bot snapshot has no markdown and no message count. Content is the full
    # row sets (ids included - agent proposals point at ids) so restore is a
    # replace, never a replay.
    """
    CREATE TABLE IF NOT EXISTS card_checkpoints (
        id          TEXT PRIMARY KEY,
        char_key    TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        fields_json TEXT NOT NULL,
        scripts_json TEXT NOT NULL,
        lore_json   TEXT NOT NULL,
        created_at  REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS card_checkpoints_char ON card_checkpoints(char_key, created_at DESC)",

    # --- v9: the asset store (assets.py) ------------------------------------
    # What is on disk: data/assets/<content_hash>.<ext>, one row per file,
    # global across bots - RisuAI keys by content too, so two bots sharing an
    # image share a blob here as well.
    """
    CREATE TABLE IF NOT EXISTS asset_blobs (
        content_hash TEXT PRIMARY KEY,
        ext          TEXT NOT NULL,
        size         INTEGER NOT NULL,
        created_at   REAL NOT NULL
    )
    """,
    # A RisuAI key (`assets/<hash>.<ext>`) and what the store knows about it:
    # present (points at a blob), missing (never fetched), failed (the host
    # could not read it - retried on the next sync, never holds the gate).
    """
    CREATE TABLE IF NOT EXISTS asset_keys (
        risu_key     TEXT PRIMARY KEY,
        content_hash TEXT REFERENCES asset_blobs(content_hash),
        state        TEXT NOT NULL DEFAULT 'missing',
        error        TEXT NOT NULL DEFAULT '',
        updated_at   REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS asset_keys_state ON asset_keys(state)",
    # The manifest: which keys a bot references, in card order, with the
    # field and display name the card gave them. Replaced whole on every
    # /assets/manifest; the assets tab and the charx builder read this rather
    # than re-deriving it from card_json.
    """
    CREATE TABLE IF NOT EXISTS char_assets (
        char_key TEXT NOT NULL REFERENCES characters(char_key) ON DELETE CASCADE,
        seq      INTEGER NOT NULL,
        field    TEXT NOT NULL,
        name     TEXT NOT NULL DEFAULT '',
        ext      TEXT NOT NULL DEFAULT '',
        risu_key TEXT NOT NULL,
        PRIMARY KEY (char_key, seq)
    )
    """,
    "CREATE INDEX IF NOT EXISTS char_assets_key ON char_assets(risu_key)",

    # --- v10: API keys, kept apart from presets -------------------------------
    # One row per credential (a provider's key, a gateway's key). Presets
    # point at a row (key_ref) or carry their own; the settings page shows the
    # key's shape, never the key.
    """
    CREATE TABLE IF NOT EXISTS api_keys (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        provider    TEXT NOT NULL DEFAULT '',
        base_url    TEXT NOT NULL DEFAULT '',
        api_key     TEXT NOT NULL DEFAULT '',
        note        TEXT NOT NULL DEFAULT '',
        created_at  REAL NOT NULL,
        updated_at  REAL NOT NULL
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_name ON api_keys(name COLLATE NOCASE)",

]


# Columns added after a table shipped. `CREATE TABLE IF NOT EXISTS` does not
# alter an existing table, so a deployed database needs these explicitly.
ADD_COLUMNS = [
    ("agent_presets", "instructions", "TEXT NOT NULL DEFAULT ''"),
    # v10: a preset is either the general agent's or the search agent's, and
    # may borrow its credentials from the API key table instead of carrying
    # them (key_ref = api_keys.id, '' = the preset's own base_url/api_key).
    ("agent_presets", "kind", "TEXT NOT NULL DEFAULT 'general'"),
    ("agent_presets", "key_ref", "TEXT NOT NULL DEFAULT ''"),
    # '' = OpenAI-compatible endpoint, 'codex' = OpenAI subscription (codexauth).
    ("agent_presets", "provider", "TEXT NOT NULL DEFAULT ''"),
    # The workspace a copy / new version of a bot shares (workspace.root).
    ("characters", "family_key", "TEXT NOT NULL DEFAULT ''"),
    # What the agent calls itself (presets.agentName).
    ("agent_presets", "agent_name", "TEXT NOT NULL DEFAULT ''"),
    # v11: request-parameter JSON (providers.plan_for). temperature keeps its
    # NOT NULL column; -1 there means "not sent" (presets.TEMP_UNSET).
    ("agent_presets", "params", "TEXT NOT NULL DEFAULT ''"),
    ("skills", "kind", "TEXT NOT NULL DEFAULT 'md'"),
    ("skills", "filename", "TEXT NOT NULL DEFAULT ''"),
    # A checkpoint covers the whole chat - turns, this chat's lorebook entries
    # and its long-term memory - because that is the unit the user restores.
    # Older rows have NULL here and restore turns only.
    ("checkpoints", "lore_json", "TEXT"),
    ("checkpoints", "memory_json", "TEXT"),
    # v13: who took the snapshot. 'user' = the user named and saved it (the
    # version list); 'auto' = the code saved it before doing something
    # destructive (an internal backup, pruned to the newest few). A column
    # rather than a label convention, because the user can rename a label.
    ("checkpoints", "kind", "TEXT NOT NULL DEFAULT 'user'"),
    ("card_checkpoints", "kind", "TEXT NOT NULL DEFAULT 'user'"),
]


# Dropped in schema 7. There used to be an FTS5 index over turn bodies with the
# trigram tokenizer.
#
# It was removed because it was measured and found to buy nothing here. Three
# LIKE queries over 60,000 turns (24 MB) take 2 ms; a real chat is a few hundred
# turns. Against that, the index cost a virtual table, three triggers on every
# turn insert/update/delete, a two-path search that routed short terms
# differently, and - the thing that forced the issue - a hard floor of SQLite
# 3.34, since that is when trigram arrived. Ubuntu 20.04 ships 3.31 and links
# Python against it, so the backend could not start there at all.
#
# The triggers are dropped before the table: they reference it, and a leftover
# trigger on an install that once had the index would fail every write to turns.
DROP_FTS = [
    "DROP TRIGGER IF EXISTS turns_ai",
    "DROP TRIGGER IF EXISTS turns_ad",
    "DROP TRIGGER IF EXISTS turns_au",
    "DROP TABLE IF EXISTS turns_fts",
]


# Tables whose rows are a working copy of something RisuAI owns. Schema 12
# changed how they are merged on re-open (app/merge.py), and rows written by
# the old rule carry no `base_seq` and were addressed by position, which the
# new matcher would read as a wave of conflicts. They are dropped instead:
# every one of them is rebuilt from RisuAI on the first open, and the
# snapshots (checkpoints, card_checkpoints) are deliberately kept.
WORKING_TABLES = ("turns", "turns_original", "lore_entries",
                  "card_fields", "card_scripts", "memories")


def _drop_working_copies(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    try:
        was = int(row["value"]) if row else 0
    except (TypeError, ValueError):
        was = 0
    if not was or was >= 12:
        return
    for table in WORKING_TABLES:
        conn.execute(f"DROP TABLE IF EXISTS {table}")
    print(f"[risu-hina] schema {was} -> {SCHEMA_VERSION}: working copies rebuilt from RisuAI "
          f"on next open (snapshots kept)", flush=True)


# Snapshots the code took before schema 13 gave them a `kind` of their own,
# by the labels their writers used (mirrors snapshots.py and the plugin's
# protective checkpoint calls). Used once, to backfill. A user snapshot that
# was renamed to one of these strings folds into the backups - still visible
# behind the backups toggle and still restorable, so nothing is lost.
SNAPSHOT_AUTO_LABELS = (
    "반영 직전", "reset 직전", "restore 직전", "충돌 해결 직전",
    "에이전트", "에이전트 제안 적용 직전", "찾기·바꾸기 직전",
    "턴 삭제 직전", "복사본 저장 직후",
)


def _backfill_snapshot_kinds(conn: sqlite3.Connection) -> None:
    row = conn.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    try:
        was = int(row["value"]) if row else 0
    except (TypeError, ValueError):
        was = 0
    if not was or was >= 13:
        return
    marks = ",".join("?" * len(SNAPSHOT_AUTO_LABELS))
    n = conn.execute(f"UPDATE checkpoints SET kind = 'auto' WHERE label IN ({marks})",
                     SNAPSHOT_AUTO_LABELS).rowcount or 0
    n += conn.execute(f"UPDATE card_checkpoints SET kind = 'auto' WHERE label IN ({marks})",
                      SNAPSHOT_AUTO_LABELS).rowcount or 0
    if n:
        print(f"[risu-hina] schema {was} -> {SCHEMA_VERSION}: "
              f"{n} automatic snapshot(s) filed as backups", flush=True)


def _migrate(conn: sqlite3.Connection) -> None:
    with LOCK:
        # Before the DDL, so the tables come back with the new columns.
        try:
            _drop_working_copies(conn)
        except sqlite3.Error as e:  # noqa: BLE001 - a fresh DB has no meta table yet
            print(f"[risu-hina] schema check skipped: {e}", flush=True)
        for stmt in DDL:
            conn.execute(stmt)
        for stmt in DROP_FTS:
            conn.execute(stmt)
        for table, column, decl in ADD_COLUMNS:
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        # After ADD_COLUMNS (the column must exist), before the version bump
        # (the old version is what says whether to backfill).
        _backfill_snapshot_kinds(conn)
        conn.execute(
            "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION),),
        )
        conn.commit()


# --- small helpers ----------------------------------------------------------

def now() -> float:
    return time.time()


def query(sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    with LOCK:
        return connect().execute(sql, tuple(params)).fetchall()


def one(sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
    with LOCK:
        return connect().execute(sql, tuple(params)).fetchone()


# How deep we are inside `transaction()`. Every statement below commits on its
# own, which is right for a one-shot mutation and wrong for a merge: that reads
# the old baseline, decides, then overwrites it, so a crash halfway leaves half
# the baselines moved and the previous state gone - the baseline is the only
# record of it. Rather than thread a connection through four ingest modules,
# the helpers simply hold their commit while a transaction is open. Safe
# because LOCK is an RLock and every path here shares one connection.
_tx_depth = 0


@contextlib.contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """Run a block as one unit. Nestable; the outermost one commits."""
    global _tx_depth
    with LOCK:
        conn = connect()
        outer = _tx_depth == 0
        if outer and not conn.in_transaction:
            conn.execute("BEGIN IMMEDIATE")
        _tx_depth += 1
        try:
            yield conn
        except BaseException:
            _tx_depth -= 1
            if _tx_depth == 0:
                conn.rollback()
            raise
        _tx_depth -= 1
        if _tx_depth == 0:
            conn.commit()


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    with LOCK:
        conn = connect()
        cur = conn.execute(sql, tuple(params))
        if _tx_depth == 0:
            conn.commit()
        return cur


def executemany(sql: str, rows: Iterable[Iterable[Any]]) -> None:
    with LOCK:
        conn = connect()
        conn.executemany(sql, [tuple(r) for r in rows])
        if _tx_depth == 0:
            conn.commit()


def js(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def unjs(raw: str | None, default: Any = None) -> Any:
    if not raw:
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


def row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def has_migration(key: str) -> bool:
    row = one("SELECT value FROM meta WHERE key = ?", (f"mig_{key}",))
    return row is not None


def mark_migration(key: str) -> None:
    execute("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)", (f"mig_{key}", "1"))

# NOTE: close() is defined once, near connect(). A second bare definition used
# to sit here and, being later, silently replaced the one that checkpoints the
# WAL - so "clean stop leaves one file" was not actually true. Do not add one.
