/**
 * The one agent panel, shared by every tab that has a right pane.
 *
 * There is one conversation with one agent. Building a panel per tab would give
 * three histories, three cost lines and three "새 대화" buttons for something
 * the user experiences as a single chat - and switching tabs would silently
 * change which one they were talking to.
 *
 * So the panel is created once and re-parented. Its hooks are mutable rather
 * than fixed at construction, because what a staged proposal should *do*
 * depends on where you are looking: in the editor it paints a preview over the
 * turn list, and elsewhere there is no turn list to paint on.
 */
import { AgentPanel, type AgentPanelHooks } from './agent';
import type { StagedEdit } from '../state';

let panel: AgentPanel | null = null;

/** Whoever is currently interested in staged proposals and notices. */
let hooks: AgentPanelHooks = {
  onStagedChanged: () => { /* nobody is listening outside the editor */ },
  onApplied: () => { /* nor here */ },
  notice: () => { /* the tab supplies its own */ },
};

export function agentPanel(): AgentPanel {
  if (!panel) {
    // The indirection matters: the panel captures this object once, and the
    // tabs swap what it points at.
    panel = new AgentPanel({
      onStagedChanged: (s: StagedEdit[]) => hooks.onStagedChanged(s),
      onApplied: () => hooks.onApplied(),
      notice: (t, k) => hooks.notice(t, k),
    });
  }
  return panel;
}

/** Point the shared panel's callbacks at the tab that is now showing it. */
export function bindAgent(next: Partial<AgentPanelHooks>): void {
  hooks = { ...hooks, ...next };
}

/**
 * Move the panel into this container.
 *
 * `appendChild` moves rather than copies, so the panel keeps its DOM - the
 * half-typed message and any run in flight survive. The scroll position does
 * not: a detached element loses its scroll offset, so a tab switch used to
 * land the conversation at the top. It is saved and put back after layout.
 */
export function mountAgent(into: HTMLElement): void {
  const p = agentPanel();
  if (p.root.parentElement !== into) {
    const log = p.root.querySelector('.agentlog') as HTMLElement | null;
    const top = log?.scrollTop ?? 0;
    // Pinned to the bottom stays pinned even if the log grew meanwhile.
    const atBottom = !!log && log.scrollHeight - log.scrollTop - log.clientHeight < 4;
    into.appendChild(p.root);
    if (log) {
      const restore = () => { log.scrollTop = atBottom ? log.scrollHeight : top; };
      restore();
      requestAnimationFrame(restore);
    }
  }
  void p.load();
}

export function resetAgentPane(): void {
  panel = null;
}
