/**
 * The agent's configuration: the selected general preset, and under it the
 * web search tool card (buildWebsearchCard - who searches: the model itself,
 * a Gemini helper, or a search API). The "search agent" preset kind that
 * used to sit between them is gone from the page; its rows stay in the DB.
 *
 * A preset carries its own base URL and key, or points at an entry on the
 * API 키 page (keyRef) - the one place a rotated key has to be typed.
 *
 * The list and the editor are modals rather than inline sections because
 * both are whole tasks. An editor with a dozen fields unfolding inside a
 * settings page pushes everything else off screen.
 */
import { el, clear, modal, setSelected, selectedValue, popover, pollWhileVisible } from './dom';
import { pickerRow, openListPicker, type PickerEntry } from './pickers';
import { state, type AgentPreset, type ApiKeyEntry, type CatalogModel, type ProviderProfile, type WebsearchMode, type WebsearchStatus, type VisionMode, type VisionStatus } from '../state';
import { transport } from '../transport';

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

/** Whether this backend offers that path; off unless its operator enabled it. */
function codexOffered(): boolean {
  return transport.health?.codexEnabled === true;
}

export function buildPresetsCard(opts: PresetsCardOptions): HTMLElement {
  const generalMount = el('div');
  const out = el('div');
  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const refresh = async (): Promise<void> => {
    clear(generalMount);
    generalMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.presets();
      clear(generalMount);
      const general = r.presets.filter((p) => p.kind === 'general');
      generalMount.appendChild(currentRow('general', r.selected, general.length));
    } catch (e) {
      clear(generalMount);
      generalMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
    await opts.onChanged();
  };

  // One chevron: the list behind it is where 선택, 수정 and 삭제 live, next
  // to 추가. The current row only says what is running.
  const currentRow = (kind: Kind, p: AgentPreset | null, total: number): HTMLElement => {
    const onOpen = () => openPicker(kind, refresh, say);
    if (!p) {
      return pickerRow(null, {
        title: total ? `저장된 프리셋 ${total}개 — 선택 · 추가` : '프리셋 추가',
        emptyHint: total ? '선택된 프리셋 없음 — › 에서 고르세요' : '프리셋이 없습니다. › 에서 하나 만들어 주세요.',
        onOpen,
      });
    }
    return pickerRow({ name: p.name, hint: summarise(p), badges: keyBadges(p) }, {
      title: `저장된 프리셋 ${total}개 — 선택 · 수정 · 삭제 · 추가`,
      emptyHint: '',
      onOpen,
    });
  };

  // The same probe for both agents: plain answer, then a forced tool call.
  const testButton = (kind: Kind, box: HTMLElement): HTMLElement => {
    const testBtn = el('button', { class: 'ghost', text: '연결 테스트' });
    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      clear(box);
      box.appendChild(el('div', { class: 'hint', text: '테스트 중입니다… (최대 4분)' }));
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
    buildWebsearchCard(),
    buildVisionCard(),
  ]);
}

/**
 * The web search tool: one card under the general agent, one choice.
 *
 *   1. the main agent's own search      (its endpoint has one - found by trying)
 *   2. a Gemini helper                   (Google AI Studio, Google Search grounding)
 *   3. an external search provider       (DuckDuckGo by default, keyed ones optional)
 *
 * The choice at the top swaps the fields under it; 저장 writes the section;
 * 테스트 runs one real search the way the agent's web_search tool would and
 * shows what came back. There used to be a "search agent" preset next to a
 * "search provider" card - a model and an engine that could not be tested
 * as one thing, and whose split nobody could explain in one sentence.
 */
/**
 * A settings card whose body folds behind its heading (§1-43): the web-search
 * and vision cards are long and rarely revisited, so they start folded and
 * remember the choice per card.
 */
function foldableCard(id: string, title: string, body: (HTMLElement | null)[]): HTMLElement {
  const key = 'hina.foldCard.' + id;
  let open = false;
  try { open = localStorage.getItem(key) === '1'; } catch { /* iframe */ }
  const caret = el('span', { class: 'foldcaret', text: open ? '▾' : '▸' });
  const head = el('h2', { class: 'foldhead', title: '접기/펼치기' }, [caret, el('span', { text: title })]);
  const box = el('div', { class: 'foldbody' }, body);
  box.style.display = open ? '' : 'none';
  head.addEventListener('click', () => {
    open = !open;
    box.style.display = open ? '' : 'none';
    caret.textContent = open ? '▾' : '▸';
    try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* fine */ }
  });
  return el('div', { class: 'card foldable' + (open ? '' : ' folded'), id }, [head, box]);
}

/** One 고급 설정 field: the number, what it does, and what leaving it blank means. */
interface AdvField { key: string; label: string; def: number; unit: string; help: string; zeroMeansOff?: boolean }

const ADV_FIELDS: AdvField[] = [
  { key: 'historyBudgetChars', label: '히스토리 예산', def: 120000, unit: '자',
    help: '대화 기록이 이 글자 수를 넘으면 앞부분을 요약하거나(요약 모델이 거절하면 통째로) 잘라냅니다. 요청마다 다시 보내는 기록의 상한이라, 요청당 토큰을 직접 정합니다. 12만 자 ≈ 5~7만 토큰.' },
  { key: 'pruneKeepTurns', label: '툴 결과 그대로 두는 턴 수', def: 2, unit: '턴',
    help: '최근 이 턴 수 안의 툴 결과(스크립트 출력·읽은 파일·생성 스펙)는 그대로 두고, 더 오래된 것은 아래 글자 수로 자릅니다. 자른 결과가 필요하면 히나가 툴을 다시 부릅니다.' },
  { key: 'pruneClipChars', label: '오래된 툴 결과 자르기', def: 600, unit: '자',
    help: '오래된 툴 결과 하나를 남길 길이. 100 아래로는 내려가지 않습니다.' },
  { key: 'maxRequestsPerTurn', label: '턴당 최대 모델 요청', def: 40, unit: '회', zeroMeansOff: true,
    help: '한 번의 대화 턴에서 모델을 부르는 횟수 상한. 툴을 한 번 쓸 때마다 한 번 더 부르고, 매번 기록 전체를 다시 보냅니다. 넘으면 턴이 멈추고 이유를 말합니다. 0 = 제한 없음.' },
  { key: 'maxToolCallsPerTurn', label: '턴당 최대 툴 호출', def: 30, unit: '회', zeroMeansOff: true,
    help: '한 턴에서 툴(스크립트·파일·생성·비전)을 부르는 횟수 상한. 0 = 제한 없음.' },
  { key: 'maxInputTokensPerTurn', label: '턴당 입력 토큰 상한', def: 0, unit: '토큰', zeroMeansOff: true,
    help: '한 턴에 보낸 입력 토큰의 합계가 이 값을 넘으면 멈춥니다. 비용을 직접 막는 안전장치. 0 = 제한 없음 (권장: 예상 최대치의 1.5배, 예 800000).' },
];

const FIXED_PROMPT_TOKENS = 15000;

function fmtN(n: number): string { return Math.round(n).toLocaleString(); }

/**
 * 고급 설정 (§1-47): the per-turn cost knobs, with the arithmetic behind
 * them shown live and the last turns' real numbers beside it. Folded by
 * default - the presets above are the everyday part.
 */
export function buildAdvancedCard(): HTMLElement {
  const inputs = new Map<string, HTMLInputElement>();
  const status = el('div', { class: 'hint' });
  const sim = el('div', { class: 'advsim' });
  const measured = el('div', { class: 'hint', style: { marginTop: '6px' } });
  let usage: Record<string, number> | null = null;

  const val = (f: AdvField): number => {
    const raw = (inputs.get(f.key)?.value ?? '').trim();
    if (raw === '') return f.def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : f.def;
  };

  const drawSim = () => {
    const budget = val(ADV_FIELDS[0]);
    const req = val(ADV_FIELDS[3]);
    const calls = val(ADV_FIELDS[4]);
    const capTok = val(ADV_FIELDS[5]);
    const histTok = budget / 2;
    const perReq = FIXED_PROMPT_TOKENS + histTok;
    const reqUsed = req > 0 ? req : 50;
    const worst = perReq * reqUsed;
    const typical = perReq * Math.min(reqUsed, usage?.avgRequests || 8);
    clear(sim);
    sim.append(
      el('div', { class: 'sectiontitle', text: '예상 시뮬레이션' }),
      el('div', { text: `요청 1회 ≈ 고정 프롬프트 ${fmtN(FIXED_PROMPT_TOKENS)} + 기록 ${fmtN(histTok)} = 약 ${fmtN(perReq)} 토큰` }),
      el('div', { text: `보통 턴 (요청 ${fmtN(Math.min(reqUsed, usage?.avgRequests || 8))}회) ≈ ${fmtN(typical)} 토큰` }),
      el('div', { text: `최악 턴 (요청 ${req > 0 ? fmtN(req) : '50(라이브러리 기본)'}회) ≈ ${fmtN(worst)} 토큰` + (calls > 0 ? ` · 툴 호출 ${fmtN(calls)}회에서도 멈춤` : '') }),
      el('div', { text: capTok > 0
        ? (capTok < typical ? `⚠ 입력 상한 ${fmtN(capTok)} 이 보통 턴보다 작습니다 - 대부분의 턴이 중간에 멈춥니다.` : `입력 상한 ${fmtN(capTok)}: 최악 턴의 ${fmtN(capTok / worst * 100)}% 지점에서 멈춥니다.`)
        : '입력 상한 없음: 최악 턴까지 허용합니다.' }),
      el('div', { class: 'hint', text: '기록은 글자 2자 ≈ 1토큰으로, 고정 프롬프트(지침+툴 스키마)는 약 1.5만 토큰으로 잡았습니다. 캐시 히트는 할인되지만 여기엔 반영하지 않았습니다.' }),
    );
  };

  const drawMeasured = () => {
    if (!usage || !usage.turns) { measured.textContent = '실측: 아직 기록된 턴이 없습니다.'; return; }
    const since = new Date(usage.since * 1000);
    measured.textContent = `실측 (최근 ${usage.turns}턴, ${since.getMonth() + 1}/${since.getDate()} ${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')} 이후): `
      + `턴당 입력 평균 ${fmtN(usage.avgInput)} · 최대 ${fmtN(usage.maxInput)} · 요청 평균 ${usage.avgRequests}회(최대 ${usage.maxRequests}) · `
      + `요청당 ${fmtN(usage.avgPerRequest)} 토큰 · 툴 호출 평균 ${usage.avgToolCalls}회 · 캐시 ${Math.round((usage.cacheShare || 0) * 100)}%`;
  };

  const rows = ADV_FIELDS.map((f) => {
    const input = el('input', { type: 'number', min: '0', placeholder: `${f.def.toLocaleString()} (권장)` }) as HTMLInputElement;
    input.addEventListener('input', drawSim);
    inputs.set(f.key, input);
    return el('div', { class: 'advfield' }, [
      el('label', { class: 'field' }, [el('span', { text: `${f.label} (${f.unit})` }), input]),
      el('div', { class: 'hint', text: f.help + (f.zeroMeansOff ? '' : ' 비우면 권장값을 씁니다.') }),
    ]);
  });

  const load = async () => {
    try {
      const [{ config }, u] = await Promise.all([
        state.getConfig(),
        transport.get<Record<string, number>>('/agent/usage', { turns: '30' }).catch(() => null),
      ]);
      const a = (config.agent ?? {}) as Record<string, unknown>;
      for (const f of ADV_FIELDS) {
        const v = a[f.key];
        const inp = inputs.get(f.key)!;
        inp.value = v === undefined || v === null || Number(v) === f.def ? '' : String(v);
      }
      usage = u;
      drawMeasured();
      drawSim();
    } catch (e) {
      status.textContent = '읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e));
    }
  };

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    const patch: Record<string, number> = {};
    for (const f of ADV_FIELDS) patch[f.key] = val(f);
    try {
      await state.setConfig({ agent: patch });
      status.textContent = '저장했습니다. 다음 턴부터 적용됩니다.';
      await load();
    } catch (e) {
      status.textContent = '저장 실패: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      save.disabled = false;
    }
  });
  const reset = el('button', { class: 'ghost tiny', text: '권장값으로' });
  reset.addEventListener('click', () => { for (const inp of inputs.values()) inp.value = ''; drawSim(); });

  void load();
  return foldableCard('agent-advanced-card', '고급 설정 (공통)', [
    el('div', { class: 'hint', style: { marginBottom: '8px' },
      text: '모든 프리셋에 공통인 턴당 비용 조절입니다. 한 턴 = 사용자의 말 한 번에 히나가 툴을 오가며 답을 끝내는 것. 툴을 부를 때마다 모델을 다시 부르고 기록 전체를 다시 보내므로, 턴 비용 = 요청 수 × (고정 프롬프트 + 기록)입니다.' }),
    ...rows,
    sim,
    measured,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save, reset, status]),
  ]);
}

/**
 * The vision tool card (§1-42): who looks at images for the agent - its own
 * model (after a probe proves it sees), a separate OpenAI-compatible vision
 * helper, or nobody (numbers only). One 테스트 does what the tool does.
 */
function buildVisionCard(): HTMLElement {
  const modeSel = el('select') as HTMLSelectElement;
  const modeNote = el('div', { class: 'hint', style: { margin: '4px 0 10px' } });
  const status = el('div', { class: 'hint', style: { marginBottom: '8px' } });
  const out = el('div', { class: 'outbox' });
  let st: VisionStatus | null = null;
  let keep = '__keep__';
  let keyList: ApiKeyEntry[] = [];

  // --- 1. native ---
  const nativeInfo = el('div', { class: 'hint' });
  const nativePane = el('div', { class: 'wsmode' }, [nativeInfo]);

  // --- 2. helper ---
  const hUrl = el('input', { placeholder: 'https://generativelanguage.googleapis.com/v1beta/openai 또는 http://127.0.0.1:11434/v1' }) as HTMLInputElement;
  const hModel = el('input', { placeholder: 'gemini-2.5-flash' }) as HTMLInputElement;
  const hKeySel = el('select') as HTMLSelectElement;
  const hKey = el('input', { type: 'password', placeholder: 'API 키 (로컬 Ollama 는 비워 둠)' }) as HTMLInputElement;
  const hKeyRow = el('label', { class: 'field' }, [el('span', { text: 'API 키 직접 입력' }), hKey]);
  const hInstr = el('textarea', { rows: '4' }) as HTMLTextAreaElement;
  const hReset = el('button', { class: 'ghost tiny', text: '기본 지침으로' });
  hReset.addEventListener('click', () => { hInstr.value = st?.helper.defaultInstructions ?? ''; });
  // A key picked from the list carries its own address (keys.resolve): the
  // baseUrl field goes away with it (§1-43, user).
  const hUrlRow = el('label', { class: 'field' }, [el('span', { text: '주소 (baseUrl)' }), hUrl]);
  const hUrlNote = el('div', { class: 'hint', style: { display: 'none' }, text: '주소는 선택한 API 키에 저장된 것을 씁니다.' });
  const syncHelperKey = () => {
    const ref = !!selectedValue(hKeySel);
    hKeyRow.style.display = ref ? 'none' : '';
    hUrlRow.style.display = ref ? 'none' : '';
    hUrlNote.style.display = ref ? '' : 'none';
  };
  hKeySel.addEventListener('change', syncHelperKey);
  const helperPane = el('div', { class: 'wsmode' }, [
    el('div', { class: 'hint', style: { marginBottom: '8px' },
      text: 'OpenAI 호환 chat/completions 에 그림을 실어 보냅니다. 성인 이미지가 많다면 무검열/로컬 모델(예: Ollama 의 llava·qwen2.5-vl, 주소 http://127.0.0.1:11434/v1)을 권합니다 — 외부 API 는 거절할 수 있고, 거절되면 툴이 "VISION REFUSED" 로 알립니다.' }),
    hUrlRow,
    hUrlNote,
    el('label', { class: 'field' }, [el('span', { text: '모델' }), hModel]),
    el('label', { class: 'field' }, [el('span', { text: 'API 키 (키 목록에서)' }), hKeySel]),
    hKeyRow,
    el('label', { class: 'field' }, [el('span', { text: '비전 모델 지침' }), hInstr]),
    el('div', { class: 'row' }, [hReset]),
  ]);

  // --- 3. off ---
  const offPane = el('div', { class: 'wsmode' }, [
    el('div', { class: 'hint', text: '모델 없이 수치(크기·밝기·선명도·레터박스·중복)만 잽니다. 에이전트는 그림의 내용을 판단하지 못하고 그렇다고 말합니다.' }),
  ]);

  // --- common ---
  const maxW = el('input', { type: 'number', min: '128', max: '2048', step: '64', value: '768' }) as HTMLInputElement;
  const detail = el('select') as HTMLSelectElement;
  for (const [v, t] of [['auto', 'auto'], ['low', 'low (싸고 빠름)'], ['high', 'high (세밀)']]) detail.appendChild(el('option', { value: v, text: t }));
  const maxCalls = el('input', { type: 'number', min: '1', max: '100', value: '12' }) as HTMLInputElement;
  const commonPane = el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px', marginTop: '6px' } }, [
    el('label', { class: 'field' }, [el('span', { text: '최대 변 길이 (px)' }), maxW]),
    el('label', { class: 'field' }, [el('span', { text: '디테일' }), detail]),
    el('label', { class: 'field' }, [el('span', { text: '턴당 최대 호출' }), maxCalls]),
  ]);

  const panes: Record<VisionMode, HTMLElement> = { native: nativePane, helper: helperPane, off: offPane };
  const syncMode = () => {
    const m = selectedValue(modeSel) as VisionMode;
    for (const [id, pane] of Object.entries(panes)) pane.style.display = id === m ? '' : 'none';
    commonPane.style.display = m === 'off' ? 'none' : '';
    modeNote.textContent = st?.modes.find((x) => x.id === m)?.note ?? '';
  };
  modeSel.addEventListener('change', syncMode);

  const load = async () => {
    try {
      const [r, k] = await Promise.all([state.vision(), state.apiKeys().catch(() => ({ keys: [] as ApiKeyEntry[] }))]);
      st = r;
      keep = r.keepSentinel || keep;
      keyList = k.keys ?? [];
      clear(modeSel);
      for (const m of r.modes) modeSel.appendChild(el('option', { value: m.id, text: `${r.modes.indexOf(m) + 1}. ${m.name}` }));
      setSelected(modeSel, r.mode);
      // native
      clear(nativeInfo);
      nativeInfo.appendChild(el('div', { text: `일반 에이전트: ${r.agent.model || '(모델 없음)'} @ ${r.agent.host || '(주소 없음)'}` }));
      const p = r.nativeProbe || {};
      nativeInfo.appendChild(el('div', { class: r.nativeProbeStale || (p.model && !p.ok) ? 'diff-del-n' : '', text:
        !p.model ? '아직 확인 안 됨 — 테스트를 누르면 두 색 그림을 보내 이 모델이 실제로 보는지 확인하고 기억합니다.'
        : r.nativeProbeStale ? `모델이 바뀌었습니다 (확인된 것: ${p.model}) — 다시 테스트하세요.`
        : p.ok ? `확인됨 ${p.at || ''} · ${p.model}`
        : `이 모델은 이미지를 보지 못했습니다 (${p.error || ''}) — 보조 비전 모델을 쓰세요.` }));
      // helper
      hUrl.value = r.helper.baseUrl || '';
      hModel.value = r.helper.model === r.helper.defaultModel ? '' : r.helper.model;
      hModel.placeholder = r.helper.defaultModel;
      clear(hKeySel);
      hKeySel.appendChild(el('option', { value: '', text: r.helper.apiKeySet ? '(직접 입력한 키 사용)' : '(직접 입력 / 없음)' }));
      for (const key of keyList) hKeySel.appendChild(el('option', { value: key.id, text: `${key.name}${key.provider ? ' · ' + key.provider : ''}` }));
      setSelected(hKeySel, r.helper.keyRef);
      hKey.placeholder = r.helper.apiKeySet ? '(저장된 키 유지 — 바꾸려면 입력)' : 'API 키 (로컬 Ollama 는 비워 둠)';
      hInstr.value = r.helper.instructions;
      hInstr.placeholder = r.helper.defaultInstructions;
      syncHelperKey();
      maxW.value = String(r.maxWidth || 768);
      setSelected(detail, r.detail || 'auto');
      maxCalls.value = String(r.maxCallsPerTurn || 12);
      syncMode();
      status.textContent = (r.ready ? `지금: ${r.modes.find((m) => m.id === r.mode)?.name ?? r.mode} — 사용 가능` : `사용 불가: ${r.whyNot}`)
        + (r.pillow ? '' : ' · Pillow 없음: 수치 분석이 제한됩니다');
      status.className = 'hint ' + (r.ready ? '' : 'diff-del-n');
    } catch (e) {
      status.textContent = msg(e);
    }
  };

  const patch = (): Record<string, unknown> => {
    const m = selectedValue(modeSel) as VisionMode;
    const p: Record<string, unknown> = { mode: m };
    if (m === 'helper') {
      // With a key from the list the key's own address applies (the field is hidden).
      p.helperBaseUrl = selectedValue(hKeySel) ? '' : hUrl.value.trim();
      p.helperModel = hModel.value.trim();
      p.helperKeyRef = selectedValue(hKeySel);
      p.helperApiKey = hKey.value ? hKey.value : (st?.helper.apiKeySet ? keep : '');
      p.helperInstructions = hInstr.value.trim();
    }
    if (m !== 'off') {
      p.maxWidth = Math.max(128, Math.min(2048, Number(maxW.value) || 768));
      p.detail = selectedValue(detail) || 'auto';
      p.maxCallsPerTurn = Math.max(1, Math.min(100, Number(maxCalls.value) || 12));
    }
    return p;
  };

  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveVision(patch());
      hKey.value = '';
      await load();
      clear(out);
      out.appendChild(el('div', { class: 'notice ok', text: '저장했습니다.' }));
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      save.disabled = false;
    }
  });

  const path = el('input', { placeholder: '테스트 이미지 경로 (비우면 내장 두 색 그림) — studio/output/…/x.png' }) as HTMLInputElement;
  const test = el('button', { class: 'ghost', text: '테스트' }) as HTMLButtonElement;
  test.addEventListener('click', async () => {
    test.disabled = true;
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '저장하고 보는 중입니다… (메인 모델 확인은 한 번의 실제 호출입니다)' }));
    try {
      await state.saveVision(patch());
      hKey.value = '';
      const r = await state.testVision(path.value.trim(), '');
      await load();
      clear(out);
      const head = r.ok
        ? `봅니다 · ${r.detail} · ${(r.ms / 1000).toFixed(1)}초`
        : (r.refused ? `거절됨 — 이 모델은 이 그림을 묘사하지 않습니다. 무검열/로컬 모델로 바꾸거나 다른 이미지를 시도하세요.` : `실패했습니다${r.detail ? ' · ' + r.detail : ''}`);
      out.appendChild(el('div', { class: 'notice ' + (r.ok ? 'ok' : 'err') }, [
        el('div', { text: head }),
        el('pre', { class: 'mono', style: { maxHeight: '220px' }, text: r.text || r.error || '' }),
        r.metrics ? el('pre', { class: 'mono hint', style: { maxHeight: '140px' }, text: JSON.stringify(r.metrics, null, 1) }) : null,
      ]));
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      test.disabled = false;
    }
  });

  void load();
  return foldableCard('vision-card', '비전 툴', [
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text: '일반 에이전트가 이미지를 직접 보고 판단·검수·조정할 때 쓰는 view_image · compare_images · review_folder 툴입니다. 누가 볼지 하나를 고릅니다.' }),
    status,
    el('label', { class: 'field' }, [el('span', { text: '보기 옵션' }), modeSel]),
    modeNote,
    nativePane,
    helperPane,
    offPane,
    commonPane,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save, path, test]),
    out,
  ]);
}

function buildWebsearchCard(): HTMLElement {
  const modeSel = el('select') as HTMLSelectElement;
  const modeNote = el('div', { class: 'hint', style: { margin: '4px 0 10px' } });
  const status = el('div', { class: 'hint', style: { marginBottom: '8px' } });
  const out = el('div', { class: 'outbox' });
  let st: WebsearchStatus | null = null;
  let keep = '__keep__';
  let keyList: ApiKeyEntry[] = [];

  // --- 1. native ---
  const nativeInfo = el('div', { class: 'hint' });
  const nativePane = el('div', { class: 'wsmode' }, [nativeInfo]);

  // --- 2. gemini ---
  const gModel = el('input', { placeholder: 'gemini-3.7-flash' }) as HTMLInputElement;
  const gKeySel = el('select') as HTMLSelectElement;
  const gKey = el('input', { type: 'password', placeholder: 'Google AI Studio API 키' }) as HTMLInputElement;
  const gKeyRow = el('label', { class: 'field' }, [el('span', { text: 'API 키 직접 입력' }), gKey]);
  const gInstr = el('textarea', { rows: '4' }) as HTMLTextAreaElement;
  const gReset = el('button', { class: 'ghost tiny', text: '기본 지침으로' });
  gReset.addEventListener('click', () => { gInstr.value = st?.gemini.defaultInstructions ?? ''; });
  const syncGeminiKey = () => { gKeyRow.style.display = selectedValue(gKeySel) ? 'none' : ''; };
  gKeySel.addEventListener('change', syncGeminiKey);
  const geminiPane = el('div', { class: 'wsmode' }, [
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text: 'Google AI Studio 로 고정됩니다 (generativelanguage.googleapis.com). Gemini 가 Google 검색으로 찾고 읽어 출처가 붙은 답을 돌려줍니다.' }),
    el('label', { class: 'field' }, [el('span', { text: '모델' }), gModel]),
    el('label', { class: 'field' }, [el('span', { text: 'API 키 (키 목록에서)' }), gKeySel]),
    gKeyRow,
    el('label', { class: 'field' }, [el('span', { text: '에이전트 지침' }), gInstr]),
    el('div', { class: 'row' }, [gReset]),
  ]);

  // --- 3. provider ---
  const pSel = el('select') as HTMLSelectElement;
  const pKey = el('input', { type: 'password', placeholder: 'API 키' }) as HTMLInputElement;
  const pUrl = el('input', { placeholder: 'https://searx.example.com' }) as HTMLInputElement;
  const pMax = el('input', { type: 'number', min: '1', max: '8', value: '5' }) as HTMLInputElement;
  const pKeyRow = el('label', { class: 'field' }, [el('span', { text: 'API 키' }), pKey]);
  const pUrlRow = el('label', { class: 'field' }, [el('span', { text: '주소 (baseUrl)' }), pUrl]);
  const pNote = el('div', { class: 'hint' });
  const syncProvider = () => {
    const p = st?.providers.find((x) => x.id === selectedValue(pSel));
    pKeyRow.style.display = p?.needsKey ? '' : 'none';
    pUrlRow.style.display = p?.needsUrl ? '' : 'none';
    pKey.placeholder = st?.apiKeySet ? '(저장된 키 유지 — 바꾸려면 입력)' : 'API 키';
    pNote.textContent = p?.note ?? '';
  };
  pSel.addEventListener('change', syncProvider);
  const providerPane = el('div', { class: 'wsmode' }, [
    el('label', { class: 'field' }, [el('span', { text: '제공자' }), pSel]),
    pNote,
    pKeyRow,
    pUrlRow,
    el('label', { class: 'field' }, [el('span', { text: '결과 수 (1–8)' }), pMax]),
  ]);

  const panes: Record<WebsearchMode, HTMLElement> = { native: nativePane, gemini: geminiPane, provider: providerPane };
  const syncMode = () => {
    const m = selectedValue(modeSel) as WebsearchMode;
    for (const [id, pane] of Object.entries(panes)) pane.style.display = id === m ? '' : 'none';
    modeNote.textContent = st?.modes.find((x) => x.id === m)?.note ?? '';
  };
  modeSel.addEventListener('change', syncMode);

  const load = async () => {
    try {
      const [r, k] = await Promise.all([state.websearch(), state.apiKeys().catch(() => ({ keys: [] as ApiKeyEntry[] }))]);
      st = r;
      keep = r.keepSentinel || keep;
      keyList = k.keys ?? [];
      clear(modeSel);
      for (const m of r.modes) modeSel.appendChild(el('option', { value: m.id, text: `${r.modes.indexOf(m) + 1}. ${m.name}` }));
      setSelected(modeSel, r.mode);
      // native
      clear(nativeInfo);
      nativeInfo.appendChild(el('div', { text: `일반 에이전트: ${r.agent.model || '(모델 없음)'} @ ${r.agent.host || '(주소 없음)'}` }));
      nativeInfo.appendChild(el('div', { text: r.nativeShape
        ? `기억한 방식: ${r.nativeShapeLabel || r.nativeShape} — 테스트로 다시 찾을 수 있습니다.`
        : '아직 테스트하지 않았습니다. 테스트가 여러 방식을 차례로 시도해 되는 것을 기억합니다 (최대 몇 분).' }));
      // gemini
      gModel.value = r.gemini.model === r.gemini.defaultModel ? '' : r.gemini.model;
      gModel.placeholder = r.gemini.defaultModel;
      clear(gKeySel);
      gKeySel.appendChild(el('option', { value: '', text: r.gemini.apiKeySet ? '(직접 입력한 키 사용)' : '(직접 입력)' }));
      for (const key of keyList) gKeySel.appendChild(el('option', { value: key.id, text: `${key.name}${key.provider ? ' · ' + key.provider : ''}` }));
      setSelected(gKeySel, r.gemini.keyRef);
      gKey.placeholder = r.gemini.apiKeySet ? '(저장된 키 유지 — 바꾸려면 입력)' : 'Google AI Studio API 키';
      gInstr.value = r.gemini.instructions;
      gInstr.placeholder = r.gemini.defaultInstructions;
      syncGeminiKey();
      // provider
      clear(pSel);
      for (const p of r.providers) pSel.appendChild(el('option', { value: p.id, text: p.name }));
      setSelected(pSel, r.provider);
      pUrl.value = r.baseUrl || '';
      pMax.value = String(r.maxResults || 5);
      syncProvider();
      syncMode();
      status.textContent = r.ready ? `지금: ${r.modes.find((m) => m.id === r.mode)?.name ?? r.mode} — 검색 가능` : `검색 불가: ${r.whyNot}`;
      status.className = 'hint ' + (r.ready ? '' : 'diff-del-n');
    } catch (e) {
      status.textContent = msg(e);
    }
  };

  const patch = (): Record<string, unknown> => {
    const m = selectedValue(modeSel) as WebsearchMode;
    const p: Record<string, unknown> = { mode: m };
    if (m === 'gemini') {
      p.geminiModel = gModel.value.trim();
      p.geminiKeyRef = selectedValue(gKeySel);
      p.geminiApiKey = gKey.value ? gKey.value : (st?.gemini.apiKeySet ? keep : '');
      p.geminiInstructions = gInstr.value.trim();
    } else if (m === 'provider') {
      p.provider = selectedValue(pSel);
      p.apiKey = pKey.value ? pKey.value : (st?.apiKeySet ? keep : '');
      p.baseUrl = pUrl.value.trim();
      p.maxResults = Math.max(1, Math.min(8, Number(pMax.value) || 5));
    }
    return p;
  };

  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveWebsearch(patch());
      gKey.value = '';
      pKey.value = '';
      await load();
      clear(out);
      out.appendChild(el('div', { class: 'notice ok', text: '저장했습니다.' }));
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      save.disabled = false;
    }
  });

  const q = el('input', { placeholder: '테스트 질문', value: 'RisuAI 최신 릴리스 버전' }) as HTMLInputElement;
  const test = el('button', { class: 'ghost', text: '테스트' }) as HTMLButtonElement;
  test.addEventListener('click', async () => {
    test.disabled = true;
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '저장하고 검색하는 중입니다… (내장 검색은 여러 방식을 시도하므로 몇 분 걸릴 수 있습니다)' }));
    try {
      await state.saveWebsearch(patch());
      gKey.value = '';
      pKey.value = '';
      const r = await state.testWebsearch(q.value.trim() || 'RisuAI 최신 릴리스 버전');
      await load();
      clear(out);
      out.appendChild(el('div', { class: 'notice ' + (r.ok ? 'ok' : 'err') }, [
        el('div', { text: r.ok ? `검색됩니다 · ${r.detail} · ${(r.ms / 1000).toFixed(1)}초` : `실패했습니다${r.detail ? ' · ' + r.detail : ''}` }),
        el('pre', { class: 'mono', style: { maxHeight: '260px' }, text: r.text || r.error || '' }),
      ]));
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      test.disabled = false;
    }
  });

  void load();
  return foldableCard('websearch-card', '웹 검색 툴', [
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text: '일반 에이전트가 외부 사실이 필요할 때 쓰는 web_search 툴입니다. 누가 검색할지 하나를 고릅니다.' }),
    status,
    el('label', { class: 'field' }, [el('span', { text: '검색 옵션' }), modeSel]),
    modeNote,
    nativePane,
    geminiPane,
    providerPane,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save, q, test]),
    out,
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

function keyBadges(p: AgentPreset): { text: string; cls: string }[] {
  return !p.apiKey?.set && !p.keyRef && p.provider !== 'codex' ? [{ text: '키 없음', cls: 'warn' }] : [];
}

function openPicker(kind: Kind, refresh: () => Promise<void>, say: (t: string, k?: 'ok' | 'err' | '') => void): void {
  openListPicker({
    title: `${KIND_LABEL[kind]} 프리셋 선택`,
    load: async () => {
      const r = await state.presets();
      const mine = r.presets.filter((p) => p.kind === kind);
      return mine.map((p): PickerEntry => ({
        id: p.id,
        name: p.name,
        hint: summarise(p),
        selected: !!p.selected,
        badges: keyBadges(p),
        // The backend refuses to delete the last general one; hiding the
        // button states the rule instead of surfacing a refusal.
        noDelete: kind === 'general' && mine.length <= 1,
      }));
    },
    onSelect: async (entry) => {
      await state.selectPreset(entry.id);
      await refresh();
      say(`“${entry.name}” 을(를) 쓰기 시작했습니다.`, 'ok');
    },
    onEdit: (entry) => openEditor(kind, entry.id, refresh, say),
    onDelete: async (entry) => {
      await state.deletePreset(entry.id);
      await refresh();
    },
    onCreate: () => openEditor(kind, null, refresh, say),
    createLabel: '새 프리셋 추가',
  });
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
      if (codexOffered()) {
        keySel.appendChild(el('option', { value: CODEX_KEY, text: 'OpenAI 구독 (ChatGPT Plus/Pro · Codex)' }));
      }
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
    codexOffered() ? codexBox.root : null,
    ownKeyRow,
    urlRow,
    el('label', { class: 'field' }, [
      el('span', {}, [el('span', { text: 'Model ' }), catalogBtn]), model,
    ]),
    kind === 'search'
      ? el('div', { class: 'notice', style: { marginBottom: '10px' }, text:
        '검색 에이전트에는 검색에 강하고 저렴한 모델을 권합니다 — Google Gemini(예: gemini-2.5-flash, OpenAI 호환 엔드포인트 …/v1beta/openai). 실제 검색은 에이전트 탭 아래 “검색 제공자” 카드로 합니다.' })
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
  let poll: (() => void) | null = null;

  const stopPoll = () => { if (poll) { poll(); poll = null; } };
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
      // Stops while the page is hidden, and for good once this card is gone
      // from the page - navigating away mid-login used to leave it polling
      // forever (§1-55).
      poll = pollWhileVisible(() => {
        if (!out.isConnected) { stopPoll(); return; }
        void (async () => {
          try {
            const st = await state.codexLoginStatus(pendingState);
            if (st.done || st.loggedIn) { stopPoll(); clear(out); await refresh(); }
            else if (st.error) { stopPoll(); out.appendChild(el('div', { class: 'notice err', text: st.error })); }
          } catch { /* keep polling */ }
        })();
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
        'Codex OAuth 로 ChatGPT Plus/Pro 계정에 로그인해 chatgpt.com 의 codex 백엔드를 씁니다. 요청에는 risu-hina 이름으로 접속합니다. 로그인해 두면 에이전트 프리셋의 API 키 선택에서 "OpenAI 구독" 을 고를 수 있습니다. 공식 API 가 아니라 OpenAI 쪽 변경에 깨질 수 있고, 그때는 오류를 그대로 보여 줍니다.' }),
      el('div', { class: 'notice warn', style: { marginBottom: '6px' } }, [
        el('span', { text: '오픈소스 에이전트 프로그램에서 Codex 구독 사용은 명시적으로 허용되지 않았습니다. 개인의 책임하에 사용해 주세요. ' }),
        el('strong', { text: '(특히 챗챈에서 언급은 자제하여 주십시오.)' }),
      ]),
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
