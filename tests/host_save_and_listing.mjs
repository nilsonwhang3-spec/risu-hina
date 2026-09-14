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
const context = vm.createContext({ BackendError, transport, setTimeout: fn => fn() });
vm.runInContext(transformSync(`class State {
  ${method('files')}
  ${method('decideAction')}
  ${method('requestedCardWriteback')}
}
globalThis.state = new State();`, { loader: 'ts' }).code, context);
const state = context.state;
state.botKey = 'bot'; state.activeChatKey = 'active'; state.activeTab = 'studio';
state.cardWriteBack = async () => ({ verified: true, applied: 2 });
assert.match(await state.requestedCardWriteback('save', 'bot', 'requested-chat'), /2/);
assert.equal(completions.at(-1).ok, true);
assert.equal(completions.at(-1).chatKey, 'requested-chat');
state.cardWriteBack = async () => ({ verified: false, drift: 'host ignored write' });
await assert.rejects(state.requestedCardWriteback('save2', 'bot', 'requested-chat'), /host ignored write/);
assert.equal(completions.at(-1).ok, false);
await assert.rejects(state.requestedCardWriteback('save3', 'other-bot', ''), /현재 봇/);
await state.files();
assert.equal(reads, 3);
reads = 0; transport.get = async () => { reads++; throw new BackendError(401); };
await assert.rejects(state.files());
assert.equal(reads, 1);
console.log('PASS explicit studio save, verified result, bot identity, transient listing retry, no auth retry');
