/**
 * Plugin smoke test: run the built bundle against a real backend.
 *
 * `tsc --noEmit` proves the types line up and `node --check` proves it parses.
 * Neither runs the code, and the bug class that reached a live chat in
 * active-recall was a ReferenceError in a branch nobody executed. So the bundle
 * is loaded here with a real DOM (linkedom) and a stub host, then driven
 * through the flows a user actually takes.
 *
 * The backend is the real one, started as a child process, so the request
 * shapes are checked against the server rather than against a mock that agrees
 * with whatever the client sends.
 *
 *   node tests/plugin_smoke.mjs
 */
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// linkedom is a devDependency of the plugin package, not of the repo root, so
// it is resolved from there rather than duplicated into a second node_modules.
const pluginRequire = createRequire(pathToFileURL(resolve(ROOT, 'plugin/package.json')));
const { parseHTML } = pluginRequire('linkedom');
const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, 'plugin/package.json'), 'utf8')).version;
const BUNDLE = resolve(ROOT, `plugin/dist/risu-hina-${pkgVersion}.js`);

const failures = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { console.log(`  FAIL ${name}${detail ? ' - ' + detail : ''}`); failures.push(name); }
};

const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// --- backend ----------------------------------------------------------------

async function startBackend() {
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'risuhina-plugin-'));
  let py = resolve(ROOT, 'pyserver/.venv/Scripts/python.exe');
  if (!existsSync(py)) py = 'python';
  const proc = spawn(py, [resolve(ROOT, 'pyserver/run.py')], {
    cwd: resolve(ROOT, 'pyserver'),
    env: {
      ...process.env,
      RISUHINA_PORT: String(port),
      RISUHINA_HOST: '127.0.0.1',
      RISUHINA_DATA_DIR: data,
      RISUHINA_TOKEN: 'plugin-smoke-token',
      RISUHINA_REQUIRE_TOKEN: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });

  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url + '/health');
      const j = await r.json();
      if (j.service === 'risu-hina') return { url, port, data, proc, token: 'plugin-smoke-token', log: () => log };
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('backend did not start:\n' + log);
}

// --- host stub --------------------------------------------------------------

function makeChat(id, name, n) {
  return {
    id, name, note: '', localLore: [], fmIndex: 0,
    arKey: 'someone-elses-stamp',
    modelBinding: { provider: 'p' },
    hypaV3Data: { summaries: [{ text: 's', chatMemos: [`${id}-m1`] }] },
    scriptstate: { '$affection': 3, '$met': true, route: 'A', tags: ['x', 'y'] },
    message: Array.from({ length: n }, (_, i) => ({
      role: i % 2 ? 'char' : 'user',
      data: i % 2
        ? `<Thoughts>내부 추론 ${i}</Thoughts>\n<pk-panel>상태창</pk-panel>\n턴 ${i}: **페데리코**는 신전에 있다. "여기 있었군." '설마 벌써?'`
        : `턴 ${i}: 페데리코는 어디에 있다.`,
      time: 1778892822492 + i * 1000,
      chatId: `${id}-m${i}`,
      ...(i % 2 ? { generationInfo: { model: 'x', inputTokens: 10 } } : {}),
    })),
  };
}

function makeHost(backendUrl, token) {
  const liveChar = {
    name: 'Parma Knights', chaId: 'cha-smoke', type: 'character',
    desc: '설명', firstMessage: '첫 인사',
    image: 'assets/portrait.png',
    globalLore: [{ key: ['k'], content: 'c' }],
    alternateGreetings: ['대체 인사 하나'],
    // forkExtra is a field the schema does not model - it must survive edits.
    customscript: [{ comment: '치환', in: 'foo', out: 'bar', type: 'editdisplay', forkExtra: 7 }],
    triggerscript: [{
      comment: '스모크 트리거', type: 'start', conditions: [], lowLevelAccess: true,
      effect: [{ type: 'triggerlua', code: 'local n = 1\nprint(n)' }],
    }],
    chatFolders: [{ id: 'f1', name: '보관함', color: '#8b5cf6' }],
    // One loose chat plus a folder, so both list paths render.
    chats: [
      makeChat('chatA', '플레이스루 A', 10),
      { ...makeChat('chatB', '옛 플레이스루', 4), folderId: 'f1' },
    ],
    chatPage: 0,
  };
  const calls = [];
  const storage = new Map();
  // 0.7.2: the //@arg fields are gone; the backend address lives only in
  // pluginStorage, which is what a real install has after ⚙ → 연결.
  storage.set('backend', { url: backendUrl, token });
  const dbWrites = [];
  let selectedChar = 0;

  return {
    liveChar,
    calls,
    dbWrites,
    api: {
      async getArgument(k) {
        calls.push('getArgument');
        if (k === 'backend_url') return backendUrl;
        if (k === 'backend_token') return token;
        return '';
      },
      async setArgument() { calls.push('setArgument'); },
      async getRuntimeInfo() {
        calls.push('getRuntimeInfo');
        return { apiVersion: '3.0', platform: 'node', saveMethod: 'local' };
      },
      async nativeFetch(url, opts = {}) {
        calls.push('nativeFetch');
        // Record how the health probe was made: it must be a POST, which no
        // CDN answers from its cache (a cached GET /health error page cost a
        // real deployment a minute of "not connected" on every open).
        if (url.endsWith('/health')) calls.push('health:' + (opts.method || 'GET'));
        // The real bridge rejects a POST with no body; mirror that so the
        // client's own guard is exercised.
        if ((opts.method === 'POST' || opts.method === 'PUT') && opts.body === undefined) {
          throw new Error('Body is required for POST and PUT requests');
        }
        if (opts.networkRoute !== 'local_network') {
          throw new Error('every request must carry networkRoute:local_network');
        }
        if (opts.interceptor === 'openai_streaming') {
          throw new Error('openai_streaming takes the buffering WS path');
        }
        return await fetch(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body });
      },
      async getCurrentCharacterIndex() { calls.push('getCurrentCharacterIndex'); return selectedChar; },
      async getCurrentChatIndex() {
        calls.push('getCurrentChatIndex');
        if (selectedChar < 0) throw new TypeError("Cannot read properties of undefined (reading 'chatPage')");
        return liveChar.chatPage;
      },
      async getCharacterFromIndex() { calls.push('getCharacterFromIndex'); return structuredClone(liveChar); },
      async setCharacterToIndex(i, char) {
        calls.push('setCharacterToIndex');
        // The real host replaces the object whole; mirroring that is what lets
        // the card write-back tests see their fields land (or fail to).
        const next = structuredClone(char);
        for (const k of Object.keys(liveChar)) delete liveChar[k];
        Object.assign(liveChar, next);
      },
      async getDatabase(keys) {
        calls.push('getDatabase');
        return { characters: [structuredClone(liveChar)] };
      },
      async setDatabase(patch) { calls.push('setDatabase'); dbWrites.push(structuredClone(patch)); },
      async checkCharOrder() { calls.push('checkCharOrder'); },
      async getChatFromIndex(ci, chi) { calls.push('getChatFromIndex'); return structuredClone(liveChar.chats[chi] ?? null); },
      async setChatToIndex(ci, chi, chat) {
        calls.push('setChatToIndex');
        if (liveChar.chats[chi]) liveChar.chats[chi] = structuredClone(chat);
      },
      async showContainer() { calls.push('showContainer'); },
      async hideContainer() { calls.push('hideContainer'); },
      async registerSetting(name, cb) { calls.push('registerSetting'); registered.push({ id: 's1', cb }); return { id: 's1' }; },
      async registerButton(a, cb) { calls.push('registerButton'); registered.push({ id: 'b1', cb }); return { id: 'b1' }; },
      async unregisterUIPart() { calls.push('unregisterUIPart'); },
      async readImage(path) {
        calls.push('readImage');
        // A 1x1 GIF: enough for the blob path to run end to end.
        return new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,
                               249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]);
      },
      async saveAsset(data) {
        calls.push('saveAsset');
        // The real host names the key by content hash and always .png.
        let h = 0;
        for (const b of data) h = (h * 31 + b) >>> 0;
        return 'assets/smoke' + h.toString(16) + '.png';
      },
      pluginStorage: {
        async getItem(k) { return storage.get(k); },
        async setItem(k, v) { storage.set(k, v); },
        async removeItem(k) { storage.delete(k); },
      },
      async onUnload(cb) { calls.push('onUnload'); unload = cb; },
      async alert() {}, async alertError() {},
    },
    selectNone() { selectedChar = -1; },
  };
}

const registered = [];
let unload = null;

// --- DOM --------------------------------------------------------------------

function installDom() {
  const { window, document } = parseHTML(
    '<!doctype html><html><head></head><body></body></html>',
  );
  globalThis.window = window;
  globalThis.document = document;
  globalThis.Node = window.Node;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
  globalThis.Blob = window.Blob ?? globalThis.Blob;
  globalThis.URL.createObjectURL = () => 'blob:stub';
  globalThis.URL.revokeObjectURL ??= () => {};
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  // linkedom has no layout, so measured heights are 0. The turn list treats a
  // zero height as "not measured yet" and keeps its estimate, which is exactly
  // the path we want covered here.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { height: 0, width: 0, top: 0, left: 0, right: 0, bottom: 0 };
  };
  document.execCommand = () => true;
  return document;
}

const clickById = (document, id) => {
  const node = document.getElementById(id);
  if (!node) return false;
  node.dispatchEvent(new window.Event('click', { bubbles: true }));
  return true;
};

const findButton = (document, text) =>
  [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text));

const clickButton = (document, text) => {
  const b = findButton(document, text);
  if (!b) return false;
  b.dispatchEvent(new window.Event('click', { bubbles: true }));
  return true;
};

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

// linkedom has no KeyboardEvent constructor, so the key rides on a plain Event.
// The handler only reads `.key`, which is the part worth exercising anyway.
const pressEscape = (document) => {
  const ev = new window.Event('keydown', { bubbles: true });
  ev.key = 'Escape';
  document.dispatchEvent(ev);
};

// Tools live in the left toolbar and their options render into the right
// panel. Activating by data-tool rather than by label keeps the test honest
// about which control it is driving.
const clickTool = (document, tool) => {
  const b = document.querySelector('.tool[data-tool="' + tool + '"]');
  b?.dispatchEvent(new window.Event('click', { bubbles: true }));
  return !!b;
};

const optionInput = (document, placeholder) =>
  [...document.querySelectorAll('.rpanel.active input')]
    .find((i) => i.getAttribute('placeholder') === placeholder);

// --- run --------------------------------------------------------------------

const backend = await startBackend();
console.log(`backend: ${backend.url}`);

const document = installDom();
const host = makeHost(backend.url, 'plugin-smoke-token');
globalThis.Risuai = host.api;

const errors = [];
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e?.message ?? e)));

try {
  new Function(readFileSync(BUNDLE, 'utf8'))();
} catch (e) {
  errors.push('bundle threw on load: ' + e.stack);
}
await settle(200);

console.log('\ntest_registration');
check('registered an entry point', registered.length >= 1, String(registered.length));
check('registered an unload handler', typeof unload === 'function');

console.log('\ntest_open_and_bootstrap');
try {
  await registered[0].cb();
} catch (e) {
  errors.push('open() threw: ' + e.stack);
}
await settle(1500);

check('showContainer called before painting', host.calls.includes('showContainer'));
check('shell rendered', !!document.querySelector('.wrap'));
// Content views in the tab bar; settings is a header verb, not a view. The
// middle of the bar is modal: chat tabs and bot tabs share the slot and only
// one set is visible at a time.
check('eleven content tabs present', document.querySelectorAll('.tab').length === 11,
      [...document.querySelectorAll('.tab')].map((t) => t.textContent).join(','));
check('the workspace files tab is set apart', !!document.querySelector('.tabs .tabsep')
      && document.querySelector('.tabs .tabsep')?.nextElementSibling?.id === 'tab-files');
check('and named for what it is', /워크스페이스 파일/.test(document.getElementById('tab-files')?.textContent || ''));
// The bot half opens first (0.6.1): bot tabs visible, chat tabs hidden.
check('chat tabs start hidden (bot mode)',
      document.getElementById('tab-editor')?.style.display === 'none'
      && document.getElementById('tab-meta')?.style.display !== 'none');
check('no chat bar on the chat picker', document.querySelector('.toolslot .chatbar')?.style.display === 'none');
check('settings is not one of them',
      ![...document.querySelectorAll('.tab')].some((t) => t.textContent === '설정'));
check('settings is reachable from the header',
      document.getElementById('open-settings')?.closest('header') === document.querySelector('header'));
check('backend reached', host.calls.filter((c) => c === 'nativeFetch').length > 0);
{
  // The merge summary the shell announces after a re-open, and the conflict
  // gate on 반영. Both are new in 0.9 and neither has any other coverage.
  const notice = document.querySelector('.shellnotice')?.textContent || '';
  check('a first open announces no merge', !/RisuAI 쪽 변경/.test(notice), notice.slice(0, 80));
}
check('the health probe is a POST, uncacheable by any relay',
      host.calls.includes('health:POST') && !host.calls.includes('health:GET'),
      host.calls.filter((c) => c.startsWith('health:')).join(','));
check('chat list rendered', !!document.querySelector('.chatitem'));

console.log('\ntest_chat_selection_layout');
{
  clickById(document, 'tab-chats');
  await settle(600);
  check('bot section rendered', !!document.querySelector('.botcard'));
  check('portrait attempted', host.calls.includes('readImage'));
  check('bot and chat sections are divided', !!document.querySelector('.sectionline'));
  check('loose chat listed', document.querySelectorAll('.chatlist .chatitem').length >= 1,
        String(document.querySelectorAll('.chatitem').length));
  check('folder rendered', !!document.querySelector('.folder'));
  // 30-50 chats across folders is normal, so folders start collapsed.
  check('folder starts collapsed',
        !document.querySelector('.folderbody.open'));
  const fh = document.querySelector('.folderhead');
  fh?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(200);
  check('folder expands on click', !!document.querySelector('.folderbody.open'));
  // The bot-switching note is an aside under the bot, not a warning banner.
  check('bot-switch note lives in the bot section',
        /다른 봇을 편집하시려면/.test(document.querySelector('.botcard').textContent || ''));
}

console.log('\ntest_asset_sync');
{
  // The background importer starts right after the text upload: the card's
  // one asset (the portrait) is read out of the host and lands in the store,
  // after which the backend reports the bot complete and the picker says so.
  const auth = { Authorization: 'Bearer plugin-smoke-token' };
  const wsList = await (await fetch(backend.url + '/workspace', { headers: auth })).json();
  const ck = wsList.workspaces?.[0]?.charKey || '';
  check('workspace known to the backend', !!ck, JSON.stringify(wsList).slice(0, 120));
  let status = null;
  for (let i = 0; i < 20 && !(status && status.complete); i++) {
    await settle(250);
    status = await (await fetch(backend.url + '/assets/status?charKey=' + encodeURIComponent(ck), { headers: auth })).json();
  }
  check('the store holds the portrait', status?.present === 1 && status?.total === 1, JSON.stringify(status).slice(0, 200));
  check('and reports the bot complete', status?.complete === true);
  check('readImage was used for the missing key', host.calls.filter((c) => c === 'readImage').length >= 1);
  clickById(document, 'tab-chats');
  await settle(600);
  const line = document.querySelector('.botcard .assetsync');
  check('the bot card shows the sync result', /에셋 1\/1개/.test(line?.textContent || ''), line?.textContent);
  // A finished, complete sync offers no button: the picker's job is "pick
  // what to edit", and 다시 동기화 only appears when there is something to
  // retry (an error, a cancel, or failed items). 🔄 restarts it either way.
  check('a clean finished sync offers no retry button', !findButton(line, '다시 동기화'),
        line?.textContent);
  check('and no progress bar once done', !line?.querySelector('.assetbar'));
  // A second sync sends nothing: the store already has the key. Counted on
  // the wire (the picker's portrait thumbnail also calls readImage, so host
  // calls would not tell the two apart).
  const uploads = () => (backend.log().match(/POST \/assets\/upload/g) || []).length;
  const uploadsBefore = uploads();
  check('the first sync uploaded once', uploadsBefore === 1, String(uploadsBefore));
  clickButton(line, '다시 동기화');
  await settle(1200);
  check('a second sync uploads nothing', uploads() === uploadsBefore, `${uploadsBefore} -> ${uploads()}`);
  const again = await (await fetch(backend.url + '/assets/status?charKey=' + encodeURIComponent(ck), { headers: auth })).json();
  check('and is still complete', again?.complete === true && again?.present === 1);
}

console.log('\ntest_health_status');
{
  // Health lives inside the title row now: one dot and a version rather than a
  // second full-width strip above a panel whose job is showing a long transcript.
  const bar = document.querySelector('.status');
  check('status chip exists', !!bar);
  check('it sits in the title row', bar.closest('header') === document.querySelector('header'));
  check('the title row is the first child of the shell',
        document.querySelector('.wrap').firstElementChild === document.querySelector('header'));
  check('it reports the backend version', /백엔드 v/.test(bar.textContent || ''),
        (bar.textContent || '').slice(0, 80));
  // No agent credentials in the test backend, so it should warn, not claim ok.
  check('it flags the missing agent config', bar.className.includes('warn'), bar.className);
  check('there is no separate health strip', !document.querySelector('.healthbar'));
}

console.log('\ntest_editor_tab');
clickById(document, 'tab-editor');
await settle(700);
const turnNodes = document.querySelectorAll('.turn');
check('turns rendered', turnNodes.length > 0, String(turnNodes.length));
check('virtualised', turnNodes.length <= 10, String(turnNodes.length));
// A pencil, not the word - it sits on every row of a 394-row list.
check('every turn has a visible edit button',
      [...turnNodes].every((t) => !!t.querySelector('button[title="이 턴 편집"]')));
check('tools sit above the chat', document.querySelectorAll('.toolrow .tool').length >= 6,
      String(document.querySelectorAll('.toolrow .tool').length));
// The chat-level verbs are the shell's, rendered ahead of the tab's own tools.
check('the chat bar is present', !!document.querySelector('.toolslot .chatbar'));
check('it carries 반영 · 스냅샷 · 버전',
      ['apply', 'snapshot', 'versions'].every((t) => !!document.querySelector('.chatbar .tool[data-tool="' + t + '"]')));
check('the editor tool row no longer has its own 반영',
      !document.querySelector('.tabslot .tool[data-tool="apply"]'));
check('the chat bar comes first',
      document.querySelector('.toolslot')?.firstElementChild?.classList.contains('chatbar'));
check('the change line says nothing is pending yet',
      /변경 없음/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
      document.querySelector('.chatbar .changesum')?.textContent);
// Files are their own view now; a second entry point in the editor was the
// same browser rendered into a third of a column.
check('the editor no longer duplicates the file browser',
      !document.querySelector('.toolrow .tool[data-tool="files"]'));
// Promoted out of the middle column: boxed into a third of the width it read
// as a property of the transcript rather than as this tab's actions.
check('the tool row spans the whole tab',
      !!document.querySelector('.toolslot .toolrow'));
check('it is not inside the transcript column',
      !document.querySelector('.left .toolrow'));
check('right panel has two tabs', document.querySelectorAll('.rtab').length === 2,
      String(document.querySelectorAll('.rtab').length));
check('AI agent is the default right tab',
      document.querySelector('.rpanel.agentwrap').classList.contains('active'));
check('turn explorer column exists', !!document.querySelector('.explorer'));
check('explorer groups turns by 50',
      document.querySelectorAll('.expgroup').length >= 1,
      String(document.querySelectorAll('.expgroup').length));
check('a resize gutter exists', !!document.querySelector('.gutter'));

// Switching to the options tab must still work and start empty.
[...document.querySelectorAll('.rtab')].find((b) => b.textContent === '상세옵션')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(200);
check('options panel starts empty', /위 도구를 선택하시면/.test(document.body.innerHTML));

console.log('\ntest_turn_edit_modal');
{
  const row = document.querySelector('.turn');
  const seq = row.querySelector('.turn-no')?.textContent;
  row.querySelector('button[title="이 턴 편집"]')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  const box = document.querySelector('.modalbox');
  check('the pencil opens a modal', !!box);
  check('it names the turn', new RegExp('턴 ' + seq).test(
        box?.querySelector('.modalhead')?.textContent || ''),
        box?.querySelector('.modalhead')?.textContent);
  const area = box?.querySelector('textarea.turnedit');
  // The whole reason it left the row: a few lines was not enough for a turn
  // that is routinely a screen of prose. The height is in the stylesheet, so
  // that is where it has to be checked - linkedom computes no styles.
  check('the box carries the tall class', area?.classList.contains('turnedit'),
        area?.className);
  check('and that class is sized in viewport heights',
        /textarea[.]turnedit[^}]*min-height:[^;]*vh/.test(
          document.querySelector('style')?.textContent || ''),
        (document.querySelector('style')?.textContent || '')
          .slice((document.querySelector('style')?.textContent || '')
            .indexOf('textarea.turnedit'), 200));
  check('it holds the turn text', (area?.value || '').length > 5, (area?.value || '').slice(0, 60));
  check('the length is counted', /자/.test(box?.textContent || ''));

  area.value = '모달에서 고친 본문입니다.';
  [...box.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1100);
  check('saving closes the modal', !document.querySelector('.modalbox'));
  check('the edit is in the list',
        /모달에서 고친 본문입니다/.test(document.querySelector('.turn')?.textContent || ''),
        (document.querySelector('.turn')?.textContent || '').slice(0, 120));
  check('and the turn is marked changed',
        !!document.querySelector('.turn.changed'));

  // Reopening a changed turn offers the frozen original to compare against.
  document.querySelector('.turn button[title="이 턴 편집"]')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  check('the original is shown for comparison',
        !!findButton(document.querySelector('.modalbox'), '원본으로 되돌리기'));
  clickButton(document.querySelector('.modalbox'), '원본으로 되돌리기');
  await settle(200);
  check('reverting refills the box, without saving',
        !/모달에서 고친/.test(document.querySelector('.modalbox textarea')?.value || ''),
        (document.querySelector('.modalbox textarea')?.value || '').slice(0, 60));
  [...document.querySelectorAll('.modalbox button')].find((b) => b.textContent === '취소')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  check('cancelling leaves the edit in place',
        !!document.querySelector('.turn.changed'));
}

console.log('\ntest_view_modes');
{
  const bodyText = () => [...document.querySelectorAll('.turn-body')].map((n) => n.textContent).join('\n');
  check('clean mode is the default - thinking block hidden', !bodyText().includes('내부 추론'));
  check('clean mode renders emphasis as an element',
        document.querySelectorAll('.turn-body strong').length > 0);
  // The card's own regexes colour these on the chat screen; the stored text is
  // flat, so reading a log here was a wall of one colour.
  check('double-quoted speech is coloured',
        document.querySelectorAll('.turn-body .speech').length > 0,
        String(document.querySelectorAll('.turn-body .speech').length));
  check('single-quoted thought is coloured',
        document.querySelectorAll('.turn-body .thought').length > 0,
        String(document.querySelectorAll('.turn-body .thought').length));
  check('the quote marks are kept, since edits target the raw text',
        [...document.querySelectorAll('.turn-body .speech')]
          .every((n) => /^["\u201C]/.test(n.textContent || '')));

  check('view tool activates', clickTool(document, 'view'));
  await settle(300);
  check('three view modes offered', document.querySelectorAll('.modebtn').length === 3,
        String(document.querySelectorAll('.modebtn').length));
  check('strip options are visible in clean mode',
        document.querySelectorAll('.rpanel.active label.checkrow').length === 5,
        String(document.querySelectorAll('.rpanel.active label.checkrow').length));

  const mode = (m) => document.querySelector('.modebtn[data-mode="' + m + '"]');
  mode('raw').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(400);
  check('raw mode shows the thinking block', bodyText().includes('내부 추론'));
  check('raw mode shows the asterisks', bodyText().includes('**'));
  check('raw mode colours nothing', document.querySelectorAll('.turn-body .speech').length === 0);
  // The strip toggles cannot do anything outside clean mode, so they leave
  // the screen rather than sit greyed out.
  check('strip options hidden outside clean mode',
        document.querySelector('.stripopts')?.style.display === 'none',
        String(document.querySelector('.stripopts')?.style.display));

  mode('rendered').dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(400);
  check('rendered mode says it is not implemented yet',
        /아직 준비 중입니다/.test(document.body.innerHTML));
  check('rendered mode falls back to clean, not raw', !bodyText().includes('내부 추론'));

  clickTool(document, 'view');
  await settle(200);
  check('clicking the active tool closes it', /위 도구를 선택하시면/.test(document.body.innerHTML));
}

console.log('\ntest_turn_numbers_and_range');
{
  const nos = () => [...document.querySelectorAll('.turn .turn-no')].map((n) => n.textContent);
  check('every rendered turn carries its number',
        document.querySelectorAll('.turn').length === document.querySelectorAll('.turn-no').length,
        `${document.querySelectorAll('.turn').length} turns / ${document.querySelectorAll('.turn-no').length} numbers`);
  check('the numbers are the seq values', nos().includes('0') && nos().includes('3'), nos().join(','));

  check('view tool reopens', clickTool(document, 'view'));
  await settle(300);
  const rangeRow = document.querySelector('.rpanel.active .rangerow');
  const range = [...(rangeRow?.querySelectorAll('input') ?? [])];
  // Scoped: a substring match on 적용 also hits the rendered-mode hint.
  const applyRange = () => [...(rangeRow?.querySelectorAll('button') ?? [])]
    .find((b) => b.textContent === '적용')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  check('a start and an end field are offered', range.length === 2, String(range.length));

  range[0].value = '2';
  range[1].value = '4';
  applyRange();
  await settle(500);
  const shown = nos().map(Number);
  check('only the range is listed', shown.length === 3 && Math.min(...shown) === 2
        && Math.max(...shown) === 4, shown.join(','));
  check('the filter announces itself', /2–4번 턴만 보고 있습니다/.test(document.body.innerHTML));
  check('the count line reports the narrowing', /표시 3/.test(document.body.innerHTML));

  // Reversed input is a typo, not an error worth stopping for.
  range[0].value = '6';
  range[1].value = '5';
  applyRange();
  await settle(500);
  check('a reversed range is read in order', nos().map(Number).sort().join(',') === '5,6',
        nos().join(','));

  // An empty box means the end of the chat, not turn 0 - Number('') is 0.
  range[0].value = '7';
  range[1].value = '';
  applyRange();
  await settle(500);
  check('an empty end field runs to the last turn',
        nos().map(Number).sort((a, b) => a - b).join(',') === '7,8,9', nos().join(','));

  clickButton(document, '전체 보기');
  await settle(500);
  check('clearing restores every turn', document.querySelectorAll('.turn').length > 3,
        String(document.querySelectorAll('.turn').length));
  check('the filter bar is gone',
        document.querySelector('.filterbar')?.style.display === 'none',
        String(document.querySelector('.filterbar')?.style.display));

  clickTool(document, 'view');
  await settle(200);
}

console.log('\ntest_find_replace');
{
  check('find tool activates', clickTool(document, 'find'));
  await settle(300);
  const pattern = optionInput(document, '찾을 문자열');
  const replacement = optionInput(document, '바꿀 문자열');
  check('find inputs present', !!pattern && !!replacement);
  check('regex switch is gone',
        [...document.querySelectorAll('.rpanel.active')].every((n) => !/정규식/.test(n.textContent || '')));

  const applyBtn = () => [...document.querySelectorAll('.rpanel.active button')]
    .find((b) => b.textContent === '적용');
  check('apply disabled before preview', applyBtn() && applyBtn().disabled);

  pattern.value = '페데리코';
  replacement.value = '페데리꼬';
  clickButton(document, '미리보기');
  await settle(900);
  check('preview renders in the turn list', document.querySelectorAll('.turn.preview').length > 0,
        String(document.querySelectorAll('.turn.preview').length));
  check('apply enabled after preview', applyBtn() && !applyBtn().disabled);

  applyBtn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);
  check('preview cleared after apply', document.querySelectorAll('.turn.preview').length === 0);
  check('turns show as changed', document.querySelectorAll('.turn.changed').length > 0,
        String(document.querySelectorAll('.turn.changed').length));
  await settle(400);
  check('the chat bar counts the edited turns',
        /턴 수정 \d+/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);
  check('and badges the 반영 button',
        (document.querySelector('.chatbar .applybadge')?.textContent || '') !== '0'
        && document.querySelector('.chatbar .applybadge')?.style.display !== 'none');
}

console.log('\ntest_write_back_to_host');
{
  const before = JSON.stringify(host.liveChar.chats[0].message);
  check('반영 opens from the chat bar', clickTool(document, 'apply'));
  await settle(300);
  check('it opens a popover with the verbs', !!document.querySelector('.popover .applypop'));
  check('the popover names what will be written',
        /턴 수정/.test(document.querySelector('.popover')?.textContent || ''),
        document.querySelector('.popover')?.textContent?.slice(0, 120));
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(900);
  check('setChatToIndex was called', host.calls.includes('setChatToIndex'));
  const after = host.liveChar.chats[0].message;
  check('host chat actually changed', JSON.stringify(after) !== before);
  check('edit landed in the host', after.some((m) => m.data.includes('페데리꼬')),
        after[0]?.data ?? '');
  check('chatIds preserved', after.every((m, i) => m.chatId === `chatA-m${i}`));
  check('generationInfo preserved',
        after[1]?.generationInfo?.inputTokens === 10, JSON.stringify(after[1] ?? {}));
  check('message count unchanged', after.length === 10, String(after.length));
}

console.log('\ntest_commit_rebases_the_baseline');
{
  await settle(1000);
  // The reported bug: after a write-back every edited turn stayed struck
  // through, because the baseline never moved and the panel kept diffing
  // against the pre-edit text. A shipped edit is not a pending edit.
  const stillChanged = document.querySelectorAll('.turn.changed').length;
  check('no turn is still marked changed after a successful write-back',
        stillChanged === 0, String(stillChanged));
  const struck = document.querySelectorAll('.diff-del').length;
  check('nothing is still rendered struck through', struck === 0, String(struck));
  check('the chat bar is back to 변경 없음',
        /변경 없음/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);
}

console.log('\ntest_unverified_write_keeps_the_working_copy');
{
  // A resolved setChatToIndex is not a kept write: mainline's save encoder
  // can skip it, another RisuAI window can save its stale copy over ours.
  // The host here swallows the write; the panel must keep the edits, say so,
  // and neither commit nor re-read (the re-read is what used to replace the
  // working copy with the text the write had just failed to change).
  check('find tool activates', clickTool(document, 'find'));
  await settle(300);
  // The tool button toggles; if find was already the active tool the first
  // click closed it - click again until the inputs are actually there.
  if (!optionInput(document, '찾을 문자열')) { clickTool(document, 'find'); await settle(300); }
  optionInput(document, '찾을 문자열').value = '페데리꼬';
  optionInput(document, '바꿀 문자열').value = '페데리코';
  clickButton(document, '미리보기');
  await settle(900);
  const applyBtn = () => [...document.querySelectorAll('.rpanel.active button')]
    .find((b) => b.textContent === '적용');
  applyBtn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);

  const before = JSON.stringify(host.liveChar.chats[0].message);
  const real = host.api.setChatToIndex;
  host.api.setChatToIndex = async () => { host.calls.push('setChatToIndex:dropped'); };
  clickTool(document, 'apply');
  await settle(300);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(900);
  check('the write was attempted and dropped', host.calls.includes('setChatToIndex:dropped'));
  check('the popover says the write was not kept',
        /받지 않았습니다/.test(document.querySelector('.popover')?.textContent || ''),
        document.querySelector('.popover')?.textContent?.slice(0, 160));
  check('the host chat is untouched',
        JSON.stringify(host.liveChar.chats[0].message) === before);
  await settle(400);
  check('the edits are still pending',
        /턴 수정 \d+/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);

  // The host comes back; the same press now lands, verifies, and commits.
  host.api.setChatToIndex = real;
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1500);
  check('the retry landed',
        host.liveChar.chats[0].message.some((m) => m.data.includes('페데리코')));
  await settle(600);
  check('and the chat bar is clean again',
        /변경 없음/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);
}

console.log('\ntest_discard_button_resolves_the_session');
{
  // 변경 취소 lives on the bar itself now, visible only while something is
  // pending, and discards the whole chat scope in two clicks.
  const discardBtn = () => document.querySelector('.chatbar [data-tool="discard"]');
  check('discard is hidden while clean', discardBtn()?.style.display === 'none',
        discardBtn()?.style.display);

  check('find tool activates', clickTool(document, 'find'));
  await settle(300);
  if (!optionInput(document, '찾을 문자열')) { clickTool(document, 'find'); await settle(300); }
  optionInput(document, '찾을 문자열').value = '페데리코';
  optionInput(document, '바꿀 문자열').value = '페데리꼬';
  clickButton(document, '미리보기');
  await settle(900);
  const applyBtn = () => [...document.querySelectorAll('.rpanel.active button')]
    .find((b) => b.textContent === '적용');
  applyBtn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);

  check('discard appears once something is pending', discardBtn()?.style.display !== 'none');
  // The 반영 popover no longer carries a reset row - one verb, one place.
  clickTool(document, 'apply');
  await settle(300);
  check('the popover no longer hides a reset row',
        !/기준선으로 되돌리기/.test(document.querySelector('.popover')?.textContent || ''));
  clickTool(document, 'apply');
  await settle(200);

  const before = JSON.stringify(host.liveChar.chats[0].message);
  discardBtn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(200);
  check('first click only arms', /정말 버릴까요/.test(discardBtn()?.textContent || ''),
        discardBtn()?.textContent);
  discardBtn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);
  check('the discard names what went',
        /버렸습니다.*턴 \d+건/.test(document.querySelector('.notice.ok')?.textContent || ''),
        document.querySelector('.notice.ok')?.textContent);
  check('the chat bar is clean after the discard',
        /변경 없음/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);
  check('and the host was never written', JSON.stringify(host.liveChar.chats[0].message) === before);
  await settle(300);
  check('discard hides again once clean', discardBtn()?.style.display === 'none',
        discardBtn()?.style.display);
}

console.log('\ntest_truncate_with_preview');
{
  check('cut tool activates', clickTool(document, 'cut'));
  await settle(300);
  const from = optionInput(document, '시작 턴');
  const to = optionInput(document, '끝 턴');
  check('cut inputs present', !!from && !!to);
  from.value = '0';
  to.value = '2';
  clickButton(document, '미리보기');
  await settle(500);
  check('doomed turns are marked in the list',
        document.querySelectorAll('.turn.doomed').length > 0,
        String(document.querySelectorAll('.turn.doomed').length));
  check('nothing deleted by a preview', host.liveChar.chats[0].message.length === 10,
        String(host.liveChar.chats[0].message.length));

  // Destructive controls are two-click by design; one click only arms them.
  clickButton(document, '적용');
  await settle(200);
  check('first click only arms', host.liveChar.chats[0].message.length === 10);
  clickButton(document, '정말 삭제할까요?');
  await settle(1000);

  clickTool(document, 'apply');
  await settle(300);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1200);
  check('structural write shortened the host chat',
        host.liveChar.chats[0].message.length === 7,
        String(host.liveChar.chats[0].message.length));
}

console.log('\ntest_workspace_files');
{
  // Seed the kind of thing the agent leaves behind: a document in scratch/
  // (a deliverable in the wrong folder) next to a script (internal). Written
  // straight into the workspace, because there is no HTTP route for it - the
  // agent's write tool is the only writer.
  const wsRoot = join(backend.data, 'workspace');
  const charDir = join(wsRoot, readdirSync(wsRoot)[0]);
  mkdirSync(join(charDir, 'scratch'), { recursive: true });
  mkdirSync(join(charDir, 'scripts'), { recursive: true });
  writeFileSync(join(charDir, 'scratch', 'draft-summary.md'), '# 초안' + String.fromCharCode(10) + '본문');
  writeFileSync(join(charDir, 'scratch', 'numbers.txt'), '1 2 3');
  writeFileSync(join(charDir, 'scripts', 'helper.py'), 'print(1)');

  // No pinned download card in the agent panel any more - a file shows up as
  // one line in the log, and the files tab is where files are listed.
  check('the agent panel has no pinned output card',
        !/만들어진 파일/.test(document.querySelector('.agentpanel')?.textContent || ''));

  clickById(document, 'tab-files');
  await settle(1100);
  check('the file view has its own three panes', !!document.querySelector('.panel.active .split'));
  check('the left pane is a folder tree', !!document.querySelector('.panel.active .tree.filetree'));
  check('the agent came along', !!document.querySelector('.panel.active .agentpanel'));

  const tree = document.querySelector('.panel.active .tree');
  check('upload is offered', !!findButton(tree, '올리기'));
  check('a whole folder can be uploaded', !!findButton(tree, '폴더 올리기'));
  check('cleaning is offered', !!findButton(tree, '임시 정리'));

  // Only what a person put in or would take out. The frozen originals, the
  // generated helper and the scratch are real but not interesting.
  check('internal areas are hidden by default',
        !/원본/.test(tree?.textContent || ''), (tree?.textContent || '').slice(0, 200));
  check('and the toggle says how many are hidden',
        /내부 파일 보기 [(]\d+[)]/.test(tree?.textContent || ''),
        (tree?.textContent || '').slice(-120));
  // A document in scratch/ is a deliverable: it gets a folder of its own in
  // the tree, and its files are listed in the centre without unfolding the
  // internals; the script beside it stays behind the toggle.
  check('documents in scratch/ get a folder of their own', /임시 문서/.test(tree?.textContent || ''),
        (tree?.textContent || '').slice(0, 300));
  const docsBranch = [...tree.querySelectorAll('.treebranch')].find((b) => /임시 문서/.test(b.textContent || ''));
  docsBranch?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  const centre = () => document.querySelector('.panel.active .left');
  check('the centre lists the surfaced documents',
        /draft-summary\.md/.test(centre()?.textContent || '') && /numbers\.txt/.test(centre()?.textContent || ''),
        (centre()?.textContent || '').slice(0, 300));
  check('the script stays out of it', !/helper\.py/.test(centre()?.textContent || ''));
  check('rows carry a checkbox for multi-select',
        document.querySelectorAll('.panel.active .filelist .frow input[type=checkbox]').length >= 2);
  check('the files tab button carries a badge slot', !!document.querySelector('#tab-files .tabbadge'));

  clickButton(tree, '내부 파일 보기');
  await settle(900);
  const tree2 = document.querySelector('.panel.active .tree');
  check('revealing shows the frozen original', /원본/.test(tree2?.textContent || ''),
        (tree2?.textContent || '').slice(0, 200));

  // original/ is the diff baseline: its files list, open and download, but
  // the delete verb stays disabled however many are selected.
  const originalBranch = [...tree2.querySelectorAll('.treebranch')].find((b) => /원본/.test(b.textContent || ''));
  check('the original branch is listed', !!originalBranch);
  originalBranch?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  const rows = [...document.querySelectorAll('.panel.active .filelist .frow:not(.head)')];
  check('the original folder lists its files', rows.length > 0, String(rows.length));
  rows[0]?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(200);
  check('a row can be selected', !!document.querySelector('.panel.active .filelist .frow.sel'));
  const bar = document.querySelector('.panel.active .filebar');
  const delBtn = findButton(bar, '삭제');
  check('original files cannot be deleted', !!delBtn && delBtn.disabled, delBtn ? String(delBtn.disabled) : 'no button');
  const dlBtn = findButton(bar, '내려받기');
  check('but can be downloaded', !!dlBtn && !dlBtn.disabled);
  const row0 = document.querySelector('.panel.active .filelist .frow:not(.head)');
  row0?.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  await settle(900);
  check('double-click opens the file in the middle pane',
        !!document.querySelector('.panel.active .left .filepreview'));
  clickButton(document.querySelector('.panel.active .left'), '목록으로');
  await settle(200);
  check('and the list comes back', !!document.querySelector('.panel.active .filelist'));

  clickButton(document.querySelector('.panel.active .tree'), '내부 파일 숨기기');
  await settle(600);
}

console.log('\ntest_lore_view');
{
  clickById(document, 'tab-lore');
  await settle(1000);
  check('the lorebook view has three panes', !!document.querySelector('.panel.active .split'));
  // Only the chat's own lore. The fixture character has a globalLore entry, so
  // this also proves the bot's lorebook is not being shown here.
  const loreTree = () => document.querySelector('.panel.active .tree')?.textContent || '';
  // Checked on the scope headers, not the whole column: the empty state
  // explains where bot-level lore went, and that sentence names it.
  check('the bot lorebook is not shown here',
        ![...document.querySelectorAll('.panel.active .treescope')]
          .some((h) => /봇 전체/.test(h.textContent || '')),
        [...document.querySelectorAll('.panel.active .treescope')]
          .map((h) => h.textContent).join(','));
  check('and it says where bot-level editing went',
        /봇 로어북/.test(loreTree()), loreTree().slice(0, 200));

  clickButton(document.querySelector('.panel.active .tree'), '새 항목');
  await settle(1100);
  check('a new entry opens for editing',
        !!document.querySelector('.panel.active .left textarea'));
  const centre = document.querySelector('.panel.active .left');
  check('it is scoped to this chat, not the whole bot',
        /이 챗의 로어북/.test(centre?.textContent || ''), centre?.textContent?.slice(0, 120));
  const inputs = [...centre.querySelectorAll('input')];
  inputs[0].value = '스모크 항목';
  centre.querySelector('textarea').value = '# 제목' + String.fromCharCode(10) + '본문입니다.';
  // The editor carries a folder select for 폴더 간 이동 (no preview pane -
  // removed by user decision 2026-08-24).
  check('a folder select is offered', !!centre.querySelector('select'));
  clickButton(centre, '저장');
  await settle(1100);
  check('the entry is listed by name',
        /스모크 항목/.test(document.querySelector('.panel.active .tree')?.textContent || ''),
        (document.querySelector('.panel.active .tree')?.textContent || '').slice(0, 200));
  // One entry, not two: the character's globalLore must not have joined it.
  check('only the chat entry is listed',
        document.querySelectorAll('.panel.active .tree button.treefile').length === 1,
        String(document.querySelectorAll('.panel.active .tree button.treefile').length));
  check('and marked as edited',
        /수정|추가/.test(document.querySelector('.panel.active .tree')?.textContent || ''));
  check('it does not claim another tab does the writing',
        !/챗 에딧 탭/.test(document.querySelector('.panel.active')?.textContent || ''));

  // The chat bar is on this tab as well, and it counts the lorebook.
  await settle(400);
  check('the chat bar is on the lorebook tab', !!document.querySelector('.toolslot .chatbar')
        && document.querySelector('.toolslot .chatbar')?.style.display !== 'none');
  check('it counts the new entry',
        /로어북 \+1/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);

  // And 반영 from here writes the lorebook into the live chat - the path that
  // did not exist before: entries were saved to a table nothing wrote back.
  const msgsBefore = JSON.stringify(host.liveChar.chats[0].message);
  clickTool(document, 'apply');
  await settle(300);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1200);
  const lore = host.liveChar.chats[0].localLore || [];
  check('the lorebook entry reached the host', lore.some((e) => e.comment === '스모크 항목'),
        JSON.stringify(lore).slice(0, 200));
  check('the transcript was not disturbed by it',
        JSON.stringify(host.liveChar.chats[0].message) === msgsBefore);
  await settle(600);
  check('the entry is original after the write',
        !/수정|추가/.test(document.querySelector('.panel.active .tree')?.textContent || ''),
        (document.querySelector('.panel.active .tree')?.textContent || '').slice(0, 200));
}

console.log('\ntest_memory_view');
{
  clickById(document, 'tab-memory');
  await settle(1100);
  check('the memory view has three panes', !!document.querySelector('.panel.active .split'));
  check('it has its own tool row', !!document.querySelector('.tabslot .toolrow'));
  check('it has no 반영 of its own', !findButton(document.querySelector('.tabslot'), '반영'));
  check('the chat bar offers 반영 here too', !!document.querySelector('.chatbar .tool[data-tool="apply"]'));

  // The fixture chat carries a hypaV3 summary, so it must have been taken
  // apart into rows rather than left as a JSON blob.
  const tree = document.querySelector('.panel.active .tree');
  check('the summary was ingested as an entry',
        /HypaV3/.test(tree?.textContent || ''), (tree?.textContent || '').slice(0, 200));

  const entry = tree?.querySelector('button.treefile');
  check('an entry can be opened', !!entry);
  entry?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(700);
  const centre = document.querySelector('.panel.active .left');
  check('its text is editable', !!centre?.querySelector('textarea'));
  check('it explains why this matters',
        /이후 답변이 계속 그 위에 쌓입니다/.test(centre?.textContent || ''));

  const box = centre.querySelector('textarea');
  box.value = '고친 요약입니다.';
  clickButton(centre, '저장');
  await settle(1100);
  check('the edit is marked in the list',
        /수정/.test(document.querySelector('.panel.active .tree')?.textContent || ''),
        (document.querySelector('.panel.active .tree')?.textContent || '').slice(0, 200));
  check('and the original is kept for comparison',
        /원본/.test(document.querySelector('.panel.active .left')?.textContent || ''));

  await settle(400);
  check('the chat bar counts the memory edit',
        /장기기억 1/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);

  // Writing back must touch only the memory fields, never the transcript.
  const before = host.liveChar.chats[0].message.length;
  clickTool(document, 'apply');
  await settle(300);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1400);
  check('the transcript is untouched by a memory write',
        host.liveChar.chats[0].message.length === before, String(before));
  check('the summary reached the host',
        JSON.stringify(host.liveChar.chats[0].hypaV3Data || {}).includes('고친 요약'),
        JSON.stringify(host.liveChar.chats[0].hypaV3Data || {}).slice(0, 200));
}

console.log('\ntest_chat_variables_view');
{
  clickById(document, 'tab-vars');
  await settle(1100);
  check('the variables view exists', !!document.querySelector('.panel.active .vartable'),
        (document.querySelector('.panel.active')?.textContent || '').slice(0, 200));
  check('the chat bar is on it', document.querySelector('.toolslot .chatbar')?.style.display !== 'none');
  const rows = [...document.querySelectorAll('.panel.active .varrow')];
  check('each fixture variable is a row', rows.length === 4, String(rows.length));
  const aff = rows.find((r) => /\$affection/.test(r.textContent || ''));
  check('a $ key is listed with its type', !!aff && /숫자/.test(aff.textContent || ''), aff?.textContent);
  const input = aff?.querySelector('input');
  input.value = '9';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  clickButton(aff, '저장');
  await settle(1100);
  const aff2 = [...document.querySelectorAll('.panel.active .varrow')].find((r) => /\$affection/.test(r.textContent || ''));
  check('the edit is marked', /수정/.test(aff2?.textContent || ''), aff2?.textContent);
  await settle(400);
  check('the chat bar counts it as a variable, not a memory',
        /챗 변수 1/.test(document.querySelector('.chatbar .changesum')?.textContent || '')
        && !/장기기억/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);

  clickTool(document, 'apply');
  await settle(300);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1400);
  const st = host.liveChar.chats[0].scriptstate || {};
  check('the variable reached the host as a number', st['$affection'] === 9, JSON.stringify(st));
  check('the other variables kept their types', st['$met'] === true && Array.isArray(st.tags), JSON.stringify(st));

  clickById(document, 'tab-memory');
  await settle(900);
  check('the memory tab does not list variables',
        !/\$affection/.test(document.querySelector('.panel.active .tree')?.textContent || ''));
}

console.log('\ntest_bot_tabs');
{
  // One picker, two modes: 봇 편집 on the picker swaps the bar's middle to
  // the bot tabs and lands on 메타.
  clickById(document, 'tab-chats');
  await settle(600);
  clickButton(document.querySelector('.panel.active'), '봇 편집');
  await settle(900);
  check('봇 편집 swaps to bot mode', document.getElementById('tab-meta')?.style.display !== 'none'
        && document.getElementById('tab-editor')?.style.display === 'none');
  check('and lands on 메타', document.getElementById('tab-meta')?.classList.contains('active'));
  check('the bot bar shows on bot tabs',
        document.querySelector('.toolslot .botbar')?.style.display !== 'none');
  // The asset importer finished earlier (test_asset_sync), so the gate on
  // 반영 is open: the apply verb is not dimmed and its title is the plain one.
  const applyTool = document.querySelector('.botbar .tool[data-tool="card-apply"]');
  check('the asset gate is open after the sync', !!applyTool && !applyTool.classList.contains('dimmed'),
        applyTool?.title);
  check('and the chat bar does not',
        document.querySelector('.toolslot .chatbar')?.style.display === 'none');
  const tree = () => document.querySelector('.panel.active .tree');
  check('card fields listed as rows', /설명 \(desc\)/.test(tree()?.textContent || '')
        && /대체 인사말 #1/.test(tree()?.textContent || ''), tree()?.textContent?.slice(0, 200));
  check('retired fields are gone', !/시나리오|성격|시스템 프롬프트/.test(tree()?.textContent || ''));
  check('greetings sit under the first message', (() => {
    const labels = [...tree()?.querySelectorAll('.treefile') ?? []].map((b) => b.textContent || '');
    const fm = labels.findIndex((t) => /퍼스트 메시지/.test(t));
    return fm >= 0 && /대체 인사말 #1/.test(labels[fm + 1] || '');
  })(), [...tree()?.querySelectorAll('.treefile') ?? []].map((b) => b.textContent).join(','));

  clickButton(tree(), '설명 (desc)');
  await settle(400);
  const centre = document.querySelector('.panel.active .left');
  const box = centre?.querySelector('textarea');
  check('the field opens for editing', !!box && box.value === '설명', box?.value);
  box.value = '스모크가 고친 설명';
  clickButton(centre, '저장');
  await settle(1100);
  check('the row wears a 수정 badge',
        /수정/.test([...tree().querySelectorAll('.treerow')]
          .find((r) => /설명 \(desc\)/.test(r.textContent || ''))?.textContent || ''));
  check('the bot bar counts the change',
        /메타 1/.test(document.querySelector('.botbar .changesum')?.textContent || ''),
        document.querySelector('.botbar .changesum')?.textContent);
  // The reopened field says what changed, not just that it did: a folded
  // diff card, and the box can be taken full-screen.
  {
    const c2 = document.querySelector('.panel.active .left');
    check('the editor offers 집중 편집', !!findButton(c2, '집중 편집'));
    const diffBtn = findButton(c2, '변경 내용 보기');
    check('an edited field offers its diff', !!diffBtn, c2?.textContent?.slice(0, 200));
    diffBtn?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(100);
    check('the diff marks the removed and the added line',
          !!c2?.querySelector('.diffview .diffline.del') && !!c2?.querySelector('.diffview .diffline.ins'),
          c2?.querySelector('.diffview')?.textContent?.slice(0, 120));
    clickButton(c2, '집중 편집');
    await settle(100);
    const big = document.querySelector('.modalbox.focusmodal textarea');
    check('집중 편집 opens the box full-screen with the same text', !!big && big.value === '스모크가 고친 설명', big?.value);
    pressEscape(document);
    await settle(100);
    check('and closes without a trace', !document.querySelector('.modalbox.focusmodal'));
  }

  // 에셋: the store's manifest, grouped by field, with the sync state per row.
  clickById(document, 'tab-assets');
  await settle(900);
  check('the assets tab is a bot tab', document.getElementById('tab-assets')?.style.display !== 'none'
        && document.getElementById('tab-assets')?.classList.contains('active'));
  // A grid of thumbnails with the name under each; the portrait is a cell too.
  const grid = () => document.querySelector('.panel.active .assetgrid');
  check('assets are a grid', !!grid() && grid().querySelectorAll('.assetcell').length === 1,
        String(grid()?.querySelectorAll('.assetcell').length));
  check('the portrait cell carries its name and a thumbnail attempt',
        /프로필/.test(grid()?.querySelector('.assetname')?.textContent || '')
        && !!grid()?.querySelector('.assetpic img, .assetpic .assettype'));
  check('the side column totals the assets', /에셋 1개/.test(document.querySelector('.panel.active .tree')?.textContent || ''),
        document.querySelector('.panel.active .tree')?.textContent?.slice(0, 120));
  check('the find box sits on the menu line', !!document.querySelector('.tabslot .searchbox input'));
  check('the sync badge sits at the end of the tab row', /에셋 1\/1/.test(document.querySelector('.tabs .syncbadge')?.textContent || ''),
        document.querySelector('.tabs .syncbadge')?.textContent);
  check('bulk tools are offered once the sync is done', !!findButton(document.querySelector('.panel.active .tree'), '확장자 일괄 제거'));
  // charx lives on the bot bar, next to 반영, and is open because the sync finished.
  const charxTool = document.querySelector('.botbar .tool[data-tool="card-charx"]');
  check('charx is a bot bar verb', !!charxTool && !charxTool.classList.contains('dimmed'), charxTool?.title);
  check('it opens a popover', clickTool(document, 'card-charx'));
  await settle(300);
  clickButton(document.querySelector('.popover'), 'charx 만들기');
  // The build zips on the backend; wait for the shell notice rather than a fixed pause.
  for (let i = 0; i < 40 && !/out\//.test(document.querySelector('.shellnotice')?.textContent || ''); i++) await settle(250);
  check('charx built with the portrait in it', /에셋 1개/.test(document.querySelector('.shellnotice')?.textContent || '')
        && /out\//.test(document.querySelector('.shellnotice')?.textContent || ''),
        'notice=' + JSON.stringify(document.querySelector('.shellnotice')?.textContent) + ' popover=' + JSON.stringify(document.querySelector('.popover')?.textContent?.slice(0, 200)));
  pressEscape(document);
  await settle(200);
  clickById(document, 'tab-files');
  await settle(900);
  // The tree holds folders; the file is in the centre once 결과물 is picked.
  const outBranch = [...document.querySelectorAll('.panel.active .tree .treebranch')].find((b) => /결과물/.test(b.textContent || ''));
  check('out/ is a folder in the tree', !!outBranch, document.querySelector('.panel.active .tree')?.textContent?.slice(0, 200));
  outBranch?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  const charxRow = [...document.querySelectorAll('.panel.active .filelist .frow:not(.head)')].find((r) => /\.charx/.test(r.textContent || ''));
  check('the charx shows up under out/', !!charxRow, document.querySelector('.panel.active .left')?.textContent?.slice(0, 200));
  charxRow?.dispatchEvent(new window.Event('dblclick', { bubbles: true }));
  await settle(500);
  check('a binary file offers 내 PC에 저장', !!findButton(document.querySelector('.panel.active'), '내 PC에 저장'));
  clickById(document, 'tab-meta');
  await settle(400);

  // Regex: the whole-entry write must keep fields the schema never modelled.
  clickById(document, 'tab-regex');
  await settle(900);
  clickButton(document.querySelector('.panel.active .tree'), '1. 치환');
  await settle(400);
  const rc = document.querySelector('.panel.active .left');
  const outBox = [...(rc?.querySelectorAll('textarea') ?? [])][1];
  check('the regex opens with its out text', outBox?.value === 'bar', outBox?.value);
  outBox.value = 'baz';
  clickButton(rc, '저장');
  await settle(1100);
  check('the bot bar counts regex too',
        /Regex ~1/.test(document.querySelector('.botbar .changesum')?.textContent || ''),
        document.querySelector('.botbar .changesum')?.textContent);
  check('the background pair is listed here',
        /백그라운드 HTML/.test(document.querySelector('.panel.active .tree')?.textContent || ''));
  check('reorder lives in the list, not the editor',
        !!document.querySelector('.panel.active .tree .movebtn') && !findButton(rc, '↑ 위로'));

  // Trigger: RisuAI's three modes. The card is in Lua mode, so the editor is
  // ONE text box with the code - no list, no event type, never JSON.
  clickById(document, 'tab-trigger');
  await settle(900);
  const tc = document.querySelector('.panel.active .left');
  const modes = document.querySelector('.panel.active .tree');
  check('mode switch shows V2 and Lua like RisuAI', !!findButton(modes, 'V2') && !!findButton(modes, 'Lua')
        && modes?.querySelector('.modebtn.on')?.textContent === 'Lua', modes?.textContent?.slice(0, 120));
  const codeBox = tc?.querySelector('textarea');
  check('the Lua script opens as one code box', codeBox?.value === 'local n = 1\nprint(n)',
        JSON.stringify(codeBox?.value));
  check('with no per-trigger event selector', !tc?.querySelector('select') && !/실행 시점/.test(tc?.textContent || ''));
  codeBox.value = 'local n = 2\nprint(n)';
  clickButton(tc, '저장');
  await settle(1100);
  check('the bot bar counts the trigger',
        /트리거 ~1/.test(document.querySelector('.botbar .changesum')?.textContent || ''),
        document.querySelector('.botbar .changesum')?.textContent);
}

console.log('\ntest_card_write_back');
{
  const chatsBefore = JSON.stringify(host.liveChar.chats);
  check('반영 opens from the bot bar', clickTool(document, 'card-apply'));
  await settle(300);
  check('the popover names what will be written',
        /메타 1/.test(document.querySelector('.popover')?.textContent || ''),
        document.querySelector('.popover')?.textContent?.slice(0, 160));
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1500);
  check('setCharacterToIndex was called', host.calls.includes('setCharacterToIndex'));
  check('the field landed in the host', host.liveChar.desc === '스모크가 고친 설명',
        host.liveChar.desc);
  check('the regex landed whole', host.liveChar.customscript?.[0]?.out === 'baz',
        JSON.stringify(host.liveChar.customscript ?? []));
  check('with its unmodelled field intact', host.liveChar.customscript?.[0]?.forkExtra === 7);
  check('the trigger code landed', host.liveChar.triggerscript?.[0]?.effect?.[0]?.code === 'local n = 2\nprint(n)',
        JSON.stringify(host.liveChar.triggerscript?.[0]?.effect ?? []));
  check('with lowLevelAccess intact', host.liveChar.triggerscript?.[0]?.lowLevelAccess === true);
  check('a card write never touches the chats',
        JSON.stringify(host.liveChar.chats) === chatsBefore);
  await settle(600);
  check('the bot bar is back to 변경 없음',
        /변경 없음/.test(document.querySelector('.botbar .changesum')?.textContent || ''),
        document.querySelector('.botbar .changesum')?.textContent);
}

console.log('\ntest_save_as_new_bot');
{
  // An edit pending, so the save has something to write into this bot while
  // the backup keeps what RisuAI held.
  clickById(document, 'tab-meta');
  await settle(600);
  clickButton(document.querySelector('.panel.active .tree'), '설명 (desc)');
  await settle(400);
  const c = document.querySelector('.panel.active .left');
  c.querySelector('textarea').value = '새 봇으로 저장 전에 고친 설명';
  clickButton(c, '저장');
  await settle(1000);

  clickTool(document, 'card-apply');
  await settle(300);
  const pop = document.querySelector('.popover');
  check('the verb is 새 봇으로 저장, not a clone', !!findButton(pop, '새 봇으로 저장') && !findButton(pop, '복제 봇 생성'));
  const nameBox = pop?.querySelector('input');
  check('the backup name is prefilled with (백업)', /\(백업\)$/.test(nameBox?.value || ''), nameBox?.value);
  nameBox.value = '스모크 (백업)';
  const hides = host.calls.filter((x) => x === 'hideContainer').length;
  clickButton(pop, '새 봇으로 저장');
  await settle(2000);
  check('the backup went through setDatabase', host.dbWrites.length === 1, String(host.dbWrites.length));
  const chars = host.dbWrites[0]?.characters ?? [];
  const backup = chars[chars.length - 1];
  check('as a new character named for the backup', chars.length === 2 && backup?.name === '스모크 (백업)',
        JSON.stringify({ n: chars.length, name: backup?.name }));
  check('with a fresh chaId', !!backup?.chaId && backup.chaId !== 'cha-smoke', backup?.chaId);
  const srcChats = chars[0]?.chats ?? [];
  check('and the chats come along', backup?.chats?.length === srcChats.length
        && backup.chats.every((c2, i) => c2.message.length === srcChats[i].message.length),
        JSON.stringify(backup?.chats?.map((c2) => c2.message.length)));
  check('the backup holds the card as RisuAI had it', backup?.desc === '스모크가 고친 설명', backup?.desc);
  check('the live bot got the pending edit', host.liveChar.desc === '새 봇으로 저장 전에 고친 설명', host.liveChar.desc);
  check('assets shared by reference, not copied', backup?.image === 'assets/portrait.png');
  check('the sidebar was told about it', host.calls.includes('checkCharOrder'));
  check('the panel stepped aside for the permission prompt and came back',
        host.calls.filter((x) => x === 'hideContainer').length > hides && host.calls.includes('showContainer'));
  check('the popover says what happened',
        /새 봇으로 저장하였습니다/.test(document.querySelector('.popover')?.textContent || '')
        && /백업/.test(document.querySelector('.popover')?.textContent || ''),
        document.querySelector('.popover')?.textContent?.slice(0, 200));
  pressEscape(document);
  await settle(600);
  check('the bot bar is back to 변경 없음 (the edit became the baseline)',
        /변경 없음/.test(document.querySelector('.botbar .changesum')?.textContent || ''),
        document.querySelector('.botbar .changesum')?.textContent);
}

console.log('\ntest_settings_tab');
// Settings is opened from the header now, not from a tab.
document.getElementById('open-settings')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(900);
check('the gear shows as pressed', document.getElementById('open-settings')?.classList.contains('on'));
check('settings is split into sub-tabs', document.querySelectorAll('.subtab').length === 5,
      [...document.querySelectorAll('.subtab')].map((t) => t.textContent).join(','));
check('connection card present', !!findButton(document, '저장하고 연결'));
check('diagnostic present', !!findButton(document, '연결 진단'));

// The agent lives on its own sub-tab now.
[...document.querySelectorAll('.subtab')].find((t) => t.textContent === '에이전트')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(500);
check('agent credential card present', !!findButton(document, '연결 테스트'));
{
  // The web search tool is one card right under the general agent, with a
  // three-way choice at the top that swaps the fields under it. The old
  // "search agent" preset card is gone.
  await settle(600);
  const card = document.getElementById('websearch-card');
  check('the web search tool card follows the general agent card',
        !!card && /일반 에이전트/.test(card.previousElementSibling?.querySelector('h2')?.textContent || ''));
  check('no search agent card remains', ![...document.querySelectorAll('h2')].some((h) => /검색 에이전트/.test(h.textContent || '')));
  const modeSel = card?.querySelector('select');
  const modes = [...(modeSel?.options || [])].map((o) => o.value);
  check('three search options, in order', modes.join(',') === 'native,gemini,provider', modes.join(','));
  // linkedom's <select> has no settable .value: the stamped `selected`
  // attribute is what setSelected wrote and what selectedValue falls back to.
  const chosen = () => modeSel?.querySelector('option[selected]')?.value;
  const choose = (v) => {
    for (const o of modeSel.options) o.removeAttribute('selected');
    [...modeSel.options].find((o) => o.value === v)?.setAttribute('selected', '');
    modeSel.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  check('provider mode is the default and its pane is the visible one',
        chosen() === 'provider' && [...card.querySelectorAll('.wsmode')].filter((p) => p.style.display !== 'none').length === 1,
        String(chosen()));
  // Picking a mode swaps the pane.
  choose('gemini');
  const shown = [...card.querySelectorAll('.wsmode')].filter((p) => p.style.display !== 'none');
  check('choosing the Gemini helper shows its fields (model, key, instructions)',
        shown.length === 1 && /Google AI Studio/.test(shown[0].textContent) && !!shown[0].querySelector('textarea'));
  choose('provider');
  check('a test button is on the card', !![...card.querySelectorAll('button')].find((b) => b.textContent.trim() === '테스트'));
}
{
  // The phone view switch: two segments at the top of every split, the lit
  // one being the current view. (A floating pill used to sit on the send button.)
  const bars = [...document.querySelectorAll('.split > .mbar')];
  check('every split starts with the mobile view bar', bars.length >= 1 && bars.every((b) => b.parentElement?.firstElementChild === b), String(bars.length));
  check('with an 편집 and an AI 챗 segment', bars.every((b) => /편집/.test(b.textContent) && /AI 챗/.test(b.textContent)));
}
{
  // The subscription path is off unless this backend's operator enabled it,
  // so the key page must not offer it (the smoke backend uses the default).
  check('the key page offers no subscription login',
        !/OPENAI 구독|OpenAI 로그인/i.test(document.body.textContent || ''));
  const pw = [...document.querySelectorAll('input')].filter((i) => i.getAttribute('type') === 'password');
  check('api key field is a password input', pw.length >= 1, String(pw.length));
  const body = document.body.innerHTML;
  // The backend token is config the user typed; it belongs in its password
  // field. The invariant that matters is the agent API key, which the backend
  // only ever reports as {set, length} and never sends back in full.
  check('agent api key is never sent to the client', !/vck_|sk-[A-Za-z0-9]{20}/.test(body));
}
clickButton(document, '연결 진단');
await settle(900);
check('diagnostic reported a route', /직접 연결 확인됨/.test(document.body.innerHTML));

console.log('\ntest_agent_presets_ui');
{
  // One current preset on the page; everything else is behind a button. The
  // page used to show a form AND a list of saved copies of that form, which
  // read as two sets of live settings.
  const current = document.querySelector('.presetnow');
  check('exactly one current preset is shown', !!current);
  check('it names the preset', /기본/.test(current?.textContent || ''), current?.textContent);
  check('the agent fields are not on the page',
        ![...document.querySelectorAll('input')]
          .some((i) => (i.getAttribute('placeholder') || '').includes('ai-gateway')));

  // --- the editor is a focused modal ---------------------------------------
  // The current row carries one chevron; 수정 lives in the list behind it.
  current?.querySelector('.chev')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(700);
  check('› opens the preset list', !!document.querySelector('.modalbox .pickrow'));
  [...document.querySelectorAll('.modalbox .pickrow.on button')].find((b) => b.textContent === '수정')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(700);
  const box = document.querySelector('.modalbox');
  check('수정 opens a modal', !!box);
  check('it has a backdrop', !!document.querySelector('.modalback'));
  check('base instructions are editable', !!box?.querySelector('textarea'));
  // Two selects: the credential (own / a key from the key page / the OpenAI
  // subscription), then reasoning.
  const selects = [...(box?.querySelectorAll('select') || [])];
  const credSel = selects.find((s) => /직접 입력/.test(s.textContent || ''));
  check('the API key can be borrowed from the key page', !!credSel);
  // Not among them here: the subscription path is offered only when this
  // backend's operator turned it on, and the smoke backend is the default.
  check('and the subscription is not offered when the backend does not enable it',
        !/OpenAI 구독/.test(credSel?.textContent || ''), credSel?.textContent?.slice(0, 80));
  const reasoningSel = selects.find((s) => /high/.test(s.textContent || ''));
  check('reasoning level is settable', !!reasoningSel);
  const opts = [...(reasoningSel?.querySelectorAll('option') || [])]
    .map((o) => o.getAttribute('value'));
  check('off means sending nothing', opts.includes('') && opts.includes('high'), opts.join(','));
  check('prompt cache is offered', /프롬프트 캐시/.test(box?.textContent || ''));
  check('flex tier is offered', /Flex 티어/.test(box?.textContent || ''));
  check('the key field is a password input',
        box?.querySelector('input[type="password"]') !== null);
  check('base instructions say they cannot revoke the rules',
        /뒤집을 수 없습니다/.test(box?.textContent || ''));

  const fields = [...box.querySelectorAll('input')];
  const nameBox = fields.find((i) => (i.getAttribute('placeholder') || '').includes('프리셋 이름'));
  nameBox.value = '스모크 프리셋';
  [...box.querySelectorAll('textarea')].find((t) => (t.getAttribute('placeholder') || '').includes('지침')).value = '항상 존댓말로 답한다.';
  [...box.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1000);
  // Saving hands over to the picker (0.6.1): the next question is "which
  // one runs", so the list opens with the saved preset in it.
  check('saving opens the picker', /프리셋 선택/.test(document.querySelector('.modalbox')?.textContent || '')
        && /스모크 프리셋/.test(document.querySelector('.modalbox')?.textContent || ''));
  pressEscape(document);
  await settle(300);
  check('and escape closes it', !document.querySelector('.modalbox'));
  check('the rename shows in the current row',
        /스모크 프리셋/.test(document.querySelector('.presetnow')?.textContent || ''),
        document.querySelector('.presetnow')?.textContent);
  check('base instructions are summarised',
        /기본지침 있음/.test(document.querySelector('.presetnow')?.textContent || ''));

  // --- the picker ----------------------------------------------------------
  document.querySelector('.presetnow .chev')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(800);
  check('선택 opens the list', !!document.querySelector('.modalbox'));
  check('the list marks which one is in use',
        /사용 중/.test(document.querySelector('.modalbox')?.textContent || ''));
  check('the only preset offers no delete',
        [...document.querySelectorAll('.modalbox .pickrow')].length === 1
        && [...document.querySelectorAll('.modalbox .pickrow button')]
             .filter((b) => b.textContent === '삭제' && b.style.display !== 'none').length === 0);

  clickButton(document, '새 프리셋 추가');
  await settle(700);
  const box2 = document.querySelector('.modalbox');
  check('추가 reuses the same editor', !!box2?.querySelector('textarea'));
  [...box2.querySelectorAll('input')]
    .find((i) => (i.getAttribute('placeholder') || '').includes('프리셋 이름')).value = '두 번째';
  [...box2.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1000);
  check('the new preset is saved but not auto-selected',
        /스모크 프리셋/.test(document.querySelector('.presetnow')?.textContent || ''),
        document.querySelector('.presetnow')?.textContent);

  // Saving reopened the picker; escape closes a modal - the only other way
  // out besides the backdrop.
  check('the list now has two', document.querySelectorAll('.modalbox .pickrow').length === 2,
        String(document.querySelectorAll('.modalbox .pickrow').length));
  pressEscape(document);
  await settle(200);
  check('escape closes the modal', !document.querySelector('.modalbox'));
}

console.log('\ntest_skills_ui');
{
  [...document.querySelectorAll('.subtab')].find((t) => t.textContent === '스킬')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  check('skills card present', /스킬/.test(document.body.innerHTML));
  check('the budget names what it counts',
        /매 요청에 실리는 것은 이 목록/.test(document.body.innerHTML));
  check('it says bodies are loaded on demand', /load_skill/.test(document.body.innerHTML));
  const skillRows = () => [...document.querySelectorAll('.card')]
    .find((c) => /^스킬$/.test(c.querySelector('h2')?.textContent || ''))
    ?.querySelectorAll('.pickrow') || [];
  check('seeded skills are listed', skillRows().length >= 2, String(skillRows().length));
  check('each row has an enable toggle',
        [...skillRows()].every((r) => !!r.querySelector('input[type="checkbox"]')));
  check('each row shows its trigger description and folder',
        [...skillRows()].every((r) => /skills\//.test(r.textContent || '')),
        [...skillRows()].map((r) => r.textContent).join(' | ').slice(0, 200));

  clickButton(document, '스킬 추가');
  await settle(700);
  const box = document.querySelector('.modalbox');
  check('the editor is a modal', !!box);
  check('the description is its own field', /트리거/.test(box?.textContent || ''));
  check('always-on is an explicit opt-in', !!box?.querySelector('.checkrow input[type="checkbox"]'));

  box.querySelector('input').value = '스모크 스킬';
  const [descBox, bodyBox] = box.querySelectorAll('textarea');
  descBox.value = '스모크 테스트를 돌릴 때';
  bodyBox.value = '1. 확인한다.\n2. 제안한다.';
  bodyBox.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('the length is counted against the cap',
        /\/\s*[\d,]+자/.test(box.textContent || ''), box.textContent?.slice(0, 200));
  [...box.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1000);
  check('the skill is saved', /스모크 스킬/.test(document.body.innerHTML));
  check('and listed with its trigger',
        [...skillRows()].some((r) => /스모크 테스트를 돌릴 때/.test(r.textContent || '')));

  clickButton(document, '보내는 내용 보기');
  await settle(800);
  const preview = document.querySelector('.modalbox .filepreview')?.textContent || '';
  check('the catalog is inspectable', /스모크 스킬/.test(preview), preview.slice(0, 120));
  check('it carries the trigger, not the body',
        /스모크 테스트를 돌릴 때/.test(preview) && !/확인한다/.test(preview), preview.slice(0, 300));
  check('and tells the model to load_skill', /load_skill/.test(preview));
  pressEscape(document);
  await settle(200);

  // Editing an existing skill shows its folder files.
  const row0 = [...skillRows()].find((r) => /스모크 스킬/.test(r.textContent || ''));
  clickButton(row0, '수정');
  await settle(900);
  const box2 = document.querySelector('.modalbox');
  check('the editor names the folder', /skills\//.test(box2?.querySelector('.modalhead')?.textContent || ''),
        box2?.querySelector('.modalhead')?.textContent);
  check('it has a files section', /폴더의 파일/.test(box2?.textContent || ''));
  check('it is pre-filled with the body', /확인한다/.test(box2?.querySelectorAll('textarea')[1]?.value || ''));
  pressEscape(document);
  await settle(200);

  // Disabling keeps the skill but takes it out of the catalog.
  const row = [...skillRows()].find((r) => /스모크 스킬/.test(r.textContent || ''));
  const boxToggle = row?.querySelector('input[type="checkbox"]');
  boxToggle.checked = false;
  boxToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle(900);
  clickButton(document, '보내는 내용 보기');
  await settle(800);
  check('a disabled skill leaves the catalog',
        !/스모크 스킬/.test(document.querySelector('.modalbox .filepreview')?.textContent || ''));
  check('but stays in the list',
        [...skillRows()].some((r) => /스모크 스킬/.test(r.textContent || '')));
  pressEscape(document);
  await settle(200);
}

console.log('\ntest_debug_panel');
{
  [...document.querySelectorAll('.subtab')].find((t) => /로그/.test(t.textContent || ''))
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  check('the bug-report panel exists', /문제 신고/.test(document.body.innerHTML));
  check('it promises not to include secrets',
        /API 키나 토큰은 포함되지 않습니다/.test(document.body.innerHTML));

  clickButton(document, '진단 정보');
  await settle(1100);
  const report = document.querySelector('.subpane.active .filepreview')?.textContent || '';
  check('a diagnostic is produced', report.length > 50, report.slice(0, 120));
  check('it covers both sides', /"plugin"/.test(report) && /"server"/.test(report),
        report.slice(0, 200));
  // The one property that matters once users start pasting these.
  check('it carries no token', !/smoke-token|Bearer /.test(report), report.slice(0, 200));
  check('it reports the key as a flag, not a value', /"hasKey"/.test(report),
        report.slice(0, 300));
  check('copying is offered', !!findButton(document.querySelector('.subpane.active'), '복사'));

  clickButton(document, '서버 로그');
  await settle(1100);
  const logText = document.querySelector('.subpane.active .filepreview')?.textContent || '';
  check('the server log is shown', logText.length > 20, logText.slice(0, 120));
  check('and it too carries no token', !/smoke-token/.test(logText), logText.slice(0, 200));
}

console.log('\ntest_agent_panel');
{
  clickById(document, 'tab-editor');
  await settle(400);
  const agentTab = [...document.querySelectorAll('.rtab')]
    .find((b) => (b.textContent || '').includes('AI'));
  check('agent tab exists', !!agentTab);
  agentTab.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(900);

  check('agent panel rendered', !!document.querySelector('.agentpanel'));
  check('attaching a file is offered', !!document.querySelector('.attachbtn'));
  check('has a compose box', !!document.querySelector('.agentinput'));
  // The test backend has no agent credentials, so the panel must say so
  // rather than offering a send button that will always fail.
  check('missing credentials are reported',
        /자격증명이 아직 설정되지 않았습니다/.test(document.body.innerHTML));
  // The send button is a paper-plane icon, so it is addressed by class.
  const send = document.querySelector('.sendbtn');
  check('send button present', !!send);
  check('send is disabled without credentials', send && send.disabled);
  // Labelled, not icons: a "+" reads as "add" when the action is "start over".
  const heads = [...document.querySelectorAll('.agenthead button')].map((b) => b.textContent);
  check('new-conversation control is labelled', heads.includes('새 대화'), String(heads));
  check('history control is labelled', heads.includes('이전 대화'), String(heads));

  // A staged proposal must read as a proposal: preview in the turn list,
  // and the transcript untouched until approval.
  const auth = { Authorization: 'Bearer ' + backend.token };
  const chatKey = await (async () => {
    const r = await fetch(backend.url + '/workspace', { headers: auth });
    const j = await r.json();
    return j.workspaces?.[0]?.chats?.[0]?.chatKey;
  })();
  check('chat key resolved for staging', !!chatKey, String(chatKey));

  const turnsBefore = await (await fetch(
    backend.url + '/turns?chatKey=' + encodeURIComponent(chatKey), { headers: auth })).json();
  const target = turnsBefore.turns[1];
  await fetch(backend.url + '/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ chatKey }),
  });

  // Stage directly through the store the agent would use, so the panel is
  // tested without needing a model in the loop.
  const staged = await (await fetch(backend.url + '/staged?chatKey=' + encodeURIComponent(chatKey), { headers: auth })).json();
  check('nothing staged yet', (staged.staged || []).length === 0, JSON.stringify(staged).slice(0, 120));

  const turnsAfter = await (await fetch(
    backend.url + '/turns?chatKey=' + encodeURIComponent(chatKey), { headers: auth })).json();
  check('transcript unchanged by opening the agent panel',
        turnsAfter.turns[1].body === target.body);
}

console.log('\ntest_agent_welcome');
{
  // Configure the agent through the preset editor, which is the real path, and
  // is also what makes the panel show its normal empty state instead of the
  // "credentials not set" notice.
  document.getElementById('open-settings')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(500);
  [...document.querySelectorAll('.subtab')].find((t) => t.textContent === '에이전트')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(500);
  document.querySelector('.presetnow .chev')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  [...document.querySelectorAll('.modalbox .pickrow.on button')].find((b) => b.textContent === '수정')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(700);
  const box = document.querySelector('.modalbox');
  const fields = [...box.querySelectorAll('input')];
  const byPlaceholder = (frag) =>
    fields.find((i) => (i.getAttribute('placeholder') || '').includes(frag));
  byPlaceholder('ai-gateway').value = 'https://gw.invalid/v1';
  byPlaceholder('gemini').value = 'test/model';
  box.querySelector('input[type="password"]').value = 'smoke-key-not-real';
  [...box.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);

  clickById(document, 'tab-editor');
  await settle(500);
  [...document.querySelectorAll('.rtab')].find((b) => (b.textContent || '').includes('AI'))
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);

  check('the panel is usable once configured',
        !/자격증명이 아직 설정되지 않았습니다/.test(
          document.querySelector('.agentpanel')?.textContent || ''),
        (document.querySelector('.agentpanel')?.textContent || '').slice(0, 120));
  // An empty conversation with a bare cursor asks "what can this do" and
  // answers nothing.
  check('an empty conversation suggests what to ask',
        document.querySelectorAll('.agentpanel .exbtn').length === 3,
        String(document.querySelectorAll('.agentpanel .exbtn').length));
  // The title follows the tab bar's mode (chat or bot); either is the job.
  check('it names the job', /조정(해야 )?할 항목을 상담하세요/.test(
        document.querySelector('.agentpanel')?.textContent || ''));
  check('and says the agent sees the whole bot and chat, not just the tab',
        /선택된 봇 및 챗의 전반적인 정보를 모두 알고 있습니다/.test(document.querySelector('.agentpanel')?.textContent || ''));

  const ex = document.querySelector('.agentpanel .exbtn');
  ex?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  // Clicking fills the box rather than sending: these are starting points to
  // edit, not commands.
  check('clicking an example fills the box, not sends it',
        (document.querySelector('.agentinput')?.value || '').length > 5,
        document.querySelector('.agentinput')?.value);
  check('and nothing was sent', !document.querySelector('.bubble.user'));
  document.querySelector('.agentinput').value = '';
}

console.log('\ntest_open_a_chat_risuai_does_not_have_open');
{
  // Reported: clicking a chat that was not loaded sent the user out to RisuAI
  // ("open that chat there and press 🔄"), while 이 봇의 모든 챗 불러오기 right
  // below loaded and edited exactly those chats. So the refusal was a detour.
  // Clicking loads the chat now - and the write-back has to land on THAT chat,
  // not on the one RisuAI has open (chatPage = 0, i.e. chatA, throughout).
  clickById(document, 'tab-chats');
  await settle(700);
  document.querySelector('.folderhead')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(250);
  const row = document.querySelector('.folderbody.open .chatitem');
  check('the folder lists the chat RisuAI does not have open', !!row);
  const liveBefore = JSON.stringify(host.liveChar.chats[0].message);
  check('clicking it starts the load', clickButton(row, '챗 편집'));
  await settle(2000);
  check('it does not send the user back to RisuAI',
        !/RisuAI에서 그 챗을/.test(document.body.innerHTML));
  check('the editor opened',
        document.getElementById('tab-editor')?.style.display !== 'none');
  // chatB is 4 turns, chatA is 10: the count is what tells them apart.
  check('and it is showing the clicked chat, not the open one',
        document.querySelectorAll('.turn').length === 4,
        String(document.querySelectorAll('.turn').length));

  document.querySelector('.turn button[title="이 턴 편집"]')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
  const area = document.querySelector('.modalbox textarea.turnedit');
  check('a turn of it can be edited', !!area);
  area.value = '옆 챗에서 고친 본문입니다.';
  // Scoped to the turn modal: the settings modal from the preset test is still
  // in the tree, and it has a 저장 of its own.
  [...area.closest('.modalbox').querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1200);
  check('the edit is pending on it', !!document.querySelector('.turn.changed'));

  clickTool(document, 'apply');
  await settle(400);
  clickButton(document.querySelector('.popover'), 'RisuAI에 반영');
  await settle(1600);
  const written = host.liveChar.chats[1].message;
  check('the write-back landed on the clicked chat',
        written.some((m) => m.data.includes('옆 챗에서 고친 본문입니다')),
        written[0]?.data?.slice(0, 60));
  check('and left the chat RisuAI has open alone',
        JSON.stringify(host.liveChar.chats[0].message) === liveBefore);
  check('its chatIds survived', written.every((m, i) => m.chatId === `chatB-m${i}`));
  check('its turn count is unchanged', written.length === 4, String(written.length));
  check('the chat bar is back to 변경 없음',
        /변경 없음/.test(document.querySelector('.chatbar .changesum')?.textContent || ''),
        document.querySelector('.chatbar .changesum')?.textContent);
}

console.log('\ntest_no_character_selected');
host.selectNone();
clickById(document, 'tab-chats');
await settle(200);
try {
  await registered[0].cb();
} catch (e) {
  errors.push('reopen with no selection threw: ' + e.stack);
}
await settle(1200);
check('no-selection is reported, not thrown',
      /캐릭터가 선택되어 있지 않습니다/.test(document.body.innerHTML));

console.log('\ntest_unload');
try { await unload?.(); } catch (e) { errors.push('unload threw: ' + e.stack); }
check('unregistered its UI parts', host.calls.filter((c) => c === 'unregisterUIPart').length >= 1);

// --- verdict ----------------------------------------------------------------

backend.proc.kill();
await new Promise((r) => { backend.proc.once('exit', r); setTimeout(r, 5000); });
try {
  rmSync(backend.data, { recursive: true, force: true });
} catch {
  // Windows keeps the SQLite handles briefly after exit. A leftover temp dir
  // is not a test failure.
}

console.log();
if (errors.length) {
  console.log('runtime errors:');
  for (const e of errors) console.log('  - ' + e);
}
if (failures.length || errors.length) {
  console.log(`FAIL - ${failures.length} check(s), ${errors.length} error(s)`);
  process.exit(1);
}
console.log('PASS - plugin loads, renders, edits, and writes back');
