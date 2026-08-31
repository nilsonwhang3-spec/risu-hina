/**
 * Background-tint syntax colouring and autocomplete for plain textareas.
 *
 * The structure is NAIS3's prompt editor (its NAIS2 postmortem, adopted):
 * the TEXTAREA alone draws the glyphs - selection, caret and IME all stay
 * native - while a mirror <div> behind it repeats the text transparently and
 * paints only backgrounds. Both layers share the same typography (copied
 * from the textarea's computed style), so the tints sit exactly under their
 * characters. Colouring the glyphs themselves would mean either a
 * transparent-text textarea (broken IME/selection) or a double draw (blur);
 * background bands are what survives contact with a real editor.
 *
 * Two modes:
 *   'nai'  NovelAI prompt syntax - {} emphasis / [] de-emphasis per NAIS3's
 *          parser, N::…:: numeric weights, <조각> references (green),
 *          # comment lines (grey) - plus autocomplete: `<` completes
 *          fragment names, any other token asks the backend's
 *          /studio/tag-suggest (NovelAI's own danbooru suggester).
 *   'md'   markdown landmarks - heading lines, **bold**, `code`, links,
 *          > quotes, and RisuAI's {{…}} CBS calls - for the lorebook and
 *          other markdown-ish bodies.
 */
import { el } from './dom';
import { state } from '../state';

// --- NAI weight parsing (NAIS3 prompt-weights.ts, algorithm adopted) -----------

interface WeightSegment { start: number; end: number; weight: number }

const STEP = 1.05;
const NUMERIC_OPEN = /^(-?\d+(?:\.\d+)?)::/;

function parseWeights(text: string): WeightSegment[] {
  const segments: WeightSegment[] = [];
  let braces = 0;
  let brackets = 0;
  const numeric: number[] = [];
  const effective = (): number => {
    const base = numeric.length > 0 ? numeric[numeric.length - 1] : 1;
    return base * Math.pow(STEP, braces) * Math.pow(STEP, -brackets);
  };
  let segStart = 0;
  let segWeight = effective();
  const boundary = (pos: number): void => {
    const w = effective();
    if (w === segWeight) return;
    if (pos > segStart) segments.push({ start: segStart, end: pos, weight: segWeight });
    segStart = pos;
    segWeight = w;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') { braces++; boundary(i); i++; }
    else if (ch === '}') { if (braces > 0) braces--; boundary(i + 1); i++; }
    else if (ch === '[') { brackets++; boundary(i); i++; }
    else if (ch === ']') { if (brackets > 0) brackets--; boundary(i + 1); i++; }
    else if (text.startsWith('::', i) && numeric.length > 0) {
      numeric.pop();
      boundary(i + 2);
      i += 2;
    } else {
      const m = NUMERIC_OPEN.exec(text.slice(i));
      if (m) {
        numeric.push(Number(m[1]));
        boundary(i);
        i += m[0].length;
      } else i++;
    }
  }
  if (text.length > segStart) segments.push({ start: segStart, end: text.length, weight: segWeight });
  return segments;
}

/** Emphasis (>1) reds, de-emphasis (<1) and negatives blue; 1.0 is silent.
 * The exact rgba curve is NAIS3's, so both editors read the same. */
function weightBackground(weight: number): string | null {
  if (weight === 1) return null;
  if (weight <= 0) return 'rgba(96, 145, 235, 0.45)';
  const steps = Math.abs(Math.log(weight) / Math.log(STEP));
  const alpha = Math.min(0.1 + steps * 0.09, 0.48);
  return weight > 1
    ? `rgba(233, 94, 80, ${alpha.toFixed(3)})`
    : `rgba(96, 145, 235, ${alpha.toFixed(3)})`;
}

const FRAGMENT_BG = 'rgba(92, 190, 125, 0.3)';
const COMMENT_BG = 'rgba(128, 128, 136, 0.28)';

interface Span { start: number; end: number; bg: string; prio: number }

interface Range { start: number; end: number; bg: string | null }

/** Overlapping spans into disjoint ranges; higher prio wins where they cross. */
function flatten(text: string, spans: Span[], weights: WeightSegment[] = []): Range[] {
  const bounds = new Set<number>([0, text.length]);
  for (const s of spans) { bounds.add(s.start); bounds.add(s.end); }
  for (const s of weights) { bounds.add(s.start); bounds.add(s.end); }
  const sorted = [...bounds].filter((n) => n >= 0 && n <= text.length).sort((a, b) => a - b);
  const ranges: Range[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i];
    const end = sorted[i + 1];
    let best: Span | null = null;
    for (const s of spans) {
      if (s.start <= start && start < s.end && (!best || s.prio > best.prio)) best = s;
    }
    const bg = best ? best.bg
      : weightBackground(weights.find((s) => s.start <= start && start < s.end)?.weight ?? 1);
    const prev = ranges[ranges.length - 1];
    if (prev && prev.bg === bg) prev.end = end;
    else ranges.push({ start, end, bg });
  }
  return ranges;
}

function lineSpans(text: string, test: (line: string) => boolean, bg: string, prio: number): Span[] {
  const out: Span[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    if (test(line)) out.push({ start: offset, end: offset + line.length, bg, prio });
    offset += line.length + 1;
  }
  return out;
}

function regexSpans(text: string, re: RegExp, bg: string, prio: number): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) {
    if (m.index !== undefined && m[0]) out.push({ start: m.index, end: m.index + m[0].length, bg, prio });
  }
  return out;
}

function naiRanges(text: string): Range[] {
  const spans: Span[] = [
    ...regexSpans(text, /<[^<>\n]+>/g, FRAGMENT_BG, 2),
    ...lineSpans(text, (l) => l.trimStart().startsWith('#'), COMMENT_BG, 3),
  ];
  return flatten(text, spans, parseWeights(text));
}

function mdRanges(text: string): Range[] {
  const spans: Span[] = [
    ...lineSpans(text, (l) => /^#{1,6}\s/.test(l), 'rgba(125, 211, 252, 0.16)', 1),
    ...lineSpans(text, (l) => /^\s*>/.test(l), 'rgba(128, 128, 136, 0.18)', 1),
    ...regexSpans(text, /\*\*[^*\n]+\*\*/g, 'rgba(233, 94, 80, 0.18)', 2),
    ...regexSpans(text, /`[^`\n]+`/g, 'rgba(128, 128, 136, 0.3)', 3),
    ...regexSpans(text, /\[[^\]\n]+\]\([^)\n]+\)/g, 'rgba(92, 190, 125, 0.22)', 2),
    // RisuAI CBS calls ride lorebook text; seeing their extent is the point.
    ...regexSpans(text, /\{\{[^{}\n]+\}\}/g, 'rgba(124, 92, 255, 0.24)', 4),
  ];
  return flatten(text, spans);
}

// --- the mirror ------------------------------------------------------------------

// What the mirror must copy for its line breaks to match the textarea's
// exactly (NAIS3 caret.ts's list, plus the box itself).
const COPY_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
  'lineHeight', 'textTransform', 'wordSpacing', 'textIndent', 'whiteSpace',
  'wordBreak', 'overflowWrap', 'tabSize', 'boxSizing',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
] as const;

function copyTypography(from: HTMLTextAreaElement, to: HTMLElement): void {
  try {
    const cs = getComputedStyle(from);
    for (const p of COPY_PROPS) {
      (to.style as unknown as Record<string, string>)[p] = cs[p as keyof CSSStyleDeclaration] as string;
    }
    to.style.borderStyle = 'solid';
    to.style.borderColor = 'transparent';
  } catch { /* the test DOM has no computed styles; tints just sit unaligned */ }
}

/** Pixel position of a character index inside the textarea (popup anchor). */
function caretCoords(ta: HTMLTextAreaElement, position: number): { left: number; top: number; height: number } {
  const div = document.createElement('div');
  try {
    copyTypography(ta as HTMLTextAreaElement, div);
  } catch { /* fine */ }
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.left = '-9999px';
  div.style.top = '0';
  div.style.width = `${ta.clientWidth || 300}px`;
  div.style.whiteSpace = 'pre-wrap';
  div.textContent = ta.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = ta.value.slice(position, position + 1) || '​';
  div.appendChild(marker);
  document.body.appendChild(div);
  const coords = { left: marker.offsetLeft, top: marker.offsetTop, height: marker.offsetHeight || 18 };
  div.remove();
  return coords;
}

// --- autocomplete ----------------------------------------------------------------

type Suggestion = { kind: 'frag'; name: string } | { kind: 'tag'; tag: string; count: number };

// Where a danbooru-tag token starts (NAIS3's separator set; ':' covers '::').
const TAG_TOKEN_SEPARATORS = /[,\n{}[\]|<>:/]/;

function fmtCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return count > 0 ? String(count) : '';
}

export interface HiliteOpts {
  mode: 'nai' | 'md';
  /** Fragment names for `<` completion (nai mode). */
  fragments?: () => string[];
  /** Turn tag autocomplete off (a negative box may still want colours). */
  noSuggest?: boolean;
}

/**
 * Attach colouring (and, in nai mode, autocomplete) to one textarea.
 *
 * The textarea is wrapped in place; callers keep their reference and their
 * listeners. Safe to call in the test DOM - anything the mirror cannot
 * measure there degrades to "no tint", never to an error.
 */
export function attachHilite(ta: HTMLTextAreaElement, opts: HiliteOpts): void {
  if (!ta.parentNode || (ta.parentElement && ta.parentElement.classList.contains('hlwrap'))) return;
  const wrap = el('div', { class: 'hlwrap' });
  const mirror = el('div', { class: 'hlmirror', 'aria-hidden': 'true' });
  ta.parentNode.insertBefore(wrap, ta);
  wrap.appendChild(mirror);
  wrap.appendChild(ta);
  ta.classList.add('hl-on');

  const render = (): void => {
    copyTypography(ta, mirror);
    const text = ta.value;
    const ranges = opts.mode === 'nai' ? naiRanges(text) : mdRanges(text);
    while (mirror.firstChild) mirror.removeChild(mirror.firstChild);
    for (const r of ranges) {
      const piece = text.slice(r.start, r.end);
      if (!piece) continue;
      const span = document.createElement('span');
      span.textContent = piece;
      if (r.bg) span.style.background = r.bg;
      mirror.appendChild(span);
    }
    if (text.endsWith('\n')) mirror.appendChild(document.createTextNode('​'));
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  };
  const syncScroll = (): void => {
    mirror.scrollTop = ta.scrollTop;
    mirror.scrollLeft = ta.scrollLeft;
  };
  ta.addEventListener('input', render);
  ta.addEventListener('scroll', syncScroll);
  try {
    // The drag-resize handle changes the box without an input event.
    new ResizeObserver(render).observe(ta);
  } catch { /* no ResizeObserver in the test DOM */ }
  render();

  if (opts.mode === 'nai' && !opts.noSuggest) attachSuggest(ta, opts);
}

function attachSuggest(ta: HTMLTextAreaElement, opts: HiliteOpts): void {
  let pop: HTMLElement | null = null;
  let items: Suggestion[] = [];
  let selected = 0;
  let tokenStart = -1;
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const close = (): void => {
    pop?.remove();
    pop = null;
    items = [];
  };

  const draw = (): void => {
    if (!items.length) { close(); return; }
    if (!pop) {
      pop = el('div', { class: 'suggestpop' });
      document.body.appendChild(pop);
    }
    while (pop.firstChild) pop.removeChild(pop.firstChild);
    items.slice(0, 8).forEach((s, i) => {
      const b = el('button', { class: i === selected ? 'on' : '' });
      if (s.kind === 'frag') {
        b.appendChild(el('span', { class: 'frag', text: `<${s.name}>` }));
      } else {
        b.appendChild(el('span', { text: s.tag }));
        const c = fmtCount(s.count);
        if (c) b.appendChild(el('span', { class: 'cnt', text: c }));
      }
      // mousedown, not click: the textarea's blur fires between the two and
      // would close the popup before a click could land.
      b.addEventListener('mousedown', (e) => {
        e.preventDefault();
        complete(items[i]);
      });
      pop!.appendChild(b);
    });
    // Under the caret, clamped on screen; above it when the bottom is close.
    try {
      const caret = caretCoords(ta, ta.selectionStart);
      const rect = ta.getBoundingClientRect();
      const vh = window.innerHeight || 768;
      const est = Math.min(items.length, 8) * 26 + 8;
      let left = rect.left + caret.left - ta.scrollLeft;
      let top = rect.top + caret.top - ta.scrollTop + caret.height + 4;
      left = Math.max(8, Math.min(left, (window.innerWidth || 1024) - 280));
      if (top + est > vh - 8) top = rect.top + caret.top - ta.scrollTop - est - 4;
      pop.style.left = left + 'px';
      pop.style.top = Math.max(8, top) + 'px';
    } catch { /* unmeasurable in the test DOM */ }
  };

  const refresh = (): void => {
    if (timer) clearTimeout(timer);
    const mySeq = ++seq;
    const cursor = ta.selectionStart;
    const before = ta.value.slice(0, cursor);
    // No suggestions inside a comment line - it is never sent anyway.
    const lineStart = before.lastIndexOf('\n') + 1;
    if (before.slice(lineStart).trimStart().startsWith('#')) { close(); return; }

    const frag = /<([^<>|]*)$/.exec(before);
    if (frag && opts.fragments) {
      const q = frag[1].toLowerCase();
      const names = opts.fragments().filter((n) => n.toLowerCase().includes(q)).slice(0, 8);
      tokenStart = cursor - frag[1].length;
      items = names.map((name) => ({ kind: 'frag' as const, name }));
      selected = 0;
      draw();
      return;
    }

    let sepIx = -1;
    for (let i = before.length - 1; i >= 0; i--) {
      if (TAG_TOKEN_SEPARATORS.test(before[i])) { sepIx = i; break; }
    }
    const rawToken = before.slice(sepIx + 1);
    const token = rawToken.trimStart();
    if (token.trim().length < 2) { close(); return; }
    tokenStart = sepIx + 1 + (rawToken.length - token.length);
    timer = setTimeout(() => {
      void state.studio.suggestTags(token.trim()).then((r) => {
        if (seq !== mySeq) return; // stale - the input moved on
        items = (r.tags ?? []).map((t) => ({ kind: 'tag' as const, tag: t.tag, count: t.count ?? 0 }));
        selected = 0;
        draw();
      }).catch(() => { /* autocomplete is a convenience, not a feature to error on */ });
    }, 160);
  };

  const complete = (s: Suggestion): void => {
    if (tokenStart < 0) return;
    const cursor = ta.selectionStart;
    let insert = s.kind === 'frag' ? s.name + '>' : s.tag;
    if (!ta.value.slice(cursor).trimStart().startsWith(',')) insert += ', ';
    ta.value = ta.value.slice(0, tokenStart) + insert + ta.value.slice(cursor);
    close();
    const pos = tokenStart + insert.length;
    try { ta.setSelectionRange(pos, pos); } catch { /* fine */ }
    ta.focus();
    // The caller's own listeners (debounced saves, counters) must hear this.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  ta.addEventListener('input', refresh);
  ta.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = (selected + 1) % Math.min(items.length, 8);
      draw();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected - 1 + Math.min(items.length, 8)) % Math.min(items.length, 8);
      draw();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      complete(items[selected]);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  ta.addEventListener('blur', () => {
    if (timer) clearTimeout(timer);
    seq++;
    setTimeout(close, 150);
  });
}
