import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export async function stagedAssetSmoke({ backend, host, document, window, settle, clickButton, check, root }) {
  const originalFetch = globalThis.fetch, originalSave = host.api.saveAsset, originalSet = host.api.setCharacterToIndex;
  const auth = { Authorization: 'Bearer plugin-smoke-token', 'Content-Type': 'application/json' };
  const get = async path => (await originalFetch(backend.url + path, { headers: auth })).json();
  const post = async (path, body) => {
    const response = await originalFetch(backend.url + path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(path + ': ' + JSON.stringify(result));
    return result;
  };
  const workspaces = (await get('/workspace')).workspaces;
  const workspace = workspaces.find(w => w.chaId === host.liveChar.chaId) ?? workspaces[0];
  const ck = workspace.charKey, chatKey = workspace.chats[0].chatKey;
  const webp = Buffer.from('UklGRjoAAABXRUJQVlA4IC4AAACQAQCdASoCAAIAAUAmJaACdLoAA5gA/vtV4/+lwf/S4P/pcH/pcH8bss4bpAAA', 'base64');
  await post('/files/upload', { dir: 'projects/staged-smoke', name: 'hero-happy.2.webp', base64: webp.toString('base64') });
  const proposal = { name: 'hero-happy', path: 'projects/staged-smoke/hero-happy.2.webp', field: 'additional' };
  const script = "import sys,json,os; os.environ['RISUHINA_DATA_DIR']=sys.argv[1]; sys.path.insert(0,sys.argv[2]); from app import config,db,actions; config.load(); db.connect(); actions.propose('host_asset_add',chat_key=sys.argv[4],char_key=sys.argv[3],summary='Neutral WebP staged asset',args=json.loads(sys.argv[5])); actions.propose('script_add',chat_key=sys.argv[4],char_key=sys.argv[3],summary='Neutral regex staged edit',args={'kind':'customscript','entry':{'comment':'Neutral staged regex','in':'hello','out':'hi','type':'editdisplay'}})";
  let queued = false;
  const uploads = [], beforeAssets = structuredClone(host.liveChar.additionalAssets ?? []);
  host.api.saveAsset = async bytes => { uploads.push(Buffer.from(bytes)); return originalSave(bytes); };
  globalThis.fetch = async (url, opts) => {
    if (String(url).endsWith('/chat')) return new Response('{"type":"done","usage":{},"staged":0}\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
    if (!queued && String(url).includes('/actions?')) {
      queued = true;
      const actualChat = new URL(String(url)).searchParams.get('chatKey') || chatKey;
      execFileSync(join(root, 'pyserver/.venv/Scripts/python.exe'), ['-c', script, backend.data, join(root, 'pyserver'), ck, actualChat, JSON.stringify(proposal)], { encoding: 'utf8' });
    }
    return originalFetch(url, opts);
  };
  try {
    const input = document.querySelector('.panel.active .agentinput');
    input.value = 'Neutral pending changes test';
    document.querySelector('.panel.active .sendbtn')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(700);
    for (const label of ['Neutral WebP staged asset', 'Neutral regex staged edit']) {
      const row = [...document.querySelectorAll('.panel.active .stagedrow')].find(r => r.textContent.includes(label));
      check('proposal is shown as working-copy edit: ' + label, row?.textContent.includes('작업본'));
      row?.querySelector('button.primary')?.dispatchEvent(new window.Event('click', { bubbles: true }));
      await settle(500);
    }
    check('approval never invokes saveAsset', uploads.length === 0);
    check('approval leaves live asset references untouched', JSON.stringify(host.liveChar.additionalAssets ?? []) === JSON.stringify(beforeAssets));
    const changes = await get('/card/changes?charKey=' + encodeURIComponent(ck));
    check('asset and regex approvals both become pending card edits', changes.assetref.added >= 1 && changes.customscript.added >= 1);
    const bar = document.querySelector('.botbar');
    check('studio exposes pending bot writeback without changing tabs', bar?.style.display !== 'none' && Number(bar.querySelector('.applybadge')?.textContent) >= 2);
    document.getElementById('tab-files')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(250);
    check('workspace files also exposes pending writeback', document.getElementById('tab-files')?.classList.contains('active') && bar.style.display !== 'none');
    document.getElementById('tab-studio')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(250);
    bar.querySelector('.apply-help')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(100);
    check('touchable info explains staging, writeback and WebP', [...document.querySelectorAll('.applypop')].some(p => p.textContent.includes('작업본') && p.textContent.includes('PNG/WebP')));
    document.body.dispatchEvent(new window.Event('click', { bubbles: true }));
    host.api.setCharacterToIndex = async (i, char) => {
      const kept = structuredClone(char); kept.additionalAssets = structuredClone(beforeAssets); return originalSet(i, kept);
    };
    bar.querySelector('[data-tool="card-apply"]')?.dispatchEvent(new window.Event('click', { bubbles: true }));
    await settle(250);
    const pop = [...document.querySelectorAll('.applypop')].find(p => p.textContent.includes('RisuAI에 반영'));
    check('apply popover refreshes stale counts', !!pop && !pop.textContent.includes('반영할 변경이 없습니다'));
    clickButton(pop, 'RisuAI에 반영');
    await settle(1000);
    check('writeback uploads original WebP bytes', uploads.length === 1 && uploads[0].equals(webp), JSON.stringify({ uploads: uploads.length, popup: pop?.textContent, calls: host.calls.slice(-8) }));
    check('failed host verification preserves pending assets', (await get('/card/changes?charKey=' + encodeURIComponent(ck))).assetref.added >= 1);
    host.api.setCharacterToIndex = originalSet;
    clickButton(pop, 'RisuAI에 반영');
    await settle(1200);
    const saved = (host.liveChar.additionalAssets ?? []).find(r => r[0] === 'hero-happy');
    check('successful writeback registers WebP with actual extension metadata', saved?.[2] === 'webp' && !saved?.[1].includes('hina-pending-'));
    check('successful writeback clears pending card changes', (await get('/card/changes?charKey=' + encodeURIComponent(ck))).total === 0);
    check('regex is written with the assets', (host.liveChar.customscript ?? []).some(r => r.comment === 'Neutral staged regex'));
  } finally {
    host.api.saveAsset = originalSave; host.api.setCharacterToIndex = originalSet; globalThis.fetch = originalFetch;
  }
}
