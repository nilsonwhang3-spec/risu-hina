import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';

let character = { chaId: 'bot-a', name: 'A', chats: [{ id: 'chat-a', message: [] }] };
let selected = 0;
globalThis.Risuai = {
  async getCurrentCharacterIndex() { return selected; },
  async getCurrentChatIndex() { return 0; },
  async getCharacterFromIndex() { return structuredClone(character); },
  async getChatFromIndex() { return structuredClone(character.chats[0]); },
};
const stopped = [];
const transport = {
  async get(path) {
    if (path === '/card/changes' || path === '/changes') return { total: 0 };
    throw new Error(path);
  },
  async post(path, data) { if (path === '/agent/stop') stopped.push(data.sessionId); return {}; },
  async upload(_path, payload) { return { workspace: { charId: payload.charId, charKey: payload.charId,
    characterName: payload.card.name, chats: [{ chatKey: payload.charId + '-chat', chatId: payload.chats[0].chat.id }] } }; },
};
globalThis.__botContextTransport = transport;
const result = await build({ entryPoints: ['plugin/src/state.ts'], bundle: true, write: false, format: 'esm',
  plugins: [{ name: 'host-and-transport', setup(b) {
    b.onResolve({ filter: /^\.\/(transport|assets|operation)$/ }, args =>
      args.importer.endsWith('state.ts') ? { path: args.path.slice(2), namespace: 'test' } : undefined);
    b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: {
      transport: 'export const transport = globalThis.__botContextTransport; export class BackendError extends Error {} export const clientLog = async () => {};',
      assets: 'export const syncAssets = () => {}; export const syncBusy = () => false; export const describeSync = () => "";',
      operation: 'export const foregroundWrite = async (_label, fn) => fn(); export const boundedAssets = async () => {};',
    }[path] }));
  } }],
});
const { state } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
state.syncAssets = () => {};
await state.readHost();
await state.upload();
state.sessionId = 'old-session';
state.unseenOutputs = ['projects/A/old.md'];
state.openFileRequest = 'projects/A/old.md';
state.turns = [{ body: 'old turn' }];
const revision = state.contextRevision;
await state.readHost();
assert.equal(state.contextRevision, revision, 'same bot reopen retains context');
assert.equal(state.sessionId, 'old-session');

const originalGet = transport.get;
let resolveSession, resolveTurns, resolveUpload;
transport.get = (path, args) => path === '/session' ? new Promise(resolve => { resolveSession = resolve; })
  : path === '/turns' ? new Promise(resolve => { resolveTurns = resolve; }) : originalGet(path, args);
const staleSession = state.agentSession();
const staleTurns = state.loadTurns();
const originalUpload = transport.upload;
transport.upload = () => new Promise(resolve => { resolveUpload = resolve; });
const staleUpload = state.upload();
character = { chaId: 'bot-b', name: 'B', chats: [{ id: 'chat-b', message: [] }] };
await state.readHost(); // Same host slot, new character identity.
assert.equal(state.workspace, null);
assert.equal(state.sessionId, '');
assert.equal(state.activeChatKey, '');
assert.deepEqual(state.turns, []);
assert.deepEqual(state.unseenOutputs, []);
assert.equal(state.openFileRequest, null);
assert.deepEqual(stopped, ['old-session']);
transport.upload = originalUpload;
await state.upload();
resolveSession({ session: { sessionId: 'late-old-session' }, messages: [] });
await assert.rejects(staleSession, /변경/);
resolveTurns({ total: 1, turns: [{ body: 'late old turn' }] });
await staleTurns;
resolveUpload({ workspace: { charKey: 'bot-a', chats: [] } });
await assert.rejects(staleUpload, /변경/);
assert.equal(state.activeCharKey, 'bot-b');
assert.equal(state.activeChatKey, 'bot-b-chat');
assert.equal(state.sessionId, '');
assert.deepEqual(state.turns, []);
selected = -1;
assert.equal(await state.readHost(), false);
assert.equal(state.workspace, null, 'failed/no selection cannot retain the old bot');
assert.equal(state.activeChatKey, '');
console.log('PASS - bot identity reset, same-bot retention and stale response isolation');
