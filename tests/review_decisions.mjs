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
