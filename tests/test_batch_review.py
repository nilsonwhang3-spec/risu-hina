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
