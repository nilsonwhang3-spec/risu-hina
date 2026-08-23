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

import json
import sqlite3
import threading
import time
from typing import Any, Iterable

from . import config

SCHEMA_VERSION = 7

LOCK = threading.RLock()
_conn: sqlite3.Connection | None = None


def connect() -> sqlite3.Connection:
    global _conn
    with LOCK:
        if _conn is not None:
            return _conn
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        _adopt_legacy_db()
        conn = sqlite3.connect(str(config.DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA busy_timeout = 5000")
        conn.execute("PRAGMA foreign_keys = ON")
        _conn = conn
        _migrate(conn)
        return conn


def _adopt_legacy_db() -> None:
    """Move a pre-rename database to the new name, sidecars included.

    Renaming the project must not orphan someone's chats. This runs before the
    connection is opened, so the WAL and shm files can move with it - renaming
    a database out from under an open connection is how a WAL gets separated
    from the file it belongs to.
    """
    old = getattr(config, "LEGACY_DB_PATH", None)
    if old is None or config.DB_PATH.exists() or not old.exists():
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
        entry_json  TEXT NOT NULL,
        origin      TEXT NOT NULL DEFAULT 'original',
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

]


# Columns added after a table shipped. `CREATE TABLE IF NOT EXISTS` does not
# alter an existing table, so a deployed database needs these explicitly.
ADD_COLUMNS = [
    ("agent_presets", "instructions", "TEXT NOT NULL DEFAULT ''"),
    ("skills", "kind", "TEXT NOT NULL DEFAULT 'md'"),
    ("skills", "filename", "TEXT NOT NULL DEFAULT ''"),
    # A checkpoint covers the whole chat - turns, this chat's lorebook entries
    # and its long-term memory - because that is the unit the user restores.
    # Older rows have NULL here and restore turns only.
    ("checkpoints", "lore_json", "TEXT"),
    ("checkpoints", "memory_json", "TEXT"),
    # The entry as it came from RisuAI, so an edit can be told from a no-op and
    # a commit knows what the new baseline is. NULL for rows that predate it.
    ("lore_entries", "original_json", "TEXT"),
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


def _migrate(conn: sqlite3.Connection) -> None:
    with LOCK:
        for stmt in DDL:
            conn.execute(stmt)
        for stmt in DROP_FTS:
            conn.execute(stmt)
        for table, column, decl in ADD_COLUMNS:
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
            if column not in cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
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


def execute(sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    with LOCK:
        conn = connect()
        cur = conn.execute(sql, tuple(params))
        conn.commit()
        return cur


def executemany(sql: str, rows: Iterable[Iterable[Any]]) -> None:
    with LOCK:
        conn = connect()
        conn.executemany(sql, [tuple(r) for r in rows])
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


def close() -> None:
    global _conn
    with LOCK:
        if _conn is not None:
            _conn.close()
            _conn = None
