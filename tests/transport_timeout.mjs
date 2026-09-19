import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';
const bundle = await build({ entryPoints: ['plugin/src/transport.ts'], bundle: true, write: false,
  format: 'esm', define: { __PLUGIN_VERSION__: '"0.15.16"' } });
const { Transport, BackendError } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const transport = new Transport();
transport.configure({ url: 'http://backend.test', token: '' });
const never = () => new Promise(() => {});
let options;
globalThis.Risuai = { nativeFetch: async (_url, opts) => { options = opts; return { ok: true, status: 200, text: never }; } };
const bounded = async (call) => {
  let timer;
  try {
    return await Promise.race([call.then(() => 'resolved', e => e), new Promise(resolve => {
      timer = setTimeout(() => resolve('HUNG after response headers'), 180);
    })]);
  } finally { clearTimeout(timer); }
};
for (const status of [200, 502]) {
  Risuai.nativeFetch = async (_url, opts) => { options = opts; return { ok: status === 200, status, text: never }; };
  const result = await bounded(transport.post('/update/check', {}, 25));
  assert.ok(result instanceof BackendError, `HTTP ${status}: ${result}`);
  assert.match(result.message, /update\/check.*응답/);
  assert.equal(options.signal.aborted, true, 'timeout requests cancellation even if host ignores it');
}
Risuai.nativeFetch = never;
assert.ok(await bounded(transport.post('/update/check', {}, 25)) instanceof BackendError, 'headers also bounded');
Risuai.nativeFetch = async () => ({ ok: true, status: 200, text: async () => '{"ok":true,"latest":"0.15.16"}' });
assert.equal((await transport.post('/update/check', {}, 25)).latest, '0.15.16', 'retry after timeout succeeds');
Risuai.nativeFetch = async () => ({ ok: false, status: 503, text: async () => '{"error":"temporary unavailable"}' });
await assert.rejects(transport.post('/update/check', {}, 25), /temporary unavailable/);
Risuai.nativeFetch = async () => ({ ok: true, status: 200, text: async () => '<html>proxy</html>' });
await assert.rejects(transport.post('/update/check', {}, 25), /JSON/);
console.log('PASS - full JSON request deadline, stalled success/error bodies and retry');
