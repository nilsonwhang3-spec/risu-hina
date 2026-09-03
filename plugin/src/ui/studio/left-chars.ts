/**
 * The left character view: the 프롬프트 column, taken over.
 *
 * Folder-grouped rows; the toggle IS the selection (a card carries its own
 * on/off, there is no second "chosen" list to sync). Clicking a row expands
 * the full editor - prompt, negative, vibe transfer, character reference -
 * in place, so everything about a character is handled in this column.
 * Rows DRAG: onto a folder header to file them, onto the 미분류 header to
 * take them back out.
 */
import { el } from '../dom';
import { namePopover } from '../kit';
import { state, type StudioItem } from '../../state';
import { listRow as kitRow } from '../kit';
import { installDrag, installDrop } from '../tree';
import { S, hub, checkUnresolved, newCard, cardStem, msg } from './store';
import { characterEditor } from './char-edit';

/** Folders opened out; '' is the top level and always open. */
const openFolders = new Set<string>(['']);
/** Grouping folders made this session that still hold no card - the listing
 * cannot see an empty directory, so the panel remembers what it just made. */
const extraFolders = new Set<string>();
let filter = '';

function grouped(): Map<string, StudioItem[]> {
  const out = new Map<string, StudioItem[]>();
  const norm = (f: string) => (f === '.' ? '' : f);
  for (const f of extraFolders) out.set(f, []);
  const q = filter.trim().toLowerCase();
  const items = (S.cards.characters ?? []).filter((i) =>
    !q || i.name.toLowerCase().includes(q) || (i.description ?? '').toLowerCase().includes(q));
  for (const it of items.sort((a, b) =>
    ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path))) {
    const key = norm(it.folder ?? '');
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(it);
    if (key) extraFolders.delete(key);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))));
}

/** File dragged cards under `folder` ('' = back to the top level). */
async function moveCards(folder: string, sources: string[]): Promise<void> {
  const dstDir = 'studio/config/characters' + (folder ? '/' + folder : '');
  try {
    for (const src of sources) {
      if (!src.startsWith('studio/config/characters/')) continue;
      const parent = src.slice(0, src.lastIndexOf('/'));
      if (parent === dstDir || dstDir.startsWith(src + '/')) continue;
      const r = await state.moveFile(src, dstDir);
      if (S.charOpen === src) S.charOpen = r.to;
    }
    if (folder) openFolders.add(folder);
    await hub.refreshArea('characters');
  } catch (e) {
    hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
  }
}

export function buildLeftChars(mount: HTMLElement): void {
  // An open card takes the column (← 목록 to come back): an editor unfolded
  // inside the list made the column a scroll hunt nobody could use.
  if (S.charOpen) {
    const it = (S.cards.characters ?? []).find((c) => c.path === S.charOpen);
    const backList = el('button', { class: 'ghost tiny', text: '← 목록' });
    backList.addEventListener('click', () => { S.charOpen = ''; hub.drawLeft(); });
    mount.appendChild(el('div', { class: 'row', style: { padding: '6px 6px 4px', gap: '6px' } }, [
      backList, el('span', { class: 'sectiontitle grow', text: it?.name ?? S.charOpen.split('/').pop() ?? '' }),
    ]));
    mount.appendChild(el('div', { class: 'charinline' }, [
      characterEditor(S.charOpen, {
        chrome: 'inline',
        onSaved: (d) => { S.charOpen = d; },
        onDeleted: () => { S.charOpen = ''; },
      }),
    ]));
    return;
  }

  const back = el('button', { class: 'ghost tiny', text: '← 프롬프트' });
  back.addEventListener('click', () => { S.leftView = 'main'; hub.drawLeft(); });
  const title = el('span', { class: 'sectiontitle grow', text: '캐릭터',
                             title: '카드를 폴더 제목으로 끌어다 놓으면 그 폴더로 옮겨집니다' });
  mount.appendChild(el('div', { class: 'row', style: { padding: '6px 6px 0', gap: '6px' } }, [
    back, title,
  ]));

  const search = el('input', { class: 'grow', placeholder: '이름·설명 검색', value: filter }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value; hub.drawLeft(); });
  const addFolder = el('button', { class: 'ghost tiny', text: '＋ 폴더', title: '캐릭터를 묶는 폴더를 만듭니다' });
  addFolder.addEventListener('click', () => {
    namePopover(addFolder, {
      label: '새 폴더 이름', ok: '만들기',
      onSubmit: async (raw) => {
        const nm = cardStem(raw);
        if (!nm) return;
        try {
          await state.mkdirFile('studio/config/characters/' + nm);
          extraFolders.add(nm);
          openFolders.add(nm);
          hub.touchQuiet();
          hub.drawLeft();
        } catch (e) {
          hub.notice('폴더를 만들지 못했습니다: ' + msg(e), 'err');
        }
      },
    });
  });
  const add = el('button', { class: 'primary tiny', text: '＋ 캐릭터' });
  add.addEventListener('click', () => addCharacter(add, ''));
  mount.appendChild(el('div', { class: 'row', style: { padding: '4px 6px 6px', gap: '4px' } }, [
    search, addFolder, add,
  ]));

  const groups = grouped();
  if (![...groups.values()].some((v) => v.length) && !extraFolders.size) {
    mount.appendChild(el('div', { class: 'hint', style: { padding: '4px 10px' },
      text: filter ? '검색 결과가 없습니다.' : '캐릭터가 없습니다. ＋ 캐릭터 로 만들어 주세요.' }));
  }
  for (const [folder, items] of groups) {
    const isOpen = folder === '' || openFolders.has(folder);
    // Every group header is a DROP TARGET, the top level included: dragging
    // a card out of a folder lands it on 미분류.
    const head = el('div', { class: 'row secthead', style: { padding: '4px 6px 0', cursor: folder ? 'pointer' : 'default' },
                            title: folder ? (isOpen ? '접기 · 카드를 끌어다 놓으면 이 폴더로' : '펼치기') : '카드를 끌어다 놓으면 미분류로' }, [
      el('span', { class: 'hint', text: folder ? (isOpen ? '▾' : '▸') : '' }),
      el('span', { class: 'sectiontitle grow', text: folder || '미분류' }),
      el('span', { class: 'hint', text: String(items.length) }),
    ]);
    installDrop(head, { into: () => folder, onMove: (f, sources) => void moveCards(f, sources) });
    if (folder) {
      head.addEventListener('click', () => {
        if (openFolders.has(folder)) openFolders.delete(folder); else openFolders.add(folder);
        hub.drawLeft();
      });
      const addHere = el('button', { class: 'ghost tiny', text: '＋', title: '이 폴더에 캐릭터 추가' });
      addHere.addEventListener('click', (e) => { e.stopPropagation(); addCharacter(addHere, folder); });
      head.appendChild(addHere);
    }
    mount.appendChild(head);
    if (!isOpen) continue;
    if (!items.length) {
      mount.appendChild(el('div', { class: 'hint', style: { padding: '0 10px 4px' },
        text: folder ? '(비어 있음 — 카드를 끌어다 놓으세요)' : '(없음)' }));
      continue;
    }
    for (const it of items) mount.appendChild(charRow(it));
  }
}

function charRow(it: StudioItem): HTMLElement {
  const badges: { text: string; kind?: 'ok' | 'warn' | 'err' | ''; title?: string }[] = [];
  if (it.vibe) badges.push({ text: `바이브 ${it.vibe}`, title: '이 카드의 바이브가 함께 실립니다' });
  if (it.charref) badges.push({ text: `레퍼런스 ${it.charref}` });
  const row = kitRow({
    variant: 'pick',
    selected: S.charOpen === it.path,
    title: it.name || it.path.split('/').pop() || it.path,
    hint: it.description || undefined,
    badges,
    // Dense rows and a slide toggle: the checkbox-and-air version read as a
    // settings page, not a cast list (§1-31).
    cls: 'compact',
    toggle: {
      checked: !!it.enabled,
      style: 'switch',
      title: '켜면 생성 요청에 이 캐릭터가 실립니다 (순서대로 이어집니다)',
      onChange: async (v) => {
        try {
          await state.studio.setMeta(it.path, { enabled: v });
        } catch (e) {
          hub.notice('바꾸지 못했습니다: ' + msg(e), 'err');
          throw e;
        }
        it.enabled = v;
        hub.drawLeft();
        hub.drawCentre();
        checkUnresolved();
        hub.touchQuiet();
      },
    },
    onClick: () => {
      S.charOpen = it.path;
      hub.drawLeft();
    },
  });
  // A row drags as its card folder: drop it on a folder header here, or on
  // the OUTPUT tree's folders (the shared DRAG_PATHS type).
  installDrag(row, () => [it.path]);
  return row;
}

function addCharacter(anchor: HTMLElement, folder: string): void {
  namePopover(anchor, {
    label: folder ? `${folder}/ 에 새 캐릭터` : '새 캐릭터 이름',
    placeholder: '예: 유나',
    ok: '만들기',
    onSubmit: async (nm) => {
      const path = await newCard('characters', folder, nm);
      if (!path) return;
      if (folder) openFolders.add(folder);
      S.charOpen = path;
      hub.drawLeft();
    },
  });
}
