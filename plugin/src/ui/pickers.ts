/**
 * The pick-one-of-a-list idiom, extracted from the agent preset card so the
 * studio can use it too: a compact "current" row in the page (name · summary ·
 * a › chevron), and behind the chevron a modal list where 선택 · 수정 · 삭제 ·
 * 추가 all live. The current row never grows buttons of its own - a row that
 * says what is running stays one line tall no matter how many entries exist.
 */
import { el, clear, armed, modal, popover } from './dom';

export interface PickerBadge {
  text: string;
  /** 'ok' | 'warn' | 'err' | '' - appended to the badge class. */
  cls?: string;
}

/** What the compact row shows for the current choice. */
export interface PickerCurrent {
  name: string;
  hint?: string;
  badges?: PickerBadge[];
}

/** One entry in the modal list. */
export interface PickerEntry {
  id: string;
  name: string;
  hint?: string;
  selected?: boolean;
  badges?: PickerBadge[];
  /** Hides 삭제 on rows that must survive (e.g. the last preset). */
  noDelete?: boolean;
  /** Folder the entry sits in ('' = top level); only read when the spec has `folders`. */
  group?: string;
}

/** Opt-in folders for a picker (the studio's styles): rows group under
 * foldable folder headers, and a row can move between folders. */
export interface PickerFolders {
  /** Every folder to show, including empty ones just made. */
  list(): string[];
  /** Make a folder; resolves to its name, or '' when cancelled. */
  create(anchor: HTMLElement): Promise<string>;
  /** Move one entry into `folder` ('' = top level). */
  move(entry: PickerEntry, folder: string): Promise<void>;
  /** Create a new entry inside `folder`. The modal closes first. */
  createIn?(folder: string): void;
}

export interface PickerRowOptions {
  /** Chevron tooltip, e.g. '저장된 프리셋 N개 — 선택 · 수정 · 삭제 · 추가'. */
  title: string;
  /** Shown instead of a name when `current` is null. */
  emptyHint: string;
  onOpen(): void;
}

/** The compact current row: name + badges + hint, and the › chevron. */
export function pickerRow(current: PickerCurrent | null, opts: PickerRowOptions): HTMLElement {
  const open = el('button', { class: 'ghost chev', text: '›', title: opts.title });
  open.addEventListener('click', () => opts.onOpen());
  if (!current) {
    return el('div', { class: 'presetnow' }, [
      el('div', { class: 'grow' }, [el('div', { class: 'hint', text: opts.emptyHint })]),
      open,
    ]);
  }
  return el('div', { class: 'presetnow' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 'presetnow-name' }, [
        el('span', { text: current.name }),
        ...(current.badges ?? []).map((b) =>
          el('span', { class: 'badge ' + (b.cls ?? ''), style: { marginLeft: '6px' }, text: b.text })),
      ]),
      current.hint ? el('div', { class: 'hint', text: current.hint }) : null,
    ]),
    open,
  ]);
}

export interface ListPickerSpec {
  title: string;
  /** One line above the list; defaults to the select-applies-immediately note. */
  hint?: string;
  /** Read the entries; called on open and after every delete. */
  load(): Promise<PickerEntry[]>;
  /** Apply the choice. The modal closes when this resolves. */
  onSelect(entry: PickerEntry): Promise<void>;
  /** Open the editor for one entry. The modal closes first. */
  onEdit?(entry: PickerEntry): void;
  /** Delete one entry. The list redraws when this resolves. */
  onDelete?(entry: PickerEntry): Promise<void>;
  /** Create a new entry. The modal closes first. */
  onCreate?(): void;
  createLabel?: string;
  /** The badge on the selected row and its disabled button, default '사용 중'. */
  selectedLabel?: string;
  folders?: PickerFolders;
}

/** Folded folders, per picker title, for the session. */
const foldedFolders = new Map<string, Set<string>>();

/**
 * The modal list. Selection is an explicit button, not a click on the row:
 * the row also carries 수정 and 삭제, and a choice that changes what runs
 * should be a button that says so.
 */
export function openListPicker(spec: ListPickerSpec): void {
  const listMount = el('div');
  const body = el('div', {}, [
    el('div', { class: 'hint', style: { marginBottom: '8px' }, text: spec.hint ?? '선택하면 바로 적용됩니다.' }),
    listMount,
  ]);
  const close = modal(spec.title, body);
  const selectedLabel = spec.selectedLabel ?? '사용 중';

  const draw = async () => {
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const entries = await spec.load();
      clear(listMount);
      if (spec.folders) drawFolders(entries, spec.folders);
      else for (const entry of entries) listMount.appendChild(row(entry));
      const actions = el('div', { class: 'row', style: { marginTop: '10px', gap: '6px' } });
      if (spec.onCreate) {
        const add = el('button', { class: 'primary', text: spec.createLabel ?? '새로 추가' });
        add.addEventListener('click', () => {
          close();
          spec.onCreate?.();
        });
        actions.appendChild(add);
      }
      if (spec.folders) {
        const folders = spec.folders;
        const addFolder = el('button', { class: 'ghost', text: '＋ 폴더' }) as HTMLButtonElement;
        addFolder.addEventListener('click', async () => {
          try {
            if (await folders.create(addFolder)) await draw();
          } catch (e) { complain(e); }
        });
        actions.appendChild(addFolder);
      }
      if (actions.childElementCount) listMount.appendChild(actions);
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  };

  const folded = foldedFolders.get(spec.title) ?? new Set<string>();
  foldedFolders.set(spec.title, folded);

  /** Top-level rows first, then one foldable section per folder. */
  const drawFolders = (entries: PickerEntry[], folders: PickerFolders): void => {
    const names = [...new Set([...folders.list(), ...entries.map((e) => e.group ?? '')])]
      .filter(Boolean).sort((a, b) => a.localeCompare(b));
    for (const entry of entries.filter((e) => !e.group)) listMount.appendChild(row(entry));
    for (const name of names) {
      const inside = entries.filter((e) => e.group === name);
      const open = !folded.has(name);
      const head = el('div', { class: 'row secthead pickfolder', style: { cursor: 'pointer', padding: '6px 2px 2px' } }, [
        el('span', { class: 'hint', text: open ? '▾' : '▸' }),
        el('span', { class: 'sectiontitle grow', text: name }),
        el('span', { class: 'hint', text: String(inside.length) }),
      ]);
      head.addEventListener('click', () => {
        if (folded.has(name)) folded.delete(name); else folded.add(name);
        void draw();
      });
      if (folders.createIn) {
        const addHere = el('button', { class: 'ghost tiny', text: '＋', title: '이 폴더에 추가' });
        addHere.addEventListener('click', (ev) => {
          ev.stopPropagation();
          close();
          folders.createIn?.(name);
        });
        head.appendChild(addHere);
      }
      listMount.appendChild(head);
      if (!open) continue;
      if (!inside.length) {
        listMount.appendChild(el('div', { class: 'hint', style: { padding: '0 8px 4px' }, text: '(비어 있음)' }));
        continue;
      }
      for (const entry of inside) listMount.appendChild(row(entry));
    }
  };

  const moveButton = (entry: PickerEntry, folders: PickerFolders): HTMLElement => {
    const b = el('button', { class: 'ghost tiny', text: '이동', title: '다른 폴더로 옮깁니다' }) as HTMLButtonElement;
    b.addEventListener('click', () => {
      const body = el('div', { class: 'applypop' });
      const closePop = popover(b, body);
      const targets = ['', ...new Set(folders.list())].filter((t, i, a) => a.indexOf(t) === i);
      for (const t of targets) {
        const go = el('button', { class: 'ghost tiny', text: t || '(최상위)' }) as HTMLButtonElement;
        go.disabled = t === (entry.group ?? '');
        go.addEventListener('click', async () => {
          closePop();
          try {
            await folders.move(entry, t);
            await draw();
          } catch (e) { complain(e); }
        });
        body.appendChild(go);
      }
    });
    return b;
  };

  const complain = (e: unknown) => {
    // Shown in place, then the list redraws so a stale row never lingers.
    clear(listMount);
    listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    setTimeout(() => void draw(), 2500);
  };

  const row = (entry: PickerEntry): HTMLElement => {
    const pickArea = el('div', { class: 'grow' }, [
      el('div', { class: 'pickname' }, [
        el('span', { text: entry.name }),
        entry.selected ? el('span', { class: 'badge ok', text: selectedLabel }) : null,
        ...(entry.badges ?? []).map((b) => el('span', { class: 'badge ' + (b.cls ?? ''), text: b.text })),
      ]),
      entry.hint ? el('div', { class: 'hint', text: entry.hint }) : null,
    ]);
    const select = el('button', { class: 'primary tiny', text: entry.selected ? selectedLabel : '선택' }) as HTMLButtonElement;
    select.disabled = !!entry.selected;
    select.addEventListener('click', async () => {
      try {
        await spec.onSelect(entry);
        close();
      } catch (e) {
        complain(e);
      }
    });
    const cells: (HTMLElement | null)[] = [pickArea, select];
    if (spec.onEdit) {
      const edit = el('button', { class: 'ghost tiny', text: '수정' });
      edit.addEventListener('click', () => {
        close();
        spec.onEdit?.(entry);
      });
      cells.push(edit);
    }
    if (spec.folders) cells.push(moveButton(entry, spec.folders));
    if (spec.onDelete && !entry.noDelete) {
      const del = el('button', { class: 'ghost tiny' });
      armed(del, '삭제', '한 번 더', async () => {
        try {
          await spec.onDelete?.(entry);
          await draw();
        } catch (e) {
          complain(e);
        }
      });
      cells.push(del);
    }
    return el('div', { class: 'pickrow' + (entry.selected ? ' on' : '') }, cells);
  };

  void draw();
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
