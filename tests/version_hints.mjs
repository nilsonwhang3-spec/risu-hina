import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';

// §1-91: the version gate lets an older PATCH of the backend through (same
// major.minor speaks the same API), but a patch can add routes the
// self-updating plugin then calls. backendBehind names that case, worded for
// how the backend is updated; versionGate keeps refusing a different minor.
const out = await build({
  entryPoints: [new URL('../plugin/src/transport.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  define: { __PLUGIN_VERSION__: '"0.15.33"' },
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { backendBehind, versionGate } = mod;

assert.equal(backendBehind('0.15.33', '0.15.33'), '', 'same version: nothing to say');
assert.equal(backendBehind('0.15.33', '0.15.34'), '', 'a newer backend patch is fine');
assert.equal(backendBehind('0.15.33', ''), '', 'no backend version: nothing to compare');
assert.equal(backendBehind('0.16.0', '0.15.40'), '', 'a different minor is the gate\'s case, not this one');

const standard = backendBehind('0.15.33', '0.15.32', 'standard');
assert.match(standard, /0\.15\.32/);
assert.match(standard, /백엔드 업데이트/, 'a standard install is pointed at the in-app updater');
assert.doesNotMatch(standard, /Docker/);

const docker = backendBehind('0.15.33', '0.15.9', 'docker');
assert.match(docker, /Docker/, 'a Docker install is told to rebuild/pull the image');
assert.doesNotMatch(docker, /정보 · 로그/, 'and not sent to an updater that refuses it');

assert.equal(versionGate('0.15.33', '0.15.32'), '', 'the gate itself still lets a patch through');
assert.notEqual(versionGate('0.16.0', '0.15.33'), '', 'and refuses a different minor');

console.log('PASS - backend-behind hints and the version gate');
