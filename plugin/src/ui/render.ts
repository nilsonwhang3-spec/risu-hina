/**
 * Turn body rendering.
 *
 * What the store holds is the **raw** message: RisuAI applies the character's
 * regex scripts and CBS at display time, so a turn as stored is full of things
 * the reader never normally sees - thinking chains, panel markup, emphasis
 * asterisks. Editing needs the raw text, reading needs the rendered text, and
 * the two are different enough that the panel has to offer both.
 *
 * This is deliberately NOT a reimplementation of RisuAI's display pipeline.
 * Running the character's own `customscript` regexes would be closer to the
 * truth but means executing untrusted patterns on multi-megabyte text (a ReDoS
 * hazard) and reimplementing CBS. What is here is the pragmatic subset that
 * removes the noise: drop reasoning blocks, drop markup that is not an image,
 * and turn emphasis into actual emphasis.
 */
import { el } from './dom';

/**
 * Three modes, in increasing fidelity to what RisuAI shows:
 *
 *   raw       exactly what is stored. Editing always targets this text.
 *   clean     noise removed - thinking blocks, non-image tags, emphasis marks.
 *             Not a RisuAI reproduction; see docs/03.
 *   rendered  the card's own editdisplay regexes plus its backgroundHTML CSS.
 *             Not implemented yet (docs/03 stage A) - the button exists so the
 *             ladder is visible, and it says so rather than pretending.
 */
export type ViewMode = 'raw' | 'clean' | 'rendered';

/**
 * Reasoning/scratchpad blocks. Case-insensitive, and the closing tag is
 * optional because a truncated response leaves the block unterminated - in
 * which case everything after the opening tag is scratchpad too.
 */
const THINK_TAGS = ['thoughts', 'think', 'thinking', 'reasoning', 'scratchpad', 'plan'];

const THINK_RE = new RegExp(
  `<(${THINK_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)`,
  'gi',
);

/** `<img ...>` is kept; every other tag is removed, its text content retained. */
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;

/** Fenced blocks that RisuAI cards commonly use for panels/status displays. */
const PANEL_RE = /```[\s\S]*?```/g;

export interface RenderOptions {
  stripThinking: boolean;
  stripTags: boolean;
  stripPanels: boolean;
  markdown: boolean;
  /** Colour "speech" and 'thought' the way the chat screen does. */
  quotes: boolean;
}

export const DEFAULT_RENDER: RenderOptions = {
  stripThinking: true,
  stripTags: true,
  stripPanels: false,
  markdown: true,
  quotes: true,
};

/**
 * Double quotes are speech, single quotes are inner thought.
 *
 * That is the convention these logs are written in, and RisuAI cards colour
 * them through their own regex scripts - which is why the raw text looks flat
 * here while the chat screen does not. Both straight and curly forms are
 * matched: what a model emits and what a user types by hand differ, and often
 * within one line.
 *
 * Deliberately single-line (no newline inside a quote). An unclosed quote
 * would otherwise swallow the rest of a turn and paint half a message.
 */
const SPEECH_RE = /[\u201C"][^\u201D"\n]*[\u201D"]/;
const THOUGHT_RE = /[\u2018'][^\u2019'\n]*[\u2019']/;

/** Produce the display text. Never mutates what gets saved. */
export function toDisplayText(raw: string, opts: RenderOptions): string {
  let out = raw;
  if (opts.stripThinking) out = out.replace(THINK_RE, '');
  if (opts.stripPanels) out = out.replace(PANEL_RE, '');
  if (opts.stripTags) {
    out = out.replace(TAG_RE, (m, name: string) =>
      String(name).toLowerCase() === 'img' ? m : '');
  }
  // Collapse the blank runs the removals leave behind, or every stripped block
  // becomes a hole in the text.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Render display text into a node, honouring `<img>` and markdown emphasis.
 *
 * Built with DOM calls rather than innerHTML: the text is model output and
 * putting it through innerHTML would let a chat containing markup inject
 * elements into our panel. The CSP would stop scripts, but layout-breaking
 * markup is annoying enough on its own.
 */
export function renderBody(raw: string, mode: ViewMode, opts: RenderOptions): HTMLElement {
  if (mode !== 'clean') {
    return el('div', { class: 'turn-body raw', text: raw });
  }
  const text = toDisplayText(raw, opts);
  const box = el('div', { class: 'turn-body' });
  if (!text) {
    box.appendChild(el('span', { class: 'hint', text: '(정리하고 나니 내용이 비었습니다 — 원문 보기로 확인해 주세요)' }));
    return box;
  }

  for (const piece of splitImages(text)) {
    if (piece.kind === 'img') {
      // Both hosts allow img-src blob:/data: now (mainline since 2026-08),
      // but a broken image must still degrade to a readable placeholder.
      const img = el('img', { class: 'turn-img', src: piece.src, alt: piece.alt || 'image' });
      img.addEventListener('error', () => {
        img.replaceWith(el('span', { class: 'hint', text: `[이미지: ${piece.alt || piece.src}]` }));
      });
      box.appendChild(img);
    } else {
      appendMarkdown(box, piece.text, opts);
    }
  }
  return box;
}

type Piece = { kind: 'text'; text: string } | { kind: 'img'; src: string; alt: string };

function splitImages(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /<img\b([^>]*)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    const attrs = m[1] || '';
    out.push({
      kind: 'img',
      src: (attrs.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim(),
      alt: (attrs.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1] ?? '').trim(),
    });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

/**
 * Emphasis, speech and thought, in one pass.
 *
 * One regex over the whole string rather than nested passes: a second pass
 * would have to walk the nodes the first one produced, and quotes routinely sit
 * inside emphasis (*"...that again?"*) so the passes would fight over the same
 * characters.
 */
function appendMarkdown(box: HTMLElement, text: string, opts: RenderOptions): void {
  const parts: string[] = [];
  if (opts.markdown) parts.push('\\*\\*[^*\n]+\\*\\*', '\\*[^*\n]+\\*', '`[^`\n]+`');
  if (opts.quotes) parts.push(SPEECH_RE.source, THOUGHT_RE.source);
  if (!parts.length) {
    box.appendChild(document.createTextNode(text));
    return;
  }
  const re = new RegExp('(' + parts.join('|') + ')', 'g');

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
    box.appendChild(inlineToken(m[0], opts));
    last = re.lastIndex;
  }
  if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
}

function inlineToken(tok: string, opts: RenderOptions): Node {
  if (opts.markdown) {
    if (tok.startsWith('**')) return el('strong', { text: tok.slice(2, -2) });
    if (tok.startsWith('`')) return el('code', { text: tok.slice(1, -1) });
    if (tok.startsWith('*')) return el('em', { text: tok.slice(1, -1) });
  }
  if (opts.quotes) {
    // The quote marks stay in the text. Stripping them would change what the
    // reader sees against what they are about to edit, and the raw view is the
    // one edits target.
    const head = tok[0];
    if (head === '"' || head === '\u201C') return el('span', { class: 'speech', text: tok });
    if (head === "'" || head === '\u2018') return el('span', { class: 'thought', text: tok });
  }
  return document.createTextNode(tok);
}

/** How much a turn shrinks when rendered - shown so the toggle is worth finding. */
export function noiseRatio(raw: string, opts: RenderOptions): number {
  if (!raw) return 0;
  const shown = toDisplayText(raw, opts).length;
  return Math.max(0, 1 - shown / raw.length);
}
