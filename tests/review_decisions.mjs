import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../plugin/node_modules/esbuild/lib/main.js';

// Exercise the actual UI handlers with only rendering/network dependencies stubbed.
const source = readFileSync(new URL('../plugin/src/ui/studio/selector.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('function flag('), source.indexOf('function dropSuggest('));
const context = vm.createContext({});
vm.runInContext(transformSync(`
let selection = {};
let saves = 0;
const cellSyncs = new Map();
let missingSync = null;
function queueSave() { saves++; }
${handlers}
globalThis.review = {
  set(value) { selection = { file: value }; },
  get() { return selection.file; },
  flag(key) { flag('file', key); },
  apply() { applySuggest('file'); },
  saves() { return saves; },
};`, { loader: 'ts' }).code, context);
const review = context.review;
const keys = ['use', 'inpaint', 'delete'];
for (const from of keys) {
  for (const to of keys) {
    review.set(Object.fromEntries(keys.map(k => [k, k === from])));
    review.flag(to);
    for (const key of keys) assert.equal(review.get()[key], from !== to && key === to);
    review.set({ ...Object.fromEntries(keys.map(k => [k, k === from])), suggest: { verdict: to } });
    review.apply();
    for (const key of keys) assert.equal(review.get()[key], key === to);
    assert.equal(review.get().suggest, undefined);
  }
}
assert.equal(review.saves(), 18);
console.log('PASS: all review decision transitions and suggestion applications are exclusive and saved');

// The chat's 검수 on a batch (§1-62): the selector unfolds the group holding
// the new images; images no rule can place fall back to the flat view.
const focusSrc = source.slice(source.indexOf('let pendingFocus'), source.indexOf('/** Whether the loaded groups belong'));
const fctx = vm.createContext({});
vm.runInContext(transformSync(`
let viewMode = 'group';
let drill = '';
${focusSrc.replace(/export function/g, 'function')}
globalThis.focus = {
  set: setFocus, apply: applyFocus,
  state() { return JSON.stringify({ viewMode, drill, fresh: [...highlight] }); },
};`, { loader: 'ts' }).code, fctx);
const groups = { groups: [
  { key: 'joy', items: [{ filename: 'a-joy-1.png' }, { filename: 'a-joy-2.png' }] },
  { key: 'sad', items: [{ filename: 'a-sad-1.png' }] },
], unmatched: [{ filename: 'odd.png' }] };
fctx.focus.set('studio/output/x', ['studio/output/x/a-sad-1.png']);
fctx.focus.apply({ path: 'studio/output/other' }, groups);
assert.equal(JSON.parse(fctx.focus.state()).drill, '', 'another folder does not consume the focus');
fctx.focus.apply({ path: 'studio/output/x' }, groups);
assert.equal(fctx.focus.state(), JSON.stringify({ viewMode: 'group', drill: 'sad', fresh: ['a-sad-1.png'] }));
fctx.focus.set('studio/output/x', ['studio/output/x/odd.png']);
fctx.focus.apply({ path: 'studio/output/x' }, groups);
assert.equal(fctx.focus.state(), JSON.stringify({ viewMode: 'all', drill: '', fresh: ['odd.png'] }));
fctx.focus.apply({ path: 'studio/output/x' }, groups);
assert.equal(JSON.parse(fctx.focus.state()).viewMode, 'all', 'the focus applies once');
console.log('PASS: the chat 검수 lands in the group of the new images, flat when unplaceable');
