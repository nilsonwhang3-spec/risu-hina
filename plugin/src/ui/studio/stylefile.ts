/**
 * The card file format helpers: front matter above a markdown body.
 *
 * The client-side mirror of studio.FRONT - split the front matter off so an
 * editor shows fields, not fence syntax. The backend stays the writer of
 * meta-only changes (set_meta); a full save goes through upload.
 */

const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

export function splitFront(text: string): { meta: Map<string, string>; body: string } {
  const meta = new Map<string, string>();
  const m = text.match(FRONT_RE);
  if (!m) return { meta, body: text };
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, ''));
  }
  return { meta, body: text.slice(m[0].length) };
}

export function joinFront(meta: Map<string, string>, body: string): string {
  const lines = [...meta.entries()].filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

// --- style documents ------------------------------------------------------------
//
// A style body is `## positive` / `## negative` sections. The parse mirrors
// the backend's read_style: no headings at all means one positive block (a
// pasted prompt should work, not demand a heading), and repeated positive
// sections concatenate.

const STYLE_SECTION = /^##+\s*(positive|negative|프롬프트|네거티브)\s*$/im;

export interface StyleDoc {
  meta: Map<string, string>;
  positive: string;
  negative: string;
}

export function parseStyleDoc(text: string): StyleDoc {
  const { meta, body } = splitFront(text);
  const parts = body.split(new RegExp(STYLE_SECTION.source, 'gim'));
  let positive = '';
  let negative = '';
  if (parts.length === 1) {
    positive = body.trim();
  } else {
    const head = parts[0].trim();
    if (head) positive = head;
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const name = parts[i].toLowerCase();
      const chunk = parts[i + 1].trim();
      if (name === 'negative' || name === '네거티브') negative = chunk;
      else positive = positive ? (positive + ', ' + chunk).replace(/^, |, $/g, '') : chunk;
    }
  }
  return { meta, positive, negative };
}

export function buildStyleDoc(doc: StyleDoc): string {
  let body = `## positive\n${doc.positive.trim()}\n`;
  if (doc.negative.trim()) body += `\n## negative\n${doc.negative.trim()}\n`;
  return joinFront(doc.meta, body);
}
