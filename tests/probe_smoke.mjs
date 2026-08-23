/**
 * Probe plugin smoke harness.
 *
 * `node --check` proves the file parses; it does not prove every identifier
 * resolves. A ReferenceError in a rarely-taken branch is exactly the class of
 * bug that reached a live chat in active-recall, so the probe gets executed
 * here against stub host APIs before it is ever imported into RisuAI.
 *
 * Backend tests run against a real probe_server.py when one is reachable, so
 * nfetch/readJson/stream-reading are exercised for real rather than mocked.
 *
 *   node tests/probe_smoke.mjs [backendUrl] [token]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(__dirname, '..', 'probe', 'risu-elf-probe.js');

const BACKEND = process.argv[2] || 'http://127.0.0.1:6021';
const TOKEN = process.argv[3] || 'testtok';

// ---------------------------------------------------------------- fake DOM

// Deliberately permissive: any id or selector yields an element. The point is
// to let every code path run to completion, not to model a browser.
function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    style: {},
    dataset: {},
    children: [],
    textContent: '',
    value: '',
    _html: '',
    _listeners: new Map(),
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    remove() {},
    click() { el._clicked = true; },
    select() {},
    focus() {},
    addEventListener(type, fn) { this._listeners.set(type, fn); },
    // Cache by selector so a value written through querySelector can be read
    // back — otherwise every lookup returns a fresh object and the harness
    // cannot see what the probe actually reported.
    querySelector(sel) {
      if (!this._sel) this._sel = new Map();
      if (!this._sel.has(sel)) this._sel.set(sel, makeEl());
      return this._sel.get(sel);
    },
    querySelectorAll() { return []; },
  };
  return el;
}

const registry = new Map();
const body = makeEl('body');
const head = makeEl('head');

globalThis.document = {
  body, head, documentElement: makeEl('html'),
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => {
    if (!registry.has(id)) registry.set(id, makeEl());
    return registry.get(id);
  },
  querySelector: () => makeEl(),
  querySelectorAll: () => [],
  execCommand: () => true,
  addEventListener: () => {},
};

globalThis.Image = class {
  constructor() { this.onload = null; this.onerror = null; }
  set src(v) {
    // A data: URI is the only thing the probe loads; report success so the
    // PocketRisu-shaped branch is the one exercised here.
    setTimeout(() => { if (this.onload) this.onload(); }, 0);
  }
};

// ---------------------------------------------------------------- fake host

const storage = new Map();
let unloadCb = null;
const registered = [];
const calls = [];

function note(name, args) { calls.push(name); return args; }

// A chat that looks like the real thing: chatId on every message, hypaV3 present.
const fakeChat = {
  id: 'chat-uuid-0',
  name: 'probe chat',
  note: '',
  localLore: [],
  message: Array.from({ length: 7 }, (_, i) => ({
    role: i % 2 ? 'char' : 'user',
    data: `turn ${i}`,
    time: 1700000000000 + i * 1000,
    chatId: `msg-${i}`,
    generationInfo: i % 2 ? { model: 'x', inputTokens: 10 } : undefined,
  })),
  hypaV3Data: { summaries: [{ text: 's', chatMemos: ['msg-1'] }] },
};

const fakeChar = {
  name: 'Probe Bot',
  type: 'character',
  chaId: 'cha-0',
  desc: 'a'.repeat(120),
  firstMessage: 'hello',
  alternateGreetings: ['g1', 'g2'],
  globalLore: [{ key: ['k'], content: 'c' }],
  chats: [fakeChat, { ...fakeChat, id: 'chat-uuid-1', message: fakeChat.message.slice(0, 3) }],
};

let liveChat = structuredClone(fakeChat);
let liveChar = structuredClone(fakeChar);
liveChar.chats[0] = liveChat;

globalThis.Risuai = {
  async getArgument(k) {
    note('getArgument');
    if (k === 'backend_url') return BACKEND;
    if (k === 'backend_token') return TOKEN;
    return '';
  },
  async getRuntimeInfo() {
    note('getRuntimeInfo');
    return { apiVersion: '3.0', platform: 'node', saveMethod: 'local' };
  },
  async nativeFetch(url, opts) {
    note('nativeFetch');
    const o = opts || {};
    // The real bridge rejects POST/PUT without a body; mirror that so the
    // probe's own guard is exercised.
    if ((o.method === 'POST' || o.method === 'PUT') && o.body === undefined) {
      throw new Error('Body is required for POST and PUT requests');
    }
    return await fetch(url, { method: o.method || 'GET', headers: o.headers, body: o.body });
  },
  pluginStorage: {
    async getItem(k) { note('pluginStorage.getItem'); return storage.get(k); },
    async setItem(k, v) { note('pluginStorage.setItem'); storage.set(k, v); },
    async removeItem(k) { note('pluginStorage.removeItem'); storage.delete(k); },
  },
  async getCurrentCharacterIndex() { note('getCurrentCharacterIndex'); return 0; },
  async getCurrentChatIndex() { note('getCurrentChatIndex'); return 0; },
  async getChatFromIndex(ci, chi) {
    note('getChatFromIndex');
    const c = liveChar.chats[chi];
    return c ? structuredClone(c) : null;
  },
  async setChatToIndex(ci, chi, chat) {
    note('setChatToIndex');
    // Mirrors v3.svelte.ts:791-801 — writes only to an index that exists.
    if (liveChar.chats[chi]) liveChar.chats[chi] = structuredClone(chat);
  },
  async getCharacterFromIndex() { note('getCharacterFromIndex'); return structuredClone(liveChar); },
  async showContainer() { note('showContainer'); },
  async hideContainer() { note('hideContainer'); },
  async registerSetting(name, cb) { note('registerSetting'); registered.push({ id: 's1', cb }); return { id: 's1' }; },
  async registerButton(arg, cb) { note('registerButton'); registered.push({ id: 'b1', cb }); return { id: 'b1' }; },
  async unregisterUIPart() { note('unregisterUIPart'); },
  async onUnload(cb) { note('onUnload'); unloadCb = cb; },
};

// ---------------------------------------------------------------- run

const errors = [];
const origError = console.error;
process.on('unhandledRejection', (e) => { errors.push('unhandledRejection: ' + (e && e.message)); });

const src = readFileSync(PLUGIN, 'utf8');

console.log(`harness: backend=${BACKEND}`);
let backendUp = false;
try {
  const r = await fetch(BACKEND + '/health');
  const j = await r.json();
  backendUp = j && j.service === 'risu-elf-probe';
} catch { /* not running */ }
console.log(`harness: backend ${backendUp ? 'reachable' : 'NOT reachable (network tests will report failures)'}`);

try {
  // Indirect eval keeps the plugin at module scope-ish while still running the IIFE.
  (0, eval)(src);
} catch (e) {
  errors.push('load threw: ' + (e && e.stack));
}

// The plugin registers its entry points asynchronously; wait for them.
await new Promise((r) => setTimeout(r, 200));

if (!registered.length) {
  errors.push('no UI entry point registered');
} else {
  try {
    await registered[0].cb();       // open() -> buildUI + runAll
  } catch (e) {
    errors.push('open() threw: ' + (e && e.stack));
  }
}

// runAll is fire-and-forget inside open(); give the network tests time.
await new Promise((r) => setTimeout(r, backendUp ? 6000 : 1500));

try {
  if (unloadCb) await unloadCb();
} catch (e) {
  errors.push('onUnload threw: ' + (e && e.stack));
}

// ---------------------------------------------------------------- verdict

const uniq = [...new Set(calls)].sort();
console.log(`\nhost APIs actually exercised (${uniq.length}):`);
console.log('  ' + uniq.join(', '));

// Read each row back out of the fake DOM so the harness reports real verdicts,
// not merely "nothing threw".
console.log('\nverdicts as the probe rendered them:');
let unreported = 0;
for (const [id, row] of registry) {
  if (!id.startsWith('row-')) continue;
  const badge = row.querySelector('.badge').textContent;
  const summary = row.querySelector('.summary').textContent;
  if (!badge || badge === '···') { unreported++; }
  console.log(`  ${String(badge || '----').padEnd(5)} ${id.slice(4).padEnd(13)} ${summary}`);
}
if (unreported) errors.push(`${unreported} test row(s) never reported a verdict`);

// The write test must leave no trace on the chat object.
const residue = Object.prototype.hasOwnProperty.call(liveChar.chats[0], 'realOocProbe');
if (residue) errors.push('T-12 left realOocProbe on the chat — cleanup is broken');

const msgsIntact = liveChar.chats[0].message.length === fakeChat.message.length &&
  liveChar.chats[0].message.every((m, i) => m.data === fakeChat.message[i].data &&
    m.chatId === fakeChat.message[i].chatId);
if (!msgsIntact) errors.push('T-12 mutated chat messages — it must be non-destructive');

const chatsGrew = liveChar.chats.length !== fakeChar.chats.length;
if (chatsGrew) errors.push('T-13 added a chat via setChatToIndex — guard is wrong');

console.log('');
if (errors.length) {
  console.error('FAIL');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log('PASS — plugin loads, registers, runs every test, and leaves the chat untouched');
