import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';
const built = await build({ entryPoints: ['plugin/src/operation.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { boundedAssets, foregroundWrite, onWriteProgress } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
for (const storage of ['web IndexedDB/OPFS', 'PocketRisu HTTP']) {
  let active = 0, peak = 0, initialized = false;
  const completed = new Set();
  const start = performance.now();
  await boundedAssets(Array.from({ length: 1301 }, (_, i) => i), async i => {
    if (i) assert.ok(initialized, 'first storage initialization completes before concurrency');
    active++; peak = Math.max(peak, active);
    await delay(storage.startsWith('web') ? 1 : 2);
    completed.add(i); initialized = true; active--;
  });
  assert.equal(completed.size, 1301); assert.equal(active, 0); assert.equal(peak, 4);
  console.log(storage + ' simulated latency: 1301 assets, concurrency ' + peak + ', ' + Math.round(performance.now() - start) + ' ms');
}
let active = 0, started = 0;
await assert.rejects(boundedAssets(Array.from({ length: 30 }, (_, i) => i), async i => {
  active++; started++;
  try { await delay(i === 1 ? 1 : 15); if (i === 1) throw new Error('storage full'); }
  finally { active--; }
}), /storage full/);
assert.equal(active, 0, 'all in-flight work drained before releasing write guard');
assert.equal(started, 5, 'no new work after failure');
const messages = [];
onWriteProgress(m => messages.push(m));
await assert.rejects(foregroundWrite(async report => {
  report('uploading');
  await assert.rejects(foregroundWrite(async () => {}), /진행 중/);
  throw new Error('host failed');
}), /host failed/);
assert.equal(messages.at(-1), null, 'spinner clears on error');
await foregroundWrite(async () => {});
assert.equal(messages.at(-1), null, 'write can be retried');
console.log('PASS asset concurrency and foreground write lifecycle');
