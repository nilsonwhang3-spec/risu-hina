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
const BUNDLE = resolve(ROOT, 'plugin/dist/risu-elf-0.1.0.js');

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
  const data = mkdtempSync(join(tmpdir(), 'risuelf-plugin-'));
  let py = resolve(ROOT, 'pyserver/.venv/Scripts/python.exe');
  if (!existsSync(py)) py = 'python';
  const proc = spawn(py, [resolve(ROOT, 'pyserver/run.py')], {
    cwd: resolve(ROOT, 'pyserver'),
    env: {
      ...process.env,
      RISUELF_PORT: String(port),
      RISUELF_HOST: '127.0.0.1',
      RISUELF_DATA_DIR: data,
      RISUELF_TOKEN: 'plugin-smoke-token',
      RISUELF_REQUIRE_TOKEN: '1',
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
      if (j.service === 'risu-elf') return { url, port, data, proc, token: 'plugin-smoke-token', log: () => log };
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
  let selectedChar = 0;

  return {
    liveChar,
    calls,
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
      async setCharacterToIndex(i, char) { calls.push('setCharacterToIndex'); liveChar.chats = structuredClone(char.chats); },
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
// Content views in the tab bar; settings is a header verb, not a view.
check('six content tabs present', document.querySelectorAll('.tab').length === 6,
      [...document.querySelectorAll('.tab')].map((t) => t.textContent).join(','));
check('the workspace files tab is set apart', !!document.querySelector('.tabs .tabsep')
      && document.querySelector('.tabs .tabsep')?.nextElementSibling?.id === 'tab-files');
check('and named for what it is', /워크스페이스 파일/.test(document.getElementById('tab-files')?.textContent || ''));
check('no chat bar on the chat picker', document.querySelector('.toolslot .chatbar')?.style.display === 'none');
check('settings is not one of them',
      ![...document.querySelectorAll('.tab')].some((t) => t.textContent === '설정'));
check('settings is reachable from the header',
      document.getElementById('open-settings')?.closest('header') === document.querySelector('header'));
check('backend reached', host.calls.filter((c) => c === 'nativeFetch').length > 0);
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
  check('the left pane is a tree', !!document.querySelector('.panel.active .tree'));
  check('the agent came along', !!document.querySelector('.panel.active .agentpanel'));

  const tree = document.querySelector('.panel.active .tree');
  check('upload is offered', !!findButton(tree, '올리기'));
  check('cleaning is offered', !!findButton(tree, '임시 정리'));

  // Only what a person put in or would take out. The frozen originals, the
  // generated helper and the scratch are real but not interesting.
  check('internal areas are hidden by default',
        !/원본/.test(tree?.textContent || ''), (tree?.textContent || '').slice(0, 200));
  check('and the toggle says how many are hidden',
        /내부 파일 보기 [(]\d+[)]/.test(tree?.textContent || ''),
        (tree?.textContent || '').slice(-120));
  // A document in scratch/ is a deliverable and is listed without unfolding;
  // the script beside it stays behind the toggle.
  check('a document in scratch/ is surfaced', /draft-summary\.md/.test(tree?.textContent || ''),
        (tree?.textContent || '').slice(0, 300));
  check('under a heading that says where it lives', /임시 문서/.test(tree?.textContent || ''));
  check('a plain text note counts as a document', /numbers\.txt/.test(tree?.textContent || ''));
  check('the script stays folded', !/helper\.py/.test(tree?.textContent || ''));
  const surfaced = [...tree.querySelectorAll('.treebranch')].find((b) => /임시 문서/.test(b.textContent || ''));
  check('the surfaced group is open, not collapsed',
        surfaced?.nextElementSibling?.style.display !== 'none');
  check('the files tab button carries a badge slot', !!document.querySelector('#tab-files .tabbadge'));

  clickButton(tree, '내부 파일 보기');
  await settle(900);
  const tree2 = document.querySelector('.panel.active .tree');
  check('revealing shows the frozen original', /원본/.test(tree2?.textContent || ''),
        (tree2?.textContent || '').slice(0, 200));

  // original/ is the diff baseline, so it is never offered for deletion.
  const branches = [...document.querySelectorAll('.panel.active .treebranch')];
  const originalBranch = branches.find((b) => /원본/.test(b.textContent || ''));
  check('the original branch is listed', !!originalBranch);
  originalBranch?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(300);
  const originalKids = originalBranch?.nextElementSibling;
  check('original files offer no delete button',
        [...(originalKids?.querySelectorAll('button') || [])]
          .every((b) => b.textContent !== '×'),
        [...(originalKids?.querySelectorAll('button') || [])].map((b) => b.textContent).join(','));

  const firstFile = originalKids?.querySelector('button.treefile');
  check('a file can be opened', !!firstFile);
  firstFile?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(900);
  check('its contents are shown in the middle pane',
        !!document.querySelector('.panel.active .left .filepreview'));

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
        /봇 단위 편집은 따로/.test(loreTree()), loreTree().slice(0, 200));

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
  centre.querySelector('textarea').dispatchEvent(new window.Event('input', { bubbles: true }));
  check('the content is previewed as markdown',
        !!centre.querySelector('.md-h'), centre.querySelector('.md-h')?.textContent);
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

console.log('\ntest_settings_tab');
// Settings is opened from the header now, not from a tab.
document.getElementById('open-settings')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(900);
check('the gear shows as pressed', document.getElementById('open-settings')?.classList.contains('on'));
check('settings is split into sub-tabs', document.querySelectorAll('.subtab').length === 4,
      [...document.querySelectorAll('.subtab')].map((t) => t.textContent).join(','));
check('connection card present', !!findButton(document, '저장하고 연결'));
check('diagnostic present', !!findButton(document, '연결 진단'));

// The agent lives on its own sub-tab now.
[...document.querySelectorAll('.subtab')].find((t) => t.textContent === '에이전트')
  ?.dispatchEvent(new window.Event('click', { bubbles: true }));
await settle(500);
check('agent credential card present', !!findButton(document, '연결 테스트'));
{
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
  [...(current?.querySelectorAll('button') || [])].find((b) => b.textContent === '수정')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(700);
  const box = document.querySelector('.modalbox');
  check('수정 opens a modal', !!box);
  check('it has a backdrop', !!document.querySelector('.modalback'));
  check('base instructions are editable', !!box?.querySelector('textarea'));
  check('reasoning level is settable', !!box?.querySelector('select'));
  const opts = [...(box?.querySelector('select')?.querySelectorAll('option') || [])]
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
  box.querySelector('textarea').value = '항상 존댓말로 답한다.';
  [...box.querySelectorAll('button')].find((b) => b.textContent === '저장')
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(1000);
  check('saving closes the modal', !document.querySelector('.modalbox'));
  check('the rename shows in the current row',
        /스모크 프리셋/.test(document.querySelector('.presetnow')?.textContent || ''),
        document.querySelector('.presetnow')?.textContent);
  check('base instructions are summarised',
        /기본지침 있음/.test(document.querySelector('.presetnow')?.textContent || ''));

  // --- the picker ----------------------------------------------------------
  [...document.querySelectorAll('.presetnow button')].find((b) => /선택/.test(b.textContent || ''))
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
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

  // Escape closes a modal - the only other way out besides the backdrop.
  [...document.querySelectorAll('.presetnow button')].find((b) => /선택/.test(b.textContent || ''))
    ?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await settle(600);
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
        /프롬프트에 실리는 분량/.test(document.body.innerHTML));
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
  [...document.querySelectorAll('.presetnow button')].find((b) => b.textContent === '수정')
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
  check('it names the job', /조정해야 할 항목을 상담하세요/.test(
        document.querySelector('.agentpanel')?.textContent || ''));

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
