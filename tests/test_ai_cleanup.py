"""Cleanup is previewed, deletes for real, and is confined to disposable AI work files."""
import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
os.environ['RISUHINA_DATA_DIR'] = tempfile.mkdtemp(prefix='hina-clean-config-')
from app import files, session, workspace


class Cleanup(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'space'
        self.root.mkdir()
        self.mapping = patch.object(workspace, 'space_root', return_value=self.root)
        self.mapping.start()
        self.addCleanup(self.mapping.stop)

    def put(self, relative, text='keep'):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def test_preview_then_delete_preserves_user_material(self):
        selected = ['hina/Bot/scratch/tmp.txt', 'hina/Bot/scripts/_agent_run.py',
                    'hina/Bot/.cache/temp.bin', 'hina/Bot/scripts/__pycache__/a.pyc',
                    'hina/.cleanup/20260901-000000-abcd/hina/Bot/scratch/old.txt']
        protected = ['projects/Bot/.hidden', 'studio/output/picture.webp', '.hina/bots.json',
                     'hina/Bot/scripts/useful.py', 'hina/Bot/skills/demo/.cache/keep',
                     'hina/Bot/scratch/.git/config', 'hina/Bot/scratch/.env',
                     'hina/Bot/scratch/config.json', 'hina/Bot/.unknown',
                     'hina/Bot/scratch/repo/.git', 'hina/Bot/scratch/.npmrc']
        for rel in selected + protected:
            self.put(rel, rel)
        preview = files.cleanup_ai()
        self.assertEqual(set(preview['paths']), set(selected))
        self.assertTrue(all((self.root / rel).exists() for rel in selected))
        result = files.cleanup_ai(preview['plan'])
        self.assertEqual(result['removed'], len(selected))
        self.assertEqual(result['freed'], sum(len(rel) for rel in selected))
        self.assertFalse(result['failed'])
        for rel in selected:
            self.assertFalse((self.root / rel).exists())
        self.assertFalse((self.root / 'hina' / '.cleanup').exists(), 'an old quarantine goes with the rest')
        # The roots the runner writes into survive, emptied; deeper folders go.
        self.assertTrue((self.root / 'hina/Bot/scratch').is_dir())
        self.assertTrue((self.root / 'hina/Bot/scripts').is_dir())
        self.assertFalse((self.root / 'hina/Bot/scripts/__pycache__').exists())
        self.assertTrue(all((self.root / rel).exists() for rel in protected))
        self.assertEqual(files.cleanup_ai()['count'], 0)

    def test_changed_preview_does_not_delete_any_files(self):
        a = self.put('hina/Bot/scratch/a.txt')
        plan = files.cleanup_ai()['plan']
        self.put('hina/Bot/scratch/b.txt')
        with self.assertRaises(files.FileError): files.cleanup_ai(plan)
        self.assertTrue(a.exists())

    def test_running_agent_blocks_preview_and_apply(self):
        with patch.object(session, '_ACTIVE', {'test': asyncio.Event()}):
            with self.assertRaises(files.FileError): files.cleanup_ai()

    def test_external_symlink_is_not_followed(self):
        external = Path(self.temp.name) / 'outside'
        external.mkdir()
        (external / 'keep.tmp').write_text('outside')
        link = self.root / 'hina' / 'Bot' / 'scratch'
        link.parent.mkdir(parents=True)
        try:
            link.symlink_to(external, target_is_directory=True)
        except OSError:
            if os.name != 'nt':
                self.skipTest('OS does not permit creating symlinks')
            import subprocess
            made = subprocess.run(['cmd', '/c', 'mklink', '/J', str(link), str(external)], capture_output=True)
            if made.returncode:
                self.skipTest('OS does not permit creating links or junctions')
        self.assertEqual(files.cleanup_ai()['count'], 0)
        self.assertEqual((external / 'keep.tmp').read_text(), 'outside')


if __name__ == '__main__': unittest.main()
