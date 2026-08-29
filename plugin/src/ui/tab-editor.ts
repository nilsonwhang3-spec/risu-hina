/**
 * Tab 2 - the work surface.
 *
 * Layout follows what the tools actually are. Acting on the transcript (view,
 * find, cut, export) belongs above the chat, because that is what it acts on.
 * Adjusting how a tool behaves belongs to the right panel, because it is a
 * second-order decision. Acting on the chat as a whole (snapshot, versions,
 * write-back) is not this tab's at all - the shell's chat bar does that, on
 * every tab, because a lorebook edit is written back by the same verb. So:
 *
 *   left, above the turns   one icon per tool. Clicking activates it.
 *   right, 상세옵션          the active tool's controls, and nothing else.
 *   right, AI 에이전트       a separate tab - a different mode of working, not
 *                            another tool in the same row.
 *
 * The previous version stacked every tool's full form open at once, which made
 * the panel a wall of controls to scroll past. Options belonging to an inactive
 * tool are now not on screen at all.
 */
import { el, clear, armed, TOOL } from './dom';
import { state, type Turn, type BulkPreview, type StagedEdit } from '../state';
import { Explorer } from './explorer';
import { threePane } from './panes';
import { agentPanel, bindAgent, mountAgent } from './agentpane';
import { TurnList } from './turnlist';
import { DEFAULT_RENDER, type RenderOptions, type ViewMode } from './render';
import * as host from '../host';
import { GATE_COPY } from './kit';
import { setToolbar } from './shell';
import { clientLog } from '../transport';

type ToolId = 'view' | 'find' | 'cut' | 'export' | null;

let list: TurnList | null = null;
let rightMount: HTMLElement | null = null;
let optionMount: HTMLElement | null = null;
let agentMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let toolbarEl: HTMLElement | null = null;
let optTabBtn: HTMLElement | null = null;
let agentTabBtn: HTMLElement | null = null;

let activeTool: ToolId = null;
let showOriginal = true;
let viewMode: ViewMode = 'clean';
const renderOpts: RenderOptions = { ...DEFAULT_RENDER };

/**
 * Which turns the middle panel shows, as an inclusive seq range.
 *
 * Purely a view: it never narrows what 찾기·바꾸기 or 삭제 act on, because
 * those carry their own range fields. A filter that silently scoped a bulk
 * replace to whatever happened to be on screen would be the kind of surprise
 * this whole tool exists to avoid.
 */
let range: { from: number; to: number } | null = null;
let filterBar: HTMLElement | null = null;

/** msgId -> proposed text, while a replace preview is pending. */
let preview: Map<string, string> | null = null;
/** msgIds a pending deletion would remove. */
let deleting: Set<string> | null = null;
let explorer: Explorer | null = null;

export function renderEditorTab(mount: HTMLElement): void {
  if (!state.activeChatKey) {
    clear(mount);
    setToolbar(null);
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: GATE_COPY.chat }),
    ]));
    return;
  }

  if (!list || !mount.querySelector('.split')) {
    clear(mount);
    list = new TurnList({
      showOriginal: () => showOriginal,
      viewMode: () => viewMode,
      renderOptions: () => renderOpts,
      preview: () => preview,
      deleting: () => deleting,
      onEdit: async (t: Turn, next: string) => {
        try {
          await state.editTurn(t.msgId, t.body, next);
        } catch (e) {
          notice('수정에 실패했습니다: ' + msg(e), 'err');
          void clientLog('error', 'turn edit failed', { msgId: t.msgId, error: msg(e) });
        }
      },
    });

    noticeMount = el('div');
    filterBar = el('div', { class: 'filterbar', style: { display: 'none' } });
    rightMount = el('div', { class: 'right-inner' });

    explorer = new Explorer({
      onJump: (seq) => list?.scrollToSeq(seq),
      preview: () => preview,
      deleting: () => deleting,
    });
    // The explorer follows the scroll rather than only driving it, so it works
    // as a position indicator too - "where am I in 394 turns" is the same
    // question as "where do I want to go".
    list.onVisible = (seq) => explorer?.setVisible(seq);

    // The tool row goes up to the shell slot; only the transcript and its own
    // notices stay in this column.
    buildToolbar();
    const pane = threePane(explorer.root);
    pane.centre.appendChild(filterBar);
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(list.root);
    rightMount = pane.right.querySelector('.right-inner') as HTMLElement;
    mount.appendChild(pane.root);
    buildRight();
  }

  // The agent panel is shared between tabs, so the editor re-points its hooks
  // and re-parents it every time this tab is shown.
  bindAgent({ onStagedChanged, onApplied, notice });
  if (agentMount) mountAgent(agentMount);

  if (toolbarEl) setToolbar(toolbarEl);
  refreshList();
}

// --- the tool row -----------------------------------------------------------

function toolButton(id: Exclude<ToolId, null>, glyph: string, label: string, title: string): HTMLElement {
  const b = el('button', { class: 'tool', dataset: { tool: id }, title }, [
    el('span', { class: 'glyph', text: glyph }),
    el('span', { class: 'tool-label', text: label }),
  ]);
  b.addEventListener('click', () => selectTool(id));
  return b;
}

function buildToolbar(): HTMLElement {
  countEl = el('span', { class: 'dim' });

  toolbarEl = el('div', { class: 'toolrow' }, [
    toolButton('view', TOOL.view, '보기', '원문 / 정리해서 보기 / 렌더링'),
    toolButton('find', TOOL.find, '찾기', '찾기·바꾸기'),
    toolButton('cut', TOOL.cut, '삭제', '턴 범위 일괄 삭제'),
    toolButton('export', TOOL.export, '내보내기', 'md · risuChat · 클립보드'),
    el('span', { class: 'spacer' }),
    countEl,
  ]);
  return toolbarEl;
}

function selectTool(id: Exclude<ToolId, null>): void {
  // Clicking the active tool closes it, so the options panel can be empty on
  // purpose rather than always showing whatever was touched last.
  activeTool = activeTool === id ? null : id;
  for (const b of Array.from(toolbarEl?.querySelectorAll('.tool') ?? [])) {
    b.classList.toggle('on', (b as HTMLElement).dataset.tool === activeTool);
  }
  showTab('options');
  renderOptions();
}

function visibleSeq(seq: number | null | undefined): boolean {
  if (!range || seq == null) return !range;
  return seq >= range.from && seq <= range.to;
}

function refreshToolbar(): void {
  if (!countEl) return;
  const changed = state.turns.filter((t) => t.changed).length;
  const added = state.turns.filter((t) => t.isNew).length;
  const bits = [`${state.totalTurns}턴`];
  if (range) bits.push(`표시 ${visibleTurns().length}`);
  if (changed) bits.push(`수정 ${changed}`);
  if (added) bits.push(`추가 ${added}`);
  if (preview) bits.push(`치환 예정 ${preview.size}`);
  if (deleting) bits.push(`삭제 예정 ${deleting.size}`);
  countEl.textContent = bits.join(' · ');
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- 표시 범위 ---------------------------------------------------------------

function visibleTurns(): Turn[] {
  const r = range;
  if (!r) return state.turns;
  return state.turns.filter((t) => t.seq >= r.from && t.seq <= r.to);
}

function setRange(next: { from: number; to: number } | null): void {
  range = next;
  refreshList();
}

/** Push the current turns through the filter and re-sync everything on them. */
function refreshList(): void {
  list?.setTurns(visibleTurns());
  // The explorer keeps every turn on purpose: while a range is active it is the
  // only thing left on screen showing where that range sits in the whole chat.
  explorer?.setTurns(state.turns);
  syncFilterBar();
  refreshToolbar();
}

function syncFilterBar(): void {
  if (!filterBar) return;
  clear(filterBar);
  if (!range) {
    filterBar.style.display = 'none';
    return;
  }
  filterBar.style.display = 'flex';
  const shown = visibleTurns().length;
  const clearBtn = el('button', { class: 'ghost tiny', text: '전체 보기' });
  clearBtn.addEventListener('click', () => {
    setRange(null);
    renderOptions();
  });
  filterBar.appendChild(el('span', {
    text: `${range.from}–${range.to}번 턴만 보고 있습니다 · 전체 ${state.totalTurns}턴 중 ${shown}턴`,
  }));
  filterBar.appendChild(el('span', { class: 'spacer' }));
  filterBar.appendChild(clearBtn);
}

// --- right: 상세옵션 | AI 에이전트 -------------------------------------------

/**
 * A staged proposal is shown against the conversation it would change, the same
 * way a bulk preview is - the review happens on the left, not in a list of ids
 * on the right.
 */
function onStagedChanged(items: StagedEdit[]): void {
  const edits = items.filter((i) => i.op === 'edit' && i.after !== null);
  preview = edits.length ? new Map(edits.map((i) => [i.msgId, String(i.after)])) : null;
  const dels = items.filter((i) => i.op === 'delete');
  deleting = dels.length ? new Set(dels.map((i) => i.msgId)) : null;
  // A proposal the range filter is hiding cannot be reviewed, so the filter
  // yields rather than the proposal going unseen.
  if (range && items.length && !items.some((i) => visibleSeq(i.seq))) {
    range = null;
    notice('제안된 턴이 표시 범위 밖이라 전체 보기로 돌아갔습니다.');
  }
  refreshList();
  if (edits.length) list?.scrollToSeq(edits[0].seq ?? 0);
}

async function onApplied(): Promise<void> {
  preview = null;
  deleting = null;
  await state.loadTurns();
}

function buildRight(): void {
  if (!rightMount) return;
  optionMount = el('div', { class: 'pad rpanel' });
  agentMount = el('div', { class: 'rpanel agentwrap active' });

  optTabBtn = el('button', { class: 'rtab', text: '상세옵션' });
  agentTabBtn = el('button', { class: 'rtab active', text: 'AI 에이전트' });
  optTabBtn.addEventListener('click', () => showTab('options'));
  agentTabBtn.addEventListener('click', () => showTab('agent'));

  rightMount.appendChild(el('div', { class: 'rtabs' }, [optTabBtn, agentTabBtn]));
  rightMount.appendChild(optionMount);
  rightMount.appendChild(agentMount);
  renderOptions();
  showTab('agent');
}

function showTab(which: 'options' | 'agent'): void {
  if (which === 'agent') void agentPanel().load();
  optionMount?.classList.toggle('active', which === 'options');
  agentMount?.classList.toggle('active', which === 'agent');
  optTabBtn?.classList.toggle('active', which === 'options');
  agentTabBtn?.classList.toggle('active', which === 'agent');
}

function renderOptions(): void {
  if (!optionMount) return;
  clear(optionMount);
  switch (activeTool) {
    case 'view': optionMount.appendChild(buildViewOptions()); break;
    case 'find': optionMount.appendChild(buildFind()); break;
    case 'cut': optionMount.appendChild(buildCut()); break;
    case 'export': optionMount.appendChild(buildExport()); break;
    default:
      optionMount.appendChild(el('div', {
        class: 'empty',
        text: '위 도구를 선택하시면 여기에 상세 옵션이 나옵니다.',
      }));
  }
}

// --- 보기 -------------------------------------------------------------------

function buildViewOptions(): HTMLElement {
  const modes: [ViewMode, string, string][] = [
    ['rendered', '렌더링해서 보기', '카드의 editdisplay 정규식과 backgroundHTML CSS까지 적용합니다'],
    ['clean', '정리해서 보기', '사고사슬·태그 같은 노이즈만 걷어냅니다. RisuAI 재현은 아닙니다'],
    ['raw', '원문 보기', '저장된 그대로입니다. 편집은 언제나 이 텍스트를 고칩니다'],
  ];

  // Named so tests (and CSS) can address it: its visibility is the contract
  // that strip options disappear outside clean mode.
  const optsBox = el('div', { class: 'stripopts' });
  const buttons: HTMLButtonElement[] = [];

  const setMode = (m: ViewMode) => {
    if (m === 'rendered') {
      notice('“렌더링해서 보기”는 아직 준비 중입니다. “정리해서 보기”로 돌아갑니다.');
      m = 'clean';
    }
    viewMode = m;
    for (const b of buttons) b.classList.toggle('on', b.dataset.mode === m);
    // The strip toggles only mean anything in clean mode, so they leave the
    // screen rather than sit greyed out when they cannot do anything.
    optsBox.style.display = m === 'clean' ? 'block' : 'none';
    refreshList();
  };

  const rows = modes.map(([m, label, why]) => {
    const b = el('button', { class: 'modebtn', dataset: { mode: m } }, [
      el('div', { text: label + (m === 'rendered' ? '   (추후 구현)' : '') }),
      el('div', { class: 'hint', text: why }),
    ]);
    if (m === 'rendered') b.classList.add('todo');
    b.addEventListener('click', () => setMode(m));
    buttons.push(b);
    return b;
  });

  const toggle = (label: string, key: keyof RenderOptions, title: string) => {
    const box = el('input', { type: 'checkbox', checked: renderOpts[key] });
    box.addEventListener('change', () => {
      renderOpts[key] = box.checked;
      refreshList();
    });
    return el('label', { class: 'checkrow', title }, [box, el('span', { text: label })]);
  };

  optsBox.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: '정리 옵션' }),
    toggle('사고사슬 제거', 'stripThinking', '<thoughts>, <think> 같은 추론 블록을 숨깁니다'),
    toggle('태그 제거', 'stripTags', 'img를 제외한 모든 태그를 숨깁니다'),
    toggle('코드블록 제거', 'stripPanels', '```로 둘러싼 패널·상태창을 숨깁니다'),
    toggle('강조 렌더', 'markdown', '**굵게**, *기울임*, `코드`를 실제 서식으로 보여 줍니다'),
    toggle('대사·생각 색', 'quotes', '“큰따옴표”는 대사(주황), ‘작은따옴표’는 속마음(하늘색)으로 칠합니다'),
  ]));

  const diffToggle = el('button', { class: 'ghost' });
  const syncDiff = () => {
    diffToggle.textContent = `수정한 턴 전-후 비교: ${showOriginal ? '켬' : '끔'}`;
  };
  syncDiff();
  diffToggle.addEventListener('click', () => {
    showOriginal = !showOriginal;
    syncDiff();
    refreshList();
  });

  const jump = el('input', { placeholder: '턴 번호로 이동' });
  jump.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key !== 'Enter') return;
    const n = Number(jump.value);
    if (Number.isFinite(n)) list?.scrollToSeq(n);
  });

  const root = el('div', {}, [
    el('div', { class: 'card' }, [el('h2', { text: '보기 모드' }), ...rows]),
    optsBox,
    buildRangeCard(),
    el('div', { class: 'card' }, [diffToggle, el('div', { style: { marginTop: '8px' } }, [jump])]),
  ]);
  setMode(viewMode);
  return root;
}

/**
 * Show only turns start..end.
 *
 * Long chats are the normal case here - 394 turns is a real one - and most work
 * happens in a stretch of a few dozen. Narrowing the panel to that stretch is
 * cheaper than scrolling to it repeatedly, and it makes "이 구간을 고쳐 줘"
 * something the user can see the boundaries of before asking.
 */
function buildRangeCard(): HTMLElement {
  const first = state.turns.length ? state.turns[0].seq : 0;
  const last = state.turns.length ? state.turns[state.turns.length - 1].seq : 0;

  const from = el('input', { placeholder: String(first), value: range ? String(range.from) : '' });
  const to = el('input', { placeholder: String(last), value: range ? String(range.to) : '' });
  const hint = el('div', { class: 'hint' });

  const syncHint = () => {
    hint.textContent = range
      ? `${range.from}–${range.to}번만 보이는 중입니다. 찾기·삭제는 각자 범위를 따로 받으니 이 필터에 영향받지 않습니다.`
      : `전체 ${state.totalTurns}턴을 보고 있습니다. 비워 두시면 처음(${first})과 끝(${last})으로 잡습니다.`;
  };
  syncHint();

  // An empty box means "the end of the chat", not 0 - Number('') is 0, and a
  // silent 0 here would blank the panel instead of widening the range.
  const parse = (input: HTMLInputElement, fallback: number): number | null => {
    const raw = input.value.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const apply = () => {
    const a = parse(from, first);
    const b = parse(to, last);
    if (a === null || b === null) {
      notice('턴 번호는 숫자로 넣어 주세요.', 'err');
      return;
    }
    // Accepting them in either order costs nothing and saves a pointless error.
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    if (lo <= first && hi >= last) {
      setRange(null);
      from.value = '';
      to.value = '';
      syncHint();
      return;
    }
    setRange({ from: lo, to: hi });
    from.value = String(lo);
    to.value = String(hi);
    syncHint();
    if (!visibleTurns().length) {
      notice(`${lo}–${hi} 구간에는 턴이 없습니다. 범위를 다시 잡아 주세요.`, 'err');
    } else {
      list?.scrollToSeq(lo);
    }
  };

  const applyBtn = el('button', { class: 'primary', text: '적용' });
  applyBtn.addEventListener('click', apply);
  const allBtn = el('button', { class: 'ghost', text: '전체' });
  allBtn.addEventListener('click', () => {
    from.value = '';
    to.value = '';
    setRange(null);
    syncHint();
  });
  for (const input of [from, to]) {
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') apply();
    });
  }

  return el('div', { class: 'card' }, [
    el('h2', { text: '표시 범위' }),
    el('div', { class: 'rangerow' }, [
      from, el('span', { class: 'hint', text: '~' }), to, applyBtn, allBtn,
    ]),
    hint,
  ]);
}

// --- 찾기 · 바꾸기 -----------------------------------------------------------

function buildFind(): HTMLElement {
  const pattern = el('input', { placeholder: '찾을 문자열' });
  const replacement = el('input', { placeholder: '바꿀 문자열' });
  const fromSeq = el('input', { placeholder: '시작 턴', style: { width: '90px' } });
  const toSeq = el('input', { placeholder: '끝 턴', style: { width: '90px' } });
  const summary = el('div', { class: 'hint' });

  const previewBtn = el('button', { text: '미리보기' });
  const applyBtn = el('button', { class: 'primary', text: '적용', disabled: true });
  const clearBtn = el('button', { class: 'ghost', text: '해제', disabled: true });

  // Literal only. The regex switch is gone: it is the rarely-wanted half of
  // this tool and the half that can hang on a bad pattern.
  const params = (apply = false) => ({
    pattern: pattern.value,
    replacement: replacement.value,
    regex: false,
    fromSeq: fromSeq.value.trim() === '' ? undefined : Number(fromSeq.value),
    toSeq: toSeq.value.trim() === '' ? undefined : Number(toSeq.value),
    ...(apply ? { apply: true } : {}),
  });

  const setPreview = (p: BulkPreview | null) => {
    preview = p ? new Map(p.changes.map((c) => [c.msgId, c.after])) : null;
    applyBtn.disabled = !p || p.matchedTurns === 0;
    clearBtn.disabled = !p;
    summary.textContent = p
      ? (p.matchedTurns ? `${p.matchedTurns}개 턴 · ${p.totalHits}곳 — 왼쪽에 표시했습니다` : '일치하는 턴이 없습니다.')
      : '';
    refreshList();
    if (p?.changes.length) list?.scrollToSeq(p.changes[0].seq);
    refreshToolbar();
  };

  previewBtn.addEventListener('click', async () => {
    if (!pattern.value) { notice('찾을 문자열을 입력해 주세요.'); return; }
    previewBtn.disabled = true;
    try {
      setPreview(await state.bulk(params()));
    } catch (e) {
      summary.textContent = msg(e);
      setPreview(null);
    } finally {
      previewBtn.disabled = false;
    }
  });

  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    try {
      await state.checkpoint('찾기·바꾸기 직전', true);
      const r = await state.bulk(params(true));
      setPreview(null);
      await state.loadTurns();
      notice(`${r.applied}개 턴을 바꿨습니다. 되돌리시려면 🕘 버전의 스냅샷을 쓰시면 됩니다.`, 'ok');
    } catch (e) {
      void clientLog('error', 'find/replace apply failed', { error: msg(e) });
      notice('실패했습니다: ' + msg(e), 'err');
    }
  });

  clearBtn.addEventListener('click', () => setPreview(null));

  return el('div', { class: 'card' }, [
    el('h2', { text: '찾기 · 바꾸기' }),
    el('label', { class: 'field' }, [el('span', { text: '찾기' }), pattern]),
    el('label', { class: 'field' }, [el('span', { text: '바꾸기' }), replacement]),
    el('div', { class: 'row' }, [fromSeq, el('span', { class: 'hint', text: '~' }), toSeq]),
    el('div', { class: 'row' }, [previewBtn, applyBtn, clearBtn]),
    summary,
    el('div', { class: 'hint', text: '범위를 비우면 전체가 대상입니다. 적용 직전에 스냅샷이 자동으로 저장됩니다.' }),
  ]);
}

// --- 턴 일괄 삭제 -------------------------------------------------------------

function buildCut(): HTMLElement {
  const fromSeq = el('input', { placeholder: '시작 턴', style: { width: '90px' } });
  const toSeq = el('input', { placeholder: '끝 턴', style: { width: '90px' } });
  const summary = el('div', { class: 'hint' });

  const previewBtn = el('button', { text: '미리보기' });
  const applyBtn = el('button', { class: 'danger', disabled: true });
  const clearBtn = el('button', { class: 'ghost', text: '해제', disabled: true });

  const range = (): [number, number] | null => {
    // Number('') is 0, not NaN, so an isFinite check alone would read an empty
    // field as "turn 0" and quietly target the first turn.
    if (fromSeq.value.trim() === '' || toSeq.value.trim() === '') return null;
    const a = Number(fromSeq.value);
    const b = Number(toSeq.value);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < a) return null;
    return [a, b];
  };

  const setPreview = (ids: Set<string> | null, label = '') => {
    deleting = ids;
    applyBtn.disabled = !ids || ids.size === 0;
    clearBtn.disabled = !ids;
    summary.textContent = label;
    refreshList();
    refreshToolbar();
  };

  previewBtn.addEventListener('click', () => {
    const r = range();
    if (!r) { notice('삭제할 턴 범위를 올바르게 입력해 주세요.'); return; }
    const [a, b] = r;
    // Computed from turns already in hand - a delete preview needs no round trip.
    const hit = state.turns.filter((t) => t.seq >= a && t.seq <= b);
    setPreview(new Set(hit.map((t) => t.msgId)), `${hit.length}개 턴이 삭제됩니다 — 왼쪽에 표시했습니다`);
    if (hit.length) list?.scrollToSeq(hit[0].seq);
  });

  armed(applyBtn, '적용', '정말 삭제할까요?', async () => {
    const r = range();
    if (!r) return;
    try {
      await state.checkpoint('턴 삭제 직전', true);
      await state.deleteRange(r[0], r[1]);
      setPreview(null);
      notice(`턴 ${r[0]}~${r[1]} 을 지웠습니다. 하이파 요약이 지워진 턴을 인용하고 있으면 반영할 때 알려 드립니다.`, 'ok');
    } catch (e) {
      void clientLog('error', 'deleteRange failed', { range: r, error: msg(e) });
      notice('삭제에 실패했습니다: ' + msg(e), 'err');
    }
  });

  clearBtn.addEventListener('click', () => setPreview(null));

  return el('div', { class: 'card' }, [
    el('h2', { text: '턴 일괄 삭제' }),
    el('div', { class: 'row' }, [fromSeq, el('span', { class: 'hint', text: '~' }), toSeq]),
    el('div', { class: 'row' }, [previewBtn, applyBtn, clearBtn]),
    summary,
    el('div', { class: 'hint', text: '삭제 직전에 스냅샷이 자동으로 저장됩니다.' }),
  ]);
}

// --- 내보내기 -----------------------------------------------------------------

function buildExport(): HTMLElement {
  const md = el('button', { text: 'md 내려받기' });
  md.addEventListener('click', async () => {
    try {
      const r = await state.exportMarkdown();
      host.download(r.filename, r.markdown, 'text/markdown;charset=utf-8');
    } catch (e) { notice('내보내기에 실패했습니다: ' + msg(e), 'err'); }
  });

  const rc = el('button', { text: 'risuChat 내려받기' });
  rc.addEventListener('click', async () => {
    try {
      const r = await state.exportRisuchat();
      host.download(r.filename, JSON.stringify(r.envelope), 'application/json');
    } catch (e) { notice('내보내기에 실패했습니다: ' + msg(e), 'err'); }
  });

  const cb = el('button', { class: 'ghost', text: 'md 클립보드 복사' });
  cb.addEventListener('click', async () => {
    try {
      const r = await state.exportMarkdown();
      const ok = host.copyToClipboard(r.markdown);
      notice(ok ? '클립보드에 복사했습니다.' : '복사에 실패했습니다.', ok ? 'ok' : 'err');
    } catch (e) { notice('복사에 실패했습니다: ' + msg(e), 'err'); }
  });

  return el('div', { class: 'card' }, [
    el('h2', { text: '내보내기' }),
    el('div', { class: 'row' }, [md]),
    el('div', { class: 'row' }, [rc]),
    el('div', { class: 'row' }, [cb]),
    el('div', { class: 'hint', text: 'risuChat JSON은 RisuAI 기본 임포터가 그대로 받아 줍니다.' }),
  ]);
}
