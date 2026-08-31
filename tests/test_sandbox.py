"""Prove the workspace confinement actually holds.

Every claim here is one a reader would otherwise have to take on trust: that a
script cannot read outside its workspace, cannot write outside it, cannot start
a process to shed the audit hook, and cannot see another bot's chats. Each is
checked by running real Python through the real runner.

    pyserver/.venv/Scripts/python.exe tests/test_sandbox.py
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-sandbox-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)

from app import actions, db, files, pyexec, staging, store, workspace  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def make_chat(chat_id: str, name: str, n: int, subject: str) -> dict:
    return {
        "id": chat_id, "name": name, "note": "", "localLore": [], "fmIndex": 0,
        "message": [
            {"role": "user" if i % 2 == 0 else "char",
             "data": f"턴 {i}: {subject} 이야기",
             "time": 1778892822492 + i * 1000, "chatId": f"{chat_id}-m{i}"}
            for i in range(n)
        ],
    }


def setup() -> tuple[str, str, Path, str]:
    db.connect()
    a = workspace.materialize({
        "charId": "cha-alpha", "characterIndex": 0,
        "card": {"name": "알파", "chaId": "cha-alpha", "desc": "알파 설명"},
        "chats": [{"chat": make_chat("alpha-chat", "알파 챗", 6, "알파비밀"), "chatIndex": 0}],
    })
    # A second bot whose DATA must stay invisible from the first one's scripts.
    # Its FILES in the space are shared - that is the point of the space.
    b = workspace.materialize({
        "charId": "cha-beta", "characterIndex": 1,
        "card": {"name": "베타", "chaId": "cha-beta", "desc": "베타 설명"},
        "chats": [{"chat": make_chat("beta-chat", "베타 챗", 4, "베타비밀"), "chatIndex": 0}],
    })
    ck = a["charKey"]
    tk = a["chats"][0]["chatKey"]
    return ck, tk, workspace.root(ck), b["charKey"]


def run(code: str, ck: str, tk: str, ws: Path) -> dict:
    return pyexec.run(code, ws, tk, ck, session_id=None, timeout_s=45)


def main() -> int:
    ck, tk, ws, beta = setup()
    home = workspace.hina_dir(ck)

    print("test_normal_work_still_works")
    r = run(
        "import risuhina\n"
        "ts = risuhina.turns()\n"
        "print('turns', len(ts))\n"
        "p = risuhina.scratch('note.txt')\n"
        "open(p, 'w', encoding='utf-8').write('작업 중')\n"
        "print('wrote', open(p, encoding='utf-8').read())\n",
        ck, tk, ws)
    check("script runs", r["ok"], r.get("stderr", "")[:300])
    check("it can read its own turns", "turns 6" in r["stdout"], r["stdout"][:200])
    check("it can write to scratch/", "wrote 작업 중" in r["stdout"], r["stdout"][:200])
    check("scratch file exists in the bot's hina home", (home / "scratch" / "note.txt").is_file())

    print("\ntest_abort_kills_a_running_script")
    # The user's 중단 must end the PROCESS, not just the narration: the tool
    # thread used to block in subprocess.run until the script finished on its
    # own (§1-27). Register the stop, kill via abort(), and the run returns
    # long before its timeout with the abort named.
    import threading as _threading
    import time as _time
    from app import session as _session
    _session._STOPPED.add("sess-abort")
    _res: dict = {}

    def _bg() -> None:
        _res.update(pyexec.run("import time\nprint('start', flush=True)\ntime.sleep(60)\n",
                               ws, tk, ck, session_id="sess-abort", timeout_s=90))

    _th = _threading.Thread(target=_bg)
    _t0 = _time.time()
    _th.start()
    while _time.time() - _t0 < 15 and not pyexec.abort("sess-abort"):
        _time.sleep(0.2)
    _th.join(timeout=20)
    _session._STOPPED.discard("sess-abort")
    check("the script died well before its timeout",
          not _th.is_alive() and _time.time() - _t0 < 30, str(_res)[:200])
    check("the result says it was aborted, not crashed",
          _res.get("ok") is False and _res.get("aborted") is True
          and "중단" in str(_res.get("error") or ""), str(_res)[:200])

    print("\ntest_cannot_escape_the_space")
    r = run("import os; print('cwd', os.getcwd())", ck, tk, ws)
    check("the cwd is the bot's own hina folder",
          r["ok"] and r["stdout"].strip().endswith(str(home.name)), r["stdout"][:200])

    outside = str((ws.parent / "escaped.txt").resolve()).replace("\\", "\\\\")
    r = run(f"open('{outside}', 'w').write('nope')", ck, tk, ws)
    check("writing into a SYSTEM parent fails", not r["ok"], str(r.get("exitCode")))
    check("the refusal says why", "작업 공간 밖" in (r["stderr"] or ""), r["stderr"][:200])
    check("nothing was written", not (ws.parent / "escaped.txt").exists())

    r = run("print(open(__import__('os').environ['RISUHINA_DATA_DIR'] + '/config.json').read())",
            ck, tk, ws)
    check("reading the data dir fails", not r["ok"], r["stdout"][:120])

    # The space is shared: another bot's files in it are readable on purpose.
    beta_home = workspace.hina_dir(beta)
    (beta_home / "out" / "베타글.md").write_text("베타의 산출물", encoding="utf-8")
    r = run(
        "import os\n"
        "p = os.path.join(os.environ['RISUHINA_WORKSPACE'], 'hina', '베타', 'out', '베타글.md')\n"
        "print(open(p, encoding='utf-8').read())\n",
        ck, tk, ws)
    check("another bot's space files are readable (shared on purpose)",
          r["ok"] and "베타의 산출물" in r["stdout"], (r["stderr"] or r["stdout"])[:200])

    # Its DATA axis is not: the other bot's SYSTEM dir stays out of reach.
    other = str((workspace.root(beta) / "card.md").resolve()).replace("\\", "\\\\")
    r2 = run(f"print(open(r'{other}', encoding='utf-8').read())", ck, tk, ws)
    check("reading another bot's SYSTEM file fails", not r2["ok"], r2["stdout"][:120])

    # My own SYSTEM dir: readable (the frozen originals are the diff base),
    # but no longer writable - tighter than the per-bot era.
    r = run(
        "import os\n"
        "sys_dir = os.environ['RISUHINA_SYSTEM']\n"
        "print('card head', open(os.path.join(sys_dir, 'card.md'), encoding='utf-8').read()[:8])\n",
        ck, tk, ws)
    check("my own SYSTEM files are readable", r["ok"], (r["stderr"] or "")[:200])
    r = run(
        "import os\n"
        "sys_dir = os.environ['RISUHINA_SYSTEM']\n"
        "open(os.path.join(sys_dir, 'card.md'), 'a', encoding='utf-8').write('x')\n",
        ck, tk, ws)
    check("but writing them fails", not r["ok"], r["stdout"][:120])

    print("\ntest_cannot_shed_the_hook")
    r = run("import subprocess; subprocess.run(['python', '-c', 'print(1)'])", ck, tk, ws)
    check("spawning a process fails", not r["ok"], r["stdout"][:120])
    check("the refusal names the reason", "다른 프로세스" in (r["stderr"] or ""), r["stderr"][:200])

    r = run("import os; os.system('echo hi')", ck, tk, ws)
    check("os.system fails", not r["ok"], r["stdout"][:120])

    print("\ntest_other_bots_are_not_visible")
    r = run(
        "import risuhina\n"
        "print('chats', [c['name'] for c in risuhina.chats()])\n"
        "print('beta hits', len(risuhina.search('베타비밀')))\n"
        "print('card', risuhina.card().get('name'))\n",
        ck, tk, ws)
    check("scoped read works", r["ok"], r.get("stderr", "")[:300])
    check("only this bot's chats are listed", "알파 챗" in r["stdout"] and "베타 챗" not in r["stdout"],
          r["stdout"][:200])
    check("the other bot's text is unreachable", "beta hits 0" in r["stdout"], r["stdout"][:200])
    check("the card is this bot's", "card 알파" in r["stdout"], r["stdout"][:200])

    r = run(
        "import risuhina, sqlite3\n"
        "c = risuhina.conn()\n"
        "print('rows', c.execute('SELECT COUNT(*) FROM characters').fetchone()[0])\n"
        "try:\n"
        "    c.execute(\"UPDATE turns SET body='x'\")\n"
        "    print('WRITABLE')\n"
        "except Exception as e:\n"
        "    print('readonly', type(e).__name__)\n",
        ck, tk, ws)
    check("the snapshot holds one character", "rows 1" in r["stdout"], r["stdout"][:200])
    check("the snapshot is read-only", "readonly" in r["stdout"], r["stdout"][:200])

    print("\ntest_staging_from_a_script")
    r = run(
        "import risuhina\n"
        "t = risuhina.turns()[1]\n"
        "risuhina.stage(t['msg_id'], t['body'] + ' (제안)', '스크립트 테스트')\n"
        "print('staged one')\n",
        ck, tk, ws)
    check("script ran", r["ok"], r.get("stderr", "")[:200])
    check("the runner harvested it", r["staged"] == 1, str(r.get("staged")))
    pending = staging.pending(tk)
    check("it is pending approval", len(pending) == 1, str(len(pending)))
    check("the transcript is untouched",
          store.turn_by_msg(tk, pending[0]["msgId"])["body"] == pending[0]["before"])

    # A proposal naming another bot's chat must not survive validation.
    (ws / ".scratch").mkdir(parents=True, exist_ok=True)
    (ws / ".scratch" / "staged.jsonl").write_text(
        '{"op":"edit","msgId":"beta-chat-m1","after":"x","chatKey":"someone-else"}\n',
        encoding="utf-8")
    got = pyexec.harvest(ws, tk, None)
    check("a proposal for another chat is dropped", got == 0, str(got))

    print("\ntest_file_management")
    folder = workspace.bot_folder(ck)
    files.upload(files.SPACE, "참고.md", text="# 참고 자료\n본문", into=f"projects/{folder}")
    listing = files.listing(ck)
    areas = {a["area"]: a for a in listing["areas"]}
    check("original is protected from deletion", areas["original"]["deletable"] is False)

    r = run("import risuhina\nprint(risuhina.uploads())\nprint(risuhina.read_upload('참고.md'))",
            ck, tk, ws)
    check("the agent can read the project material", "참고 자료" in r["stdout"],
          (r["stderr"] or r["stdout"])[:200])

    # 정리 is per bot: this bot's hina scratch/scripts and its SYSTEM .scratch,
    # never the project material or the deliverables.
    (home / "scratch" / "쓰레기.txt").write_text("x", encoding="utf-8")
    (home / "out" / "산출.md").write_text("keep", encoding="utf-8")
    cleaned = files.clean_bot(ck)
    check("cleaning swept the bot's scratch", cleaned["removed"] > 0
          and not (home / "scratch" / "쓰레기.txt").exists(), str(cleaned))
    check("deliverables survived cleaning", (home / "out" / "산출.md").is_file())
    check("the project material survived",
          (workspace.space_root() / "projects" / folder / "참고.md").is_file())
    check("original survived cleaning", any((ws / "original").iterdir()))

    try:
        files.delete(ck, "../escape.txt")
        check("path traversal on delete is refused", False)
    except files.FileError:
        check("path traversal on delete is refused", True)
    try:
        files.delete(ck, "original/" + Path(next(iter((ws / "original").iterdir()))).name)
        check("deleting a frozen original is refused", False)
    except files.FileError:
        check("deleting a frozen original is refused", True)

    print("\ntest_action_queue_gates_writes")
    lore_id = store.add_lore(ck, {"key": "테스트", "content": "원래 내용"}, "local", tk)
    act = actions.propose(
        "lore_edit", chat_key=tk, char_key=ck, summary="로어 수정 제안",
        args={"id": lore_id, "entry": {"key": "테스트", "content": "고친 내용"}})
    check("proposing returns an id", bool(act.get("id")), str(act))
    check("it is queued", len(actions.pending(tk)) == 1, str(actions.pending(tk)))
    # The whole point of the queue: proposing changed nothing.
    check("proposing did not write",
          store.lore_entry(lore_id)["entry"]["content"] == "원래 내용",
          str(store.lore_entry(lore_id)))

    out = actions.decide(act["id"], True)
    check("approving executes it", out.get("approved") is True, str(out))
    check("and the write landed",
          store.lore_entry(lore_id)["entry"]["content"] == "고친 내용",
          str(store.lore_entry(lore_id)))
    check("the queue is empty again", not actions.pending(tk))

    # Deciding twice must not run it twice.
    try:
        actions.decide(act["id"], True)
        check("a decided action cannot be re-run", False)
    except actions.ActionError:
        check("a decided action cannot be re-run", True)

    rejected = actions.propose("lore_delete", chat_key=tk, char_key=ck,
                               summary="삭제 제안", args={"id": lore_id})
    actions.decide(rejected["id"], False)
    check("rejecting leaves the data alone", store.lore_entry(lore_id) is not None)

    # Host actions are approved here but carried out by the plugin.
    host = actions.propose("host_writeback", chat_key=tk, char_key=ck, summary="반영")
    out = actions.decide(host["id"], True)
    check("a host action hands work back to the plugin",
          (out.get("host") or {}).get("kind") == "host_writeback", str(out))
    check("and stays open until it reports",
          actions.get(host["id"])["status"] == "approved",
          str(actions.get(host["id"])["status"]))
    actions.complete(host["id"], True, "반영했습니다")
    check("completing closes it", actions.get(host["id"])["status"] == "done")

    db.close()
    shutil.rmtree(DATA, ignore_errors=True)

    print()
    if FAILURES:
        print(f"FAIL - {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASS - scripts share the space and cannot reach another bot's DATA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
