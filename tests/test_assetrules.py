"""Offline contracts: multiple profiles, exceptions, lineage and random alternatives."""
from __future__ import annotations

import copy
import io
import os
import re
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-rules-", ignore_cleanup_errors=True)
sys.stdout.reconfigure(encoding="utf-8")
os.environ["RISUHINA_DATA_DIR"] = DATA.name
from app import assetrules as ar, config, db, files, nai, studio, workspace
from PIL import Image

config.load()
db.connect()


def png(color="red"):
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buf, "PNG")
    return buf.getvalue()


class AssetRulesTest(unittest.TestCase):
    def setUp(self):
        self.project = self.id().split(".")[-1]
        self.folder = "studio/output/" + self.project
        self.doc = ar.save(self.project, {"revision": 0, "rules": [
            {"id": "basic", "name": "표정", "template": "{character}-{emotion}", "extension": "webp"},
            {"id": "costume", "name": "복장", "template": "{character}_{emotion}_{outfit}_{variant}",
             "extension": "png", "empty": {"variant": "base"}},
        ], "sets": [
            {"id": "expressions", "name": "표정 세트", "ruleId": "basic", "characters": [],
             "slots": [{"id": "happy", "fields": {"emotion": "happy"}, "status": "required"},
                       {"id": "sad", "fields": {"emotion": "sad"}, "status": "optional"}],
             "overrides": {"B": {"happy": "excluded", "sad": "required"}}},
            {"id": "uniforms", "name": "복장 세트", "ruleId": "costume", "characters": ["A"],
             "slots": [{"id": "uniform", "fields": {"emotion": "happy", "outfit": "uniform"}, "status": "optional"}],
             "overrides": {}},
        ]})

    def binding(self, character="A", set_id="expressions", slot="happy"):
        return {"project": self.project, "setId": set_id, "slotId": slot, "fields": {"character": character}}

    def save_candidate(self, binding=None, color="red"):
        asset = ar.candidate(ar.resolve(binding or self.binding()))
        name = Path(asset["exportName"]).stem + ".png"
        return studio.save_image(self.folder, name, png(color), {"asset": asset})["path"]

    def test_multiple_rules_and_exceptions(self):
        self.assertEqual(ar.resolve(self.binding())["exportName"], "A-happy.webp")
        self.assertEqual(ar.resolve(self.binding(set_id="uniforms", slot="uniform"))["exportName"], "A_happy_uniform_base.png")
        with self.assertRaises(ar.RuleError): ar.resolve(self.binding("B"))
        with self.assertRaises(ar.RuleError): ar.resolve(self.binding("B", "uniforms", "uniform"))
        self.assertEqual(ar.coverage(self.project, "B", [])["missing"], [{"setId": "expressions", "slotId": "sad", "status": "required", "present": False}])
        self.assertTrue(ar.coverage(self.project, "A", [ar.resolve(self.binding())])["complete"])

    def test_numbered_files_round_trip_without_new_slots(self):
        rule = self.doc["rules"][0]
        for n in [1, 2, 3, 9, 10, 123]:
            name = ar.numbered("A-happy.webp", n)
            self.assertEqual(re.fullmatch(ar.pattern(rule), name).groups(), ("A", "happy"))
            matches = ar.classify(self.project, name)
            self.assertEqual(len(matches), 1)
            self.assertEqual(matches[0]["slotId"], "happy")
            self.assertEqual(ar.bot_name(matches[0]), "A-happy")

    def test_concurrent_candidates_never_overwrite(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            paths = list(pool.map(lambda _: self.save_candidate(), range(4)))
        self.assertEqual({Path(p).name for p in paths}, {"A-happy.png", "A-happy.2.png", "A-happy.3.png", "A-happy.4.png"})
        self.assertEqual(len({ar.metadata(files._resolve(files.SPACE, p))["imageId"] for p in paths}), 4)

    def test_plan_checks_slots_before_generation(self):
        spec = {"asset": self.binding(), "styles": [], "characters": [], "count": 2}
        items = studio.plan(spec)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["folder"], self.folder)
        self.assertEqual(items[0]["name"], "A-happy.png")
        self.assertNotEqual(items[0]["asset"]["imageId"], items[1]["asset"]["imageId"])
        with self.assertRaises(ar.RuleError): studio.plan({**spec, "asset": self.binding("B")})
        with self.assertRaises(studio.StudioError): studio.build_name("{character}-{scene}")

    def test_generation_inpaint_rename_export_and_adoption(self):
        first = self.save_candidate()
        second = self.save_candidate(color="blue")
        self.assertEqual(Path(second).name, "A-happy.2.png")
        with patch.object(nai, "infill", return_value=png("green")):
            third = studio.inpaint(first, [{"x": .1, "y": .1, "w": .5, "h": .5}], "repair",
                                   model="nai-diffusion-4-5-full", composite="server", inherit=False)["path"]
        self.assertEqual(Path(third).name, "A-happy.3.png")
        identity = ar.metadata(files._resolve(files.SPACE, first))
        self.assertEqual(ar.metadata(files._resolve(files.SPACE, third))["parentId"], identity["imageId"])
        studio.write_selection(self.folder, {Path(p).name: {"use": True} for p in [first, second, third]})
        studio.rename_apply(self.folder, [{"from": Path(second).name, "to": "renamed.png"}])
        grouped = studio.group(self.folder, r"DOES_NOT_MATCH", "arbitrary")
        self.assertEqual(len(grouped["groups"]), 1)
        self.assertEqual(len(grouped["groups"][0]["items"]), 3)
        preview = studio.export_selected(self.folder, preview=True)
        self.assertEqual(preview["problems"], [])
        self.assertEqual([x["target"] for x in preview["mapping"]], ["A-happy.webp", "A-happy.2.webp", "A-happy.3.webp"])
        self.assertEqual({x["assetName"] for x in preview["mapping"]}, {"A-happy"})
        self.assertFalse(files._resolve(files.SPACE, self.folder + "/selected").exists())
        result = studio.export_selected(self.folder)
        self.assertEqual(result["used"], 3)
        for entry in result["mapping"]:
            path = result["folder"] + "/" + entry["target"]
            with Image.open(files._resolve(files.SPACE, path)) as im: self.assertEqual(im.format, "WEBP")
            prepared = ar.adoption(path)
            self.assertEqual(prepared["name"], "A-happy")
            self.assertTrue(files._resolve(files.SPACE, prepared["path"]).read_bytes().startswith(b"\x89PNG"))
        self.assertTrue(ar.coverage(self.project, "A", ar.selected_assets(self.folder))["complete"])

    def test_identical_imports_can_have_different_slots(self):
        base = files._resolve(files.SPACE, self.folder)
        base.mkdir(parents=True)
        (base / "one.png").write_bytes(png())
        (base / "two.png").write_bytes(png())
        ar.bind(self.folder + "/one.png", self.binding())
        ar.bind(self.folder + "/two.png", self.binding(slot="sad"))
        self.assertEqual(ar.metadata(base / "one.png")["slotId"], "happy")
        self.assertEqual(ar.metadata(base / "two.png")["slotId"], "sad")
        studio.rename_apply(self.folder, [{"from": "one.png", "to": "other.png"}])
        self.assertEqual(ar.metadata(base / "other.png")["slotId"], "happy")

    def test_ambiguous_import_and_optimistic_revision(self):
        doc = copy.deepcopy(self.doc)
        extra = copy.deepcopy(doc["sets"][0]); extra["id"] = "duplicate"
        doc["sets"].append(extra)
        ar.save(self.project, doc)
        self.assertEqual(len(ar.classify(self.project, "A-happy.2.webp")), 2)
        with self.assertRaises(ar.RuleError): ar.save(self.project, doc)

    def test_failed_export_keeps_previous_files(self):
        first = self.save_candidate()
        studio.write_selection(self.folder, {Path(first).name: {"use": True}})
        result = studio.export_selected(self.folder)
        out = files._resolve(files.SPACE, result["folder"]) / "A-happy.webp"
        before = out.read_bytes()
        doc = ar.read(self.project)
        doc["sets"][0]["overrides"]["A"] = {"happy": "excluded"}
        ar.save(self.project, doc)
        with self.assertRaises(ar.RuleError): studio.export_selected(self.folder)
        self.assertEqual(out.read_bytes(), before)

    def test_paths_and_ambiguous_delimiters(self):
        for p in ["../escape", "A/B", "CON", "C:\\path"]:
            with self.assertRaises(ar.RuleError): ar.read(p)
        with self.assertRaises(ar.RuleError):
            ar.render(self.doc["rules"][0], {"character": "A-B", "emotion": "happy"})
        with self.assertRaises(files.FileError): ar.bind("../outside.png", self.binding())

    def test_agent_tool_registration(self):
        from app import agent
        from pydantic_ai.models.test import TestModel
        with patch.object(agent, "_model", return_value=TestModel()):
            built = agent.build()
        self.assertIn("studio_asset_rules", built._function_toolset.tools)

    def test_http_rules_and_plan_errors(self):
        from test_http import Server
        server = Server()
        try:
            self.assertTrue(server.wait_ready())
            doc = copy.deepcopy(self.doc); doc["revision"] = 0
            status, result = server.post("/studio/asset-rules", {"project": self.project, "document": doc})
            self.assertEqual(status, 200, result)
            self.assertEqual(result["revision"], 1)
            status, result = server.post("/studio/asset-rules", {"project": self.project, "document": doc})
            self.assertEqual(status, 400, result)
            for character, expected in [("A", 200), ("B", 400)]:
                status, result = server.post("/studio/plan", {"styles": [], "characters": [], "asset": self.binding(character)})
                self.assertEqual(status, expected, result)
            status, result = server.post("/studio/asset-bind", {"path": "../outside.png", "asset": self.binding()})
            self.assertEqual(status, 400, result)
        finally:
            server.stop()


if __name__ == "__main__":
    unittest.main()
