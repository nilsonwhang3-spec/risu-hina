/**
 * The chat lorebook view.
 *
 * Rarely opened by hand - most chats have no local lore at all - but it has to
 * exist, because the agent can write here and anything the agent writes needs a
 * place a person can check it.
 *
 * **Only this chat's lore.** A character's `globalLore` belongs to the bot, not
 * to the conversation, and editing it here would change every chat of that bot
 * from a screen that says "챗 로어북". Bot-level editing is its own job with its
 * own write path (`setCharacterToIndex`), and it is deliberately not here yet.
 *
 * The tree groups by the entry's own `folder`, which is what RisuAI's lorebook
 * UI groups on. Entries without one fall into a single unnamed group rather
 * than each becoming its own - a folder per entry is a list with extra
 * indentation.
 */
import { el, clear, armed } from './dom';
import { state, type LoreEntry } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { renderMarkdown } from './markdown';

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let openId = '';
let entries: LoreEntry[] = [];
let seenEpoch = -1;

export function renderLoreTab(mount: HTMLElement): void {
  if (!state.activeCharKey) {
    clear(mount);
    built = false;
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
    built = true;
    seenEpoch = state.epoch;
    void refresh();
  } else if (seenEpoch !== state.epoch) {
    // A restore, a reset, a commit or an approved proposal changed the rows
    // underneath this list; what it shows is stale until it reloads.
    seenEpoch = state.epoch;
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
    entries = await state.lore('local');
    drawTree();
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

function titleOf(e: LoreEntry): string {
  const entry = e.entry as Record<string, any>;
  const raw = String(entry.comment || entry.name || entry.key || entry.keys || '').trim();
  return raw ? raw.slice(0, 60) : '(이름 없음)';
}

function folderOf(e: LoreEntry): string {
  const entry = e.entry as Record<string, any>;
  return String(entry.folder || entry.folderId || '').trim();
}

/** A folder in RisuAI is itself an entry, with mode 'folder'. */
function isFolder(e: LoreEntry): boolean {
  return String((e.entry as Record<string, any>).mode || '') === 'folder';
}

/**
 * Folder id -> the name a person gave it.
 *
 * The `folder` field holds an id, and ids here are long generated strings. The
 * tree was showing them raw, which made every group header a wall of
 * characters that says nothing. The folder's own entry carries the name; when
 * there is no such entry - a group whose folder entry was deleted, which
 * RisuAI allows - a short prefix is at least distinguishable and honest about
 * being an id.
 */
function folderNames(all: LoreEntry[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of all) {
    if (!isFolder(e)) continue;
    const entry = e.entry as Record<string, any>;
    const id = String(entry.id || entry.folder || entry.folderId || '').trim();
    const label = String(entry.comment || entry.name || entry.key || '').trim();
    if (id && label) names.set(id, label);
  }
  return names;
}

function shortId(id: string): string {
  return id.length > 10 ? `폴더 ${id.slice(0, 6)}…` : `폴더 ${id}`;
}

function drawTree(): void {
  if (!treeMount) return;
  clear(treeMount);

  const add = el('button', { class: 'primary tiny', text: '새 항목' });
  add.addEventListener('click', () => void create());
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  treeMount.appendChild(el('div', { class: 'treehead' }, [add, reloadBtn]));

  if (!entries.length) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: '이 챗의 로어북 항목이 없습니다. 대부분의 챗은 비어 있는 것이 정상입니다.',
    }));
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '0 8px 8px' },
      text: '봇 전체 로어북은 여기서 다루지 않습니다 — 봇 단위 편집은 따로 만듭니다.',
    }));
    return;
  }

  const names = folderNames(entries);
  // A folder entry is a container, not content: it is never injected into the
  // prompt, and listing it beside its own children reads as a duplicate.
  const items = entries.filter((e) => !isFolder(e));
  treeMount.appendChild(el('div', { class: 'treescope', text: `이 챗 · ${items.length}` }));

  // Group by folder, but only draw folder headers when at least one entry has
  // one - a single "(폴더 없음)" header is noise.
  const byFolder = new Map<string, LoreEntry[]>();
  for (const e of items) {
    const f = folderOf(e);
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f)!.push(e);
  }
  const named = [...byFolder.keys()].filter(Boolean);
  for (const [folder, group] of byFolder) {
    if (folder && named.length) {
      const label = names.get(folder) || shortId(folder);
      const head = el('button', { class: 'treebranch', title: folder }, [
        el('span', { class: 'grow', text: label }),
        el('span', { class: 'hint', text: String(group.length) }),
      ]);
      const kids = el('div', { class: 'treekids' }, group.map(entryRow));
      head.addEventListener('click', () => {
        kids.style.display = kids.style.display === 'none' ? 'block' : 'none';
      });
      treeMount.appendChild(el('div', {}, [head, kids]));
    } else {
      for (const e of group) treeMount.appendChild(entryRow(e));
    }
  }
}

function entryRow(e: LoreEntry): HTMLElement {
  const name = el('button', {
    class: 'treefile' + (e.id === openId ? ' on' : ''),
    text: titleOf(e),
    title: e.id,
  });
  name.addEventListener('click', () => open(e));
  const row = el('div', { class: 'treerow' }, [name]);
  if (e.origin !== 'original') {
    row.appendChild(el('span', { class: 'badge warn', text: e.origin === 'added' ? '추가' : '수정' }));
  }
  return row;
}

function open(e: LoreEntry): void {
  if (!viewMount) return;
  openId = e.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === e.id);
  }

  const entry = e.entry as Record<string, any>;
  const keys = el('input', { value: String(entry.key ?? entry.keys ?? '') });
  const comment = el('input', { value: String(entry.comment ?? entry.name ?? '') });
  const content = el('textarea', {
    value: String(entry.content ?? ''),
    style: { minHeight: '260px' },
  });

  const preview = el('div', { class: 'card' });
  const drawPreview = () => {
    clear(preview);
    preview.appendChild(el('h2', { text: '미리보기' }));
    preview.appendChild(renderMarkdown(content.value));
  };
  content.addEventListener('input', drawPreview);

  const save = el('button', { class: 'primary', text: '저장' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      // The entry is written back whole. A lorebook entry has fields we do not
      // model, and a field-wise merge would have to know all of them.
      await state.saveLore(e.id, {
        ...entry,
        key: keys.value,
        comment: comment.value,
        content: content.value,
      });
      notice('저장했습니다. 위 “반영”을 누르면 턴·장기기억과 함께 RisuAI에 쓰입니다.', 'ok');
      await refresh();
      // Re-open from the refreshed list so the row's edited badge and the pane
      // agree about what is stored.
      const fresh = entries.find((x) => x.id === e.id);
      if (fresh) open(fresh);
    } catch (err) {
      notice('저장하지 못했습니다: ' + msg(err), 'err');
    } finally {
      save.disabled = false;
    }
  });

  const del = el('button', { class: 'ghost' });
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteLore(e.id);
      openId = '';
      if (viewMount) clear(viewMount);
      await refresh();
    } catch (err) {
      notice('삭제하지 못했습니다: ' + msg(err), 'err');
    }
  });

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: '이 챗의 로어북 항목' }),
    el('label', { class: 'field' }, [el('span', { text: '이름 (comment)' }), comment]),
    el('label', { class: 'field' }, [
      el('span', { text: '키워드 (key)' }), keys,
      el('span', { class: 'hint', text: '쉼표로 구분합니다. 대화에 이 말이 나오면 항목이 삽입됩니다.' }),
    ]),
    el('label', { class: 'field' }, [el('span', { text: '내용' }), content]),
    el('div', { class: 'row' }, [save, del]),
  ]));
  viewMount.appendChild(preview);
  drawPreview();
}

async function create(): Promise<void> {
  try {
    // Local by default: this is the chat lorebook view, and a global entry
    // affects every chat of the bot - not something to make by accident.
    const id = await state.addLore(
      { key: '', comment: '새 항목', content: '', alwaysActive: false, insertorder: 100 },
      'local',
    );
    await refresh();
    const made = entries.find((e) => e.id === id);
    if (made) open(made);
  } catch (e) {
    notice('만들지 못했습니다: ' + msg(e), 'err');
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
