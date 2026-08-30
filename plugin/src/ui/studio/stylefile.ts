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
