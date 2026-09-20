"""Persistent plans, execution boundary, context retention and learning checkpoints."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
DATA = tempfile.TemporaryDirectory(prefix='hina-plans-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
from app import agent, agentcontext, agentnotes, config, db, learning, main, session, skills, workplan
from pydantic_ai import Agent
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

config.load(); db.connect()
db.execute('INSERT INTO characters(char_key,created_at,updated_at) VALUES(?,?,?)', ('bot', db.now(), db.now()))
db.execute('INSERT INTO chats(chat_key,char_key,created_at,updated_at) VALUES(?,?,?,?)', ('chat', 'bot', db.now(), db.now()))

class Plans(unittest.TestCase):
    def setUp(self):
        self.sid = self.id()
        db.execute('INSERT INTO sessions(id,chat_key,title,created_at,updated_at) VALUES(?,?,?,?,?)',
                   (self.sid, 'chat', '', db.now(), db.now()))
        self.deps = agent.Deps('chat', '', self.sid, Path(DATA.name))
        self.todo = [{'id': 'a', 'title': 'Check behavior', 'status': 'pending', 'evidence': ''}]

    def test_concurrent_plan_and_checkpoint_do_not_deadlock(self):
        # Isolate the deliberate lock interleaving so regressions fail on timeout
        # rather than hanging the entire test runner with a blocked DB lock.
        import subprocess
        script = r"""
import threading
import test_workplan as t
case = t.Plans('test_persistent_revision_and_evidence')
case.setUp()
original = t.db.LOCK
waiting = threading.Event()
errors = []
class ObservedLock:
    def __enter__(self):
        if threading.current_thread().name == 'checkpoint':
            waiting.set()
        original.acquire()
        return self
    def __exit__(self, *args):
        original.release()
t.db.LOCK = ObservedLock()
def checkpoint():
    try:
        t.session._save_message(case.sid, 'history', {'checkpoint': True})
    except BaseException as exc:
        errors.append(exc)
with t.db.transaction():
    worker = threading.Thread(target=checkpoint, name='checkpoint', daemon=True)
    worker.start()
    assert waiting.wait(3), 'checkpoint did not reach DB lock'
    t.workplan.save(case.sid, 0, document='Concurrent plan', tasks=case.todo)
worker.join(3)
assert not worker.is_alive(), 'checkpoint deadlocked'
assert not errors, errors
rows = t.db.query('SELECT seq, role FROM agent_messages WHERE session_id=? ORDER BY seq', (case.sid,))
assert [(r['seq'], r['role']) for r in rows] == [(0, 'plan'), (1, 'history')]
assert t.workplan.get(case.sid)['revision'] == 1
t.db.close()
"""
        result = subprocess.run([sys.executable, '-c', script], cwd=Path(__file__).parent,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_persistent_revision_and_evidence(self):
        workplan.save(self.sid, 0, document='# Plan\nKeep user constraint', tasks=self.todo, mode='plan')
        db.close(); db.connect()
        self.assertEqual(workplan.get(self.sid)['mode'], 'plan')
        self.assertEqual(workplan.get('another')['revision'], 0)
        with self.assertRaises(ValueError): workplan.save(self.sid, 0, document='stale')
        self.todo[0]['status'] = 'completed'
        with self.assertRaises(ValueError): workplan.save(self.sid, 1, tasks=self.todo)
        self.todo[0]['evidence'] = 'Verified output file'
        self.assertEqual(workplan.save(self.sid, 1, tasks=self.todo)['tasks'][0]['status'], 'completed')
        self.assertEqual(len(session.messages(self.sid)), 0)

    def test_single_active_task_and_duplicate_ids(self):
        with self.assertRaises(ValueError): workplan.save(self.sid, 0, tasks=self.todo * 2)
        tasks = [dict(self.todo[0], id=str(i), status='in_progress') for i in range(2)]
        with self.assertRaises(ValueError): workplan.save(self.sid, 0, tasks=tasks)

    def test_mode_api_is_scoped_and_busy_safe(self):
        with patch.object(main, '_chat', return_value='other'):
            with self.assertRaises(main.ApiError): main.h_workplan({'sessionId': self.sid})
        with patch.object(main, '_chat', return_value='chat'):
            session._ACTIVE[self.sid] = asyncio.Event()
            try:
                with self.assertRaises(main.ApiError):
                    main.h_workplan({'sessionId': self.sid, 'mode': 'plan', 'revision': 0})
            finally: session._ACTIVE.pop(self.sid)
            self.assertEqual(main.h_workplan({'sessionId': self.sid, 'mode': 'plan', 'revision': 0})['mode'], 'plan')

    def test_guard_blocks_real_tool_execution(self):
        workplan.save(self.sid, 0, mode='plan')
        invoked = []
        def model(messages, info):
            if len(messages) == 1:
                return ModelResponse(parts=[ToolCallPart('write_file', {}, 'w'), ToolCallPart('read_plan', {}, 'r')])
            return ModelResponse(parts=[TextPart('done')])
        ag = Agent(FunctionModel(model), deps_type=agent.Deps, capabilities=[workplan.PlanGuard()])
        @ag.tool_plain
        def write_file(): invoked.append('write'); return 'written'
        @ag.tool_plain
        def read_plan(): invoked.append('read'); return 'read'
        asyncio.run(ag.run('plan only', deps=self.deps))
        self.assertEqual(invoked, ['read'])
        workplan.save(self.sid, 1, mode='execute')
        asyncio.run(ag.run('execute', deps=self.deps))
        self.assertIn('write', invoked)
        self.assertNotIn('run_python', workplan.PLAN_TOOLS)
        self.assertNotIn('improve_skill', workplan.PLAN_TOOLS)

    def test_plan_survives_compaction_and_resume(self):
        workplan.save(self.sid, 0, document='UNIQUE plan constraint', tasks=self.todo)
        def model(messages, info): return ModelResponse(parts=[TextPart('summary')])
        messages = [ModelRequest(parts=[UserPromptPart(workplan.prompt(self.sid))])]
        for i in range(8):
            messages += [ModelRequest(parts=[UserPromptPart('next')]), ModelResponse(parts=[TextPart('x' * 3000)])]
        compacted, _ = asyncio.run(agentcontext.compress(messages, 4500, FunctionModel(model), self.sid, force=True))
        self.assertTrue(any('UNIQUE plan constraint' in str(getattr(p, 'content', '')) for m in compacted for p in m.parts))
        ag = Agent(FunctionModel(model), deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        result = asyncio.run(ag.run('continue', message_history=compacted, deps=self.deps))
        self.assertIn('UNIQUE plan constraint', str(result.all_messages()))
        workplan.save(self.sid, 1, document='UPDATED user constraint')
        result = asyncio.run(ag.run('continue', message_history=result.all_messages(), deps=self.deps))
        self.assertIn('UPDATED user constraint', str(result.new_messages()))

    def test_learning_review_is_optional_and_never_blocks_the_answer(self):
        # §1-62: the forced end-of-turn review is gone. A final answer after
        # tool work passes through; review_learning still records when called.
        before = agentnotes.recall('')
        ctx = SimpleNamespace(deps=self.deps, usage=RunUsage(tool_calls=5))
        self.assertEqual(learning.validate(ctx, 'final answer'), 'final answer')
        self.assertFalse(db.one("SELECT seq FROM agent_messages WHERE session_id=? AND role='learning_review'", (self.sid,)))
        learning.record(ctx, 'Saved the approved reference strengths as a project note.')
        self.assertTrue(db.one("SELECT seq FROM agent_messages WHERE session_id=? AND role='learning_review'", (self.sid,)))
        self.assertEqual(agentnotes.recall(''), before)

    def test_real_model_answers_without_a_learning_review(self):
        count = 0
        def model(messages, info):
            nonlocal count
            count += 1
            if count == 1:
                return ModelResponse(parts=[ToolCallPart('read_plan', {}, '1'), ToolCallPart('read_plan', {}, '2')])
            return ModelResponse(parts=[TextPart('done')])
        with patch.object(agent, '_model', return_value=FunctionModel(model)):
            ag = agent.build()
        result = asyncio.run(ag.run('Inspect plan', deps=self.deps))
        self.assertEqual(result.output, 'done')
        self.assertEqual(count, 2, 'no retry, no extra model call for a review')

    def test_instructions_make_plans_and_notes_on_request_only(self):
        with patch.object(agent, '_model', return_value=TestModel()): ag = agent.build()
        text = ' '.join(f(SimpleNamespace(deps=self.deps)) if callable(f) else str(f)
                        for f in getattr(ag, '_instructions_functions', []))
        if not text:
            text = str(getattr(ag, '_instructions', '')) + ' ' + str(learning.instructions())
        self.assertNotIn('Read recall_notes first', text + learning.instructions())
        self.assertIn('Most turns need no note', learning.instructions())
        self.assertNotIn('then call review_learning', learning.instructions())

    def test_plan_is_handed_over_once_per_run_not_after_each_update(self):
        workplan.save(self.sid, 0, document='Plan v1', tasks=self.todo)
        seen = []
        def model(messages, info):
            seen.append(sum(1 for m in messages for p in m.parts
                            if isinstance(getattr(p, 'content', None), str) and p.content.startswith(workplan.MARKER)))
            if len(messages) == 1:
                return ModelResponse(parts=[ToolCallPart('bump', {}, 'b')])
            return ModelResponse(parts=[TextPart('done')])
        ag = Agent(FunctionModel(model), deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        @ag.tool_plain
        def bump():
            workplan.save(self.sid, 1, document='Plan v2')
            return 'bumped'
        result = asyncio.run(ag.run('go', deps=self.deps))
        self.assertEqual(seen, [1, 1], 'the plan rides on the user turn; the tool step does not re-send it')
        self.assertNotIn('Plan v2', str(result.all_messages()).replace('bumped', ''))
        result = asyncio.run(ag.run('again', message_history=result.all_messages(), deps=self.deps))
        self.assertIn('Plan v2', str(result.new_messages()), 'the next user turn carries the revised plan')

    def test_learning_review_is_visible_and_project_scoped(self):
        ctx = SimpleNamespace(deps=self.deps)
        learning.record(ctx, 'Checked memories and skills; no new reusable lesson.')
        self.assertTrue(learning.recent('bot'))
        self.assertEqual(learning.recent('another-bot'), [])
        self.assertIn('no new reusable lesson', main.h_agent_learning({'charKey': 'bot'})['reviews'][0]['summary'])

    def test_read_endpoint_cannot_switch_mode(self):
        with patch.object(main, '_chat', return_value='chat'):
            result = main.h_workplan_get({'sessionId': self.sid, 'mode': 'plan', 'revision': 0})
        self.assertEqual(result['mode'], 'execute')
        self.assertEqual(result['revision'], 0)

    def test_internal_learning_tools_and_disabled_memory(self):
        with patch.object(agent, '_model', return_value=TestModel()): ag = agent.build()
        ctx = SimpleNamespace(deps=self.deps)
        tools = ag._function_toolset.tools
        result = json.loads(tools['remember_note'].function(ctx, title='Global style', body='Use polite Korean',
                            evidence='User explicitly requested this globally', shared=True))
        self.assertEqual(agentnotes.recall('')[0]['id'], result['id'])
        with patch.object(config, 'section', return_value={'memoryEnabled': False}):
            self.assertIn('꺼져', tools['remember_note'].function(ctx, title='X', body='Y', evidence='Z', shared=True))
            self.assertIn('disabled', learning.instructions())
        result = json.loads(tools['improve_skill'].function(ctx, name='Test learned procedure', description='A verified method',
                            body='Use the checked procedure for this test only.', evidence='Offline regression verified it'))
        self.assertTrue(result['revision'])
        self.assertEqual(skills.get(result['id'])['body'], 'Use the checked procedure for this test only.')

if __name__ == '__main__': unittest.main()
