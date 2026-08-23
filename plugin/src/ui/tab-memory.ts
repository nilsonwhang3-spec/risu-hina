/**
 * The long-term memory view.
 *
 * RisuAI's hypa/supa summaries are what the model actually reads about the
 * early part of a long chat - by the time a chat is 400 turns, the summaries
 * matter more to the next reply than most of the transcript does. A wrong fact
 * in a summary quietly poisons everything after it, and until now the only way
 * to fix one was to export the chat and edit JSON.
 *
 * They are rows in the database, exactly like turns, for exactly the same
 * reasons (see memory.py). So this view is the transcript view's smaller
 * sibling: list on the left, the entry in the middle, agent on the right, and a
 * diff against the frozen original.
 */
import { el, clear, armed } from './dom';
import { state, type MemoryItem } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { setToolbar } from './shell';

const KIND_LABEL: Record<string, string> = {
  hypaV3Data: 'HypaV3',
  hypaV2Data: 'HypaV2',
  supaMemoryData: 'SupaMemory',
  supaMemory: 'SupaMemory',
  lastMemory: '최근 요약',
};

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let toolbar: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let openId = '';
let items: MemoryItem[] = [];
let seenEpoch = -1;

export function renderMemoryTab(mount: HTMLElement): void {
  if (!state.activeChatKey) {
    clear(mount);
    built = false;
    setToolbar(null);
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 “챗 선택” 탭에서 챗을 골라 주세요.' }),
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
    buildToolbar();
    built = true;
    seenEpoch = state.epoch;
    void refresh();
  } else if (seenEpoch !== state.epoch) {
    // A restore, a reset, a commit or an approved proposal changed the rows
    // underneath this list; what it shows is stale until it reloads.
    seenEpoch = state.epoch;
    void refresh();
  }

  if (toolbar) setToolbar(toolbar);
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

/**
 * Only a reload here. Writing the memory back is the chat bar's 반영, the same
 * verb that writes the turns and the lorebook - this tab used to carry a 반영
 * of its own with a narrower meaning, and two buttons with one label is how a
 * user writes the memory while believing the turns went too.
 */
function buildToolbar(): void {
  countEl = el('span', { class: 'dim' });

  const reloadBtn = el('button', { class: 'tool', title: '백엔드에서 다시 읽어 옵니다' }, [
    el('span', { class: 'glyph', text: '↻' }),
    el('span', { class: 'tool-label', text: '새로고침' }),
  ]);
  reloadBtn.addEventListener('click', () => void refresh());

  toolbar = el('div', { class: 'toolrow' }, [
    reloadBtn, el('span', { class: 'spacer' }), countEl,
  ]);
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
    const r = await state.memory();
    // Variables are the same rows but their own tab (챗 변수); here only the
    // summaries, and the count only counts them.
    items = r.items.filter((i) => i.kind !== 'scriptstate');
    drawTree(items.filter((i) => i.changed || i.isNew).length);
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

function drawTree(changed: number): void {
  if (!treeMount) return;
  clear(treeMount);

  if (countEl) {
    countEl.textContent = items.length
      ? `${items.length}개${changed ? ` · 수정 ${changed}` : ''}`
      : '없음';
  }

  const add = el('button', { class: 'primary tiny', text: '새 항목' });
  add.addEventListener('click', () => void create());
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  treeMount.appendChild(el('div', { class: 'treehead' }, [add, reloadBtn]));

  if (!items.length) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: '이 챗에는 장기기억이 없습니다. RisuAI에서 하이파나 수파 메모리를 켜야 생깁니다.',
    }));
    return;
  }

  const kinds = [...new Set(items.map((i) => i.kind))];
  for (const kind of kinds) {
    const group = items.filter((i) => i.kind === kind);
    treeMount.appendChild(el('div', {
      class: 'treescope',
      text: `${KIND_LABEL[kind] ?? kind} · ${group.length}`,
    }));
    for (const item of group) treeMount.appendChild(itemRow(item));
  }
}

function itemRow(item: MemoryItem): HTMLElement {
  const name = el('button', {
    class: 'treefile' + (item.id === openId ? ' on' : ''),
    text: `${item.seq}. ${item.title}`,
    title: item.id,
  });
  name.addEventListener('click', () => open(item));
  const row = el('div', { class: 'treerow' }, [name]);
  if (item.isNew) row.appendChild(el('span', { class: 'badge ok', text: '추가' }));
  else if (item.changed) row.appendChild(el('span', { class: 'badge warn', text: '수정' }));
  return row;
}

function open(item: MemoryItem): void {
  if (!viewMount) return;
  openId = item.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === item.id);
  }

  const body = el('textarea', { value: item.body, style: { minHeight: '300px' } });
  const count = el('div', { class: 'hint' });
  const sync = () => { count.textContent = `${body.value.length}자`; };
  body.addEventListener('input', sync);
  sync();

  const save = el('button', { class: 'primary', text: '저장' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveMemory(item.id, body.value);
      notice('저장했습니다. 위 “반영”을 누르면 턴·로어북과 함께 RisuAI에 쓰입니다.', 'ok');
      await refresh();
      // Re-open from the refreshed list. Without this the pane still shows the
      // pre-save item, so the diff against the original - the thing that says
      // what was just changed - does not appear until the entry is reopened.
      const fresh = items.find((i) => i.id === item.id);
      if (fresh) open(fresh);
    } catch (e) {
      notice('저장하지 못했습니다: ' + msg(e), 'err');
    } finally {
      save.disabled = false;
    }
  });

  const revert = el('button', { class: 'ghost', text: '원래대로' });
  revert.disabled = item.original === null;
  revert.addEventListener('click', () => {
    body.value = item.original ?? '';
    sync();
  });

  const del = el('button', { class: 'ghost' });
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteMemory(item.id);
      openId = '';
      if (viewMount) clear(viewMount);
      await refresh();
    } catch (e) {
      notice('삭제하지 못했습니다: ' + msg(e), 'err');
    }
  });

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, [
      el('span', { text: `${KIND_LABEL[item.kind] ?? item.kind} · ${item.seq}번 항목` }),
    ]),
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '이 요약이 모델이 실제로 읽는 “옛날 일”입니다. 여기 틀린 사실이 있으면 이후 답변이 계속 그 위에 쌓입니다.',
    ]),
    body, count,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save, revert, del]),
  ]));

  if (item.changed && item.original !== null) {
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: '원본' }),
      el('pre', { class: 'mono filepreview', text: item.original }),
    ]));
  }
}

async function create(): Promise<void> {
  const kind = items[0]?.kind || 'hypaV3Data';
  try {
    const made = await state.addMemory(kind, '');
    await refresh();
    open(made);
  } catch (e) {
    notice('만들지 못했습니다: ' + msg(e), 'err');
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
