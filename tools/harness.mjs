/**
 * Browser harness: the built plugin in a real browser, on a stub host, against
 * a real backend.
 *
 * The smoke test (tests/plugin_smoke.mjs) runs the bundle under linkedom, which
 * has no layout - so "the send button leaves the screen when the box is
 * resized" and "the tree cannot scroll on a phone" pass it every time. This
 * serves the same bundle and the same kind of stub host as a page, so a
 * browser (or a browser-driving agent) can look at the layout at any width.
 *
 *   node tools/harness.mjs            -> prints the URL, keeps running
 *   node tools/harness.mjs --port 8765
 *
 * Nothing here touches real data: the backend runs on a temp data dir that is
 * removed on exit, and the character is a fixture.
 */
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createNet } from 'node:net';
import { createServer } from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const pkgVersion = JSON.parse(readFileSync(resolve(ROOT, 'plugin/package.json'), 'utf8')).version;
const BUNDLE = resolve(ROOT, `plugin/dist/risu-hina-${pkgVersion}.js`);
const TOKEN = 'harness-token';

const argPort = (() => {
  const i = process.argv.indexOf('--port');
  return i > 0 ? Number(process.argv[i + 1]) : 0;
})();

const freePort = () => new Promise((res) => {
  const s = createNet();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

async function startBackend() {
  const port = await freePort();
  // A throwaway dir per run, unless one is named: some checks need a config
  // the backend reads at boot (a hand-set flag), and a fresh dir every time
  // cannot hold one.
  const data = process.env.RISUHINA_HARNESS_DATA
    || mkdtempSync(join(tmpdir(), 'risuhina-harness-'));
  let py = resolve(ROOT, 'pyserver/.venv/Scripts/python.exe');
  if (!existsSync(py)) py = 'python';
  const proc = spawn(py, [resolve(ROOT, 'pyserver/run.py')], {
    cwd: resolve(ROOT, 'pyserver'),
    env: {
      ...process.env,
      RISUHINA_PORT: String(port), RISUHINA_HOST: '127.0.0.1', RISUHINA_DATA_DIR: data,
      RISUHINA_TOKEN: TOKEN, RISUHINA_REQUIRE_TOKEN: '1', PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.stdout.write('[backend] ' + d));
  proc.stderr.on('data', (d) => process.stdout.write('[backend] ' + d));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const j = await (await fetch(url + '/health')).json();
      if (j.service === 'risu-hina') return { url, proc, data };
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('backend did not start');
}

// --- the fixture ------------------------------------------------------------

const LORE_TITLES = [
  '세계관 개요', '왕국 파르마', '기사단 규율', '수도 아르코나', '북부 신전', '남부 항구 도시',
  '마법 체계', '용의 전설', '검은 숲', '왕가 계보', '화폐와 물가', '군제', '종교와 사제',
  '주연: 페데리코', '주연: 파브리스', '조연: 대장장이 롤로', '조연: 사서 엘리나',
  '몬스터: 그림자 늑대', '몬스터: 늪 트롤', '엑스트라: 여관 주인', '장소: 성채 도서관',
  '장소: 훈련장', '사건: 첫 원정', '사건: 대관식',
];
const fixture = (() => {
  const turns = Array.from({ length: 60 }, (_, i) => ({
    role: i % 2 ? 'char' : 'user',
    data: i % 2
      ? `턴 ${i}: **페데리코**는 신전 앞에 서서 오래 침묵했다. "여기 있었군." 바람이 깃발을 흔들었고, 멀리서 종소리가 울렸다. 그는 검을 고쳐 잡았다.\n\n파브리스가 뒤따라 왔다. '설마 벌써?'`
      : `턴 ${i}: 나는 페데리코를 따라 신전으로 향한다. 주변을 살핀다.`,
    time: 1778892822492 + i * 1000,
    chatId: `chatA-m${i}`,
    ...(i % 2 ? { generationInfo: { model: 'x', inputTokens: 10 } } : {}),
  }));
  const lore = LORE_TITLES.map((t, i) => ({
    key: [t.split(': ').pop(), 'k' + i],
    comment: t,
    content: `### ${t}\n#### 개요\n- 항목 ${i}의 본문입니다. 여러 줄로 이어지는 설정 텍스트.\n- 두 번째 줄.\n#### 관계\n- 다른 항목과의 관계.`,
    insertorder: 100 + i * 10,
    folder: i < 13 ? '세계관' : (i < 17 ? '인물' : ''),
    alwaysActive: i < 2,
  }));
  return {
    name: 'Parma Knights', chaId: 'cha-harness', type: 'character',
    desc: '설명 '.repeat(80), firstMessage: '첫 인사',
    image: 'assets/portrait.png',
    globalLore: lore,
    alternateGreetings: ['대체 인사 하나', '대체 인사 둘'],
    customscript: Array.from({ length: 6 }, (_, i) => ({ comment: `치환 ${i}`, in: `foo${i}`, out: `bar${i}`, type: 'editdisplay' })),
    triggerscript: [{
      comment: '하네스 트리거', type: 'start', conditions: [], lowLevelAccess: true,
      effect: [{ type: 'triggerlua', code: 'local n = 1\nprint(n)' }],
    }],
    chatFolders: [],
    chats: [{
      id: 'chatA', name: '플레이스루 A', note: '', localLore: [], fmIndex: 0,
      scriptstate: { '$affection': 3, '$met': true, route: 'A' },
      message: turns,
    }],
    chatPage: 0,
  };
})();

const pageHtml = (backendUrl) => `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Risu Hina harness</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f1117; color: #d8dce4; font-family: system-ui, sans-serif; }
  #hostbar { position: fixed; top: 0; left: 0; right: 0; z-index: 5000; display: flex; gap: 8px; align-items: center;
    padding: 4px 8px; background: #1f2937; font-size: 12px; }
  #hostbar button { font-size: 12px; }
  body.open #hostbar { display: none; }
</style></head>
<body>
<div id="hostbar">
  <span>stub host · backend ${backendUrl}</span>
  <button id="openbtn">패널 열기</button>
  <span id="hostlog"></span>
</div>
<script>
(() => {
  const backendUrl = ${JSON.stringify(backendUrl)};
  const token = ${JSON.stringify(TOKEN)};
  const liveChar = ${JSON.stringify(fixture)};
  const storage = new Map([['backend', { url: backendUrl, token }]]);
  const registered = [];
  const calls = [];
  const log = (m) => { document.getElementById('hostlog').textContent = m; console.log('[host]', m); };
  window.__host = { calls, registered, liveChar };
  window.Risuai = {
    async getArgument() { return ''; },
    async setArgument() {},
    async getRuntimeInfo() { return { apiVersion: '3.0', platform: 'web', saveMethod: 'local' }; },
    async nativeFetch(url, opts = {}) {
      calls.push('nativeFetch');
      return await fetch(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body });
    },
    async getCurrentCharacterIndex() { return 0; },
    async getCurrentChatIndex() { return liveChar.chatPage; },
    async getCharacterFromIndex() { return structuredClone(liveChar); },
    async setCharacterToIndex(i, char) { Object.assign(liveChar, structuredClone(char)); },
    async getDatabase() { return { characters: [structuredClone(liveChar)] }; },
    async setDatabase() {},
    async checkCharOrder() {},
    async getChatFromIndex(ci, chi) { return structuredClone(liveChar.chats[chi] ?? null); },
    async setChatToIndex(ci, chi, chat) { if (liveChar.chats[chi]) liveChar.chats[chi] = structuredClone(chat); },
    async showContainer() { document.body.classList.add('open'); calls.push('showContainer'); },
    async hideContainer() { document.body.classList.remove('open'); calls.push('hideContainer'); },
    async registerSetting(name, cb) { registered.push({ id: 's1', cb }); return { id: 's1' }; },
    async registerButton(a, cb) { registered.push({ id: 'b1', cb }); return { id: 'b1' }; },
    async unregisterUIPart() {},
    async readImage() { return new Uint8Array([71,73,70,56,57,97,1,0,1,0,128,0,0,0,0,0,255,255,255,33,249,4,1,0,0,0,0,44,0,0,0,0,1,0,1,0,0,2,2,68,1,0,59]); },
    async saveAsset() { return 'assets/harness.png'; },
    pluginStorage: {
      async getItem(k) { return storage.get(k); },
      async setItem(k, v) { storage.set(k, v); },
      async removeItem(k) { storage.delete(k); },
    },
    async onUnload() {},
    async alert(m) { log('alert: ' + m); }, async alertError(m) { log('alertError: ' + m); },
    async alertConfirm(m) { log('alertConfirm: ' + m); return true; },
  };
  document.getElementById('openbtn').addEventListener('click', () => {
    if (!registered.length) { log('plugin registered nothing'); return; }
    registered[0].cb();
  });
  window.__open = () => registered[0]?.cb();
})();
</script>
<script>
  // Scenario from the query string, so a headless screenshot can land on a
  // given tab in a given mobile view:  /?tab=meta&view=centre
  (() => {
    const q = new URLSearchParams(location.search);
    const view = q.get('view');
    if (view) localStorage.setItem('hina.mobileView', view);
    window.__scenario = { tab: q.get('tab') || '', mode: q.get('mode') || '', sub: q.get('sub') || '' };
  })();
</script>
<script src="/bundle.js"></script>
<script>
  setTimeout(() => window.__open && window.__open(), 300);
  setTimeout(() => {
    const s = window.__scenario || {};
    if (s.mode === 'chat') [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '챗 편집')?.click();
    if (s.tab === 'settings') document.getElementById('open-settings')?.click();
    else if (s.tab) document.getElementById('tab-' + s.tab)?.click();
    if (s.sub) setTimeout(() => [...document.querySelectorAll('.subtab')].find((t) => t.textContent === s.sub)?.click(), 400);
  }, 2500);
  // ?probe=1: after the scenario settles, write layout numbers into the DOM so
  // a headless --dump-dom run can read them (there is no console to read).
  if (new URLSearchParams(location.search).get('probe')) {
    setTimeout(() => {
      const pick = (sel) => {
        const n = document.querySelector(sel);
        if (!n) return null;
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
                 display: cs.display, overflowY: cs.overflowY, position: cs.position, sw: n.scrollWidth, sh: n.scrollHeight };
      };
      const out = {};
      for (const sel of ['.wrap', 'main', '.panel.active', '.split', '.explorer', '.left', '.right', '.right-inner',
                         '.agentpanel', '.agentlog', '.agentcompose', '.agentinput', '.agentbtns', '.sendbtn', '.mtoggle',
                         '.tree', '.pad', '.scroller', '.agenthead']) out[sel] = pick(sel);
      out.viewport = { w: innerWidth, h: innerHeight, docW: document.documentElement.scrollWidth };
      const pre = document.createElement('pre');
      pre.id = 'probe';
      pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
      try { parent.postMessage({ type: 'hina-probe', out }, '*'); } catch { /* not framed */ }
    }, 4500);
  }
</script>
</body></html>`;


// The plugin runs in an iframe in RisuAI, and headless Chrome will not make a
// window narrower than 500px - so the phone case is an iframe of the asked
// size, and the media queries inside it see the iframe's width.
const framePage = (w, h, inner) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Risu Hina harness</title>
<style>
  html, body { margin: 0; background: #06070a; }
  #stage { display: inline-block; margin: 4px; border: 1px solid #3a4152; }
  iframe { display: block; border: none; width: ${w}px; height: ${h}px; background: #0f1117; }
  #probe { color: #9aa; font: 11px monospace; white-space: pre-wrap; max-width: 900px; }
</style></head>
<body><div id="stage"><iframe id="app" src="${inner}"></iframe></div><pre id="probe"></pre>
<script>
  addEventListener('message', (e) => {
    if (e.data && e.data.type === 'hina-probe') document.getElementById('probe').textContent = JSON.stringify(e.data.out);
  });
</script>
</body></html>`;

// --- serve ------------------------------------------------------------------

const backend = await startBackend();
const port = argPort || await freePort();
const server = createServer((req, res) => {
  if (req.url === '/bundle.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(BUNDLE, 'utf8'));
    return;
  }
  const u = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (u.pathname === '/app') { res.end(pageHtml(backend.url)); return; }
  // /?w=390&h=760&tab=meta&view=centre&probe=1  -> the plugin page framed at that size
  const w = Number(u.searchParams.get('w')) || 1200;
  const h = Number(u.searchParams.get('h')) || 800;
  u.searchParams.delete('w'); u.searchParams.delete('h');
  res.end(framePage(w, h, '/app?' + u.searchParams.toString()));
});
server.listen(port, '127.0.0.1', () => {
  console.log(`harness: http://127.0.0.1:${port}/   (bundle ${BUNDLE})`);
  console.log(`backend: ${backend.url}`);
});

const bye = () => {
  try { backend.proc.kill(); } catch { /* gone */ }
  // Only clean up what we created.
  if (!process.env.RISUHINA_HARNESS_DATA) {
    try { rmSync(backend.data, { recursive: true, force: true }); } catch { /* fine */ }
  }
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
