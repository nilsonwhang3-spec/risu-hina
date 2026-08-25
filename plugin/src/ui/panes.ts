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
  root.appendChild(splitter({ target: right, container: root, storageKey: 'panelWidth' }));
  root.appendChild(right);

  return { root, left, centre, right };
}
