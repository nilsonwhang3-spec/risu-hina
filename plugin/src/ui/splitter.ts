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

/** Every splitter on a container, so one can re-clamp the others (§1-33):
 * the tree column and the agent pane each remembered a width that fit on
 * its own, and the two together did not - each applied its stored basis
 * before the other's had landed, and the sum overflowed the screen. */
const registry = new WeakMap<HTMLElement, Array<() => void>>();

/** Re-apply every splitter's current basis on this container - called after
 * a sibling's basis lands, and by anything that changes what fits (a rail
 * folding). Right side first: that pane is the one that yields. */
export function reclamp(container: HTMLElement): void {
  for (const fn of registry.get(container) ?? []) fn();
}

/** The right edge nothing may pass: the nearest clipping ancestor's, or the
 * viewport's. Every ancestor with overflow visible grows with the split. */
function limitRight(node: HTMLElement): number {
  let right = typeof document !== 'undefined' ? document.documentElement.clientWidth : Infinity;
  if (typeof getComputedStyle !== 'function') return right;
  for (let p = node.parentElement; p; p = p.parentElement) {
    const ox = getComputedStyle(p).overflowX;
    if (ox && ox !== 'visible') {
      right = Math.min(right, p.getBoundingClientRect().right);
      break;
    }
  }
  return right;
}

/** The element the ResizeObserver watches: the clipping ancestor (the one
 * the window resizes), never the split itself. */
function limitNode(node: HTMLElement): HTMLElement {
  if (typeof getComputedStyle === 'function') {
    for (let p = node.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox && ox !== 'visible') return p;
    }
  }
  return node.parentElement ?? node;
}

export function splitter(opts: SplitterOptions): HTMLElement {
  const gutter = el('div', { class: 'gutter' + (opts.side === 'left' ? ' leftside' : ''), title: '드래그해서 패널 크기를 조절합니다' });

  /** True while the container is stacking, i.e. on a narrow screen. */
  const vertical = () => {
    // No layout in the test DOM (linkedom): a row, then.
    if (typeof getComputedStyle !== 'function') return false;
    const dir = getComputedStyle(opts.container).flexDirection;
    return dir === 'column' || dir === 'column-reverse';
  };

  /** What the OTHER panes need: every visible sibling's current size, except
   * the centre (.left), which counts at its floor - it is the one that
   * yields. A fixed 320 used to stand in for this, and with the studio's
   * 300px explorer beside it the agent pane could be dragged past the
   * container's edge: the centre hit its min-width and the sum overflowed,
   * so dragging "did nothing" until a tab switch let the width land. */
  const keepFor = (down: boolean): number => {
    let keep = 0;
    for (const c of Array.from(opts.container.children)) {
      if (c === opts.target || c === gutter) continue;
      const node = c as HTMLElement;
      if (!node.offsetParent && getComputedStyle(node).display === 'none') continue;
      if (node.classList.contains('left')) { keep += down ? 140 : 260; continue; }
      keep += down ? node.offsetHeight : node.offsetWidth;
    }
    return Math.max(down ? 140 : 320, keep);
  };

  const apply = (px: number) => {
    const down = vertical();
    // A stacked layout has far less room, and the transcript needs less of it
    // than the agent does - so the floor drops rather than fighting the screen.
    const min = down ? 160 : (opts.min ?? 250);
    const keep = keepFor(down);
    const span = down ? opts.container.clientHeight : opts.container.clientWidth;
    // A hidden split (its tab is not the active one) measures 0 and would
    // clamp every pane to its floor; leave it for the observer that fires
    // when it is shown.
    if (span <= 0) {
      const cur = parseInt(opts.target.style.flexBasis || '0', 10);
      return cur > 0 ? cur : px;
    }
    let size = Math.round(Math.min(Math.max(min, span - keep), Math.max(min, px)));
    opts.target.style.flexBasis = size + 'px';
    // Belt: keepFor GUESSES the centre's floor, and a child whose intrinsic
    // min-content beats it (an unbreakable path string, a wide preview) still
    // pushes the far pane past the edge. Measure the actual overflow after
    // the basis lands and take it back out of the target. Horizontal only -
    // a stacked column scrolls vertically by design.
    if (!down) {
      // The split (and its .panel parent) grow past the screen when the
      // fixed-basis children do not fit, so the overflow is measured against
      // the nearest ancestor that clips - or the viewport - not the split's
      // own box (which is exactly what grew).
      const over = Math.round(opts.container.getBoundingClientRect().right - limitRight(opts.container));
      if (over > 0 && size - over >= min) {
        size -= over;
        opts.target.style.flexBasis = size + 'px';
      }
    }
    return size;
  };

  /** Clamp the CURRENT basis (no-op until a stored or dragged one exists). */
  const reapply = (): void => {
    if (vertical()) return;
    const cur = parseInt(opts.target.style.flexBasis || '0', 10);
    if (cur > 0) apply(cur);
  };
  {
    const list = registry.get(opts.container) ?? [];
    // The agent pane (right) yields first, so it is clamped first.
    if (opts.side === 'left') list.push(reapply); else list.unshift(reapply);
    registry.set(opts.container, list);
  }
  /** apply + let the siblings react: a basis landing late (the stored value
   * arrives async) is exactly the case the registry exists for. */
  const applyAll = (px: number): number => {
    const size = apply(px);
    for (const fn of registry.get(opts.container) ?? []) if (fn !== reapply) fn();
    return size;
  };

  if (opts.storageKey) {
    void Risuai.pluginStorage.getItem(opts.storageKey).then((v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) applyAll(n);
    }).catch(() => { /* first run */ });
  }

  // The container itself resizes - the RisuAI window narrows, a studio rail
  // collapses - and a px basis with flex-shrink:0 does not follow: the agent
  // pane sat past the right edge until the next drag (§1-27, seen on the
  // studio's 1장/배치). Re-clamp the current basis whenever the container
  // moves; the stored preference is untouched, so widening the window gives
  // the pane its size back on the next apply.
  try {
    // Two signals. The clipping ancestor is what the window resizes; the
    // split itself changes size when it is first SHOWN (a stored basis
    // applied while the panel was display:none measured nothing, so the
    // belt saw no overflow) and when it overflows. Each re-clamp is skipped
    // while the size it saw last has not moved, so a basis change that does
    // not change the size cannot loop.
    let lastOuter = 0;
    let lastOwn = 0;
    // The split is built before it is mounted, so its clipping ancestor is
    // unknown here; the viewport is the thing a window resize moves anyway.
    const watched = typeof document !== 'undefined' ? document.documentElement : limitNode(opts.container);
    new ResizeObserver(() => {
      const span = vertical() ? watched.clientHeight : watched.clientWidth;
      if (span === lastOuter) return;
      lastOuter = span;
      reapply();
    }).observe(watched);
    new ResizeObserver(() => {
      const own = vertical() ? opts.container.offsetHeight : opts.container.offsetWidth;
      if (own === lastOwn || own === 0) return;
      lastOwn = own;
      reapply();
    }).observe(opts.container);
  } catch { /* no ResizeObserver in the test DOM */ }

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
    // The other pane fits itself around the new width once the drag is done.
    for (const fn of registry.get(opts.container) ?? []) if (fn !== reapply) fn();
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
    const back = applyAll(opts.side === 'left' ? 210 : (vertical() ? 360 : Math.round(opts.container.clientWidth / 2)));
    if (opts.storageKey) void Risuai.pluginStorage.setItem(opts.storageKey, back).catch(() => undefined);
  });

  return gutter;
}
