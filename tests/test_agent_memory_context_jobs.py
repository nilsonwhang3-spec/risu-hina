"""Assistant notes, per-request context compression, and shared job lifecycle."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-memory-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")

from app import agent, agentcontext, agentnotes, config, db, main, session, studiojob
from pydantic_ai import Agent, capture_run_messages
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

config.load()
db.connect()


class Features(unittest.TestCase):
    def test_notes_persist_and_isolate_projects(self):
        with patch("app.workspace.bot_folder", side_effect=lambda key: key):
            a, b = agentnotes.scope("A"), agentnotes.scope("B")
            note = agentnotes.save(a, "Naming", "Keep .2 alternatives", "User correction")
            self.assertEqual(agentnotes.listing(a)["notes"][0]["body"], note["body"])
            self.assertFalse(agentnotes.recall("B", "Naming"))
            shared = agentnotes.save("global", "General preference", "Use Korean", "Explicit general preference")
            self.assertTrue(agentnotes.recall("B", "Korean"))
            self.assertIn("Keep .2 alternatives", agentnotes.prompt("A"))
            self.assertNotIn("Keep .2 alternatives", agentnotes.prompt("B"))
            updated = agentnotes.save(a, note["title"], "Keep .2 and .3", "verified", note_id=note["id"], revision=1)
            self.assertEqual(updated["history"][0]["body"], note["body"])
            with self.assertRaises(agentnotes.NoteError): agentnotes.save(a, note["title"], "stale", "verified", revision=1)
            with self.assertRaises(agentnotes.NoteError): agentnotes.delete(a, note["id"], 1)
            agentnotes.delete(a, note["id"], 2)
            self.assertFalse(agentnotes.recall("A", "Naming"))
            agentnotes.delete("global", shared["id"], shared["revision"])

    def test_memory_disabled_not_injected(self):
        with patch.object(config, "section", return_value={"memoryEnabled": False}):
            self.assertIn("disabled", agentnotes.prompt("A"))

    def test_notes_api_and_conflict(self):
        body = {"shared": True, "title": "HTTP note", "body": "Rule", "evidence": "manual"}
        note = main.h_agent_note_save(body)["note"]
        self.assertTrue(main.h_agent_notes({"shared": "true"})["notes"])
        with self.assertRaises(main.ApiError): main.h_agent_note_save({**body, "id": note["id"], "revision": 0})
        self.assertEqual(main.h_agent_note_delete({"shared": True, "id": note["id"], "revision": 1})["deleted"], note["id"])

    def test_same_turn_compression_preserves_current_request_and_pairs(self):
        calls = {"main": 0, "summary": 0}
        def model(messages, info):
            if not info.function_tools:
                calls["summary"] += 1
                return ModelResponse(parts=[TextPart(content="기존 결과는 읽음. 변경 작업 없음. 남은 결과를 확인해야 함.")])
            calls["main"] += 1
            if calls["main"] <= 6:
                return ModelResponse(parts=[ToolCallPart("read", {}, f"c{calls['main']}")])
            return ModelResponse(parts=[TextPart(content="done")])
        ag = Agent(FunctionModel(model), deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        @ag.tool_plain
        def read() -> str:
            return "Start: saved path A. " + "x" * 15000 + " End: remaining path B."
        sid = "compact-live"
        db.execute("INSERT INTO sessions(id,chat_key,title,created_at,updated_at) VALUES(?,?,?,?,?)", (sid,"chat","",db.now(),db.now()))
        settings = {"autoCompact": True, "historyBudgetChars": 5000, "contextWindowTokens": 128000, "maxTokens": 1000}
        deps = agent.Deps("chat", "A", sid, Path(DATA.name))
        with patch.object(config, "section", side_effect=lambda name: settings if name == "agent" else {}):
            with capture_run_messages() as captured:
                result = asyncio.run(ag.run("Never overwrite A; continue from B", deps=deps))
        self.assertGreater(calls["summary"], 0)
        self.assertEqual(calls["main"], 7)
        history = result.all_messages()
        self.assertTrue(any("Never overwrite A" in str(getattr(p,"content","")) for m in history for p in m.parts))
        outstanding = set()
        for message in history:
            for part in message.parts:
                if part.part_kind == "tool-call": outstanding.add(part.tool_call_id)
                elif part.part_kind == "tool-return":
                    self.assertIn(part.tool_call_id, outstanding)
                    outstanding.remove(part.tool_call_id)
        self.assertFalse(outstanding)
        self.assertTrue(db.one("SELECT seq FROM agent_messages WHERE session_id=? AND role='context'", (sid,)))
        self.assertEqual(captured, history)

    def test_summary_failure_keeps_unknown_status(self):
        messages = [ModelRequest(parts=[UserPromptPart(content="preserve my instruction")])]
        for i in range(5):
            messages += [ModelResponse(parts=[ToolCallPart("work", {}, str(i))]),
                         ModelRequest(parts=[ToolReturnPart("work", "Outcome UNKNOWN. " + "x" * 4000, str(i))])]
        def fail(*args): raise RuntimeError("unavailable")
        compacted, info = asyncio.run(agentcontext.compress(messages, 5000, FunctionModel(fail)))
        self.assertEqual(info["method"], "fallback")
        self.assertIn("완료를 뜻하지", info["summary"])
        self.assertTrue(any("preserve my instruction" in str(getattr(p,"content","")) for m in compacted for p in m.parts))

    def test_all_active_jobs_visible_and_cancelled_before_generation(self):
        now = db.now()
        for i in range(15):
            db.execute("INSERT INTO jobs(id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                       (f"j{i}", "studio_generate", "pending" if i < 2 else "done", json.dumps({"done": 0, "total": 1, "saved": []}), now+i, now+i))
        ids = {j["id"] for j in studiojob.recent(3)}
        self.assertIn("j0", ids); self.assertIn("j1", ids)
        studiojob.cleanup(3)
        self.assertIsNotNone(studiojob.get("j1"))
        self.assertFalse(studiojob.cancel("missing"))
        self.assertTrue(studiojob.cancel("j0"))
        self.assertEqual(studiojob.get("j0")["state"], "cancelled")
        with patch.object(studiojob, "_run_locked") as run:
            studiojob._run("j0")
        run.assert_not_called()
        self.assertFalse(studiojob.get("j0")["cancelRequested"])
        self.assertTrue(studiojob.cancel("j0"))

    def test_cancel_between_images_preserves_saved_result(self):
        now = db.now()
        item = {"name": "sample", "prompt": "landscape", "negative": ""}
        payload = {"spec": {"streaming": False}, "items": [item, item],
                   "done": 0, "total": 2, "saved": [], "failed": []}
        db.execute("INSERT INTO jobs(id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                   ("cancel-mid", "studio_generate", "pending", json.dumps(payload), now, now))
        def generated(*args):
            studiojob.cancel("cancel-mid")
            return b"png"
        with patch.object(studiojob.nai, "anlas", side_effect=[100, 95]), \
             patch.object(studiojob.nai, "generate", side_effect=generated) as generate, \
             patch.object(studiojob.studio, "refs_for_characters", return_value=([], [])), \
             patch.object(studiojob.studio, "save_image", return_value={"path": "studio/output/sample.png"}):
            studiojob._run("cancel-mid")
        job = studiojob.get("cancel-mid")
        self.assertEqual(generate.call_count, 1)
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual(job["result"], {"saved": 1, "failed": 0, "anlasSpent": 5})
        self.assertEqual(job["payload"]["saved"], ["studio/output/sample.png"])
        self.assertNotIn("current", job["payload"])

    def test_agent_registers_memory_and_job_tools(self):
        with patch.object(agent, "_model", return_value=TestModel()):
            ag = agent.build()
        names = set(ag._function_toolset.tools)
        self.assertTrue({"remember_note", "recall_notes", "forget_note", "compact_context", "studio_cancel"} <= names)


if __name__ == "__main__": unittest.main()
