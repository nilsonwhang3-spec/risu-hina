import assert from 'node:assert/strict';
import { parseHTML } from '../plugin/node_modules/linkedom/esm/index.js';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';

// §1-86: the fragment editor filled its body after a fetch, by assigning
// `.value` - no input event, so the hilite mirror (the only thing drawn; the
// textarea's own text is transparent) stayed empty and the fragment looked
// blank. Any assignment must re-render the mirror.
const win = parseHTML('<html><body></body></html>').window;
for (const k of ['document', 'window', 'HTMLElement', 'HTMLTextAreaElement', 'Node', 'Event']) {
  if (!(k in globalThis)) globalThis[k] = win[k] ?? win;
}
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '', backgroundColor: '' });

const out = await build({
  entryPoints: [new URL('../plugin/src/ui/hilite.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')],
  bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent',
  plugins: [{ name: 'stub-state', setup(b) {
    b.onResolve({ filter: /\/state$/ }, () => ({ path: 'state', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const state = {};', loader: 'js' }));
  } }],
});
const mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const ta = document.createElement('textarea');
document.body.appendChild(ta);
mod.attachHilite(ta, { mode: 'nai', noSuggest: true, fragments: () => [] });
const mirrorText = () => (ta.parentElement?.querySelector('.hlmirror')?.textContent ?? '');
assert.ok(!mirrorText().includes('masterpiece'));
ta.value = 'masterpiece, 1girl, <hair>';
assert.equal(ta.value, 'masterpiece, 1girl, <hair>');
assert.ok(mirrorText().includes('masterpiece'), 'a programmatic .value must reach the mirror: ' + JSON.stringify(mirrorText()));
console.log('PASS hilite mirror follows programmatic value assignment');
