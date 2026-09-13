"""Approval stages PNG/WebP locally; only write-back may register with the host."""
import io
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
DATA = tempfile.TemporaryDirectory(prefix='hina-staged-assets-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image
from app import actions, assets, card, config, db, files, main, session
from pydantic_ai.messages import FunctionToolResultEvent, ToolReturnPart

config.load(); db.connect()

class StagedAssets(unittest.TestCase):
    def setUp(self):
        self.ck = self.id()
        self.live = {'chaId': self.ck, 'name': 'Neutral Test Bot', 'desc': '', 'additionalAssets': []}
        db.execute('INSERT INTO characters(char_key,cha_id,card_json,created_at,updated_at) VALUES(?,?,?,?,?)',
                   (self.ck, self.ck, db.js(self.live), db.now(), db.now()))
        card.set_full(self.ck, True)
        card.ingest(self.ck, self.live, reset=True)
        self.folder = files._root(files.SPACE) / 'projects' / self._testMethodName
        self.folder.mkdir(parents=True, exist_ok=True)

    def image(self, name, fmt='WEBP', color='blue'):
        buf = io.BytesIO(); Image.new('RGB', (4, 4), color).save(buf, fmt)
        p = self.folder / name; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(buf.getvalue())
        return p.relative_to(files._root(files.SPACE)).as_posix(), buf.getvalue()

    def approve(self, items, kind='host_asset_add_many'):
        action = actions.propose(kind, chat_key='', char_key=self.ck, summary='Neutral asset batch',
                                 args={'items': items} if kind.endswith('_many') else items[0])
        self.assertFalse(actions.get(action['id'])['byHost'])
        return actions.decide(action['id'], True)

    def test_approval_snapshots_webp_and_counts_pending_without_host_write(self):
        path, data = self.image('hero-happy.2.webp')
        result = self.approve([{'name': 'hero-happy', 'path': path}])
        self.assertNotIn('host', result)
        self.assertIn('아직 RisuAI', result['result'])
        self.assertEqual(card.changes(self.ck)['assetref']['added'], 1)
        key = card.patch(self.ck)['assets']['additionalAssets'][0][1]
        self.assertTrue(key.startswith(assets.PENDING_PREFIX))
        self.assertEqual(card.patch(self.ck)['assets']['additionalAssets'][0][2], 'webp')
        files._resolve(files.SPACE, path).unlink()
        db.close(); db.connect()
        self.assertEqual(assets.read_bytes(key)[0], data)
        self.assertEqual(db.unjs(db.one('SELECT card_json FROM characters WHERE char_key=?', (self.ck,))['card_json']), self.live)
        self.assertTrue(any(i.get('pending') and i['state'] == 'present' for i in assets.listing(self.ck)['items']))
        assets.gc(0)
        self.assertEqual(assets.read_bytes(key)[0], data)
        with self.assertRaises(main.ApiError): main.h_card_patch({'charKey': self.ck})
        self.assertEqual(main.h_card_patch({'charKey': self.ck, 'stagedAssets': '1'})['assets']['changed'], 1)

    def test_reset_discards_pending_card_change_and_keeps_original_file(self):
        path, _ = self.image('hero.webp')
        self.approve([{'name': 'hero', 'path': path}])
        card.reset_working(self.ck)
        self.assertEqual(card.changes(self.ck)['total'], 0)
        self.assertTrue(files._resolve(files.SPACE, path).is_file())

    def test_replace_is_staged_and_invalid_batch_is_atomic(self):
        initial = {**self.live, 'additionalAssets': [['hero', 'assets/existing.png', 'png']]}
        card.ingest(self.ck, initial, reset=True)
        path, _ = self.image('replacement.webp')
        self.approve([{'name': 'hero', 'path': path}], 'host_asset_replace')
        patch = card.patch(self.ck)
        self.assertEqual(patch['assets']['before']['additionalAssets'], initial['additionalAssets'])
        self.assertEqual(patch['assets']['additionalAssets'][0][2], 'webp')
        before = card.changes(self.ck)
        with self.assertRaises(assets.AssetError):
            assets.stage_changes(self.ck, 'host_asset_replace', [{'name': 'hero', 'path': path}, {'name': 'missing', 'path': path}])
        self.assertEqual(card.changes(self.ck), before)

    def test_folder_supports_1301_files_and_preserves_variant_names(self):
        path, data = self.image('hero-happy.2.webp')
        self.image('hero-happy.3.png', 'PNG', 'red')
        for i in range(1299): (self.folder / f'character{i}-happy.webp').write_bytes(data)
        folder = self.folder.relative_to(files._root(files.SPACE)).as_posix()
        plan = assets.stage_folder(folder)
        self.assertEqual(len(plan['items']), 1301)
        self.assertEqual(sum(i['name'] == 'hero-happy' for i in plan['items']), 2)
        self.approve(plan['items'])
        rows = card.scripts(self.ck, card.ASSET_KIND)
        self.assertEqual(len(rows), 1301)
        self.assertEqual([r['seq'] for r in rows], list(range(1301)))
        self.assertEqual(card.changes(self.ck)['total'], 1301)

    def test_host_png_key_keeps_original_webp_bytes_in_cache(self):
        path, data = self.image('hero.webp')
        self.approve([{'name': 'hero', 'path': path}])
        key = card.patch(self.ck)['assets']['additionalAssets'][0][1]
        main.h_assets_adopt({'charKey': self.ck, 'sourceKey': key, 'key': 'assets/host-webp.png'})
        self.assertEqual(assets.read_bytes('assets/host-webp.png'), (data, 'webp'))

    def test_real_sdk_result_event_is_recorded_and_streamed(self):
        sid = self.ck
        db.execute('INSERT INTO sessions(id,chat_key,title,created_at,updated_at) VALUES(?,?,?,?,?)', (sid, '', '', db.now(), db.now()))
        event = FunctionToolResultEvent(part=ToolReturnPart('test_tool', 'Working copy saved; not written to host', 'c1'))
        session._checkpoint(sid, event)
        self.assertEqual(session.work_log(sid)[0]['tool'], 'test_tool')
        self.assertIn('not written to host', session.work_log(sid)[0]['result'])

if __name__ == '__main__': unittest.main()
