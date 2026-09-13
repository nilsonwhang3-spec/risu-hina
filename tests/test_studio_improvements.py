"""Offline regression tests for interrupted work, learning and default installs."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-improvements-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
sys.stdout.reconfigure(encoding="utf-8")
from app import config, db, session, skills, studio, studiojob, studiodefaults, vision
from pydantic_ai import Agent, capture_run_messages
from pydantic_ai.messages import ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.test import TestModel

config.load()
db.connect()


class Improvements(unittest.TestCase):
    def test_output_project_and_subfolders(self):
        with patch("app.workspace.bot_folder", return_value="Project A"):
            self.assertEqual(studio.output_folder({"charKey": "a", "folder": "studio/output"}), "studio/output/Project A")
            self.assertEqual(studio.output_folder({"charKey": "a", "folder": "studio/output/Project A/extra"}), "studio/output/Project A/extra")
        self.assertEqual(studio.output_folder({"folder": "projects/B/out"}), "studio/output/B/out")
        self.assertEqual(studio.output_folder({}), "studio/output/_unassigned")
        with self.assertRaises(studio.StudioError):
            studio.output_folder({"project": "../escape"})
        items = studio.plan({"styles": [], "characters": [], "project": "Project A"})
        self.assertEqual(items[0]["folder"], "studio/output/Project A")

    def test_skill_learning_revision_and_restore(self):
        first = skills.save("Verified procedure", "When processing files", "Check type first", enabled=False, always=True)
        result = skills.improve(first["name"], first["description"], "Check type, then list directories", "Verified against a file and a directory",
                                slug=first["id"], revision=first["revision"], session_id="test", project="A")
        self.assertFalse(result["enabled"])
        self.assertTrue(result["always"])
        self.assertEqual(result["meta"]["learned_project"], "A")
        with self.assertRaises(skills.SkillError):
            skills.improve(first["name"], first["description"], "stale", "verified", slug=first["id"], revision=first["revision"])
        restored = skills.restore(first["id"], first["revision"])
        self.assertEqual(restored["body"], first["body"])
        self.assertFalse(restored["enabled"])
        self.assertEqual(len(skills.revisions(first["id"])), 2)
        created = skills.improve("New lesson", "For verified work", "Use structured APIs", "Successful offline test")
        self.assertFalse(created["always"])
        with self.assertRaises(skills.SkillError):
            skills.improve("New lesson", "For work", "duplicate", "test")

    def test_defaults_checksums_and_user_changes(self):
        result = studiodefaults.install()
        manifest = json.loads((studiodefaults.SOURCE / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(result["installed"]), len(manifest["files"]))
        rel = manifest["files"][0]["path"]
        target = config.DATA_DIR / "space/studio/config" / rel
        target.write_text("user edit", encoding="utf-8")
        result = studiodefaults.install()
        self.assertIn(rel, result["preserved"])
        self.assertEqual(target.read_text(encoding="utf-8"), "user edit")
        self.assertFalse(manifest["unresolved"])
        paths = {e["path"] for e in manifest["files"]}
        self.assertEqual({p.split('/')[1] for p in paths if p.startswith('fragments/')},
                         {"표정", "체위", "랜덤섹스.md"})
        self.assertEqual({p for p in paths if not p.startswith('fragments/')},
                         {"styles/오피스카운셀링.md"})
        actual = {p.relative_to(studiodefaults.SOURCE).as_posix()
                  for p in studiodefaults.SOURCE.rglob('*') if p.is_file() and p.name != 'manifest.json'}
        self.assertEqual(actual, paths)
        self.assertFalse(any("의상" in e["path"] or "보케" in e["path"] for e in manifest["files"]))

    def test_helper_rejects_incomplete_or_duplicate_verdicts(self):
        one = {"n": 1, "verdict": "use", "reason": "Complete"}
        self.assertEqual(vision.parse_verdicts("```json\n" + json.dumps([one]) + "\n```", 1), [one])
        for data in ([one], [one, one], [{**one, "verdict": "maybe"}, {**one, "n": 2}]):
            with self.assertRaises((ValueError, vision.VisionError)):
                vision.parse_verdicts(json.dumps(data), 2)

    def test_partial_history_preserves_completed_and_unknown_calls(self):
        captured = [ModelRequest(parts=[UserPromptPart(content="work")]),
                    ModelResponse(parts=[ToolCallPart("save", {}, "done"), ToolCallPart("generate", {}, "pending")]),
                    ModelRequest(parts=[ToolReturnPart("save", "saved file A", "done")])]
        with patch.object(session, "_save_message") as save, patch.object(session, "prune_history"):
            session._save_partial_history("test", "work", "", "disconnected", captured=captured)
        stored = save.call_args.args[2]
        results = [p for m in stored for p in m["parts"] if p["part_kind"] == "tool-return"]
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["content"], "saved file A")
        self.assertIn("outcome unknown", results[1]["content"])

    def test_real_stream_capture_on_tool_failure(self):
        ag = Agent(TestModel(call_tools=["save", "fail"]))
        saved = asyncio.Event()
        @ag.tool_plain
        def save() -> str:
            return "saved A"
        @ag.tool_plain
        async def fail() -> str:
            await asyncio.wait_for(saved.wait(), 3)
            raise RuntimeError("interrupted")
        async def run():
            with capture_run_messages() as captured:
                with self.assertRaises(Exception):
                    async with ag.run_stream_events("work") as events:
                        async for event in events:
                            if type(event).__name__ == "FunctionToolResultEvent" and event.result.tool_name == "save":
                                saved.set()
                return captured
        history = asyncio.run(run())
        returns = [p for m in history for p in m.parts if isinstance(p, ToolReturnPart)]
        self.assertTrue(any(p.content == "saved A" for p in returns))

    def test_restart_preserves_saved_job_results(self):
        db.execute("INSERT INTO jobs(id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                   ("restart", "studio_generate", "running", json.dumps({"saved": ["A.png"], "done": 1, "total": 2}), db.now(), db.now()))
        self.assertEqual(studiojob.recover_interrupted(), 1)
        job = studiojob.get("restart")
        self.assertEqual(job["state"], "cancelled")
        self.assertEqual(job["payload"]["saved"], ["A.png"])
        self.assertIsNone(job["result"]["anlasSpent"])
        self.assertEqual(studiojob.recover_interrupted(), 0)


if __name__ == "__main__":
    unittest.main()
