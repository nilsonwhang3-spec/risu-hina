/**
 * Minimal markdown renderer for agent replies.
 *
 * Built with DOM calls, never innerHTML: this text comes from a model and is
 * about a chat log that may itself contain markup. The sandbox CSP would stop
 * scripts, but layout-breaking HTML is annoying enough on its own, and a
 * renderer that can only produce the elements listed here cannot produce any
 * others by accident.
 *
 * Deliberately small - headings, lists, code, quotes, emphasis, links, rules.
 * A full CommonMark implementation is a dependency and a bundle, and agent
 * replies are prose with the occasional list and code block.
 */
import { el } from './dom';

export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code. An unterminated fence runs to the end rather than being
    // dropped: a truncated reply should still show what it managed to say.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const pre = el('pre', { class: 'md-code' }, [el('code', { text: body.join('\n') })]);
      if (lang) pre.dataset.lang = lang;
      frag.appendChild(pre);
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      frag.appendChild(el('hr', { class: 'md-hr' }));
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = Math.min(4, heading[1].length);
      const h = el('div', { class: 'md-h md-h' + level });
      h.appendChild(inline(heading[2]));
      frag.appendChild(h);
      i++;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const q = el('div', { class: 'md-quote' });
      q.appendChild(renderMarkdown(body.join('\n')));
      frag.appendChild(q);
      continue;
    }

    // GFM table: a header row, a separator row of dashes (with optional
    // alignment colons), then body rows - each row a pipe-separated line.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => {
        const t = c.trim();
        return t.startsWith(':') && t.endsWith(':') ? 'mid' : t.endsWith(':') ? 'num' : '';
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const cellClass = (j: number) => aligns[j] || '';
      const thead = el('thead', {}, [el('tr', {}, header.map((h, j) => {
        const th = el('th', { class: cellClass(j) });
        th.appendChild(inline(h.trim()));
        return th;
      }))]);
      const tbody = el('tbody', {}, rows.map((r) => el('tr', {}, header.map((_, j) => {
        const td = el('td', { class: cellClass(j) });
        td.appendChild(inline((r[j] ?? '').trim()));
        return td;
      }))));
      frag.appendChild(el('div', { class: 'md-tablewrap' }, [el('table', { class: 'md-table' }, [thead, tbody])]));
      continue;
    }

    const bullet = line.match(/^\s*([-*+]|\d+\.)\s+/);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const list = el(ordered ? 'ol' : 'ul', { class: 'md-list' });
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
        if (!m) break;
        const li = el('li');
        li.appendChild(inline(m[1]));
        list.appendChild(li);
        i++;
      }
      frag.appendChild(list);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block, so a
    // wrapped sentence stays one paragraph instead of becoming several.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])
           && !(lines[i].includes('|') && isTableSeparator(lines[i + 1] ?? ''))) {
      para.push(lines[i]);
      i++;
    }
    const p = el('div', { class: 'md-p' });
    p.appendChild(inline(para.join('\n')));
    frag.appendChild(p);
  }
  return frag;
}

function isTableSeparator(line: string): boolean {
  // |---|:--:|--:| or ---|--- : every cell is dashes with optional colons.
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c)) && /-{2,}/.test(line);
}

/** Cells of a table row, outer pipes stripped, escaped pipes kept. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

function isBlockStart(line: string): boolean {
  return /^\s*```/.test(line)
    || /^#{1,4}\s/.test(line)
    || /^\s*>/.test(line)
    || /^\s*(?:[-*+]|\d+\.)\s/.test(line)
    || /^\s*([-*_])\1{2,}\s*$/.test(line);
}

const INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  let m: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    frag.appendChild(token(m[0]));
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function token(tok: string): Node {
  if (tok.startsWith('**') || tok.startsWith('__')) {
    return el('strong', { text: tok.slice(2, -2) });
  }
  if (tok.startsWith('`')) {
    return el('code', { class: 'md-inline-code', text: tok.slice(1, -1) });
  }
  if (tok.startsWith('[')) {
    const m = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (m) {
      // Only http(s): a javascript: or data: href in model output has no
      // legitimate use here and the CSP is not the right place to catch it.
      const href = /^https?:\/\//i.test(m[2]) ? m[2] : '';
      return href
        ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: m[1] })
        : document.createTextNode(m[1]);
    }
  }
  return el('em', { text: tok.slice(1, -1) });
}
