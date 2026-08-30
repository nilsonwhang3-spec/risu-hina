/** Small DOM helpers. No framework, no eval - the sandbox CSP blocks eval. */

type Attrs = Record<string, unknown>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Child[] | Child = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v as object);
    else if (k === 'dataset' && typeof v === 'object') Object.assign(node.dataset, v as object);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'value' && node instanceof HTMLTextAreaElement) {
      node.value = String(v);
    } else if (k === 'value' && node instanceof HTMLInputElement) {
      node.value = String(v);
    } else if (k === 'checked' && node instanceof HTMLInputElement) {
      node.checked = Boolean(v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * A list filter box, the same one on every list tab.
 *
 * `onInput` typically redraws the list; the caller re-focuses the box after
 * the redraw (`.searchbox input`) because the redraw replaced this node.
 */
export function searchBox(value: string, onInput: (v: string) => void,
                          placeholder = '찾기'): HTMLElement {
  const input = el('input', { class: 'searchinput', placeholder, value });
  input.addEventListener('input', () => onInput(input.value));
  return el('div', { class: 'searchbox' }, [input]);
}

/** Re-focus the filter box after a redraw, caret at the end. */
export function refocusSearch(root: HTMLElement | null): void {
  // Filter boxes live on the menu line (shell.setToolbarSearch) now; a tab
  // passing its own column still finds one there.
  const input = (root?.querySelector('.searchbox input')
    ?? document.querySelector('.tabslot .searchbox input')) as HTMLInputElement | null;
  if (!input) return;
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* number inputs */ }
}

/**
 * Set and read a <select> through its options.
 *
 * `select.value = x` is the obvious way and it is not portable: linkedom, which
 * the smoke tests run against, exposes `value` as a getter only, so the
 * assignment throws rather than silently doing nothing. Expressing selection on
 * the option works in both, and browsers keep `.value` in sync from it.
 */
export function setSelected(sel: HTMLSelectElement, value: string): void {
  for (const opt of Array.from(sel.querySelectorAll('option'))) {
    const on = opt.value === value;
    opt.selected = on;
    // The attribute as well as the property: linkedom stores neither `.value`
    // on the select nor `.selected` on the option, so without this the test DOM
    // has no record of the choice at all and every read falls through to the
    // empty string - which then reads as "not the default".
    if (on) opt.setAttribute('selected', '');
    else opt.removeAttribute('selected');
  }
  try {
    sel.value = value;
  } catch {
    /* getter-only in the test DOM; the attribute carries it */
  }
}

export function selectedValue(sel: HTMLSelectElement): string {
  const options = Array.from(sel.querySelectorAll('option'));
  // The live choice first. In a browser, what the user picked is the option's
  // `.selected` property (and `sel.value`); the `selected` ATTRIBUTE is only
  // what setSelected stamped when the form was filled, and it stays on that
  // old option after the user changes the select - reading it first made
  // "직접 입력" look chosen after a key had been picked, and the preset saved
  // without the key. The attribute remains the fallback for the test DOM,
  // which tracks neither the property nor `.value`.
  const live = options.find((o) => o.selected === true && o.hasAttribute('selected') === false)
    ?? (typeof sel.value === 'string' && sel.value !== '' && options.find((o) => o.value === sel.value))
    ?? options.find((o) => o.selected === true);
  if (live) return live.value;
  const stamped = sel.querySelector<HTMLOptionElement>('option[selected]');
  // Last resort is the first option, which is what an untouched <select> shows.
  return stamped?.value ?? sel.value ?? options[0]?.value ?? '';
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function svg(path: string, size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}

export const ICON = {
  app: svg('<path d="M4 4h16v12H8l-4 4z"/><path d="M8 9h8"/><path d="M8 12h5"/>'),
  close: svg('<path d="M18 6 6 18M6 6l12 12"/>', 18),
  // A drawn arrow rather than the 🔄 emoji: the emoji renders at a different
  // weight and baseline from every other control in the header.
  reload: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>', 17),
  check: svg('<path d="m5 13 4 4L19 7"/>', 16),
  clip: svg('<path d="M21.4 11.1 12.3 20.2a5 5 0 0 1-7.1-7.1l9.2-9.2a3.3 3.3 0 1 1 4.7 4.7l-9.2 9.2a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5"/>', 17),
  pencil: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>', 15),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.66 1.03 1.28 1.05H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 17),
  warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>', 16),
};

/**
 * Two-click confirm for anything destructive.
 *
 * `window.confirm` can be blocked in a sandboxed iframe, so a modal is not a
 * dependable gate. The button arms, relabels, and disarms itself after a few
 * seconds - the same pattern active-recall settled on for the same reason.
 */
export interface ArmedControl {
  arm(): void;
  fire(): void;
  disarm(): void;
  readonly armed: boolean;
}

export function armed(button: HTMLButtonElement, label: string, confirmLabel: string,
                      run: () => void): ArmedControl {
  let armedNow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    armedNow = false;
    button.textContent = label;
    button.classList.remove('danger');
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    armedNow = true;
    button.textContent = confirmLabel;
    button.classList.add('danger');
    timer = setTimeout(disarm, 4000);
  };
  const fire = () => {
    disarm();
    run();
  };
  button.textContent = label;
  button.addEventListener('click', () => {
    if (!armedNow) arm();
    else fire();
  });
  // The controller lets another input path (the Delete key, a bar) share the
  // same two-step confirm instead of inventing a second one.
  return { arm, fire, disarm, get armed() { return armedNow; } };
}

/** Character-level diff, rendered as before/after fragments. */
export function diffFragments(before: string, after: string): { before: Node; after: Node } {
  let head = 0;
  const max = Math.min(before.length, after.length);
  while (head < max && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < max - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;

  const mk = (text: string, cls: string) => {
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(text.slice(0, head)));
    const mid = text.slice(head, text.length - tail);
    if (mid) frag.appendChild(el('span', { class: cls, text: mid }));
    frag.appendChild(document.createTextNode(text.slice(text.length - tail)));
    return frag;
  };
  return { before: mk(before, 'diff-del'), after: mk(after, 'diff-ins') };
}

export function fmtTime(ms: unknown): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return new Date(n).toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return '';
  }
}

/**
 * Toolbar glyphs. Emoji rather than inline SVG for the tool row: they read as
 * distinct shapes at 13px where monochrome strokes blur together, and they cost
 * nothing to render under a CSP with no img-src.
 */
export const TOOL = {
  snapshot: '🔖',
  discard: '↩',
  versions: '🕘',
  apply: '💾',
  export: '⬇',
  find: '🔍',
  cut: '✂',
  view: '👁',
  reload: '🔄',
  newChat: '➕',
  history: '🗂',
  info: 'ⓘ',
};

/**
 * Which glyph stands for which agent tool.
 *
 * A trace of bare function names reads as debug output; a glyph plus a short
 * label reads as "it looked, then it proposed", which is the thing worth
 * seeing at a glance.
 */
export const TOOL_GLYPH: Record<string, [string, string]> = {
  list_turns: ['📋', '훑기'],
  read_turns: ['📖', '읽기'],
  search_turns: ['🔍', '검색'],
  read_card: ['🪪', '카드'],
  read_lore: ['📚', '로어'],
  read_memory: ['🧠', '요약'],
  list_skills: ['🧩', '스킬 목록'],
  load_skill: ['🧩', '스킬'],
  stage_edit: ['✏️', '수정 제안'],
  stage_bulk: ['✏️', '일괄 제안'],
  stage_delete: ['✂️', '삭제 제안'],
  list_staged: ['📌', '제안 확인'],
  run_python: ['🐍', '스크립트'],
  write_file: ['💾', '파일 쓰기'],
  list_files: ['📁', '파일 목록'],
  read_file: ['📄', '파일 읽기'],
  web_search: ['🌐', '웹 검색'],
  show_artifact: ['📊', '아티팩트'],
  find_files: ['🔍', '파일 찾기'],
  search_files: ['🔍', '내용 검색'],
  studio_meta: ['🎛', '카드'],
};

/** A paper plane, for the send button. */
export const PAPER_PLANE =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg>';

/**
 * A popover anchored under an element, dismissed by click-away or Escape.
 *
 * Positioned against the viewport with `position: fixed` and a bounding rect,
 * not against `offsetParent`. The offset-parent chain depends on which
 * ancestor happens to be positioned, so the same call landed correctly from
 * one panel and far away from another; the rect is the same in both.
 */
/**
 * A centred modal with its own backdrop.
 *
 * A popover is right for a short list next to the thing it belongs to. A
 * preset editor is neither short nor incidental - it has ten fields including a
 * multi-line instruction box - and anchoring that to a button puts a form on
 * top of the settings it is editing. This takes the screen instead, which is
 * what "집중 팝업" means: one job, nothing else reachable, one way out.
 *
 * Escape and the backdrop both close it. There is no third dismissal, and no
 * click-outside-a-form surprise: the backdrop is the only outside there is.
 */
export function modal(title: string, body: HTMLElement, opts: {
  wide?: boolean;
  /** A form the user is typing into: the backdrop does not close it, only ✕ / Escape / 취소. */
  sticky?: boolean;
  /** Extra class on the box (the focus editor takes the whole screen). */
  cls?: string;
  onClose?: () => void;
} = {}): () => void {
  const closeBtn = el('button', { class: 'iconbtn', html: ICON.close, title: '닫기' });
  const box = el('div', { class: 'modalbox' + (opts.wide ? ' wide' : '') + (opts.cls ? ' ' + opts.cls : '') }, [
    el('div', { class: 'modalhead' }, [
      el('h2', { text: title }),
      el('span', { class: 'spacer' }),
      closeBtn,
    ]),
    el('div', { class: 'modalbody' }, [body]),
  ]);
  const back = el('div', { class: 'modalback' }, [box]);
  document.body.appendChild(back);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', esc, true);
    opts.onClose?.();
  };
  const esc = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  back.addEventListener('click', (e) => {
    // Only the backdrop itself, never a click that happened to bubble from a
    // field inside the box - and not at all for a sticky form.
    if (e.target === back && !opts.sticky) close();
  });
  document.addEventListener('keydown', esc, true);

  // Focus the first field so a keyboard user is not left on the backdrop.
  setTimeout(() => box.querySelector<HTMLElement>('input, textarea, select, button')?.focus(), 0);
  return close;
}

/**
 * Edit a text box in a screen-sized modal - "집중 편집".
 *
 * A Lua script or a lorebook entry is often hundreds of lines, and the
 * centre column shows a dozen of them at a time. The modal mirrors the
 * source box live (every keystroke lands in it), so there is no "apply"
 * step to forget and Escape loses nothing; 완료 just closes. The source's
 * own `input` listeners fire too, so a character count keeps counting.
 */
export function focusEdit(source: HTMLTextAreaElement, title: string, opts: { code?: boolean } = {}): void {
  const big = el('textarea', {
    class: 'focusarea' + (opts.code ? ' codearea' : ''),
    spellcheck: opts.code ? 'false' : 'true',
  }) as HTMLTextAreaElement;
  big.value = source.value;
  const count = el('span', { class: 'hint', text: `${big.value.length}자` });
  const sync = () => {
    source.value = big.value;
    count.textContent = `${big.value.length}자`;
    source.dispatchEvent(new Event('input', { bubbles: true }));
  };
  big.addEventListener('input', sync);
  const done = el('button', { class: 'primary', text: '완료' });
  const body = el('div', { class: 'focusbody' }, [
    big,
    el('div', { class: 'row focusfoot' }, [
      count,
      el('span', { class: 'hint grow', text: '입력은 바로 원래 상자에 반영됩니다. 저장은 원래 화면의 저장 버튼으로 합니다.' }),
      done,
    ]),
  ]);
  const close = modal(title, body, { cls: 'focusmodal', sticky: true });
  done.addEventListener('click', close);
  setTimeout(() => {
    big.focus();
    try { big.setSelectionRange(source.selectionStart, source.selectionEnd); } catch { /* fine */ }
  }, 0);
}

/** A ⤢ button that opens `focusEdit` on the box - the same one on every tab. */
export function focusButton(source: HTMLTextAreaElement, title: string, opts: { code?: boolean } = {}): HTMLElement {
  const b = el('button', { class: 'ghost tiny focusbtn', text: '⤢ 집중 편집', title: '화면 전체로 크게 편집합니다' });
  b.addEventListener('click', () => focusEdit(source, title, opts));
  return b;
}

// --- line diff -----------------------------------------------------------------

export interface DiffLine { kind: 'same' | 'del' | 'ins'; text: string }

/**
 * Line-level diff of two texts.
 *
 * Common head and tail are stripped first, so the quadratic part only sees
 * the lines that actually differ; past a size that would take real time in
 * the browser, the middle is reported as one replaced block rather than
 * computed - a rough answer now beats an exact one after a freeze.
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
         && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ kind: 'same', text: a[i] });
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  if (am.length && bm.length && am.length * bm.length <= 4_000_000) {
    // Longest common subsequence over the middle, walked back into ops.
    const n = am.length, m = bm.length;
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) { out.push({ kind: 'same', text: am[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: am[i] }); i++; }
      else { out.push({ kind: 'ins', text: bm[j] }); j++; }
    }
    while (i < n) out.push({ kind: 'del', text: am[i++] });
    while (j < m) out.push({ kind: 'ins', text: bm[j++] });
  } else {
    for (const t of am) out.push({ kind: 'del', text: t });
    for (const t of bm) out.push({ kind: 'ins', text: t });
  }
  for (let i = a.length - tail; i < a.length; i++) out.push({ kind: 'same', text: a[i] });
  return out;
}

/**
 * The diff as a block: a gutter mark per line (− / +) with the line beside
 * it, the way an IDE colours its margin, and long unchanged stretches
 * folded to a "… N줄 같음" line so a one-word edit in a 400-line entry
 * shows as one screen rather than four hundred.
 */
export function diffView(before: string, after: string, opts: { context?: number; code?: boolean } = {}): HTMLElement {
  const lines = lineDiff(before, after);
  const ctx = opts.context ?? 2;
  const dels = lines.filter((l) => l.kind === 'del').length;
  const ins = lines.filter((l) => l.kind === 'ins').length;
  const root = el('div', { class: 'diffview' + (opts.code ? ' code' : '') });
  root.appendChild(el('div', { class: 'diffsum' }, [
    el('span', { class: 'diff-ins-n', text: `+${ins}` }),
    el('span', { class: 'diff-del-n', text: `−${dels}` }),
    el('span', { class: 'hint', text: dels || ins ? ' 줄 (기준선 → 지금)' : ' 줄 — 내용이 같습니다' }),
  ]));
  // Which lines to show: every changed line plus `ctx` around it.
  const show = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) show[k] = true;
  });
  let hidden = 0;
  const flush = () => {
    if (hidden) root.appendChild(el('div', { class: 'diffskip', text: `… ${hidden}줄 같음 …` }));
    hidden = 0;
  };
  lines.forEach((l, i) => {
    if (!show[i]) { hidden++; return; }
    flush();
    root.appendChild(el('div', { class: 'diffline ' + l.kind }, [
      el('span', { class: 'diffmark', text: l.kind === 'del' ? '−' : l.kind === 'ins' ? '+' : ' ' }),
      el('span', { class: 'difftext', text: l.text || ' ' }),
    ]));
  });
  flush();
  return root;
}

/**
 * A folded "변경 내용" card for an edited item: closed by default (the
 * badge already says "수정"), one click shows what changed. `before` null
 * means nothing to compare against, and no card at all.
 */
export function diffCard(before: string | null, after: string, opts: { code?: boolean; open?: boolean } = {}): HTMLElement | null {
  if (before === null || before === after) return null;
  const lines = lineDiff(before, after);
  const n = lines.filter((l) => l.kind !== 'same').length;
  const body = el('div', { class: 'diffbody', style: { display: opts.open ? '' : 'none' } });
  const toggle = el('button', { class: 'ghost tiny', text: opts.open ? '변경 내용 접기' : `변경 내용 보기 (${n}줄)` });
  toggle.addEventListener('click', () => {
    const open = body.style.display === 'none';
    if (open && !body.childElementCount) body.appendChild(diffView(before, after, { code: opts.code }));
    body.style.display = open ? '' : 'none';
    toggle.textContent = open ? '변경 내용 접기' : `변경 내용 보기 (${n}줄)`;
  });
  if (opts.open) body.appendChild(diffView(before, after, { code: opts.code }));
  return el('div', { class: 'diffcard' }, [
    el('div', { class: 'row' }, [
      el('span', { class: 'hint grow', text: `기준선과 다릅니다 (${before.length}자 → ${after.length}자).` }),
      toggle,
    ]),
    body,
  ]);
}

export function popover(anchor: HTMLElement, content: HTMLElement): () => void {
  const pop = el('div', { class: 'popover' }, [content]);
  document.body.appendChild(pop);

  const rect = anchor.getBoundingClientRect();
  const vw = window.innerWidth || 1024;
  const vh = window.innerHeight || 768;
  // Never wider than the viewport: a content min-width (the catalog picker's
  // search box) would otherwise push the panel into a horizontal scroll on a
  // phone.
  pop.style.maxWidth = Math.max(200, vw - 16) + 'px';
  // Measure after insertion, then keep it on screen: anchored near the right
  // edge it would otherwise open off-panel, and near the bottom it would open
  // below the fold.
  const pw = pop.offsetWidth || 300;
  const ph = pop.offsetHeight || 200;
  const left = Math.max(8, Math.min(rect.left, vw - pw - 8));
  const below = rect.bottom + 4;
  const top = below + ph > vh - 8 ? Math.max(8, rect.top - ph - 4) : below;
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';

  const close = () => {
    pop.remove();
    document.removeEventListener('click', away, true);
    document.removeEventListener('keydown', esc, true);
  };
  const away = (e: Event) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !anchor.contains(t)) close();
  };
  const esc = (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') close();
  };
  // Deferred: the click that opened this must not immediately close it.
  setTimeout(() => {
    document.addEventListener('click', away, true);
    document.addEventListener('keydown', esc, true);
  }, 0);
  return close;
}
