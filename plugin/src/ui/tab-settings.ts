/**
 * Tab 3 - backend connection, agent credentials, and a connection diagnostic.
 *
 * The diagnostic exists because connection failure is going to be the most
 * common problem here and it has several distinct causes that look identical
 * from the UI: wrong URL, wrong token, backend down, or - on web RisuAI - the
 * request being relayed through sv.risuai.xyz instead of reaching the backend
 * at all. Reporting what was actually observed beats guessing.
 */
import { el, clear } from './dom';
import { state } from '../state';
import { buildPresetsCard } from './presets';
import { buildSkillsCard } from './skills';
import { agentPanel } from './agentpane';
import { buildDebugCard, buildUpdateCard } from './debugpanel';
import { transport } from '../transport';

let aboutMount: HTMLElement | null = null;

/**
 * Build once, refresh only what depends on state.
 *
 * Rebuilding on every state change looked fine until a test drove it: the
 * diagnostic calls state.connect(), connect() emits, the emit re-renders this
 * tab, and the freshly written diagnostic output is wiped before the user can
 * read it. The agent test result had the same fate. Anything long-lived here -
 * a half-typed API key included - has to survive an unrelated state change.
 */
export function renderSettingsTab(mount: HTMLElement): void {
  if (mount.querySelector('.pad')) {
    refreshAbout();
    return;
  }
  clear(mount);

  // Sub-tabs, because these are four unrelated jobs and stacking them made a
  // page you scroll past three things to reach the fourth. Each section is
  // built once and hidden with CSS - a half-typed key must survive a tab
  // switch, and rebuilding would lose it.
  aboutMount = el('div');
  refreshAbout();

  const sections: [string, HTMLElement[]][] = [
    ['연결', [buildConnectionCard(), buildDiagnosticCard()]],
    ['에이전트', [buildPresetsCard({
      onChanged: async () => {
        await state.connect();
        // The agent panel renders once and keeps it. Without this, changing
        // credentials here leaves it still saying they are not set.
        agentPanel().invalidate();
      },
    })]],
    ['스킬', [buildSkillsCard()]],
    ['정보 · 로그', [buildUpdateCard(), buildDebugCard(), aboutMount]],
  ];

  const bar = el('div', { class: 'subtabs' });
  const body = el('div', { class: 'pad' });
  const panes = sections.map(([label, cards], i) => {
    const pane = el('div', { class: 'subpane' + (i === 0 ? ' active' : '') }, cards);
    const btn = el('button', { class: 'subtab' + (i === 0 ? ' active' : ''), text: label });
    btn.addEventListener('click', () => {
      for (const [j, other] of panes.entries()) {
        other.pane.classList.toggle('active', j === i);
        other.btn.classList.toggle('active', j === i);
      }
    });
    bar.appendChild(btn);
    body.appendChild(pane);
    return { pane, btn };
  });
  void panes;

  mount.appendChild(el('div', { class: 'settingswrap' }, [bar, body]));
}

function refreshAbout(): void {
  if (!aboutMount) return;
  clear(aboutMount);
  aboutMount.appendChild(buildAboutCard());
}

function buildConnectionCard(): HTMLElement {
  const cfg = transport.config;
  const url = el('input', { value: cfg.url, placeholder: 'http://127.0.0.1:6020' });
  const token = el('input', { value: cfg.token, type: 'password', placeholder: 'data/token.txt' });
  const out = el('div', { class: 'hint' });

  const save = el('button', { class: 'primary', text: '저장하고 연결' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '연결하는 중입니다…';
    try {
      // Persisted through pluginStorage rather than the //@arg values: args are
      // wiped when the plugin is reinstalled, and pluginCustomStorage is not.
      await Risuai.pluginStorage.setItem('backend', { url: url.value, token: token.value });
      try { await Risuai.setArgument('backend_url', url.value); } catch { /* optional */ }
      try { await Risuai.setArgument('backend_token', token.value); } catch { /* optional */ }
      transport.configure({ url: url.value, token: token.value });
      const ok = await state.connect();
      out.textContent = ok
        ? `연결되었습니다 · 백엔드 v${state.health?.version}`
        : '실패했습니다: ' + state.connectError;
    } finally {
      save.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '백엔드 연결' }),
    el('label', { class: 'field' }, [el('span', { text: 'URL' }), url]),
    el('label', { class: 'field' }, [
      el('span', { text: '토큰 (루프백이면 비워 두셔도 됩니다)' }), token,
    ]),
    el('div', { class: 'row' }, [save]),
    out,
    el('div', { class: 'hint', style: { marginTop: '8px' } }, [
      '127.0.0.1은 PocketRisu 서버 입장의 루프백입니다. 이 브라우저가 도는 PC가 아닙니다.',
    ]),
  ]);
}

function buildDiagnosticCard(): HTMLElement {
  const out = el('div');

  const run = el('button', { text: '연결 진단' });
  run.addEventListener('click', async () => {
    run.disabled = true;
    clear(out);
    try {
      await transport.detectPlatform();
      const t0 = Date.now();
      const ok = await state.connect();
      const ms = Date.now() - t0;
      const h = state.health;

      const rows: [string, string][] = [
        ['호스트', transport.hostPlatform],
        ['라우팅', transport.routeKind === 'direct' ? '직접 연결 확인됨' : '확인 안 됨'],
        ['토큰 부착', transport.tokenAttached ? '허용됨' : '보류 중'],
        ['왕복 시간', ms + 'ms'],
      ];
      if (h) {
        rows.push(['백엔드 버전', h.version]);
        rows.push(['백엔드가 본 클라이언트', String(h.clientIp)]);
        rows.push(['루프백으로 인식', h.loopback ? '예 (토큰 면제)' : '아니오 (토큰 필수)']);
        rows.push(['에이전트 설정', h.agentReady ? '완료' : '미완료']);
      }
      out.appendChild(el('div', { class: ok ? 'notice ok' : 'notice err' },
        [ok ? '백엔드에 직접 닿았습니다.' : '연결에 실패했습니다: ' + state.connectError]));
      out.appendChild(el('pre', {
        class: 'mono',
        text: rows.map(([k, v]) => `${k.padEnd(22)} ${v}`).join('\n'),
      }));

      if (transport.hostPlatform === 'web' && !transport.tokenAttached) {
        out.appendChild(el('div', { class: 'notice' }, [
          el('div', { text: 'web RisuAI에서 직접 연결이 확인되지 않아 토큰을 보내지 않았습니다.' }),
          el('div', {
            class: 'hint',
            text: 'RisuAI 설정에서 Use Plain Fetch를 켜 주세요. 꺼져 있으면 요청이 sv.risuai.xyz로 릴레이되어 토큰이 새고, 사설 주소에는 닿지도 않습니다.',
          }),
        ]));
      }
    } finally {
      run.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '연결 진단' }),
    el('div', { class: 'row' }, [run]),
    out,
  ]);
}

function buildAboutCard(): HTMLElement {
  const h = state.health;
  return el('div', { class: 'card' }, [
    el('h2', { text: '정보' }),
    el('pre', {
      class: 'mono',
      text: [
        `플러그인   v${__PLUGIN_VERSION__}`,
        `백엔드     ${h ? 'v' + h.version : '미연결'}`,
        `워크스페이스 ${h?.workspaces ?? '?'}개`,
      ].join('\n'),
    }),
  ]);
}
