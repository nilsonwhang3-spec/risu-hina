/**
 * Turn-group explorer: the leftmost column.
 *
 * A 394-turn chat scrolls essentially forever, and "turn 210" is a position
 * nobody can find by dragging. Groups of 50 give the transcript a spine - jump
 * to a decade, then scroll a screen or two.
 *
 * Each group also carries what is happening inside it, because that is the
 * other question being asked while scrolling: where are my edits? A group with
 * pending changes says so without having to be visited.
 */
import { el, clear } from './dom';
import type { Turn } from '../state';

const GROUP = 50;

export interface ExplorerOptions {
  onJump: (seq: number) => void;
  /** msgIds a pending replace would touch. */
  preview: () => Map<string, string> | null;
  /** msgIds a pending deletion would remove. */
  deleting: () => Set<string> | null;
}

export class Explorer {
  readonly root: HTMLElement;
  private turns: Turn[] = [];
  private activeStart = -1;

  constructor(private opts: ExplorerOptions) {
    this.root = el('div', { class: 'explorer' });
  }

  setTurns(turns: Turn[]): void {
    this.turns = turns;
    this.render();
  }

  /** Highlight the group containing the turn currently at the top of the view. */
  setVisible(seq: number): void {
    const start = Math.floor(seq / GROUP) * GROUP;
    if (start === this.activeStart) return;
    this.activeStart = start;
    for (const b of Array.from(this.root.querySelectorAll('.expgroup'))) {
      b.classList.toggle('on', Number((b as HTMLElement).dataset.start) === start);
    }
  }

  private render(): void {
    clear(this.root);
    if (!this.turns.length) {
      this.root.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '턴 없음' }));
      return;
    }
    const preview = this.opts.preview();
    const deleting = this.opts.deleting();
    const last = this.turns[this.turns.length - 1].seq;

    for (let start = 0; start <= last; start += GROUP) {
      const end = start + GROUP - 1;
      const inGroup = this.turns.filter((t) => t.seq >= start && t.seq <= end);
      if (!inGroup.length) continue;

      const changed = inGroup.filter((t) => t.changed || t.isNew).length;
      const pending = preview ? inGroup.filter((t) => preview.has(t.msgId)).length : 0;
      const doomed = deleting ? inGroup.filter((t) => deleting.has(t.msgId)).length : 0;

      const marks: string[] = [];
      if (changed) marks.push(`✎${changed}`);
      if (pending) marks.push(`◆${pending}`);
      if (doomed) marks.push(`✕${doomed}`);

      const b = el('button', {
        class: 'expgroup' + (start === this.activeStart ? ' on' : ''),
        dataset: { start: String(start) },
        title: `턴 ${start}–${Math.min(end, last)} (${inGroup.length}개)`,
      }, [
        el('span', { text: `${start}–${Math.min(end, last)}` }),
        marks.length ? el('span', { class: 'expmark', text: marks.join(' ') }) : null,
      ]);
      b.addEventListener('click', () => this.opts.onJump(start));
      this.root.appendChild(b);
    }
  }
}
