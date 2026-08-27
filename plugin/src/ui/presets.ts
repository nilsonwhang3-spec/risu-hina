/**
 * The agents' configuration, as two selected presets.
 *
 * Two sections, one per kind. 일반 is the editing agent - tools, scripts,
 * proposals - and always has exactly one preset selected. 검색 is the
 * research agent the general one hands questions to (web_research); it may
 * have none, in which case the general agent searches on its own with the
 * raw web_search tool as before. Splitting them lets a cheap, grounded model
 * do the searching while the capable one does the editing.
 *
 * A preset carries its own base URL and key, or points at an entry on the
 * API 키 page (keyRef) - the one place a rotated key has to be typed.
 *
 * The list and the editor are modals rather than inline sections because
 * both are whole tasks. An editor with a dozen fields unfolding inside a
 * settings page pushes everything else off screen.
 */
import { el, clear, armed, modal, setSelected, selectedValue, popover } from './dom';
import { state, type AgentPreset, type ApiKeyEntry, type CatalogModel, type ProviderProfile } from '../state';

type Kind = 'general' | 'search';

const KIND_LABEL: Record<Kind, string> = { general: '일반 에이전트', search: '검색 에이전트' };

const REASONING_LABEL: Record<string, string> = {
  '': '보내지 않음',
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

export interface PresetsCardOptions {
  /** Called whenever a selected preset changes, so dependent UI can refresh. */
  onChanged: () => void | Promise<void>;
  /** Hands the card's reload to the settings page, which calls it when the connection comes up. */
  onMount?: (refresh: () => Promise<void>) => void;
}

/** The key-select value that means "the OpenAI subscription" (provider codex). */
const CODEX_KEY = '__codex__';

export function buildPresetsCard(opts: PresetsCardOptions): HTMLElement {
  const generalMount = el('div');
  const searchMount = el('div');
  const out = el('div');
  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const refresh = async (): Promise<void> => {
    clear(generalMount);
    clear(searchMount);
    generalMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.presets();
      clear(generalMount);
      clear(searchMount);
      const general = r.presets.filter((p) => p.kind === 'general');
      const search = r.presets.filter((p) => p.kind === 'search');
      generalMount.appendChild(currentRow('general', r.selected, general.length));
      searchMount.appendChild(currentRow('search', r.selectedSearch, search.length));
    } catch (e) {
      clear(generalMount);
      generalMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
    await opts.onChanged();
  };

  const currentRow = (kind: Kind, p: AgentPreset | null, total: number): HTMLElement => {
    const pick = el('button', { class: 'ghost', text: `선택 (${total})`, title: '저장된 프리셋 목록' });
    pick.addEventListener('click', () => openPicker(kind, refresh, say));
    if (!p) {
      // Same shape as the filled row: the chevron opens the list (which has
      // 추가 at the bottom), so both agents are picked the same way.
      const open = el('button', { class: 'ghost chev', text: '›', title: total ? `저장된 프리셋 ${total}개 — 선택 · 추가` : '프리셋 추가' });
      open.addEventListener('click', () => openPicker(kind, refresh, say));
      void pick;
      return el('div', { class: 'presetnow' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'hint', text: kind === 'search'
            ? '검색 에이전트가 없습니다 — 일반 에이전트가 직접 web_search 로 검색합니다. › 에서 고르거나 추가합니다.'
            : '프리셋이 없습니다. › 에서 하나 만들어 주세요.' }),
        ]),
        open,
      ]);
    }
    // One chevron: the list behind it is where 수정 and 삭제 live, next to
    // 추가. The current row only says what is running.
    const open = el('button', { class: 'ghost chev', text: '›', title: `저장된 프리셋 ${total}개 — 선택 · 수정 · 삭제 · 추가` });
    open.addEventListener('click', () => openPicker(kind, refresh, say));
    void pick;
    const row = el('div', { class: 'presetnow' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'presetnow-name' }, [
          el('span', { text: p.name }),
          !p.apiKey?.set && !p.keyRef && p.provider !== 'codex'
            ? el('span', { class: 'badge warn', style: { marginLeft: '6px' }, text: '키 없음' })
            : null,
        ]),
        el('div', { class: 'hint', text: summarise(p) }),
      ]),
      open,
    ]);
    if (kind === 'search') {
      const off = el('button', { class: 'ghost tiny', text: '해제', title: '검색 에이전트를 끄고 일반 에이전트가 직접 검색하게 합니다' });
      off.addEventListener('click', async () => {
        try { await state.deselectPreset('search'); await refresh(); say('검색 에이전트를 껐습니다.', 'ok'); } catch (e) { say(msg(e), 'err'); }
      });
      row.appendChild(off);
    }
    return row;
  };

  // The same probe for both agents: plain answer, then a forced tool call.
  const testButton = (kind: Kind, box: HTMLElement): HTMLElement => {
    const testBtn = el('button', { class: 'ghost', text: '연결 테스트' });
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      clear(box);
      box.appendChild(el('div', { class: 'hint', text: '테스트 중입니다… (최대 2분)' }));
      try {
        const r = await state.testAgent(kind) as Record<string, any>;
        clear(box);
        if (r.ok) {
          const u = r.usage ?? {};
          box.appendChild(el('div', { class: 'notice ok' }, [
            el('div', { text: `정상 동작합니다 · ${r.model}` }),
            el('div', { class: 'hint', text: `툴 호출 ${r.toolCalls}건 · 토큰 in ${u.in} / out ${u.out}` }),
          ]));
        } else {
          box.appendChild(el('div', { class: 'notice err' }, [
            el('div', { text: `실패했습니다 (${r.stage})` }),
            el('div', { class: 'hint', text: String(r.error ?? '') }),
          ]));
        }
      } catch (e) {
        clear(box);
        box.appendChild(el('div', { class: 'notice err', text: msg(e) }));
      } finally {
        testBtn.disabled = false;
      }
    });
    return testBtn;
  };
  const searchOut = el('div', { class: 'outbox' });

  opts.onMount?.(refresh);
  void refresh();
  return el('div', {}, [
    el('div', { class: 'card' }, [
      el('h2', { text: '일반 에이전트' }),
      el('div', { class: 'hint', style: { marginBottom: '8px' }, text: '챗·카드를 읽고 고치는 에이전트입니다. 툴과 파이썬 스크립트를 씁니다. 항상 하나가 선택되어 있습니다.' }),
      generalMount,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [testButton('general', out)]),
      out,
      el('div', { class: 'hint', style: { marginTop: '8px' } }, [
        '테스트는 일반 응답과 툴 호출을 따로 확인합니다. 툴 호출이 안 되면 에이전트가 동작할 수 없습니다.',
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: '검색 에이전트' }),
      el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
        '일반 에이전트가 조사를 맡기는 보조 에이전트(웹 검색만). 저렴한 검색형 모델(예: Gemini Flash)을 권합니다. 없으면 일반 에이전트가 직접 검색합니다.',
      ]),
      searchMount,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [testButton('search', searchOut)]),
      searchOut,
    ]),
  ]);
}

function summarise(p: AgentPreset): string {
  const bits = [p.model || '모델 미설정'];
  if (p.provider === 'codex') bits.push('OpenAI 구독');
  else if (p.keyRef) bits.push('API 키 탭의 키');
  if (p.reasoning) bits.push('reasoning ' + p.reasoning);
  if (p.cache) bits.push('캐시');
  if (p.flex) bits.push('Flex');
  bits.push(`${p.maxTokens.toLocaleString()} 토큰`);
  if (p.params) bits.push('파라미터 JSON');
  if (p.instructions) bits.push('기본지침 있음');
  return bits.join(' · ');
}

// --- the picker ---------------------------------------------------------------

function openPicker(kind: Kind, refresh: () => Promise<void>, say: (t: string, k?: 'ok' | 'err' | '') => void): void {
  const listMount = el('div');
  const body = el('div', {}, [
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '선택하면 바로 적용됩니다.',
    ]),
    listMount,
  ]);
  const close = modal(`${KIND_LABEL[kind]} 프리셋 선택`, body);

  const draw = async () => {
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.presets();
      const mine = r.presets.filter((p) => p.kind === kind);
      clear(listMount);
      for (const p of mine) listMount.appendChild(row(p, mine.length));
      const add = el('button', { class: 'primary', text: '새 프리셋 추가', style: { marginTop: '10px' } });
      add.addEventListener('click', () => {
        close();
        openEditor(kind, null, refresh, say);
      });
      listMount.appendChild(add);
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  };

  const row = (p: AgentPreset, total: number): HTMLElement => {
    const pickArea = el('div', { class: 'grow' }, [
      el('div', { class: 'pickname' }, [
        el('span', { text: p.name }),
        p.selected ? el('span', { class: 'badge ok', text: '사용 중' }) : null,
        !p.apiKey?.set && !p.keyRef && p.provider !== 'codex' ? el('span', { class: 'badge warn', text: '키 없음' }) : null,
      ]),
      el('div', { class: 'hint', text: summarise(p) }),
    ]);
    // An explicit 선택, not a click on the row: the row also carries 수정
    // and 삭제, and a choice that changes what the agent runs should be a
    // button that says so.
    const select = el('button', { class: 'primary tiny', text: p.selected ? '사용 중' : '선택' }) as HTMLButtonElement;
    select.disabled = !!p.selected;
    select.addEventListener('click', async () => {
      try {
        await state.selectPreset(p.id);
        await refresh();
        close();
        say(`“${p.name}” 을(를) 쓰기 시작했습니다.`, 'ok');
      } catch (e) {
        say(msg(e), 'err');
      }
    });
    const edit = el('button', { class: 'ghost tiny', text: '수정' });
    edit.addEventListener('click', () => {
      close();
      openEditor(kind, p.id, refresh, say);
    });
    const del = el('button', { class: 'ghost tiny' });
    armed(del, '삭제', '한 번 더', async () => {
      try {
        await state.deletePreset(p.id);
        await draw();
        await refresh();
      } catch (e) {
        // The backend refuses to delete the last general one; that is a rule
        // worth stating in place rather than as a silent no-op.
        clear(listMount);
        listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
        setTimeout(() => void draw(), 2500);
      }
    });
    if (kind === 'general' && total <= 1) del.style.display = 'none';
    return el('div', { class: 'pickrow' + (p.selected ? ' on' : '') }, [pickArea, select, edit, del]);
  };

  void draw();
}

// --- the editor ---------------------------------------------------------------

/**
 * One form for both 추가 and 수정, and for both kinds - the kind is fixed by
 * the section the form was opened from. The API key is either typed here or
 * taken from the API 키 page.
 */
function openEditor(
  kind: Kind,
  id: string | null,
  refresh: () => Promise<void>,
  say: (t: string, k?: 'ok' | 'err' | '') => void,
): void {
  const name = el('input', { placeholder: kind === 'search' ? '프리셋 이름 (예: Gemini 검색)' : '프리셋 이름 (예: 정밀 · 저렴이)' });
  // What the agent calls itself - in its instructions and the panel.
  const agentName = el('input', { placeholder: '히나' }) as HTMLInputElement;
  const baseUrl = el('input', { placeholder: kind === 'search' ? 'https://generativelanguage.googleapis.com/v1beta/openai' : 'https://ai-gateway.vercel.sh/v1' });
  const model = el('input', { placeholder: kind === 'search' ? 'gemini-2.5-flash' : 'google/gemini-3.7-flash' });
  const keySel = el('select') as HTMLSelectElement;
  const apiKey = el('input', { type: 'password', placeholder: '(변경할 때만 입력)' });
  const keyNote = el('span', { class: 'hint' });
  const ownKeyRow = el('label', { class: 'field' }, [el('span', { text: 'API Key (직접 입력)' }), apiKey, keyNote]);
  const maxTokens = el('input', { placeholder: kind === 'search' ? '16000' : '32000' });
  // Blank = not sent. OpenAI's reasoning models refuse any value but their
  // default, and every provider has a sensible one of its own.
  const temperature = el('input', { placeholder: '(비움 = 보내지 않음)' });
  const reasoning = reasoningSelect();
  // Request parameters as JSON, real field names, null = do not send. The
  // last word over the boxes above and over the provider profile.
  const params = el('textarea', {
    placeholder: '{"reasoning_effort": "medium", "temperature": null}',
    style: { minHeight: '64px', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '12px' },
  }) as HTMLTextAreaElement;
  const paramsNote = el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '10px' } });
  const provBox = el('div', { class: 'notice', style: { marginBottom: '10px', display: 'none' } });
  let providers: ProviderProfile[] = [];
  const cache = el('input', { type: 'checkbox' });
  const flex = el('input', { type: 'checkbox' });
  const instructions = el('textarea', {
    placeholder: kind === 'search'
      ? '검색 에이전트가 지킬 지침 (예: 한국어 자료 우선, 출처 3개 이상). 비워 두셔도 됩니다.'
      : '에이전트가 항상 지킬 지침을 적어 주세요. 비워 두셔도 됩니다.',
    style: { minHeight: '110px' },
  });
  const instCount = el('div', { class: 'hint' });
  const out = el('div');
  let keepSentinel = '__keep__';
  let keys: ApiKeyEntry[] = [];

  // Where the credential comes from: a key from the API 키 page, this
  // preset's own, or the OpenAI subscription (also set up on the API 키
  // page) - one select, because to the user they are the same question.
  const keyRow = el('label', { class: 'field' }, [el('span', { text: 'API 키' }), keySel]);
  const keyHint = el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '10px' } }, [
    'API 키/인증 탭의 키를 고르거나 직접 입력합니다. 키를 고르면 주소도 따라옵니다.',
  ]);
  const urlRow = el('label', { class: 'field' }, [el('span', { text: 'Base URL' }), baseUrl]);
  const codexBox = buildCodexBox(model, false);
  const isCodex = () => selectedValue(keySel) === CODEX_KEY;

  const syncCount = () => { instCount.textContent = `${instructions.value.length}자`; };
  instructions.addEventListener('input', syncCount);
  syncCount();
  const syncKeyRow = () => {
    const codex = isCodex();
    const fromKeyPage = !codex && !!selectedValue(keySel);
    // A key from the key page carries its endpoint; only 직접 입력 shows URL and key.
    urlRow.style.display = codex || fromKeyPage ? 'none' : '';
    ownKeyRow.style.display = codex || fromKeyPage ? 'none' : '';
    codexBox.root.style.display = codex ? '' : 'none';
    if (codex) void codexBox.refresh();
  };
  keySel.addEventListener('change', syncKeyRow);

  // Which provider this preset will talk to, from the chosen key's provider
  // or URL, or the URL typed here - and what that provider wants to hear.
  const profileFor = (): ProviderProfile | null => {
    if (isCodex()) return null;
    const k = keys.find((x) => x.id === selectedValue(keySel));
    const url = (baseUrl.value || k?.baseUrl || '').toLowerCase().replace(/^https?:\/\//, '');
    const byUrl = url ? providers.find((p) => p.hosts.some((h) => url.includes(h))) : null;
    if (byUrl) return byUrl;
    const pv = (k?.provider || '').trim().toLowerCase();
    return pv ? providers.find((p) => p.id === pv || p.name.toLowerCase() === pv) ?? null : null;
  };
  const syncProvider = () => {
    const p = profileFor();
    clear(provBox);
    provBox.style.display = p ? '' : 'none';
    if (!p) return;
    const fill = el('button', { class: 'ghost tiny', text: '예시 JSON 채우기' });
    fill.addEventListener('click', () => {
      // Merge over what is there rather than replace: a null the user added
      // to silence a field must not come back.
      let cur: Record<string, unknown> = {};
      try { cur = params.value.trim() ? JSON.parse(params.value) : {}; } catch { cur = {}; }
      params.value = JSON.stringify({ ...p.template, ...cur }, null, 1).replace(/\n\s*/g, ' ');
    });
    provBox.appendChild(el('div', {}, [
      el('b', { text: p.name }),
      el('span', { class: 'dim', text: ` · ${p.endpoint === 'responses' ? 'Responses API' : 'Chat Completions'} · 출력 상한 ${p.capField}` }),
    ]));
    if (p.note) provBox.appendChild(el('div', { class: 'hint', text: p.note }));
    for (const n of p.modelNotes) provBox.appendChild(el('div', { class: 'hint', text: '· ' + n }));
    if (p.unsupported.length) provBox.appendChild(el('div', { class: 'hint', text: '보내지 않는 필드: ' + p.unsupported.join(', ') }));
    if (p.modelExample) provBox.appendChild(el('div', { class: 'hint', text: '모델 이름 예: ' + p.modelExample }));
    const row = el('div', { class: 'row', style: { marginTop: '4px' } }, [
      Object.keys(p.template).length ? fill : null,
      p.docs ? el('a', { href: p.docs, target: '_blank', rel: 'noopener', class: 'hint', text: '문서 ↗' }) : null,
    ]);
    provBox.appendChild(row);
  };
  keySel.addEventListener('change', syncProvider);
  baseUrl.addEventListener('input', syncProvider);
  model.addEventListener('input', syncProvider);

  const catalogBtn = el('button', { class: 'ghost tiny', text: '카탈로그에서 찾기', title: 'models.dev 에서 프로바이더·모델을 찾아 채웁니다' });
  catalogBtn.addEventListener('click', () => openCatalogPicker(catalogBtn, (m, api) => {
    model.value = m.id;
    if (api && !baseUrl.value) baseUrl.value = api;
  }));

  const load = async () => {
    try {
      const r = await state.presets();
      keepSentinel = r.keepSentinel || keepSentinel;
      keys = r.keys ?? [];
      providers = r.providers ?? [];
      paramsNote.textContent = `요청 필드 이름 그대로, null 은 "보내지 않음". 위 칸들보다 우선합니다. 오류 메시지가 알려주는 JSON 을 여기에 붙입니다. (${r.maxParams ?? 4000}자까지)`;
      clear(keySel);
      keySel.appendChild(el('option', { value: '', text: '직접 입력' }));
      for (const k of keys) keySel.appendChild(el('option', { value: k.id, text: `${k.name}${k.provider ? ' · ' + k.provider : ''}` }));
      keySel.appendChild(el('option', { value: CODEX_KEY, text: 'OpenAI 구독 (ChatGPT Plus/Pro · Codex)' }));
      const p = id ? r.presets.find((x) => x.id === id) : null;
      if (!p) {
        // A new preset starts as the kind's default persona; the text is
        // editable and replaces the default, never appends to it.
        agentName.value = r.defaultAgentName || '히나';
        instructions.value = r.defaultInstructions?.[kind] || '';
        syncCount();
        keyNote.textContent = '설정되지 않음';
        syncKeyRow();
        syncProvider();
        return;
      }
      agentName.value = p.agentName || r.defaultAgentName || '히나';
      name.value = p.name;
      baseUrl.value = p.baseUrl;
      model.value = p.model;
      maxTokens.value = String(p.maxTokens);
      temperature.value = p.temperature === null || p.temperature === undefined ? '' : String(p.temperature);
      params.value = p.params || '';
      setSelected(reasoning, p.reasoning || '');
      setSelected(keySel, p.provider === 'codex' ? CODEX_KEY : (p.keyRef || ''));
      cache.checked = p.cache;
      flex.checked = p.flex;
      instructions.value = p.instructions || '';
      syncCount();
      syncKeyRow();
      syncProvider();
      keyNote.textContent = p.apiKey?.set
        ? `설정됨 (${p.apiKey.length}자) — 바꾸려면 새로 입력`
        : '설정되지 않음';
    } catch (e) {
      keyNote.textContent = msg(e);
    }
  };

  const save = el('button', { class: 'primary', text: '저장' });
  const cancel = el('button', { class: 'ghost', text: '취소' });
  const body = el('div', {}, [
    el('label', { class: 'field' }, [el('span', { text: '프리셋 이름' }), name]),
    kind === 'general' ? el('label', { class: 'field' }, [el('span', { text: '에이전트 이름 (대화에서 부르는 이름)' }), agentName]) : null,
    keyRow,
    keyHint,
    codexBox.root,
    ownKeyRow,
    urlRow,
    el('label', { class: 'field' }, [
      el('span', {}, [el('span', { text: 'Model ' }), catalogBtn]), model,
    ]),
    kind === 'search'
      ? el('div', { class: 'notice', style: { marginBottom: '10px' }, text:
        '검색 에이전트에는 검색에 강하고 저렴한 모델을 권합니다 — Google Gemini(예: gemini-2.5-flash, OpenAI 호환 엔드포인트 …/v1beta/openai). 웹 검색 프로바이더는 연결 탭에서 설정합니다.' })
      : null,
    el('div', { class: 'row' }, [
      el('label', { class: 'field grow' }, [el('span', { text: '최대 출력 토큰' }), maxTokens]),
      el('label', { class: 'field grow' }, [el('span', { text: 'temperature' }), temperature]),
    ]),
    el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '10px' } }, [
      '사고 모델은 생각한 토큰도 출력에 포함됩니다 — 32000 이상 권장. temperature 는 비우면 보내지 않습니다.',
    ]),
    el('label', { class: 'field' }, [el('span', { text: 'Reasoning' }), reasoning]),
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'checkrow', title: '같은 지시문·툴 정의를 다시 보낼 때 캐시를 태웁니다' },
         [cache, el('span', { text: '프롬프트 캐시' })]),
      el('label', { class: 'checkrow', title: '싸지만 느립니다. 대기가 길어질 수 있습니다' },
         [flex, el('span', { text: 'Flex 티어' })]),
    ]),
    el('div', { class: 'hint', style: { marginBottom: '12px' } }, [
      '프로바이더에 따라 지원이 다릅니다. 오류가 나면 먼저 꺼 보세요.',
    ]),
    provBox,
    el('label', { class: 'field' }, [el('span', { text: '파라미터 JSON (선택)' }), params]),
    paramsNote,
    el('label', { class: 'field' }, [
      el('span', { text: '기본지침' }), instructions, instCount,
    ]),
    el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '12px' } }, [
      '기본 규칙 뒤에 덧붙습니다. “전사에 직접 쓰지 않는다” 같은 안전 규칙은 여기서 뒤집을 수 없습니다.',
    ]),
    out,
    el('div', { class: 'row' }, [save, cancel]),
  ]);
  const close = modal(`${KIND_LABEL[kind]} — ${id ? '프리셋 수정' : '새 프리셋'}`, body, { wide: true, sticky: true });
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const saved = await state.savePreset(name.value, {
        kind,
        provider: isCodex() ? 'codex' : '',
        keyRef: isCodex() ? '' : selectedValue(keySel),
        baseUrl: baseUrl.value,
        model: model.value,
        // Leave the stored key alone unless a new one was typed.
        apiKey: apiKey.value ? apiKey.value : keepSentinel,
        maxTokens: maxTokens.value === '' ? undefined : Number(maxTokens.value),
        // '' is a value here: "do not send". undefined would keep the old one.
        temperature: temperature.value.trim() === '' ? '' : Number(temperature.value),
        params: params.value.trim(),
        reasoning: selectedValue(reasoning),
        cache: cache.checked,
        flex: flex.checked,
        instructions: instructions.value,
        agentName: agentName.value.trim() || undefined,
      }, id ?? undefined);
      close();
      await refresh();
      say(saved.selected ? '저장했습니다.' : `“${saved.name}” 을(를) 저장했습니다. 쓰려면 아래에서 선택하세요.`, 'ok');
      // Back to the list, not to nothing: the next question after saving is
      // "which one runs now", and that is answered there.
      openPicker(kind, refresh, say);
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      save.disabled = false;
    }
  });

  void load();
}

/**
 * The OpenAI-subscription block of the editor: login state, the login
 * link, the paste fallback for a browser that is not on the backend's
 * machine (the redirect lands on localhost:1455 there and shows as an
 * unreachable page - its address is what gets pasted), and the model list
 * the codex backend is known to serve.
 */
export function buildCodexBox(modelInput: HTMLInputElement | null, withLogin: boolean): { root: HTMLElement; refresh: () => Promise<void> } {
  const line = el('div', { class: 'hint' });
  const out = el('div', { class: 'outbox' });
  const login = el('button', { class: 'primary tiny', text: 'OpenAI 로그인' }) as HTMLButtonElement;
  const logout = el('button', { class: 'ghost tiny', text: '로그아웃' }) as HTMLButtonElement;
  const paste = el('input', { placeholder: '로그인 뒤 이동한 주소를 여기에 붙여넣기 (http://localhost:1455/auth/callback?code=…)' }) as HTMLInputElement;
  const finish = el('button', { class: 'ghost tiny', text: '붙여넣은 주소로 완료' }) as HTMLButtonElement;
  const pasteRow = el('div', { class: 'row' }, [paste, finish]);
  pasteRow.style.display = 'none';
  const models = el('div', { class: 'row' });
  let pendingState = '';
  let poll: ReturnType<typeof setInterval> | null = null;

  const stopPoll = () => { if (poll) { clearInterval(poll); poll = null; } };
  const refresh = async (): Promise<void> => {
    try {
      const s = await state.codexStatus();
      line.textContent = s.loggedIn
        ? `로그인됨 · ${s.email || s.accountId.slice(0, 8)}${s.plan ? ' · ' + s.plan : ''}`
        : '로그인되지 않았습니다. ChatGPT Plus/Pro 계정으로 로그인하면 구독으로 에이전트를 돌립니다.';
      login.style.display = s.loggedIn ? 'none' : '';
      logout.style.display = s.loggedIn ? '' : 'none';
      if (s.loggedIn) { pasteRow.style.display = 'none'; stopPoll(); }
      clear(models);
      if (modelInput) {
        for (const m of s.models) {
          const b = el('button', { class: 'ghost tiny', text: m });
          b.addEventListener('click', () => { modelInput.value = m; });
          models.appendChild(b);
        }
      }
    } catch (e) {
      line.textContent = msg(e);
    }
  };

  login.addEventListener('click', async () => {
    login.disabled = true;
    clear(out);
    try {
      const r = await state.codexLoginStart();
      pendingState = r.state;
      const a = el('a', { href: r.url, target: '_blank', rel: 'noopener', text: '브라우저에서 OpenAI 로그인 열기' });
      // The raw address too: this page usually runs on a phone or a browser
      // that is not the backend's, so the link gets copied, not clicked.
      const urlBox = el('input', { value: r.url, readonly: 'readonly', class: 'mono' }) as HTMLInputElement;
      urlBox.addEventListener('focus', () => { try { urlBox.select(); } catch { /* linkedom */ } });
      const copy = el('button', { class: 'ghost tiny', text: '복사' });
      copy.addEventListener('click', () => {
        try { urlBox.select(); document.execCommand('copy'); copy.textContent = '복사됨'; } catch { copy.textContent = '길게 눌러 복사'; }
      });
      out.appendChild(el('div', { class: 'notice' }, [
        el('div', {}, [a]),
        el('div', { class: 'row', style: { marginTop: '6px' } }, [urlBox, copy]),
        el('ol', { class: 'hint steps' }, [
          el('li', { text: '위 주소를 열어 ChatGPT 계정으로 로그인합니다 (다른 기기여도 됩니다).' }),
          el('li', { text: r.listening
            ? '백엔드와 같은 PC 의 브라우저면 자동으로 완료됩니다.'
            : '(포트 1455 가 사용 중이라 자동 완료는 안 됩니다.)' }),
          el('li', { text: '다른 기기면 마지막에 "연결할 수 없음" 페이지(localhost:1455/…)가 뜹니다 — 정상. 그 주소 전체를 아래에 붙여넣고 완료.' }),
        ]),
      ]));
      pasteRow.style.display = '';
      try { window.open(r.url, '_blank', 'noopener'); } catch { /* popup blocked: the link is there */ }
      stopPoll();
      poll = setInterval(async () => {
        try {
          const st = await state.codexLoginStatus(pendingState);
          if (st.done || st.loggedIn) { stopPoll(); clear(out); await refresh(); }
          else if (st.error) { stopPoll(); out.appendChild(el('div', { class: 'notice err', text: st.error })); }
        } catch { /* keep polling */ }
      }, 2000);
    } catch (e) {
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      login.disabled = false;
    }
  });
  finish.addEventListener('click', async () => {
    finish.disabled = true;
    try {
      await state.codexLoginComplete(paste.value.trim(), pendingState);
      clear(out);
      paste.value = '';
      await refresh();
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      finish.disabled = false;
    }
  });
  logout.addEventListener('click', async () => {
    try { await state.codexLogout(); await refresh(); } catch (e) { out.appendChild(el('div', { class: 'notice err', text: msg(e) })); }
  });

  // On the API 키 page: the full card with login. In the preset editor:
  // the state line and the model buttons, with a pointer to that page.
  const root = withLogin
    ? el('div', { class: 'card codexbox' }, [
      el('h2', { text: 'OpenAI 구독 (Codex)' }),
      el('div', { class: 'hint', style: { marginBottom: '6px' }, text:
        'Codex CLI 와 같은 방식으로 ChatGPT Plus/Pro 계정에 로그인해 chatgpt.com 의 codex 백엔드를 씁니다. 로그인해 두면 에이전트 프리셋의 API 키 선택에서 "OpenAI 구독" 을 고를 수 있습니다. 공식 API 가 아니라 OpenAI 쪽 변경에 깨질 수 있고, 그때는 오류를 그대로 보여 줍니다.' }),
      line,
      el('div', { class: 'row', style: { marginTop: '6px' } }, [login, logout]),
      pasteRow,
      out,
    ])
    : el('div', { class: 'codexbox', style: { marginBottom: '10px' } }, [
      el('div', { class: 'notice' }, [
        line,
        el('div', { class: 'hint', style: { marginTop: '4px' }, text: 'Base URL·API 키는 쓰지 않습니다. 로그인·로그아웃은 API 키 탭에서 합니다.' }),
      ]),
      el('div', { class: 'hint', text: '이 백엔드가 받는 모델 (누르면 채워집니다):' }),
      models,
    ]);
  root.style.display = 'none';
  return { root, refresh };
}

/**
 * models.dev, searched through the backend's cache: pick a model and the
 * form takes its id (and the provider's API base when the URL is empty).
 */
export function openCatalogPicker(anchor: HTMLElement, onPick: (m: CatalogModel, api: string) => void): void {
  const input = el('input', { placeholder: '프로바이더나 모델 이름 (예: gemini, anthropic, gpt-5)' }) as HTMLInputElement;
  const list = el('div', { class: 'cataloglist' });
  const body = el('div', { class: 'applypop catalogpop' }, [el('div', { class: 'row' }, [input]), list]);
  const close = popover(anchor, body);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    const q = input.value.trim();
    clear(list);
    if (q.length < 2) { list.appendChild(el('div', { class: 'hint', text: '두 글자 이상 입력하세요.' })); return; }
    list.appendChild(el('div', { class: 'hint', text: '찾는 중…' }));
    try {
      const r = await state.modelCatalog(q);
      clear(list);
      const apiOf = new Map(r.providers.map((p) => [p.id, p.api]));
      if (!r.models.length) list.appendChild(el('div', { class: 'hint', text: '없습니다.' }));
      for (const m of r.models.slice(0, 40)) {
        const b = el('button', { class: 'catrow' }, [
          el('span', { class: 'grow', text: `${m.id}` }),
          el('span', { class: 'hint', text: `${m.provider}${m.context ? ' · ' + Math.round(m.context / 1000) + 'k' : ''}${m.costIn != null ? ' · $' + m.costIn + '/' + m.costOut : ''}` }),
        ]);
        b.addEventListener('click', () => { onPick(m, apiOf.get(m.provider) || ''); close(); });
        list.appendChild(b);
      }
      if (r.truncated) list.appendChild(el('div', { class: 'hint', text: '더 있습니다 — 검색어를 좁혀 주세요.' }));
    } catch (e) {
      clear(list);
      list.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  };
  input.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void run(), 300); });
  setTimeout(() => input.focus(), 0);
}

/** The reasoning selector. */
export function reasoningSelect(): HTMLSelectElement {
  const sel = el('select');
  for (const [value, label] of Object.entries(REASONING_LABEL)) {
    sel.appendChild(el('option', { value, text: label }));
  }
  return sel;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
