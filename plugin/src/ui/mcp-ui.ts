/**
 * MCP in the panel: the install card (설정 → 고급 기능) and the switch on the
 * picker (the first screen of 봇/챗 편집). The switch only appears once the
 * backend has the add-on loaded; the card is where it gets there.
 */
import { el, clear } from './dom';
import { state } from '../state';
import { transport } from '../transport';
import { copyToClipboard } from '../host';
import { mcp, type McpAddonStatus, type McpBridgeStatus } from '../mcp';

const URL_KEY = 'mcpUrl';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function mcpToast(text: string, kind: 'ok' | 'err' | '' = ''): void {
  let wrap = document.querySelector<HTMLElement>('.toastwrap');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toastwrap'; document.body.appendChild(wrap); }
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = text;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
mcp.onNotice = mcpToast;

/** The address an MCP client outside should use. The panel's own backend URL
 * is often not it (127.0.0.1 through PocketRisu, or a LAN address), so it is
 * editable and remembered; the default is the backend URL + /mcp. */
async function savedUrl(): Promise<string> {
  try {
    const v = await Risuai.pluginStorage.getItem(URL_KEY);
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch { /* storage unavailable: fall back */ }
  return (transport.config.url || '').replace(/\/+$/, '') + '/mcp';
}

function command(url: string, token: string): string {
  return `claude mcp add --transport http risu-hina ${url} --header "Authorization: Bearer ${token}"`;
}

function ago(at: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - at));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.round(s / 60)}분 전`;
  return `${Math.round(s / 3600)}시간 전`;
}

// --- settings: 고급 기능 → MCP ---------------------------------------------------

export function buildMcpCard(onMount?: (refresh: () => void) => void): HTMLElement {
  const statusLine = el('div', { class: 'hint' });
  const actions = el('div', { class: 'row' });
  const detail = el('div');
  const out = el('pre', { class: 'hint mcpout', style: { display: 'none', maxHeight: '200px', overflow: 'auto', whiteSpace: 'pre-wrap' } });
  let timer: ReturnType<typeof setTimeout> | null = null;

  const render = async (): Promise<void> => {
    if (timer) { clearTimeout(timer); timer = null; }
    clear(actions);
    clear(detail);
    if (!state.health) {
      statusLine.textContent = '백엔드에 연결되면 확인할 수 있습니다.';
      return;
    }
    let st: { addon: McpAddonStatus; bridge: McpBridgeStatus };
    try {
      st = await mcp.status();
    } catch (e) {
      statusLine.textContent = '이 백엔드는 MCP 를 지원하지 않습니다 (백엔드 업데이트 필요): ' + msg(e);
      return;
    }
    const a = st.addon;
    // The picker's switch reads /health; after an install (or removal) the
    // cached health is stale until refreshed.
    if (st.bridge.mounted !== mcp.available) void state.connect();
    if (a.job.running) {
      statusLine.textContent = `설치 중입니다… (${Math.round(Date.now() / 1000 - a.job.startedAt)}초) — 보통 1분 안쪽입니다.`;
      timer = setTimeout(() => void render(), 2000);
      return;
    }
    if (a.job.ok === false) {
      out.style.display = '';
      out.textContent = (a.job.error || '') + '\n\n' + (a.job.output || '');
    }
    if (a.removalPending) {
      statusLine.textContent = '제거 예약됨 — 백엔드를 다시 시작하면 지워집니다.';
      return;
    }
    const install = el('button', { class: 'primary tiny', text: a.reinstallNeeded ? 'MCP 재설치' : 'MCP 설치' }) as HTMLButtonElement;
    install.addEventListener('click', async () => {
      install.disabled = true;
      out.style.display = 'none';
      try {
        const r = await mcp.install();
        if (!r.started) statusLine.textContent = r.reason || '시작하지 못했습니다.';
      } catch (e) {
        statusLine.textContent = '설치를 시작하지 못했습니다: ' + msg(e);
      }
      await render();
    });
    if (!a.installed) {
      statusLine.textContent = a.reinstallNeeded
        ? '백엔드의 파이썬이 바뀌어 다시 설치해야 합니다.'
        : '설치되어 있지 않습니다. 백엔드 설치본에 mcp 패키지(약 30MB)를 내려받아 설치합니다. 릴리스 번들에는 들어 있지 않습니다.';
      actions.appendChild(install);
      return;
    }
    if (!a.loaded) {
      statusLine.textContent = `설치됨 v${a.version} — 불러오지 못했습니다: ${a.loadError || '백엔드를 다시 시작해 주세요.'}`;
    } else {
      statusLine.textContent = `설치됨 v${a.version} · /mcp 동작 중` + (st.bridge.active ? ' · 패널 활성' : ' · 패널 꺼짐');
    }
    const remove = el('button', { class: 'ghost tiny', text: '제거' }) as HTMLButtonElement;
    let armedRemove = false;
    remove.addEventListener('click', async () => {
      if (!armedRemove) { armedRemove = true; remove.textContent = '정말 제거'; setTimeout(() => { armedRemove = false; remove.textContent = '제거'; }, 3000); return; }
      remove.disabled = true;
      try {
        const r = await mcp.uninstall();
        statusLine.textContent = r.restartNeeded ? '제거 예약됨 — 백엔드를 다시 시작하면 지워집니다.' : '제거했습니다.';
        await state.connect();
      } catch (e) {
        statusLine.textContent = '제거하지 못했습니다: ' + msg(e);
      }
      await render();
    });
    actions.appendChild(remove);
    if (!a.loaded) return;

    // Address, token and the one command to paste.
    const url = el('input', { value: await savedUrl(), placeholder: 'https://risuhina.example.com/mcp' }) as HTMLInputElement;
    const tokenBox = el('input', { type: 'password', readonly: 'readonly' }) as HTMLInputElement;
    const cmd = el('pre', { class: 'mcpcmd', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' } });
    let token = '';
    const sync = () => { cmd.textContent = command(url.value.trim(), token ? '••••••' : '<토큰>'); };
    try { token = await mcp.token(); tokenBox.value = token; } catch (e) { tokenBox.value = ''; statusLine.textContent += ' · 토큰을 읽지 못했습니다: ' + msg(e); }
    sync();
    url.addEventListener('change', async () => {
      try { await Risuai.pluginStorage.setItem(URL_KEY, url.value.trim()); } catch { /* not remembered */ }
      sync();
    });
    url.addEventListener('input', sync);
    const show = el('button', { class: 'ghost tiny', text: '보기' });
    show.addEventListener('click', () => { tokenBox.type = tokenBox.type === 'password' ? 'text' : 'password'; show.textContent = tokenBox.type === 'password' ? '보기' : '숨기기'; });
    const copyCmd = el('button', { class: 'primary tiny', text: '명령 복사' });
    copyCmd.addEventListener('click', () => {
      copyCmd.textContent = copyToClipboard(command(url.value.trim(), token)) ? '복사됨' : '복사 실패';
      setTimeout(() => { copyCmd.textContent = '명령 복사'; }, 1500);
    });
    const rotate = el('button', { class: 'ghost tiny', text: '토큰 재발급' }) as HTMLButtonElement;
    let armedRotate = false;
    rotate.addEventListener('click', async () => {
      if (!armedRotate) { armedRotate = true; rotate.textContent = '재발급 (기존 연결 끊김)'; setTimeout(() => { armedRotate = false; rotate.textContent = '토큰 재발급'; }, 3000); return; }
      try { token = await mcp.token(true); tokenBox.value = token; sync(); mcpToast('토큰을 재발급했습니다. MCP 클라이언트에 새 명령을 다시 등록해 주세요.', 'ok'); } catch (e) { mcpToast('재발급 실패: ' + msg(e), 'err'); }
      armedRotate = false; rotate.textContent = '토큰 재발급';
    });

    detail.appendChild(el('label', { class: 'field' }, [el('span', { text: 'MCP 주소 (MCP 클라이언트가 접속할 외부 주소)' }), url]));
    detail.appendChild(el('label', { class: 'field' }, [el('span', { text: 'MCP 토큰 (백엔드 토큰과 별개, 루프백에서도 항상 필요)' }), tokenBox]));
    detail.appendChild(el('div', { class: 'row' }, [show, rotate]));
    detail.appendChild(el('div', { class: 'hint', style: { marginTop: '8px' }, text: 'Claude Code 에서 한 번 실행하세요:' }));
    detail.appendChild(cmd);
    detail.appendChild(el('div', { class: 'row' }, [copyCmd]));
    detail.appendChild(el('div', { class: 'hint', style: { marginTop: '8px' } }, [
      '사용: 봇·챗 선택 화면(첫 화면)의 ‘MCP 활성화’를 누르고 이 화면을 열어 둔 채로 Claude Code 에서 부르세요. ',
      'MCP 는 패널에 열린 봇·챗에서만 동작하고, 수정은 모두 이 패널의 승인 대기로 들어옵니다. ',
      '토큰은 이 백엔드에서 파이썬 실행(run_python)까지 할 수 있는 권한입니다 — 공유하지 마세요.',
    ]));
  };

  onMount?.(() => void render());
  void render();
  return el('div', { class: 'card' }, [
    el('h2', { text: 'MCP (Claude Code 등에서 부르기)' }),
    statusLine, actions, out, detail,
  ]);
}

// --- the picker's switch --------------------------------------------------------

/** The 'MCP 활성화' switch for the picker, or null when the add-on is absent. */
export function mcpSwitch(): HTMLElement | null {
  if (!mcp.available && !mcp.on) return null;
  const btn = el('button') as HTMLButtonElement;
  const line = el('span', { class: 'hint mcpline' });
  const syncLine = () => {
    btn.className = (mcp.on ? 'primary' : 'ghost') + ' tiny mcpswitch';
    btn.textContent = mcp.on ? 'MCP 켜짐 · 끄기' : 'MCP 활성화';
    btn.title = mcp.on
      ? 'MCP 클라이언트가 이 봇·챗에서 작업할 수 있습니다. 이 화면을 열어 두세요.'
      : 'Claude Code 등 MCP 클라이언트가 지금 열린 봇·챗을 다룰 수 있게 합니다.';
    if (!mcp.on) { line.textContent = mcp.error; return; }
    if (mcp.error) { line.textContent = '연결 재시도 중: ' + mcp.error; return; }
    line.textContent = mcp.lastCall
      ? `호출 ${mcp.calls}회 · 마지막 ${mcp.lastCall.tool} ${ago(mcp.lastCall.at)}`
      : '대기 중 — 화면을 열어 두세요';
  };
  syncLine();
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (mcp.on) await mcp.deactivate();
      else await mcp.activate();
    } catch (e) {
      mcpToast('MCP 를 켜지 못했습니다: ' + msg(e), 'err');
    }
    btn.disabled = false;
    syncLine();
  });
  // The line updates in place; a full picker render per poll would flicker.
  const off = mcp.subscribe(() => {
    if (!btn.isConnected) { off(); return; }
    syncLine();
  });
  return el('span', { class: 'mcpswitchwrap' }, [btn, line]);
}
