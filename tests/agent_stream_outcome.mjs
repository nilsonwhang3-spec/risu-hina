// A lost AI turn and the report about it (the two Vertex reports of 2026-10-26):
// when every reattach fails the panel asks GET /chat/outcome and shows the
// turn's own error instead of a bare "network error"; the bug-report block
// keeps a traceback's LAST line (the error) and drops the oldest log entries,
// not the newest, when it runs long.
import assert from 'node:assert/strict';
import { build } from '../plugin/node_modules/esbuild/lib/main.js';

// The reattach backoff is 1..5s per try; the test does not wait for it.
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realTimeout(fn, 0);

globalThis.Risuai = {};
let outcome = { state: 'error', error: '모델 쪽에서 요청 한도에 걸렸습니다' };
const calls = [];
globalThis.__outcomeTransport = {
  async get(path, query) {
    calls.push('GET ' + path);
    if (path === '/chat/outcome') {
      assert.equal(query.sessionId, 's1');
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    throw new Error(path);
  },
  async post() { return {}; },
  async *stream(path) {
    calls.push('STREAM ' + path);
    if (path === '/chat') yield { type: 'start' };
    throw new Error('network error');
  },
};

const STUB = {
  transport: 'export const transport = globalThis.__outcomeTransport; export class BackendError extends Error {} export const clientLog = async () => {}; export const addressKind = () => "";',
  assets: 'export const syncAssets = () => {}; export const syncBusy = () => false; export const describeSync = () => "";',
  operation: 'export const foregroundWrite = async (_l, fn) => fn(); export const boundedAssets = async () => {};',
  state: 'export const state = {};',
  host: 'export const copyToClipboard = () => false;',
  dom: 'export const el = () => null, clear = () => {}, modal = () => {}, svg = () => null;',
};

/** Bundle `entry` with the named sibling modules replaced by STUB. */
async function load(entry, names) {
  const filter = new RegExp(`^\\.\\.?/(${names.join('|')})$`);
  const r = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm',
    plugins: [{ name: 'stubs', setup(b) {
      b.onResolve({ filter }, (args) => (args.importer.endsWith(entry.split('/').pop())
        ? { path: args.path.replace(/^.*\//, ''), namespace: 'test' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: STUB[path] }));
    } }] });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}

// --- the panel ---------------------------------------------------------------
const { state } = await load('plugin/src/state.ts', ['transport', 'assets', 'operation']);
state.sessionId = 's1';
state.liveModules = [];

async function drive() {
  const got = [];
  let thrown = null;
  try {
    for await (const ev of state.agentChat('hi')) got.push(ev);
  } catch (e) { thrown = e; }
  return { got, thrown };
}

let r = await drive();
assert.equal(calls.filter((c) => c === 'STREAM /chat/attach').length, 5, 'five reattaches first');
assert.equal(calls.at(-1), 'GET /chat/outcome', 'then the outcome is asked');
assert.equal(r.thrown, null, 'the turn error is shown, not thrown');
const last = r.got.at(-1);
assert.equal(last.type, 'error');
assert.match(last.error, /요청 한도/, "the turn's own error leads");
assert.match(last.error, /network error/, 'and the break is named');

outcome = { state: 'running' };
r = await drive();
assert.match(r.got.at(-1).error, /계속 진행 중/);

outcome = { state: 'unknown' };
r = await drive();
assert.equal(r.thrown?.message, 'network error', 'unknown falls back to the break');

outcome = new Error('also down');
r = await drive();
assert.equal(r.thrown?.message, 'network error', 'an unreachable outcome falls back too');

// --- the report ----------------------------------------------------------------
const { logEntry, fitReport } = await load('plugin/src/ui/bugreport.ts', ['state', 'transport', 'host', 'dom']);
const tb = '[2026-10-26 19:38:35] error agent run failed session=649\nTraceback (most recent call last):\n'
  + '  File "x.py", line 220, in _map_api_errors\n'.repeat(20)
  + "pydantic_ai.exceptions.ModelHTTPError: status_code: 429, model_name: g, body: {'message': 'Resource exhausted'}\n";
const e = logEntry(tb);
assert.equal(e.length, 2);
assert.match(e[0], /agent run failed/);
assert.match(e[1], /ModelHTTPError: status_code: 429/, "a traceback keeps its error line");
assert.deepEqual(logEntry('[t] warn  short'), ['[t] warn  short']);

const old = Array.from({ length: 30 }, (_, i) => [`[old ${i}] warn  ` + 'x'.repeat(200)]);
const text = fitReport(['[Risu Hina 오류 제보]'], [...old, e]);
assert.ok(text.length <= 3500, String(text.length));
assert.match(text, /ModelHTTPError: status_code: 429/, 'the newest entry survives the cap');
assert.match(text, /오래된 \d+줄 생략/);
assert.doesNotMatch(text, /\[old 0\]/, 'the oldest goes first');

console.log('PASS agent stream outcome + report log entries');
