/**
 * Tab 3 - backend connection, agent credentials, and a connection diagnostic.
 *
 * The diagnostic exists because connection failure is going to be the most
 * common problem here and it has several distinct causes that look identical
 * from the UI: wrong URL, wrong token, backend down, or - on web RisuAI - the
 * request being relayed through sv.risuai.xyz instead of reaching the backend
 * at all. Reporting what was actually observed beats guessing.
 */
import { el, clear, armed, modal } from './dom';
import { state, type ApiKeyEntry, type ProviderProfile } from '../state';
import { buildPresetsCard, buildCodexBox } from './presets';
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
/**
 * Cards that load from the backend register here, so a connection that
 * comes up AFTER the settings page was built (the page opened before the
 * probe finished, or 저장하고 연결 fixed the URL) re-reads them. Without
 * this a card kept the "token not sent" refusal it got before the route
 * was proven direct, under a header that already said connected.
 */
const refreshers: (() => void | Promise<void>)[] = [];
let watchedHealth: boolean | null = null;

export function refreshSettingsCards(): void {
  for (const fn of refreshers) { try { void fn(); } catch { /* one card must not stop the rest */ } }
}

state.onChange(() => {
  const ok = !!state.health;
  if (watchedHealth === null) { watchedHealth = ok; return; }
  if (ok && !watchedHealth) refreshSettingsCards();
  watchedHealth = ok;
});

export function renderSettingsTab(mount: HTMLElement): void {
  if (mount.querySelector('.pad')) {
    refreshAbout();
    return;
  }
  clear(mount);
  refreshers.length = 0;
  watchedHealth = !!state.health;

  // Sub-tabs, because these are four unrelated jobs and stacking them made a
  // page you scroll past three things to reach the fourth. Each section is
  // built once and hidden with CSS - a half-typed key must survive a tab
  // switch, and rebuilding would lose it.
  aboutMount = el('div');
  refreshAbout();

  const sections: [string, HTMLElement[]][] = [
    // The backend update sits with the connection, right under it: it is the
    // first thing to press when the two sides disagree, and it was buried on
    // the last page before.
    ['연결', [buildConnectionCard(), buildUpdateCard(), buildDiagnosticCard(), buildAssetsCard()]],
    ['API 키/인증', [buildKeysCard()]],
    ['에이전트', [buildPresetsCard({
      onMount: (refresh) => { refreshers.push(refresh); },
      onChanged: async () => {
        await state.connect();
        // The agent panel renders once and keeps it. Without this, changing
        // credentials here leaves it still saying they are not set.
        agentPanel().invalidate();
      },
    })]],
    ['스킬', [buildSkillsCard({ onMount: (refresh) => { refreshers.push(refresh); } })]],
    ['정보 · 로그', [buildCatalogCard(), buildDebugCard(), aboutMount]],
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

  // The sub-tab bar goes up to the shell's tab row while settings is open
  // (연결 · API 키/인증 · 에이전트 …); the page keeps only its panes.
  // A visible way out, at the end of the section row (the gear toggles too).
  const closeBtn = el('button', { class: 'ghost tiny settingsclose', text: '✕ 닫기', title: '설정을 닫고 보던 탭으로 돌아갑니다' });
  closeBtn.addEventListener('click', () => { document.getElementById('open-settings')?.dispatchEvent(new Event('click', { bubbles: true })); });
  bar.appendChild(el('span', { class: 'spacer' }));
  bar.appendChild(closeBtn);
  settingsBar = bar;
  mount.appendChild(el('div', { class: 'settingswrap' }, [body]));
}

let settingsBar: HTMLElement | null = null;

/** The sub-tab bar, for the shell to place in the tab row (null until first render). */
export function getSettingsBar(): HTMLElement | null {
  return settingsBar;
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
      // pluginCustomStorage survives plugin updates; the //@arg fields did
      // not (and are gone from the header since 0.7.2).
      await Risuai.pluginStorage.setItem('backend', { url: url.value, token: token.value });
      transport.configure({ url: url.value, token: token.value });
      const ok = await state.connect();
      out.textContent = ok
        ? `연결되었습니다 · 백엔드 v${state.health?.version}`
        : '실패했습니다: ' + state.connectError;
      // Every other card loaded against the old (or no) connection.
      if (ok) refreshSettingsCards();
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
  const out = el('div', { class: 'outbox' });

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

      // Only when the probe actually failed: a successful connect has just
      // proven the route direct and attached the token, and saying otherwise
      // underneath a green line is exactly the message that would not go away.
      if (!ok && transport.hostPlatform === 'web' && !transport.tokenAttached) {
        out.appendChild(el('div', { class: 'notice' }, [
          el('div', { text: 'web RisuAI에서 직접 연결이 확인되지 않아 토큰을 보내지 않았습니다.' }),
          el('div', {
            class: 'hint',
            text: '대개는 백엔드 앞의 터널·VPN 이 아직 안 열린 것이고, 패널이 30초마다 다시 시도합니다. '
              + '계속 실패하면 위에 인용된 응답을 보세요 — HTML 이나 다른 서버의 답이면 URL 이 잘못된 것이고, '
              + 'sv.risuai.xyz 의 오류면 RisuAI 설정의 Use Plain Fetch 가 꺼져 요청이 릴레이된 것입니다.',
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

/**
 * The asset store's knobs: PocketRisu's save directory for the fast path
 * (the backend reads risuai.db directly instead of the plugin pushing every
 * image), the store's size, and the manual GC.
 */
function buildAssetsCard(): HTMLElement {
  const savePath = el('input', { placeholder: 'D:\\path\\to\\Risuai-NodeOnly\\save  (PocketRisu 의 save 폴더, 백엔드와 같은 PC일 때)' }) as HTMLInputElement;
  const stats = el('div', { class: 'hint' });
  const out = el('div', { class: 'outbox' });

  const load = async (): Promise<void> => {
    try {
      const { config } = await state.getConfig();
      const pr = (config.pocketrisu || {}) as { savePath?: string };
      savePath.value = pr.savePath || '';
    } catch { /* offline: leave blank */ }
    try {
      const d = await state.diagnostics() as { assets?: { blobs?: number; bytes?: number; fastPath?: boolean; serverWrite?: boolean; dir?: string } };
      const a = d.assets || {};
      stats.textContent = `스토어 ${a.blobs ?? '?'}개 · ${((a.bytes ?? 0) / 1048576).toFixed(1)}MB · ${a.dir ?? ''}`
        + (a.fastPath ? ' · SQLite 고속 경로 사용 중' : '') + (a.serverWrite ? ' · 서버 쓰기 가능' : '');
    } catch { stats.textContent = ''; }
  };
  void load();

  const save = el('button', { class: 'primary', text: '저장' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    clear(out);
    try {
      await state.setConfig({ pocketrisu: { savePath: savePath.value.trim() } });
      await load();
      out.appendChild(el('div', { class: 'notice ok', text: '저장했습니다. 다음 에셋 동기화부터 적용됩니다.' }));
    } catch (e) {
      out.appendChild(el('div', { class: 'notice err', text: '저장 실패: ' + (e instanceof Error ? e.message : String(e)) }));
    } finally {
      save.disabled = false;
    }
  });

  const gc = el('button', { text: '스토어 정리 (GC)' });
  gc.title = '어느 봇의 목록에도 없는 파일 중 7일이 지난 것을 지웁니다';
  gc.addEventListener('click', async () => {
    gc.disabled = true;
    clear(out);
    try {
      const r = await transport.post<{ removed: number; freed: number; orphanKeys: number }>('/assets/gc', {});
      await load();
      out.appendChild(el('div', { class: 'notice ok', text: `정리했습니다: 파일 ${r.removed}개 · ${(r.freed / 1048576).toFixed(1)}MB 확보 · 고아 키 ${r.orphanKeys}개` }));
    } catch (e) {
      out.appendChild(el('div', { class: 'notice err', text: 'GC 실패: ' + (e instanceof Error ? e.message : String(e)) }));
    } finally {
      gc.disabled = false;
    }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '포켓리스 직렬연결 (포켓리스 사용시만)' }),
    el('label', { class: 'field' }, [el('span', { text: 'PocketRisu save 폴더 (선택 · 백엔드와 같은 PC일 때만)' }), savePath]),
    el('div', { class: 'row' }, [save, gc]),
    stats,
    out,
    el('div', { class: 'hint', style: { marginTop: '8px' } }, [
      '비워 두면 플러그인이 에셋을 읽어 올립니다(웹 계정 사용자는 백엔드가 허브에서 직접 받습니다). ',
      '경로를 주면 백엔드가 risuai.db 를 읽기 전용으로 열어 빠진 에셋을 곧바로 채웁니다.',
    ]),
  ]);
}

/**
 * NovelAI - its own card, under the general keys.
 *
 * A NovelAI token is not a provider credential an agent preset picks from a
 * list: nothing chooses between NovelAI tokens, exactly one is in play, and
 * what a person wants to see next to it is the balance rather than the key
 * length. So it gets a card of its own, the way the web-search provider does
 * in the next tab, instead of being one anonymous row among the gateway keys.
 *
 * It is still stored as an `api_keys` row (provider `novelai`) - one place for
 * secrets - so nothing downstream had to learn about a second store.
 */
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function buildNaiCard(): { root: HTMLElement; refresh: () => Promise<void> } {
  const meters = el('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } });
  const input = el('input', { type: 'password', placeholder: 'NovelAI 퍼시스턴트 토큰' }) as HTMLInputElement;
  const out = el('div', { class: 'outbox' });
  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const test = el('button', { class: 'ghost tiny', text: '연결 확인' }) as HTMLButtonElement;
  let existingId = '';

  const refresh = async (): Promise<void> => {
    clear(meters);
    let st;
    try {
      st = await state.studio.status();
    } catch (e) {
      meters.appendChild(el('span', { class: 'hint err', text: msg(e) }));
      return;
    }
    if (!st.configured) {
      meters.appendChild(el('span', { class: 'hint', text: st.note || '토큰이 아직 없습니다.' }));
    } else if (st.account) {
      const a = st.account;
      meters.append(
        el('span', { class: 'badge', title: '레퍼런스 인코딩과 디렉터 툴이 쓰는 잔량', text: `Anlas ${a.anlas}` }),
        // Two currencies, neither derived from the other (docs/09 §2).
        el('span', { class: 'badge', title: 'v5 사용량 — Anlas 와 별개의 한도', text: `v5 ${a.usagePercent ?? '?'}%` }),
        el('span', { class: 'hint', text: `tier ${a.tier ?? '?'}${a.active ? '' : ' · 만료'}` }),
      );
    } else if (st.error) {
      meters.appendChild(el('span', { class: 'hint err', text: st.error }));
    }
    try {
      const { keys } = await state.apiKeys();
      const hit = keys.find((k) => (k.provider || '').toLowerCase() === 'novelai');
      existingId = hit?.id ?? '';
      input.placeholder = hit?.apiKey?.set
        ? `설정됨 (${hit.apiKey.length}자) — 바꿀 때만 입력`
        : 'NovelAI 퍼시스턴트 토큰';
    } catch { /* the card still works without the list */ }
  };

  save.addEventListener('click', async () => {
    const v = input.value.trim();
    if (!v) { out.textContent = '토큰을 입력해 주세요.'; return; }
    save.disabled = true;
    out.textContent = '';
    try {
      await state.saveApiKey({ name: 'NovelAI', provider: 'novelai', apiKey: v, baseUrl: '', note: '' },
                             existingId || undefined);
      input.value = '';
      await refresh();
      out.textContent = '저장했습니다.';
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  test.addEventListener('click', async () => {
    test.disabled = true;
    out.textContent = '확인 중…';
    try {
      const st = await state.studio.status();
      out.textContent = st.configured && st.account
        ? `연결됨 — Anlas ${st.account.anlas}, tier ${st.account.tier}`
        : (st.error || st.note || '토큰이 없습니다.');
    } catch (e) {
      out.textContent = msg(e);
    } finally { test.disabled = false; }
  });

  const root = el('div', { class: 'card' }, [
    el('h2', { text: 'NovelAI' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text:
      '에셋 스튜디오가 이미지를 생성할 때 씁니다. NovelAI 계정 설정의 퍼시스턴트 토큰을 넣으세요. '
      + '토큰 없이도 스튜디오에서 이미지를 넣고, 고르고, 봇에 반영하는 것은 됩니다.' }),
    meters,
    el('label', { class: 'field' }, [el('span', { text: '퍼시스턴트 토큰' }), input]),
    el('div', { class: 'row' }, [save, test]),
    out,
  ]);
  return { root, refresh };
}

/**
 * API 키 - credentials kept apart from presets. A preset points at one of
 * these (or carries its own); rotating a key happens here, once.
 */
function buildKeysCard(): HTMLElement {
  const listMount = el('div');
  const out = el('div', { class: 'outbox' });
  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };
  let keepSentinel = '__keep__';

  // Add and edit open a focused modal; the card itself stays a list.
  const openForm = (existing: ApiKeyEntry | null): void => {
    let close = (): void => { /* set below */ };
    const box = form(existing, () => close());
    close = modal(existing ? 'API 키 수정' : 'API 키 추가', box, { sticky: true });
  };
  const form = (existing: ApiKeyEntry | null, onClose: () => void): HTMLElement => {
    // Four fields: name, provider, key, note. The endpoint comes from the
    // provider (models.dev, or a pinned list) - a custom gateway is the one
    // case that needs the URL, behind 직접 지정.
    const name = el('input', { value: existing?.name ?? '', placeholder: '이름 (확인용, 예: 내 Gemini 키)' }) as HTMLInputElement;
    const provider = el('input', { value: existing?.provider ?? '', placeholder: '프로바이더 (예: google, openai, openrouter, vercel)', list: 'hina-providers' }) as HTMLInputElement;
    const providerList = el('datalist', { id: 'hina-providers' }, ['google', 'openai', 'anthropic', 'openrouter', 'vercel', 'groq', 'deepseek', 'xai', 'mistral', 'ollama']
      .map((p) => el('option', { value: p })));
    // What the chosen provider expects - its URL, how the key travels, its
    // quirks - from the backend's profile table, so the form says it before
    // the first failed request does.
    const provNote = el('div', { class: 'notice', style: { marginTop: '-4px', marginBottom: '10px', display: 'none' } });
    let profiles: ProviderProfile[] = [];
    const syncProv = () => {
      const want = provider.value.trim().toLowerCase();
      const p = want ? profiles.find((x) => x.id === want || x.name.toLowerCase() === want
        || x.hosts.some((h) => want.includes(h))) : null;
      clear(provNote);
      provNote.style.display = p ? '' : 'none';
      if (!p) return;
      provNote.appendChild(el('div', {}, [el('b', { text: p.name })]));
      provNote.appendChild(el('div', { class: 'hint', text: p.api ? 'API 주소: ' + p.api : 'API 주소: 프로젝트마다 다릅니다 — 아래 Base URL 직접 지정' }));
      provNote.appendChild(el('div', { class: 'hint', text: '인증: ' + p.auth }));
      if (p.modelExample) provNote.appendChild(el('div', { class: 'hint', text: '모델 이름 예: ' + p.modelExample }));
      if (p.note) provNote.appendChild(el('div', { class: 'hint', text: p.note }));
      if (p.docs) provNote.appendChild(el('a', { href: p.docs, target: '_blank', rel: 'noopener', class: 'hint', text: '문서 ↗' }));
      if (!p.api) urlRow.style.display = '';
    };
    provider.addEventListener('input', syncProv);
    void state.providers().then((list) => {
      profiles = list;
      clear(providerList);
      for (const p of list) providerList.appendChild(el('option', { value: p.id, text: p.name }));
      syncProv();
    }).catch(() => { /* the static list above stays */ });
    const apiKey = el('input', { type: 'password', placeholder: existing?.apiKey?.set ? `설정됨 (${existing.apiKey.length}자) — 바꿀 때만 입력` : 'API 키' }) as HTMLInputElement;
    const note = el('input', { value: existing?.note ?? '', placeholder: '메모 (선택)' }) as HTMLInputElement;
    const baseUrl = el('input', { value: existing?.baseUrl ?? '', placeholder: 'Base URL (프로바이더 이름으로 못 찾을 때만 · 예: https://generativelanguage.googleapis.com/v1beta/openai)' }) as HTMLInputElement;
    const urlRow = el('label', { class: 'field', style: { display: existing?.baseUrl ? '' : 'none' } }, [el('span', { text: 'Base URL 직접 지정' }), baseUrl]);
    const urlToggle = el('button', { class: 'ghost tiny', text: 'Base URL 직접 지정' });
    urlToggle.addEventListener('click', () => { urlRow.style.display = urlRow.style.display === 'none' ? '' : 'none'; });
    const save = el('button', { class: 'primary tiny', text: existing ? '저장' : '추가' }) as HTMLButtonElement;
    const cancel = el('button', { class: 'ghost tiny', text: '취소' });
    const box = el('div', { class: 'keyform' }, [
      el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
      el('label', { class: 'field' }, [el('span', { text: '프로바이더' }), provider, providerList]),
      el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '10px' }, text: '이름을 고르면 주소를 압니다. 주소가 따로 있으면 아래 직접 지정.' }),
      provNote,
      el('label', { class: 'field' }, [el('span', { text: 'API 키' }), apiKey]),
      el('label', { class: 'field' }, [el('span', { text: '메모' }), note]),
      urlRow,
      el('div', { class: 'row' }, [save, cancel, urlToggle]),
    ]);
    cancel.addEventListener('click', () => { onClose(); });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await state.saveApiKey({
          name: name.value, provider: provider.value, baseUrl: baseUrl.value, note: note.value,
          apiKey: apiKey.value ? apiKey.value : (existing ? keepSentinel : ''),
        }, existing?.id);
        say(existing ? '키를 저장했습니다. 이 키를 쓰는 프리셋에 바로 적용됩니다.' : '키를 추가했습니다. 에이전트 탭의 프리셋에서 고를 수 있습니다.', 'ok');
        onClose();
        await draw();
      } catch (e) {
        say(e instanceof Error ? e.message : String(e), 'err');
      } finally {
        save.disabled = false;
      }
    });
    return box;
  };

  const draw = async (): Promise<void> => {
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.apiKeys();
      keepSentinel = r.keepSentinel || keepSentinel;
      clear(listMount);
      if (!r.keys.length) listMount.appendChild(el('div', { class: 'hint', text: '저장된 키가 없습니다.' }));
      for (const k of r.keys) {
        const edit = el('button', { class: 'ghost tiny', text: '수정' });
        const del = el('button', { class: 'ghost tiny' });
        const row = el('div', { class: 'verrow keyrow' }, [
          el('div', { class: 'grow' }, [
            el('div', {}, [
              el('span', { text: k.name }),
              k.provider ? el('span', { class: 'badge', style: { marginLeft: '6px' }, text: k.provider }) : null,
              !k.apiKey.set ? el('span', { class: 'badge warn', style: { marginLeft: '6px' }, text: '키 없음' }) : null,
            ]),
            el('div', { class: 'hint', text: [k.baseUrl || '(URL 없음)', k.apiKey.set ? `키 ${k.apiKey.length}자` : '', k.note].filter(Boolean).join(' · ') }),
          ]),
          edit, del,
        ]);
        edit.addEventListener('click', () => { openForm(k); });
        armed(del, '삭제', '정말?', async () => {
          try { await state.deleteApiKey(k.id); await draw(); } catch (e) { say(e instanceof Error ? e.message : String(e), 'err'); }
        });
        listMount.appendChild(row);
      }
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
    }
  };
  const add = el('button', { class: 'primary', text: '키 추가' });
  add.addEventListener('click', () => { openForm(null); });
  refreshers.push(draw);
  void draw();

  // The OpenAI subscription is a credential too, so its login lives here;
  // a preset then picks it the way it picks a key. Present only when the
  // backend offers that path at all (its operator turns it on).
  const offered = transport.health?.codexEnabled === true;
  const nai = buildNaiCard();
  refreshers.push(nai.refresh);
  void nai.refresh();

  const codex = buildCodexBox(null, true);
  codex.root.style.display = '';
  if (offered) {
    refreshers.push(codex.refresh);
    void codex.refresh();
  }

  return el('div', {}, [
    el('div', { class: 'card' }, [
      el('h2', { text: 'API 키' }),
      el('div', { class: 'hint', style: { marginBottom: '8px' }, text:
        '프로바이더·게이트웨이의 키를 한 곳에 둡니다. 에이전트 프리셋은 여기 키를 고르거나 직접 입력할 수 있고, 키를 바꾸면 그 키를 쓰는 프리셋 전부에 바로 적용됩니다. 키는 백엔드 data/ 에만 저장되며 화면에는 길이만 보입니다.' }),
      listMount,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [add]),
      out,
    ]),
    // NovelAI below the general keys: exactly one is ever in play, and what
    // belongs beside it is the balance, not a key length in a list.
    nai.root,
    offered ? codex.root : null,
  ]);
}

/**
 * 모델 카탈로그 - models.dev through the backend's daily cache. Which base
 * URL a provider uses and what its models are called, searchable, so a
 * preset does not start from a guess.
 */
function buildCatalogCard(): HTMLElement {
  const input = el('input', { placeholder: '프로바이더나 모델 이름 (예: gemini, anthropic, deepseek)' }) as HTMLInputElement;
  const out = el('div', { class: 'outbox' });
  const meta = el('div', { class: 'hint' });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (refresh = false) => {
    const q = input.value.trim();
    clear(out);
    if (q.length < 2 && !refresh) { meta.textContent = ''; return; }
    out.appendChild(el('div', { class: 'hint', text: '찾는 중…' }));
    try {
      const r = await state.modelCatalog(q, '', refresh);
      clear(out);
      meta.textContent = `models.dev · 프로바이더 ${r.totalProviders}개` + (r.cachedAt ? ` · 갱신 ${new Date(r.cachedAt * 1000).toLocaleString()}` : '') + (r.stale ? ' · 오래됨' : '');
      if (r.providers.length) {
        out.appendChild(el('div', { class: 'sectiontitle', text: `프로바이더 ${r.providers.length}` }));
        for (const p of r.providers.slice(0, 20)) {
          out.appendChild(el('div', { class: 'verrow' }, [
            el('div', { class: 'grow' }, [
              el('div', { text: `${p.name} (${p.id}) · 모델 ${p.models}개` }),
              el('div', { class: 'hint mono', text: p.api || '(OpenAI 호환 URL 미기재)' }),
              p.doc ? el('div', { class: 'hint', text: p.doc }) : null,
            ]),
          ]));
        }
      }
      if (r.models.length) {
        out.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '8px' }, text: `모델 ${r.models.length}${r.truncated ? '+' : ''}` }));
        const rows = r.models.map((m) =>
          `${m.provider.padEnd(14)} ${m.id.padEnd(40)} ${m.context ? Math.round(m.context / 1000) + 'k' : '-'}`.padEnd(62)
          + ` ${m.costIn != null ? '$' + m.costIn + '/' + m.costOut : '-'}${m.reasoning ? ' · reasoning' : ''}${m.toolCall ? ' · tools' : ''}`);
        out.appendChild(el('pre', { class: 'mono', style: { maxHeight: '360px' }, text: rows.join('\n') }));
      }
      if (!r.providers.length && !r.models.length) out.appendChild(el('div', { class: 'hint', text: '없습니다.' }));
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
    }
  };
  input.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(), 300); });
  const refreshBtn = el('button', { class: 'ghost tiny', text: '지금 갱신' });
  refreshBtn.addEventListener('click', () => void run(true));
  return el('div', { class: 'card' }, [
    el('h2', { text: '모델 카탈로그' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text:
      '주요 프로바이더의 API 주소와 모델 이름·컨텍스트·가격을 models.dev 에서 찾습니다(백엔드가 하루 한 번 받아 둠). 프리셋 편집기의 “카탈로그에서 찾기”도 같은 자료입니다.' }),
    el('div', { class: 'row' }, [input, refreshBtn]),
    meta,
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
