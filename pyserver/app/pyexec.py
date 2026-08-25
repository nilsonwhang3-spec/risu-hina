"""Run agent-written Python, confined to one bot's workspace.

Capability is unchanged inside the workspace - full stdlib, installed packages,
network. What changed is reach: `sandbox.py` explains the two mechanisms and
why each is needed. The remaining limits here are reliability, not permission:

  timeout        a runaway loop must not wedge the server
  output cap     a runaway print must not exhaust memory
  subprocess     a segfault or sys.exit kills a child, not the backend
"""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import textwrap
from pathlib import Path

from . import config, db, log, sandbox, staging, skills

SCOPE_TABLES = ("characters", "chats", "turns", "turns_original", "lore_entries",
                "card_fields", "card_scripts", "char_assets")


def install_skills(ws: Path) -> list[str]:
    """Copy the enabled skill folders into <workspace>/skills/<slug>/.

    Skills are global and workspaces are per bot, so the folders have to come
    to the sandbox rather than the sandbox reaching out to them - the audit
    hook in sandbox.py refuses anything outside the workspace, and that refusal
    is the point.

    The directory is rebuilt on every run: a skill the user disabled or renamed
    must not linger as a folder the agent can still find and run.
    """
    import shutil

    out = ws / "skills"
    try:
        if out.exists():
            shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        log.warn("could not prepare the skills directory: %s", e)
        return []

    written: list[str] = []
    for slug, src in skills.enabled_dirs():
        try:
            shutil.copytree(src, out / slug, dirs_exist_ok=True)
            written.append(slug)
        except OSError as e:  # noqa: PERF203
            log.warn("could not install skill %s: %s", slug, e)
    if written:
        log.debug("installed %s skill folder(s)", len(written))
    return written


def layout(workspace_dir: Path) -> None:
    """Create the directories the agent is told to use.

    They exist up front so the instruction to put throwaway files in scratch/
    and deliverables in out/ describes something real rather than something the
    agent has to invent.
    """
    for name in ("scratch", "out", "uploads", "scripts", ".scratch"):
        (workspace_dir / name).mkdir(parents=True, exist_ok=True)
    (workspace_dir / "scripts" / "risuelf.py").write_text(sandbox.HELPER, encoding="utf-8")
    # The helper used to be called `realooc`. Any script skill the user already
    # wrote still says `import realooc`, and a rename that breaks those scripts
    # at the moment they are finally needed is not worth the tidiness.
    (workspace_dir / "scripts" / "realooc.py").write_text(
        sandbox.LEGACY_HELPER, encoding="utf-8")
    (workspace_dir / ".scratch" / "_bootstrap.py").write_text(sandbox.BOOTSTRAP, encoding="utf-8")


def build_scope_db(workspace_dir: Path, char_key: str) -> Path:
    """Export just this character's rows into a snapshot the child may read.

    Rebuilt whenever the character's data has moved. "Only this bot" is then a
    property of the file rather than a WHERE clause the helper has to remember.
    """
    path = workspace_dir / ".scratch" / "scope.db"
    stamp_path = workspace_dir / ".scratch" / "scope.stamp"

    # Table-qualified throughout: the correlated subqueries see the outer
    # `characters` row, so a bare `updated_at` is ambiguous.
    row = db.one(
        "SELECT c.updated_at AS c_at, "
        "  (SELECT MAX(k.updated_at) FROM chats k WHERE k.char_key = c.char_key) AS t_at, "
        "  (SELECT MAX(t.updated_at) FROM turns t JOIN chats k2 ON k2.chat_key = t.chat_key "
        "     WHERE k2.char_key = c.char_key) AS u_at, "
        "  (SELECT MAX(f.updated_at) FROM card_fields f WHERE f.char_key = c.char_key) AS f_at, "
        "  (SELECT COUNT(*) FROM card_scripts s WHERE s.char_key = c.char_key) AS s_n "
        "FROM characters c WHERE c.char_key = ?",
        (char_key,),
    )
    stamp = json.dumps(
        [row["c_at"], row["t_at"], row["u_at"], row["f_at"], row["s_n"]] if row else [])
    if path.exists() and stamp_path.exists():
        try:
            if stamp_path.read_text(encoding="utf-8") == stamp:
                return path
        except OSError:
            pass

    if path.exists():
        path.unlink()
    out = sqlite3.connect(str(path))
    try:
        with db.LOCK:
            src = db.connect()
            for table in SCOPE_TABLES:
                cols = [r["name"] for r in src.execute(f"PRAGMA table_info({table})")]
                coldef = ", ".join(f'"{c}"' for c in cols)
                out.execute(f"CREATE TABLE {table} ({coldef})")
                if table == "characters":
                    sql = f"SELECT {coldef} FROM characters WHERE char_key = ?"
                    args: tuple = (char_key,)
                elif table in ("chats", "lore_entries", "card_fields", "card_scripts", "char_assets"):
                    sql = f"SELECT {coldef} FROM {table} WHERE char_key = ?"
                    args = (char_key,)
                else:
                    sql = (f"SELECT {coldef} FROM {table} WHERE chat_key IN "
                           f"(SELECT chat_key FROM chats WHERE char_key = ?)")
                    args = (char_key,)
                rows = src.execute(sql, args).fetchall()
                if rows:
                    marks = ",".join("?" * len(cols))
                    out.executemany(f"INSERT INTO {table} VALUES ({marks})",
                                    [tuple(r) for r in rows])
            out.execute("CREATE INDEX turns_scope ON turns(chat_key, seq)")
            out.commit()
    finally:
        out.close()
    stamp_path.write_text(stamp, encoding="utf-8")
    log.debug("scope.db rebuilt char=%s", char_key)
    return path


def harvest(workspace_dir: Path, chat_key: str, session_id: str | None) -> int:
    """Ingest proposals the script appended, re-validating each one.

    The child writes to a file rather than the database, so every proposal is
    checked against the real turns here. A script cannot stage an edit to a
    chat it was never given, and a malformed line is dropped rather than
    poisoning the review list.
    """
    path = workspace_dir / ".scratch" / "staged.jsonl"
    if not path.exists():
        return 0
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return 0
    path.unlink(missing_ok=True)

    from . import store
    staged = 0
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            log.warn("staged.jsonl: unparseable line dropped")
            continue
        if rec.get("chatKey") != chat_key:
            log.warn("staged.jsonl: proposal for another chat dropped")
            continue
        op = str(rec.get("op") or "edit")
        msg_id = str(rec.get("msgId") or "")
        cur = store.turn_by_msg(chat_key, msg_id)
        if op in ("edit", "delete") and cur is None:
            log.warn("staged.jsonl: unknown turn %s dropped", msg_id)
            continue
        after = rec.get("after")
        if op == "edit" and (after is None or str(after) == str(cur["body"])):
            continue
        staging.stage(
            chat_key, op, session_id=session_id,
            batch_id=rec.get("batchId"), msg_id=msg_id,
            before=str(cur["body"]) if cur else None,
            after=None if after is None else str(after),
            reason=str(rec.get("reason") or "스크립트가 제안했습니다"),
            seq=int(cur["seq"]) if cur else None,
        )
        staged += 1
    if staged:
        log.info("harvested %s staged proposal(s) from script", staged)
    return staged


def run(
    code: str,
    workspace_dir: Path,
    chat_key: str,
    char_key: str,
    *,
    session_id: str | None = None,
    timeout_s: int | None = None,
    max_output: int | None = None,
) -> dict:
    cfg = config.section("python")
    timeout = int(timeout_s or cfg.get("timeoutSeconds") or 120)
    cap = int(max_output or cfg.get("maxOutputBytes") or 256 * 1024)

    layout(workspace_dir)
    build_scope_db(workspace_dir, char_key)
    install_skills(workspace_dir)
    src = workspace_dir / "scripts" / "_agent_run.py"
    src.write_text(code, encoding="utf-8")

    env = {
        "RISUELF_WORKSPACE": str(workspace_dir.resolve()),
        "RISUELF_CHAT_KEY": chat_key,
        "RISUELF_SCRIPT": str(src.resolve()),
        "PYTHONIOENCODING": "utf-8",
        # -u so partial output survives a timeout kill: a script that hangs
        # after printing something useful should still show what it printed.
        "PYTHONUNBUFFERED": "1",
        # No .pyc files: they are clutter in a directory the panel offers
        # to clean, and these imports are far too small to be worth caching.
        "PYTHONDONTWRITEBYTECODE": "1",
        # scripts/ first so `import risuelf` finds the helper.
        "PYTHONPATH": str((workspace_dir / "scripts").resolve()),
        "PATH": os.environ.get("PATH", ""),
        "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
    }
    if session_id:
        env["RISUELF_SESSION_ID"] = session_id

    boot = workspace_dir / ".scratch" / "_bootstrap.py"
    log.debug("run_python chat=%s bytes=%s timeout=%s", chat_key, len(code), timeout)
    try:
        proc = subprocess.run(
            [sys.executable, "-u", str(boot)],
            cwd=str(workspace_dir), env=env, capture_output=True,
            timeout=timeout, text=True, encoding="utf-8", errors="replace",
        )
        out, err, rc, timed_out = proc.stdout, proc.stderr, proc.returncode, False
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else ""
        err = e.stderr if isinstance(e.stderr, str) else ""
        rc, timed_out = -1, True
    except Exception as e:  # noqa: BLE001 - report, never crash the request
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "stdout": "", "stderr": "",
                "exitCode": -1, "timedOut": False, "staged": 0}

    staged = harvest(workspace_dir, chat_key, session_id)

    result = {
        "ok": rc == 0 and not timed_out,
        "exitCode": rc,
        "timedOut": timed_out,
        "stdout": out[:cap],
        "stderr": err[:cap],
        "truncated": len(out) > cap or len(err) > cap,
        "staged": staged,
    }
    if timed_out:
        result["error"] = f"{timeout}초 안에 끝나지 않아서 중단했습니다"
    log.info("run_python chat=%s rc=%s timeout=%s out=%sB staged=%s",
             chat_key, rc, timed_out, len(out), staged)
    return result


def describe_helper() -> str:
    """The helper API and the file conventions, for the tool description."""
    return textwrap.dedent("""
        `import risuelf` is available (workspace-scoped, this bot only):
          risuelf.turns(start, end, role, chat_key)  ordered turns
          risuelf.turn(msg_id) / risuelf.search(needle, limit)
          risuelf.chats()      every chat of this bot
          risuelf.lore() / risuelf.card()
          risuelf.stage(msg_id, after, reason)   propose one change
          risuelf.stage_many(items, reason)      propose a group
          risuelf.uploads() / risuelf.read_upload(name)
          risuelf.scratch(name) / risuelf.out(name)   paths to write to
          risuelf.conn()       read-only scoped snapshot, for other queries

        The snapshot behind risuelf.conn() holds this bot's whole structure, so
        anything the tools do not cover can be computed with plain SQL:
          characters(card_json: 카드 전체 JSON, 에셋 참조 포함)
          chats / turns / turns_original(작업본 vs 기준선)
          lore_entries(id, scope global|local, chat_key, seq, entry_json,
                       origin, original_json)  - 폴더는 mode='folder' 항목,
                       소속은 멤버.folder == 폴더.key
          card_fields(field, seq, body, original)  카드 프로즈 행
          card_scripts(kind customscript|triggerscript, seq, entry_json,
                       original_json, origin)  - Lua 코드는
                       entry_json.effect[0].code
          char_assets(seq, field image|emotion|additional|cc|vits, name, ext,
                      risu_key)  카드가 참조하는 에셋 목록(카드 순서, 스토어 쪽 매니페스트)
          card_scripts kind='assetref' (entry_json={field,name,key,ext})  카드의 에셋
                      참조 작업본 - 이름 변경·삭제는 이 행을 고친다. 같은 name 여러 개 =
                      랜덤 풀(호출 시 무작위 1개). 이름 끝 확장자는 보통 실수.
        Writes still go through the tools (stage_* / propose_*): compute with
        the script, then aim the tool with the ids the script found.

        Where to write - the panel cleans up on these, so please use them:
          risuelf.scratch("x.json")  throwaway working files
          risuelf.out("report.md")   deliverables the user downloads
          uploads/ is read-only.

        The script cannot read or write outside this workspace, cannot see other
        bots, and cannot start another process. Everything else works normally.
    """).strip()
