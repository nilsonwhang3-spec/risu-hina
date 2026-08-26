"""Agent end-to-end, against the real model.

Deliberately not mocked. The things that break here - a gateway that drops
`tools`, a tool whose schema the model cannot fill, a staged proposal that never
materialises - are exactly the things a mock would agree with. Phase 0's
`check_agent.py` already proved the credentials work; this proves the loop
closes over our own tools.

Skips itself when no credentials are configured, so the gate stays runnable
offline.

    pyserver/.venv/Scripts/python.exe tests/test_agent.py
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
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


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def agent_configured() -> bool:
    """Read the operator's real config without importing the server."""
    for candidate in (ROOT / "data" / "config.json",):
        try:
            cfg = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        a = cfg.get("agent") or {}
        if a.get("baseUrl") and a.get("apiKey") and a.get("model"):
            return True
    return False


class Server:
    def __init__(self) -> None:
        self.port = free_port()
        self.token = "agent-test-" + str(self.port)
        self.data = Path(tempfile.mkdtemp(prefix="risuhina-agent-"))
        # Copy the operator's credentials into the throwaway data dir so the
        # test uses real ones without touching the real database.
        try:
            src = json.loads((ROOT / "data" / "config.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            src = {}
        (self.data).mkdir(parents=True, exist_ok=True)
        (self.data / "config.json").write_text(
            json.dumps(src, ensure_ascii=False), encoding="utf-8")

        py = PYSERVER / ".venv" / "Scripts" / "python.exe"
        self.proc = subprocess.Popen(
            [str(py) if py.exists() else sys.executable, str(PYSERVER / "run.py")],
            cwd=str(PYSERVER),
            env={**os.environ,
                 "RISUHINA_PORT": str(self.port), "RISUHINA_HOST": "127.0.0.1",
                 "RISUHINA_DATA_DIR": str(self.data), "RISUHINA_TOKEN": self.token,
                 "RISUHINA_REQUIRE_TOKEN": "0", "PYTHONIOENCODING": "utf-8"},
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            encoding="utf-8", errors="replace")

    def wait_ready(self, timeout: float = 25.0) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                return False
            try:
                st, b = self.get("/health")
                if st == 200 and b.get("service") == "risu-hina":
                    return True
            except Exception:
                time.sleep(0.2)
        return False

    def _req(self, method, path, payload=None, timeout=300):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        req = urllib.request.Request(
            url, data=data, method=method,
            headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"_raw": raw}

    def get(self, path):
        return self._req("GET", path)

    def post(self, path, payload=None):
        return self._req("POST", path, payload if payload is not None else {})

    def stream(self, path, payload, timeout=300):
        """Read NDJSON, recording arrival times so buffering is detectable."""
        url = f"http://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(
            url, data=json.dumps(payload, ensure_ascii=False).encode(),
            method="POST", headers={"Content-Type": "application/json"})
        events, arrivals = [], []
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=timeout) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                arrivals.append(int((time.time() - t0) * 1000))
                try:
                    events.append(json.loads(line))
                except ValueError:
                    events.append({"type": "raw", "text": line})
        return events, arrivals

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        shutil.rmtree(self.data, ignore_errors=True)

    def drain(self):
        try:
            return self.proc.stdout.read() if self.proc.stdout else ""
        except Exception:
            return ""


def make_payload() -> dict:
    msgs = []
    for i in range(12):
        msgs.append({
            "role": "user" if i % 2 == 0 else "char",
            "data": (f"턴 {i}: 페데리코는 신전에 있다." if i == 5
                     else f"턴 {i}: 파브리스가 말했다. 오늘도 폐허를 걸었다."),
            "time": 1778892822492 + i * 1000,
            "chatId": f"a-m{i}",
        })
    return {
        "charId": "cha-agent-test",
        "characterIndex": 0,
        "card": {"name": "테스트 봇", "chaId": "cha-agent-test", "desc": "설명",
                 "globalLore": [{"key": ["신전"], "content": "신전은 도시 북쪽에 있다."}]},
        "chats": [{"chat": {"id": "agent-chat", "name": "에이전트 테스트", "note": "",
                            "localLore": [], "fmIndex": 0, "message": msgs}, "chatIndex": 0}],
    }


def main() -> int:
    if not agent_configured():
        print("SKIP - agent credentials not configured (data/config.json)")
        return 0

    s = Server()
    try:
        if not s.wait_ready():
            print("server failed to start:\n" + s.drain()[:3000])
            return 1

        print("test_setup")
        st, b = s.post("/workspace", make_payload())
        check("workspace created", st == 200, f"{st} {str(b)[:160]}")
        chat_key = ((b.get("workspace") or {}).get("chats") or [{}])[0].get("chatKey")
        check("chat key issued", bool(chat_key))

        st, b = s.post("/session", {"chatKey": chat_key, "title": "테스트"})
        sid = b.get("sessionId")
        check("session created", st == 200 and bool(sid), f"{st} {b}")

        print("\ntest_agent_reads_before_answering")
        events, arrivals = s.stream("/chat", {
            "sessionId": sid,
            "prompt": "이 챗에서 '신전'이 나오는 턴을 찾아서 몇 번 턴인지만 알려줘.",
        })
        kinds = [e.get("type") for e in events]
        check("stream started", kinds and kinds[0] == "start", str(kinds[:3]))
        check("stream finished", "done" in kinds, str(kinds[-3:]))
        check("no error event", "error" not in kinds,
              str([e for e in events if e.get("type") == "error"])[:300])

        tools = [e.get("name") for e in events if e.get("type") == "tool"]
        check("the agent used a tool", bool(tools), str(kinds))
        check("it searched or listed rather than guessing",
              any(t in ("search_turns", "list_turns", "read_turns", "run_python") for t in tools),
              str(tools))

        text = "".join(e.get("text", "") for e in events if e.get("type") == "text")
        check("it produced an answer", len(text.strip()) > 0, repr(text[:120]))
        check("it found the right turn", "5" in text, repr(text[:200]))

        done = next((e for e in events if e.get("type") == "done"), {})
        check("usage reported", isinstance(done.get("usage"), dict), str(done)[:200])
        check("input tokens counted", (done.get("usage") or {}).get("input"), str(done.get("usage")))
        check("cost reported or explicitly unknown", "cost" in done, str(done)[:200])

        # Progressive delivery: a run with several tool calls should not arrive
        # as one blob at the end. Phase 0 measured this path streaming properly.
        span = (arrivals[-1] - arrivals[0]) if len(arrivals) > 1 else 0
        check("events arrived progressively", span > 100, f"span={span}ms over {len(arrivals)} events")

        print("\ntest_agent_stages_rather_than_writing")
        events, _ = s.stream("/chat", {
            "sessionId": sid,
            "prompt": "5번 턴의 '신전'을 '대성당'으로 바꾸는 수정을 제안해줘. 그 턴 하나만.",
        })
        check("no error", "error" not in [e.get("type") for e in events],
              str([e for e in events if e.get("type") == "error"])[:300])

        st, b = s.get(f"/staged?chatKey={urllib.parse.quote(chat_key)}")
        staged = b.get("staged") or []
        check("a proposal was staged", len(staged) >= 1, str(b)[:250])

        st, b = s.get(f"/turns?chatKey={urllib.parse.quote(chat_key)}")
        t5 = next((t for t in b["turns"] if t["msgId"] == "a-m5"), {})
        # The whole design rests on this: proposing must not mutate.
        check("the transcript is untouched before approval",
              "신전" in (t5.get("body") or ""), repr(t5.get("body"))[:160])
        check("no turn is marked changed yet", not any(t["changed"] for t in b["turns"]))

        print("\ntest_approval_applies")
        st, b = s.post("/approve", {"chatKey": chat_key, "all": True, "approve": True})
        check("approve returns 200", st == 200, f"{st} {str(b)[:200]}")
        check("edits applied", (b.get("ops") or {}).get("edit", 0) >= 1, str(b)[:200])

        st, b = s.get(f"/turns?chatKey={urllib.parse.quote(chat_key)}")
        t5 = next((t for t in b["turns"] if t["msgId"] == "a-m5"), {})
        check("the approved edit landed", "대성당" in (t5.get("body") or ""), repr(t5.get("body"))[:160])
        check("it is marked changed", t5.get("changed") is True)

        st, b = s.get(f"/staged?chatKey={urllib.parse.quote(chat_key)}")
        check("nothing left pending", not (b.get("staged") or []), str(b)[:160])

        print("\ntest_history_persists")
        st, b = s.get(f"/session?chatKey={urllib.parse.quote(chat_key)}")
        msgs = b.get("messages") or []
        check("conversation was stored", len([m for m in msgs if m["role"] == "user"]) == 2,
              str([m["role"] for m in msgs]))
        check("cost booked per assistant turn",
              any(m["role"] == "assistant" and m.get("usage") for m in msgs))

    finally:
        s.stop()

    print()
    if FAILURES:
        print(f"FAIL - {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASS - agent reads, stages, and only writes after approval")
    return 0


if __name__ == "__main__":
    sys.exit(main())
