/**
 * Typed card rows (§1-66): how a non-string character value rides in a
 * card_fields row, and back.
 *
 * Every row the backend keeps is a string. A few character fields are not
 * (lowLevelAccess is a boolean, loreSettings an object or undefined), so both
 * sides encode them the same way and compare the encoded text. The backend's
 * mirror is `card.py` (BOOL_FIELDS / LORE_SETTINGS_KEYS) - keep them
 * identical, or a live value would look "changed" on every open.
 */
import type { RisuCharacter } from './risuai';

export const BOOL_FIELDS = new Set(['lowLevelAccess']);
export const LORE_SETTINGS_FIELD = 'loreSettings';

export interface LoreSettings {
  recursiveScanning: boolean;
  fullWordMatching: boolean;
  scanDepth: number;
  tokenBudget: number;
}

/** RisuAI's own defaults (database.svelte.ts: loreBookDepth 5, loreBookToken 800). */
export const LORE_SETTINGS_DEFAULTS: LoreSettings = {
  recursiveScanning: false, fullWordMatching: false, scanDepth: 5, tokenBudget: 800,
};

const LORE_KEYS: Array<[keyof LoreSettings, 'bool' | 'int']> = [
  ['recursiveScanning', 'bool'], ['fullWordMatching', 'bool'], ['scanDepth', 'int'], ['tokenBudget', 'int'],
];

/** loreSettings object -> row text; anything but an object is "use global" (""). */
export function encodeLoreSettings(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const v = value as Record<string, unknown>;
  return LORE_KEYS.map(([key, kind]) => {
    const raw = v[key] ?? LORE_SETTINGS_DEFAULTS[key];
    if (kind === 'bool') return `${key}=${raw ? '1' : '0'}`;
    const n = Number(raw);
    return `${key}=${Number.isFinite(n) ? Math.trunc(n) : LORE_SETTINGS_DEFAULTS[key]}`;
  }).join('\n');
}

/** Row text -> loreSettings object; null means "use the global settings". */
export function decodeLoreSettings(text: string): LoreSettings | null {
  if (!text.trim()) return null;
  const got = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) got.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  const out: Record<string, boolean | number> = { ...LORE_SETTINGS_DEFAULTS };
  for (const [key, kind] of LORE_KEYS) {
    const raw = got.get(key);
    if (raw === undefined) continue;
    if (kind === 'bool') out[key] = !['0', '', 'false', 'False'].includes(raw);
    else {
      const n = parseInt(raw, 10);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return out as unknown as LoreSettings;
}

/** The row text a live character value encodes to. */
export function encodeField(char: RisuCharacter, field: string): string {
  if (BOOL_FIELDS.has(field)) return char[field] ? '1' : '0';
  if (field === LORE_SETTINGS_FIELD) return encodeLoreSettings(char[field]);
  return String(char[field] ?? '');
}

/** Write a row's text onto a character, decoding typed fields. */
export function applyField(next: RisuCharacter, field: string, text: string): void {
  if (BOOL_FIELDS.has(field)) { next[field] = text === '1'; return; }
  if (field === LORE_SETTINGS_FIELD) {
    const v = decodeLoreSettings(text);
    if (v === null) delete next[field];
    else next[field] = v;
    return;
  }
  next[field] = text;
}
