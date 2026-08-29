/**
 * Chat variables - `chat.scriptstate`, the key/value store that `{{setvar}}`,
 * triggers and Lua scripts write to.
 *
 * The long-term memory view's smaller sibling, and the same rows underneath:
 * a variable is a memory row of kind `scriptstate` (memory.py), so the
 * baseline, the diff, the snapshot and the write-back are all the ones the
 * summaries already have. What differs is the shape on screen. A summary is
 * prose and wants a pane; a variable is a key and a short value and wants a
 * row it can be edited in. So this is a table, not a tree.
 *
 * Keys that start with `$` are the ones `{{getvar}}` reads; the rest belong
 * to whatever trigger or script wrote them. Both are shown, because a wrong
 * flag from a trigger poisons the next reply exactly like a wrong summary.
 */
import { el, clear, armed, refocusSearch } from './dom';
import { state, type MemoryItem } from '../state';
import { makeTab, savedText, type NoticeKind, type TabUi } from './kit';

const KIND = 'scriptstate';

let listMount: HTMLElement | null = null;
let items: MemoryItem[] = [];
let filter = '';
let ui: TabUi | null = null;

function notice(text: string, kind: NoticeKind = ''): void {
  ui?.notice(text, kind);
}

export const renderVarsTab = makeTab({
  gate: 'chat',
  keys: () => [state.epoch, state.activeChatKey],
  // No left column: the list is the content, so it takes the middle.
  noLeft: true,
  search: {
    placeholder: '변수 찾기',
    get: () => filter,
    set: (v) => { filter = v; draw(); refocusSearch(null); },
  },
  build(pane, u) {
    ui = u;
    listMount = el('div', { class: 'pad' });
    pane.centre.appendChild(listMount);
  },
  async refresh() {
    if (!listMount) return;
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.memory();
      items = r.items.filter((i) => i.kind === KIND);
      draw();
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  },
});

async function refreshNow(): Promise<void> {
  try {
    const r = await state.memory();
    items = r.items.filter((i) => i.kind === KIND);
  } catch (e) {
    notice(msg(e), 'err');
  }
  draw();
}

function draw(): void {
  if (!listMount) return;
  clear(listMount);

  const q = filter.trim().toLowerCase();
  const shown = q
    ? items.filter((i) => i.title.toLowerCase().includes(q) || i.body.toLowerCase().includes(q))
    : items;

  const changed = items.filter((i) => i.changed || i.isNew).length;
  const head = el('h2', {}, [
    el('span', { text: '챗 변수' }),
    el('span', { class: 'hint', style: { marginLeft: '8px' },
      text: items.length
        ? `${items.length}개${changed ? ` · 수정 ${changed}` : ''}${q ? ` · 표시 ${shown.length}` : ''}`
        : '없음' }),
  ]);

  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refreshNow());

  const card = el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [head, el('span', { class: 'spacer' }), reloadBtn]),
    el('div', {
      class: 'hint', style: { marginBottom: '8px' },
      text: '`$`로 시작하는 키가 {{getvar}}가 읽는 변수입니다. 나머지는 트리거·Lua가 쓴 값입니다.',
    }),
  ]);

  if (!items.length) {
    card.appendChild(el('div', { class: 'hint', text: '이 챗에는 변수가 없습니다. 봇이 {{setvar}}를 쓰지 않으면 비어 있는 것이 정상입니다.' }));
  } else if (!shown.length) {
    card.appendChild(el('div', { class: 'hint', text: `“${filter}” 에 맞는 변수가 없습니다.` }));
  } else {
    const table = el('div', { class: 'vartable' });
    for (const item of shown) table.appendChild(varRow(item));
    card.appendChild(table);
  }
  card.appendChild(buildAdd());
  listMount.appendChild(card);
}

function typeLabel(t: string | null | undefined): string {
  switch (t) {
    case 'number': return '숫자';
    case 'bool': return '참/거짓';
    case 'json': return 'JSON';
    case 'null': return 'null';
    default: return '문자열';
  }
}

function varRow(item: MemoryItem): HTMLElement {
  const value = el('input', { value: item.body, class: 'mono' });
  const save = el('button', { class: 'primary tiny', text: '저장' });
  save.disabled = true;
  value.addEventListener('input', () => { save.disabled = value.value === item.body; });
  const commit = async () => {
    if (value.value === item.body) return;
    save.disabled = true;
    try {
      await state.saveMemory(item.id, value.value);
      notice(savedText(`${item.title} 을(를)`), 'ok');
      await refreshNow();
    } catch (e) {
      notice('저장하지 못했습니다: ' + msg(e), 'err');
      save.disabled = false;
    }
  };
  save.addEventListener('click', () => void commit());
  value.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void commit(); });

  const revert = el('button', { class: 'ghost tiny', text: '원래대로', title: item.original ?? '' });
  revert.disabled = !item.changed;
  revert.addEventListener('click', async () => {
    if (item.original === null) return;
    try {
      await state.saveMemory(item.id, item.original);
      await refreshNow();
    } catch (e) {
      notice('되돌리지 못했습니다: ' + msg(e), 'err');
    }
  });

  const del = el('button', { class: 'ghost tiny' });
  armed(del, '삭제', '정말?', async () => {
    try {
      await state.deleteMemory(item.id);
      notice(`${item.title} 을(를) 지웠습니다. 반영하면 RisuAI에서도 사라집니다.`, 'ok');
      await refreshNow();
    } catch (e) {
      notice('삭제하지 못했습니다: ' + msg(e), 'err');
    }
  });

  const badge = item.isNew
    ? el('span', { class: 'badge ok', text: '추가' })
    : item.changed ? el('span', { class: 'badge warn', text: '수정' }) : el('span');

  return el('div', { class: 'varrow' + (item.changed || item.isNew ? ' changed' : '') }, [
    el('div', { class: 'varkey mono', text: item.title, title: item.id }),
    el('div', { class: 'vartype hint', text: typeLabel(item.valueType) }),
    el('div', { class: 'varvalue' }, [value]),
    el('div', { class: 'varops' }, [badge, save, revert, del]),
  ]);
}

function buildAdd(): HTMLElement {
  const key = el('input', { placeholder: '$이름', class: 'mono' });
  const value = el('input', { placeholder: '값 (문자열로 저장됩니다)', class: 'mono' });
  const add = el('button', { class: 'tiny', text: '변수 추가' });
  add.addEventListener('click', async () => {
    const k = key.value.trim();
    if (!k) { notice('변수 이름을 입력해 주세요.', 'err'); return; }
    add.disabled = true;
    try {
      await state.addMemory(KIND, value.value, k);
      key.value = ''; value.value = '';
      notice(`${k} 을(를) 추가했습니다.`, 'ok');
      await refreshNow();
    } catch (e) {
      notice('추가하지 못했습니다: ' + msg(e), 'err');
    } finally {
      add.disabled = false;
    }
  });
  return el('div', { class: 'varadd row', style: { marginTop: '10px' } }, [key, value, add]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
