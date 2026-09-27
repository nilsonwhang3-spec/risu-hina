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

// --- generation settings carried by a style (§1-77) --------------------------------
//
// Front-matter keys use the job spec's own names (the backend's
// studio.style_gen reads the same ones and fills a spec's gaps with them);
// the panel's generation card uses its own short names.

/** [generation-card key, front-matter key] */
const GEN_META: [string, string][] = [
  ['model', 'model'], ['steps', 'steps'], ['scale', 'scale'], ['rescale', 'cfg_rescale'],
  ['sampler', 'sampler'], ['schedule', 'noise_schedule'], ['width', 'width'], ['height', 'height'],
  ['quality', 'qualityToggle'], ['ucPreset', 'ucPreset'],
  // The two web-client sampler flags: null on the card = not sent (the
  // service's own default), so they are only written when set.
  ['eulerBug', 'deliberate_euler_ancestral_bug'], ['brownian', 'prefer_brownian'],
];

const GEN_BOOL = new Set(['quality', 'eulerBug', 'brownian']);

export type GenSettings = Partial<{
  model: string; steps: number; scale: number; rescale: number; sampler: string; schedule: string;
  width: number; height: number; quality: boolean; ucPreset: number;
  eulerBug: boolean; brownian: boolean;
}>;

/** The settings a style's front matter carries (empty object = none). */
export function genFromMeta(meta: Map<string, string>): GenSettings {
  const out: Record<string, unknown> = {};
  for (const [g, m] of GEN_META) {
    const v = (meta.get(m) ?? '').trim();
    if (!v) continue;
    if (g === 'model' || g === 'sampler' || g === 'schedule') out[g] = v;
    else if (GEN_BOOL.has(g)) out[g] = /^(true|1|yes|on)$/i.test(v);
    else if (Number.isFinite(Number(v))) out[g] = Number(v);
  }
  return out as GenSettings;
}

/** Write `gen`'s settings into the front matter (replacing any earlier ones). */
export function writeGenMeta(meta: Map<string, string>, gen: Record<string, unknown>): void {
  for (const [g, m] of GEN_META) {
    const v = gen[g];
    if (v === undefined || v === null || v === '') meta.delete(m);
    else meta.set(m, String(v));
  }
}

export function clearGenMeta(meta: Map<string, string>): void {
  for (const [, m] of GEN_META) meta.delete(m);
}

export function describeGen(g: GenSettings): string {
  const bits: string[] = [];
  if (g.model) bits.push(g.model.replace(/^nai-diffusion-/, 'v'));
  if (g.steps !== undefined) bits.push(`${g.steps} steps`);
  if (g.scale !== undefined) bits.push(`CFG ${g.scale}`);
  if (g.rescale !== undefined) bits.push(`rescale ${g.rescale}`);
  if (g.sampler) bits.push(g.sampler);
  if (g.schedule) bits.push(g.schedule);
  if (g.width && g.height) bits.push(`${g.width}×${g.height}`);
  if (g.quality !== undefined) bits.push(g.quality ? '퀄리티 태그 ON' : '퀄리티 태그 OFF');
  if (g.ucPreset !== undefined) bits.push(`UC ${g.ucPreset}`);
  if (g.eulerBug !== undefined) bits.push(`euler 버그 ${g.eulerBug ? 'ON' : 'OFF'}`);
  if (g.brownian !== undefined) bits.push(`brownian ${g.brownian ? 'ON' : 'OFF'}`);
  return bits.join(' · ');
}
