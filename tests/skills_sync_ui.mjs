import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';
import { parseHTML } from '../plugin/node_modules/linkedom/esm/index.js';
const { window, document } = parseHTML('<html><body></body></html>');
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Event: window.Event });
let reads = 0, writes = 0, finish;
globalThis.__skillState = {
  async skills() { reads++; return { skills: [], catalogChars: 0, catalogLimit: 6000 }; },
  syncSkills() { writes++; return new Promise(resolve => { finish = resolve; }); },
};
const result = await build({ entryPoints: ['plugin/src/ui/skills.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'dependencies', setup(b) {
    const mocks = {
      '../state': 'export const state = globalThis.__skillState;',
      '../transport': 'export const transport = {};',
    };
    b.onResolve({ filter: /.*/ }, args => mocks[args.path] ? { path: args.path, namespace: 'mock' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'mock' }, ({path}) => ({ contents: mocks[path] }));
  }}] });
const { buildSkillsCard } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const card = buildSkillsCard(); document.body.appendChild(card);
const tick = () => new Promise(resolve => setImmediate(resolve));
await tick();
const advanced = card.querySelector('details');
assert.equal(advanced.hasAttribute('open'), false);
assert.match(advanced.textContent, /덮어써져 사라집니다/);
assert.match(advanced.textContent, /직접 추가한 별도 스킬/);
const button = advanced.querySelector('button');
button.click();
assert.equal(writes, 0, 'first click only confirms');
assert.match(button.textContent, /덮어쓰고/);
button.click();
assert.equal(writes, 1);
assert.equal(button.disabled, true);
finish({ updated: 17, created: 1 }); await tick();
assert.equal(button.disabled, false);
assert.equal(reads, 2, 'refreshes listing after success');
assert.match(card.textContent, /17개 갱신, 1개 추가/);
globalThis.__skillState.syncSkills = async () => { throw new Error('offline'); };
button.click(); button.click(); await tick();
assert.equal(button.disabled, false, 'failure allows retry');
assert.match(card.textContent, /offline/);
console.log('skills sync UI: confirmation, busy state, refresh and failure recovery passed');
