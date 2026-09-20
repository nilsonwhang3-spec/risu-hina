import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../plugin/node_modules/esbuild/lib/main.js';

// host.canon decides "did RisuAI change this list" before and after a write.
const source = readFileSync(new URL('../plugin/src/host.ts', import.meta.url), 'utf8');
const slice = source.slice(source.indexOf('const DEFAULT_FALSE'), source.indexOf('export function fnv32'));
const ctx = vm.createContext({});
vm.runInContext(transformSync(slice.replace(/export function/g, 'function') + '\nglobalThis.canon = canon;', { loader: 'ts' }).code, ctx);
const trig = { comment: 't', type: 'start', effect: [{ type: 'triggerlua', code: 'print(1)' }] };
assert.equal(ctx.canon([trig]), ctx.canon([{ ...trig, lowLevelAccess: false }]), 'run-time stamp false');
assert.equal(ctx.canon([trig]), ctx.canon([{ ...trig, lowLevelAccess: true }]), 'run-time stamp true');
assert.notEqual(ctx.canon([trig]), ctx.canon([{ ...trig, effect: [{ type: 'triggerlua', code: 'print(2)' }] }]), 'a code change still counts');
assert.equal(ctx.canon([{ ...trig, selective: false }]), ctx.canon([trig]), 'importer defaults still fold');
console.log('PASS: host.canon ignores RisuAI\'s run-time lowLevelAccess stamp and keeps real edits');
