"""Dialogue retention, durable handoff, and stable prompt prefixes."""
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
DATA = tempfile.TemporaryDirectory(prefix='hina-continuity-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
sys.stdout.reconfigure(encoding='utf-8')
from app import agent, agentcontext, config, continuity, db, session
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessagesTypeAdapter, ModelRequest, ModelResponse, TextPart, ThinkingPart, ToolCallPart, ToolReturnPart, UserPromptPart
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.usage import RequestUsage

config.load()
db.connect()

def user(text):
    return ModelRequest(parts=[UserPromptPart(content=text)])

def text_of(messages):
    return '\n'.join(str(getattr(p, 'content', '')) for m in messages for p in m.parts)

def dialogue():
    messages = [user('Use specified style; never overwrite existing files.'),
                ModelResponse(parts=[TextPart(content='Confirmed: file A exists; B remains pending.')]),
                user(agentcontext.SUMMARY_MARKER + ']\nEarlier decision: preserve alternatives.')]
    for i in range(6):
        messages += [user(f'Instruction {i}: keep character {i} distinct.'),
                     ModelResponse(parts=[ToolCallPart('read', {}, str(i))]),
                     ModelRequest(parts=[ToolReturnPart('read', 'UNKNOWN result: ' + 'x' * 4000, str(i))])]
    return messages

class Continuity(unittest.TestCase):
    def setUp(self):
        self.sid = self.id()
        db.execute('INSERT INTO sessions(id,chat_key,title,created_at,updated_at) VALUES(?,?,?,?,?)',
                   (self.sid, 'chat', '', db.now(), db.now()))

    def test_repeated_summary_failure_retains_dialogue_and_pairs(self):
        def fail(*args): raise RuntimeError('unavailable')
        original = dialogue()
        packed = ModelMessagesTypeAdapter.dump_json(original)
        current = original
        for _ in range(3):
            current, info = asyncio.run(agentcontext.compress(current, 4000, FunctionModel(fail), self.sid, force=True))
            self.assertEqual(info['method'], 'preserved')
            self.assertEqual(len(current), len(original))
            for old, new in zip(original, current):
                for a, b in zip(old.parts, new.parts):
                    if a.part_kind != 'tool-return': self.assertEqual(a, b)
                    else: self.assertEqual(a.tool_call_id, b.tool_call_id)
        self.assertEqual(ModelMessagesTypeAdapter.dump_json(original), packed)

    def test_success_cannot_omit_user_rules_or_recovered_instructions(self):
        original = dialogue()
        recovery = continuity.RECOVERY_MARKER + '\n' + json.dumps([{'seq': 1, 'user': 'Special filename rule'}])
        original.insert(0, user(recovery))
        original.insert(1, user(continuity.STATE_MARKER + '\nOld state'))
        original.append(user(continuity.STATE_MARKER + '\nLatest state: job pending'))
        def summarize(*args): return ModelResponse(parts=[TextPart(content='Tool reads finished; outcome still unknown.')])
        result, info = asyncio.run(agentcontext.compress(original, 5000, FunctionModel(summarize)))
        self.assertEqual(info['method'], 'summary')
        rendered = text_of(result)
        self.assertIn('Use specified style; never overwrite existing files.', rendered)
        for i in range(6): self.assertIn(f'Instruction {i}: keep character {i} distinct.', rendered)
        self.assertIn(recovery, rendered)
        self.assertIn('Latest state: job pending', rendered)
        self.assertNotIn('Old state', rendered)

    def test_restore_from_journal_is_deduplicated_and_session_scoped(self):
        directive = 'Keep filenames consistent.\nUse "project" rules.'
        session._save_message(self.sid, 'user', directive)
        session._save_message(self.sid, 'assistant', 'Everything finished (unverified report).')
        session._save_message(self.sid, 'user', '계속해줘')
        continuity.save(self.sid, 'Goal', ['reported done'], ['verify file'], 'Inspect file', 'Earlier answer only')
        payload = {'spec': {'sessionId': self.sid}, 'done': 1, 'total': 3, 'saved': ['A.png']}
        db.execute('INSERT INTO jobs(id,kind,state,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                   (self.sid, 'studio_generate', 'cancelled', db.js(payload), db.now(), db.now()))
        with patch.object(continuity.agentnotes, 'prompt', return_value='project note'):
            parts = continuity.build(self.sid, 'A', [])
            self.assertEqual(len(parts), 2)
            records, _ = json.JSONDecoder().raw_decode(parts[0][len(continuity.RECOVERY_MARKER):].lstrip())
            self.assertEqual(records[0]['user'], directive)
            snapshot = json.loads(parts[-1][parts[-1].index('{'):])
            self.assertEqual(snapshot['actualJobs'][0]['state'], 'cancelled')
            self.assertEqual(snapshot['recordedWork']['pending'], ['verify file'])
            self.assertIn('unverified report', snapshot['previousAssistantReport'])
            again = continuity.build(self.sid, 'A', [user(p) for p in parts])
            self.assertEqual(len(again), 1)
            # §1-62: the notes block is the same text as in the handover still
            # in the history, so this one carries a pointer, not the block.
            self.assertEqual(json.loads(again[0][again[0].index('{'):])['notes'],
                             'unchanged since the previous handover above (recall_notes for details)')
        with patch.object(continuity.agentnotes, 'prompt', return_value='project note v2'):
            changed = continuity.build(self.sid, 'A', [user(p) for p in parts])
            self.assertEqual(json.loads(changed[-1][changed[-1].index('{'):])['notes'], 'project note v2')
            self.assertNotIn(directive, '\n'.join(continuity.build('another-session', 'A', [])))
        page = continuity.recall(self.sid, count=2)
        self.assertEqual(page['nextOffset'], 2)
        self.assertEqual(len(continuity.recall(self.sid, offset=2)['records']), 2)
        self.assertEqual(continuity.recall(self.sid, query='consistent')['total'], 1)
        self.assertFalse(continuity.recall('another-session')['records'])
        self.assertEqual([m['role'] for m in session.messages(self.sid)], ['user', 'assistant', 'user'])

    def test_new_handoff_does_not_rewrite_cached_history_or_instructions(self):
        seen = []
        def respond(messages, info):
            seen.append(ModelMessagesTypeAdapter.dump_json(messages))
            return ModelResponse(parts=[TextPart(content='Acknowledged')])
        with patch.object(agent, '_model', return_value=FunctionModel(respond)):
            ag = agent.build()
        settings = {'autoCompact': False}
        async def turns():
            deps = agent.Deps('chat', 'A', self.sid, Path(DATA.name), continuity_parts=['Snapshot one'])
            first = await ag.run('First user request', deps=deps)
            history = first.all_messages()
            packed = ModelMessagesTypeAdapter.dump_json(history)
            deps.continuity_parts = ['Snapshot two with edited note']
            second = await ag.run('Continue', message_history=history, deps=deps)
            self.assertEqual(ModelMessagesTypeAdapter.dump_json(history), packed)
            self.assertEqual(second.all_messages()[:len(history)], history)
            last_request = second.all_messages()[-2]
            self.assertEqual([p.content for p in last_request.parts], ['Snapshot two with edited note', 'Continue'])
            self.assertEqual(last_request.instructions, history[0].instructions)
            self.assertIsNone(deps.continuity_parts)
        with patch.object(config, 'section', return_value=settings): asyncio.run(turns())

    def test_long_journal_results_can_be_read_without_silent_truncation(self):
        session._save_message(self.sid, 'checkpoint', {'tool': 'read', 'result': 'x' * 4500 + 'TAIL EVIDENCE'})
        first = continuity.recall(self.sid, query='read', count=1)
        self.assertEqual(first['records'][0]['nextTextOffset'], 4000)
        second = continuity.recall(self.sid, query='read', count=1, text_offset=4000)
        self.assertIn('TAIL EVIDENCE', second['records'][0]['text'])
        self.assertIsNone(second['records'][0]['nextTextOffset'])

    def test_hard_limit_stops_before_provider_without_losing_history(self):
        calls = []
        def respond(*args):
            calls.append(1)
            return ModelResponse(parts=[TextPart(content='should not run')])
        ag = Agent(FunctionModel(respond), deps_type=agent.Deps, capabilities=[agentcontext.AutoContext()])
        history = [user('Earlier instruction'), ModelResponse(parts=[TextPart(content='Earlier answer')])]
        packed = ModelMessagesTypeAdapter.dump_json(history)
        settings = {'autoCompact': True, 'contextWindowTokens': 8000, 'maxTokens': 1000, 'historyBudgetChars': 120000}
        with patch.object(config, 'section', return_value=settings), self.assertRaises(agentcontext.ContextCapacityError):
            asyncio.run(ag.run('가' * 5000, message_history=history,
                              deps=agent.Deps('chat', 'A', self.sid, Path(DATA.name))))
        self.assertFalse(calls)
        self.assertEqual(ModelMessagesTypeAdapter.dump_json(history), packed)

    def test_thinking_only_failure_records_sanitized_diagnostics_and_usage(self):
        def thinking(*args):
            return ModelResponse(parts=[ThinkingPart(content='private reasoning')], finish_reason='length',
                                 usage=RequestUsage(input_tokens=100, output_tokens=8000, cache_read_tokens=50))
        result, info = asyncio.run(agentcontext.compress(dialogue(), 5000, FunctionModel(thinking), self.sid))
        self.assertEqual(info['method'], 'preserved')
        response = info['diagnostics']['responses'][0]
        self.assertEqual(response['finish'], 'length')
        self.assertEqual(response['textChars'], 0)
        self.assertEqual(info['usage'].output_tokens, 8000)
        self.assertNotIn('private reasoning', json.dumps(info['diagnostics']))

if __name__ == '__main__': unittest.main()
