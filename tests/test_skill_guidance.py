"""Skill upgrade preserves custom references and state and discovers the new guide."""
import os
import re
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

    def test_seed_v9_installs_bot_ui_guides_once(self):
        db.mark_migration("skills_seeded_v8")
        skills.seed_once()
        for name, filename in (("RisuAI 옵션 패널 (슬라이딩 드로어)", "risuai-option-panel.md"),
                               ("RisuAI 에셋 출력식", "risuai-asset-output.md"),
                               ("RisuAI 상태창", "risuai-status-panel.md")):
            fresh = skills.find(name)
            self.assertIsNotNone(fresh, name)
            self.assertTrue(fresh["enabled"])
            self.assertIn(fresh["name"], skills.prompt())
            self.assertLessEqual(len(fresh["description"]), skills.MAX_DESCRIPTION)
            self.assertEqual((skills.root()/fresh["slug"]/"references"/filename).read_bytes(),
                             (skills.SEED_DIR/filename).read_bytes())
        before = {x["slug"]: x["revision"] for x in skills.list_all()}
        skills.seed_once()
        self.assertEqual(before, {x["slug"]: x["revision"] for x in skills.list_all()})

    def test_seed_v10_installs_solo_and_regex_guides_once(self):
        db.mark_migration("skills_seeded_v9")
        skills.seed_once()
        for name, filename in (("RisuAI 일인봇 구조와 제작", "risuai-solobot.md"),
                               ("RisuAI 정규식 작성법", "risuai-regex.md")):
            fresh = skills.find(name)
            self.assertIsNotNone(fresh, name)
            self.assertTrue(fresh["enabled"])
            self.assertIn(fresh["name"], skills.prompt())
            self.assertIn(f"references/{filename}", fresh["body"])
            self.assertEqual((skills.root()/fresh["slug"]/"references"/filename).read_bytes(),
                             (skills.SEED_DIR/filename).read_bytes())
        before = {x["slug"]: x["revision"] for x in skills.list_all()}
        skills.seed_once()
        self.assertEqual(before, {x["slug"]: x["revision"] for x in skills.list_all()})

    def test_method_refresh_replaces_references_and_keeps_state(self):
        for filename in skills.METHOD_FILES:
            label = skills.SEED_FILES[filename][0]
            created = skills.save(label, "옛 설명", "사용자 편집 본문", enabled=False, sort_order=37)
            skills.put_file(created["slug"], "references/" + filename, b"custom reference")
        skills.refresh_method_skills_once()
        for filename in skills.METHOD_FILES:
            label, desc, _ = skills.SEED_FILES[filename]
            updated = skills.find(label)
            self.assertEqual(updated["description"], desc)
            self.assertNotIn("사용자 편집 본문", updated["body"])
            self.assertIn(f"references/{filename}", updated["body"])
            self.assertFalse(updated["enabled"])
            self.assertEqual(updated["sortOrder"], 37)
            self.assertEqual((skills.root()/updated["slug"]/"references"/filename).read_bytes(),
                             (skills.SEED_DIR/filename).read_bytes())
        before = {x["slug"]: x["revision"] for x in skills.list_all()}
        skills.refresh_method_skills_once()
        self.assertEqual(before, {x["slug"]: x["revision"] for x in skills.list_all()})

    def test_method_seeds_are_english_with_catalog_room(self):
        hangul = re.compile(r"[가-힣]")
        for filename in skills.METHOD_FILES:
            label, desc, _ = skills.SEED_FILES[filename]
            self.assertLessEqual(len(desc), skills.MAX_DESCRIPTION, filename)
            self.assertIsNone(hangul.search(desc), filename)
            text = (skills.SEED_DIR/filename).read_text(encoding="utf-8")
            if filename in skills.PRESET_SCOPE_FILES.values():
                self.assertIn(skills.PRESET_SCOPE_MARKER, text, filename)
            # read_file pages by offset, but one file should stay a few windows at most.
            self.assertLessEqual(len(text), 60_000, filename)
            ratio = len(hangul.findall(text)) / max(1, len(text))
            self.assertLess(ratio, 0.01, filename)
        lines = [f"- **{label}** — {desc}" for label, desc, _ in skills.SEED_FILES.values()]
        self.assertLess(len("\n".join(lines)) + 400, skills.CATALOG_LIMIT)

    def test_agent_read_pages_by_offset(self):
        from app import files
        target = Path(DATA.name)/"long.md"
        target.write_text("a" * 50 + "b" * 30, encoding="utf-8")
        with patch.object(files, "_resolve", return_value=target):
            first = files.agent_read("space", "long.md", limit=50)
            self.assertTrue(first.startswith("a" * 50))
            self.assertIn("offset=50", first)
            rest = files.agent_read("space", "long.md", offset=50, limit=50)
            self.assertTrue(rest.startswith("b" * 30))
            self.assertNotIn("offset=80", rest)
            self.assertEqual(files.agent_read("space", "long.md"), "a" * 50 + "b" * 30)
            self.assertIn("offset=999", files.agent_read("space", "long.md", offset=999))

    def test_preset_guidance_upgrade_preserves_custom_content_and_state(self):
        name = "RisuAI 시뮬봇 구조와 제작"
        old = "모든 인물을 매 장면에 등장시킬 필요는 없으며 유저의 선택을 대신 확정하지 않는다."
        created = skills.save(name, "custom", "custom body", enabled=False, always=True, sort_order=37)
        skills.put_file(created['slug'], 'references/risuai-simbot.md', ('custom reference\n' + old).encode('utf-8'))
        skills.refresh_preset_scope_once()
        updated = skills.get(created['slug'])
        self.assertIn(skills.PRESET_SCOPE_NOTE, updated['body'])
        self.assertIn('custom body', updated['body'])
        self.assertFalse(updated['enabled'])
        self.assertTrue(updated['always'])
        self.assertEqual(updated['sortOrder'], 37)
        ref = (skills.root()/created['slug']/'references/risuai-simbot.md').read_text(encoding='utf-8')
        self.assertIn('custom reference', ref)
        self.assertIn(skills.PRESET_SCOPE_NOTE, ref)
        self.assertNotIn(old, ref)
        revision = updated['revision']
        skills.refresh_preset_scope_once()
        self.assertEqual(skills.get(created['slug'])['revision'], revision)

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
