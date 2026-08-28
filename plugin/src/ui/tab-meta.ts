/**
 * The card's prose - name, description, greetings and the rest, one row each.
 *
 * Same shape as the memory tab: rows on the left, one big editor in the
 * middle, the agent on the right. Every save goes to the working copy; the
 * bot bar's 반영 is what reaches RisuAI.
 */
import { el, clear, armed, refocusSearch, focusButton, diffCard } from './dom';
import { setToolbarSearch } from './shell';
import { state, type CardField } from '../state';
import { threePane } from './panes';
import { conflictBox } from './conflicts';
import { bindAgent, mountAgent } from './agentpane';

// personality/scenario/exampleMessage/systemPrompt/PHI are retired fields
// (import compatibility only) and the backend no longer sends rows for them.
const LABELS: Record<string, string> = {
  name: '이름',
  desc: '설명 (desc)',
  firstMessage: '퍼스트 메시지',
  creatorNotes: '제작자 노트',
  characterVersion: '봇 버전',
  replaceGlobalNote: '글로벌 노트 덮어쓰기',
  alternateGreetings: '대체 인사말',
};

// Card fields, but not meta: the Regex tab owns them (they live next to the
// display scripts that usually come with them).
const NOT_HERE = new Set(['backgroundHTML']);

/** Row order on the left; 100+ sits below the rule. */
const FIELD_RANK: Record<string, number> = {
  name: 0,
  desc: 10,
  firstMessage: 20,
  alternateGreetings: 21,
  replaceGlobalNote: 30,
  characterVersion: 100,
  creatorNotes: 110,
};

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let openId = '';
let fields: CardField[] = [];
let full = true;
let seenEpoch = -1;
let seenKey = '';
let filterText = '';

export function renderMetaTab(mount: HTMLElement): void {
  if (!state.botKey) {
    clear(mount);
    built = false;
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 패널을 연 봇이 있어야 합니다. RisuAI에서 봇을 열고 다시 여세요.' }),
    ]));
    return;
  }

  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree' });
    pane.left.appendChild(treeMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(viewMount);
    mount.appendChild(pane.root);
    built = true;
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    void refresh();
  } else if (seenEpoch !== state.epoch || seenKey !== state.botKey) {
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    openId = '';
    if (viewMount) clear(viewMount);
    void refresh();
  }

  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

async function refresh(): Promise<void> {
  if (!treeMount) return;
  clear(treeMount);
  treeMount.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '읽는 중입니다…' }));
  try {
    const r = await state.cardFields();
    fields = r.fields.filter((f) => !NOT_HERE.has(f.field));
    full = r.full;
    drawTree();
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
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
      await refresh();
      const fresh = fields.find((f) => f.id === made.id);
      if (fresh) open(fresh);
    } catch (e) {
      notice('추가하지 못했습니다: ' + msg(e), 'err');
    }
  });
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  treeMount.appendChild(el('div', { class: 'treehead' }, [addGreet, reloadBtn]));

  if (!full) {
    treeMount.appendChild(el('div', {
      class: 'notice', style: { margin: '8px' },
      text: '구버전 업로드 상태입니다. 패널을 닫았다 다시 열면 전체 카드로 갱신됩니다.',
    }));
  }

  setToolbarSearch(filterText, (v) => {
    filterText = v;
    drawTree();
    refocusSearch(null);
  }, '찾기 (이름·본문)');
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
    const name = el('button', {
      class: 'treefile' + (f.id === openId ? ' on' : ''),
      text: labelOf(f) + (f.body ? '' : ' (비어 있음)'),
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

function open(f: CardField): void {
  if (!viewMount) return;
  openId = f.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === f.id);
  }

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
        : '저장했습니다. 봇 바의 “반영”을 누르면 RisuAI에 쓰입니다.', 'ok');
      await refresh();
      const fresh = fields.find((x) => x.id === f.id);
      if (fresh) open(fresh);
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
        await refresh();
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
      }, () => { void refresh(); })
    : null;

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    conflict,
    el('h2', {}, [el('span', { text: labelOf(f) }), el('span', { class: 'spacer' }),
                  f.field === 'name' ? null : focusButton(body, labelOf(f))]),
    ...(f.deleted ? [el('div', { class: 'notice', text: '삭제 예정입니다. 저장하면 삭제가 취소됩니다.' })] : []),
    el('label', { class: 'field' }, [body]),
    ...(diff ? [diff] : []),
    el('div', { class: 'row' }, buttons),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
