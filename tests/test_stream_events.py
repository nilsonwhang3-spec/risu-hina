"""Side events: the queue a tool pushes and the run loop drains.

A tool that wants to say something structured to the panel (an artifact, an
image strip) cannot reach the NDJSON stream itself - it pushes into
session._EXTRA and run() drains after every translated event. These tests pin
the queue's contract (order, isolation per session, drained-means-gone, a
missing session id is a quiet no-op) and the artifact writer's file rules
(slugged title, counted duplicates, the bot's own out/artifacts/).

    python tests/test_stream_events.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))

DATA = Path(tempfile.mkdtemp(prefix="risuhina-stream-"))
os.environ["RISUHINA_DATA_DIR"] = str(DATA)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

from app import config, db, session, store, workspace  # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name}{(' - ' + detail) if detail else ''}")
        FAILURES.append(name)


config.load()
db.connect()

print("test_side_event_queue")
session.push_stream_event("s1", {"type": "artifact", "path": "a.md"})
session.push_stream_event("s1", {"type": "images", "paths": ["b.png"]})
session.push_stream_event("s2", {"type": "artifact", "path": "c.md"})
got = session._drain_extra("s1")
check("events drain in push order", [e["type"] for e in got] == ["artifact", "images"], str(got))
check("a drain empties the queue", session._drain_extra("s1") == [])
check("sessions are isolated", [e["path"] for e in session._drain_extra("s2")] == ["c.md"])
session.push_stream_event(None, {"type": "artifact"})
session.push_stream_event("", {"type": "artifact"})
check("no session means no queue, quietly", session._drain_extra("") == [])

print("\ntest_write_artifact")
CK = store.upsert_character("cha-stream-test", "스트림 봇", {"name": "스트림 봇"}, 0)
rel = workspace.write_artifact(CK, "비교 보고서", "# 본문\n한 줄")
check("the artifact lands under the bot's project out/artifacts",
      rel.startswith("projects/") and "/out/artifacts/" in rel and rel.endswith("비교-보고서.md"), rel)
check("and holds the text", (workspace.space_root() / rel).read_text(encoding="utf-8") == "# 본문\n한 줄")
rel2 = workspace.write_artifact(CK, "비교 보고서", "둘째")
check("a taken title counts up instead of overwriting", rel2.endswith("비교-보고서-2.md"), rel2)
rel3 = workspace.write_artifact(CK, '<>:"/\\|?*', "x")
check("a hostile title still makes a file", rel3.endswith(".md") and "artifacts/" in rel3, rel3)

print("\ntest_ping_while_the_model_thinks")
# A model silent past PING_EVERY_S (Gemini thinking on Vertex) must not leave
# the stream silent: a proxy's read timeout (nginx 60s) drops it (§1-114).
import asyncio  # noqa: E402
import json  # noqa: E402
from pydantic_ai import Agent  # noqa: E402
from pydantic_ai.models.function import FunctionModel  # noqa: E402
from app import agent as agent_mod  # noqa: E402


async def _slow_stream(messages, info):
    await asyncio.sleep(2.6)  # the run loop wakes once a second
    yield "생각 끝"


workspace.ensure_space()
db.execute("INSERT INTO chats(chat_key, char_key, name, created_at, updated_at) VALUES(?,?,?,?,?)",
           ("chat-stream-ping", CK, "핑 챗", db.now(), db.now()))
PSID = session.create("chat-stream-ping")["sessionId"]
session.get_agent = lambda: Agent(FunctionModel(stream_function=_slow_stream), deps_type=agent_mod.Deps)
session.PING_EVERY_S = 0.5


async def _collect() -> list[dict]:
    return [json.loads(line) async for line in session.run(PSID, "안녕")]

events = asyncio.run(_collect())
types = [e.get("type") for e in events]
check("a silent model gets pings in between", types.count("ping") >= 2, str(types))
check("the pings come before the answer", "ping" in types and "text" in types
      and types.index("ping") < types.index("text"), str(types))
check("and the turn still finishes", types[-1] == "done", str(types[-3:]))

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - side events land in order, and artifacts are files first")
