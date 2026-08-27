/**
 * One lorebook view, parameterised by scope.
 *
 * The chat tab (scope 'local') and the bot tab (scope 'global') show the same
 * material with the same tree, editor and write path - only the scope, the
 * words and the create default differ. Extracted from tab-lore.ts when the bot
 * lorebook tab arrived, so the two views cannot drift apart.
 *
 * The tree groups by the entry's own `folder`, which is what RisuAI's lorebook
 * UI groups on. Entries without one fall into a single unnamed group rather
 * than each becoming its own - a folder per entry is a list with extra
 * indentation.
 */
import { el, clear, armed, refocusSearch, focusButton, diffCard } from './dom';
import { setToolbarSearch } from './shell';
import { state, type LoreEntry } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

export interface LoreViewOptions {
  scope: 'local' | 'global';
  /** 좌측 스코프 줄의 라벨: "이 챗" / "이 봇" */
  scopeLabel: string;
  /** 항목 편집 카드의 제목. */
  heading: string;
  /** 목록이 비었을 때 보여줄 안내 줄들. */
  emptyLines: string[];
  /** 저장 후 안내 (반영이 어디서 일어나는지). */
  savedNotice: string;
}

export function makeLoreTab(opts: LoreViewOptions): (mount: HTMLElement) => void {
  let built = false;
  let treeMount: HTMLElement | null = null;
  let viewMount: HTMLElement | null = null;
  let noticeMount: HTMLElement | null = null;
  let openId = '';
  let entries: LoreEntry[] = [];
  let seenEpoch = -1;
  let seenKey = '';
  /** Folders start closed - 수십 항목이 흔해서 펼친 채로는 벽이 된다. */
  const openFolders = new Set<string>();
  let filterText = '';

  function render(mount: HTMLElement): void {
    const key = opts.scope === 'global' ? state.botKey : state.activeCharKey;
    if (!key) {
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
      seenKey = key;
      void refresh();
    } else if (seenEpoch !== state.epoch || seenKey !== key) {
      // A restore, a reset, a commit, an approved proposal - or the bot tabs
      // pointing at a different bot - made what this list shows stale.
      seenEpoch = state.epoch;
      seenKey = key;
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
      entries = await state.lore(opts.scope);
      if (opts.scope === 'local') {
        // The listing is char-wide; this view is one chat's.
        entries = entries.filter((e) => e.chatKey === state.activeChatKey);
      }
      drawTree();
    } catch (e) {
      clear(treeMount);
      treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
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
      for (const line of opts.emptyLines) {
        treeMount.appendChild(el('div', { class: 'hint', style: { padding: '4px 8px' }, text: line }));
      }
      return;
    }

    // Finding one entry among dozens is the common case; the filter searches
    // names and content, and a filtered view auto-opens its folders.
    setToolbarSearch(filterText, (v) => {
      filterText = v;
      drawTree();
      refocusSearch(null);
    }, '찾기 (이름·내용)');

    const needle = filterText.trim().toLowerCase();
    const hit = (e: LoreEntry): boolean => {
      if (!needle) return true;
      const entry = e.entry as Record<string, any>;
      return [entry.comment, entry.key, entry.content]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    };

    const names = folderNames(entries);
    // A folder entry is a container, not content: it is never injected into
    // the prompt, and listing it beside its own children reads as a duplicate.
    const items = entries.filter((e) => !isFolder(e));
    const shown = items.filter(hit);
    treeMount.appendChild(el('div', {
      class: 'treescope',
      text: `${opts.scopeLabel} · ${needle ? `${shown.length}/${items.length}` : items.length}`,
    }));

    const byFolder = new Map<string, LoreEntry[]>();
    for (const e of shown) {
      const f = folderOf(e);
      if (!byFolder.has(f)) byFolder.set(f, []);
      byFolder.get(f)!.push(e);
    }
    const named = [...byFolder.keys()].filter(Boolean);
    for (const [folder, group] of byFolder) {
      if (folder && named.length) {
        const label = names.get(folder) || shortId(folder);
        const isOpen = !!needle || openFolders.has(folder);
        const caret = el('span', { text: isOpen ? '▾' : '▸' });
        const head = el('button', { class: 'treebranch', title: folder }, [
          caret,
          el('span', { class: 'grow', text: label }),
          el('span', { class: 'hint', text: String(group.length) }),
        ]);
        const kids = el('div', { class: 'treekids' }, group.map((e) => entryRow(e, items)));
        kids.style.display = isOpen ? 'block' : 'none';
        head.addEventListener('click', () => {
          if (openFolders.has(folder)) openFolders.delete(folder);
          else openFolders.add(folder);
          const now = openFolders.has(folder);
          kids.style.display = now ? 'block' : 'none';
          caret.textContent = now ? '▾' : '▸';
        });
        treeMount.appendChild(el('div', {}, [head, kids]));
      } else {
        for (const e of group) treeMount.appendChild(entryRow(e, items));
      }
    }
  }

  /**
   * One entry as a small card: name, badges, and ↑↓ that reorder it among its
   * folder siblings. The move is expressed as a scope-wide index (the backend
   * renumbers the whole scope densely), so swapping with a sibling that sits
   * apart in seq still lands next to it.
   */
  function entryRow(e: LoreEntry, all: LoreEntry[]): HTMLElement {
    const name = el('button', {
      class: 'treefile' + (e.id === openId ? ' on' : ''),
      text: titleOf(e),
      title: e.id,
    });
    name.addEventListener('click', () => open(e));

    const siblings = all.filter((x) => folderOf(x) === folderOf(e));
    const at = siblings.findIndex((x) => x.id === e.id);
    const moveTo = async (neighbor: LoreEntry) => {
      try {
        await state.moveLore(e.id, all.findIndex((x) => x.id === neighbor.id));
        await refresh();
      } catch (err) {
        notice('순서를 바꾸지 못했습니다: ' + msg(err), 'err');
      }
    };
    const up = el('button', { class: 'ghost tiny movebtn', text: '↑', title: '위로' }) as HTMLButtonElement;
    const down = el('button', { class: 'ghost tiny movebtn', text: '↓', title: '아래로' }) as HTMLButtonElement;
    up.disabled = at <= 0;
    down.disabled = at < 0 || at >= siblings.length - 1;
    up.addEventListener('click', () => void moveTo(siblings[at - 1]));
    down.addEventListener('click', () => void moveTo(siblings[at + 1]));

    const row = el('div', { class: 'treerow lorecard' }, [name]);
    // The priority number beside every entry: a lorebook is read by tiers,
    // and a 100 among 700s and 1000s is the entry someone forgot to place.
    const io = Number((e.entry as Record<string, unknown>).insertorder ?? 100);
    row.appendChild(el('span', { class: 'hint ordertag', title: '우선순위 (insertorder)', text: String(io) }));
    // Always-active entries have no trigger keys; without the badge they
    // look like entries whose keys someone forgot.
    if ((e.entry as Record<string, unknown>).alwaysActive) {
      row.appendChild(el('span', { class: 'badge', title: '상시 활성화 — 키워드 없이 항상 삽입됩니다', text: '상시' }));
    }
    if (e.origin !== 'original') {
      row.appendChild(el('span', { class: 'badge warn', text: e.origin === 'added' ? '추가' : '수정' }));
    }
    row.appendChild(up);
    row.appendChild(down);
    return row;
  }

  function open(e: LoreEntry): void {
    if (!viewMount) return;
    openId = e.id;
    for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
      b.classList.toggle('on', (b as HTMLElement).title === e.id);
    }

    const entry = e.entry as Record<string, any>;
    const keys = el('input', { value: String(entry.key ?? entry.keys ?? '') }) as HTMLInputElement;
    const comment = el('input', { value: String(entry.comment ?? entry.name ?? '') });
    // RisuAI's 상시 활성화: the entry is always inserted and carries no
    // keys. The checkbox and the key box are one setting seen two ways.
    const always = el('input', { type: 'checkbox' }) as HTMLInputElement;
    always.checked = !!entry.alwaysActive;
    const keyHint = el('span', { class: 'hint', text: '쉼표로 구분합니다. 대화에 이 말이 나오면 항목이 삽입됩니다.' });
    const syncAlways = () => {
      keys.disabled = always.checked;
      if (always.checked) keys.value = '';
      keyHint.textContent = always.checked
        ? '상시 활성화 항목은 키워드 없이 항상 삽입됩니다 (키워드는 비웁니다).'
        : '쉼표로 구분합니다. 대화에 이 말이 나오면 항목이 삽입됩니다.';
    };
    always.addEventListener('change', syncAlways);
    syncAlways();
    const content = el('textarea', {
      value: String(entry.content ?? ''),
      style: { minHeight: '300px' },
    });
    // insertorder: RisuAI's one number for both "survives the token budget"
    // and "goes first in the prompt" (bigger wins both). It had no field
    // here, so every entry the panel made sat at the default 100.
    const order = el('input', {
      type: 'number', step: '10', value: String(Number(entry.insertorder ?? 100)),
      title: '클수록 예산에서 먼저 살아남고 프롬프트에 먼저 놓입니다. 주연 1000 · 조연 800~900 · 세계관 700 · 장소 600 · 몬스터 500 · 엑스트라 300 · 상시 정본 2000',
    }) as HTMLInputElement;

    // 폴더 간 이동: membership is `entry.folder === folderEntry.key`, so the
    // select's values are folder keys and its labels the folders' comments.
    const names = folderNames(entries);
    const curFolder = folderOf(e);
    const folderKeys = [...names.keys()];
    if (curFolder && !folderKeys.includes(curFolder)) folderKeys.push(curFolder);
    const folderSel = el('select', {}, [
      (() => {
        const o = el('option', { value: '', text: '(폴더 없음)' });
        if (!curFolder) o.setAttribute('selected', '');
        return o;
      })(),
      ...folderKeys.map((k) => {
        const o = el('option', { value: k, text: names.get(k) || shortId(k) });
        if (k === curFolder) o.setAttribute('selected', '');
        return o;
      }),
    ]) as HTMLSelectElement;

    const save = el('button', { class: 'primary', text: '저장' });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        // The entry is written back whole. A lorebook entry has fields we do
        // not model, and a field-wise merge would have to know all of them.
        const next: Record<string, unknown> = {
          ...entry,
          key: always.checked ? '' : keys.value,
          alwaysActive: always.checked,
          comment: comment.value,
          content: content.value,
          insertorder: Number.isFinite(Number(order.value)) ? Math.trunc(Number(order.value)) : 100,
        };
        if (folderSel.value) next.folder = folderSel.value;
        else delete next.folder;
        await state.saveLore(e.id, next);
        if (opts.scope === 'global') void state.refreshBotChanges();
        notice(opts.savedNotice, 'ok');
        await refresh();
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
        if (opts.scope === 'global') void state.refreshBotChanges();
        openId = '';
        if (viewMount) clear(viewMount);
        await refresh();
      } catch (err) {
        notice('삭제하지 못했습니다: ' + msg(err), 'err');
      }
    });

    // An edited entry shows its lines against the baseline - the row badge
    // says 수정, this says where. Keys and name changes are one line each
    // and read fine from the diff of the content plus a note.
    const orig = e.origin === 'edited' && e.original ? (e.original as Record<string, any>) : null;
    const diff = orig ? diffCard(String(orig.content ?? ''), String(entry.content ?? '')) : null;
    const metaChanged: string[] = [];
    if (orig) {
      if (String(orig.comment ?? '') !== String(entry.comment ?? '')) metaChanged.push(`이름: “${String(orig.comment ?? '')}” → “${String(entry.comment ?? '')}”`);
      if (String(orig.key ?? '') !== String(entry.key ?? '')) metaChanged.push(`키워드: “${String(orig.key ?? '')}” → “${String(entry.key ?? '')}”`);
      if (!!orig.alwaysActive !== !!entry.alwaysActive) metaChanged.push(`상시 활성화: ${orig.alwaysActive ? '켬' : '끔'} → ${entry.alwaysActive ? '켬' : '끔'}`);
    }

    clear(viewMount);
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [el('span', { text: opts.heading }), el('span', { class: 'spacer' }), focusButton(content, titleOf(e))]),
      el('label', { class: 'field' }, [el('span', { text: '이름 (comment)' }), comment]),
      el('label', { class: 'checkrow', style: { marginBottom: '8px' } }, [
        always, el('span', { text: '상시 활성화 (alwaysActive) — 키워드 없이 항상 삽입' }),
      ]),
      el('label', { class: 'field' }, [
        el('span', { text: '키워드 (key)' }), keys, keyHint,
      ]),
      el('div', { class: 'row', style: { marginBottom: '10px' } }, [
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '폴더' }), folderSel]),
        el('label', { class: 'field', style: { marginBottom: '0', width: '150px' } }, [el('span', { text: '우선순위 (insertorder)' }), order]),
      ]),
      el('label', { class: 'field' }, [el('span', { text: '내용' }), content]),
      metaChanged.length ? el('div', { class: 'hint diffmeta', text: '기준선과 다른 항목 — ' + metaChanged.join(' · ') }) : null,
      diff,
      el('div', { class: 'row' }, [save, del]),
    ]));
  }

  async function create(): Promise<void> {
    try {
      const id = await state.addLore(
        { key: '', comment: '새 항목', content: '', alwaysActive: false, insertorder: 100 },
        opts.scope,
      );
      if (opts.scope === 'global') void state.refreshBotChanges();
      await refresh();
      const made = entries.find((e) => e.id === id);
      if (made) open(made);
    } catch (e) {
      notice('만들지 못했습니다: ' + msg(e), 'err');
    }
  }

  return render;
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
 * Folder key -> the name a person gave it.
 *
 * RisuAI's own membership test is `item.folder === folderEntry.key`
 * (LoreBookData.svelte:154) and the display name is the folder entry's
 * `comment` (":142). The first version mapped from `entry.id`, which is why
 * folders rendered as "폴더 folder-…" ids even when a name existed.
 */
function folderNames(all: LoreEntry[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const e of all) {
    if (!isFolder(e)) continue;
    const entry = e.entry as Record<string, any>;
    const key = String(entry.key ?? '').trim();
    if (key) names.set(key, String(entry.comment || '').trim() || '이름 없는 폴더');
  }
  return names;
}

function shortId(id: string): string {
  return id.length > 10 ? `폴더 ${id.slice(0, 6)}…` : `폴더 ${id}`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
