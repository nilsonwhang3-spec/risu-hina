/**
 * Every call into RisuAI goes through here.
 *
 * Three Phase 0 findings are encoded as code rather than as comments elsewhere:
 *
 *  - `getCurrentChatIndex()` reads `db.characters[selected].chatPage`, so with
 *    no character selected it **throws** rather than returning null. Every
 *    entry point has to survive that.
 *  - `setChatToIndex` writes only to an index that already exists, so adding a
 *    chat means growing `char.chats` and calling `setCharacterToIndex`.
 *  - Writes replace the whole object, so a stale snapshot silently clobbers
 *    whatever the user did in RisuAI meanwhile. Every write re-reads first and
 *    verifies identity before committing.
 */
import type { RisuChat, RisuCharacter, RisuMessage } from './risuai';

export interface Slot {
  characterIndex: number;
  chatIndex: number;
}

export class HostError extends Error {
  constructor(readonly code: 'noselect' | 'changed' | 'missing' | 'failed', message: string) {
    super(message);
    this.name = 'HostError';
  }
}

export const NO_SELECT_HINT =
  'RisuAI에서 봇을 열어 채팅 화면에 들어간 다음 다시 시도해 주세요';

export async function currentSlot(): Promise<Slot> {
  let characterIndex: number;
  try {
    characterIndex = await Risuai.getCurrentCharacterIndex();
  } catch (e) {
    throw new HostError('noselect', NO_SELECT_HINT);
  }
  if (characterIndex == null || characterIndex < 0) {
    throw new HostError('noselect', NO_SELECT_HINT);
  }
  try {
    const chatIndex = await Risuai.getCurrentChatIndex();
    if (chatIndex == null || chatIndex < 0) throw new HostError('noselect', NO_SELECT_HINT);
    return { characterIndex, chatIndex };
  } catch (e) {
    if (e instanceof HostError) throw e;
    throw new HostError('noselect', NO_SELECT_HINT);
  }
}

export async function readCharacter(characterIndex: number): Promise<RisuCharacter> {
  const char = await Risuai.getCharacterFromIndex(characterIndex);
  if (!char) throw new HostError('missing', `캐릭터 ${characterIndex}를 읽지 못했습니다`);
  return char;
}

export async function readChat(slot: Slot): Promise<RisuChat> {
  const chat = await Risuai.getChatFromIndex(slot.characterIndex, slot.chatIndex);
  if (!chat || !Array.isArray(chat.message)) {
    throw new HostError('missing', '챗을 읽지 못했습니다');
  }
  return chat;
}

/**
 * The card as uploaded to the backend: the whole character minus its chats.
 *
 * Used to be a 13-field whitelist, which silently dropped customscript,
 * triggerscript and every asset reference at upload time - the bot editor
 * needs all of them, and M2's charx builder needs the rest. Chats are
 * excluded because they are megabytes and travel on their own endpoint;
 * chatPage goes with them (it is chat UI state, not card content).
 */
export function cardOf(char: RisuCharacter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(char)) {
    if (k === 'chats' || k === 'chatPage') continue;
    out[k] = char[k];
  }
  return out;
}

export interface Edit { msgId: string; before: string; after: string }

/**
 * One write-back's worth of change. Every field is optional and only the
 * fields present are touched on the live chat.
 *
 *  - `edits`     per-turn body changes, addressed by chatId and verified
 *                against `before` on the live chat (non-structural case)
 *  - `messages`  the whole ordered array, once turns were inserted, deleted
 *                or reordered and a per-turn patch cannot express the result
 *  - `localLore` this chat's lorebook, whole list
 *  - `memory`    the long-term memory fields (hypaV3Data and friends)
 */
export interface ChatUpdate {
  edits?: Edit[];
  messages?: RisuMessage[];
  localLore?: unknown[];
  /** The lorebook as RisuAI last showed us, checked before replacing it. */
  loreBefore?: unknown[];
  /** The ordered turn ids + body hashes a whole-array replace is based on. */
  beforeTurns?: { id: string; h: number }[];
  memory?: Record<string, unknown>;
}

// --- comparing a list against what RisuAI holds now --------------------------
//
// A list material (lorebook, greetings, scripts, asset references) is written
// whole, so before 0.9 an entry the user added in RisuAI while the panel was
// open simply vanished - no error, no warning. The backend now sends the
// baseline list alongside the new one and these compare it with live.
//
// Never `JSON.stringify(a) === JSON.stringify(b)`: `structuredClone` and
// RisuAI's own save/load reorder object keys freely, so key order can never be
// part of the comparison. The rules here mirror `app/merge.py`'s `canon`, and
// the boolean set matters as much as the sorting - a card that has been
// through RisuAI's importer carries `selective: false` on every lorebook entry
// it read, and without treating a default as absent no write-back would ever
// pass again.

const DEFAULT_FALSE = new Set([
  'alwaysActive', 'selective', 'useRegex', 'enabled', 'case_sensitive',
  'scanDepth', 'loreCache', 'folder', 'activationPercent',
]);

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      const v = strip(src[k]);
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v) && !v.length) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length) continue;
      if (DEFAULT_FALSE.has(k) && (v === false || v === 0 || v === '0')) continue;
      out[k] = v;
    }
    return out;
  }
  return value;
}

export function canon(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(strip(value));
}

export function fnv32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    // Hash the UTF-8 bytes, so the backend's Python and this agree.
    const c = text.codePointAt(i) as number;
    for (const b of utf8(c)) h = Math.imul(h ^ b, 0x01000193) >>> 0;
    if (c > 0xffff) i += 1;
  }
  return h >>> 0;
}

function utf8(cp: number): number[] {
  if (cp < 0x80) return [cp];
  if (cp < 0x800) return [0xc0 | (cp >> 6), 0x80 | (cp & 63)];
  if (cp < 0x10000) return [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
  return [0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)];
}

/** Refuse the write when RisuAI's copy of a list is not what we based ours on. */
function checkList(what: string, live: unknown, before: unknown): void {
  if (canon(live ?? []) === canon(before ?? [])) return;
  throw new HostError('changed',
    `RisuAI 쪽에서 ${what}이(가) 바뀌었습니다. 패널을 다시 열어 병합한 뒤 반영해 주세요`);
}

export interface WriteResult {
  applied: number;
  mode: 'noop' | 'edits' | 'replace';
  /** Which parts of the chat object were written. */
  parts: string[];
  /**
   * Did RisuAI actually keep it?
   *
   * `setChatToIndex` resolving is not proof. A save encoder that skips the
   * write, another RisuAI instance saving its own stale copy over ours, a
   * chat the host holds only as a stub - all of them return without an error
   * and leave the old text in place. That was reported from real use: 반영
   * said it succeeded, and the panel then re-read RisuAI and replaced the
   * working copy with the text it had just failed to change. The edit was
   * gone from both sides.
   *
   * So the write is read back and compared. `false` means: do not commit, do
   * not re-read, keep the working copy, and say so.
   */
  verified: boolean;
  /** What came back instead, when it did not verify. */
  drift?: string;
}

/**
 * Write a chat update to the live chat, in one `setChatToIndex`.
 *
 * Turns, lorebook and memory all live on the same chat object, and RisuAI's
 * write replaces that object whole, so writing them one part at a time would
 * be three re-reads and three chances for the last write to carry a stale
 * copy of the other two. One read, one compose, one write.
 *
 * The write protocol, the same one any careful chat writer uses: re-read
 * without the cache, confirm we are still looking at the same chat, confirm
 * each edited turn still holds the text the user was shown, then write once.
 * Any mismatch aborts the whole write rather than applying part of it.
 */
export async function writeChat(slot: Slot, seenChatId: string | undefined, update: ChatUpdate): Promise<WriteResult> {
  const fresh = await readChat(slot);
  if (seenChatId && fresh.id && fresh.id !== seenChatId) {
    throw new HostError('changed', '챗이 바뀌었습니다 (복사·브랜치 직후일 수 있습니다). 다시 불러와 주세요');
  }

  // Every check first, then every write: a mismatch on the lorebook must not
  // leave the transcript already replaced.
  if (update.messages && update.beforeTurns) {
    const live = fresh.message.map((m) => ({ id: String(m.chatId ?? ''), h: fnv32(String(m.data ?? '')) }));
    if (canon(live) !== canon(update.beforeTurns)) {
      throw new HostError('changed',
        'RisuAI 쪽에서 챗이 바뀌었습니다 (턴이 늘었거나 수정되었습니다). 패널을 다시 열어 병합한 뒤 반영해 주세요');
    }
  }
  if (update.localLore && update.loreBefore) {
    checkList('로어북', fresh.localLore, update.loreBefore);
  }

  const next: RisuChat = { ...fresh };
  const parts: string[] = [];
  let applied = 0;
  let mode: WriteResult['mode'] = 'noop';

  if (update.messages) {
    next.message = update.messages;
    applied = update.messages.length;
    mode = 'replace';
    parts.push('message');
  } else if (update.edits?.length) {
    const byId = new Map<string, number>();
    fresh.message.forEach((m, i) => { if (m.chatId) byId.set(m.chatId, i); });
    for (const e of update.edits) {
      const idx = byId.get(e.msgId);
      if (idx === undefined) {
        throw new HostError('missing', `턴이 라이브 챗에 없습니다: ${e.msgId}`);
      }
      if (String(fresh.message[idx].data ?? '') !== e.before) {
        throw new HostError('changed', `RisuAI 쪽에서 턴이 바뀌었습니다 (${e.msgId}). 다시 불러와 주세요`);
      }
    }
    const edits = update.edits;
    next.message = fresh.message.map((m, i) => {
      const hit = edits.find((e) => byId.get(e.msgId) === i);
      // Spread the original message so chatId, generationInfo and every field
      // we do not know about ride along untouched.
      return hit ? { ...m, data: hit.after } : m;
    });
    applied = edits.length;
    mode = 'edits';
    parts.push('message');
  }

  if (update.localLore) {
    next.localLore = update.localLore;
    parts.push('localLore');
  }
  if (update.memory) {
    // Only the memory keys are replaced - `message` and everything else on
    // the chat object rides along untouched, because a memory edit must never
    // be able to disturb the transcript.
    Object.assign(next, update.memory);
    parts.push(...Object.keys(update.memory));
  }

  if (!parts.length) return { applied: 0, mode: 'noop', parts, verified: true };
  await Risuai.setChatToIndex(slot.characterIndex, slot.chatIndex, next);

  // Read it back. See WriteResult.verified for why resolving is not enough.
  let verified = true;
  let drift = '';
  try {
    const after = await readChat(slot);
    if (update.messages || update.edits?.length) {
      const want = next.message;
      const got = after.message ?? [];
      if (got.length !== want.length) {
        verified = false;
        drift = `턴 수가 다릅니다 (보낸 ${want.length}, 남은 ${got.length})`;
      } else {
        const bad = want.findIndex((m, i) => String(m.data ?? '') !== String(got[i]?.data ?? ''));
        if (bad >= 0) {
          verified = false;
          drift = `${bad + 1}번째 턴이 쓰기 전 내용 그대로입니다`;
        }
      }
    }
    if (verified && update.localLore && canon(after.localLore ?? []) !== canon(update.localLore)) {
      verified = false;
      drift = '로어북이 쓰기 전 내용 그대로입니다';
    }
  } catch (e) {
    // Could not check. Report it as unverified rather than assuming either
    // way - the caller's job is to not throw the working copy away.
    verified = false;
    drift = '쓴 뒤 다시 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e));
  }
  return { applied, mode, parts, verified, ...(drift ? { drift } : {}) };
}

/**
 * Save a copy as a new chat, carrying the working state - turns, lorebook
 * and memory - so the copy is what the panel shows, not what RisuAI held.
 *
 * `setChatToIndex` cannot append, so the character object has to grow and be
 * written back whole. The copy gets a fresh `chat.id` because two live chats
 * sharing an id break RisuAI's own list rendering.
 */
export async function saveAsCopy(
  slot: Slot,
  update: ChatUpdate,
  name: string,
): Promise<number> {
  const fresh = await readChat(slot);
  const char = await readCharacter(slot.characterIndex);
  const chats = Array.isArray(char.chats) ? char.chats.slice() : [];

  const copy: RisuChat = {
    ...fresh,
    ...(update.memory ?? {}),
    id: cryptoRandomId(),
    name,
    ...(update.messages ? { message: update.messages } : {}),
    ...(update.localLore ? { localLore: update.localLore } : {}),
  };
  chats.unshift(copy);
  await Risuai.setCharacterToIndex(slot.characterIndex, { ...char, chats });
  return 0;
}

/** One scalar card-field change, verified against `before` on the live card. */
export interface CardFieldEdit { field: string; before: string; after: string }

/**
 * One card write-back's worth of change. Only fields present are touched;
 * the three list materials are whole-list replacements, the same acceptance
 * the chat path gives localLore.
 */
export interface CardUpdate {
  fields?: CardFieldEdit[];
  alternateGreetings?: string[];
  globalLore?: unknown[];
  customscript?: unknown[];
  triggerscript?: unknown[];
  /** Binary card material (asset references). Written by approved asset actions only. */
  additionalAssets?: unknown[];
  emotionImages?: unknown[];
  ccAssets?: unknown[];
  /**
   * What each list looked like in RisuAI when we based our copy on it. A list
   * is replaced whole, so without this a change made in RisuAI while the panel
   * was open was overwritten with no error at all. Absent = no check (an
   * approved asset action, or a clone, which cannot clobber anything).
   */
  before?: {
    alternateGreetings?: unknown[];
    globalLore?: unknown[];
    customscript?: unknown[];
    triggerscript?: unknown[];
    additionalAssets?: unknown[];
    emotionImages?: unknown[];
    ccAssets?: unknown[];
  };
}

const LIST_LABEL: Record<string, string> = {
  alternateGreetings: '대체 인사말', globalLore: '봇 로어북',
  customscript: 'Regex', triggerscript: '트리거',
  additionalAssets: '에셋', emotionImages: '감정 이미지', ccAssets: '에셋',
};

/**
 * Write a card update to the live character, in one `setCharacterToIndex`.
 *
 * Same contract as writeChat: re-read without the cache, confirm identity
 * (chaId), confirm every edited scalar still holds the text the diff was
 * drawn against, then write once - any mismatch aborts the whole write.
 *
 * `chats` is force-carried from the fresh read and a CardUpdate that tries to
 * smuggle one in is refused outright: this is the one write path that could
 * destroy every conversation of a bot in a single call, so the invariant is
 * enforced here rather than trusted to callers.
 */
export async function writeCharacter(
  characterIndex: number,
  seenChaId: string | undefined,
  update: CardUpdate,
): Promise<WriteResult> {
  if ('chats' in update || 'chatPage' in update) {
    throw new HostError('failed', '카드 반영이 chats 를 건드리려 했습니다 - 버그입니다');
  }
  const fresh = await readCharacter(characterIndex);
  if (seenChaId && fresh.chaId && fresh.chaId !== seenChaId) {
    throw new HostError('changed', '선택된 봇이 바뀌었습니다. 봇 선택 탭에서 다시 불러와 주세요');
  }

  const next: RisuCharacter = { ...fresh };
  const parts: string[] = [];
  let applied = 0;

  // characterVersion is nested on a RisuAI character (additionalData.
  // character_version is what its UI edits; the importer also sets the
  // top-level twin). Read the nested one, write both.
  const liveValue = (field: string): string => {
    if (field === 'characterVersion') {
      const add = fresh['additionalData'] as Record<string, unknown> | undefined;
      const v = add && typeof add === 'object' ? add['character_version'] : undefined;
      return String(v ?? fresh['characterVersion'] ?? '');
    }
    return String(fresh[field] ?? '');
  };
  for (const e of update.fields ?? []) {
    if (liveValue(e.field) !== e.before) {
      throw new HostError('changed', `RisuAI 쪽에서 카드가 바뀌었습니다 (${e.field}). 다시 불러와 주세요`);
    }
  }
  // The lists, checked before anything is written (see checkList).
  for (const [key, label] of Object.entries(LIST_LABEL)) {
    const wanted = (update as Record<string, unknown>)[key];
    const before = update.before?.[key as keyof NonNullable<CardUpdate['before']>];
    if (wanted && before !== undefined) checkList(label, fresh[key], before);
  }
  for (const e of update.fields ?? []) {
    if (e.field === 'characterVersion') {
      const add = { ...((fresh['additionalData'] as Record<string, unknown> | undefined) ?? {}) };
      add['character_version'] = e.after;
      next['additionalData'] = add;
    }
    next[e.field] = e.after;
    applied += 1;
    parts.push(e.field);
  }
  if (update.alternateGreetings) {
    next.alternateGreetings = update.alternateGreetings;
    parts.push('alternateGreetings');
  }
  if (update.globalLore) {
    next.globalLore = update.globalLore;
    parts.push('globalLore');
  }
  if (update.customscript) {
    next['customscript'] = update.customscript;
    parts.push('customscript');
  }
  if (update.triggerscript) {
    next['triggerscript'] = update.triggerscript;
    parts.push('triggerscript');
  }
  for (const k of ['additionalAssets', 'emotionImages', 'ccAssets'] as const) {
    if (update[k]) {
      next[k] = update[k];
      parts.push(k);
    }
  }

  if (!parts.length) return { applied: 0, mode: 'noop', parts, verified: true };
  next.chats = fresh.chats;
  next.chatPage = fresh.chatPage;
  await Risuai.setCharacterToIndex(characterIndex, next);

  // Same reason as writeChat: mainline's save encoder is documented (in
  // cloneBot) to skip a character it decides has not changed, so a resolved
  // write is not a kept write.
  let verified = true;
  let drift = '';
  try {
    const after = await readCharacter(characterIndex);
    const missed = (update.fields ?? []).find((e) => String(after[e.field] ?? '') !== e.after);
    if (missed) {
      verified = false;
      drift = `${missed.field} 이(가) 쓰기 전 값 그대로입니다`;
    }
    // The asset lists verify too: adoption from the studio lands here, and a
    // write the save encoder skipped must not report itself as kept.
    const LISTS = ['globalLore', 'alternateGreetings', 'customscript', 'triggerscript',
                   'additionalAssets', 'emotionImages', 'ccAssets'] as const;
    for (const k of LISTS) {
      if (verified && update[k] && canon(after[k] ?? []) !== canon(update[k])) {
        verified = false;
        drift = `${LIST_LABEL[k] ?? k} 이(가) 쓰기 전 내용 그대로입니다`;
      }
    }
  } catch (e) {
    verified = false;
    drift = '쓴 뒤 다시 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e));
  }
  return { applied, mode: 'edits', parts, verified, ...(drift ? { drift } : {}) };
}

/**
 * Create a clone bot carrying the working card, as a NEW character.
 *
 * A new chaId is the one write that is safe on every host: mainline's save
 * encoder skips re-encoding an existing non-selected character (edits there
 * silently do not persist), but a chaId it has never seen is always encoded.
 * Assets are shared by reference - keys are content hashes and RisuAI's GC
 * scans every character, so nothing needs copying and the clone is instant.
 *
 * Needs the 'db' permission (getDatabase prompts on first use and returns
 * null when refused) because appending a character is a database write.
 */
export async function cloneBot(
  sourceIndex: number,
  seenChaId: string | undefined,
  name: string,
  update: CardUpdate,
  familyKey = '',
): Promise<string> {
  const src = await readCharacter(sourceIndex);
  if (seenChaId && src.chaId && src.chaId !== seenChaId) {
    throw new HostError('changed', '봇이 바뀌었습니다. 봇 선택 탭에서 다시 불러와 주세요');
  }

  const copy: RisuCharacter = structuredClone(src);
  // The copy shares the source's workspace: the backend reads this stamp on
  // upload (workspace.family_from_card). RisuAI keeps unknown extension keys
  // through save, export and charx import, so it survives round trips.
  if (familyKey) {
    const ext = { ...((copy['extentions'] as Record<string, unknown> | undefined) ?? {}) };
    ext['risu_hina'] = { ...((ext['risu_hina'] as Record<string, unknown> | undefined) ?? {}), family: familyKey };
    copy['extentions'] = ext;
  }
  for (const e of update.fields ?? []) copy[e.field] = e.after;
  if (update.alternateGreetings) copy.alternateGreetings = update.alternateGreetings;
  if (update.globalLore) copy.globalLore = update.globalLore;
  if (update.customscript) copy['customscript'] = update.customscript;
  if (update.triggerscript) copy['triggerscript'] = update.triggerscript;

  copy.chaId = cryptoRandomId();
  copy.name = name;
  delete copy['realmId'];

  // RisuAI asks for the 'db' permission with a dialog drawn UNDER the
  // fullscreen plugin container, so the first clone ever sat at "복제 중…"
  // until the user closed the panel and found the prompt waiting. The panel
  // steps aside for the read and comes back right after.
  let dbSlice: Record<string, unknown> | null = null;
  try { await Risuai.hideContainer(); } catch { /* not shown */ }
  try {
    dbSlice = await Risuai.getDatabase(['characters']);
  } catch (e) {
    throw new HostError('failed', '캐릭터 목록을 읽지 못했습니다: ' + String(e));
  } finally {
    try { await Risuai.showContainer('fullscreen'); } catch { /* fine */ }
  }
  const characters = dbSlice && Array.isArray(dbSlice['characters'])
    ? (dbSlice['characters'] as RisuCharacter[]).slice()
    : null;
  if (!characters) {
    throw new HostError('failed',
      "복제에는 'db' 권한이 필요합니다. RisuAI가 띄운 권한 요청을 허용하고 다시 시도해 주세요");
  }

  // The chats come along. readCharacter can hand back stubs for inactive
  // chats (PocketRisu loads them lazily), so they are taken from the database
  // slice, which holds the character whole; a chat that still has no message
  // list is a stub and is skipped. No real chat: one fresh chat, as before.
  const srcDb = characters.find((c) => c.chaId && c.chaId === src.chaId) ?? characters[sourceIndex];
  const srcChats = Array.isArray(srcDb?.chats) ? (srcDb.chats as Record<string, unknown>[]) : [];
  const real = srcChats.filter((c) => c && Array.isArray(c['message']));
  if (real.length) {
    copy.chats = structuredClone(real).map((c) => (c['id'] ? { ...c, id: cryptoRandomId() } : c)) as RisuCharacter['chats'];
    const page = Number(srcDb?.chatPage ?? src.chatPage ?? 0);
    copy.chatPage = Number.isFinite(page) ? Math.max(0, Math.min(page, real.length - 1)) : 0;
  } else {
    copy.chats = [{ message: [], note: '', name: 'Chat 1', localLore: [] }];
    copy.chatPage = 0;
  }
  characters.push(copy);
  await Risuai.setDatabase({ characters });
  // Without this the clone exists but the sidebar never shows it.
  try { await Risuai.checkCharOrder?.(); } catch { /* cosmetic on hosts without it */ }
  return copy.chaId ?? '';
}

function cryptoRandomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    // Same shape as RisuAI's uuidv4 output, so anything reading the field sees
    // what it expects even on a host without randomUUID.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }
}

/** Trigger a browser download. Verified working in the sandbox (allow-downloads). */
export function download(filename: string, text: string, mime = 'text/plain;charset=utf-8'): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Bytes variant: a charx or an image the backend built. */
export function downloadBytes(filename: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  // Copy into a plain ArrayBuffer: a SharedArrayBuffer-backed view is refused by Blob.
  const buf = new Uint8Array(bytes.byteLength);
  buf.set(bytes);
  downloadBlob(filename, new Blob([buf], { type: mime }));
}

function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

/**
 * Copy via a temporary textarea and execCommand.
 *
 * navigator.clipboard needs a permission the sandboxed iframe does not get;
 * execCommand is what every working RisuAI plugin uses and what the Phase 0
 * probe's copy button was verified with.
 */
export function copyToClipboard(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  try { ta.select(); } catch { /* bare DOM impls (tests) have no selection */ }
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
