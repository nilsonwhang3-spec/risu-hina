"""AI batch confirmation uses actual image count and the approved expansion."""
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
DATA = tempfile.TemporaryDirectory(prefix='hina-batch-review-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
from app import agent, batchreview, config, db, permits, studio, studiojob
from pydantic_ai.models.test import TestModel
config.load(); db.connect()


class BatchReview(unittest.TestCase):
    def test_missing_styles_cannot_fall_back_to_active_cards(self):
        with self.assertRaises(studio.StudioError):
            batchreview.prepare([{'characters': [], 'count': 25}])

    def test_preview_describes_actual_scenes_and_settings(self):
        spec = {'styles': [], 'characters': [], 'scenes': [{'name': 'happy'}, {'name': 'sad'}], 'count': 2}
        prepared, detail, total = batchreview.prepare([spec])
        self.assertEqual(total, 4)
        self.assertIn('happy', detail); self.assertIn('sad', detail)
        self.assertEqual(len(prepared[0][1]), 4)
        self.assertIn('referenceSpecs', prepared[0][1][0])
        self.assertIn('width', prepared[0][0]['params'])

    def test_style_settings_survive_the_ai_batch_path(self):
        # §1-77 field bug: prepare() merged the defaults before the style's
        # settings, so an AI/MCP batch ran (and showed) the defaults. The
        # style must win over the defaults, an explicit value over the style.
        from app import files
        rel = 'studio/config/styles/review-gen.md'
        p = files._resolve(files.SPACE, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text('---\nname: review-gen\nmodel: nai-diffusion-4-5-curated\nsteps: 40\nsampler: k_dpmpp_2m\n'
                     'width: 1024\nheight: 1024\nprefer_brownian: true\n---\n## positive\nink\n', encoding='utf-8')
        prepared, detail, _ = batchreview.prepare([{'styles': [rel], 'characters': [], 'count': 1,
                                                     'params': {'scale': 7}}])
        spec, items = prepared[0]
        self.assertEqual(spec['model'], 'nai-diffusion-4-5-curated')
        self.assertEqual(spec['params']['steps'], 40)
        self.assertEqual(spec['params']['sampler'], 'k_dpmpp_2m')
        self.assertEqual(spec['params']['width'], 1024)
        self.assertIs(spec['params']['prefer_brownian'], True)
        self.assertEqual(spec['params']['scale'], 7)            # explicit wins
        self.assertIn('cfg_rescale', spec['params'])             # defaults still fill the rest
        self.assertIn('nai-diffusion-4-5-curated', detail)       # the confirmation shows it
        self.assertIn('1024×1024', detail)
        # And the job that runs the approved items keeps them.
        with patch('threading.Thread.start'):
            job = studiojob.start(spec, planned_items=items)
        payload = studiojob.get(job['jobId'])['payload']['spec']
        self.assertEqual(payload['model'], 'nai-diffusion-4-5-curated')
        self.assertEqual(payload['params']['steps'], 40)

    def test_held_mcp_batch_runs_the_plan_that_was_shown(self):
        # §1-79: an MCP batch is a studio_batch proposal; approving it starts
        # exactly the held expansion (no replanning), once.
        from app import actions, nai
        prepared, detail, total = batchreview.prepare([{'styles': [], 'characters': [], 'count': 2}])
        act = actions.propose('studio_batch', chat_key='', char_key='', summary=f'총 {total}장',
                              args={'lines': batchreview.summary_lines(detail)})
        batchreview.hold(act['id'], prepared)
        self.assertTrue(batchreview.summary_lines(detail)[0].startswith('배치 1: 2장'))
        seen = []

        def fake_start(spec, planned_items=None):
            seen.append(planned_items)
            return {'jobId': 'job_test', 'total': len(planned_items)}
        with patch.object(nai, 'configured', return_value=True), \
             patch.object(studio, 'plan', side_effect=AssertionError('replanned')), \
             patch.object(studiojob, 'start', side_effect=fake_start):
            out = actions.decide(act['id'], True)
        self.assertEqual(seen, [prepared[0][1]])
        self.assertIn('job_test', out['result'])
        self.assertIsNone(batchreview.take(act['id']))   # the plan is used once

    def test_job_uses_approved_items_without_replanning(self):
        prepared, _, _ = batchreview.prepare([{'styles': [], 'characters': [], 'count': 2}])
        spec, items = prepared[0]
        with patch.object(studio, 'plan', side_effect=AssertionError('replanned')), patch('threading.Thread.start'):
            result = studiojob.start(spec, planned_items=items)
        self.assertEqual(studiojob.get(result['jobId'])['payload']['items'], items)

    def test_multiscene_batch_waits_and_denial_starts_nothing(self):
        self.run_confirmation(False)

    def test_approval_is_one_time_even_with_always_requested(self):
        self.run_confirmation(True)

    def run_confirmation(self, allow):
        with patch.object(agent, '_model', return_value=TestModel()):
            tool = agent.build()._function_toolset.tools['studio_generate'].function
        sid = 'review-' + str(allow)
        ctx = SimpleNamespace(deps=agent.Deps('chat', '', sid, Path(DATA.name)))
        spec = {'styles': [], 'characters': [], 'count': 1,
                'scenes': [{'name': f'emotion{i}'} for i in range(25)]}
        async def run():
            task = asyncio.create_task(tool(ctx, json.dumps(spec), wait=False))
            for _ in range(100):
                pending = permits.pending(sid)
                if pending: break
                await asyncio.sleep(.01)
            self.assertTrue(pending)
            start.assert_not_called()
            self.assertIn('25', pending[0]['summary'])
            answer = permits.decide(pending[0]['id'], allow, always=True)
            self.assertFalse(answer['always'])
            await asyncio.wait_for(task, 2)
            if allow:
                self.assertEqual(len(start.call_args.kwargs['planned_items']), 25)
                again = permits.request(sid, 'studio_batch', 'next', 'new settings')
                self.assertFalse(again['auto']); self.assertFalse(again['decided'])
            else: start.assert_not_called()
        with patch.object(studiojob, 'start', return_value={'jobId': 'mock', 'total': 25, 'estimate': {'note': 'test'}}) as start:
            try: asyncio.run(run())
            finally: permits.end_turn(sid)


if __name__ == '__main__': unittest.main()
