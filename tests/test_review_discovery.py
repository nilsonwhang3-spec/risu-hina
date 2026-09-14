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
from app import actions, agent, agentcontext, assets, botsearch, card, codexauth, config, db, files, hostwriteback, main, scripttext, session, skills, store, studio, tooloutput
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

    def test_large_script_raw_search_patch_file_import_and_stale_approval(self):
        self.ctx.deps.mode = "bot"
        original = '-- 한글 \\n "quoted"\r\n' * 9000 + 'local tail = "old"\n'
        entry = {"comment": "large Lua", "effect": [{"type": "triggerlua", "code": original}], "unknown": {"keep": True}}
        sid = card.add_script(self.ck, "triggerscript", entry)
        info = json.loads(self.tool("read_script_text", script_id=sid))
        self.assertIn("일치 횟수", self.tool("propose_script_text_replace", script_id=sid, field="/effect/0/code",
                       revision=info["revision"], find="quoted", replace="ambiguous", reason="test"))
        self.assertIn("/effect/0/code", [r["field"] for r in info["fields"]])
        self.assertIn('local tail = "old"', self.tool("read_script_text", script_id=sid, field="/effect/0/code", query="local tail"))
        self.assertIn('local tail = \\"old\\"', self.tool("read_script", script_id=sid))
        proposed = self.tool("propose_script_text_replace", script_id=sid, field="/effect/0/code", revision=info["revision"],
                             find='local tail = "old"', replace='local tail = "new"', reason="fix")
        aid = re.search(r"id=([a-f0-9]+)", proposed).group(1)
        self.assertEqual(card.script_entry(sid)["entry"], entry)
        actions.decide(aid, True, "bot")
        changed = card.script_entry(sid)["entry"]
        self.assertEqual(changed["effect"][0]["code"], original.replace('"old"', '"new"'))
        self.assertEqual(changed["unknown"], entry["unknown"])
        export = json.loads(self.tool("export_script_text", script_id=sid, field="/effect/0/code", path="projects/code-test/full.lua"))
        path = files._resolve(files.SPACE, export["path"])
        self.assertEqual(path.read_bytes().decode(), changed["effect"][0]["code"])
        path.write_bytes((original + '-- imported\n').encode())
        proposed = self.tool("propose_script_text_from_file", script_id=sid, field="/effect/0/code", revision=export["revision"], path=export["path"], reason="file edit")
        aid = re.search(r"id=([a-f0-9]+)", proposed).group(1)
        path.write_text("later file edit must not change approval snapshot", encoding="utf-8")
        actions.decide(aid, True, "bot")
        self.assertEqual(card.script_entry(sid)["entry"]["effect"][0]["code"], original + '-- imported\n')
        revision = scripttext.digest(card.script_entry(sid)["entry"])
        args = scripttext.replacement(self.ck, sid, "/effect/0/code", revision, find="imported", replace="stale")
        pending = actions.propose("script_edit", chat_key="", char_key=self.ck, summary="stale", args=args)
        card.update_script(sid, {**card.script_entry(sid)["entry"], "comment": "concurrent edit"})
        with self.assertRaises(actions.ActionError): actions.decide(pending["id"], True, "bot")
        self.assertEqual(card.script_entry(sid)["entry"]["comment"], "concurrent edit")
        with self.assertRaises(ValueError): scripttext.current("another-bot", sid)

    def test_lua_full_file_editor_roundtrip_and_stale_save(self):
        content = '-- 한글 \\n\n' * 30000
        result = files.upload(files.SPACE, "editor.LUA", text=content, into="projects/code-editor")
        self.assertTrue(files.read(files.SPACE, result["path"])["textual"])
        loaded = main.h_file_text({"path": result["path"]})
        self.assertEqual(loaded["content"], content)
        main.h_file_text({"path": result["path"], "content": content + "-- edited", "revision": loaded["revision"]})
        with self.assertRaises(main.ApiError):
            main.h_file_text({"path": result["path"], "content": "stale", "revision": loaded["revision"]})
        self.assertTrue(files.edit_text(files.SPACE, result["path"])["content"].endswith("-- edited"))
        with self.assertRaises(files.FileError): files.edit_text(files.SPACE, "../outside.lua")

    def test_oauth_url_and_exact_code_inputs(self):
        for value in ('http://localhost:1455/auth/callback?code=abc%2Bdef&state=test',
                      'localhost:1455/auth/callback?code=abc%2Bdef&state=test',
                      '127.0.0.1:1455/auth/callback?code=abc%2Bdef&amp;state=test',
                      '?state=test&code=abc%2Bdef', 'abc+def'):
            self.assertEqual(codexauth.parse_login_input(value, 'test'), ('abc+def', 'test'))
        self.assertEqual(codexauth.parse_login_input('exact%2Fcode', 'test')[0], 'exact%2Fcode')
        for value in ('http://localhost:1455/auth/callback?state=test',
                      '?code=abc&state=other', '?code=a&code=b', '?error=access_denied'):
            with self.assertRaises(codexauth.CodexError): codexauth.parse_login_input(value, 'test')
        with patch.dict(codexauth._pending, {'test': {'verifier': 'fake'}}, clear=True), \
             patch.object(codexauth, '_exchange') as exchange, patch.object(codexauth, 'status', return_value={}):
            codexauth.complete_login('abc+def')
            exchange.assert_called_once_with('abc+def', 'fake', 'test')

    def test_lore_scope_defaults_follow_editor_and_explicit_scope_is_preserved(self):
        for editor, expected in (("bot", "global"), ("chat", "local")):
            self.ctx.deps.mode = editor
            result = self.tool("propose_lore_add", comment="canon", keys="key", content="### Canon", reason="requested")
            self.assertIn("제안했습니다", result)
            action_id = re.search(r"id=([a-f0-9]+)", result).group(1)
            self.assertEqual(actions.get(action_id)["args"]["scope"], expected)
        self.ctx.deps.mode = "bot"
        result = self.tool("propose_lore_add", comment="chat event", keys="event", content="event",
                           reason="explicit chat request", scope="local")
        self.assertNotIn("제안했습니다", result)  # scope gate, never silently changed to bot lore
        self.ctx.deps.mode = "studio"
        self.assertIn("scope", self.tool("propose_lore_add", comment="ambiguous", keys="", content="text", reason="request"))

    def test_lore_read_defaults_and_current_chat_isolation(self):
        store.add_lore(self.ck, {"comment": "bot-canon"}, "global")
        store.add_lore(self.ck, {"comment": "current-event"}, "local", "")
        store.add_lore(self.ck, {"comment": "other-event"}, "local", "other-chat")
        self.ctx.deps.mode = "bot"
        self.assertIn("bot-canon", self.tool("read_lore"))
        self.assertNotIn("current-event", self.tool("read_lore"))
        self.ctx.deps.mode = "chat"
        self.assertIn("current-event", self.tool("list_lore"))
        self.assertNotIn("other-event", self.tool("list_lore"))
        self.assertNotIn("bot-canon", self.tool("list_lore"))
        self.assertIn("bot-canon", self.tool("list_lore", scope="global"))

    def test_installed_lore_skill_scope_refresh_preserves_custom_body_and_state(self):
        created = skills.save("RisuAI 로어북 구조", "챗 로어북 항목을 만들 때", "사용자 수정 본문",
                              always=True, enabled=False, sort_order=37)
        skills.refresh_lore_scope_once()
        updated = skills.get(created["slug"])
        self.assertIn("사용자 수정 본문", updated["body"])
        self.assertIn('scope="global"', updated["body"])
        self.assertIn('scope="local"', updated["body"])
        self.assertFalse(updated["enabled"])
        self.assertTrue(updated["always"])
        skills.refresh_lore_scope_once()
        self.assertEqual(updated["body"], skills.get(created["slug"])["body"])

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
