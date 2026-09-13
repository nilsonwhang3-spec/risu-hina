import asyncio
import os
import sys
import tempfile
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'pyserver'))
DATA = tempfile.TemporaryDirectory(prefix='hina-shell-', ignore_cleanup_errors=True)
os.environ['RISUHINA_DATA_DIR'] = DATA.name
from app import agent, config, db, permits
from pydantic_ai.models.test import TestModel
config.load(); db.connect()

class Responsiveness(unittest.IsolatedAsyncioTestCase):
    async def test_approved_process_does_not_block_server_loop(self):
        with patch.object(agent, '_model', return_value=TestModel()):
            built = agent.build()
        ctx = SimpleNamespace(deps=SimpleNamespace(char_key='test', session_id='test'))
        for name, arguments in [('run_shell', {'command':'test', 'reason':'test'}), ('pip_install', {'packages':'test', 'reason':'test'})]:
            started, release = threading.Event(), threading.Event()
            def blocking(*args):
                started.set(); release.wait(1)
                return {'code':0,'stdout':'done','stderr':'','seconds':0}
            # Fails without freezing the test itself when the event loop is blocked.
            timer = threading.Timer(0.6, release.set); timer.start()
            try:
                with patch.object(permits, name, side_effect=blocking), patch.object(permits, 'decision', new=AsyncMock(return_value=True)):
                    task = asyncio.create_task(built._function_toolset.tools[name].function(ctx, **arguments))
                    for _ in range(50):
                        if started.is_set(): break
                        await asyncio.sleep(0.005)
                    self.assertTrue(started.is_set())
                    self.assertFalse(task.done(), 'server loop was blocked until subprocess completed')
                    release.set(); await task
            finally:
                release.set(); timer.cancel()

    def test_service_git_config_reaches_child_without_token_env(self):
        auth_dir = str(Path(DATA.name) / 'auth')
        git_config = str(Path(DATA.name) / 'gitconfig')
        with patch.dict(os.environ, {'GH_CONFIG_DIR':auth_dir, 'GIT_CONFIG_GLOBAL':git_config, 'GIT_TERMINAL_PROMPT':'0', 'GH_TOKEN':'not-a-real-token'}):
            env=permits._env()
        self.assertEqual(env['GH_CONFIG_DIR'],auth_dir)
        self.assertEqual(env['GIT_CONFIG_GLOBAL'],git_config)
        self.assertEqual(env['GIT_TERMINAL_PROMPT'],'0')
        self.assertNotIn('GH_TOKEN',env)

if __name__ == '__main__': unittest.main()
