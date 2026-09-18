"""Skill upgrade preserves custom references and state and discovers the new guide."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pyserver"))
DATA = tempfile.TemporaryDirectory(prefix="hina-skill-guidance-", ignore_cleanup_errors=True)
os.environ["RISUHINA_DATA_DIR"] = DATA.name
from app import config, db, skills

db.connect()


class SkillGuidanceTests(unittest.TestCase):
    def setUp(self):
        migrations = set()
        for patcher in (
            patch.object(skills, "root", return_value=Path(DATA.name)/self._testMethodName),
            patch.object(db, "has_migration", side_effect=lambda key: key in migrations),
            patch.object(db, "mark_migration", side_effect=migrations.add),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_upgrade_preserves_custom_guidance_and_state(self):
        for name, (filename, _) in skills.LORE_AUTHORING_NOTES.items():
            created = skills.save(name, "custom description", "사용자 편집 본문", always=True,
                                  enabled=False, sort_order=37)
            skills.put_file(created["slug"], "references/" + filename, b"custom reference")
        skills.refresh_lore_authoring_once()
        for name, (filename, guidance) in skills.LORE_AUTHORING_NOTES.items():
            updated = skills.find(name)
            self.assertIn(guidance, updated["body"])
            self.assertTrue(updated["body"].endswith("사용자 편집 본문"))
            self.assertEqual(updated["description"], "custom description")
            self.assertTrue(updated["always"])
            self.assertFalse(updated["enabled"])
            self.assertEqual(updated["sortOrder"], 37)
            self.assertEqual((skills.root()/updated["slug"]/"references"/filename).read_bytes(), b"custom reference")
        before = {x["slug"]: x["revision"] for x in skills.list_all()}
        skills.refresh_lore_authoring_once()
        self.assertEqual(before, {x["slug"]: x["revision"] for x in skills.list_all()})

    def test_seed_upgrade_installs_new_guide_once(self):
        db.mark_migration("skills_seeded_v7")
        skills.seed_once()
        fresh = skills.find("RisuAI 시뮬봇 구조와 제작")
        self.assertIsNotNone(fresh)
        self.assertTrue(fresh["enabled"])
        self.assertFalse(fresh["always"])
        self.assertIn(fresh["name"], skills.prompt())
        self.assertEqual((skills.root()/fresh["slug"]/"references/risuai-simbot.md").read_bytes(),
                         (skills.SEED_DIR/"risuai-simbot.md").read_bytes())
        before = {x["slug"]: x["revision"] for x in skills.list_all()}
        skills.seed_once()
        self.assertEqual(before, {x["slug"]: x["revision"] for x in skills.list_all()})

    def test_current_reference_does_not_get_duplicate_guidance(self):
        name = "RisuAI CBS 문법"
        filename = "risuai-cbs.md"
        created = skills.save(name, "current", "Read current reference", slug=(skills.find(name) or {}).get("slug"))
        skills.put_file(created["slug"], "references/" + filename, (skills.SEED_DIR/filename).read_bytes())
        with patch.object(skills, "LORE_AUTHORING_KEY", "test_current_reference"), \
             patch.object(skills, "LORE_AUTHORING_NOTES", {name: skills.LORE_AUTHORING_NOTES[name]}):
            skills.refresh_lore_authoring_once()
        self.assertEqual(skills.get(created["slug"])["body"], "Read current reference")


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        db.close()
