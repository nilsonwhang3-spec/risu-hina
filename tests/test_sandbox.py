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

DATA = Path(tempfile.mkdtemp(prefix="risuelf-sandbox-"))
os.environ["RISUELF_DATA_DIR"] = str(DATA)

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


def setup() -> tuple[str, str, Path]:
    db.connect()
    a = workspace.materialize({
        "charId": "cha-alpha", "characterIndex": 0,
        "card": {"name": "알파", "chaId": "cha-alpha", "desc": "알파 설명"},
        "chats": [{"chat": make_chat("alpha-chat", "알파 챗", 6, "알파비밀"), "chatIndex": 0}],
    })
    # A second bot whose data must be invisible from the first one's scripts.
    workspace.materialize({
        "charId": "cha-beta", "characterIndex": 1,
        "card": {"name": "베타", "chaId": "cha-beta", "desc": "베타 설명"},
        "chats": [{"chat": make_chat("beta-chat", "베타 챗", 4, "베타비밀"), "chatIndex": 0}],
    })
    ck = a["charKey"]
    tk = a["chats"][0]["chatKey"]
    return ck, tk, workspace.root(ck)


def run(code: str, ck: str, tk: str, ws: Path) -> dict:
    return pyexec.run(code, ws, tk, ck, session_id=None, timeout_s=45)


def main() -> int:
    ck, tk, ws = setup()

    print("test_normal_work_still_works")
    r = run(
        "import risuelf\n"
        "ts = risuelf.turns()\n"
        "print('turns', len(ts))\n"
        "p = risuelf.scratch('note.txt')\n"
        "open(p, 'w', encoding='utf-8').write('작업 중')\n"
        "print('wrote', open(p, encoding='utf-8').read())\n",
        ck, tk, ws)
    check("script runs", r["ok"], r.get("stderr", "")[:300])
    check("it can read its own turns", "turns 6" in r["stdout"], r["stdout"][:200])
    check("it can write to scratch/", "wrote 작업 중" in r["stdout"], r["stdout"][:200])
    check("scratch file exists on disk", (ws / "scratch" / "note.txt").is_file())

    print("\ntest_cannot_escape_the_workspace")
    outside = str((ws.parent / "escaped.txt").resolve()).replace("\\", "\\\\")
    r = run(f"open('{outside}', 'w').write('nope')", ck, tk, ws)
    check("writing to the parent directory fails", not r["ok"], str(r.get("exitCode")))
    check("the refusal says why", "워크스페이스 밖" in (r["stderr"] or ""), r["stderr"][:200])
    check("nothing was written", not (ws.parent / "escaped.txt").exists())

    r = run("print(open(__import__('os').environ['RISUELF_DATA_DIR'] + '/config.json').read())",
            ck, tk, ws)
    check("reading the data dir fails", not r["ok"], r["stdout"][:120])

    r = run("import os; print(os.listdir(os.path.dirname(os.environ['RISUELF_WORKSPACE'])))",
            ck, tk, ws)
    # listdir is not an audited open, so it may succeed - what must fail is
    # actually reading anything it names.
    other = str((ws.parent / "cb1" / "card.md")).replace("\\", "\\\\")
    r2 = run(f"print(open(r'{other}', encoding='utf-8').read())", ck, tk, ws)
    check("reading another workspace's file fails", not r2["ok"], r2["stdout"][:120])

    print("\ntest_cannot_shed_the_hook")
    r = run("import subprocess; subprocess.run(['python', '-c', 'print(1)'])", ck, tk, ws)
    check("spawning a process fails", not r["ok"], r["stdout"][:120])
    check("the refusal names the reason", "다른 프로세스" in (r["stderr"] or ""), r["stderr"][:200])

    r = run("import os; os.system('echo hi')", ck, tk, ws)
    check("os.system fails", not r["ok"], r["stdout"][:120])

    print("\ntest_other_bots_are_not_visible")
    r = run(
        "import risuelf\n"
        "print('chats', [c['name'] for c in risuelf.chats()])\n"
        "print('beta hits', len(risuelf.search('베타비밀')))\n"
        "print('card', risuelf.card().get('name'))\n",
        ck, tk, ws)
    check("scoped read works", r["ok"], r.get("stderr", "")[:300])
    check("only this bot's chats are listed", "알파 챗" in r["stdout"] and "베타 챗" not in r["stdout"],
          r["stdout"][:200])
    check("the other bot's text is unreachable", "beta hits 0" in r["stdout"], r["stdout"][:200])
    check("the card is this bot's", "card 알파" in r["stdout"], r["stdout"][:200])

    r = run(
        "import risuelf, sqlite3\n"
        "c = risuelf.conn()\n"
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
        "import risuelf\n"
        "t = risuelf.turns()[1]\n"
        "risuelf.stage(t['msg_id'], t['body'] + ' (제안)', '스크립트 테스트')\n"
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
    files.upload(ck, "참고.md", text="# 참고 자료\n본문")
    listing = files.listing(ck)
    areas = {a["area"]: a for a in listing["areas"]}
    check("uploads are listed", areas["uploads"]["count"] == 1, str(areas["uploads"]))
    check("uploads are protected from cleaning", areas["uploads"]["cleanable"] is False)
    check("original is protected from deletion", areas["original"]["deletable"] is False)
    check("scratch is cleanable", areas["scratch"]["cleanable"] is True)

    r = run("import risuelf\nprint(risuelf.uploads())\nprint(risuelf.read_upload('참고.md'))",
            ck, tk, ws)
    check("the agent can read an upload", "참고 자료" in r["stdout"], r["stdout"][:200])

    before = files.listing(ck)["totalSize"]
    cleaned = files.clean(ck)
    after = files.listing(ck)
    check("cleaning removed files", cleaned["removed"] > 0, str(cleaned))
    check("it freed space", after["totalSize"] < before, f"{before} -> {after['totalSize']}")
    kept = {a["area"]: a["count"] for a in after["areas"]}
    check("uploads survived cleaning", kept["uploads"] == 1, str(kept))
    check("original survived cleaning", kept["original"] > 0, str(kept))

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
    print("PASS - scripts stay inside one bot's workspace")
    return 0


if __name__ == "__main__":
    sys.exit(main())
