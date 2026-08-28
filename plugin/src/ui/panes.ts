/**
 * The three-pane workbench every content tab uses.
 *
 *   left    what there is - turn groups, a folder tree, a list of entries
 *   centre  the thing itself
 *   right   the agent
 *
 * One shape rather than three, because the tabs are the same task on different
 * material: look at a list, open one, ask the agent to change it. A tab that
 * invented its own arrangement would make the agent feel like a different tool
 * depending on what was being edited.
 *
 * The agent panel is a **single shared instance** moved between tabs, not one
 * per tab. There is one conversation with one agent; three panels would mean
 * three histories and three costs for what the user experiences as one chat.
 */
import { el } from './dom';
import { splitter } from './splitter';

export interface ThreePaneParts {
  root: HTMLElement;
  left: HTMLElement;
  centre: HTMLElement;
  right: HTMLElement;
}

/**
 * Build the split. `leftNode` is placed as-is so a component can own it (the
 * turn explorer keeps its own element and its own state across renders).
 */
export function threePane(leftNode?: HTMLElement): ThreePaneParts {
  const left = leftNode ?? el('div', { class: 'explorer' });
  const centre = el('div', { class: 'left' });
  const right = el('div', { class: 'right' }, [el('div', { class: 'right-inner' })]);

  const root = el('div', { class: 'split' }, [left]);
  // The tree column is resizable too: lorebook titles are sentences, and a
  // fixed 210px cut most of them off.
  root.appendChild(splitter({ target: left, container: root, storageKey: 'treeWidth', side: 'left', min: 120 }));
  root.appendChild(centre);
  root.appendChild(splitter({ target: right, container: root, storageKey: 'panelWidth2' }));
  root.appendChild(right);
  // First child: under the mobile breakpoint the split is a column and the
  // bar sits across its top. Desktop CSS hides it.
  root.insertBefore(mobileBar(root), root.firstChild);

  return { root, left, centre, right };
}

// --- phones: one view at a time ---------------------------------------------
//
// Stacking three panes on a 390px screen left the conversation a third of
// the height and the editor in the way of it. Under the mobile breakpoint the
// split shows either the agent (default) or the editor side, and a floating
// button swaps them. The choice is remembered and shared by every tab, so
// switching tabs does not flip the view back.

type MobileView = 'agent' | 'centre';
const VIEW_KEY = 'hina.mobileView';
let mobileView: MobileView = 'agent';
try {
  const v = localStorage.getItem(VIEW_KEY);
  if (v === 'centre' || v === 'agent') mobileView = v;
} catch { /* storage may be unavailable in the iframe */ }
// Every live split's sync, keyed by its root so re-rendered tabs drop out.
const toggles = new Map<HTMLElement, () => void>();

function syncAll(): void {
  for (const [root, t] of [...toggles]) {
    if (!root.isConnected && toggles.size > 1) { toggles.delete(root); continue; }
    t();
  }
}

// Whether the tree explorer (lorebook, meta fields...) is opened out on a
// phone. Off by default: the list is short and the entry gets the screen.
let mobileList = false;

function mobileBar(root: HTMLElement): HTMLElement {
  const editBtn = el('button', { text: '📄 편집', title: '편집 화면 (모바일)' });
  const agentBtn = el('button', { text: '💬 AI 챗', title: 'AI 챗 (모바일)' });
  const listBtn = el('button', { class: 'ghost tiny mlist', title: '왼쪽 목록을 펼치거나 접습니다' });
  const bar = el('div', { class: 'mbar' }, [el('div', { class: 'mseg' }, [editBtn, agentBtn]), listBtn]);
  const sync = () => {
    root.classList.toggle('m-agent', mobileView === 'agent');
    root.classList.toggle('m-centre', mobileView === 'centre');
    root.classList.toggle('m-list', mobileList);
    editBtn.classList.toggle('on', mobileView === 'centre');
    agentBtn.classList.toggle('on', mobileView === 'agent');
    listBtn.textContent = mobileList ? '☰ 목록 접기' : '☰ 목록 펼치기';
    // Only trees fold; a strip of jump targets has nothing to open.
    listBtn.style.display = root.querySelector('.explorer .tree') ? '' : 'none';
  };
  const pick = (v: MobileView) => {
    if (mobileView === v) return;
    mobileView = v;
    try { localStorage.setItem(VIEW_KEY, mobileView); } catch { /* fine */ }
    syncAll();
  };
  editBtn.addEventListener('click', () => pick('centre'));
  agentBtn.addEventListener('click', () => pick('agent'));
  listBtn.addEventListener('click', () => { mobileList = !mobileList; syncAll(); });
  toggles.set(root, sync);
  sync();
  // The tree mounts after the split is built; re-check once it is there.
  setTimeout(sync, 0);
  return bar;
}

/** Show the agent side on a phone (a proposal arrived, a run finished). */
export function showMobileAgent(): void {
  if (mobileView === 'agent') return;
  mobileView = 'agent';
  try { localStorage.setItem(VIEW_KEY, mobileView); } catch { /* fine */ }
  syncAll();
}
