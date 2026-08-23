/**
 * The panel a bug report is written from.
 *
 * Once this is on someone else's machine, "check the server log" is not an
 * instruction they can follow: the backend may be on a PC they are addressing
 * from a phone over Tailscale, and the log is a file on that PC. So the log
 * comes to the panel, and the panel offers to copy it.
 *
 * Two buttons, because the two questions are different. **진단 정보** answers
 * "what is this setup" - versions, what is configured, how much is stored - and
 * is short enough to paste anywhere. **로그** answers "what just happened" and
 * is long. A report that has both is one nobody has to follow up on.
 *
 * Neither carries a key or a token: the diagnostic reports whether a key is
 * set, never its value, and the log has never written one.
 */
import { el, clear } from './dom';
import { state } from '../state';
import { transport } from '../transport';
import * as host from '../host';

/**
 * Updating, in the order it actually happens.
 *
 * RisuAI updates the plugin from its own plugin screen - that is why the
 * //@update-url points at a GitHub release and not at this backend, which may
 * be the thing that is out of date. Then the user opens this panel and updates
 * the backend. So this card says which half is which rather than pretending
 * one button does both.
 */
export function buildUpdateCard(): HTMLElement {
  const out = el('div');
  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const applyBtn = el('button', { class: 'primary', text: '백엔드 업데이트' });
  applyBtn.disabled = true;

  const checkBtn = el('button', { class: 'ghost', text: '업데이트 확인' });
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    say('확인하는 중입니다…');
    try {
      const r = await state.updateCheck();
      clear(out);
      if (!r.configured) {
        out.appendChild(el('div', { class: 'notice' }, [
          el('div', { text: '업데이트 레포가 설정되지 않았습니다.' }),
          el('div', {
            class: 'hint',
            text: '백엔드 data/config.json 의 update.repo 에 GitHub 의 owner/repo 를 넣어 주세요.',
          }),
        ]));
        return;
      }
      if (!r.ok) {
        say(r.error || '확인하지 못했습니다', 'err');
        return;
      }
      if (!r.newer) {
        say(`이미 최신입니다 (v${r.current}).`, 'ok');
        return;
      }
      applyBtn.disabled = !r.installable;
      out.appendChild(el('div', { class: 'notice ok' }, [
        el('div', { text: `새 버전이 있습니다: v${r.current} → v${r.latest}` }),
        r.installable
          ? null
          : el('div', { class: 'hint', text: r.reason || '이 릴리스는 자동 설치할 수 없습니다' }),
      ]));
      if (r.notes) {
        out.appendChild(el('pre', { class: 'mono filepreview', text: r.notes }));
      }
    } catch (e) {
      say(msg(e), 'err');
    } finally {
      checkBtn.disabled = false;
    }
  });

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    checkBtn.disabled = true;
    say('내려받고 검증하는 중입니다… 끝나면 백엔드가 다시 시작됩니다.');
    try {
      const r = await state.updateApply();
      if (!r.updated) {
        say(r.reason || '설치할 것이 없습니다', 'ok');
        return;
      }
      say(`v${r.version} 을(를) 설치했습니다. 다시 올라오기를 기다리는 중입니다…`);
      const version = await state.waitForBackend(90);
      say(`백엔드가 v${version} 으로 다시 시작했습니다.`, 'ok');
    } catch (e) {
      // The install may well have succeeded and only the restart be slow, so
      // this says what is uncertain rather than declaring failure.
      say('설치 또는 재시작을 확인하지 못했습니다: ' + msg(e)
          + ' — 잠시 후 새로고침해서 버전을 확인해 주세요.', 'err');
    } finally {
      checkBtn.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '업데이트' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '순서가 있습니다. ① RisuAI 플러그인 화면에서 플러그인을 먼저 업데이트하고, ② 여기서 백엔드를 업데이트해 주세요.',
    ]),
    el('div', { class: 'row' }, [checkBtn, applyBtn]),
    out,
  ]);
}

export function buildDebugCard(): HTMLElement {
  const out = el('div');
  const levelSel = el('select');
  for (const [value, label] of [
    ['', '전체'], ['info', 'info 이상'], ['warn', 'warn 이상'], ['error', 'error만'],
  ]) {
    levelSel.appendChild(el('option', { value, text: label }));
  }

  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const show = (title: string, text: string) => {
    clear(out);
    const copy = el('button', { class: 'ghost tiny', text: '복사' });
    copy.addEventListener('click', () => {
      // Truthiness, not optimism: an unavailable clipboard in the sandbox
      // returns false rather than throwing, and a green "copied" over a failed
      // copy is worse than no button.
      const ok = copyText(text);
      copy.textContent = ok ? '복사했습니다' : '복사 실패 — 직접 선택해 주세요';
      setTimeout(() => { copy.textContent = '복사'; }, 3000);
    });
    const dl = el('button', { class: 'ghost tiny', text: '파일로 저장' });
    dl.addEventListener('click', () => saveText(title, text));

    out.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        el('span', { text: `${title} · ${text.length.toLocaleString()}자` }),
      ]),
      el('div', { class: 'row', style: { marginBottom: '8px' } }, [copy, dl]),
      el('pre', { class: 'mono filepreview', text }),
    ]));
  };

  const diagBtn = el('button', { class: 'primary', text: '진단 정보' });
  diagBtn.addEventListener('click', async () => {
    diagBtn.disabled = true;
    try {
      const server = await state.diagnostics();
      // The client half matters as much as the server half: most failures here
      // are about how the request got out of the iframe, not about the backend.
      const report = {
        plugin: {
          version: __PLUGIN_VERSION__,
          platform: transport.hostPlatform,
          route: transport.routeKind,
          tokenAttached: transport.tokenAttached,
          backendUrl: redactUrl(transport.config.url),
          hasToken: Boolean(transport.config.token),
          userAgent: navigator.userAgent,
          screen: `${window.innerWidth}x${window.innerHeight}`,
        },
        server,
        state: {
          connected: Boolean(state.health),
          connectError: state.connectError,
          charKey: state.activeCharKey,
          chatKey: state.activeChatKey,
          turns: state.turns.length,
        },
      };
      show('진단 정보', JSON.stringify(report, null, 2));
    } catch (e) {
      say('진단 정보를 읽지 못했습니다: ' + msg(e), 'err');
    } finally {
      diagBtn.disabled = false;
    }
  });

  const logBtn = el('button', { class: 'ghost', text: '서버 로그' });
  logBtn.addEventListener('click', async () => {
    logBtn.disabled = true;
    try {
      const r = await state.logs(400, selectedLevel(levelSel));
      show('서버 로그', r.lines.join('\n') || '(비어 있습니다)');
    } catch (e) {
      say('로그를 읽지 못했습니다: ' + msg(e), 'err');
    } finally {
      logBtn.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '문제 신고 · 디버깅' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '문제가 생기면 아래 두 가지를 복사해서 함께 보내 주세요. API 키나 토큰은 포함되지 않습니다.',
    ]),
    el('div', { class: 'row' }, [diagBtn, logBtn, levelSel]),
    out,
  ]);
}

function selectedLevel(sel: HTMLSelectElement): string {
  const chosen = Array.from(sel.querySelectorAll('option')).find((o) => o.selected);
  return chosen?.value ?? sel.value ?? '';
}

/** The host and path shape, never a token that someone put in a query string. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}:${u.port || '(기본)'}`;
  } catch {
    return url ? '(형식 오류)' : '(미설정)';
  }
}

/**
 * The execCommand path, which is the one that works in this iframe.
 *
 * `navigator.clipboard` needs a secure context and permission the sandbox does
 * not grant, so it fails silently here; host.copyToClipboard is what the Phase
 * 0 probe actually verified. It returns false rather than throwing, and that
 * false has to be believed - a green tick over a failed copy is worse than no
 * button at all.
 */
function copyText(text: string): boolean {
  return host.copyToClipboard(text);
}

function saveText(title: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
  const a = el('a', { href: url, download: `risu-elf-${title}-${stamp}.txt` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
