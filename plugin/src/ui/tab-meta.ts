/**
 * The card's prose - name, description, greetings and the rest, one row each.
 *
 * Same shape as the memory tab: rows on the left, one big editor in the
 * middle, the agent on the right. Every save goes to the working copy; the
 * bot bar's 반영 is what reaches RisuAI.
 */
import { el, clear, armed, refocusSearch, focusButton, diffCard } from './dom';
import { state, type CardField } from '../state';
import { conflictBox } from './conflicts';
import { makeTab, savedText, type NoticeKind, type TabUi } from './kit';
import { decodeLoreSettings, encodeLoreSettings, LORE_SETTINGS_DEFAULTS, LORE_SETTINGS_FIELD } from '../cardfields';

// personality/scenario/PHI are retired fields (import compatibility only)
// and the backend no longer sends rows for them. systemPrompt and
// exampleMessage came back in §1-66: RisuAI's editor shows both, and a
// non-empty systemPrompt replaces the preset's main prompt.
const LABELS: Record<string, string> = {
  name: '이름',
  desc: '설명 (desc)',
  firstMessage: '퍼스트 메시지',
  creatorNotes: '제작자 노트',
  characterVersion: '봇 버전',
  replaceGlobalNote: '글로벌 노트 덮어쓰기',
  systemPrompt: '시스템 프롬프트 (메인 프롬프트 대체)',
  exampleMessage: '예시 대화',
  defaultVariables: '기본 변수',
  translatorNote: '번역가 노트',
  lowLevelAccess: '저수준 접근 (Lua)',
  loreSettings: '로어북 설정',
  alternateGreetings: '대체 인사말',
};

/** A one-line reminder of the format, above the editor. */
const HINTS: Record<string, string> = {
  defaultVariables: '한 줄에 하나, 이름=값. 채팅 변수가 없을 때 쓰는 기본값입니다 (RisuAI 기본 변수).',
  systemPrompt: '비어 있지 않으면 프리셋의 메인 프롬프트를 통째로 대체합니다. {{original}} 자리에 원래 메인 프롬프트가 들어갑니다.',
  exampleMessage: 'RisuAI 의 예시 대화 칸입니다. <START> 로 예시를 나눕니다.',
};

// Card fields, but not meta: the Regex tab owns backgroundHTML (it lives
// next to the display scripts that usually come with it) and the assets tab
// shows the profile picture (`image`, replaced from there).
const NOT_HERE = new Set(['backgroundHTML', 'image']);

/** Row order on the left; 100+ sits below the rule. */
const FIELD_RANK: Record<string, number> = {
  name: 0,
  desc: 10,
  firstMessage: 20,
  alternateGreetings: 21,
  exampleMessage: 22,
  replaceGlobalNote: 30,
  systemPrompt: 31,
  defaultVariables: 40,
  characterVersion: 100,
  creatorNotes: 110,
  translatorNote: 115,
  lowLevelAccess: 120,
  loreSettings: 121,
};

let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let openId = '';
let fields: CardField[] = [];
let full = true;
let filterText = '';
let ui: TabUi | null = null;

function notice(text: string, kind: NoticeKind = ''): void {
  ui?.notice(text, kind);
}

export const renderMetaTab = makeTab({
  gate: 'bot',
  keys: () => [state.epoch, state.botKey],
  search: {
    placeholder: '찾기 (이름·본문)',
    get: () => filterText,
    set: (v) => { filterText = v; drawTree(); refocusSearch(null); },
  },
  build(pane, u) {
    ui = u;
    treeMount = el('div', { class: 'tree' });
    pane.left.appendChild(treeMount);
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(viewMount);
  },
  async refresh() {
    await refreshNow();
  },
});

async function refreshNow(): Promise<void> {
  if (!treeMount) return;
  clear(treeMount);
  treeMount.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '읽는 중입니다…' }));
  try {
    const r = await state.cardFields();
    fields = r.fields.filter((f) => !NOT_HERE.has(f.field));
    full = r.full;
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    return;
  }
  drawTree();
  const fresh = fields.find((x) => x.id === openId);
  if (fresh) open(fresh);
  else if (openId && viewMount) { openId = ''; clear(viewMount); }
}

function labelOf(f: CardField): string {
  if (f.field === 'alternateGreetings') return `대체 인사말 #${f.seq + 1}`;
  return LABELS[f.field] || f.field;
}

function drawTree(): void {
  if (!treeMount) return;
  clear(treeMount);

  const addGreet = el('button', { class: 'primary tiny', text: '인사말 추가' });
  addGreet.addEventListener('click', async () => {
    try {
      const made = await state.addGreeting('');
      await refreshNow();
      const fresh = fields.find((f) => f.id === made.id);
      if (fresh) open(fresh);
    } catch (e) {
      notice('추가하지 못했습니다: ' + msg(e), 'err');
    }
  });
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refreshNow());
  treeMount.appendChild(el('div', { class: 'treehead' }, [addGreet, reloadBtn]));

  if (!full) {
    treeMount.appendChild(el('div', {
      class: 'notice', style: { margin: '8px' },
      text: '구버전 업로드 상태입니다. 패널을 닫았다 다시 열면 전체 카드로 갱신됩니다.',
    }));
  }

  const needle = filterText.trim().toLowerCase();
  const shown = fields.filter((f) => !needle
    || labelOf(f).toLowerCase().includes(needle)
    || f.body.toLowerCase().includes(needle));

  // The order a person reads a card in, not the order the schema lists it:
  // what the bot is, what it says, the note that overrides the global one -
  // then, below a rule, the housekeeping fields (version, creator's notes).
  shown.sort((a, b) => (FIELD_RANK[a.field] ?? 50) - (FIELD_RANK[b.field] ?? 50) || a.seq - b.seq);
  let ruled = false;
  for (const f of shown) {
    if (!ruled && (FIELD_RANK[f.field] ?? 50) >= 100) {
      ruled = true;
      treeMount.appendChild(el('div', { class: 'sectionline', style: { margin: '8px 6px' } }));
    }
    const suffix = f.field === 'lowLevelAccess' ? (f.body === '1' ? ' (켬)' : ' (끔)')
      : f.field === LORE_SETTINGS_FIELD ? (f.body ? ' (봇 설정)' : ' (글로벌)')
      : (f.body ? '' : ' (비어 있음)');
    const name = el('button', {
      class: 'treefile' + (f.id === openId ? ' on' : ''),
      text: labelOf(f) + suffix,
      title: f.id,
    });
    name.addEventListener('click', () => open(f));
    const row = el('div', { class: 'treerow' }, [name]);
    if (f.deleted) row.appendChild(el('span', { class: 'badge', text: '삭제 예정' }));
    else if (f.isNew) row.appendChild(el('span', { class: 'badge warn', text: '추가' }));
    else if (f.changed) row.appendChild(el('span', { class: 'badge warn', text: '수정' }));
    treeMount.appendChild(row);
  }
}

async function saveTyped(f: CardField, value: string, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    await state.saveCardField(f.id, value);
    notice(savedText('카드 필드를'), 'ok');
    await refreshNow();
  } catch (e) {
    notice('저장하지 못했습니다: ' + msg(e), 'err');
  } finally {
    btn.disabled = false;
  }
}

/** lowLevelAccess: one checkbox. The row text is "1" / "0". */
function openBool(f: CardField): void {
  if (!viewMount) return;
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = f.body === '1';
  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', () => void saveTyped(f, box.checked ? '1' : '0', save));
  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, [el('span', { text: labelOf(f) })]),
    el('div', { class: 'hint', text: 'Lua 트리거가 저수준 API 를 쓰려면 켜야 합니다. RisuAI 는 켜진 봇에 경고를 띄웁니다.' }),
    el('label', { class: 'field row' }, [box, el('span', { text: '저수준 접근 허용' })]),
    ...(f.changed ? [el('div', { class: 'hint diffmeta', text: `기준선: ${f.original === '1' ? '켬' : '끔'}` })] : []),
    el('div', { class: 'row' }, [save]),
  ]));
}

/** loreSettings: 글로벌 설정 사용, or the bot's own four values. */
function openLoreSettings(f: CardField): void {
  if (!viewMount) return;
  const cur = decodeLoreSettings(f.body);
  const useGlobal = el('input', { type: 'checkbox' }) as HTMLInputElement;
  useGlobal.checked = cur === null;
  const v = cur ?? { ...LORE_SETTINGS_DEFAULTS };
  const recursive = el('input', { type: 'checkbox' }) as HTMLInputElement;
  recursive.checked = v.recursiveScanning;
  const fullWord = el('input', { type: 'checkbox' }) as HTMLInputElement;
  fullWord.checked = v.fullWordMatching;
  const depth = el('input', { type: 'number', min: '0', max: '20', value: String(v.scanDepth) }) as HTMLInputElement;
  const budget = el('input', { type: 'number', min: '0', max: '4096', value: String(v.tokenBudget) }) as HTMLInputElement;
  const own = el('div', { class: 'card', style: { marginTop: '8px' } }, [
    el('label', { class: 'field row' }, [recursive, el('span', { text: '재귀 검색 (recursiveScanning)' })]),
    el('label', { class: 'field row' }, [fullWord, el('span', { text: '전체 단어 일치 (fullWordMatching)' })]),
    el('label', { class: 'field' }, [el('span', { text: '스캔 깊이 (scanDepth, 0–20)' }), depth]),
    el('label', { class: 'field' }, [el('span', { text: '토큰 예산 (tokenBudget, 0–4096)' }), budget]),
  ]);
  const sync = (): void => { own.hidden = useGlobal.checked; };
  useGlobal.addEventListener('change', sync);
  sync();
  const clamp = (input: HTMLInputElement, lo: number, hi: number, fallback: number): number => {
    const n = parseInt(input.value, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
  };
  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', () => void saveTyped(f, useGlobal.checked ? '' : encodeLoreSettings({
    recursiveScanning: recursive.checked, fullWordMatching: fullWord.checked,
    scanDepth: clamp(depth, 0, 20, LORE_SETTINGS_DEFAULTS.scanDepth),
    tokenBudget: clamp(budget, 0, 4096, LORE_SETTINGS_DEFAULTS.tokenBudget),
  }), save));
  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, [el('span', { text: labelOf(f) })]),
    el('div', { class: 'hint', text: 'RisuAI 로어북 탭의 설정 칸입니다. 글로벌 설정을 끄면 이 봇만의 값을 씁니다. 배포 전에는 보통 재귀 검색을 끕니다.' }),
    el('label', { class: 'field row' }, [useGlobal, el('span', { text: '글로벌 설정 사용' })]),
    own,
    ...(f.changed ? [el('div', { class: 'hint diffmeta', text: `기준선: ${f.original ? f.original.replace(/\n/g, ' · ') : '글로벌 설정 사용'}` })] : []),
    el('div', { class: 'row' }, [save]),
  ]));
}

function open(f: CardField): void {
  if (!viewMount) return;
  const was = openId;
  openId = f.id;
  if (was !== f.id) drawTree();
  if (f.field === 'lowLevelAccess') { openBool(f); return; }
  if (f.field === LORE_SETTINGS_FIELD) { openLoreSettings(f); return; }

  const body = el('textarea', {
    value: f.body,
    style: { minHeight: f.field === 'name' ? '48px' : '340px' },
  }) as HTMLTextAreaElement;

  const save = el('button', { class: 'primary', text: '저장' });
  save.addEventListener('click', async () => {
    (save as HTMLButtonElement).disabled = true;
    try {
      await state.saveCardField(f.id, body.value);
      notice(f.deleted
        ? '저장했습니다. 삭제 표시는 해제되었습니다.'
        : savedText('카드 필드를'), 'ok');
      await refreshNow();
    } catch (e) {
      notice('저장하지 못했습니다: ' + msg(e), 'err');
    } finally {
      (save as HTMLButtonElement).disabled = false;
    }
  });

  const buttons: HTMLElement[] = [save];
  if (f.field === 'alternateGreetings' && !f.deleted) {
    const del = el('button', { class: 'ghost' });
    armed(del, '삭제', '정말 지울까요?', async () => {
      try {
        await state.deleteGreeting(f.id);
        openId = '';
        if (viewMount) clear(viewMount);
        await refreshNow();
      } catch (e) {
        notice('삭제하지 못했습니다: ' + msg(e), 'err');
      }
    });
    buttons.push(del);
  }

  // What changed, not just that it did: the badge on the row says 수정, and
  // this says which lines.
  const diff = f.changed && !f.conflict ? diffCard(f.original, f.body) : null;
  const conflict = f.conflict
    ? conflictBox({
        kind: 'card_field', id: f.id, label: labelOf(f), charKey: state.botKey, chatKey: null,
        reason: String((f.conflict as Record<string, unknown>).kind ?? ''), tier: '',
        mine: f.body, theirs: (f.conflict as Record<string, unknown>).theirs ?? null,
        base: (f.conflict as Record<string, unknown>).base ?? null, canTakeTheirs: true,
      }, () => { void refreshNow(); })
    : null;

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    conflict,
    el('h2', {}, [el('span', { text: labelOf(f) }), el('span', { class: 'spacer' }),
                  f.field === 'name' ? null : focusButton(body, labelOf(f))]),
    ...(f.deleted ? [el('div', { class: 'notice', text: '삭제 예정입니다. 저장하면 삭제가 취소됩니다.' })] : []),
    ...(HINTS[f.field] ? [el('div', { class: 'hint', text: HINTS[f.field] })] : []),
    el('label', { class: 'field' }, [body]),
    ...(diff ? [diff] : []),
    el('div', { class: 'row' }, buttons),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
