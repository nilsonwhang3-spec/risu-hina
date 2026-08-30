/**
 * The fragment organizer - the centre pane, when 조각 is pressed.
 *
 * Fragments stopped being a left-column list: there are dozens of them and
 * they are structure, not a daily pick. Here they get the room to be
 * organized - a folder column (add, move, delete) beside the editor for the
 * one selected piece. Reference syntax and backend resolution are untouched:
 * `<이름>`, `<폴더/이름>`, `<컬렉션.키>`.
 */
import { el, popover } from '../dom';
import { namePopover } from '../kit';
import { state, type StudioItem } from '../../state';
import { S, hub, newCard, cardStem, msg } from './store';
import { cardEditor } from './editors';

let selFrag = '';
const openFolders = new Set<string>(['']);
/** Session-made grouping folders that hold no fragment yet (rglob cannot see
 * an empty directory, so the panel remembers what it just made). */
const extraFolders = new Set<string>();
let filter = '';

function norm(f: string): string {
  return f === '.' ? '' : f;
}

function grouped(): Map<string, StudioItem[]> {
  const out = new Map<string, StudioItem[]>([['', []]]);
  for (const f of extraFolders) out.set(f, []);
  const q = filter.trim().toLowerCase();
  for (const it of [...(S.cards.fragments ?? [])].sort((a, b) => a.path.localeCompare(b.path))) {
    if (q && !it.name.toLowerCase().includes(q) && !(it.description ?? '').toLowerCase().includes(q)) continue;
    const key = norm(it.folder ?? '');
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(it);
    if (key) extraFolders.delete(key);
  }
  return new Map([...out.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b))));
}

export function drawFragments(): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;

  const back = el('button', { class: 'ghost tiny', text: '← 돌아가기' });
  back.addEventListener('click', () => { S.centreMode = 'tab'; hub.drawCentre(); });
  const addFolder = el('button', { class: 'ghost tiny', text: '＋ 폴더' });
  addFolder.addEventListener('click', () => {
    namePopover(addFolder, {
      label: '새 폴더 이름', ok: '만들기',
      onSubmit: async (raw) => {
        const nm = cardStem(raw);
        if (!nm) return;
        try {
          await state.mkdirFile('studio/fragments/' + nm);
          extraFolders.add(nm);
          openFolders.add(nm);
          hub.touchQuiet();
          hub.drawCentre();
        } catch (e) {
          hub.notice('폴더를 만들지 못했습니다: ' + msg(e), 'err');
        }
      },
    });
  });
  const add = el('button', { class: 'primary tiny', text: '＋ 조각' });
  add.addEventListener('click', () => addFragment(add, ''));
  const head = el('div', { class: 'row', style: { marginBottom: '6px' } }, [
    back,
    el('span', { class: 'sectiontitle grow', text: `조각 프롬프트 · ${(S.cards.fragments ?? []).length}개` }),
    S.unresolvedRefs.length ? el('span', {
      class: 'badge err', text: `미해결 ${S.unresolvedRefs.length}`,
      title: '프롬프트가 참조하는데 조각이 없는 이름: ' + S.unresolvedRefs.join(', '),
    }) : null,
    addFolder, add,
  ]);
  viewMount.appendChild(head);
  viewMount.appendChild(el('div', { class: 'hint', style: { marginBottom: '8px' },
    text: '프롬프트에서 <이름> · <폴더/이름> · <컬렉션.키> 로 참조합니다. 이름이 곧 참조 키입니다.' }));

  const listCol = el('div', { class: 'fraglist' });
  const editCol = el('div', { class: 'fragedit' });
  viewMount.appendChild(el('div', { class: 'fragcols' }, [listCol, editCol]));

  const search = el('input', { placeholder: '이름·설명 검색', value: filter }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value; hub.drawCentre(); });
  listCol.appendChild(el('div', { style: { marginBottom: '4px' } }, [search]));

  const groups = grouped();
  for (const [folder, items] of groups) {
    if (folder) {
      const isOpen = openFolders.has(folder);
      const fhead = el('div', { class: 'row secthead', style: { padding: '4px 2px 0', cursor: 'pointer' } }, [
        el('span', { class: 'hint', text: isOpen ? '▾' : '▸' }),
        el('span', { class: 'sectiontitle grow', text: folder }),
        el('span', { class: 'hint', text: String(items.length) }),
      ]);
      fhead.addEventListener('click', () => {
        if (openFolders.has(folder)) openFolders.delete(folder); else openFolders.add(folder);
        hub.drawCentre();
      });
      const addHere = el('button', { class: 'ghost tiny', text: '＋', title: '이 폴더에 조각 추가' });
      addHere.addEventListener('click', (e) => { e.stopPropagation(); addFragment(addHere, folder); });
      fhead.appendChild(addHere);
      listCol.appendChild(fhead);
      if (!isOpen) continue;
      if (!items.length) {
        listCol.appendChild(el('div', { class: 'hint', style: { padding: '0 8px 4px' }, text: '(비어 있음)' }));
        continue;
      }
    } else if (!items.length) {
      continue;
    }
    for (const it of items) {
      const row = el('div', { class: 'pickrow' + (selFrag === it.path ? ' on' : ''), title: it.path }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'pickname' }, [el('span', { text: it.name })]),
          it.description ? el('div', { class: 'hint', text: it.description }) : null,
        ]),
      ]);
      row.addEventListener('click', () => { selFrag = it.path; hub.drawCentre(); });
      listCol.appendChild(row);
    }
  }

  if (!selFrag) {
    editCol.appendChild(el('div', { class: 'empty', text: '왼쪽에서 조각을 고르거나 ＋ 조각 으로 만들어 주세요.' }));
    return;
  }
  const moveBtn = el('button', { class: 'ghost tiny', text: '폴더 이동' });
  moveBtn.addEventListener('click', () => {
    const body = el('div', { class: 'applypop' });
    const close = popover(moveBtn, body);
    const targets = ['', ...[...grouped().keys()].filter((k) => k)];
    for (const t of targets) {
      const cur = norm((S.cards.fragments ?? []).find((i) => i.path === selFrag)?.folder ?? '');
      const b = el('button', { class: 'ghost tiny', text: t || '(최상위)' }) as HTMLButtonElement;
      b.disabled = t === cur;
      b.addEventListener('click', async () => {
        close();
        try {
          const r = await state.moveFile(selFrag, 'studio/fragments' + (t ? '/' + t : ''));
          selFrag = r.to;
          await hub.refreshArea('fragments');
        } catch (e) {
          hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
        }
      });
      body.appendChild(b);
    }
  });
  editCol.appendChild(el('div', { class: 'row', style: { marginBottom: '4px' } }, [
    el('span', { class: 'sectiontitle grow', text: selFrag }),
    moveBtn,
  ]));
  editCol.appendChild(cardEditor(selFrag, {
    chrome: 'inline',
    onSaved: (p) => { selFrag = p; },
    onDeleted: () => { selFrag = ''; },
  }));
}

function addFragment(anchor: HTMLElement, folder: string): void {
  namePopover(anchor, {
    label: folder ? `${folder}/ 에 새 조각 — <${folder}/이름> 으로 참조됩니다` : '새 조각 이름 — <이름> 으로 참조됩니다',
    ok: '만들기',
    onSubmit: async (nm) => {
      const path = await newCard('fragments', folder, nm);
      if (!path) return;
      if (folder) openFolders.add(folder);
      selFrag = path;
      hub.drawCentre();
    },
  });
}
