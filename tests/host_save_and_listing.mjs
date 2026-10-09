import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from '../plugin/node_modules/esbuild/lib/main.js';

const source = readFileSync(new URL('../plugin/src/state.ts', import.meta.url), 'utf8');
const method = name => {
  const start = source.indexOf('  async ' + name + '(');
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
};
class BackendError extends Error { constructor(status) { super('temporary'); this.status = status; } }
let reads = 0;
const completions = [];
const transport = {
  async get() { if (++reads < 3) throw new BackendError(502); return { areas: [] }; },
  async post(path, payload) {
    if (path === '/actions/decide') return { approved: true, host: { kind: 'host_card_writeback' } };
    if (path === '/actions/complete') completions.push(payload);
  },
};
const helper = name => {
  const start = source.indexOf(name);
  assert.ok(start >= 0, name);
  // '\n}' and not '\n}\n': the working tree may be CRLF.
  return source.slice(start, source.indexOf('\n}', start) + 2) + '\n';
};
const context = vm.createContext({ BackendError, transport, setTimeout: fn => fn() });
vm.runInContext(transformSync(helper('function lostAnswer(') + helper('async function reportOutcome('), { loader: 'ts' }).code, context);
vm.runInContext(transformSync(`class State {
  ${method('files')}
  ${method('decideAction')}
  ${method('requestedCardWriteback')}
}
globalThis.state = new State();`, { loader: 'ts' }).code, context);
const state = context.state;
state.botKey = 'bot'; state.activeCharKey = 'bot'; state.openModules = []; state.activeChatKey = 'active'; state.activeTab = 'studio';
state.cardWriteBack = async () => ({ verified: true, applied: 2 });
assert.match(await state.requestedCardWriteback('save', 'bot', 'requested-chat'), /2/);
assert.equal(completions.at(-1).ok, true);
assert.equal(completions.at(-1).chatKey, 'requested-chat');
state.cardWriteBack = async () => ({ verified: false, drift: 'host ignored write' });
await assert.rejects(state.requestedCardWriteback('save2', 'bot', 'requested-chat'), /host ignored write/);
assert.equal(completions.at(-1).ok, false);
await assert.rejects(state.requestedCardWriteback('save3', 'other-bot', ''), /현재 봇/);

// A Lua-only card write is a real write: it must not read "0건" (the agent
// then invented an explanation) and it must say what went in.
const hostSource = readFileSync(new URL('../plugin/src/host.ts', import.meta.url), 'utf8');
const from = hostSource.indexOf('const LIST_LABEL');
const fnAt = hostSource.indexOf('export function describeCardParts');
const endMatch = /\r?\n\}\r?\n/.exec(hostSource.slice(fnAt));
const to = endMatch ? fnAt + endMatch.index + endMatch[0].length : -1;
assert.ok(from >= 0 && to > from);
vm.runInContext(transformSync(hostSource.slice(from, to).replace('export function', 'function')
  + '\nglobalThis.host = { describeCardParts };', { loader: 'ts' }).code, context);
state.cardWriteBack = async () => ({ verified: true, applied: 1, mode: 'edits', parts: ['triggerscript'] });
const luaSaid = await state.requestedCardWriteback('save4', 'bot', 'requested-chat');
assert.doesNotMatch(luaSaid, /0건/);
assert.match(luaSaid, /1건\(트리거\(Lua\)\)/);
state.cardWriteBack = async () => ({ verified: true, applied: 2, mode: 'edits', parts: ['desc', 'customscript'] });
assert.match(await state.requestedCardWriteback('save5', 'bot', 'requested-chat'), /설명 · Regex/);

// The chat twin: a lorebook-only write used to say "0건을 반영".
transport.post = async (path, payload) => {
  if (path === '/actions/decide') return { approved: true, host: { kind: 'host_writeback' } };
  if (path === '/actions/complete') completions.push(payload);
};
const commits = [];
state.commit = async label => { commits.push(label); return { shipped: 1 }; };
state.writeBack = async () => ({ verified: true, mode: 'edits', applied: 0, lore: 2, memory: 0, warnings: [] });
const loreSaid = await state.decideAction('wb1', true, 'active');
assert.doesNotMatch(loreSaid, /0건/);
assert.match(loreSaid, /챗 로어북 2건/);
// An approved 반영 that landed becomes the baseline (§1-84), like the bar's
// 반영: without it the shipped turns stayed "pending" and the next 반영 was
// refused as "RisuAI 쪽에서 챗이 바뀌었습니다".
assert.equal(commits.length, 1);
state.writeBack = async () => ({ verified: true, mode: 'replace', applied: 45, lore: 0, memory: 0, warnings: [] });
assert.match(await state.decideAction('wb0', true, 'active'), /턴 45건/);
assert.equal(commits.length, 2);
state.writeBack = async () => ({ verified: true, mode: 'noop', applied: 0, lore: 0, memory: 0, warnings: [] });
assert.match(await state.decideAction('wbn', true, 'active'), /없었습니다/);
assert.equal(commits.length, 2);
state.writeBack = async () => ({ verified: false, mode: 'edits', applied: 3, lore: 0, memory: 0, warnings: [], drift: 'kept old text' });
await assert.rejects(state.decideAction('wb2', true, 'active'), /kept old text/);
assert.equal(completions.at(-1).ok, false);
assert.equal(commits.length, 2, 'an unverified write must not become the baseline');
transport.post = async (path, payload) => {
  if (path === '/actions/decide') return { approved: true, host: { kind: 'host_card_writeback' } };
  if (path === '/actions/complete') completions.push(payload);
};
await state.files();
assert.equal(reads, 3);
reads = 0; transport.get = async () => { reads++; throw new BackendError(401); };
await assert.rejects(state.files());
assert.equal(reads, 1);
console.log('PASS explicit studio save, verified result, bot identity, transient listing retry, no auth retry');
