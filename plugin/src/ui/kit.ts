/**
 * The tab kit - the one place the shared tab behaviours live.
 *
 * Every content tab used to hand-roll the same five things, each slightly
 * differently: the gate (and its empty-state copy), the rebuild guard (three
 * different staleness keys), the notice line (ten byte-identical copies), the
 * toolbar search (five tabs had it, four that needed it did not - and it only
 * installed when the list happened to be non-empty), and the save feedback
 * (each tab restating the 반영 rule in its own words). This file is those
 * five, stated once.
 *
 * Deliberately NOT unified, because they are different on purpose:
 *   - the editor's toolbar (a full tool row - 찾기 · 잘라내기 · 보기 - not a
 *     search box);
 *   - the chats picker's layout (an entry screen, not a threePane edit tab);
 *   - the files tab's .frow table rows (a file manager row is a table row,
 *     not a card);
 *   - the agent panel (its own component, re-parented by agentpane.ts).
 */
import { el, clear, searchBox } from './dom';
import { threePane, type ThreePaneParts } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { state } from '../state';
import { setToolbar } from './shell';

export type NoticeKind = 'ok' | 'err' | '';

export interface Notice {
  mount: HTMLElement;
  show(text: string, kind?: NoticeKind): void;
}

/** The notice line: one element, auto-clearing, newest message wins. */
export function makeNotice(margin = '10px 14px 0'): Notice {
  const mount = el('div');
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    mount,
    show(text: string, kind: NoticeKind = ''): void {
      clear(mount);
      mount.appendChild(el('div', { class: 'notice ' + kind, style: { margin }, text }));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => clear(mount), 9000);
    },
  };
}

/** The empty-state copy, one wording per gate kind. */
export const GATE_COPY: Record<'chat' | 'bot', string> = {
  chat: '먼저 “선택” 탭에서 챗을 골라 주세요.',
  bot: '먼저 패널을 연 봇이 있어야 합니다. RisuAI에서 봇을 열고 다시 여세요.',
};

/** One line of save feedback, the 반영 rule stated once. */
export function savedText(what: string): string {
  return `${what} 저장했습니다. 반영을 누르기 전까지 RisuAI 원본에는 쓰이지 않습니다.`;
}

export interface TabUi {
  notice(text: string, kind?: NoticeKind): void;
}

export interface TabSpec {
  /** What must be selected for the tab to have content. Default 'none'. */
  gate?: 'chat' | 'bot' | 'none';
  /** Staleness inputs: when their serialisation moves, refresh() runs. */
  keys(): unknown[];
  /** Build the pane's static structure, once per (re)build. */
  build(pane: ThreePaneParts, ui: TabUi): void;
  /** Load and draw the data - after build, and whenever keys() moved. */
  refresh(): void | Promise<void>;
  /** A filter box on the menu line. Installed whenever the gate passes -
   *  an empty list still deserves its (idle) search box. */
  search?: { placeholder?: string; get(): string; set(v: string): void };
  /** A custom toolbar instead of the search box. */
  toolbar?(): HTMLElement | null;
  /** vars-style: the list is the content, hide the left column. */
  noLeft?: boolean;
}

/**
 * The tab scaffold: gate → rebuild guard → toolbar → agent mount.
 *
 * The returned function is the tab's render entry (what shell.renderActive
 * calls). The pane structure survives re-renders; refresh() runs only when
 * the declared keys moved, which replaces the three ad-hoc staleness schemes
 * the tabs used to keep by hand.
 */
export function makeTab(spec: TabSpec): (mount: HTMLElement) => void {
  let built = false;
  let seen = '';
  const n = makeNotice();
  return (mount: HTMLElement): void => {
    const gate = spec.gate ?? 'none';
    const pass = gate === 'none'
      || (gate === 'chat' ? !!state.activeChatKey : !!state.activeCharKey);
    if (!pass) {
      clear(mount);
      built = false;
      mount.appendChild(el('div', { class: 'pad' }, [
        el('div', { class: 'empty', text: GATE_COPY[gate as 'chat' | 'bot'] }),
      ]));
      return;
    }

    const key = JSON.stringify(spec.keys());
    if (!built || !mount.querySelector('.split')) {
      clear(mount);
      const pane = threePane();
      if (spec.noLeft) pane.left.style.display = 'none';
      pane.centre.appendChild(n.mount);
      spec.build(pane, { notice: n.show });
      mount.appendChild(pane.root);
      built = true;
      seen = key;
      void spec.refresh();
    } else if (seen !== key) {
      seen = key;
      void spec.refresh();
    }

    // The toolbar installs whenever the gate passes, not only when the list
    // happened to be non-empty - that dependence was a bug, not a feature.
    setToolbar(spec.toolbar?.()
      ?? (spec.search
        ? searchBox(spec.search.get(), (v) => spec.search!.set(v), spec.search.placeholder ?? '찾기')
        : null));

    bindAgent({ notice: n.show });
    const inner = mount.querySelector('.right-inner');
    if (inner) mountAgent(inner as HTMLElement);
  };
}

// --- rows ---------------------------------------------------------------------

export interface RowSpec {
  /** 'tree' = the bordered card row in a tree column (.treerow.lorecard);
   *  'pick' = the settings-style row with an enable toggle (.pickrow). */
  variant: 'tree' | 'pick';
  title: string | Node;
  hint?: string;
  /** Second hint line, dimmed (paths, sizes). */
  sub?: string;
  badges?: { text: string; kind?: 'ok' | 'warn' | 'err' | '' ; title?: string }[];
  /** The enable checkbox. Dims the row via `.off` while unchecked. */
  toggle?: { checked: boolean; title?: string; onChange(v: boolean): Promise<void> | void };
  /** The ↑↓ pair (.movebtn), tree rows only. */
  reorder?: { up?: () => void; down?: () => void };
  actions?: HTMLElement[];
  selected?: boolean;
  dimmed?: boolean;
  onClick?(): void;
}

/**
 * One list row, in either of the two idioms the panel already has CSS for.
 * What unifies is the affordances - badge classes, the toggle + `.off`
 * dimming, the reorder pair, where actions sit - not the visual shape.
 */
export function listRow(spec: RowSpec): HTMLElement {
  const badges = (spec.badges ?? []).map((b) =>
    el('span', { class: ('badge ' + (b.kind ?? '')).trim(), text: b.text, ...(b.title ? { title: b.title } : {}) }));

  let toggle: HTMLInputElement | null = null;
  if (spec.toggle) {
    toggle = el('input', {
      type: 'checkbox', ...(spec.toggle.title ? { title: spec.toggle.title } : {}),
    }) as HTMLInputElement;
    toggle.checked = spec.toggle.checked;
    toggle.addEventListener('click', (e) => e.stopPropagation());
    toggle.addEventListener('change', async () => {
      try {
        await spec.toggle!.onChange(toggle!.checked);
      } catch {
        // The caller reports; the box springs back so it never lies.
        toggle!.checked = !toggle!.checked;
      }
    });
  }

  const reorder: HTMLElement[] = [];
  if (spec.reorder) {
    const up = el('button', { class: 'movebtn', text: '↑', title: '위로' }) as HTMLButtonElement;
    const down = el('button', { class: 'movebtn', text: '↓', title: '아래로' }) as HTMLButtonElement;
    up.disabled = !spec.reorder.up;
    down.disabled = !spec.reorder.down;
    up.addEventListener('click', (e) => { e.stopPropagation(); spec.reorder!.up?.(); });
    down.addEventListener('click', (e) => { e.stopPropagation(); spec.reorder!.down?.(); });
    reorder.push(up, down);
  }
  for (const a of spec.actions ?? []) a.addEventListener('click', (e) => e.stopPropagation());

  const title = typeof spec.title === 'string' ? el('span', { text: spec.title }) : spec.title;

  let row: HTMLElement;
  if (spec.variant === 'pick') {
    row = el('div', {
      class: 'pickrow' + (spec.toggle && !spec.toggle.checked ? ' off' : '')
        + (spec.selected ? ' on' : ''),
    }, [
      toggle,
      el('div', { class: 'grow' }, [
        el('div', { class: 'pickname' }, [title, ...badges]),
        spec.hint != null ? el('div', { class: 'hint', text: spec.hint }) : null,
        spec.sub != null ? el('div', { class: 'hint dim', text: spec.sub }) : null,
      ]),
      ...reorder,
      ...(spec.actions ?? []),
    ]);
  } else {
    row = el('div', {
      class: 'treerow lorecard' + (spec.selected ? ' on' : ''),
    }, [
      toggle,
      title,
      ...badges,
      spec.hint != null ? el('span', { class: 'hint', text: spec.hint }) : null,
      ...reorder,
      ...(spec.actions ?? []),
    ]);
  }
  if (spec.dimmed) row.style.opacity = '0.55';
  if (spec.onClick) {
    row.addEventListener('click', () => spec.onClick!());
    row.style.cursor = 'pointer';
  }
  return row;
}

/** The tree column's action strip (새 항목 · 새로고침 …). */
export function treeHead(actions: (HTMLElement | null)[]): HTMLElement {
  return el('div', { class: 'treehead' }, actions);
}

export function refreshButton(onRefresh: () => void): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '새로고침' });
  b.addEventListener('click', onRefresh);
  return b;
}
