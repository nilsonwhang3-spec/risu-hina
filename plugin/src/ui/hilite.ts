/**
 * Background-tint syntax colouring and autocomplete for plain textareas.
 *
 * The structure is the reference prompt editor's (its predecessor's postmortem, adopted):
 * the TEXTAREA alone draws the glyphs - selection, caret and IME all stay
 * native - while a mirror <div> behind it repeats the text transparently and
 * paints only backgrounds. Both layers share the same typography (copied
 * from the textarea's computed style), so the tints sit exactly under their
 * characters. Colouring the glyphs themselves would mean either a
 * transparent-text textarea (broken IME/selection) or a double draw (blur);
 * background bands are what survives contact with a real editor.
 *
 * Two modes:
 *   'nai'  NovelAI prompt syntax - {} emphasis / [] de-emphasis per the reference tool's
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

// --- NAI weight parsing (the reference tool prompt-weights.ts, algorithm adopted) -----------

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
 * The exact rgba curve is the reference tool's, so both editors read the same. */
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
// Shared tint palette for the code modes (regex / lua): the same colour
// families nai and md already use, kept faint - these are tints, not a lexer.
const STRING_BG = 'rgba(92, 190, 125, 0.22)';
const KEYWORD_BG = 'rgba(96, 145, 235, 0.18)';
const META_BG = 'rgba(233, 94, 80, 0.18)';
const CBS_BG = 'rgba(124, 92, 255, 0.24)';

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
    ...regexSpans(text, /\{\{[^{}\n]+\}\}/g, CBS_BG, 4),
  ];
  return flatten(text, spans);
}

/** find (in) - a regular expression: classes green, escapes red, operators blue. */
function regexRanges(text: string): Range[] {
  const spans: Span[] = [
    ...regexSpans(text, /\[(?:\\.|[^\]\\])*\]/g, STRING_BG, 3),
    ...regexSpans(text, /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\./g, META_BG, 4),
    ...regexSpans(text, /[*+?|]|\{\d+(?:,\d*)?\}|\((?:\?[:=!<]*)?|\)/g, KEYWORD_BG, 2),
  ];
  return flatten(text, spans);
}

/** replace (out) / backgroundHTML: CBS calls, $ backrefs, HTML comments.
 * (These bodies are HTML by the kiloline - a full HTML mode is out of scope.) */
function regexOutRanges(text: string): Range[] {
  const spans: Span[] = [
    ...regexSpans(text, /\{\{[^{}\n]+\}\}/g, CBS_BG, 4),
    ...regexSpans(text, /\$(?:\d{1,2}|&|<[^>\n]+>)/g, KEYWORD_BG, 3),
    ...regexSpans(text, /<!--[\s\S]*?-->/g, COMMENT_BG, 2),
  ];
  return flatten(text, spans);
}

// Lua comments and strings cross lines, so one scanner walks the text once.
// Keywords ride regexSpans at a LOWER prio and lose inside these islands -
// flatten()'s prio rule does the context tracking for free.
function luaIslands(text: string): Span[] {
  const out: Span[] = [];
  const n = text.length;
  // '[' then '='* then '[' -> the '=' count, else null.
  const longOpen = (at: number): number | null => {
    if (text[at] !== '[') return null;
    let j = at + 1;
    while (text[j] === '=') j++;
    return text[j] === '[' ? j - at - 1 : null;
  };
  const longClose = (from: number, eq: number): number => {
    const close = ']' + '='.repeat(eq) + ']';
    const at = text.indexOf(close, from);
    return at === -1 ? n : at + close.length;
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const eq = longOpen(i + 2);
      let end: number;
      if (eq !== null) end = longClose(i + 4 + eq, eq);
      else { const nl = text.indexOf('\n', i); end = nl === -1 ? n : nl; }
      out.push({ start: i, end, bg: COMMENT_BG, prio: 5 });
      i = end;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      const end = j < n && text[j] === c ? j + 1 : j;
      out.push({ start: i, end, bg: STRING_BG, prio: 4 });
      i = Math.max(end, i + 1);
    } else {
      const eq = longOpen(i);
      if (eq !== null) {
        const end = longClose(i + 2 + eq, eq);
        out.push({ start: i, end, bg: STRING_BG, prio: 4 });
        i = end;
      } else i++;
    }
  }
  return out;
}

// The RisuAI hook names ride along with the language keywords: these bodies
// are trigger scripts, and the hooks are what a reader scans for (the list
// mirrors pyserver/app/seeds/risuai-lua.md).
const LUA_KEYWORDS = /\b(?:and|break|do|elseif|else|end|false|for|function|goto|if|in|local|nil|not|or|repeat|return|then|true|until|while|onStart|onOutput|onInput|onButtonClick|listenEdit|getChatVar|setChatVar)\b/g;

function luaRanges(text: string): Range[] {
  const spans: Span[] = [
    ...luaIslands(text),
    ...regexSpans(text, LUA_KEYWORDS, KEYWORD_BG, 1),
  ];
  return flatten(text, spans);
}

// --- the mirror ------------------------------------------------------------------

// What the mirror must copy for its line breaks to match the textarea's
// exactly (the reference tool caret.ts's list, plus the box itself).
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

// Where a danbooru-tag token starts (the reference tool's separator set; ':' covers '::').
const TAG_TOKEN_SEPARATORS = /[,\n{}[\]|<>:/]/;

function fmtCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return count > 0 ? String(count) : '';
}

export interface HiliteOpts {
  mode: 'nai' | 'md' | 'regex' | 'regex-out' | 'lua';
  /** Fragment names for `<` completion (nai mode). */
  fragments?: () => string[];
  /** Turn tag autocomplete off (a negative box may still want colours). */
  noSuggest?: boolean;
}

const RANGES: Record<HiliteOpts['mode'], (text: string) => Range[]> = {
  nai: naiRanges, md: mdRanges, regex: regexRanges, 'regex-out': regexOutRanges, lua: luaRanges,
};

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
  try {
    // .codearea and .promptedit boxes carry different backgrounds; capture the
    // one this textarea had before hl-on turns it transparent, so the mirror
    // repaints it instead of the stylesheet's --darkbg default.
    const bg = getComputedStyle(ta).backgroundColor;
    if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') mirror.style.backgroundColor = bg;
  } catch { /* test DOM: no computed styles */ }
  ta.classList.add('hl-on');

  const render = (): void => {
    copyTypography(ta, mirror);
    try {
      // The textarea loses content width to its own scrollbar; the mirror
      // (overflow:hidden) does not. Pad the difference into the mirror or the
      // wrap points differ and every line after the first wrap slides.
      // (Deliberately not in copyTypography - caretCoords sizes by clientWidth
      // and would double-shrink.) linkedom: offsetWidth is 0, so no-op.
      if (ta.offsetWidth > 0) {
        const cs = getComputedStyle(ta);
        const bl = parseFloat(cs.borderLeftWidth) || 0;
        const br = parseFloat(cs.borderRightWidth) || 0;
        const sbw = Math.max(0, ta.offsetWidth - ta.clientWidth - bl - br);
        mirror.style.paddingRight = `${(parseFloat(cs.paddingRight) || 0) + sbw}px`;
        mirror.style.width = `${ta.offsetWidth}px`;
      }
    } catch { /* test DOM: no computed styles */ }
    const text = ta.value;
    const ranges = RANGES[opts.mode](text);
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
        // Folder-qualified keys render the folder as a dim prefix; insertion
        // (complete()) still uses the full key.
        const cut = s.name.lastIndexOf('/');
        if (cut > 0) {
          b.appendChild(el('span', { class: 'fold', text: '<' + s.name.slice(0, cut + 1) }));
          b.appendChild(el('span', { class: 'frag', text: s.name.slice(cut + 1) + '>' }));
        } else {
          b.appendChild(el('span', { class: 'frag', text: `<${s.name}>` }));
        }
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
