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

from app import agent, agentcontext, agentnotes, config, db, main, session, studiojob, updater
from pydantic_ai import Agent, capture_run_messages
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel

config.load()
db.connect()


class Features(unittest.TestCase):
    def test_legacy_character_budget_cannot_trigger_compression(self):
        def respond(messages, info):
            return ModelResponse(parts=[TextPart(content="done")])
        ag = Agent(FunctionModel(respond), deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        settings = {"autoCompact": True, "historyBudgetChars": 1,
                    "contextWindowTokens": 220000, "maxTokens": 32000}
        prompt = "x" * 130000
        with patch.object(config, "section", return_value=settings):
            result = asyncio.run(ag.run(prompt, deps=agent.Deps("chat", "A", "", Path(DATA.name))))
        self.assertEqual(result.all_messages()[0].parts[0].content, prompt)
        self.assertEqual(len(result.all_messages()), 2)

    def test_equal_character_counts_use_token_budget(self):
        def fail(*args): raise AssertionError("A single message should only be clipped")
        ascii_messages = [ModelRequest(parts=[ToolReturnPart("read", "x" * 3000, "c")])]
        cjk_messages = [ModelRequest(parts=[ToolReturnPart("read", "가" * 3000, "c")])]
        unchanged, info = asyncio.run(agentcontext.compress(ascii_messages, 2000, FunctionModel(fail)))
        self.assertIs(unchanged, ascii_messages)
        self.assertIsNone(info)
        clipped, info = asyncio.run(agentcontext.compress(cjk_messages, 2000, FunctionModel(fail)))
        self.assertEqual(info["method"], "clip")
        self.assertGreater(info["beforeTokens"], 2000)
        self.assertLessEqual(info["afterTokens"], 2000)
        self.assertEqual(info["budgetTokens"], 2000)
        self.assertTrue(info["tokenCountEstimated"])
        self.assertEqual(cjk_messages[0].parts[0].content, "가" * 3000)

    def test_budget_reserves_instructions_tools_and_output(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        settings = {"autoCompact": True, "contextWindowTokens": 220000, "maxTokens": 32000}
        request = SimpleNamespace(messages=[ModelRequest(parts=[UserPromptPart("hello")])],
                                  model_request_parameters=SimpleNamespace(function_tools="tool schema"),
                                  model_settings={"max_tokens": 16000}, model=None)
        ctx = SimpleNamespace(deps=agent.Deps("chat", "A", "", Path(DATA.name)))
        compressed = AsyncMock(return_value=(request.messages, None))
        with patch.object(config, "section", return_value=settings), \
             patch.object(agentcontext, "get_instructions", return_value="instructions"), \
             patch.object(agentcontext, "compress", compressed):
            asyncio.run(agentcontext.AutoContext().before_model_request(ctx, request))
        # §1-62: 90% of the window, less the fixed prefix and an output
        # reservation capped at 12K (not the whole max_tokens).
        self.assertEqual(compressed.call_args.args[1],
                         198000 - agentcontext.estimate_tokens("instructionstool schema") - 12000)

    def test_repeated_instructions_do_not_trigger_early_compression(self):
        def model(messages, info):
            return ModelResponse(parts=[TextPart(content="Verified result")])
        ag = Agent(FunctionModel(model), instructions="Project policy. " * 1500,
                   deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        sid = "no-early-compact"
        db.execute("INSERT INTO sessions(id,chat_key,title,created_at,updated_at) VALUES(?,?,?,?,?)", (sid,"chat","",db.now(),db.now()))
        settings = {"autoCompact": True, "historyBudgetChars": 120000, "contextWindowTokens": 128000, "maxTokens": 32000}
        async def turns():
            history = []
            for i in range(10):
                result = await ag.run("User task " + "x" * 2700, message_history=history,
                                      deps=agent.Deps("chat", "A", sid, Path(DATA.name)))
                history = result.all_messages()
            return history
        with patch.object(config, "section", side_effect=lambda name: settings if name == "agent" else {}):
            history = asyncio.run(turns())
        self.assertGreater(sum(agent._msg_chars(m) for m in history), 26000)
        self.assertFalse(db.one("SELECT seq FROM agent_messages WHERE session_id=? AND role='context'", (sid,)))

    def test_update_distinguishes_ahead_from_current_release(self):
        with patch.object(updater, "repo", return_value="owner/repo"), \
             patch.object(updater, "_http_json", return_value={"tag_name": "v0.14.8", "assets": []}):
            info = updater.check()
            self.assertTrue(info["ahead"])
            self.assertFalse(info["newer"])
            self.assertIn("스테이징", updater.apply()["reason"])
        with patch.object(updater, "repo", return_value="owner/repo"), \
             patch.object(updater, "_http_json", return_value={"tag_name": "v" + config.VERSION, "assets": []}):
            self.assertFalse(updater.check()["ahead"])

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

    def test_stored_history_keeps_instructions_once(self):
        # §1-62: 60 copies of a 25KB instructions block were 1.5MB of an
        # 1.85MB history row. Only the last request keeps its copy.
        msgs = [ModelRequest(parts=[UserPromptPart("a")], instructions="SYS"),
                ModelResponse(parts=[ToolCallPart("read", {}, "1")]),
                ModelRequest(parts=[ToolReturnPart("read", "x", "1")], instructions="SYS"),
                ModelResponse(parts=[TextPart("done")]),
                ModelRequest(parts=[UserPromptPart("b")], instructions="SYS2"),
                ModelResponse(parts=[TextPart("ok")])]
        out = session.dedupe_instructions(msgs)
        self.assertEqual([getattr(m, "instructions", None) for m in out], [None, None, None, None, "SYS2", None])
        self.assertEqual([getattr(m, "instructions", None) for m in msgs][0], "SYS", "the input is not mutated")

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
        # A window the six previewed returns (~1.35K tokens each) overrun.
        settings = {"autoCompact": True, "historyBudgetChars": 5000, "contextWindowTokens": 10000, "maxTokens": 1000}
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
        self.assertEqual(info["method"], "preserved")
        self.assertTrue(info["summaryFailed"])
        self.assertEqual(len(compacted), len(messages))
        self.assertEqual(info['diagnostics']['errorType'], 'RuntimeError')
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
        self.assertTrue({"remember_note", "recall_notes", "forget_note", "compact_context", "studio_cancel", "recall_work", "save_work_state"} <= names)


if __name__ == "__main__": unittest.main()
