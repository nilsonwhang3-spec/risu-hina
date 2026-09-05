"""Black-box HTTP tests. The server is a child process; we only speak HTTP.

The suite must never import the server's internals. active-recall's docs/06 is
emphatic about why: the moment tests reach inside, they stop being an oracle for
"does the wire behaviour still hold" and start asserting the implementation
against itself. That property is what made its Node -> Python port verifiable at
all, and it is worth keeping here from the start.

Coverage is organised around the three job shapes this tool exists for, not
around the modules that implement them:

    small      edit one turn, write it back
    medium     one edit spanning many turns of a chat (the common case)
    large      summarise early turns into lorebook entries, then cut them

    RISUHINA_TEST_PY      python to run the server with
    RISUHINA_TEST_ENTRY   entry script (default pyserver/run.py)

    python tests/test_http.py
"""
from __future__ import annotations

from collections import deque

import json
import os
import shutil
import socket
import subprocess
import threading
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PYSERVER = ROOT / "pyserver"

FAILURES: list[str] = []
try:
    sys.stdout.reconfigure(encoding="utf-8")  # a FAIL detail with "—" or "⚙" must not crash the suite on cp949
except Exception:  # noqa: BLE001
    pass


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def q(path: str, **params: object) -> str:
    """Build a query string with proper percent-encoding.

    Korean query terms are the normal case here, and urllib refuses to put raw
    non-ASCII in a request line. The plugin does the same thing with
    encodeURIComponent.
    """
    parts = [
        f"{urllib.parse.quote(str(k))}={urllib.parse.quote(str(v))}"
        for k, v in params.items() if v is not None
    ]
    return path + ("?" + "&".join(parts) if parts else "")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, require_token: bool = True, codex: bool = True) -> None:
        self.port = free_port()
        self.token = "test-token-" + str(self.port)
        self.data = Path(tempfile.mkdtemp(prefix="risuhina-test-"))
        # The subscription path ships ON; an operator turns it off by putting
        # `"OPENAI_CODEX": 0` in config.json by hand. `codex=False` seeds that
        # hand edit and is asserted on its own server
        # (test_codex_off_by_hand_edit).
        if not codex:
            self.data.mkdir(parents=True, exist_ok=True)
            (self.data / "config.json").write_text(
                json.dumps({"OPENAI_CODEX": 0}, ensure_ascii=False), encoding="utf-8")
        py = os.environ.get("RISUHINA_TEST_PY") or str(PYSERVER / ".venv" / "Scripts" / "python.exe")
        if not Path(py).exists():
            py = sys.executable
        entry = os.environ.get("RISUHINA_TEST_ENTRY") or str(PYSERVER / "run.py")
        env = {
            **os.environ,
            "RISUHINA_PORT": str(self.port),
            "RISUHINA_HOST": "127.0.0.1",
            "RISUHINA_DATA_DIR": str(self.data),
            "RISUHINA_TOKEN": self.token,
            # The suite talks to 127.0.0.1, where a token is optional by design.
            # Forcing it on is what makes the 401 assertions mean anything; the
            # exemption itself is covered by test_loopback_exemption.
            "RISUHINA_REQUIRE_TOKEN": "1" if require_token else "0",
            "PYTHONIOENCODING": "utf-8",
        }
        self.proc = subprocess.Popen(
            [py, entry], cwd=str(PYSERVER), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace",
        )
        # A reader thread, not a read at the end.
        #
        # The server logs a line per request. Nobody was reading the pipe until
        # the suite finished, so once the suite's logging passed the OS pipe
        # buffer (64KB here) the server blocked inside write() and simply
        # stopped answering - which surfaced as a request timing out on a route
        # that works fine in isolation. Adding tests made it appear, so it would
        # have appeared again for whoever added the next ones.
        self._log_lines: deque[str] = deque(maxlen=4000)
        self._reader = threading.Thread(target=self._pump, daemon=True)
        self._reader.start()

    def _pump(self) -> None:
        stream = self.proc.stdout
        if stream is None:
            return
        try:
            for line in stream:
                self._log_lines.append(line)
        except Exception:
            pass

    def wait_ready(self, timeout: float = 25.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                return False
            try:
                st, body = self.get("/health")
                if st == 200 and body.get("service") == "risu-hina":
                    return True
            except Exception:
                time.sleep(0.2)
        return False

    def _req(self, method: str, path: str, payload=None, token: str | None = "__default__"):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        tok = self.token if token == "__default__" else token
        if tok:
            headers["Authorization"] = f"Bearer {tok}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode("utf-8", "replace")
                try:
                    return r.status, json.loads(raw)
                except ValueError:
                    # Not every route answers JSON - /plugin.js serves the
                    # bundle itself. The error path already did this; the
                    # success path assumed otherwise and threw on the first
                    # non-JSON route added.
                    return r.status, {"_raw": raw}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"_raw": raw}

    def get(self, path, token="__default__"):
        return self._req("GET", path, None, token)

    def post(self, path, payload=None, token="__default__"):
        return self._req("POST", path, payload if payload is not None else {}, token)

    def post_raw(self, path, body: bytes) -> tuple[int, dict]:
        """A POST whose body is bytes (application/octet-stream), JSON back."""
        url = f"http://127.0.0.1:{self.port}{path}"
        headers = {"Content-Type": "application/octet-stream", "Authorization": f"Bearer {self.token}"}
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"_raw": raw}

    def post_bytes(self, path, payload=None) -> tuple[int, bytes, dict]:
        """A POST whose answer is bytes, not JSON (the zip download)."""
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"}
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read(), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, e.read(), dict(e.headers)

    def stop(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.data, ignore_errors=True)

    def drain(self) -> str:
        """Everything the server has logged so far. Safe to call while running."""
        return "".join(self._log_lines)


# --- fixtures ---------------------------------------------------------------

def make_chat(chat_id: str, name: str, turns: int, *, subject: str = "페데리코",
              place: str = "신전") -> dict:
    msgs = []
    for i in range(turns):
        if i % 2 == 0:
            body = f"턴 {i}: {subject}는 어디 있지?"
        else:
            body = f"턴 {i}: {subject}는 {place}에 있다."
        msgs.append({
            "role": "user" if i % 2 == 0 else "char",
            "data": body,
            "time": 1778892822492 + i * 1000,
            "chatId": f"{chat_id}-m{i}",
        })
    return {
        "id": chat_id,
        "name": name,
        "note": "",
        "localLore": [],
        "fmIndex": 0,
        "arKey": "someone-elses-stamp",
        "modelBinding": {"provider": "p"},
        "hypaV3Data": {"summaries": [
            {"text": "요약 A", "chatMemos": [f"{chat_id}-m1"]},
            {"text": "요약 B", "chatMemos": [f"{chat_id}-m3", f"{chat_id}-m5"]},
        ]},
        # Chat variables as RisuAI stores them: {{setvar}} keys carry a $,
        # triggers write bare keys, and the values are not all strings.
        "scriptstate": {"$affection": 3, "$met": True, "route": "A", "tags": ["x", "y"]},
        "message": msgs,
    }


def payload(chats: list[dict]) -> dict:
    return {
        "charId": "cha-test",
        "characterIndex": 3,
        "card": {
            "name": "테스트 봇",
            "chaId": "cha-test",
            "desc": "설명",
            "firstMessage": "첫 인사",
            "globalLore": [{"key": ["기존"], "content": "기존 로어"}],
        },
        "chats": [{"chat": c, "chatIndex": i} for i, c in enumerate(chats)],
    }


def write_back(s: "Server", tk: str, chat: dict) -> dict:
    """What RisuAI would hold after the panel's 반영, as a chat object.

    Since 0.9 a commit does not move the baseline onto the working copy - the
    plugin re-reads the bot it just wrote and re-uploads that. A test that
    committed and then re-uploaded the *old* fixture would be modelling a
    write-back that never happened, so it applies the patch the same way the
    host does: edits by msgId, structural changes as the whole array, and the
    lorebook and memory as wholes.
    """
    st, p = s.get(q("/patch", chatKey=tk))
    assert st == 200, p
    out = json.loads(json.dumps(chat))
    if p.get("structural") and p.get("messages") is not None:
        out["message"] = p["messages"]
    else:
        by = {e["msgId"]: e["after"] for e in p.get("edits") or []}
        for m in out.get("message") or []:
            if m.get("chatId") in by:
                m["data"] = by[m["chatId"]]
    lore = p.get("lore") or {}
    if lore.get("changed"):
        out["localLore"] = lore.get("localLore") or []
    mem_patch = p.get("memory") or {}
    if mem_patch.get("changed"):
        for k, v in (mem_patch.get("data") or {}).items():
            out[k] = v
    return out


def desc_id(s: "Server", ck: str) -> str:
    """The desc row's id, looked up fresh.

    A re-read after 반영 rebuilds the card rows, so their ids change - exactly
    as they do for the panel, which re-fetches after every upload. A test that
    cached an id would be asserting against a row that no longer exists.
    """
    st, body = s.get(q("/card", charKey=ck))
    return next(f["id"] for f in body["fields"] if f["field"] == "desc")


def write_back_card(s: "Server", ck: str, card: dict) -> dict:
    """The same, for the card half."""
    st, p = s.get(q("/card/patch", charKey=ck))
    assert st == 200, p
    out = json.loads(json.dumps(card))
    for f in p.get("fields") or []:
        out[f["field"]] = f["after"]
    for key in ("alternateGreetings", "globalLore", "customscript", "triggerscript"):
        block = p.get(key) or {}
        if block.get("changed"):
            out[key] = block.get("list") or []
    assets = p.get("assets") or {}
    if assets.get("changed"):
        for key in ("emotionImages", "additionalAssets", "ccAssets"):
            out[key] = assets.get(key) or []
    return out


# --- tests ------------------------------------------------------------------

def test_dispatcher(s: Server) -> None:
    print("test_dispatcher")
    st, body = s.get("/health", token=None)
    check("/health needs no token", st == 200 and body.get("service") == "risu-hina", str(body)[:120])
    # The connect probe is a POST, because a CDN in front of the backend will
    # answer a GET from its cache and never pass it on: a cached error page on
    # GET /health left one deployment unable to connect for 49 and 79 seconds
    # with nothing reaching this process. Same answer, same exemption.
    st, body = s.post("/health", {}, token=None)
    check("/health answers POST too, without a token",
          st == 200 and body.get("service") == "risu-hina", f"{st} {str(body)[:120]}")
    st, raw, headers = s.post_bytes("/health", {})
    lower = {k.lower(): v for k, v in headers.items()}
    check("and no reply may be cached by an intermediary",
          "no-store" in lower.get("cache-control", ""), str(lower.get("cache-control")))
    st, body = s.get("/nope", token=None)
    check("unknown route is 404 even without a token", st == 404, f"{st} {body}")
    st, body = s.get("/turns", token=None)
    check("known route without a token is 401", st == 401, f"{st} {body}")
    check("401 does not leak the token", "token" not in json.dumps(body).lower(), str(body))
    st, _ = s.get("/turns", token="wrong")
    check("wrong token is 401", st == 401, str(st))
    st, body = s.post("/workspace", {"charId": "x", "chat": {"message": "nope"}})
    check("bad payload is 400 not 500", st == 400, f"{st} {body}")


def test_multi_chat_workspace(s: Server) -> dict:
    print("test_multi_chat_workspace")
    st, body = s.post("/workspace", payload([
        make_chat("chatA", "플레이스루 A", 8),
        make_chat("chatB", "플레이스루 B", 6, place="폐허"),
    ]))
    check("materialise returns 200", st == 200, f"{st} {str(body)[:200]}")
    ws = body.get("workspace") or {}
    check("workspace is character-scoped", bool(ws.get("charKey")), str(ws)[:160])
    check("both chats ingested", len(ws.get("chats") or []) == 2, str(ws.get("chats"))[:200])
    check("turn totals add up", ws.get("totalTurns") == 14, str(ws.get("totalTurns")))
    check("existing lore counted", (ws.get("loreCounts") or {}).get("global") == 1, str(ws.get("loreCounts")))
    return ws


def test_small_job_edit_and_patch(s: Server, ws: dict) -> None:
    print("test_small_job_edit_and_patch")
    a = ws["chats"][0]["chatKey"]
    st, body = s.get(f"/turns?chatKey={a}")
    check("turns listed", st == 200 and body.get("total") == 8, f"{st} {str(body)[:160]}")
    check("addressed by msgId", body["turns"][0]["msgId"] == "chatA-m0", str(body["turns"][0])[:120])

    st, _ = s.post("/turn", {"chatKey": a, "msgId": "chatA-m1",
                             "before": "턴 1: 페데리코는 신전에 있다.", "after": "턴 1: 페데리코는 폐허에 있다."})
    check("edit accepted", st == 200, str(st))

    st, body = s.get(f"/turns?chatKey={a}")
    t1 = next(t for t in body["turns"] if t["msgId"] == "chatA-m1")
    check("edited body stored", t1["body"] == "턴 1: 페데리코는 폐허에 있다.", t1["body"])
    check("flagged changed", t1["changed"] is True)
    check("original retained for diffing", "신전" in (t1["original"] or ""), str(t1["original"]))
    check("no other turn flagged", sum(1 for t in body["turns"] if t["changed"]) == 1)

    st, body = s.post("/turn", {"chatKey": a, "msgId": "chatA-m1",
                                "before": "턴 1: 페데리코는 신전에 있다.", "after": "x"})
    check("stale before is 409", st == 409, f"{st} {body}")

    st, body = s.get(f"/patch?chatKey={a}")
    check("patch has exactly one edit", len(body.get("edits") or []) == 1, str(body)[:200])
    check("patch is not structural", body.get("structural") is False)
    check("patch carries before", body["edits"][0]["before"].endswith("신전에 있다."), str(body["edits"][0]))


def test_medium_job_bulk_across_turns(s: Server, ws: dict) -> None:
    """The real medium-sized job: one edit spanning many turns of one chat."""
    print("test_medium_job_bulk_across_turns")
    a = ws["chats"][0]["chatKey"]

    st, body = s.post("/turn/bulk", {"chatKey": a, "pattern": "페데리코", "replacement": "페데리꼬"})
    check("dry run is the default", st == 200 and body.get("dryRun") is True, f"{st} {str(body)[:160]}")
    check("preview finds every turn", body.get("matchedTurns") == 8, str(body.get("matchedTurns")))
    check("preview carries before and after",
          all("before" in c and "after" in c for c in body.get("changes") or []))

    st, body = s.get(q("/turns", chatKey=a))
    check("dry run changed nothing", not any("페데리꼬" in t["body"] for t in body["turns"]))

    st, body = s.post("/turn/bulk", {"chatKey": a, "pattern": "페데리코",
                                     "replacement": "페데리꼬", "fromSeq": 2, "toSeq": 5})
    check("range scoping narrows the match", body.get("matchedTurns") == 4, str(body.get("matchedTurns")))

    st, body = s.post("/turn/bulk", {"chatKey": a, "pattern": "페데리코",
                                     "replacement": "페데리꼬", "role": "user"})
    check("role scoping narrows the match", body.get("matchedTurns") == 4, str(body.get("matchedTurns")))

    st, body = s.post("/turn/bulk", {"chatKey": a, "pattern": r"턴 (\d+):",
                                     "replacement": r"TURN \1:", "regex": True, "apply": True})
    check("regex apply writes", st == 200 and body.get("applied") == 8, f"{st} {str(body)[:160]}")

    st, body = s.get(q("/turns", chatKey=a))
    check("all turns rewritten", all(t["body"].startswith("TURN ") for t in body["turns"]),
          str([t["body"][:12] for t in body["turns"][:3]]))
    check("every turn is flagged changed", all(t["changed"] for t in body["turns"]))

    st, body = s.post("/turn/bulk", {"chatKey": a, "pattern": "([", "regex": True, "replacement": "x"})
    check("bad regex is 400 not 500", st == 400, f"{st} {body}")

    # A staged batch lands through bulk-set, and a stale one must not half-apply.
    st, body = s.post("/turn/bulk-set", {"chatKey": a, "edits": [
        {"msgId": "chatA-m0", "before": "틀린 원본", "after": "무시되어야 함"},
        {"msgId": "chatA-m1", "after": "이것도 무시되어야 함"},
    ]})
    check("stale batch is rejected whole", st == 409, f"{st} {str(body)[:160]}")
    st, body = s.get(q("/turns", chatKey=a))
    check("nothing from the rejected batch landed",
          not any("무시되어야" in t["body"] for t in body["turns"]))

    s.post("/reset", {"chatKey": a})


def test_medium_job_cross_chat_search(s: Server, ws: dict) -> None:
    print("test_medium_job_cross_chat_search")
    ck = ws["charKey"]
    st, body = s.get(q("/search", charKey=ck, **{"q": "페데리코"}))
    check("search returns 200", st == 200, f"{st} {str(body)[:160]}")
    hits = body.get("hits") or []
    keys = {h["chatKey"] for h in hits}
    check("hits span both chats", len(keys) == 2, str(keys))
    check("hits carry msgId for targeting", all(h.get("msgId") for h in hits), str(hits[:2]))
    check("hits carry an excerpt", all(h.get("excerpt") for h in hits), str(hits[:1]))

    # Two syllables: below the trigram floor, so this only works if the LIKE
    # fallback is wired. This is the Korean case that matters.
    st, body = s.get(q("/search", charKey=ck, **{"q": "폐허"}))
    check("2-syllable Korean term still matches (LIKE fallback)",
          len(body.get("hits") or []) > 0, str(body)[:200])

    a = ws["chats"][0]["chatKey"]
    st, body = s.get(q("/search", charKey=ck, chatKeys=a, **{"q": "페데리코"}))
    check("scoping to one chat works",
          {h["chatKey"] for h in body.get("hits") or []} == {a}, str(body)[:160])


def test_large_job_lore_then_truncate(s: Server, ws: dict) -> None:
    """The 'summary chat migration' job, end to end."""
    print("test_large_job_lore_then_truncate")
    ck, b = ws["charKey"], ws["chats"][1]["chatKey"]

    st, body = s.post("/lore", {"charKey": ck, "scope": "global",
                                "entry": {"key": ["페데리코"], "content": "요약: 페데리코는 폐허에 갇혀 있었다."}})
    check("lore entry added", st == 200 and body.get("id"), f"{st} {body}")

    st, body = s.get(f"/lore?charKey={ck}")
    check("lore lists original plus added", len(body.get("lore") or []) == 2, str(body)[:200])

    st, body = s.get(f"/lore/patch?charKey={ck}")
    check("lore patch returns globalLore array", len(body.get("globalLore") or []) == 2, str(body)[:200])
    check("lore patch counts what we added", body.get("added") == 1, str(body.get("added")))

    st, body = s.post("/turn/delete", {"chatKey": b, "fromSeq": 0, "toSeq": 3})
    check("range delete removes 4 turns", st == 200 and body.get("deleted") == 4, f"{st} {body}")

    st, body = s.get(f"/turns?chatKey={b}")
    check("chat is shorter", body.get("total") == 2, str(body.get("total")))
    check("seq was renumbered densely", [t["seq"] for t in body["turns"]] == [0, 1],
          str([t["seq"] for t in body["turns"]]))

    st, body = s.get(f"/patch?chatKey={b}")
    check("patch reports structural", body.get("structural") is True, str(body)[:160])
    check("structural patch carries the full message array",
          isinstance(body.get("messages"), list) and len(body["messages"]) == 2,
          str(body.get("messages"))[:160])
    check("removed turns are listed", len(body.get("removed") or []) == 4, str(len(body.get("removed") or [])))
    # Cutting turns orphans hypa summaries that cite them. Silent is not an option.
    check("hypa orphan warning is raised",
          any("hypa" in w.lower() for w in body.get("warnings") or []), str(body.get("warnings")))


def test_structural_ops(s: Server, ws: dict) -> None:
    print("test_structural_ops")
    a = ws["chats"][0]["chatKey"]

    st, body = s.post("/turn/insert", {"chatKey": a, "afterMsgId": "chatA-m0",
                                       "role": "char", "body": "삽입된 턴"})
    new_id = body.get("msgId")
    check("insert returns a new msgId", st == 200 and bool(new_id), f"{st} {body}")

    st, body = s.get(f"/turns?chatKey={a}")
    ids = [t["msgId"] for t in body["turns"]]
    check("inserted right after the anchor", ids[1] == new_id, str(ids[:3]))
    check("total grew by one", body["total"] == 9, str(body["total"]))
    check("inserted turn is marked new", next(t for t in body["turns"] if t["msgId"] == new_id)["isNew"])

    st, body = s.post("/turn/split", {"chatKey": a, "msgId": "chatA-m2", "at": 4})
    check("split returns the new msgId", st == 200 and body.get("newMsgId"), f"{st} {body}")

    st, body = s.post("/turn/merge", {"chatKey": a, "msgIds": ["chatA-m2", body["newMsgId"]]})
    check("merge keeps the first turn's identity", body.get("msgId") == "chatA-m2", str(body))

    st, body = s.get(f"/turns?chatKey={a}")
    t2 = next(t for t in body["turns"] if t["msgId"] == "chatA-m2")
    check("split+merge restores the body", t2["body"].replace("\n\n", "") == "턴 2: 페데리코는 어디 있지?",
          repr(t2["body"]))

    st, _ = s.post("/turn/delete", {"chatKey": a, "msgIds": [new_id]})
    check("delete by msgId works", st == 200)


def test_export_preserves_foreign_fields(s: Server, ws: dict) -> None:
    print("test_export_preserves_foreign_fields")
    a = ws["chats"][0]["chatKey"]
    # Make our own edit rather than relying on one an earlier test left behind:
    # the bulk test resets this chat, and a test that silently depends on
    # another's leftovers fails for reasons that have nothing to do with export.
    s.post("/turn", {"chatKey": a, "msgId": "chatA-m1", "after": "턴 1: 페데리코는 폐허에 있다."})

    st, body = s.get(f"/export/risuchat?chatKey={a}")
    check("export returns 200", st == 200, f"{st} {str(body)[:120]}")
    env = body.get("envelope") or {}
    check("stock importer shape", env.get("type") == "risuChat" and env.get("ver") == 2, str(env)[:120])
    data = env.get("data") or {}
    check("another plugin's arKey survived", data.get("arKey") == "someone-elses-stamp")
    check("PocketRisu modelBinding survived", data.get("modelBinding") == {"provider": "p"})
    check("edit is present in the export",
          any("폐허" in str(m.get("data")) for m in data.get("message") or []))
    st, body = s.get(f"/export/md?chatKey={a}")
    check("markdown export returns 200", st == 200 and "markdown" in body, str(st))


def test_checkpoint_restore(s: Server, ws: dict) -> None:
    print("test_checkpoint_restore")
    a = ws["chats"][0]["chatKey"]
    st, body = s.post("/checkpoint", {"chatKey": a, "label": "before"})
    cid = body.get("id")
    check("checkpoint created", st == 200 and bool(cid), f"{st} {body}")

    s.post("/turn", {"chatKey": a, "msgId": "chatA-m4", "after": "또 고침"})
    st, body = s.post("/checkpoint/restore", {"chatKey": a, "id": cid})
    check("restore returns 200", st == 200, f"{st} {body}")

    st, body = s.get(f"/turns?chatKey={a}")
    t4 = next(t for t in body["turns"] if t["msgId"] == "chatA-m4")
    check("restored turn reverted", "또 고침" not in t4["body"], t4["body"])
    st, body = s.get(f"/checkpoints?chatKey={a}")
    check("restore is itself undoable", len(body.get("checkpoints") or []) >= 2, str(len(body.get("checkpoints") or [])))

    # A snapshot's label is the one thing about it the user may change.
    st, _ = s.post("/checkpoint/rename", {"chatKey": a, "id": cid, "label": "3장 시작 전"})
    check("checkpoint renamed", st == 200, str(st))
    st, body = s.get(f"/checkpoints?chatKey={a}")
    check("the new label is listed",
          any(c.get("id") == cid and c.get("label") == "3장 시작 전" for c in body.get("checkpoints") or []))
    st, _ = s.post("/checkpoint/rename", {"chatKey": a, "id": cid, "label": "   "})
    check("a blank label is refused", st == 400, str(st))
    st, _ = s.post("/checkpoint/rename", {"chatKey": a, "id": "nope", "label": "x"})
    check("an unknown snapshot is 404", st == 404, str(st))

    # Delete one, then clear down to the newest N, then all.
    for n in range(3):
        s.post("/checkpoint", {"chatKey": a, "label": f"extra {n}"})
    st, body = s.get(f"/checkpoints?chatKey={a}")
    # clear() works on what the user saved; the restore's own 'restore 직전'
    # row is an automatic backup and stays out of both the count and the sweep.
    total = len([c for c in body.get("checkpoints") or [] if c.get("kind") != "auto"])
    check("several snapshots exist", total >= 4, str(total))
    st, _ = s.post("/checkpoint/delete", {"chatKey": a, "id": cid})
    check("one snapshot deleted", st == 200, str(st))
    st, body = s.get(f"/checkpoints?chatKey={a}")
    check("it is gone", all(c.get("id") != cid for c in body.get("checkpoints") or []))
    st, body = s.post("/checkpoint/clear", {"chatKey": a, "keep": 2})
    check("clear keeps the newest two saved ones", st == 200 and body.get("deleted") == total - 1 - 2, str(body))
    st, body = s.get(f"/checkpoints?chatKey={a}")
    left = [c for c in body.get("checkpoints") or [] if c.get("kind") != "auto"]
    check("two remain, newest first", len(left) == 2 and left[0]["created_at"] >= left[1]["created_at"], str(len(left)))
    st, body = s.post("/checkpoint/clear", {"chatKey": a, "keep": 0})
    remaining = [c for c in s.get(f"/checkpoints?chatKey={a}")[1].get("checkpoints") or []
                 if c.get("kind") != "auto"]
    check("clear all clears the saved ones (auto backups stay, they self-prune)",
          st == 200 and body.get("deleted") == 2 and not remaining, str(body))


def test_reopen_merges_risu_changes(s: Server) -> None:
    """The reported bug, encoded: RisuAI moves while the panel is closed.

    Before the three-way merge the baseline was refreshed and the working copy
    was not, so a turn nobody had touched came back as "edited here" with its
    diff inverted, and every message generated since the last open was
    classified `removed` - which the write-back then applied. Each check below
    fails on the old behaviour.
    """
    print("test_reopen_merges_risu_changes")

    def chat(bodies: list[str]) -> dict:
        return {"id": "mrg", "name": "병합", "note": "", "localLore": [], "fmIndex": 0,
                "message": [{"role": "user" if i % 2 == 0 else "char", "data": b,
                             "time": 1778892822492 + i, "chatId": f"mrg-m{i}"}
                            for i, b in enumerate(bodies)]}

    def up(c: dict, **extra) -> dict:
        st, body = s.post("/workspace", {**payload([c]), "charId": "cha-merge",
                                         "card": {"name": "병합 봇", "chaId": "cha-merge",
                                                  "desc": "설명", "globalLore": []}, **extra})
        assert st == 200, body
        return (body.get("workspace") or {})

    ws = up(chat(["턴 0", "턴 1", "턴 2"]))
    tk = ws["chats"][0]["chatKey"]
    s.post("/turn", {"chatKey": tk, "msgId": "mrg-m1", "after": "내가 고침"})

    # RisuAI: turn 0 edited, two turns generated, turn 1 untouched.
    ws = up(chat(["RisuAI가 고침", "턴 1", "턴 2", "턴 3", "턴 4"]))
    st, body = s.get(q("/turns", chatKey=tk))
    by = {t["msgId"]: t for t in body["turns"]}
    check("an untouched turn follows RisuAI instead of reading as our edit",
          by["mrg-m0"]["body"] == "RisuAI가 고침" and not by["mrg-m0"]["changed"], str(by["mrg-m0"])[:160])
    check("our own edit is kept and still marked",
          by["mrg-m1"]["body"] == "내가 고침" and by["mrg-m1"]["changed"], str(by["mrg-m1"])[:160])
    check("turns generated since the last open are absorbed",
          body["total"] == 5 and "mrg-m4" in by, str(sorted(by))[:160])
    st, p = s.get(q("/patch", chatKey=tk))
    check("and are not reported as removals",
          not p["removed"] and not p["structural"] and len(p["edits"]) == 1, str(p)[:200])

    # Both sides move the same turn: a conflict, ours kept, theirs recorded.
    ws = up(chat(["RisuAI가 고침", "RisuAI도 고침", "턴 2", "턴 3", "턴 4"]))
    st, body = s.get(q("/turns", chatKey=tk))
    t1 = next(t for t in body["turns"] if t["msgId"] == "mrg-m1")
    check("a turn both sides changed is a conflict, not a silent revert",
          t1["body"] == "내가 고침" and (t1.get("conflict") or {}).get("kind") == "both-moved",
          str(t1)[:200])
    st, ch = s.get(q("/changes", chatKey=tk))
    check("the chat reports its conflicts", ch.get("conflicts") == 1, str(ch)[:200])
    st, body = s.get(q("/conflicts", chatKey=tk))
    c = (body.get("conflicts") or [{}])[0]
    check("and the list shows both sides",
          body.get("total") == 1 and c.get("mine") == "내가 고침" and c.get("theirs") == "RisuAI도 고침",
          str(body)[:250])

    st, body = s.post("/conflict/resolve", {"kind": "turn", "id": c["id"], "choice": "theirs"})
    check("taking RisuAI's copy resolves it", st == 200 and body.get("ok"), str(body)[:160])
    st, body = s.get(q("/turns", chatKey=tk))
    t1 = next(t for t in body["turns"] if t["msgId"] == "mrg-m1")
    check("the turn now holds RisuAI's text with no diff left",
          t1["body"] == "RisuAI도 고침" and not t1["changed"] and not t1.get("conflict"), str(t1)[:160])
    st, ch = s.get(q("/changes", chatKey=tk))
    check("nothing pending after the conflict was decided", ch["total"] == 0 and ch["conflicts"] == 0, str(ch)[:200])

    # An agent that deleted every working turn must not be reset by the next
    # open: the baseline is still there, so the merge honours the deletion.
    # (The schema-12 upgrade empties both tables, and that DOES load fresh -
    # otherwise the first open after an upgrade reports every turn as new.)
    st, body = s.get(q("/turns", chatKey=tk))
    s.post("/turn/delete", {"chatKey": tk, "msgIds": [t["msgId"] for t in body["turns"]]})
    ws = up(chat(["RisuAI가 고침", "RisuAI도 고침", "턴 2", "턴 3", "턴 4"]))
    check("deleting every turn here is not undone by the next open",
          ws["chats"][0]["turns"] == 0 and ws["chats"][0]["workingReset"] is False,
          str(ws["chats"][0])[:200])
    up(chat(["RisuAI가 고침", "RisuAI도 고침", "턴 2", "턴 3", "턴 4"]), force=True)

    # A turn deleted in RisuAI, untouched here, must not come back.
    ws = up(chat(["RisuAI가 고침", "RisuAI도 고침", "턴 3", "턴 4"]))
    st, body = s.get(q("/turns", chatKey=tk))
    check("a turn deleted in RisuAI does not reappear",
          body["total"] == 4 and not any(t["body"] == "턴 2" for t in body["turns"]),
          str([t["body"] for t in body["turns"]])[:160])


def test_reopen_merges_card_and_lore(s: Server) -> None:
    """The same rule for the bot half, where the lorebook used not to be
    re-read at all - a manual RisuAI edit was invisible and the first
    write-back replaced it with the stale copy."""
    print("test_reopen_merges_card_and_lore")

    def lore(comment: str, content: str) -> dict:
        return {"key": [comment], "comment": comment, "content": content}

    def card(desc: str, entries: list[dict], greetings: list[str]) -> dict:
        return {"name": "병합 봇2", "chaId": "cha-merge2", "desc": desc,
                "firstMessage": "첫 인사", "alternateGreetings": greetings,
                "globalLore": entries}

    G = [lore("왕국", "본문 A"), lore("기사단", "본문 B")]

    def up(c: dict, **extra) -> dict:
        st, body = s.post("/workspace", {**payload([make_chat("mc", "챗", 2)]),
                                         "charId": "cha-merge2", "cardFull": True,
                                         "card": c, **extra})
        assert st == 200, body
        return (body.get("workspace") or {})

    ws = up(card("설명", G, ["인사 1", "인사 2"]))
    ck = ws["charKey"]
    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    mine = next(e for e in body["lore"] if e["entry"]["comment"] == "기사단")
    s.post("/lore/update", {"charKey": ck, "id": mine["id"], "entry": {**mine["entry"], "content": "내가 고침"}})

    # RisuAI: 왕국 rewritten, a new entry inserted at the head, desc changed,
    # a greeting inserted at the front (which used to shift every row).
    G2 = [lore("새 항목", "본문 Z"), lore("왕국", "RisuAI가 고침"), G[1]]
    up(card("RisuAI 설명", G2, ["새 인사", "인사 1", "인사 2"]))

    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    by = {e["entry"]["comment"]: e for e in body["lore"]}
    check("a lorebook entry edited in RisuAI is picked up",
          by["왕국"]["entry"]["content"] == "RisuAI가 고침", str(by.get("왕국"))[:160])
    check("my lorebook edit survives", by["기사단"]["entry"]["content"] == "내가 고침")
    check("an entry added in RisuAI arrives", "새 항목" in by, str(sorted(by)))

    st, body = s.get(q("/card", charKey=ck))
    fields = {f["field"]: f for f in body["fields"] if f["field"] == "desc"}
    check("a card field edited in RisuAI is adopted, not shown as our edit",
          fields["desc"]["body"] == "RisuAI 설명" and not fields["desc"]["changed"], str(fields["desc"])[:160])
    greets = [f["body"] for f in body["fields"] if f["field"] == "alternateGreetings"]
    check("an inserted greeting does not shift the others",
          greets == ["인사 1", "인사 2", "새 인사"] or greets == ["새 인사", "인사 1", "인사 2"], str(greets))

    st, body = s.get(q("/card/changes", charKey=ck))
    check("RisuAI's own changes do not become pending ones",
          body.get("fields") == 0 and (body.get("greetings") or {}).get("total") == 0
          # The one pending item is the lorebook entry this test edited here.
          and (body.get("lore") or {}).get("total") == 1 and body.get("total") == 1,
          str(body)[:250])

    # Both sides edit the same entry.
    G3 = [G2[0], G2[1], lore("기사단", "RisuAI도 고침")]
    up(card("RisuAI 설명", G3, ["새 인사", "인사 1", "인사 2"]))
    st, body = s.get(q("/conflicts", charKey=ck))
    c = (body.get("conflicts") or [{}])[0]
    check("the lorebook conflict is listed with both sides",
          body.get("total") == 1 and c.get("kind") == "lore"
          and (c.get("mine") or {}).get("content") == "내가 고침"
          and (c.get("theirs") or {}).get("content") == "RisuAI도 고침", str(body)[:250])
    st, body = s.post("/conflict/resolve", {"kind": "lore", "id": c["id"], "choice": "mine"})
    check("keeping mine clears the conflict", st == 200, str(body)[:160])
    st, body = s.get(q("/card/changes", charKey=ck))
    check("and leaves it as an ordinary pending edit",
          body.get("conflicts") == 0 and (body.get("lore") or {}).get("total") == 1, str(body)[:200])


def test_reopen_keeps_pending_edits(s: Server, ws: dict) -> None:
    print("test_reopen_keeps_pending_edits")
    a = ws["chats"][0]["chatKey"]
    s.post("/turn", {"chatKey": a, "msgId": "chatA-m6", "after": "작업 중"})
    st, body = s.post("/workspace", payload([make_chat("chatA", "플레이스루 A", 8),
                                             make_chat("chatB", "플레이스루 B", 6, place="폐허")]))
    check("re-materialise returns 200", st == 200, str(st))
    check("working turns were not reset",
          all(c["workingReset"] is False for c in (body.get("workspace") or {}).get("chats") or []),
          str((body.get("workspace") or {}).get("chats")))
    st, body = s.get(f"/turns?chatKey={a}")
    t6 = next(t for t in body["turns"] if t["msgId"] == "chatA-m6")
    check("pending edit survived re-open", t6["body"] == "작업 중", t6["body"])

    st, body = s.post("/workspace", {**payload([make_chat("chatA", "플레이스루 A", 8)]), "force": True})
    check("force resets", all(c["workingReset"] is True for c in (body.get("workspace") or {}).get("chats") or []))
    st, body = s.get(f"/turns?chatKey={a}")
    check("forced reset cleared edits", not any(t["changed"] for t in body["turns"]))


def test_agent_readiness_is_consistent(s: Server, ws: dict) -> None:
    """/session and /health must agree about whether the agent is configured.

    They did not: /session returned early when no session existed yet and that
    branch omitted `agentReady` entirely, so the panel read undefined as false
    and announced "credentials not configured" on every first open - while the
    settings tab's test passed, because it asked a different endpoint.
    """
    print("test_agent_readiness_is_consistent")
    a = ws["chats"][0]["chatKey"]

    st, health = s.get("/health")
    check("health reports readiness", st == 200 and "agentReady" in health, str(health)[:160])

    # No session has been created for this chat yet - the exact case that broke.
    st, sess = s.get(q("/session", chatKey=a))
    check("session returns 200 with no session yet", st == 200, f"{st} {str(sess)[:160]}")
    check("session reports readiness even with no session",
          "agentReady" in sess, str(sess)[:200])
    check("the two endpoints agree",
          sess.get("agentReady") == health.get("agentReady"),
          f"session={sess.get('agentReady')} health={health.get('agentReady')}")
    check("shape is complete without a session",
          sess.get("session") is None and sess.get("messages") == [] and "staged" in sess,
          str(sess)[:200])
    check("websearch flag present", "webSearch" in sess, str(sess)[:160])

    st, body = s.post("/session", {"chatKey": a, "title": "t"})
    check("session can be created", st == 200 and body.get("sessionId"), f"{st} {body}")

    st, sess2 = s.get(q("/session", chatKey=a))
    check("readiness unchanged once a session exists",
          sess2.get("agentReady") == health.get("agentReady"),
          f"{sess2.get('agentReady')} vs {health.get('agentReady')}")
    check("staged list is present", isinstance(sess2.get("staged"), list))


def test_agent_output_budget(s: Server, ws: dict) -> None:
    """The output budget must be big enough for a reasoning model to answer.

    8000 was the first-run template's value and it made the agent fail with
    "token limit exceeded before any response was generated" - the thinking
    tokens came out of the same budget. The default has to clear that, and a
    stored copy of the old default must be migrated rather than left to fail.
    """
    print("test_agent_output_budget")
    st, body = s.get("/config")
    agent = (body.get("config") or {}).get("agent") or {}

    # `maxTokens` is not a secret. A substring rule on "token" once redacted it
    # to {set, length}, which made it unreadable and unsettable from the UI.
    check("maxTokens is not redacted", not isinstance(agent.get("maxTokens"), dict),
          str(agent.get("maxTokens")))
    check("apiKey still is redacted", isinstance(agent.get("apiKey"), dict),
          str(agent.get("apiKey")))
    check("temperature is visible", not isinstance(agent.get("temperature"), dict))

    mt = int(agent.get("maxTokens") or 0)
    check("output budget clears a reasoning model's needs", mt >= 32000, str(mt))

    # It stays editable: an operator with a cheaper model may want it lower.
    st, _ = s.post("/config", {"config": {"agent": {"maxTokens": 12345}}})
    check("maxTokens is settable", st == 200, str(st))
    st, body = s.get("/config")
    check("the setting round-trips",
          int(((body.get("config") or {}).get("agent") or {}).get("maxTokens") or 0) == 12345,
          str(body.get("config", {}).get("agent")))
    s.post("/config", {"config": {"agent": {"maxTokens": mt}}})


def test_memory_as_rows(s: Server, ws: dict) -> None:
    """The hypa summaries are rows, and re-opening must not discard edits.

    The panel re-uploads the whole workspace every time it opens. Turns already
    survive that; memory has to survive it the same way, or an edit made and not
    yet written back would vanish on the next open with no error anywhere.
    """
    print("test_memory_as_rows")
    a = ws["chats"][0]["chatKey"]

    st, body = s.get(q("/memory", chatKey=a))
    check("memory endpoint answers", st == 200, str(st))
    items = body.get("items") or []
    check("the summary was taken apart into rows", len(items) >= 1, str(len(items)))
    first = items[0] if items else {}
    check("an entry carries its scheme", first.get("kind") == "hypaV3Data", str(first.get("kind")))
    check("and starts unedited", first.get("changed") is False, str(first))

    st, body = s.post("/memory/update", {"chatKey": a, "id": first["id"], "body": "고친 요약입니다."})
    check("an entry can be edited", st == 200, str(body)[:160])
    st, body = s.get(q("/memory", chatKey=a))
    edited = [i for i in body["items"] if i["id"] == first["id"]][0]
    check("the edit is marked", edited["changed"] is True, str(edited)[:200])
    check("the original is kept", edited["original"] != edited["body"], str(edited)[:200])

    # Re-upload, exactly as re-opening the panel does.
    s.post("/workspace", payload([
        make_chat("chatA", "플레이스루 A", 8),
        make_chat("chatB", "플레이스루 B", 6, place="폐허"),
    ]))
    st, body = s.get(q("/memory", chatKey=a))
    kept = [i for i in body["items"] if i["id"] == first["id"]]
    check("the edit survives a re-upload", len(kept) == 1 and kept[0]["body"] == "고친 요약입니다.",
          str(kept)[:200])

    # The patch has to put the structure back, extras included.
    st, patch = s.get(q("/memory/patch", chatKey=a))
    check("the patch rebuilds the scheme", "hypaV3Data" in (patch.get("memory") or {}),
          str(patch.get("memory"))[:200])
    summaries = ((patch.get("memory") or {}).get("hypaV3Data") or {}).get("summaries") or []
    check("the edited text is in it", any("고친 요약" in str(x.get("text")) for x in summaries),
          str(summaries)[:200])
    # chatMemos is the link from a summary to the turns it summarises. Losing it
    # is invisible until the next generation reads the wrong thing.
    check("chatMemos rode along", any(x.get("chatMemos") for x in summaries),
          str(summaries)[:250])

    st, _ = s.post("/memory/commit", {"chatKey": a})
    st, body = s.get(q("/memory", chatKey=a))
    after = [i for i in body["items"] if i["id"] == first["id"]][0]
    check("committing moves the baseline", after["changed"] is False, str(after)[:200])

    st, body = s.post("/memory/add", {"chatKey": a, "kind": "hypaV3Data", "body": "새로 넣은 기억"})
    made = body.get("item") or {}
    check("an entry can be added", st == 200 and made.get("isNew") is True, str(body)[:200])
    st, _ = s.post("/memory/delete", {"chatKey": a, "id": made["id"]})
    check("and deleted", st == 200, str(st))
    st, _ = s.post("/memory/update", {"chatKey": a, "id": "nope", "body": "x"})
    check("editing a missing entry is 404", st == 404, str(st))


def test_lore_editing(s: Server, ws: dict) -> None:
    """Lorebook entries are editable, and an entry is replaced whole."""
    print("test_lore_editing")
    ck = ws["charKey"]
    st, body = s.get(q("/lore", charKey=ck))
    entries = body.get("lore") or []
    check("lore is listed", len(entries) >= 1, str(len(entries)))
    target = entries[0]
    check("it starts as original", target["origin"] == "original", str(target)[:160])

    entry = dict(target["entry"])
    entry["content"] = "고친 로어 내용"
    st, _ = s.post("/lore/update", {"charKey": ck, "id": target["id"], "entry": entry})
    check("an entry can be edited", st == 200, str(st))

    st, body = s.get(q("/lore/get", charKey=ck, id=target["id"]))
    check("the edit round-trips", body["entry"]["content"] == "고친 로어 내용", str(body)[:200])
    check("and it is marked as edited", body["origin"] == "edited", str(body)[:160])
    # Fields we do not model must survive - a merge that knew only our fields
    # would drop them.
    for k, v in (target["entry"] or {}).items():
        if k == "content":
            continue
        check(f"unmodelled field {k} survived", body["entry"].get(k) == v, str(body["entry"])[:200])
        break

    st, _ = s.post("/lore/update", {"charKey": ck, "id": "nope", "entry": {}})
    check("editing a missing entry is 404", st == 404, str(st))


def test_unified_writeback(s: Server, ws: dict) -> None:
    """Turns, this chat's lorebook and its memory follow one shape.

    Working copy against a baseline, one /patch that carries all three, one
    /commit that moves all three baselines, one checkpoint that holds all
    three. The lorebook used to have none of this: an edit was saved to a
    table nothing wrote back, and a re-upload put a second copy next to it.
    """
    print("test_unified_writeback")
    ck = ws["charKey"]
    # A chat of its own, with local lore, so the other tests' leftovers on
    # chatA do not bleed into the counts.
    chat = make_chat("chatL", "로어 챗", 6)
    chat["localLore"] = [
        {"key": ["성소"], "comment": "성소", "content": "원래 성소 설명"},
        {"key": ["의식"], "comment": "의식", "content": "원래 의식 설명"},
    ]
    st, body = s.post("/workspace", payload([chat]))
    check("chat with local lore ingested", st == 200, str(st))
    tk = next(c["chatKey"] for c in body["workspace"]["chats"] if c["chatId"] == "chatL")

    st, body = s.get(q("/changes", chatKey=tk))
    check("changes endpoint answers", st == 200, str(st))
    check("a fresh chat has nothing pending", body.get("total") == 0, str(body)[:200])

    st, body = s.get(q("/lore", charKey=ck, scope="local"))
    mine = [e for e in (body.get("lore") or []) if e["chatKey"] == tk]
    check("both local entries are listed for this chat", len(mine) == 2, str(len(mine)))
    first, second = mine

    # Edit one, delete one, add one - and change a turn and a memory too.
    entry = dict(first["entry"]); entry["content"] = "고친 성소 설명"
    s.post("/lore/update", {"charKey": ck, "id": first["id"], "entry": entry})
    s.post("/lore/delete", {"charKey": ck, "id": second["id"]})
    st, body = s.post("/lore", {"charKey": ck, "scope": "local", "chatKey": tk,
                               "entry": {"key": ["새"], "comment": "새 항목", "content": "새로 넣음"}})
    added_id = body.get("id")
    s.post("/turn", {"chatKey": tk, "msgId": "chatL-m1", "after": "고친 턴"})
    st, body = s.get(q("/memory", chatKey=tk))
    m0 = (body.get("items") or [])[0]
    s.post("/memory/update", {"chatKey": tk, "id": m0["id"], "body": "고친 기억"})

    st, body = s.get(q("/lore", charKey=ck, scope="local"))
    mine = [e for e in (body.get("lore") or []) if e["chatKey"] == tk]
    check("the deleted entry is no longer listed", all(e["id"] != second["id"] for e in mine), str(len(mine)))
    check("the added one is", any(e["id"] == added_id for e in mine))
    st, body = s.get(q("/lore/get", charKey=ck, id=second["id"]))
    check("and cannot be fetched", st == 404, str(st))

    st, ch = s.get(q("/changes", chatKey=tk))
    check("turn change counted", ch["turns"]["edited"] == 1, str(ch["turns"]))
    check("lore changes counted by kind",
          (ch["lore"]["added"], ch["lore"]["edited"], ch["lore"]["deleted"]) == (1, 1, 1), str(ch["lore"]))
    check("memory change counted", ch["memory"]["changed"] == 1, str(ch["memory"]))
    check("the total adds up", ch["total"] == 5, str(ch["total"]))

    st, patch = s.get(q("/patch", chatKey=tk))
    check("patch carries the lorebook", isinstance(patch.get("lore"), dict), str(patch.keys()))
    local = patch["lore"]["localLore"]
    check("the write list has edit and add, not the deletion",
          len(local) == 2 and any(e.get("content") == "고친 성소 설명" for e in local)
          and not any(e.get("content") == "원래 의식 설명" for e in local), str(local)[:200])
    check("patch carries the memory", "hypaV3Data" in (patch.get("memory") or {}).get("data", {}),
          str(patch.get("memory"))[:200])
    check("with its count", patch["memory"]["changed"] == 1, str(patch["memory"].get("changed")))

    # Editing back to the baseline is not a change.
    back = dict(first["entry"])
    s.post("/lore/update", {"charKey": ck, "id": first["id"], "entry": back})
    st, body = s.get(q("/lore/get", charKey=ck, id=first["id"]))
    check("an entry edited back to its original is original again", body["origin"] == "original", body["origin"])
    s.post("/lore/update", {"charKey": ck, "id": first["id"], "entry": entry})

    # A checkpoint holds all three; restoring brings all three back.
    st, body = s.post("/checkpoint", {"chatKey": tk, "label": "full"})
    cid = body["id"]
    s.post("/lore/delete", {"charKey": ck, "id": first["id"]})
    s.post("/memory/update", {"chatKey": tk, "id": m0["id"], "body": "또 고친 기억"})
    s.post("/turn", {"chatKey": tk, "msgId": "chatL-m1", "after": "또 고친 턴"})
    st, body = s.post("/checkpoint/restore", {"chatKey": tk, "id": cid})
    check("restore reports lore and memory", body.get("lore") is not None and body.get("memory") is not None, str(body))
    st, body = s.get(q("/lore/get", charKey=ck, id=first["id"]))
    check("the lore entry deleted after the checkpoint is back", st == 200 and body["entry"]["content"] == "고친 성소 설명", f"{st} {str(body)[:120]}")
    st, body = s.get(q("/memory", chatKey=tk))
    m0b = next(i for i in body["items"] if i["id"] == m0["id"])
    check("memory went back to the checkpoint, id kept", m0b["body"] == "고친 기억", m0b["body"])
    st, body = s.get(q("/turns", chatKey=tk))
    t1 = next(t for t in body["turns"] if t["msgId"] == "chatL-m1")
    check("turn went back too", t1["body"] == "고친 턴", t1["body"])

    # Re-opening the panel keeps the working lorebook - no second copy.
    st, body = s.post("/workspace", payload([chat]))
    st, body = s.get(q("/lore", charKey=ck, scope="local"))
    mine = [e for e in (body.get("lore") or []) if e["chatKey"] == tk]
    check("re-upload does not duplicate edited lore", len(mine) == 2, str([e["entry"].get("comment") for e in mine]))
    check("the edit is still there", any(e["entry"].get("content") == "고친 성소 설명" for e in mine))

    # 반영: the host write, then the commit, then the re-read that replaces
    # the working copy with what RisuAI now holds. Keeping a working copy past
    # a successful write is what let it drift again on the next open.
    written = write_back(s, tk, chat)
    st, body = s.post("/commit", {"chatKey": tk, "label": "after write"})
    check("commit reports what shipped", body.get("shipped", 0) >= 1, str(body)[:200])
    st, body = s.post("/workspace", {**payload([written]), "chatReset": True})
    st, ch = s.get(q("/changes", chatKey=tk))
    check("nothing pending after the write-back and re-read", ch["total"] == 0, str(ch)[:200])
    check("and no conflicts either", ch.get("conflicts") == 0, str(ch)[:200])
    st, body = s.get(q("/lore", charKey=ck, scope="local"))
    mine = [e for e in (body.get("lore") or []) if e["chatKey"] == tk]
    check("re-read entries are original", all(e["origin"] == "original" for e in mine), str([e["origin"] for e in mine]))
    check("the committed deletion is gone for good", len(mine) == 2, str(len(mine)))
    check("and the edit survived the round trip",
          any(e["entry"].get("content") == "고친 성소 설명" for e in mine),
          str([e["entry"].get("content") for e in mine])[:200])
    chat = written

    # A forced reload resets the lorebook like everything else.
    s.post("/lore/delete", {"charKey": ck, "id": mine[0]["id"]})
    st, body = s.post("/workspace", {**payload([chat]), "force": True})
    st, body = s.get(q("/lore", charKey=ck, scope="local"))
    mine = [e for e in (body.get("lore") or []) if e["chatKey"] == tk]
    check("force reload restores RisuAI's lorebook", len(mine) == 2 and all(e["origin"] == "original" for e in mine),
          str([(e["origin"], e["entry"].get("content")) for e in mine]))


def test_chat_variables(s: Server, ws: dict) -> None:
    """Chat variables are rows like the summaries - same table, same write-back.

    What has to hold: every key becomes a row addressed by its key, the value's
    type survives the round trip (3 comes back as 3, not "3"), an edit is a
    change the bar can count, and the patch rebuilds scriptstate whole so a
    deleted row is a deleted variable.
    """
    print("test_chat_variables")
    chat = make_chat("chatV", "변수 챗", 4)
    st, body = s.post("/workspace", payload([chat]))
    tk = next(c["chatKey"] for c in body["workspace"]["chats"] if c["chatId"] == "chatV")

    st, body = s.get(q("/memory", chatKey=tk))
    vars_ = [i for i in body["items"] if i["kind"] == "scriptstate"]
    check("each variable is a row", len(vars_) == 4, str([v["title"] for v in vars_]))
    by = {v["title"]: v for v in vars_}
    check("the key is the title", "$affection" in by and "route" in by, str(list(by)))
    check("a number is typed", by["$affection"]["valueType"] == "number" and by["$affection"]["body"] == "3", str(by["$affection"]))
    check("a bool is typed", by["$met"]["valueType"] == "bool", str(by["$met"]))
    check("a list is kept as json", by["tags"]["valueType"] == "json", str(by["tags"]))

    st, patch = s.get(q("/memory/patch", chatKey=tk))
    state = (patch.get("memory") or {}).get("scriptstate")
    check("the patch rebuilds scriptstate", isinstance(state, dict), str(patch)[:200])
    check("with original types", state.get("$affection") == 3 and state.get("$met") is True
          and state.get("tags") == ["x", "y"] and state.get("route") == "A", str(state))
    check("and the summaries still rebuild beside it", "hypaV3Data" in (patch.get("memory") or {}))

    s.post("/memory/update", {"chatKey": tk, "id": by["$affection"]["id"], "body": "7", "title": "renamed"})
    st, body = s.get(q("/memory", chatKey=tk))
    row = next(i for i in body["items"] if i["id"] == by["$affection"]["id"])
    check("a variable keeps its key when edited", row["title"] == "$affection", row["title"])
    check("and is marked changed", row["changed"], str(row))
    st, ch = s.get(q("/changes", chatKey=tk))
    check("the change summary counts variables apart", ch["memory"]["vars"] == 1 and ch["memory"]["changed"] == 0, str(ch["memory"]))

    st, body = s.post("/memory/add", {"chatKey": tk, "kind": "scriptstate", "title": "$new", "body": "hello"})
    check("a variable can be added", st == 200 and body["item"]["title"] == "$new", f"{st} {str(body)[:120]}")
    st, body = s.post("/memory/add", {"chatKey": tk, "kind": "scriptstate", "title": "$new", "body": "again"})
    check("a duplicate key is refused", st == 400, str(st))
    st, _ = s.post("/memory/delete", {"chatKey": tk, "id": by["route"]["id"]})
    st, patch = s.get(q("/memory/patch", chatKey=tk))
    state = patch["memory"]["scriptstate"]
    check("the patch has the edit, the addition, and not the deletion",
          state.get("$affection") == 7 and state.get("$new") == "hello" and "route" not in state, str(state))

    # Re-opening the panel matches variables by key, so the edit survives and
    # a key RisuAI added appears.
    chat["scriptstate"]["$late"] = "z"
    s.post("/workspace", payload([chat]))
    st, body = s.get(q("/memory", chatKey=tk))
    vars_ = {i["title"]: i for i in body["items"] if i["kind"] == "scriptstate"}
    check("the edit survived a re-open", vars_["$affection"]["body"] == "7", str(vars_.get("$affection")))
    check("a key added in RisuAI appeared", "$late" in vars_, str(list(vars_)))

    # A chat without variables must not gain an empty scriptstate.
    plain = make_chat("chatP", "변수 없음", 2)
    plain.pop("scriptstate")
    st, body = s.post("/workspace", payload([plain]))
    tk2 = next(c["chatKey"] for c in body["workspace"]["chats"] if c["chatId"] == "chatP")
    st, patch = s.get(q("/memory/patch", chatKey=tk2))
    check("no scriptstate is invented", "scriptstate" not in (patch.get("memory") or {}), str(patch.get("memory"))[:120])


def test_action_queue(s: Server, ws: dict) -> None:
    """The queue's HTTP surface.

    Proposing is deliberately not an HTTP route - only an agent tool creates a
    row - so what this file can check is the shape around it: the queue starts
    empty, a decision on something that is not there is refused, and clearing
    works. The propose -> approve -> execute round trip needs the module layer
    and lives in test_sandbox.py.
    """
    print("test_action_queue")
    a = ws["chats"][0]["chatKey"]

    st, body = s.get(q("/actions", chatKey=a))
    check("the queue is readable", st == 200, str(st))
    check("and starts empty", not body.get("actions"), str(body)[:160])

    st, body = s.post("/actions/decide", {"chatKey": a, "id": "nope", "approve": True})
    check("deciding a missing action is refused", st == 400, str(st))
    check("and says so in Korean", "없는" in str(body.get("error") or ""), str(body)[:160])

    st, body = s.post("/actions/complete", {"chatKey": a, "id": "nope", "ok": True})
    check("completing a missing action is 404", st == 404, str(st))

    st, body = s.post("/actions/clear", {"chatKey": a})
    check("the queue can be cleared", st == 200, str(body)[:120])

    # §1-38: the bot-wide listing and clear the "제안 N 대기" chip uses.
    ck = str(ws.get("charKey") or "")
    st, body = s.get(q("/actions", charKey=ck))
    check("the bot-wide queue is readable", st == 200 and isinstance(body.get("actions"), list), str(body)[:120])
    st, body = s.post("/actions/clear", {"charKey": ck})
    check("and can be rejected wholesale", st == 200 and body.get("cleared") == 0, str(body)[:120])


def card_payload(chats: list[dict], **extra: object) -> dict:
    """A bot with every modelled material plus fields we deliberately do not
    model (emotionImages) - those must survive in card_json untouched."""
    return {
        "charId": "cha-card",
        "characterIndex": 5,
        "cardFull": True,
        "card": {
            "name": "카드 봇",
            "chaId": "cha-card",
            "desc": "본래 설명",
            "personality": "본래 성격",
            "firstMessage": "본래 첫 인사",
            "alternateGreetings": ["대체 인사 1", "대체 인사 2"],
            "customscript": [
                {"comment": "치환", "in": "foo", "out": "bar", "type": "editdisplay"},
                {"comment": "배경 HTML", "in": "^", "out": "<div class=bg></div>",
                 "type": "editdisplay", "flag": "g", "forkExtra": 7},
            ],
            "triggerscript": [
                {"comment": "시작 트리거", "type": "start", "conditions": [],
                 "effect": [{"type": "setvar", "var": "x"}]},
            ],
            "emotionImages": [["기쁨", "assets/aa.png"]],
            "globalLore": [{"key": ["세계"], "content": "세계 설정"}],
        },
        "chats": [{"chat": c, "chatIndex": i} for i, c in enumerate(chats)],
        **extra,
    }


def test_card_rows(s: Server) -> dict:
    """Full-card upload becomes rows; re-upload keeps the working copy."""
    print("test_card_rows")
    st, body = s.post("/workspace", card_payload([make_chat("cardA", "카드 챗", 4)]))
    check("card workspace created", st == 200, str(body)[:200])
    ws = body.get("workspace") or {}
    ck = ws.get("charKey") or ""
    check("first ingest resets the card", ws.get("cardReset") is True, str(ws)[:200])
    check("full flag recorded", ws.get("cardFull") is True)

    st, body = s.get(q("/card", charKey=ck))
    check("card rows listed", st == 200, str(st))
    check("full flag on the listing", body.get("full") is True)
    fields = {(f["field"], f["seq"]): f for f in body.get("fields") or []}
    check("scalars are rows", ("desc", 0) in fields and ("name", 0) in fields,
          str(sorted(k for k, _ in fields))[:200])
    check("greetings are rows", ("alternateGreetings", 0) in fields and ("alternateGreetings", 1) in fields)
    check("nothing changed yet", body.get("changed") == 0, str(body.get("changed")))
    fseq = [f["field"] for f in body["fields"]]
    check("greetings sit under firstMessage",
          fseq.index("alternateGreetings") == fseq.index("firstMessage") + 1, str(fseq))
    check("retired fields are not rows",
          not any(f in fseq for f in ("personality", "scenario", "exampleMessage",
                                      "systemPrompt", "postHistoryInstructions")), str(fseq))
    check("background fields are rows",
          "backgroundHTML" in fseq and "backgroundCSS" not in fseq and "characterVersion" in fseq, str(fseq))

    st, body = s.get(q("/card/scripts", charKey=ck, kind="customscript"))
    check("regex items listed", st == 200 and len(body.get("items") or []) == 2, str(body)[:200])
    check("unmodelled script fields survive", body["items"][1]["entry"].get("forkExtra") == 7,
          str(body["items"][1])[:160])
    st, body = s.get(q("/card/scripts", charKey=ck, kind="triggerscript"))
    check("trigger items listed", len(body.get("items") or []) == 1, str(body)[:160])

    # Edit, then re-upload the panel-open way (no force): the edit must survive
    # while the baseline follows what RisuAI now holds.
    st, body = s.get(q("/card", charKey=ck))
    desc_id = next(f["id"] for f in body["fields"] if f["field"] == "desc")
    st, _ = s.post("/card/field", {"charKey": ck, "id": desc_id, "body": "고친 설명"})
    check("field edit accepted", st == 200, str(st))

    p2 = card_payload([make_chat("cardA", "카드 챗", 4)])
    p2["card"]["desc"] = "RisuAI에서 바뀐 설명"  # type: ignore[index]
    st, body = s.post("/workspace", p2)
    check("re-upload keeps the working card", (body.get("workspace") or {}).get("cardReset") is False,
          str(body.get("workspace"))[:200])
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("working text preserved", d["body"] == "고친 설명", d["body"])
    check("baseline refreshed", d["original"] == "RisuAI에서 바뀐 설명", str(d["original"]))
    return {"charKey": ck, "descId": desc_id}


def test_card_edit_patch_commit(s: Server, cw: dict) -> None:
    print("test_card_edit_patch_commit")
    ck = cw["charKey"]

    st, body = s.post("/card/greeting", {"charKey": ck, "body": "새 인사"})
    check("greeting added", st == 200 and (body.get("item") or {}).get("isNew") is True, str(body)[:160])
    st, body = s.get(q("/card", charKey=ck))
    g0 = next(f for f in body["fields"] if f["field"] == "alternateGreetings" and f["seq"] == 0)
    st, body = s.post("/card/greeting/delete", {"charKey": ck, "id": g0["id"]})
    check("original greeting is kept as deleted", body.get("kept") is True, str(body)[:120])

    st, body = s.get(q("/card/changes", charKey=ck))
    check("changes counts the field", body.get("fields") == 1, str(body)[:200])
    g = body.get("greetings") or {}
    check("and the greetings", g.get("added") == 1 and g.get("deleted") == 1, str(g))
    check("bar total adds up", body.get("total") == 3, str(body.get("total")))
    check("action count present", body.get("actions") == 0, str(body.get("actions")))

    st, body = s.get(q("/card/patch", charKey=ck))
    check("patch names the bot", body.get("chaId") == "cha-card", str(body.get("chaId")))
    check("patch is full-card", body.get("full") is True)
    f0 = (body.get("fields") or [{}])[0]
    check("scalar carries before/after", f0.get("field") == "desc"
          and f0.get("before") == "RisuAI에서 바뀐 설명" and f0.get("after") == "고친 설명", str(f0)[:200])
    ag = body.get("alternateGreetings") or {}
    check("greetings list omits the deleted, keeps order",
          ag.get("list") == ["대체 인사 2", "새 인사"], str(ag)[:200])

    # 반영: write, commit, then re-read the card RisuAI now holds. The working
    # copy is not kept past a successful write (0.9) - it is where the drift
    # this release fixes used to start.
    base_card = card_payload([make_chat("cardA", "카드 챗", 4)])["card"]
    written_card = write_back_card(s, ck, {**base_card, "desc": "RisuAI에서 바뀐 설명"})
    st, body = s.post("/card/commit", {"charKey": ck, "label": "테스트 반영"})
    check("commit answers with what shipped", st == 200 and body.get("shipped", 0) >= 1, str(body)[:160])
    st, body = s.post("/workspace", {**card_payload([make_chat("cardA", "카드 챗", 4)]),
                                     "card": written_card, "cardReset": True})
    st, body = s.get(q("/card/changes", charKey=ck))
    check("after the write-back and re-read nothing is pending", body.get("total") == 0, str(body)[:200])
    check("and no conflicts", body.get("conflicts") == 0, str(body)[:200])
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("the card now reads what was written", d["body"] == "고친 설명" and not d["changed"], str(d)[:160])
    check("deleted greeting is gone for good",
          not any(f["seq"] == 0 and f["deleted"] for f in body["fields"] if f["field"] == "alternateGreetings"))

    # Reset: edit again, then return to the (new) baseline.
    st, _ = s.post("/card/field", {"charKey": ck, "id": desc_id(s, ck), "body": "또 고침"})
    st, body = s.post("/card/reset", {"charKey": ck})
    check("reset answers", st == 200, str(body)[:120])
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("reset returns to the baseline", d["body"] == "고친 설명", d["body"])

    # Checkpoints: the commit and reset above each left one; restore is undoable.
    st, body = s.get(q("/card/checkpoints", charKey=ck))
    labels = [c["label"] for c in body.get("checkpoints") or []]
    check("commit and reset snapshot first", "테스트 반영" in labels and "reset 직전" in labels, str(labels))
    st, body = s.post("/card/checkpoint", {"charKey": ck, "label": "수동"})
    cid = body.get("id")
    st, _ = s.post("/card/field", {"charKey": ck, "id": desc_id(s, ck), "body": "복원 확인용"})
    st, body = s.post("/card/checkpoint/restore", {"charKey": ck, "id": cid})
    check("restore answers", st == 200, str(body)[:160])
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("restore puts the field back", d["body"] == "고친 설명", d["body"])
    st, body = s.get(q("/card/checkpoints", charKey=ck))
    check("restoring snapshots first, so it is undoable",
          "restore 직전" in [c["label"] for c in body.get("checkpoints") or []])


def test_card_scripts_lifecycle(s: Server, cw: dict) -> None:
    print("test_card_scripts_lifecycle")
    ck = cw["charKey"]
    st, body = s.get(q("/card/scripts", charKey=ck, kind="customscript"))
    items = body.get("items") or []
    bg = next(i for i in items if i["entry"].get("comment") == "배경 HTML")

    entry = dict(bg["entry"])
    entry["out"] = "<div class=bg2></div>"
    st, body = s.post("/card/script", {"charKey": ck, "id": bg["id"], "entry": entry})
    check("script edited whole", st == 200 and body.get("origin") == "edited", str(body)[:160])
    st, body = s.get(q("/card/scripts", charKey=ck, kind="customscript"))
    bg2 = next(i for i in body["items"] if i["id"] == bg["id"])
    check("its unmodelled field survived the edit", bg2["entry"].get("forkExtra") == 7, str(bg2)[:160])
    check("an edited script carries its original for the diff view",
          isinstance(bg2.get("original"), dict) and bg2["original"] != bg2["entry"], str(bg2.get("original"))[:120])

    st, body = s.post("/card/script/add",
                      {"charKey": ck, "kind": "customscript",
                       "entry": {"comment": "추가", "in": "x", "out": "y", "type": "editinput"}})
    sid = body.get("id")
    check("script added", st == 200 and bool(sid), str(body)[:120])
    st, body = s.post("/card/script/move", {"charKey": ck, "id": sid, "toSeq": 0})
    check("added script moved first", st == 200 and body.get("seq") == 0, str(body)[:120])

    st, body = s.get(q("/card/scripts", charKey=ck, kind="customscript"))
    first = (body.get("items") or [{}])[0]
    check("order is the working order", first.get("id") == sid, str([i["entry"].get("comment") for i in body["items"]]))
    other = next(i for i in body["items"] if i["entry"].get("comment") == "치환")
    st, _ = s.post("/card/script/delete", {"charKey": ck, "id": other["id"]})

    st, body = s.get(q("/card/patch", charKey=ck))
    cs = body.get("customscript") or {}
    check("patch list excludes the deleted", [e.get("comment") for e in cs.get("list") or []]
          == ["추가", "배경 HTML"], str(cs.get("list"))[:200])
    check("script changes counted", cs.get("changed") == 3, str(cs.get("changed")))

    # Same 반영 shape as the field test: write, commit, re-read.
    written = write_back_card(s, ck, card_payload([make_chat("cardA", "카드 챗", 4)])["card"])
    st, _ = s.post("/card/commit", {"charKey": ck, "label": "스크립트 반영"})
    st, _ = s.post("/workspace", {**card_payload([make_chat("cardA", "카드 챗", 4)]),
                                  "card": written, "cardReset": True})
    st, body = s.get(q("/card/changes", charKey=ck))
    check("after the re-read the scripts are clean", (body.get("customscript") or {}).get("total") == 0, str(body)[:200])
    st, body = s.get(q("/card/scripts", charKey=ck, kind="customscript"))
    check("and hold what was written", [i["entry"].get("comment") for i in body["items"]] == ["추가", "배경 HTML"],
          str([i["entry"].get("comment") for i in body["items"]]))


def test_global_lore_decoupled_reset(s: Server, cw: dict) -> None:
    """Opening a new chat must not reset the bot's card or global lorebook -
    the regression the old any_reset coupling would cause."""
    print("test_global_lore_decoupled_reset")
    ck = cw["charKey"]

    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    row = (body.get("lore") or [{}])[0]
    check("global lore row exists without a chat", row.get("chatKey") is None, str(row)[:160])
    entry = dict(row.get("entry") or {})
    entry["content"] = "고친 세계"
    st, _ = s.post("/lore/update", {"charKey": ck, "id": row["id"], "entry": entry})

    st, body = s.post("/lore", {"charKey": ck, "scope": "global",
                                "chatKey": "cardA-should-be-ignored",
                                "entry": {"key": ["추가"], "content": "추가 로어"}})
    check("global add accepted", st == 200, str(body)[:120])

    st, _ = s.post("/card/field", {"charKey": ck, "id": desc_id(s, ck), "body": "새 챗 전에 고침"})

    # A brand-new chat, uploaded the panel-open way: its own turns reset
    # (first seen), but the card and global lore must keep their edits.
    st, body = s.post("/workspace", card_payload([
        make_chat("cardA", "카드 챗", 4),
        make_chat("cardB", "새 챗", 4),
    ]))
    ws = body.get("workspace") or {}
    check("new chat did not reset the card", ws.get("cardReset") is False, str(ws)[:160])
    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    contents = sorted(str((e.get("entry") or {}).get("content")) for e in body.get("lore") or [])
    check("global lore edits survived the new chat", contents == ["고친 세계", "추가 로어"], str(contents))
    check("the added row is chat-less", all(e.get("chatKey") is None for e in body.get("lore") or []))
    # The frozen counterpart travels with edited rows only - the panel's diff
    # view needs it, and an added row has nothing to diff against.
    edited = next(e for e in body["lore"] if (e.get("entry") or {}).get("content") == "고친 세계")
    added = next(e for e in body["lore"] if (e.get("entry") or {}).get("content") == "추가 로어")
    check("an edited lore row carries its original",
          isinstance(edited.get("original"), dict) and edited["original"].get("content") != "고친 세계",
          str(edited.get("original"))[:120])
    check("an added lore row carries none", added.get("original") is None)
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("card edit survived the new chat", d["body"] == "새 챗 전에 고침", d["body"])

    st, body = s.get(q("/card/patch", charKey=ck))
    gl = body.get("globalLore") or {}
    check("patch carries the working global lore",
          sorted(str(e.get("content")) for e in gl.get("list") or []) == ["고친 세계", "추가 로어"],
          str(gl)[:200])

    # Order is part of the material: move the added row first and the patch
    # list must follow.
    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    added = next(e for e in body.get("lore") or [] if (e.get("entry") or {}).get("content") == "추가 로어")
    st, body = s.post("/lore/move", {"charKey": ck, "id": added["id"], "toSeq": 0})
    check("global lore can be reordered", st == 200 and body.get("seq") == 0, str(body)[:120])
    st, body = s.get(q("/card/patch", charKey=ck))
    first = ((body.get("globalLore") or {}).get("list") or [{}])[0]
    check("the patch list follows the new order", first.get("content") == "추가 로어", str(first)[:120])

    # 카드만 다시 읽기: cardReset resets card and global lore, chats untouched.
    st, body = s.post("/workspace", card_payload([make_chat("cardA", "카드 챗", 4)], cardReset=True))
    check("cardReset forces the card", (body.get("workspace") or {}).get("cardReset") is True,
          str(body.get("workspace"))[:160])
    st, body = s.get(q("/lore", charKey=ck, scope="global"))
    contents = [str((e.get("entry") or {}).get("content")) for e in body.get("lore") or []]
    check("global lore returned to RisuAI's copy", contents == ["세계 설정"], str(contents))
    st, body = s.get(q("/card", charKey=ck))
    d = next(f for f in body["fields"] if f["field"] == "desc")
    check("card returned to the uploaded copy", d["body"] == "본래 설명", d["body"])


def test_reference_skills(s: Server) -> None:
    """Reference material lives in the skill folder and costs one catalog line."""
    print("test_reference_skills")
    st, body = s.get("/skills")
    refs = [x for x in body.get("skills") or []
            if any(f["path"].startswith("references/") for f in x.get("files") or [])]
    check("reference skills are seeded as folders", len(refs) >= 2, str(len(refs)))
    check("they carry a big file", any(f["size"] > 5000 for x in refs for f in x["files"]),
          str([[f["size"] for f in x["files"]] for x in refs]))

    st, body = s.get("/skills/preview")
    prompt = body.get("prompt") or ""
    check("the catalog names the skill", "RisuAI CBS 문법" in prompt, prompt[:400])
    check("and says when to load it", "CBS" in prompt and "load_skill" in prompt, prompt[:400])
    check("but not its contents", "{{getvar::" not in prompt and "insertorder" not in prompt, prompt[:400])
    check("the whole block stays small", len(prompt) < 4000, str(len(prompt)))

    st, body = s.get(q("/skills/preview", name="RisuAI CBS 문법"))
    loaded = body.get("prompt") or ""
    check("loading it names the file to read", "references/risuai-cbs.md" in loaded, loaded[:300])
    check("and tells how", "read_file" in loaded, loaded[:300])

    # A long .md upload becomes a reference file rather than a prompt block.
    st, body = s.post("/skills/upload", {"filename": "긴자료.md", "body": "가" * 9000})
    sk = body.get("skill") or {}
    check("a long upload becomes a reference file", any(f["path"] == "references/긴자료.md" for f in sk.get("files") or []),
          str(sk.get("files")))
    check("its body says to read it", "read_file" in sk.get("body", ""), sk.get("body", "")[:120])
    s.post("/skills/delete", {"id": sk.get("id")})

    st, body = s.post("/skills/upload", {"filename": "짧은.md", "body": "1. 먼저 읽는다."})
    sk = body.get("skill") or {}
    check("a short one is the body itself", sk.get("body") == "1. 먼저 읽는다." and not sk.get("files"), str(sk)[:160])
    s.post("/skills/delete", {"id": sk.get("id")})

    # A zipped skill folder imports whole.
    import base64, io as _io, zipfile
    buf = _io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("my-skill/SKILL.md", "---\nname: 집 스킬\ndescription: 집 정리를 할 때\n---\n\n1. 방부터.\n")
        zf.writestr("my-skill/references/guide.md", "# 안내\n자세한 절차.")
        zf.writestr("my-skill/scripts/go.py", "print('go')\n")
    st, body = s.post("/skills/upload", {"filename": "my-skill.zip",
                                          "body": base64.b64encode(buf.getvalue()).decode(), "base64": True})
    sk = body.get("skill") or {}
    check("a zip imports as a skill", st == 200 and sk.get("name") == "집 스킬", f"{st} {str(body)[:160]}")
    check("with its description as the trigger", sk.get("description") == "집 정리를 할 때", str(sk.get("description")))
    check("and its files", sorted(f["path"] for f in sk.get("files") or []) == ["references/guide.md", "scripts/go.py"],
          str(sk.get("files")))
    st, body = s.get("/skills/file?id=" + urllib.parse.quote(sk["id"]) + "&path=scripts/go.py")
    check("a skill file can be read back", body.get("content") == "print('go')\n", str(body)[:120])
    s.post("/skills/delete", {"id": sk.get("id")})


def test_plugin_self_update(s: Server) -> None:
    """RisuAI's own updater has to be able to fetch the plugin, without a token.

    The update check is made by RisuAI, which knows nothing about our bearer -
    so this one route is auth-exempt, and the header it serves has to carry
    //@version inside the first 512 bytes because that is all RisuAI reads.
    """
    print("test_plugin_self_update")
    st, body = s.get("/plugin")
    check("the backend knows about the plugin file", st == 200, str(st))
    if not body.get("available"):
        check("plugin build present", False, str(body)[:200])
        return
    check("it reports a version", bool(body.get("version")), str(body)[:200])

    st, raw = s.get("/plugin.js", token=None)
    text = raw.get("_raw") if isinstance(raw, dict) else str(raw)
    check("it serves without a token", st == 200, str(st))
    head = (text or "")[:512]
    check("the header survived the bundle", "//@name risu-hina" in head, head[:120])
    check("//@version is inside the first 512 bytes", "//@version" in head, head[:200])
    # //@update-url is emitted only when a release repo is configured. Its
    # absence is deliberate rather than a bug: a URL that 404s makes RisuAI
    # report a failed update check forever, which is worse than having none.
    if "//@update-url" in head:
        check("the update url is a release, not this backend",
              "/releases/" in head or "github" in head, head[:300])
    else:
        check("no update url is emitted until a repo is set", True)
    # A leaked token here would be handed to anyone who can reach the port.
    check("the file carries no token", "test-token-" not in (text or ""))


def test_logs_and_diagnostics(s: Server) -> None:
    """A user hitting a bug must be able to hand over what happened."""
    print("test_logs_and_diagnostics")
    st, body = s.get("/logs?limit=50")
    check("logs are readable", st == 200, str(st))
    lines = body.get("lines") or []
    check("and there is something in them", len(lines) > 0, str(len(lines)))
    check("each line is stamped", all(ln.startswith("[") for ln in lines[:5]),
          str(lines[:2]))
    joined = "\n".join(lines)
    # The log has never written a credential, and this is the assertion that
    # keeps it that way once someone starts pasting logs into bug reports.
    check("logs carry no token", "test-token-" not in joined)

    st, body = s.get("/logs?limit=20&level=error")
    check("logs can be filtered by level", st == 200, str(st))

    st, body = s.get("/diag")
    check("the diagnostic answers", st == 200, str(st))
    check("it reports the version", body.get("version"), str(body)[:200])
    check("and what is configured", "agent" in body, str(body)[:200])
    check("it says whether a key is set, not what it is",
          isinstance((body.get("agent") or {}).get("hasKey"), bool), str(body.get("agent")))
    check("no key appears anywhere in it", "sk-" not in json.dumps(body),
          json.dumps(body)[:200])
    check("it counts what is stored", isinstance(body.get("counts"), dict), str(body)[:200])


def test_asset_probe(s: Server) -> None:
    """M0 measurement surface: the echo counts what actually arrived.

    The echo endpoint is the prototype of the M2 asset upload, so its contract
    - per-item base64, byte counting, bad items reported not fatal - is locked
    here before the plugin starts depending on it.
    """
    print("test_asset_probe")
    import base64
    payload = {"items": [
        {"key": "assets/aa.png", "data": base64.b64encode(b"x" * 1000).decode()},
        {"key": "assets/bb.png", "data": "***not-base64***"},
    ]}
    st, body = s.post("/diag/asset-echo", payload)
    check("echo answers", st == 200, str(body)[:200])
    check("bytes are counted after decode", body.get("bytes") == 1000, str(body.get("bytes")))
    check("all items are acknowledged", body.get("items") == 2, str(body.get("items")))
    check("a bad item is reported, not fatal", body.get("badItems") == ["assets/bb.png"],
          str(body.get("badItems")))
    check("the address the backend saw is echoed", bool(body.get("addr")), str(body)[:200])

    st, body = s.post("/diag/asset-echo", {"items": "nope"})
    check("a non-list body is a 400", st == 400, str(st))

    # Key validation only - the actual hub fetch needs the network and belongs
    # to the manual measurement, not the gate.
    st, body = s.get("/diag/rs-probe?key=../etc/passwd")
    check("rs-probe rejects a non-asset key", st == 400, str(st))
    st, body = s.get("/diag/rs-probe?key=assets/" + "0" * 64 + ".png.exe")
    check("and a dressed-up one", st == 400, str(st))


def test_agent_presets(s: Server) -> None:
    """A preset is a saved copy of the agent settings, never a second live one.

    The distinction is the whole design: if a preset could be "active" while
    config.json said something else, "what will the agent use" would have two
    answers, and the settings panel and the agent would eventually disagree.
    """
    print("test_agent_presets")
    st, body = s.get("/presets")
    check("presets endpoint answers", st == 200, str(st))
    check("reasoning levels are advertised", "high" in (body.get("reasoningLevels") or []),
          str(body.get("reasoningLevels")))
    start = len(body.get("presets") or [])

    st, body = s.post("/presets/save", {"name": "테스트 프리셋", "values": {
        "baseUrl": "https://gw.example/v1", "apiKey": "sk-secret-value",
        "model": "test/model-a", "maxTokens": 41000, "reasoning": "high",
        "cache": True, "flex": True,
    }})
    check("preset saved", st == 200, str(body)[:200])
    pid = (body.get("preset") or {}).get("id")
    check("preset has an id", bool(pid))

    st, body = s.get("/presets")
    got = [p for p in body.get("presets") or [] if p.get("id") == pid]
    check("it is listed", len(got) == 1, str(len(body.get("presets") or [])))
    p0 = got[0] if got else {}
    check("the api key never comes back", isinstance(p0.get("apiKey"), dict), str(p0.get("apiKey")))
    check("but its presence does", (p0.get("apiKey") or {}).get("set") is True)
    check("options round-trip", p0.get("reasoning") == "high" and p0.get("cache") is True
          and p0.get("flex") is True, str(p0))
    raw = json.dumps(body)
    check("the secret is nowhere in the response", "sk-secret-value" not in raw)
    provs = body.get("providers") or []
    check("provider profiles are advertised", any(p.get("id") == "openai" for p in provs), str(len(provs)))
    check("a profile names its API and auth", all(p.get("auth") for p in provs))
    check("temperature defaults to not-sent", p0.get("temperature") is None, str(p0.get("temperature")))

    # Request parameters travel as JSON, real field names, null = do not send.
    st, body = s.post("/presets/save", {"id": pid, "name": "테스트 프리셋", "values": {
        "apiKey": "__keep__", "temperature": 0.7,
        "params": '{"reasoning_effort": "low", "temperature": null, "api": "responses"}'}})
    check("parameter JSON accepted", st == 200, str(body)[:200])
    st, body = s.get("/presets")
    p0 = [p for p in body["presets"] if p["id"] == pid][0]
    check("parameter JSON round-trips", "reasoning_effort" in (p0.get("params") or ""), str(p0.get("params")))
    check("temperature is a number when set", p0.get("temperature") == 0.7, str(p0.get("temperature")))
    st, body = s.post("/presets/save", {"id": pid, "name": "테스트 프리셋", "values": {
        "apiKey": "__keep__", "params": "{not json"}})
    check("broken parameter JSON is refused", st == 400, str(st))
    st, body = s.post("/presets/save", {"id": pid, "name": "테스트 프리셋", "values": {
        "apiKey": "__keep__", "params": '{"model": "x"}'}})
    check("the model cannot be overridden by JSON", st == 400, str(st))
    st, body = s.post("/presets/save", {"id": pid, "name": "테스트 프리셋", "values": {
        "apiKey": "__keep__", "temperature": ""}})
    check("a blank temperature means not sent", st == 200
          and [p for p in s.get("/presets")[1]["presets"] if p["id"] == pid][0].get("temperature") is None)
    st, body = s.get("/catalog/providers")
    check("providers endpoint answers alone", st == 200 and len(body.get("providers") or []) >= 9, str(st))

    # Editing without resending the key must not wipe it.
    st, _ = s.post("/presets/save", {"id": pid, "name": "테스트 프리셋", "values": {
        "model": "test/model-b", "apiKey": "__keep__"}})
    check("edit accepted", st == 200, str(st))
    st, body = s.get("/presets")
    p0 = [p for p in body["presets"] if p["id"] == pid][0]
    check("the model changed", p0.get("model") == "test/model-b", str(p0.get("model")))
    check("the key survived the edit", (p0.get("apiKey") or {}).get("set") is True, str(p0))

    # Applying writes into the live settings - that is the only thing that
    # decides what the agent runs with.
    before = ((s.get("/config")[1].get("config") or {}).get("agent") or {})
    st, body = s.post("/presets/apply", {"id": pid})
    check("preset applied", st == 200 and body.get("applied") == "테스트 프리셋", str(body)[:200])
    agent = ((s.get("/config")[1].get("config") or {}).get("agent") or {})
    check("live settings took the model", agent.get("model") == "test/model-b", str(agent.get("model")))
    check("live settings took the reasoning level", agent.get("reasoning") == "high",
          str(agent.get("reasoning")))
    check("live api key is still redacted", isinstance(agent.get("apiKey"), dict))

    # Capture is the reverse direction.
    st, body = s.post("/presets/capture", {"name": "지금 설정"})
    check("current settings can be captured", st == 200, str(body)[:200])
    cap = (body.get("preset") or {}).get("id")

    st, body = s.post("/presets/save", {"name": "잘못된", "values": {"reasoning": "very-high"}})
    check("an unknown reasoning level is refused", st == 400, str(st))
    st, _ = s.post("/presets/save", {"name": "", "values": {}})
    check("an unnamed preset is refused", st == 400, str(st))
    st, _ = s.post("/presets/apply", {"id": "nope"})
    check("applying a missing preset is 404", st == 404, str(st))

    for x in (pid, cap):
        s.post("/presets/delete", {"id": x})
    st, body = s.get("/presets")
    check("deleting cleans up", len(body.get("presets") or []) == start,
          f"{len(body.get('presets') or [])} vs {start}")

    # Put the live settings back so later tests see what they expect.
    s.post("/config", {"config": {"agent": {
        "model": before.get("model") or "", "baseUrl": before.get("baseUrl") or "",
        "reasoning": before.get("reasoning") or "", "cache": bool(before.get("cache")),
        "flex": bool(before.get("flex")),
        "maxTokens": before.get("maxTokens") or 32000}}})


def test_preset_selection(s: Server) -> None:
    """There is always exactly one selected preset and it is what the agent runs.

    The panel shows one preset, not a list, so "selected" has to be a real
    property of the data rather than something the UI remembers. And because
    config.json is still the only thing agent.py reads, selecting has to write
    through to it - otherwise the panel would show one model and the agent
    would use another.
    """
    print("test_preset_selection")
    st, body = s.get("/presets")
    check("a preset is always selected", bool((body.get("selected") or {}).get("id")),
          str(body.get("selected"))[:160])
    check("exactly one row is marked selected",
          sum(1 for x in body["presets"] if x.get("selected")) == 1,
          str([x.get("selected") for x in body["presets"]]))
    original = body["selected"]["id"]

    st, body = s.post("/presets/save", {"name": "선택 테스트", "values": {
        "baseUrl": "https://gw.example/v1", "apiKey": "sk-pick-me",
        "model": "test/pick", "instructions": "항상 존댓말로 답한다."}})
    check("a new preset saves", st == 200, str(body)[:200])
    pid = body["preset"]["id"]

    st, body = s.post("/presets/select", {"id": pid})
    check("it can be selected", st == 200 and body.get("id") == pid, str(body)[:200])
    agent = ((s.get("/config")[1].get("config") or {}).get("agent") or {})
    check("selecting writes through to the live config",
          agent.get("model") == "test/pick", str(agent.get("model")))
    check("base instructions come along",
          agent.get("instructions") == "항상 존댓말로 답한다.", str(agent.get("instructions")))

    # Editing the selected preset must reach the agent without a second step.
    st, _ = s.post("/presets/save", {"id": pid, "name": "선택 테스트", "values": {
        "model": "test/edited", "apiKey": "__keep__"}})
    agent = ((s.get("/config")[1].get("config") or {}).get("agent") or {})
    check("editing the selected preset applies immediately",
          agent.get("model") == "test/edited", str(agent.get("model")))

    # Editing a preset that is NOT selected must not touch the live config.
    st, body = s.post("/presets/save", {"name": "다른 것", "values": {"model": "test/other"}})
    other = body["preset"]["id"]
    agent = ((s.get("/config")[1].get("config") or {}).get("agent") or {})
    check("editing an unselected preset changes nothing live",
          agent.get("model") == "test/edited", str(agent.get("model")))

    st, _ = s.post("/presets/save", {"name": "너무 긴 지침",
                                     "values": {"instructions": "가" * 13000}})
    check("oversized base instructions are refused", st == 400, str(st))

    # Deleting the selected one has to leave something selected.
    st, body = s.post("/presets/delete", {"id": pid})
    check("the selected preset can be deleted", st == 200, str(body)[:160])
    st, body = s.get("/presets")
    check("something else became selected", bool((body.get("selected") or {}).get("id")),
          str(body.get("selected"))[:160])
    check("and it is not the deleted one", body["selected"]["id"] != pid)

    s.post("/presets/delete", {"id": other})
    s.post("/presets/select", {"id": original})
    st, body = s.get("/presets")
    left = body["presets"]
    for x in left:
        if x["id"] != original:
            s.post("/presets/delete", {"id": x["id"]})
    st, body = s.get("/presets")
    check("the last preset cannot be deleted",
          s.post("/presets/delete", {"id": body["selected"]["id"]})[0] == 400,
          str(len(body["presets"])))


def test_script_skills(s: Server) -> None:
    """A skill can carry a script, and then its source stays out of the prompt."""
    print("test_script_skills")
    st, body = s.post("/skills/upload", {
        "filename": "tidy_names.py",
        "body": '"""이름 표기를 훑어 후보를 뽑는다."""\nimport risuhina\nprint(len(risuhina.turns()))\n',
    })
    sk = body.get("skill") or {}
    check("a .py upload becomes a skill with a script",
          st == 200 and any(f["path"] == "scripts/tidy_names.py" for f in sk.get("files") or []), str(body)[:200])
    sid = sk.get("id")
    check("its docstring is the trigger", "이름 표기를" in sk.get("description", ""), sk.get("description"))
    check("its body names the path with the real slug", f"skills/{sid}/scripts/tidy_names.py" in sk.get("body", ""),
          sk.get("body", "")[:200])

    st, body = s.get("/skills/preview")
    prompt = body.get("prompt") or ""
    check("the skill is in the catalog", "이름 표기를" in prompt, prompt[:300])
    check("its source is NOT in the prompt", "import risuhina" not in prompt, prompt[:300])
    check("nor is its body", "scripts/tidy_names.py" not in prompt, prompt[:300])

    st, body = s.get(q("/skills/preview", name=sk["name"]))
    check("loading lists the script", "scripts/tidy_names.py" in (body.get("prompt") or ""), (body.get("prompt") or "")[:300])

    # Files can be added to and removed from a skill folder.
    st, body = s.post("/skills/file", {"id": sid, "path": "scripts/helper.py", "body": "x = 1\n"})
    check("a file can be added to a skill", st == 200 and body.get("path") == "scripts/helper.py", f"{st} {body}")
    st, body = s.get(q("/skills/get", id=sid))
    check("it is listed", any(f["path"] == "scripts/helper.py" for f in body["skill"]["files"]), str(body["skill"]["files"]))
    st, body = s.post("/skills/file", {"id": sid, "path": "../../evil.py", "body": "print(1)"})
    check("a traversing path is refused", st == 400, str(st))
    st, body = s.post("/skills/file", {"id": sid, "path": "SKILL.md", "body": "nope"})
    check("SKILL.md is not writable through the file route", st == 400, str(st))
    st, body = s.post("/skills/file/delete", {"id": sid, "path": "scripts/helper.py"})
    check("a file can be removed", st == 200, str(st))
    st, body = s.get(q("/skills/get", id=sid))
    check("and is gone", all(f["path"] != "scripts/helper.py" for f in body["skill"]["files"]))

    # A traversal in an upload filename must not choose where the file lands.
    st, body = s.post("/skills/upload", {"filename": "../../evil.py", "body": "print(1)"})
    sk2 = body.get("skill") or {}
    check("a traversing filename is reduced to a basename",
          any(f["path"] == "scripts/evil.py" for f in sk2.get("files") or []), str(sk2.get("files")))
    s.post("/skills/delete", {"id": sk2.get("id")})
    s.post("/skills/delete", {"id": sid})


def test_skills(s: Server) -> None:
    """Skills are folders; the prompt holds the catalog, the body comes on load."""
    print("test_skills")
    st, body = s.get("/skills")
    check("skills endpoint answers", st == 200, str(st))
    seeded = body.get("skills") or []
    check("starter skills are seeded", len(seeded) >= 2, str(len(seeded)))
    check("each has a slug, a name and a trigger description",
          all(x.get("id") and x.get("name") and x.get("description") for x in seeded), str(seeded)[:200])
    check("a catalog size is reported", int(body.get("catalogChars") or 0) > 0, str(body.get("catalogChars")))

    st, body = s.post("/skills/save", {"name": "테스트 스킬", "description": "테스트를 돌릴 때",
                                        "body": "1. 먼저 확인한다.\n2. 그 다음 제안한다."})
    check("skill saved", st == 200, str(body)[:200])
    sk = body.get("skill") or {}
    sid = sk.get("id")
    check("it got a folder slug", sid == "테스트-스킬", str(sid))

    st, body = s.get("/skills/preview")
    prompt = body.get("prompt") or ""
    check("the catalog names it with its trigger", "테스트 스킬" in prompt and "테스트를 돌릴 때" in prompt, prompt[:300])
    check("the body is NOT in the prompt", "먼저 확인한다" not in prompt, prompt[:300])
    check("the prompt tells the model to load_skill", "load_skill" in prompt, prompt[:200])

    st, body = s.get(q("/skills/preview", name="테스트 스킬"))
    check("loading by name returns the body", "먼저 확인한다" in (body.get("prompt") or ""), (body.get("prompt") or "")[:200])
    st, body = s.get(q("/skills/preview", name="없는 스킬"))
    check("loading a missing one says so and lists what exists",
          "그런 스킬이 없습니다" in (body.get("prompt") or "") and "테스트 스킬" in (body.get("prompt") or ""),
          (body.get("prompt") or "")[:200])

    st, _ = s.post("/skills/toggle", {"id": sid, "enabled": False})
    check("skill can be disabled", st == 200, str(st))
    st, body = s.get("/skills/preview")
    check("a disabled skill leaves the catalog", "테스트 스킬" not in (body.get("prompt") or ""), (body.get("prompt") or "")[:200])
    st, body = s.get(q("/skills/preview", name="테스트 스킬"))
    check("and cannot be loaded", "꺼 두었습니다" in (body.get("prompt") or ""), (body.get("prompt") or "")[:200])
    st, body = s.get("/skills")
    kept = [x for x in body.get("skills") or [] if x.get("id") == sid]
    check("but it is still stored", len(kept) == 1 and kept[0].get("enabled") is False, str(kept)[:200])
    s.post("/skills/toggle", {"id": sid, "enabled": True})

    # always: true puts the body in the prompt - the explicit exception.
    st, body = s.post("/skills/save", {"id": sid, "name": "테스트 스킬", "description": "테스트를 돌릴 때",
                                        "body": "항상 존댓말.", "always": True})
    check("always can be set", st == 200 and body["skill"]["always"] is True, str(body)[:160])
    st, body = s.get("/skills/preview")
    check("an always-on body is in the prompt", "항상 존댓말." in (body.get("prompt") or ""), (body.get("prompt") or "")[-200:])

    st, _ = s.post("/skills/save", {"name": "설명 없음", "body": "본문"})
    check("a skill without a trigger description is refused", st == 400, str(st))
    st, _ = s.post("/skills/save", {"name": "빈 내용", "description": "언제", "body": "   "})
    check("an empty body is refused", st == 400, str(st))
    st, _ = s.post("/skills/save", {"name": "너무 긴", "description": "언제", "body": "가" * 50000})
    check("an oversized body is refused", st == 400, str(st))
    st, _ = s.post("/skills/delete", {"id": "nope"})
    check("deleting a missing skill is 404", st == 404, str(st))

    st, _ = s.post("/skills/delete", {"id": sid})
    check("skill deleted", st == 200, str(st))
    st, body = s.get("/skills")
    check("it is gone", all(x.get("id") != sid for x in body.get("skills") or []))


def test_assets_store(s: Server, cw: dict) -> None:
    """M2: the content-addressed store behind the background importer.

    The contract the plugin importer depends on: a manifest says what is
    missing, uploads are per-item fallible, the same bytes under two keys is
    one blob, failed keys never hold the gate but are retried by the next
    manifest, and GC only ever drops what no manifest reaches.
    """
    print("test_assets_store")
    import base64
    ck = cw["charKey"]
    png = b"\x89PNG\r\n\x1a\n" + b"x" * 500
    refs = [
        {"field": "image", "name": "프로필", "key": "assets/aaaa1111.png"},
        {"field": "emotion", "name": "기쁨", "key": "assets/bbbb2222.png"},
        {"field": "emotion", "name": "중복", "key": "assets/bbbb2222.png"},
        {"field": "additional", "name": "나쁜키", "key": "../etc/passwd"},
    ]
    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": refs})
    check("manifest answers", st == 200, str(body)[:200])
    check("bad and duplicate refs are dropped", body.get("total") == 2, str(body.get("total")))
    check("everything is missing at first", sorted(body.get("missing") or []) ==
          ["assets/aaaa1111.png", "assets/bbbb2222.png"], str(body.get("missing")))
    check("the gate is closed", body.get("complete") is False)
    check("no fast path without a save dir", body.get("fastPath") is False)

    st, body = s.post("/assets/upload", {"items": [
        {"key": "assets/aaaa1111.png", "data": base64.b64encode(png).decode()},
        {"key": "assets/zzzz.png", "data": "***not-base64***"},
        {"key": "../../evil.png", "data": base64.b64encode(png).decode()},
    ]})
    check("upload answers", st == 200, str(body)[:200])
    check("one stored", body.get("stored") == 1, str(body.get("stored")))
    check("bad items reported, not fatal", sorted(b["key"] for b in body.get("bad") or []) ==
          ["../../evil.png", "assets/zzzz.png"], str(body.get("bad")))

    st, body = s.get(q("/assets/status", charKey=ck))
    check("status counts present and missing", body.get("present") == 1 and body.get("missing") == 1,
          str(body)[:200])
    check("still closed", body.get("complete") is False)

    # RisuAI keys are SHA-256 of the bytes. A key that looks like one but does
    # not match its content is refused whatever the source - that is what
    # makes a PocketRisu database or the hub a safe place to take bytes from.
    import hashlib
    real = hashlib.sha256(png).hexdigest()
    st, body = s.post("/assets/upload", {"items": [
        {"key": "assets/" + "0" * 64 + ".png", "data": base64.b64encode(png).decode()},
        {"key": f"assets/{real}.png", "data": base64.b64encode(png).decode()},
    ]})
    bad_keys = [b["key"] for b in body.get("bad") or []]
    check("a hash-shaped key must match its bytes", bad_keys == ["assets/" + "0" * 64 + ".png"]
          and "hash mismatch" in (body.get("bad") or [{}])[0].get("error", ""), str(body)[:200])
    check("and the true key is accepted", body.get("stored") == 1, str(body)[:120])

    # Same bytes, second key: one blob, two keys.
    st, body = s.post("/assets/upload", {"items": [
        {"key": "assets/bbbb2222.png", "data": base64.b64encode(png).decode()},
    ]})
    check("second key stored", body.get("stored") == 1, str(body)[:200])
    check("but no new bytes - deduplicated", body.get("newBytes") == 0, str(body.get("newBytes")))
    st, body = s.get(q("/assets/status", charKey=ck))
    check("gate opens once nothing is missing", body.get("complete") is True, str(body)[:200])
    check("one blob in the store", (body.get("store") or {}).get("blobs") == 1, str(body.get("store")))

    st, body = s.get(q("/assets/list", charKey=ck))
    items = body.get("items") or []
    check("listing follows card order with state and size",
          [i["key"] for i in items] == ["assets/aaaa1111.png", "assets/bbbb2222.png"]
          and all(i["state"] == "present" and i["size"] == len(png) for i in items), str(items)[:200])

    # Raw bytes come back as bytes, not JSON.
    st, body = s.get(q("/assets/blob", key="assets/aaaa1111.png"))
    # The helper decodes the body as text; the PNG signature's high byte
    # becomes U+FFFD, the ASCII part survives - enough to tell raw from JSON.
    raw = body.get("_raw", "")
    check("blob is served raw", st == 200 and "PNG" in raw[:8] and not raw.startswith("{"),
          str(st) + " " + repr(raw[:8]).encode("ascii", "replace").decode())
    st, body = s.get(q("/assets/blob", key="assets/nope.png"))
    check("unknown blob is a 404", st == 404, str(st))

    # A key the host could not read: marked failed, gate stays open, and the
    # next manifest tries it again.
    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": refs + [
        {"field": "additional", "name": "깨진", "key": "assets/cccc3333.webp"}]})
    check("new ref is missing", body.get("missing") == ["assets/cccc3333.webp"], str(body.get("missing")))
    st, body = s.post("/assets/fail", {"charKey": ck, "keys": ["assets/cccc3333.webp", "assets/aaaa1111.png"],
                                        "reason": "readImage returned null"})
    check("only the missing key is marked", body.get("marked") == 1, str(body))
    st, body = s.get(q("/assets/status", charKey=ck))
    check("failed does not hold the gate", body.get("complete") is True and body.get("failed") == 1, str(body)[:200])
    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": refs + [
        {"field": "additional", "name": "깨진", "key": "assets/cccc3333.webp"}]})
    check("the next sync retries a failed key", body.get("missing") == ["assets/cccc3333.webp"],
          str(body.get("missing")))

    # GC: reachable blobs stay whatever their age; unreachable ones go once old.
    st, body = s.post("/assets/gc", {"days": 0})
    check("gc keeps what a manifest reaches", body.get("removed") == 0, str(body))
    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": []})
    check("empty manifest is complete", body.get("complete") is True and body.get("total") == 0, str(body)[:120])
    st, body = s.post("/assets/gc", {"days": 0})
    # Three keys were still in the manifest until now (aaaa, bbbb, cccc); the
    # true-hash key was never in one and the earlier gc already dropped it -
    # orphan keys go regardless of age, only blobs wait out gcDays.
    check("gc drops the unreachable blob", body.get("removed") == 1 and body.get("orphanKeys") == 3, str(body))
    st, body = s.get(q("/assets/blob", key="assets/aaaa1111.png"))
    check("and it is gone", st == 404, str(st))

    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": "nope"})
    check("a non-list manifest is a 400", st == 400, str(st))
    st, body = s.post("/assets/manifest", {"charKey": "cnope", "refs": []})
    check("an unknown workspace is a 404", st == 404, str(st))


def test_charx_build(s: Server, cw: dict) -> None:
    """M2: charx from the working card and the store.

    The contract RisuAI's importer imposes (characterCards.ts at c0ed1026):
    chara_card_v3, every `embeded://` path present in the zip, triggers and
    Regex inline under extensions.risuai, the lorebook in character_book.
    And ours: the WORKING card goes in, missing assets refuse by default and
    drop on request, the file lands in out/ and streams back as bytes.
    """
    print("test_charx_build")
    import base64
    import io
    import zipfile
    ck = cw["charKey"]
    png = b"\x89PNG\r\n\x1a\n" + b"y" * 300

    # The card references one emotion image; the store was emptied by the
    # asset test, so a build must refuse and name it.
    st, body = s.post("/assets/manifest", {"charKey": ck, "refs": [
        {"field": "emotion", "name": "기쁨", "key": "assets/aa.png"}]})
    st, body = s.get(q("/charx/preview", charKey=ck))
    check("preview counts the card", st == 200 and body.get("assets") == 1 and body.get("lore") >= 1, str(body)[:200])
    check("and names the missing asset", [m["key"] for m in body.get("missing") or []] == ["assets/aa.png"], str(body.get("missing")))
    st, body = s.post("/charx/build", {"charKey": ck})
    check("a build with a missing asset is refused", st == 409, str(st) + " " + str(body)[:120])
    check("and says which", [m["key"] for m in body.get("missing") or []] == ["assets/aa.png"], str(body)[:200])

    # Drop it on request: the entry disappears, the zip imports cleanly.
    st, body = s.post("/charx/build", {"charKey": ck, "allowMissing": True, "name": "dropped"})
    check("allowMissing builds", st == 200 and body.get("ok") is True, str(body)[:200])
    check("with the entry dropped", body.get("dropped") == 1 and body.get("assets") == 0, str(body)[:200])

    # Fill the store and build for real.
    s.post("/assets/upload", {"items": [{"key": "assets/aa.png", "data": base64.b64encode(png).decode()}]})
    st, body = s.post("/charx/build", {"charKey": ck, "name": "카드 봇 테스트"})
    check("build succeeds once the asset is there", st == 200 and body.get("ok") is True, str(body)[:200])
    check("one asset in, nothing dropped", body.get("assets") == 1 and body.get("dropped") == 0, str(body)[:200])
    check("the file lands in the bot's project out/",
          str(body.get("path") or "").startswith("projects/")
          and str(body.get("path")).endswith("/out/카드 봇 테스트.charx"), str(body.get("path")))

    # q()'s own first parameter is called `path`, so this query is spelled out.
    dl = lambda p: "/files/download?charKey=" + urllib.parse.quote(ck) + "&path=" + urllib.parse.quote(p)
    st, raw = s.get(dl(body.get("path")))
    check("download streams bytes", st == 200 and "_raw" in raw, str(st))
    st, resp = s.get(dl("../../etc/passwd"))
    check("download refuses an escape", st == 400, str(st))
    st, resp = s.get(dl("out/nope.charx"))
    check("and a missing file is a 404", st == 404, str(st))

    # Read the zip straight off disk (the helper decodes bodies as text).
    # /files serves the global space now; the charx sits at its reported path.
    st, files = s.get(q("/files"))
    root = files.get("root") or ""
    with zipfile.ZipFile(Path(root) / body["path"]) as z:
        names = z.namelist()
        check("card.json is the last entry, no module.risum",
              names[-1] == "card.json" and "module.risum" not in names, str(names))
        check("x_meta precedes its asset",
              names[0].startswith("x_meta/") and names[1].startswith("assets/emotion/image/"), str(names))
        card = json.loads(z.read("card.json"))
        d = card.get("data") or {}
        check("spec is v3", card.get("spec") == "chara_card_v3" and card.get("spec_version") == "3.0")
        a = (d.get("assets") or [{}])[0]
        check("the asset entry points into the zip", a.get("uri") == "embeded://" + names[1]
              and a.get("type") == "emotion" and a.get("name") == "기쁨", str(a))
        check("and the bytes are the store's", z.read(names[1]) == png)
        risu = (d.get("extensions") or {}).get("risuai") or {}
        check("Regex and triggers are inline", isinstance(risu.get("customScripts"), list)
              and isinstance(risu.get("triggerscript"), list) and len(risu["customScripts"]) >= 1,
              str(list(risu.keys()))[:200])
        check("vits is an empty object, as createBaseV3 writes it", risu.get("vits") == {})
        book = d.get("character_book") or {}
        entries = book.get("entries") or []
        check("the lorebook is in character_book", len(entries) >= 1 and "keys" in entries[0]
              and "risu_fullWordMatching" in (book.get("extensions") or {}), str(book)[:200])
        # The working copy, not the baseline: the card test edited desc and
        # committed, and the greeting list is whatever /card lists now.
        st, cardrows = s.get(q("/card", charKey=ck))
        want = [f["body"] for f in sorted(
            (f for f in cardrows.get("fields") or [] if f["field"] == "alternateGreetings" and not f.get("deleted")),
            key=lambda f: f["seq"])]
        check("greetings come from the working copy", d.get("alternate_greetings") == want,
              str(d.get("alternate_greetings"))[:120] + " vs " + str(want)[:120])
        desc = next((f["body"] for f in cardrows.get("fields") or [] if f["field"] == "desc"), None)
        check("so does the description", d.get("description") == desc, str(d.get("description"))[:80])
        check("the portrait entry is absent when the card has no image",
              not any(x.get("type") == "icon" for x in d.get("assets") or []))

    st, body = s.post("/charx/build", {"charKey": "cnope"})
    check("unknown workspace is a 404", st == 404, str(st))

    # adopt: the plugin saved a workspace PNG into RisuAI and reports the key
    # the host chose; the store takes the same bytes under it and the
    # manifest grows by one, so a charx right after already carries it.
    s.post("/files/upload", {"name": "made.png", "base64": base64.b64encode(png).decode(),
                             "dir": "projects/어답트"})
    st, body = s.post("/assets/adopt", {"charKey": ck, "key": "assets/hostchose.png",
                                        "path": "projects/어답트/made.png", "name": "새 그림", "field": "additional"})
    check("adopt records the host's key", st == 200 and body.get("key") == "assets/hostchose.png", str(body)[:160])
    check("same bytes as aa.png - one blob", body.get("created") is False, str(body)[:160])
    st, body = s.get(q("/assets/list", charKey=ck))
    names = [(i["name"], i["state"]) for i in body.get("items") or []]
    check("the manifest carries the new asset as present", ("새 그림", "present") in names, str(names))
    st, body = s.post("/assets/adopt", {"charKey": ck, "key": "../x.png", "path": "projects/어답트/made.png"})
    check("adopt refuses a bad key", st == 400, str(st))
    st, body = s.post("/assets/adopt", {"charKey": ck, "key": "assets/ok.png", "path": "../../etc/hosts"})
    check("and an escaping path", st == 400, str(st))


def test_card_assets(s: Server, cw: dict) -> None:
    """Asset references are card material: rows under kind 'assetref' with the
    script lifecycle, renamed singly or in bulk, and written back as RisuAI's
    three lists in the same patch as everything else."""
    print("test_card_assets")
    ck = cw["charKey"]
    # Bring the card back to its baseline shape for this test: one emotion.
    s.post("/card/reset", {"charKey": ck})
    st, body = s.get(q("/card/scripts", charKey=ck, kind="assetref"))
    items = body.get("items") or []
    check("the emotion image is an assetref row", st == 200 and len(items) == 1
          and items[0]["entry"] == {"field": "emotion", "name": "기쁨", "key": "assets/aa.png", "ext": "png"},
          str(items)[:200])
    check("the version field is a card row",
          any(f["field"] == "characterVersion" for f in (s.get(q("/card", charKey=ck))[1].get("fields") or [])))

    # Single rename: entry replaced whole, origin edited.
    rid = items[0]["id"]
    st, body = s.post("/card/script", {"charKey": ck, "id": rid, "entry": {**items[0]["entry"], "name": "기쁨.png"}})
    check("rename marks the row edited", st == 200 and body.get("origin") == "edited", str(body)[:160])

    # Bulk: strip the extension people leave on names by mistake.
    st, body = s.post("/card/assets/rename", {"charKey": ck, "mode": "strip-ext"})
    check("strip-ext renames one", st == 200 and body.get("changed") == 1, str(body))
    st, body = s.get(q("/card/scripts", charKey=ck, kind="assetref"))
    check("and the name lost its .png", (body.get("items") or [{}])[0].get("entry", {}).get("name") == "기쁨", str(body)[:160])
    st, body = s.post("/card/assets/rename", {"charKey": ck, "mode": "regex", "pattern": "기쁨", "repl": "행복"})
    check("regex rename works", body.get("changed") == 1, str(body))
    st, body = s.post("/card/assets/rename", {"charKey": ck, "mode": "regex", "pattern": "(", "repl": ""})
    check("a bad regex is a 400", st == 400, str(st))

    st, body = s.get(q("/card/changes", charKey=ck))
    check("the bot bar counts it under assetref", (body.get("assetref") or {}).get("edited") == 1
          and body.get("total", 0) >= 1, str(body)[:200])
    st, body = s.get(q("/card/patch", charKey=ck))
    a = body.get("assets") or {}
    check("the patch carries RisuAI's lists, rebuilt from the working rows",
          a.get("changed") == 1 and a.get("emotionImages") == [["행복", "assets/aa.png"]]
          and a.get("additionalAssets") == [] and a.get("ccAssets") == [], str(a)[:200])

    # Delete: the reference goes on 반영; the store is not touched.
    st, body = s.post("/card/script/delete", {"charKey": ck, "id": rid})
    st, body = s.get(q("/card/patch", charKey=ck))
    check("a deleted reference leaves the list", (body.get("assets") or {}).get("emotionImages") == [], str(body.get("assets"))[:120])
    s.post("/card/reset", {"charKey": ck})
    st, body = s.get(q("/card/scripts", charKey=ck, kind="assetref"))
    check("reset brings it back", len(body.get("items") or []) == 1)


def test_keys_and_agent_kinds(s: Server) -> None:
    """API keys apart from presets; two agent kinds, one selected each; the
    search kind may run with none. The agent reads config sections the
    presets fill, so what lands in config is what is asserted."""
    print("test_keys_and_agent_kinds")
    st, body = s.post("/keys/save", {"values": {"name": "게이트웨이", "provider": "vercel",
                                                "baseUrl": "https://gw.example/v1/", "apiKey": "sk-gw-123456"}})
    check("a key is saved with its shape, not its value", st == 200
          and body["key"]["apiKey"] == {"set": True, "length": 12} and body["key"]["baseUrl"] == "https://gw.example/v1",
          str(body)[:200])
    kid = body["key"]["id"]
    st, body = s.get("/keys")
    check("keys are listed", any(k["id"] == kid for k in body.get("keys") or []))

    # A general preset borrowing the key: config.agent gets the resolved pair.
    st, body = s.post("/presets/save", {"name": "키참조", "values": {
        "model": "gpt-x", "keyRef": kid, "kind": "general", "apiKey": ""}})
    check("a preset may point at a key", st == 200 and body["preset"]["keyRef"] == kid, str(body)[:200])
    pid = body["preset"]["id"]
    st, body = s.post("/presets/select", {"id": pid})
    st, cfg = s.get("/config")
    a = (cfg.get("config") or {}).get("agent") or {}
    check("selecting it resolves base URL and key into config.agent",
          a.get("baseUrl") == "https://gw.example/v1" and a.get("apiKey", {}).get("length") == 12
          and a.get("model") == "gpt-x", str(a)[:200])

    # Rotating the key reaches the running agent without touching the preset.
    st, body = s.post("/keys/save", {"id": kid, "values": {"name": "게이트웨이", "apiKey": "sk-gw-abcdefghij"}})
    st, cfg = s.get("/config")
    check("a rotated key is re-resolved", ((cfg.get("config") or {}).get("agent") or {}).get("apiKey", {}).get("length") == 16,
          str(cfg)[:200])
    st, body = s.post("/keys/delete", {"id": kid})
    check("a key in use cannot be deleted", st == 400 and "프리셋" in body.get("error", ""), str(body)[:120])
    st, body = s.post("/presets/save", {"name": "키참조", "values": {"keyRef": "nope"}, "id": pid})
    check("an unknown key ref is refused", st == 400, str(st))

    # The search kind: its own selection, its own config section, may be none.
    st, body = s.get("/presets")
    check("no search preset selected at first", body.get("selectedSearch") is None and body.get("kinds") == ["general", "search"],
          str(body.get("selectedSearch"))[:80])
    st, body = s.post("/presets/save", {"name": "검색용", "values": {
        "kind": "search", "baseUrl": "https://s.example/v1", "apiKey": "sk-s-1", "model": "gemini-x"}})
    check("a search preset saves under its kind", st == 200 and body["preset"]["kind"] == "search" and not body["preset"]["selected"],
          str(body)[:200])
    sid = body["preset"]["id"]
    st, body = s.post("/presets/select", {"id": sid})
    check("selecting it does not disturb the general selection", body.get("kind") == "search")
    st, body = s.get("/presets")
    check("both kinds show their own selection",
          (body.get("selected") or {}).get("id") == pid and (body.get("selectedSearch") or {}).get("id") == sid,
          str(body.get("selected", {}).get("name")) + " / " + str((body.get("selectedSearch") or {}).get("name")))
    st, cfg = s.get("/config")
    check("config.agent_search is filled", ((cfg.get("config") or {}).get("agent_search") or {}).get("model") == "gemini-x",
          str((cfg.get("config") or {}).get("agent_search"))[:160])
    st, body = s.post("/presets/deselect", {"kind": "search"})
    st, cfg = s.get("/config")
    check("deselecting the search agent empties its section",
          ((cfg.get("config") or {}).get("agent_search") or {}).get("model") == "", str(cfg)[:160])
    st, body = s.post("/presets/deselect", {"kind": "general"})
    check("the general agent cannot be deselected", st == 400, str(st))
    st, body = s.post("/presets/delete", {"id": sid})
    check("a search preset can be deleted even when it is the last of its kind", st == 200, str(body)[:120])

    # The catalog answers even offline: an empty result, never a 500.
    st, body = s.get(q("/models/catalog", q="gemini"))
    check("the model catalog route answers", st == 200 and "models" in body and "providers" in body, str(body)[:160])


def test_codex_is_off_unless_enabled() -> None:
    """The shipped default: the subscription path is not offered at all.

    Its own server, seeded with the hand edit `"OPENAI_CODEX": 0`. The key
    ships in the config template at 1 (asserted on the shared server below),
    and nothing but a hand-edited config.json can turn it off - a settings
    patch cannot flip it either way, since `config.update` only walks sections.
    """
    print("test_codex_off_by_hand_edit")
    s = Server(codex=False)
    try:
        if not s.wait_ready():
            check("server started", False, s.drain()[-400:])
            return
        st, h = s.get("/health", token=None)
        check("health says it is not offered", h.get("codexEnabled") is False, str(h)[:200])
        st, _ = s.get("/codex/status")
        check("its routes are not there at all", st == 404, str(st))
        st, body = s.post("/presets/save", {"name": "구독", "values": {"provider": "codex", "model": "m"}})
        check("and a preset cannot select it", st == 400, f"{st} {str(body)[:100]}")
        st, body = s.post("/config", {"config": {"OPENAI_CODEX": 1}})
        st, h = s.get("/health", token=None)
        check("and a settings patch cannot turn it back on", h.get("codexEnabled") is False, str(h)[:200])
    finally:
        s.stop()


def test_codex_subscription_preset(s: Server) -> None:
    """The OpenAI-subscription provider: the login flow's shape (no network),
    and a codex preset as the agent's config - which leaves /health honest
    (not ready) until someone actually logs in."""
    print("test_codex_subscription_preset")
    st, body = s.get("/codex/status")
    check("logged out at first", st == 200 and body.get("loggedIn") is False and body.get("models"), str(body)[:160])

    st, body = s.post("/codex/login/start", {})
    url = body.get("url") or ""
    check("login start hands out an authorization URL", st == 200 and url.startswith("https://auth.openai.com/oauth/authorize?"), url[:80])
    qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    check("with PKCE, the codex client id and the codex redirect",
          qs.get("code_challenge_method") == ["S256"] and qs.get("client_id") == ["app_EMoamEEZ73f0CkXaXp7hrann"]
          and qs.get("redirect_uri") == ["http://localhost:1455/auth/callback"] and bool(qs.get("state")), str(qs)[:200])
    check("and it presents itself as risu-hina, not another program", qs.get("originator") == ["risu-hina"], str(qs.get("originator")))
    tmpl = json.loads((s.data / "config.json").read_text(encoding="utf-8"))
    check("the config template ships the flag at 1", tmpl.get("OPENAI_CODEX") == 1, str(tmpl.get("OPENAI_CODEX")))
    state = qs["state"][0]
    check("the pending attempt is known", s.get(q("/codex/login/status", state=state))[1].get("known") is True)
    st, body = s.post("/codex/login/complete", {"redirect": "http://localhost:1455/auth/callback?code=abc&state=WRONG"})
    check("a redirect with the wrong state is refused", st == 400 and "state" in body.get("error", ""), str(body)[:120])
    st, body = s.post("/codex/login/complete", {"redirect": "garbage"})
    check("garbage is refused", st == 400, str(st))
    st, body = s.post("/codex/logout", {})
    check("logout answers", st == 200 and body.get("loggedIn") is False)

    # A codex preset needs no URL or key; selected, it is what config.agent says.
    st, body = s.post("/presets/save", {"name": "구독", "values": {"provider": "codex", "model": "gpt-5.1-codex", "apiKey": ""}})
    check("a codex preset saves without URL or key", st == 200 and body["preset"]["provider"] == "codex", str(body)[:200])
    pid = body["preset"]["id"]
    st, body = s.post("/presets/save", {"name": "구독", "values": {"provider": "nope"}, "id": pid})
    check("an unknown provider is refused", st == 400, str(st))
    st, body = s.post("/presets/select", {"id": pid})
    st, cfg = s.get("/config")
    a = (cfg.get("config") or {}).get("agent") or {}
    check("config.agent carries the provider", a.get("provider") == "codex" and a.get("model") == "gpt-5.1-codex", str(a)[:160])
    st, h = s.get("/health")
    check("not agentReady until logged in", h.get("agentReady") is False, str(h)[:120])
    st, body = s.post("/presets/delete", {"id": pid})


def test_workspace_folders_and_family(s: Server, cw: dict) -> None:
    """Folders inside the deletable areas, moves between them, and one
    workspace shared by every version of a bot (the family stamp a clone or
    a charx round-trip carries)."""
    print("test_workspace_folders_and_family")
    ck = cw["charKey"]
    st, body = s.post("/files/mkdir", {"path": "projects/참고"})
    check("a folder is made inside projects", st == 200 and body.get("path") == "projects/참고", str(body)[:120])
    st, body = s.post("/files/mkdir", {"system": 1, "charKey": ck, "path": "original/x"})
    check("but the SYSTEM view is read-only", st == 403, str(st))
    st, body = s.post("/files/upload", {"name": "memo.txt", "text": "hi", "dir": "projects/참고"})
    check("an upload can target a folder", st == 200 and body.get("path") == "projects/참고/memo.txt", str(body)[:120])
    st, body = s.post("/files/upload", {"system": 1, "charKey": ck, "name": "x.txt", "text": "hi", "dir": "original"})
    check("an upload cannot target the SYSTEM view", st == 403, str(st))
    st, body = s.post("/files/upload", {"name": "x.txt", "text": "hi", "dir": "hina/보관"})
    check("but hina/ and a nested folder are fine", st == 200 and body.get("path") == "hina/보관/x.txt", str(body)[:120])
    s.post("/files/delete", {"path": "hina/보관"})

    # A dropped zip unpacks into a folder named after it; junk and escapes are
    # skipped; and a selection comes back as one zip.
    import base64 as _b64
    import io as _io
    import zipfile as _zipfile
    buf = _io.BytesIO()
    with _zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", "A")
        zf.writestr("sub/b.txt", "B")
        zf.writestr("__MACOSX/._a.txt", "junk")
        zf.writestr("../escape.txt", "X")
    st, body = s.post("/files/upload", {"name": "묶음.zip", "dir": "projects/참고",
                                        "base64": _b64.b64encode(buf.getvalue()).decode(), "extract": True})
    check("a zip can be unpacked on upload", st == 200 and body.get("path") == "projects/참고/묶음"
          and body.get("extracted") == 2, str(body)[:160])
    st, files = s.get(q("/files"))
    up = next(a for a in files["areas"] if a["area"] == "projects")
    names = {f["path"] for f in up["files"]}
    check("its files land under the folder, nested kept",
          "projects/참고/묶음/a.txt" in names and "projects/참고/묶음/sub/b.txt" in names, str(sorted(names))[:200])
    check("junk and escaping members are dropped",
          not any("escape" in n or "MACOSX" in n for n in names))
    st, raw, hdr = s.post_bytes("/files/zip", {"paths": ["projects/참고/묶음"], "name": "받기"})
    ctype = next((v for k, v in hdr.items() if k.lower() == "content-type"), "")
    check("a folder downloads as one zip", st == 200 and raw[:2] == b"PK" and "zip" in ctype, f"{st} {ctype}")
    with _zipfile.ZipFile(_io.BytesIO(raw)) as zf:
        got = sorted(zf.namelist())
    check("named relative to the folder's parent", got == ["묶음/a.txt", "묶음/sub/b.txt"], str(got))
    st, raw, hdr = s.post_bytes("/files/zip", {"paths": ["projects/참고/묶음/a.txt", "projects/참고/묶음/sub/b.txt"]})
    with _zipfile.ZipFile(_io.BytesIO(raw)) as zf:
        got = sorted(zf.namelist())
    check("several files zip relative to their common parent", got == ["a.txt", "sub/b.txt"], str(got))
    st, raw, hdr = s.post_bytes("/files/zip", {"paths": ["../etc"]})
    check("a path outside the workspace is refused", st == 400, str(st))
    s.post("/files/delete", {"path": "projects/참고/묶음"})

    # The folder drop: many files in one binary body, subfolders kept.
    def packed(entries: list[tuple[str, str, bytes]], **hdr_extra: object) -> bytes:
        header = json.dumps({"dir": "projects/참고", "files": [
            {"name": n, "rel": r, "size": len(b)} for n, r, b in entries], **hdr_extra}, ensure_ascii=False).encode()
        return len(header).to_bytes(4, "big") + header + b"".join(b for _, _, b in entries)
    st, body = s.post_raw("/files/upload-many", packed([
        ("a.png", "", b"\x89PNG" + bytes(20)), ("b.txt", "deep/er", "hello".encode()), ("c.bin", "deep", bytes(3))]))
    check("a batch upload lands every file", st == 200 and body.get("count") == 3, str(body)[:160])
    st, files = s.get(q("/files"))
    up = next(a for a in files["areas"] if a["area"] == "projects")
    names = {f["path"]: f["size"] for f in up["files"]}
    check("with subfolders from `rel` and exact bytes",
          names.get("projects/참고/a.png") == 24 and names.get("projects/참고/deep/er/b.txt") == 5
          and names.get("projects/참고/deep/c.bin") == 3, str(sorted(names))[:200])
    # A file bigger than one body arrives in pieces. A character's .charx is
    # 140-180MB, which the batch path could never take (the body limit is
    # 64MB), so it used to be refused outright.
    def chunk(name: str, offset: int, total: int, blob: bytes, last: bool, **extra: object) -> bytes:
        header = json.dumps({"dir": "projects/참고", "name": name, "rel": "",
                             "offset": offset, "total": total, "last": last, **extra},
                            ensure_ascii=False).encode()
        return len(header).to_bytes(4, "big") + header + blob
    big = bytes(range(256)) * 40  # 10240 bytes, in three pieces
    st, body = s.post_raw("/files/upload-chunk", chunk("큰.bin", 0, len(big), big[:4096], False))
    check("a first chunk is accepted and not finished", st == 200 and body.get("done") is False
          and body.get("received") == 4096, str(body)[:140])
    st, files = s.get(q("/files"))
    up = next(a for a in files["areas"] if a["area"] == "projects")
    check("a half-arrived file is not listed", not any(f["name"].startswith("큰.bin") for f in up["files"]),
          str([f["name"] for f in up["files"]])[:160])
    st, body = s.post_raw("/files/upload-chunk", chunk("큰.bin", 9999, len(big), big[4096:8192], False))
    check("a chunk at the wrong offset is refused", st == 400 and "조각" in str(body), str(body)[:120])
    st, body = s.post_raw("/files/upload-chunk", chunk("큰.bin", 4096, len(big), big[4096:8192], False))
    st, body = s.post_raw("/files/upload-chunk", chunk("큰.bin", 8192, len(big), big[8192:], True))
    check("the last chunk completes the file", st == 200 and body.get("done") is True
          and body.get("size") == len(big), str(body)[:140])
    st, raw, _hdr = s.post_bytes("/files/download", {"path": "projects/참고/큰.bin"})
    check("and the bytes are exactly what was sent", raw == big, f"{len(raw)} vs {len(big)}")
    st, body = s.post_raw("/files/upload-chunk", chunk("짧.bin", 0, 99, b"12345", True))
    check("a size that does not match is refused", st == 400 and "크기" in str(body), str(body)[:120])
    s.post("/files/delete", {"path": "projects/참고/큰.bin"})

    st, body = s.post_raw("/files/upload-many", packed([("x.txt", "../../escape", b"x")]))
    check("a climbing `rel` is refused", st == 400, str(st))
    bad = packed([("y.txt", "", b"12345")])[:-2]
    st, body = s.post_raw("/files/upload-many", bad)
    check("a body shorter than its header is refused", st == 400, str(body)[:80])
    s.post("/files/delete", {"path": "projects/참고/deep"})
    st, files = s.get(q("/files"))
    up = next(a for a in files["areas"] if a["area"] == "projects")
    check("the listing names the folder", "projects/참고" in (up.get("dirs") or []), str(up.get("dirs")))
    st, body = s.post("/files/move", {"from": "projects/참고/memo.txt", "to": "hina"})
    check("a file moves between areas, name kept", st == 200 and body.get("to") == "hina/memo.txt", str(body)[:120])
    st, body = s.post("/files/move", {"from": "hina/memo.txt", "to": ".hina/memo.txt"})
    check("but never into the machine area", st == 400, str(st))
    st, body = s.post("/files/move", {"from": "projects/참고", "to": "projects/참고/안"})
    check("nor a folder into itself", st == 400, str(st))
    st, body = s.post("/files/delete", {"path": "hina/memo.txt"})

    # Family: a second bot stamped with this one's key lands in this workspace.
    st, body = s.post("/workspace", {
        "charId": "cha-card-v2", "characterIndex": 6, "cardFull": True,
        "card": {"name": "카드 봇 v2", "chaId": "cha-card-v2", "desc": "v2",
                 "extentions": {"risu_hina": {"family": ck}}},
        "chats": [{"chat": make_chat("v2chat", "v2 챗", 2), "chatIndex": 0}],
    })
    ws2 = body.get("workspace") or {}
    check("the copy is its own bot", st == 200 and ws2.get("charKey") and ws2.get("charKey") != ck, str(ws2)[:120])
    st, ws1 = s.get(q("/workspace/get", charKey=ck))
    check("in the original's SYSTEM directory", ws2.get("familyKey") == ck
          and ws2["paths"]["root"] == ((ws1.get("workspace") or {}).get("paths") or {}).get("root"),
          str(ws2.get("familyKey")) + " " + str(ws2.get("paths", {}).get("root")))
    st, f2 = s.get(q("/files", charKey=ws2["charKey"], system=1))
    st, f1 = s.get(q("/files", charKey=ck, system=1))
    check("so its SYSTEM listing is the shared one", f2.get("root") == f1.get("root"), str(f2)[:120])
    st, body = s.post("/workspace", {
        "charId": "cha-card-v2", "characterIndex": 6, "cardFull": True,
        "card": {"name": "카드 봇 v2", "chaId": "cha-card-v2", "desc": "v2",
                 "extentions": {"risu_hina": {"family": ws2["charKey"]}}},
        "chats": [{"chat": make_chat("v2chat", "v2 챗", 2), "chatIndex": 0}],
    })
    check("a stamp pointing at itself is ignored", (body.get("workspace") or {}).get("familyKey") == "",
          str(body.get("workspace", {}).get("familyKey")))


def test_websearch_card(s: Server) -> None:
    """The search provider: listed, defaulting to the keyless one, and a keyed
    choice without its key reported as not ready (no network here)."""
    print("test_websearch_card")
    st, body = s.get("/websearch")
    check("three modes, provider mode by default, DuckDuckGo ready with nothing set",
          st == 200 and [m["id"] for m in body["modes"]] == ["native", "gemini", "provider"]
          and body["mode"] == "provider" and body["providers"][0]["id"] == "duckduckgo"
          and body["provider"] == "duckduckgo" and body["ready"] is True, str(body)[:300])
    st, _ = s.post("/config", {"config": {"websearch": {"provider": "brave", "apiKey": "", "baseUrl": "", "maxResults": 5}}})
    st, body = s.get("/websearch")
    check("a keyed provider without a key is not ready and says why",
          body["ready"] is False and "키" in body["whyNot"], str(body)[:200])
    st, body = s.post("/websearch/test", {"query": "x"})
    check("and the test reports that instead of searching", st == 200 and body["ok"] is False and "키" in body["error"], str(body)[:160])
    st, _ = s.post("/config", {"config": {"websearch": {"provider": "brave", "apiKey": "k", "baseUrl": "", "maxResults": 5}}})
    st, body = s.get("/websearch")
    check("with a key it is ready, and the key is not echoed", body["ready"] is True and body["apiKeySet"] is True and "k" not in json.dumps(body.get("apiKey", "")), str(body)[:160])
    check("firecrawl is offered", any(p["id"] == "firecrawl" for p in body["providers"]))
    # The main agent's own search needs a main agent; there is none here.
    st, _ = s.post("/config", {"config": {"websearch": {"mode": "native"}}})
    st, body = s.get("/websearch")
    check("native mode without agent credentials is not ready and points at the agent card",
          body["mode"] == "native" and body["ready"] is False and "일반 에이전트" in body["whyNot"], str(body)[:200])
    st, body = s.post("/websearch/test", {"query": "x"})
    check("its test says the same without calling anything", st == 200 and body["ok"] is False and "일반 에이전트" in body["error"], str(body)[:160])
    # The Gemini helper needs a key - typed or referenced - and the typed one
    # is a secret: reported as set, never echoed, kept by the sentinel.
    st, _ = s.post("/config", {"config": {"websearch": {"mode": "gemini", "geminiApiKey": ""}}})
    st, body = s.get("/websearch")
    check("gemini mode without a key is not ready", body["mode"] == "gemini" and body["ready"] is False and "키" in body["whyNot"], str(body)[:200])
    check("its defaults are visible", body["gemini"]["model"] == "gemini-3.7-flash" and body["gemini"]["defaultInstructions"], str(body["gemini"])[:200])
    st, _ = s.post("/config", {"config": {"websearch": {"geminiApiKey": "AIza-secret"}}})
    st, body = s.get("/websearch")
    check("with a key it is ready and the key is not echoed", body["ready"] is True and body["gemini"]["apiKeySet"] is True and "AIza" not in json.dumps(body), str(body)[:200])
    st, _ = s.post("/config", {"config": {"websearch": {"geminiApiKey": body["keepSentinel"], "geminiModel": "gemini-3.7-pro"}}})
    st, body = s.get("/websearch")
    check("the sentinel keeps the key while other fields change", body["gemini"]["apiKeySet"] is True and body["gemini"]["model"] == "gemini-3.7-pro", str(body["gemini"])[:200])
    st, body = s.get("/config")
    check("the gemini key is redacted in /config", "AIza" not in json.dumps(body), str(body.get("config", {}).get("websearch"))[:200])
    st, _ = s.post("/config", {"config": {"websearch": {"mode": "", "provider": "", "apiKey": "", "baseUrl": "", "maxResults": 5, "geminiApiKey": "", "geminiModel": ""}}})


def test_permits_and_key_providers(s: Server) -> None:
    """Permission prompts have a wire shape the panel polls; a key names a
    provider and gets its base URL from the catalog (pinned list offline)."""
    print("test_permits_and_key_providers")
    st, body = s.get(q("/permits", sessionId="sess-x"))
    check("an idle session has no prompts", st == 200 and body.get("pending") == [], str(body)[:120])
    st, body = s.get("/permits")
    check("sessionId is required", st == 400, str(st))
    st, body = s.post("/permits/decide", {"id": "nope", "allow": True})
    check("deciding an unknown prompt is a 404", st == 404, str(st))

    st, body = s.post("/keys/save", {"values": {"name": "제미니", "provider": "google", "apiKey": "AIza-test-key-000"}})
    check("a key without a URL gets the provider's endpoint",
          st == 200 and body["key"]["baseUrl"] == "https://generativelanguage.googleapis.com/v1beta/openai", str(body)[:200])
    kid = body["key"]["id"]
    st, body = s.post("/keys/save", {"id": kid, "values": {"name": "제미니", "provider": "google", "baseUrl": "https://gw.example/v1"}})
    check("an explicit URL wins over the provider's", body["key"]["baseUrl"] == "https://gw.example/v1", str(body)[:160])
    st, body = s.post("/keys/save", {"values": {"name": "미지", "provider": "nobody-knows-this", "apiKey": "k"}})
    check("an unknown provider leaves the URL empty rather than guessing", st == 200 and body["key"]["baseUrl"] == "", str(body)[:160])
    for k in (kid, body["key"]["id"]):
        s.post("/keys/delete", {"id": k})

    st, body = s.get("/presets")
    sel = body.get("selected") or {}
    check("the general preset carries an agent name", sel.get("agentName") == "히나", str(sel.get("agentName")))
    check("and the defaults are offered to the editor", "general" in (body.get("defaultInstructions") or {}), str(list((body.get("defaultInstructions") or {}).keys())))


def test_loopback_exemption() -> None:
    """With RISUHINA_REQUIRE_TOKEN off, a loopback caller needs no token.

    The other half of the access policy, and the half users will actually run.
    """
    print("test_loopback_exemption")
    s = Server(require_token=False)
    try:
        if not s.wait_ready():
            check("second server started", False, s.drain()[:600])
            return
        st, body = s.get("/health", token=None)
        check("health reports the exemption", st == 200 and body.get("tokenRequired") is False, str(body)[:160])
        check("health reports loopback", body.get("loopback") is True, str(body)[:160])
        st, _ = s.post("/workspace", payload([make_chat("solo", "혼자", 3)]), token=None)
        check("loopback works without a token", st == 200, str(st))
        st, _ = s.get("/turns?chatKey=nope", token=None)
        check("still 404, not 401", st == 404, str(st))
    finally:
        s.stop()


def main() -> int:
    s = Server()
    try:
        if not s.wait_ready():
            print("server failed to start:")
            print(s.drain()[:4000])
            return 1
        test_dispatcher(s)
        ws = test_multi_chat_workspace(s)
        if ws.get("chats"):
            test_small_job_edit_and_patch(s, ws)
            test_medium_job_bulk_across_turns(s, ws)
            test_medium_job_cross_chat_search(s, ws)
            test_large_job_lore_then_truncate(s, ws)
            test_structural_ops(s, ws)
            test_export_preserves_foreign_fields(s, ws)
            test_checkpoint_restore(s, ws)
            test_reopen_keeps_pending_edits(s, ws)
            test_reopen_merges_risu_changes(s)
            test_reopen_merges_card_and_lore(s)
            test_agent_readiness_is_consistent(s, ws)
            test_agent_output_budget(s, ws)
            test_memory_as_rows(s, ws)
            test_lore_editing(s, ws)
            test_unified_writeback(s, ws)
            test_chat_variables(s, ws)
            test_action_queue(s, ws)
        cw = test_card_rows(s)
        test_card_edit_patch_commit(s, cw)
        test_card_scripts_lifecycle(s, cw)
        test_global_lore_decoupled_reset(s, cw)
        test_agent_presets(s)
        test_preset_selection(s)
        test_keys_and_agent_kinds(s)
        test_codex_subscription_preset(s)
        test_codex_is_off_unless_enabled()
        test_websearch_card(s)
        test_permits_and_key_providers(s)
        test_skills(s)
        test_script_skills(s)
        test_reference_skills(s)
        test_plugin_self_update(s)
        test_logs_and_diagnostics(s)
        test_asset_probe(s)
        test_assets_store(s, cw)
        test_charx_build(s, cw)
        test_card_assets(s, cw)
        test_workspace_folders_and_family(s, cw)
    finally:
        s.stop()

    test_loopback_exemption()

    print()
    if FAILURES:
        print(f"FAIL - {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASS - all checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
