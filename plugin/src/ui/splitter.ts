/**
 * Draggable divider between the turn list and the tool panel.
 *
 * The right panel is the one with a fixed basis, so dragging changes its size
 * and the left simply takes the rest. Driving the flexible side instead makes
 * the panel jitter as its content reflows mid-drag.
 *
 * Pointer capture rather than document-level listeners: the pointer can leave
 * the 5px gutter within one frame of starting a drag, and without capture the
 * drag dies the moment it becomes useful.
 *
 * **Two axes, one gutter.** On a phone the columns stack, so the same divider
 * has to drag vertically - and it has to notice the change at drag time rather
 * than at build time, because a rotation is a resize, not a reload. The axis is
 * read from the container's own layout direction, which is the thing the CSS
 * media query actually changes, so the two can never disagree.
 */
import { el } from './dom';

export interface SplitterOptions {
  /** The element whose width is driven (the fixed-basis side). */
  target: HTMLElement;
  /** Container the width is measured against, for the maximum. */
  container: HTMLElement;
  min?: number;
  storageKey?: string;
  /**
   * Which side of the gutter the target sits on. 'right' (default) is the
   * agent panel, measured from the container's far edge; 'left' is the tree
   * column, measured from the near edge - so a lorebook title that does not
   * fit can be given room without touching the agent.
   */
  side?: 'left' | 'right';
}

export function splitter(opts: SplitterOptions): HTMLElement {
  const gutter = el('div', { class: 'gutter' + (opts.side === 'left' ? ' leftside' : ''), title: '드래그해서 패널 크기를 조절합니다' });

  /** True while the container is stacking, i.e. on a narrow screen. */
  const vertical = () => {
    const dir = getComputedStyle(opts.container).flexDirection;
    return dir === 'column' || dir === 'column-reverse';
  };

  const apply = (px: number) => {
    const down = vertical();
    // A stacked layout has far less room, and the transcript needs less of it
    // than the agent does - so the floor drops rather than fighting the screen.
    const min = down ? 160 : (opts.min ?? 250);
    const keep = down ? 140 : 320;
    const span = down ? opts.container.clientHeight : opts.container.clientWidth;
    const size = Math.round(Math.min(Math.max(min, span - keep), Math.max(min, px)));
    opts.target.style.flexBasis = size + 'px';
    return size;
  };

  if (opts.storageKey) {
    void Risuai.pluginStorage.getItem(opts.storageKey).then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) apply(n);
    }).catch(() => { /* first run */ });
  }

  let dragging = false;
  gutter.addEventListener('pointerdown', (e) => {
    const ev = e as PointerEvent;
    dragging = true;
    gutter.classList.add('dragging');
    gutter.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  gutter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const ev = e as PointerEvent;
    // Measured from the container's far edge, so the number is the panel's own
    // size regardless of where the gutter happens to sit.
    const rect = opts.container.getBoundingClientRect();
    const left = opts.side === 'left';
    apply(vertical()
      ? (left ? ev.clientY - rect.top : rect.bottom - ev.clientY)
      : (left ? ev.clientX - rect.left : rect.right - ev.clientX));
  });

  const end = (e: Event) => {
    if (!dragging) return;
    dragging = false;
    gutter.classList.remove('dragging');
    try { gutter.releasePointerCapture((e as PointerEvent).pointerId); } catch { /* already released */ }
    if (opts.storageKey) {
      const w = parseInt(opts.target.style.flexBasis || '0', 10);
      if (w > 0) void Risuai.pluginStorage.setItem(opts.storageKey, w).catch(() => undefined);
    }
  };
  gutter.addEventListener('pointerup', end);
  gutter.addEventListener('pointercancel', end);

  // Double-click restores the default rather than leaving the user to nudge it
  // back by hand after dragging it somewhere unusable.
  gutter.addEventListener('dblclick', () => {
    // The agent's default is half the split (see .right in styles.ts).
    const back = apply(opts.side === 'left' ? 210 : (vertical() ? 360 : Math.round(opts.container.clientWidth / 2)));
    if (opts.storageKey) void Risuai.pluginStorage.setItem(opts.storageKey, back).catch(() => undefined);
  });

  return gutter;
}
