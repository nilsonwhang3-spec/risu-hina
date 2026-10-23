/**
 * 오류 제보: one block of text a user can paste under the maker's community
 * post.
 *
 * Reports used to stall on "where is the log?": the diagnostics and the server
 * log lived two clicks deep in ⚙ → 정보, and nobody found them until they were
 * told. So the way in is wherever the trouble shows - every red notice in the
 * panel grows an [오류 제보] button, and the title row has one for "something
 * feels wrong" with no error on screen.
 *
 * The block is short on purpose (a comment box, not a file): versions, the
 * setup, the error that was clicked, the panel's own recent errors and the
 * server's recent warn/error lines. No key or token is in any of them, and
 * home-folder names and the backend's paths are masked, because a comment is
 * public.
 */
import { el, clear, modal, svg } from './dom';
import { state } from '../state';
import { addressKind, transport } from '../transport';
import * as host from '../host';

/** The panel's own recent errors, newest last. Kept even while the backend is
 * unreachable - that is exactly when the server log cannot help. */
const recent: { at: number; text: string }[] = [];
const KEEP = 12;

export function recordClientError(text: string): void {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!t) return;
  const last = recent[recent.length - 1];
  if (last && last.text === t) { last.at = Date.now(); return; }
  recent.push({ at: Date.now(), text: t });
  if (recent.length > KEEP) recent.shift();
}

export const BUG_ICON = svg('<path d="M8 2l1.9 1.9M16 2l-1.9 1.9"/><path d="M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6z"/><path d="M12 20v-9M6 13H2M22 13h-4M6.5 17.5 3 20M17.5 17.5 21 20M6.5 9 3 7M17.5 9 21 7"/>', 17);

/** The title-row button. */
export function bugReportButton(): HTMLButtonElement {
  const b = el('button', {
    // hdrbug: the first title-row button to go on a phone (styles.ts); the
    // red notices and ⚙ 정보 still reach the report there.
    class: 'iconbtn hdrbug', html: BUG_ICON,
    title: '오류 제보 — 오류가 났거나 이상하면 눌러 주세요. 제작자에게 보낼 내용을 만들어 줍니다',
  }) as HTMLButtonElement;
  b.addEventListener('click', () => openBugReport());
  return b;
}

/**
 * Give every red notice an [오류 제보] button, and remember what it said.
 *
 * One observer instead of a change at each of the forty places that show an
 * error: a new screen gets the button without anyone remembering to add it.
 */
export function watchErrorNotices(root: Node = document.body): void {
  if (typeof MutationObserver === 'undefined') return;
  const attach = (n: Element) => {
    if (n.closest('.bugreport') || n.querySelector('.bugbtn')) return;
    const text = (n.textContent || '').trim();
    if (!text) return;
    recordClientError(text);
    const b = el('button', { class: 'ghost tiny bugbtn', text: '오류 제보', title: '이 오류를 제작자에게 알릴 내용을 만듭니다' });
    b.addEventListener('click', (e) => { e.stopPropagation(); openBugReport(text); });
    n.appendChild(b);
  };
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((node) => {
        if (node.nodeType !== 1) return;
        const e = node as Element;
        if (e.matches('.notice.err')) attach(e);
        e.querySelectorAll('.notice.err').forEach(attach);
      });
    }
  }).observe(root, { childList: true, subtree: true });
}

/** Open the report, optionally about one error the user clicked. */
export function openBugReport(trigger = ''): void {
  const what = el('textarea', {
    class: 'bugwhat', rows: '3',
    placeholder: '무슨 작업 중이었는지 한두 줄 (선택) — 예: 로어북 반영을 누르면 실패합니다',
  }) as HTMLTextAreaElement;
  const out = el('textarea', { class: 'mono bugtext', rows: '14', readonly: 'readonly', spellcheck: 'false' }) as HTMLTextAreaElement;
  out.value = '내용을 모으는 중입니다…';
  const status = el('div', { class: 'hint' });
  const copy = el('button', { class: 'primary', text: '복사' });
  copy.disabled = true;

  let built = '';
  const full = () => (what.value.trim() ? `상황: ${what.value.trim()}\n` : '') + built;
  const refresh = () => { out.value = full(); };
  what.addEventListener('input', refresh);
  copy.addEventListener('click', () => {
    const ok = host.copyToClipboard(full());
    if (!ok) { out.focus(); out.select(); }
    clear(status);
    status.appendChild(el('div', {
      class: 'notice ' + (ok ? 'ok' : ''),
      text: ok
        ? '복사했습니다. 제작자의 커뮤니티 글에 댓글로 붙여넣어 주세요.'
        : '자동 복사가 막혀 있습니다. 위 상자를 길게 눌러(또는 Ctrl+A) 전체 선택한 뒤 복사해 주세요.',
    }));
  });

  modal('오류 제보', el('div', { class: 'bugreport' }, [
    el('div', { class: 'notice' }, [
      el('div', { text: '아래 내용을 복사해서 제작자에게 커뮤니티 댓글로 붙여넣어 주세요.' }),
      el('div', { class: 'hint', text: 'API 키·토큰은 들어 있지 않고, PC 사용자 이름과 설치 경로는 가려집니다. 댓글은 공개되니 한 번 훑어보고 보내 주세요.' }),
    ]),
    what,
    out,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [copy]),
    status,
  ]), { wide: true, sticky: true });

  void buildReport(trigger).then((text) => {
    built = text;
    refresh();
    copy.disabled = false;
  });
}

/** The block itself. Every part is best-effort: a dead backend still leaves
 * the plugin half, which is usually the half that explains it. */
export async function buildReport(trigger = ''): Promise<string> {
  const lines: string[] = ['[Risu Hina 오류 제보]'];
  const at = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  lines.push(`시각: ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`);

  let diag: Record<string, unknown> | null = null;
  try { diag = await state.diagnostics(false); } catch { diag = null; }
  const backend = diag ? `v${String(diag['version'] ?? '?')}` : `연결 안 됨 (${state.connectError || '응답 없음'})`;
  lines.push(`버전: 플러그인 v${__PLUGIN_VERSION__} · 백엔드 ${backend}`);
  const health = (state.health ?? {}) as unknown as Record<string, unknown>;
  lines.push('환경: ' + [
    `RisuAI ${transport.hostPlatform || '?'}`,
    `연결 ${transport.routeKind || '?'}`,
    addressLabel(transport.config.url),
    diag ? `서버 ${String(diag['platform'] ?? '?')}/py${String(diag['python'] ?? '?')}` : '',
    health['installKind'] ? `설치 ${String(health['installKind'])}` : '',
    window.innerWidth ? `화면 ${window.innerWidth}x${window.innerHeight}` : '',
    shortUa(navigator.userAgent),
  ].filter(Boolean).join(' · '));
  const agent = (diag?.['agent'] ?? null) as Record<string, unknown> | null;
  if (agent) {
    lines.push('AI: ' + [
      String(agent['model'] || '(모델 미설정)'),
      agent['baseUrlHost'] ? `@${String(agent['baseUrlHost'])}` : '',
      agent['reasoning'] ? `사고 ${String(agent['reasoning'])}` : '',
      agent['maxTokens'] ? `최대출력 ${String(agent['maxTokens'])}` : '',
      diag?.['agentReady'] ? '' : '준비 안 됨',
    ].filter(Boolean).join(' · '));
  }
  const tab = document.querySelector('.tabs .tab.active .tablabel')?.textContent?.trim();
  if (tab) lines.push(`보던 탭: ${tab}`);
  if (trigger) lines.push('', `누른 오류: ${trigger.replace(/\s+/g, ' ').trim().slice(0, 400)}`);

  // The clicked notice was recorded too; it is already on the line above.
  const head = trigger.replace(/\s+/g, ' ').trim().slice(0, 300);
  const others = recent.filter((r) => r.text !== head);
  if (others.length) {
    lines.push('', '화면에 뜬 최근 오류:');
    for (const r of others.slice(-6)) lines.push(`- ${clock(r.at)} ${r.text}`);
  }

  if (diag) {
    try {
      const r = await state.logs(40, 'warn');
      // 404s from probes and the like are noise in a comment; keep the rest.
      const kept = r.lines.filter((l) => !/->\s*404\b/.test(l)).slice(-15);
      if (kept.length) {
        lines.push('', '서버 로그 (warn 이상, 최근):');
        for (const l of kept) lines.push(l.length > 240 ? l.slice(0, 240) + '…' : l);
      }
    } catch { lines.push('', '(서버 로그를 읽지 못했습니다)'); }
  }

  let text = mask(lines.join('\n'));
  // A comment box, not a file: the oldest log lines go first if it runs long.
  if (text.length > 3500) text = text.slice(0, 3500) + '\n…(길어서 잘랐습니다)';
  return text;
}

/** Home-folder names and absolute paths out: a community comment is public. */
export function mask(text: string): string {
  return text
    // A Windows path whose folders may hold spaces ("Risu Hina\pyserver"):
    // every segment but the last ends in a separator; the last has no space.
    .replace(/\b[A-Za-z]:[\\/](?:[^\\/\r\n"'<>|:*?]+[\\/])*[^\\/\s"'<>|:*?]*/g, (m) => '<path>' + tail(m))
    .replace(/(\/(?:home|Users)\/)[^/\s"']+/g, '$1<user>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

function tail(path: string): string {
  // The file name is the useful part ("…\server.log"), the folders are not.
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length > 1 ? '\\…\\' + parts[parts.length - 1] : '';
}

function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The backend URL's class and scheme, never the address (§1-117): web
 * RisuAI refuses an IP outright, and the masked report could not show it. */
function addressLabel(url: string): string {
  if (!url) return '주소 없음';
  const { kind, scheme } = addressKind(url);
  return `주소 ${kind}${scheme ? '/' + scheme : ''}`;
}

function shortUa(ua: string): string {
  const os = /Android [\d.]+|iPhone OS [\d_]+|iPad|Windows NT [\d.]+|Mac OS X [\d_]+|Linux/.exec(ua)?.[0] ?? '';
  const br = /(Edg|Chrome|Firefox|Version)\/[\d]+/.exec(ua)?.[0] ?? '';
  return [os.replace(/_/g, '.'), br.replace('Version', 'Safari')].filter(Boolean).join(' ');
}
