import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(pathToFileURL(resolve('plugin/package.json')));
const { build } = require('esbuild');
const calls = [];
globalThis.__clipboardState = {
  touchFiles() {},
  async copyFiles(paths, to) { calls.push(['copy', paths, to]); return { done: paths.length, failed: [] }; },
  async moveFiles(paths, to) { calls.push(['cut', paths, to]); return { done: paths.length, failed: [] }; },
};
const result = await build({ entryPoints: ['plugin/src/ui/file-clipboard.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'state-test-double', setup(build) {
    build.onResolve({ filter: /\/state$/ }, () => ({ path: 'state', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const state = globalThis.__clipboardState;' }));
  } }],
});
const clipboard = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
clipboard.setFileClipboard({ op: 'copy', paths: ['studio/output/A/image.png'] });
await clipboard.pasteFiles('projects/A');
assert.deepEqual(calls[0], ['copy', ['studio/output/A/image.png'], 'projects/A']);
assert.equal(clipboard.fileClipboard.op, 'copy');
clipboard.setFileClipboard({ op: 'cut', paths: ['studio/output/A/a.png', 'studio/output/A/b.png'] });
globalThis.__clipboardState.moveFiles = async () => ({ done: 1, failed: [{ path: 'studio/output/A/b.png', error: 'locked' }] });
await clipboard.pasteFiles('projects/A');
assert.deepEqual(clipboard.fileClipboard.paths, ['studio/output/A/b.png']);
globalThis.__clipboardState.moveFiles = async () => { throw Error('offline'); };
await assert.rejects(clipboard.pasteFiles('projects/A'));
assert.deepEqual(clipboard.fileClipboard.paths, ['studio/output/A/b.png']);
globalThis.__clipboardState.moveFiles = async () => ({ done: 1, failed: [] });
await clipboard.pasteFiles('projects/A');
assert.equal(clipboard.fileClipboard, null);
clipboard.setFileClipboard({ op: 'cut', paths: ['studio/output/A'] });
assert.equal(await clipboard.pasteFiles('studio/output/A/child'), null);
assert.equal(clipboard.fileClipboard.paths[0], 'studio/output/A');
console.log('PASS - shared copy/cut/paste and partial-failure retention');
