import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
DATA = tempfile.TemporaryDirectory(prefix='hina-rename-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
from app import actions, agent, assetrename, card, config, db
from pydantic_ai.models.test import TestModel
config.load(); db.connect()

class RenameTests(unittest.TestCase):
    def seed(self, names):
        self.ck = self.id()
        live = {'chaId': self.ck, 'name': 'Neutral Bot', 'additionalAssets': [[n, f'assets/{i}.webp', 'webp'] for i, n in enumerate(names)]}
        db.execute('INSERT OR REPLACE INTO characters(char_key,cha_id,card_json,created_at,updated_at) VALUES(?,?,?,?,?)', (self.ck,self.ck,db.js(live),db.now(),db.now()))
        card.set_full(self.ck, True); card.ingest(self.ck, live, reset=True)
        return live

    def test_1301_names_one_approval_no_image_reupload(self):
        live = self.seed([f'hero__happy.{i+2}' for i in range(1301)])
        plan = assetrename.plan(self.ck, '__', '-')
        self.assertEqual(plan['changed'], 1301)
        self.assertEqual(card.changes(self.ck)['total'], 0)
        proposal = actions.propose('asset_rename', chat_key='', char_key=self.ck, summary='Rename', args={'items':plan['items']})
        with self.assertRaises(actions.ActionError): actions.decide(proposal['id'], True, 'chat')
        self.assertEqual(actions.get(proposal['id'])['status'], actions.PENDING)
        actions.decide(proposal['id'], True, 'bot')
        rows = card.patch(self.ck)['assets']['additionalAssets']
        self.assertEqual([r[1:] for r in rows], [r[1:] for r in live['additionalAssets']])
        self.assertEqual(rows[-1][0], 'hero-happy.1302')
        self.assertEqual(db.unjs(db.one('SELECT card_json FROM characters WHERE char_key=?',(self.ck,))['card_json']), live)

    def test_stale_plan_is_atomic(self):
        self.seed(['a__happy', 'b__happy'])
        plan = assetrename.plan(self.ck, '__', '-')
        last = plan['items'][-1]
        card.update_script(last['id'], {**last['before'], 'name':'new'})
        with self.assertRaises(ValueError): assetrename.apply(self.ck, plan['items'])
        self.assertEqual(card.scripts(self.ck,'assetref')[0]['entry']['name'], 'a__happy')

    def test_collisions_variants_filters_and_regex(self):
        self.seed(['a__happy','a-happy','same.2','same.2'])
        self.assertTrue(assetrename.plan(self.ck,'__','-')['blocked'])
        self.assertFalse(assetrename.plan(self.ck,'__','-',allow_merge=True)['blocked'])
        self.assertEqual(assetrename.plan(self.ck, 'same', 'hero', name_filter=r'\.2$')['changed'],2)
        self.assertEqual(assetrename.plan(self.ck,r'^(same)(\.2)$',r'\1-new\2',regex=True)['preview'][0]['after'],'same-new.2')
        with self.assertRaises(ValueError): assetrename.plan(self.ck,'[','-',regex=True)

    def test_agent_tool_registered(self):
        with patch.object(agent, '_model', return_value=TestModel()):
            built = agent.build()
        self.assertIn('rename_assets', built._function_toolset.tools)

    def test_dynamic_lore_and_bulk_delete_follow_mode(self):
        from types import SimpleNamespace
        self.seed(['hero'])
        with patch.object(agent, '_model', return_value=TestModel()):
            built = agent.build()
        tool = built._function_toolset.tools['propose_lore_add'].function
        ctx = SimpleNamespace(deps=agent.Deps(chat_key='', char_key=self.ck, mode='chat', session_id='', workspace_dir=Path(DATA.name)))
        result = tool(ctx, comment='World', keys='world', content='World description', reason='Test', scope='global')
        self.assertIn('봇 편집', result)
        ctx.deps.mode = 'bot'
        result = tool(ctx, comment='Local', keys='local', content='Local description', reason='Test', scope='local')
        self.assertIn('챗 편집', result)
        self.assertIsNotNone(agent.screen_gate('chat', 'script_delete_many'))

    def test_python_cannot_stage_chat_edits_in_bot_mode(self):
        from app import workspace, pyexec, staging
        material = workspace.materialize({'charId':'mode-test', 'characterIndex':0,
            'card':{'name':'Mode Test','chaId':'mode-test','desc':''},
            'chats':[{'chatIndex':0,'chat':{'id':'mode-chat','message':[{'role':'user','data':'Original','chatId':'mode-msg'}]}}]})
        ck, tk = material['charKey'], material['chats'][0]['chatKey']
        code = "import risuhina\nrisuhina.stage('mode-msg', 'Changed', 'Test')\nprint('analysis complete')"
        result = pyexec.run(code,workspace.root(ck),tk,ck,mode='bot')
        self.assertTrue(result['ok'],result)
        self.assertEqual(result['staged'],0)
        self.assertFalse(staging.pending(tk))
        result = pyexec.run(code,workspace.root(ck),tk,ck,mode='chat')
        self.assertEqual(result['staged'],1,result)

if __name__ == '__main__': unittest.main()
