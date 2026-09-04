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

print()
if FAILURES:
    print(f"FAIL - {len(FAILURES)} check(s): " + ", ".join(FAILURES))
    sys.exit(1)
print("PASS - side events land in order, and artifacts are files first")
