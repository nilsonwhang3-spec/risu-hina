/**
 * The left character view: the 프롬프트 column, taken over.
 *
 * Folder-grouped rows; the toggle IS the selection (a card carries its own
 * on/off, there is no second "chosen" list to sync). Clicking a row expands
 * the full editor - prompt, negative, vibe transfer, character reference -
 * in place, so everything about a character is handled in this column.
 */
import { el } from '../dom';
import { state, type StudioItem } from '../../state';
import { listRow as kitRow } from '../kit';
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

export function buildLeftChars(mount: HTMLElement): void {
  const back = el('button', { class: 'ghost tiny', text: '← 프롬프트' });
  back.addEventListener('click', () => { S.leftView = 'main'; hub.drawLeft(); });
  const addFolder = el('button', { class: 'ghost tiny', text: '＋ 폴더', title: '캐릭터를 묶는 폴더를 만듭니다' });
  addFolder.addEventListener('click', async () => {
    const raw = window.prompt('폴더 이름');
    const nm = cardStem((raw ?? '').trim());
    if (!nm) return;
    try {
      await state.mkdirFile('studio/characters/' + nm);
      extraFolders.add(nm);
      openFolders.add(nm);
      hub.touchQuiet();
      hub.drawLeft();
    } catch (e) {
      hub.notice('폴더를 만들지 못했습니다: ' + msg(e), 'err');
    }
  });
  const add = el('button', { class: 'primary tiny', text: '＋ 캐릭터' });
  add.addEventListener('click', () => void addCharacter(''));
  mount.appendChild(el('div', { class: 'row', style: { padding: '6px 6px 2px', gap: '4px' } }, [
    back, el('span', { class: 'sectiontitle grow', text: '캐릭터' }), addFolder, add,
  ]));

  const search = el('input', { placeholder: '이름·설명 검색', value: filter }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value; hub.drawLeft(); });
  mount.appendChild(el('div', { style: { padding: '2px 6px 4px' } }, [search]));

  const groups = grouped();
  if (![...groups.values()].some((v) => v.length) && !extraFolders.size) {
    mount.appendChild(el('div', { class: 'hint', style: { padding: '4px 10px' },
      text: filter ? '검색 결과가 없습니다.' : '캐릭터가 없습니다. ＋ 캐릭터 로 만들어 주세요.' }));
  }
  for (const [folder, items] of groups) {
    if (folder) {
      const isOpen = openFolders.has(folder);
      const head = el('div', { class: 'row secthead', style: { padding: '4px 6px 0', cursor: 'pointer' },
                              title: isOpen ? '접기' : '펼치기' }, [
        el('span', { class: 'hint', text: isOpen ? '▾' : '▸' }),
        el('span', { class: 'sectiontitle grow', text: folder }),
        el('span', { class: 'hint', text: String(items.length) }),
      ]);
      head.addEventListener('click', () => {
        if (openFolders.has(folder)) openFolders.delete(folder); else openFolders.add(folder);
        hub.drawLeft();
      });
      const addHere = el('button', { class: 'ghost tiny', text: '＋', title: '이 폴더에 캐릭터 추가' });
      addHere.addEventListener('click', (e) => { e.stopPropagation(); void addCharacter(folder); });
      head.appendChild(addHere);
      mount.appendChild(head);
      if (!isOpen) continue;
      if (!items.length) {
        mount.appendChild(el('div', { class: 'hint', style: { padding: '0 10px 4px' }, text: '(비어 있음)' }));
        continue;
      }
    }
    for (const it of items) {
      mount.appendChild(charRow(it));
      if (S.charOpen === it.path) {
        mount.appendChild(el('div', { class: 'charinline' }, [
          characterEditor(it.path, {
            chrome: 'inline',
            onSaved: (d) => { S.charOpen = d; },
            onDeleted: () => { S.charOpen = ''; },
          }),
        ]));
      }
    }
  }
}

function charRow(it: StudioItem): HTMLElement {
  const badges: { text: string; kind?: 'ok' | 'warn' | 'err' | ''; title?: string }[] = [];
  if (it.vibe) badges.push({ text: `바이브 ${it.vibe}`, title: '이 카드의 바이브가 함께 실립니다' });
  if (it.charref) badges.push({ text: `레퍼런스 ${it.charref}` });
  return kitRow({
    variant: 'pick',
    selected: S.charOpen === it.path,
    title: it.name || it.path.split('/').pop() || it.path,
    hint: it.description || undefined,
    badges,
    toggle: {
      checked: !!it.enabled,
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
      S.charOpen = S.charOpen === it.path ? '' : it.path;
      hub.drawLeft();
    },
  });
}

async function addCharacter(folder: string): Promise<void> {
  const path = await newCard('characters', folder);
  if (!path) return;
  if (folder) openFolders.add(folder);
  S.charOpen = path;
  hub.drawLeft();
}
