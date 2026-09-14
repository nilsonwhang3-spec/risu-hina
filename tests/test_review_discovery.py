"""Current-turn recovery, searchable working copies, and live review contracts."""
import asyncio
import io
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-discovery-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
from app import actions, agent, agentcontext, assets, botsearch, card, config, db, files, hostwriteback, main, session, store, studio, tooloutput
from pydantic_ai.messages import ModelRequest, ToolReturnPart
from pydantic_ai.models.test import TestModel
from PIL import Image

config.load()
db.connect()


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.ck = self.id()
        live = {"chaId": self.ck, "name": "Neutral", "description": "body needle",
                "additionalAssets": [[f"hero-happy-{i}", f"assets/{i}.png", "png"] for i in range(151)],
                "customscript": [{"comment": "renderer", "in": "x", "out": "deep needle command"}]}
        db.execute("INSERT INTO characters(char_key,cha_id,card_json,created_at,updated_at) VALUES(?,?,?,?,?)",
                   (self.ck, self.ck, db.js(live), db.now(), db.now()))
        card.set_full(self.ck, True)
        card.ingest(self.ck, live, reset=True)
        with patch.object(agent, "_model", return_value=TestModel()):
            self.built = agent.build()
        self.ctx = NS(deps=agent.Deps(chat_key="", char_key=self.ck, mode="studio", session_id="test-session", workspace_dir=Path(DATA.name)))

    def tool(self, name, **kwargs):
        return self.built._function_toolset.tools[name].function(self.ctx, **kwargs)

    def test_python_tool_exposes_runtime_helper_description(self):
        description = self.built._function_toolset.tools["run_python"].description
        for text in ("import risuhina", "import realooc", "PYTHONPATH", "risuhina.conn()", "assetref"):
            self.assertIn(text, description)

    def test_explicit_card_save_works_from_any_screen_and_waits_for_result(self):
        sid = "save-" + self._testMethodName
        db.execute("INSERT INTO sessions(id,chat_key,created_at,updated_at) VALUES(?,?,?,?)", (sid, "", db.now(), db.now()))
        for mode in ("chat", "bot", "studio"):
            self.assertIsNone(agent.screen_gate(mode, "host_card_writeback"))
        def plugin(_sid, event):
            self.assertEqual(event["charKey"], self.ck)
            approved = actions.decide(event["id"], True, "studio")
            self.assertEqual(approved["host"]["kind"], "host_card_writeback")
            actions.complete(event["id"], True, "verified save")
        with patch.object(session, "push_stream_event", side_effect=plugin):
            result = asyncio.run(hostwriteback.save_card(sid, self.ck, "", "user requested"))
        self.assertEqual(result["status"], "done")
        self.assertEqual(result["result"], "verified save")

    def test_unconnected_save_request_expires_without_late_write(self):
        sid = "save-" + self._testMethodName
        db.execute("INSERT INTO sessions(id,chat_key,created_at,updated_at) VALUES(?,?,?,?)", (sid, "", db.now(), db.now()))
        with patch.object(session, "push_stream_event"):
            result = asyncio.run(hostwriteback.save_card(sid, self.ck, "", "user requested", timeout=0))
        self.assertEqual(result["status"], "rejected")
        with self.assertRaises(actions.ActionError):
            actions.decide(result["id"], True, "studio")

    def test_temporary_negative_survives_single_and_batch_planning(self):
        common = {"styles": [], "characters": [], "folder": "studio/output/temporary-negative",
                  "extra": "soft light", "negativeExtra": "blur, watermark"}
        scene = {"name": "happy", "prompt": "smile", "negativePrompt": "dark background"}
        for spec in ({**common, "scenes": [scene]}, {**common, "entries": [{"scene": scene, "count": 2}]}):
            planned = studio.plan(spec)
            self.assertTrue(planned)
            for item in planned:
                self.assertIn("soft light", item["prompt"])
                self.assertNotIn("watermark", item["prompt"])
                for term in ("blur", "watermark", "dark background"):
                    self.assertIn(term, item["negative"])
        self.assertNotIn("blur", studio.plan({"styles": [], "characters": [], "scenes": [scene]})[0]["negative"])

    def test_assetref_search_returns_tail_ids_and_pages(self):
        text = self.tool("list_scripts", kind="assetref", query="hero-happy-150")
        self.assertIn("hero-happy-150", text)
        self.assertIn("id=", text)
        first = self.tool("list_scripts", kind="assetref", limit=100)
        self.assertIn("nextOffset=100", first)
        self.assertIn("hero-happy-150", self.tool("list_scripts", kind="assetref", offset=150))
        rows = [{"field": "additional", "name": f"hero-{i}", "ext": "png", "state": "present", "size": 10} for i in range(151)]
        with patch.object(assets, "listing", return_value={"items": rows, "present": 151, "missing": 0, "failed": 0}):
            self.assertIn("hero-150", self.tool("list_assets", query="hero-150"))
            self.assertIn("nextOffset=50", self.tool("list_assets"))

    def test_search_working_copy_includes_global_and_local_lore(self):
        global_id = store.add_lore(self.ck, {"comment": "global", "content": "needle"})
        local_id = store.add_lore(self.ck, {"comment": "local", "content": "needle"}, "local", "")
        other_id = store.add_lore(self.ck, {"content": "needle"}, "local", "different-chat")
        result = botsearch.search(self.ck, "", "needle")
        ids = {i["id"] for i in result["items"]}
        self.assertTrue({global_id, local_id} <= ids)
        self.assertNotIn(other_id, ids)
        self.assertIn("customscript", {i["kind"] for i in result["items"]})
        overview = json.loads(self.tool("bot_structure"))
        self.assertTrue(overview["fullCardSynced"])
        self.assertIn("saveState", overview)

    def test_compression_recovers_every_character_without_reexecution(self):
        original = "BEGIN\n" + "가나다 needle\n" * 3000 + "END"
        messages = [ModelRequest(parts=[ToolReturnPart("run_python", original, "call-1")])]
        result, _ = asyncio.run(agentcontext.compress(messages, 2000, TestModel(), "test-session"))
        preview = result[0].parts[0].content
        ref = re.search(r"ref='([a-f0-9]{64})'", preview).group(1)
        restored, offset = "", 0
        while True:
            page = json.loads(self.tool("read_tool_result", ref=ref, offset=offset))
            restored += page["text"]
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        self.assertEqual(restored, original)
        self.assertEqual(messages[0].parts[0].content, original)
        with self.assertRaises(FileNotFoundError):
            tooloutput.read("another-session", ref)
        with self.assertRaises(ValueError):
            tooloutput.read("test-session", "../secret")

    def test_current_review_without_export_and_legacy_conflicts(self):
        folder = "studio/output/" + self._testMethodName
        base = files._resolve(files.SPACE, folder)
        base.mkdir(parents=True)
        for name in ("A-happy.png", "A-happy.2.png", "A-sad.png"):
            (base / name).write_bytes(b"image placeholder")
        studio.write_selection(folder, {"A-happy.png": {"use": True, "inpaint": True},
                                        "A-sad.png": {"delete": True, "inpaint": True}})
        pattern = r"^(?P<character>[^-]+)-(?P<emotion>[^.]+)"
        main.h_studio_group({"folder": folder, "pattern": pattern, "groupBy": "emotion"})
        result = json.loads(self.tool("studio_group", folder=folder, status="inpaint"))
        self.assertEqual(result["pattern"], pattern)
        self.assertEqual(result["counts"], {"use": 0, "inpaint": 1, "delete": 1, "unreviewed": 1})
        self.assertEqual(result["items"][0]["filename"], "A-happy.png")
        self.assertFalse((base / "selected").exists())
        self.assertEqual(studio.group(folder, pattern)["groups"][0]["key"], "happy")
        self.tool("studio_group", folder=folder, pattern=pattern, group_by="character", save_rule=True)
        self.assertEqual(main.h_studio_group({"folder": folder, "operation": "profile"})["groupBy"], "character")

    def test_repeated_inpaint_preserves_candidate_folder_name_and_review(self):
        buf = io.BytesIO()
        Image.new("RGB", (64, 64), "blue").save(buf, "PNG")
        image = buf.getvalue()
        folder = "projects/legacy-review"
        original = studio.save_image(folder, "A-happy.png", image, {})["path"]
        studio.write_selection(folder, {"A-happy.png": {"inpaint": True}})
        with patch.object(studio.nai, "infill", return_value=image):
            second = studio.inpaint(original, [{"x": 0, "y": 0, "w": 1, "h": 1}], "repair",
                                    model="nai-diffusion-4-5-full", inherit=False, composite="server")["path"]
            third = studio.inpaint(second, [{"x": 0, "y": 0, "w": 1, "h": 1}], "repair",
                                   model="nai-diffusion-4-5-full", inherit=False, composite="server")["path"]
        self.assertEqual(second, folder + "/A-happy.2.png")
        self.assertEqual(third, folder + "/A-happy.3.png")
        grouped = studio.group(folder)
        self.assertEqual(len(grouped["groups"]), 1)
        self.assertEqual(studio.review_page(grouped)["counts"], {"use": 0, "inpaint": 1, "delete": 0, "unreviewed": 2})


if __name__ == "__main__":
    unittest.main()
