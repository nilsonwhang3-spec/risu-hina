/**
 * RisuAI modules: read the list, write one back, add one (pyserver/app/modules.py).
 *
 * A module (RisuAI `RisuModule`) is a bundle of lorebook, Regex, triggers,
 * assets, a toggle definition and a background embedding, combined with a bot,
 * a persona or a prompt preset. RisuAI keeps them in `db.modules`, which is on
 * the plugin allow-list for reading and writing.
 *
 * The backend edits a module as a card (its working copy is card rows under a
 * key of its own), so 반영 arrives here as the same `CardUpdate` a bot gets -
 * fields with before/after, whole lists with the list they were based on - and
 * this file maps it onto the module's own keys. The table is the mirror of
 * modules.py SCALAR_MAP / LIST_MAP; keep the two identical.
 *
 * One RisuAI caveat the panel tells the user about: RisuAI caches the modules
 * of the open chat (process/modules.ts getModules) until the module set
 * changes or its module settings page closes, so a module in use shows its
 * new content after that (or a reload).
 */
import { HostError, canon, type CardUpdate, type WriteResult } from './host';

/** card field -> module key (scalars). */
export const SCALAR_MAP: Record<string, string> = {
  name: 'name', creatorNotes: 'description', customModuleToggle: 'customModuleToggle',
  moduleNamespace: 'namespace', lowLevelAccess: 'lowLevelAccess', hideChatIcon: 'hideIcon',
  backgroundHTML: 'backgroundEmbedding', image: 'icon',
};
const BOOLS = new Set(['lowLevelAccess', 'hideChatIcon']);

/** card list -> module key. */
export const LIST_MAP: Record<string, string> = {
  globalLore: 'lorebook', customscript: 'regex', triggerscript: 'trigger', additionalAssets: 'assets',
};

export const MODULE_CACHE_NOTE =
  'RisuAI는 사용 중인 모듈 내용을 캐시해 둡니다. 지금 챗에서 쓰는 모듈이면 RisuAI 설정 → 모듈 화면을 한 번 열었다 닫거나 새로고침(F5)하면 새 내용이 적용됩니다.';

export type RawModule = Record<string, unknown>;

export interface ModuleSlice {
  modules: RawModule[];
  /** Turned on for every chat (RisuAI 설정 → 모듈 → 전역). */
  enabled: string[];
}

/** The database slice, with the 'db' permission dialog in mind (persona.ts readSlice). */
async function readSlice(): Promise<ModuleSlice> {
  const read = Risuai.getDatabase(['modules', 'enabledModules']);
  let slice: Record<string, unknown> | null | undefined;
  const quick = await Promise.race([
    read.then((v) => ({ v })),
    new Promise<null>((r) => setTimeout(() => r(null), 900)),
  ]).catch((e) => { throw new HostError('failed', '모듈 목록을 읽지 못했습니다: ' + String(e)); });
  if (quick) slice = quick.v;
  else {
    try { await Risuai.hideContainer(); } catch { /* not shown */ }
    try {
      slice = await read;
    } catch (e) {
      throw new HostError('failed', '모듈 목록을 읽지 못했습니다: ' + String(e));
    } finally {
      try { await Risuai.showContainer('fullscreen'); } catch { /* fine */ }
    }
  }
  if (!slice || !Array.isArray(slice['modules'])) {
    throw new HostError('failed',
      "모듈을 읽으려면 'db' 권한이 필요합니다. RisuAI가 띄운 권한 요청을 허용하고 다시 시도해 주세요");
  }
  const enabled = Array.isArray(slice['enabledModules']) ? (slice['enabledModules'] as unknown[]).map(String) : [];
  return { modules: (slice['modules'] as RawModule[]).filter((m) => m && typeof m === 'object'), enabled };
}

export async function readModules(): Promise<ModuleSlice> {
  return await readSlice();
}

/** One module by its RisuAI id, read fresh. */
export async function readModule(id: string): Promise<RawModule> {
  const { modules } = await readSlice();
  const m = modules.find((x) => String(x['id'] ?? '') === id);
  if (!m) throw new HostError('missing', 'RisuAI에서 이 모듈을 찾지 못했습니다 (지워졌을 수 있습니다). 모듈 목록을 다시 읽어 주세요');
  return m;
}

/** The row text a module value encodes to (cardfields.ts rules for the two booleans). */
function encode(m: RawModule, field: string): string {
  const v = m[SCALAR_MAP[field]];
  if (BOOLS.has(field)) return v ? '1' : '0';
  return v === undefined || v === null ? '' : String(v);
}

function decodeInto(m: RawModule, field: string, text: string): void {
  const k = SCALAR_MAP[field];
  if (BOOLS.has(field)) { m[k] = text === '1'; return; }
  if ((k === 'namespace' || k === 'icon') && !text) { delete m[k]; return; }
  m[k] = text;
}

const LIST_LABEL: Record<string, string> = {
  globalLore: '모듈 로어북', customscript: 'Regex', triggerscript: '트리거', additionalAssets: '에셋',
};

/**
 * Write a card update onto the module `id`, in one setDatabase, and read it back.
 *
 * Same contract as host.writeCharacter: every edited scalar must still hold
 * the text the diff was drawn against, every list the list it was based on -
 * otherwise nothing is written - and the write only counts once a re-read
 * shows it.
 */
export async function writeModule(id: string, update: CardUpdate): Promise<WriteResult> {
  const { modules } = await readSlice();
  const at = modules.findIndex((x) => String(x['id'] ?? '') === id);
  if (at < 0) throw new HostError('missing', 'RisuAI에서 이 모듈을 찾지 못했습니다 (지워졌을 수 있습니다). 모듈 목록을 다시 읽어 주세요');
  const live = modules[at];
  for (const e of update.fields ?? []) {
    if (!(e.field in SCALAR_MAP)) throw new HostError('failed', `모듈에 없는 필드입니다: ${e.field}`);
    const now = encode(live, e.field);
    if (now !== e.before && now !== e.after) {
      throw new HostError('changed', `RisuAI 쪽에서 모듈이 바뀌었습니다 (${e.field}). 모듈을 다시 열어 병합한 뒤 반영해 주세요`);
    }
  }
  const upd = update as Record<string, unknown>;
  for (const [list, key] of Object.entries(LIST_MAP)) {
    const wanted = upd[list];
    const before = update.before?.[list as keyof NonNullable<CardUpdate['before']>];
    if (wanted && before !== undefined && canon(live[key] ?? []) !== canon(wanted)
        && canon(live[key] ?? []) !== canon(before ?? [])) {
      throw new HostError('changed', `RisuAI 쪽에서 ${LIST_LABEL[list]}이(가) 바뀌었습니다. 모듈을 다시 열어 병합한 뒤 반영해 주세요`);
    }
  }
  if (update.emotionImages?.length || update.ccAssets?.length) {
    throw new HostError('failed', '모듈은 감정 이미지·cc 에셋을 가질 수 없습니다 (에셋은 추가 에셋으로 넣어 주세요)');
  }
  const next: RawModule = { ...live };
  const parts: string[] = [];
  for (const e of update.fields ?? []) {
    decodeInto(next, e.field, e.after);
    parts.push(e.field);
  }
  for (const [list, key] of Object.entries(LIST_MAP)) {
    if (upd[list]) {
      next[key] = upd[list];
      parts.push(list);
    }
  }
  if (!parts.length) return { applied: 0, mode: 'noop', parts, verified: true };
  const all = modules.slice();
  all[at] = next;
  await Risuai.setDatabase({ modules: all });

  let verified = true;
  let drift = '';
  try {
    const after = (await readSlice()).modules.find((x) => String(x['id'] ?? '') === id);
    if (!after) throw new Error('쓴 뒤 모듈이 보이지 않습니다');
    const missed = (update.fields ?? []).find((e) => encode(after, e.field) !== e.after);
    if (missed) { verified = false; drift = `${missed.field} 이(가) 쓰기 전 값 그대로입니다`; }
    for (const [list, key] of Object.entries(LIST_MAP)) {
      if (verified && upd[list] && canon(after[key] ?? []) !== canon(upd[list])) {
        verified = false;
        drift = `${LIST_LABEL[list]} 이(가) 쓰기 전 내용 그대로입니다`;
      }
    }
  } catch (e) {
    verified = false;
    drift = '쓴 뒤 다시 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e));
  }
  return { applied: parts.length, mode: 'edits', parts, verified, ...(drift ? { drift } : {}) };
}

function newId(): string {
  try { return crypto.randomUUID(); } catch { /* below */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Append a NEW module (an import), with a fresh id as RisuAI's importer gives one. */
export async function createModule(module: RawModule): Promise<RawModule> {
  const { modules } = await readSlice();
  const id = newId();
  const made: RawModule = { ...module, id };
  await Risuai.setDatabase({ modules: [...modules, made] });
  const after = (await readSlice()).modules.find((x) => String(x['id'] ?? '') === id);
  if (!after) {
    throw new HostError('failed', 'RisuAI가 새 모듈을 받지 않았습니다. RisuAI가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요');
  }
  return after;
}

/** A module as the character-shaped object the asset importer reads. */
export function assetCarrier(m: RawModule): Record<string, unknown> {
  return { image: m['icon'] ?? '', additionalAssets: Array.isArray(m['assets']) ? m['assets'] : [] };
}

/** One line of what a module holds. */
export function moduleCounts(m: RawModule): { lore: number; regex: number; trigger: number; assets: number; toggles: boolean; mcp: boolean } {
  const n = (k: string) => (Array.isArray(m[k]) ? (m[k] as unknown[]).length : 0);
  return {
    lore: n('lorebook'), regex: n('regex'), trigger: n('trigger'), assets: n('assets'),
    toggles: !!String(m['customModuleToggle'] ?? '').trim(), mcp: !!m['mcp'],
  };
}
