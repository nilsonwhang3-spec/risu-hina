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

/** The card fields the backend keeps as reference material. */
export function cardOf(char: RisuCharacter): Record<string, unknown> {
  const keys = [
    'name', 'chaId', 'type', 'desc', 'personality', 'scenario', 'firstMessage',
    'alternateGreetings', 'exampleMessage', 'systemPrompt', 'postHistoryInstructions',
    'creatorNotes', 'globalLore',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (char[k] !== undefined) out[k] = char[k];
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
  memory?: Record<string, unknown>;
}

export interface WriteResult {
  applied: number;
  mode: 'noop' | 'edits' | 'replace';
  /** Which parts of the chat object were written. */
  parts: string[];
}

/**
 * Write a chat update to the live chat, in one `setChatToIndex`.
 *
 * Turns, lorebook and memory all live on the same chat object, and RisuAI's
 * write replaces that object whole, so writing them one part at a time would
 * be three re-reads and three chances for the last write to carry a stale
 * copy of the other two. One read, one compose, one write.
 *
 * Mirrors the only prior art for writing chats back (cocoAgent): re-read
 * without the cache, confirm we are still looking at the same chat, confirm
 * each edited turn still holds the text the user was shown, then write once.
 * Any mismatch aborts the whole write rather than applying part of it.
 */
export async function writeChat(slot: Slot, seenChatId: string | undefined, update: ChatUpdate): Promise<WriteResult> {
  const fresh = await readChat(slot);
  if (seenChatId && fresh.id && fresh.id !== seenChatId) {
    throw new HostError('changed', '챗이 바뀌었습니다 (복사·브랜치 직후일 수 있습니다). 다시 불러와 주세요');
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

  if (!parts.length) return { applied: 0, mode: 'noop', parts };
  await Risuai.setChatToIndex(slot.characterIndex, slot.chatIndex, next);
  return { applied, mode, parts };
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
  const blob = new Blob([text], { type: mime });
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
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}
