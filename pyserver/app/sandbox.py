"""Confining agent-written Python to one bot's workspace.

This narrows an earlier decision. `run_python` was deliberately unrestricted;
the ask now is narrower and better: keep the power, but stop it reaching
another bot's data or the rest of the disk. So the limits here are about
*scope*, not capability - inside the workspace the agent can do anything.

Two mechanisms, because one alone is not enough:

1. **An audit hook** (`sys.addaudithook`) installed before user code runs. It
   sees every open, rename, unlink and process spawn from inside the
   interpreter, and an audit hook cannot be uninstalled once added. Writes
   outside the workspace are refused; reads are allowed only inside the
   workspace or the interpreter's own installation, since imports need that.
   Spawning a process is refused outright - a child without the hook would
   make the rest of this decorative.

2. **A scoped database.** The child never sees the real DB. The parent exports
   just this character's rows into `.scratch/scope.db` and the helper reads
   that, so "only this bot's data" is true by construction rather than by the
   helper remembering to add a WHERE clause. Proposals are appended to a JSONL
   file and harvested by the parent, which re-validates every one against the
   real database - so a script cannot stage an edit to a chat it cannot see.

None of this is a defence against the operator: they own the machine and can
run Python directly. It is a defence against an agent making a mess outside the
folder it was asked to work in.
"""
from __future__ import annotations

BOOTSTRAP = '''"""Installed before agent code runs. Confines it to one workspace."""
import os
import sys

_ROOT = os.path.realpath(os.environ["RISUELF_WORKSPACE"])
# Reads outside the workspace are allowed only where imports must reach.
_READ_OK = tuple(os.path.realpath(p) for p in {
    sys.prefix, sys.base_prefix, os.path.dirname(os.__file__),
    *[p for p in sys.path if p],
} if p and os.path.isdir(p))

_WRITE_MODES = ("w", "a", "x", "+")


def _inside(path, roots):
    # Audit events carry things that are not paths - an already-open fd as an
    # int, for one, which importlib passes while writing a .pyc. An fd was
    # obtained through an open this hook already judged, so anything that is
    # not a path name is allowed rather than crashed on.
    if not isinstance(path, (str, bytes, os.PathLike)):
        return True
    try:
        real = os.path.realpath(os.fsdecode(path))
    except (OSError, ValueError, TypeError):
        return False
    for r in roots:
        if real == r or real.startswith(r + os.sep):
            return True
    return False


class SandboxError(PermissionError):
    pass


def _hook(event, args):
    if event == "open":
        path, _, flags = (list(args) + [None, None, None])[:3]
        if path is None or not isinstance(path, (str, bytes, os.PathLike)):
            return
        # `flags` is an int for os.open and a mode string for builtins.open.
        writing = False
        if isinstance(flags, str):
            writing = any(m in flags for m in _WRITE_MODES)
        elif isinstance(flags, int):
            writing = bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT))
        if writing:
            if not _inside(path, (_ROOT,)):
                raise SandboxError(
                    "워크스페이스 밖에는 쓸 수 없습니다: %s (허용: %s)" % (path, _ROOT))
        elif not _inside(path, (_ROOT,) + _READ_OK):
            raise SandboxError(
                "워크스페이스 밖은 읽을 수 없습니다: %s (허용: %s)" % (path, _ROOT))

    elif event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir", "os.link", "os.symlink",
                   "os.truncate", "os.chmod", "os.chown", "shutil.copyfile",
                   "shutil.move", "shutil.rmtree"):
        for a in args:
            if isinstance(a, (str, bytes, os.PathLike)) and not _inside(a, (_ROOT,)):
                raise SandboxError("워크스페이스 밖은 수정할 수 없습니다: %s" % (a,))

    elif event in ("subprocess.Popen", "os.system", "os.exec", "os.spawn", "os.posix_spawn"):
        # A child process would not carry this hook, which would make every
        # rule above advisory.
        raise SandboxError("스크립트에서 다른 프로세스를 실행할 수는 없습니다")


sys.addaudithook(_hook)
os.chdir(_ROOT)

# Hand-off: run the agent's file with __name__ == "__main__" so ordinary
# `if __name__ == "__main__":` blocks behave as written.
_target = os.environ["RISUELF_SCRIPT"]
with open(_target, "r", encoding="utf-8") as _f:
    _code = _f.read()
sys.argv = [_target]
exec(compile(_code, _target, "exec"), {"__name__": "__main__", "__file__": _target})
'''

LEGACY_HELPER = '''"""Old name for the risuelf helper. Kept so existing scripts run.

The module was called `realooc` before the project was renamed. Re-exporting
costs three lines and saves every script skill written before the rename.
"""
from risuelf import *  # noqa: F401,F403
from risuelf import conn, turns, turn, search, chats, lore, card, stage  # noqa: F401
from risuelf import stage_many, scratch, out, uploads, read_upload  # noqa: F401
'''

HELPER = '''"""Helpers for Risu Elf agent scripts. Import as `import risuelf`.

Reads come from a scoped snapshot containing only this bot's data - other
characters are not merely filtered out, they are not in the file.

Nothing here writes to the transcript. `stage()` appends a proposal that the
backend validates and a person approves. A script that edited turns directly
would bypass the review the whole design rests on, so the capability is not
offered.

Where to put files - please follow this, the panel cleans up on it:
    scratch/   throwaway working files. Safe to delete at any time.
    out/       deliverables the user will download (md, html, json).
    uploads/   read-only: files the user provided. Do not write here.
"""
import json
import os
import sqlite3
import uuid

WORKSPACE = os.environ["RISUELF_WORKSPACE"]
CHAT_KEY = os.environ["RISUELF_CHAT_KEY"]
SESSION_ID = os.environ.get("RISUELF_SESSION_ID") or None

SCRATCH = os.path.join(WORKSPACE, "scratch")
OUT = os.path.join(WORKSPACE, "out")
UPLOADS = os.path.join(WORKSPACE, "uploads")

_SCOPE_DB = os.path.join(WORKSPACE, ".scratch", "scope.db")
_STAGED = os.path.join(WORKSPACE, ".scratch", "staged.jsonl")


def conn():
    """Read-only connection to this bot's scoped snapshot."""
    c = sqlite3.connect("file:%s?mode=ro" % _SCOPE_DB.replace("?", "%3f"), uri=True)
    c.row_factory = sqlite3.Row
    return c


def turns(start=None, end=None, role=None, chat_key=None):
    sql = "SELECT seq, msg_id, role, body, time, chat_key FROM turns WHERE chat_key = ?"
    args = [chat_key or CHAT_KEY]
    if start is not None:
        sql += " AND seq >= ?"; args.append(start)
    if end is not None:
        sql += " AND seq <= ?"; args.append(end)
    if role:
        sql += " AND role = ?"; args.append(role)
    sql += " ORDER BY seq"
    with conn() as c:
        return [dict(r) for r in c.execute(sql, args)]


def turn(msg_id):
    with conn() as c:
        r = c.execute(
            "SELECT seq, msg_id, role, body, time FROM turns WHERE chat_key = ? AND msg_id = ?",
            (CHAT_KEY, msg_id),
        ).fetchone()
        return dict(r) if r else None


def search(needle, limit=50, chat_key=None):
    with conn() as c:
        rows = c.execute(
            "SELECT seq, msg_id, role, body, chat_key FROM turns "
            "WHERE chat_key = ? AND body LIKE ? ORDER BY seq LIMIT ?",
            (chat_key or CHAT_KEY, "%" + needle + "%", limit),
        ).fetchall()
    return [dict(r) for r in rows]


def chats():
    """Every chat of this bot, so a cross-chat pass stays within the bot."""
    with conn() as c:
        return [dict(r) for r in c.execute(
            "SELECT chat_key, name, chat_index FROM chats ORDER BY chat_index")]


def lore():
    with conn() as c:
        rows = c.execute("SELECT scope, entry_json FROM lore_entries ORDER BY scope, seq").fetchall()
    return [{"scope": r["scope"], "entry": json.loads(r["entry_json"])} for r in rows]


def card():
    with conn() as c:
        r = c.execute("SELECT card_json FROM characters LIMIT 1").fetchone()
    return json.loads(r["card_json"]) if r else {}


def _append(rec):
    os.makedirs(os.path.dirname(_STAGED), exist_ok=True)
    with open(_STAGED, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\\n")


def stage(msg_id, after, reason="", op="edit", batch_id=None):
    """Propose one change. Applied only after a person approves it."""
    _append({"op": op, "msgId": msg_id, "after": after, "reason": reason,
             "batchId": batch_id, "chatKey": CHAT_KEY, "sessionId": SESSION_ID})


def stage_many(items, reason=""):
    """Propose a group that is approved and applied together."""
    batch = uuid.uuid4().hex
    for it in items:
        stage(it["msg_id"], it.get("after"), it.get("reason", reason),
              it.get("op", "edit"), batch)
    return batch


def scratch(name):
    """Path for a throwaway file. Created under scratch/."""
    os.makedirs(SCRATCH, exist_ok=True)
    return os.path.join(SCRATCH, os.path.basename(name))


def out(name):
    """Path for a deliverable the user will download."""
    os.makedirs(OUT, exist_ok=True)
    return os.path.join(OUT, os.path.basename(name))


def uploads():
    """Files the user provided, as names."""
    if not os.path.isdir(UPLOADS):
        return []
    return sorted(os.listdir(UPLOADS))


def read_upload(name):
    with open(os.path.join(UPLOADS, os.path.basename(name)), "r",
              encoding="utf-8", errors="replace") as f:
        return f.read()
'''
