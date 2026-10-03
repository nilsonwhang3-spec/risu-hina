/**
 * RisuAI user personas: read the list, write one back (§1-89).
 *
 * A persona is small - a name, a description (`personaPrompt`) and a profile
 * picture (`icon`, an `assets/<hash>.png` key) - and the plugin API reaches it
 * only through the database: `personas` and `selectedPersona` are on the v3
 * allow-list, nothing else persona-shaped is.
 *
 * The one rule that shapes this module: RisuAI keeps the SELECTED persona in
 * a second place. `db.username / userIcon / personaPrompt / userNote` are the
 * live copy, `personas[selectedPersona]` is only refreshed from them when the
 * user switches persona (persona.ts saveUserPersona), and those four keys are
 * not on the allow-list - a plugin write to them lands in pluginCustomStorage
 * and changes nothing. So an edit to the selected persona would show nowhere
 * and be overwritten by the stale live copy on the next switch. Only personas
 * that are NOT selected are written; the selected one is refused with the way
 * out (pick another persona in RisuAI first).
 */
import { HostError } from './host';

export interface Persona {
  /** Position in db.personas when read; re-derived before every write. */
  index: number;
  /** RisuAI's own id (v4); the default persona made from `username` has none. */
  id: string;
  name: string;
  prompt: string;
  /** Asset key of the picture, e.g. `assets/abc.png`; '' when none. */
  icon: string;
  selected: boolean;
}

export interface PersonaList {
  personas: Persona[];
  selected: number;
}

/**
 * The database slice, with the 'db' permission dialog in mind.
 *
 * RisuAI draws that dialog UNDER the fullscreen plugin container (see
 * host.cloneBot), and it only appears now and then (re-confirmed every few
 * days). Hiding the panel on every read would flash it each time, so the read
 * gets a moment first; if it has not answered by then a dialog is waiting, and
 * only then does the panel step aside for it.
 */
async function readSlice(): Promise<Record<string, unknown>> {
  const read = Risuai.getDatabase(['personas', 'selectedPersona']);
  let slice: Record<string, unknown> | null | undefined;
  const quick = await Promise.race([
    read.then((v) => ({ v })),
    new Promise<null>((r) => setTimeout(() => r(null), 900)),
  ]).catch((e) => { throw new HostError('failed', '페르소나 목록을 읽지 못했습니다: ' + String(e)); });
  if (quick) slice = quick.v;
  else {
    try { await Risuai.hideContainer(); } catch { /* not shown */ }
    try {
      slice = await read;
    } catch (e) {
      throw new HostError('failed', '페르소나 목록을 읽지 못했습니다: ' + String(e));
    } finally {
      try { await Risuai.showContainer('fullscreen'); } catch { /* fine */ }
    }
  }
  if (!slice || !Array.isArray(slice['personas'])) {
    throw new HostError('failed',
      "페르소나를 읽으려면 'db' 권한이 필요합니다. RisuAI가 띄운 권한 요청을 허용하고 다시 시도해 주세요");
  }
  return slice;
}

function toPersona(raw: Record<string, unknown>, index: number, selected: number): Persona {
  return {
    index,
    id: String(raw['id'] ?? ''),
    name: String(raw['name'] ?? ''),
    prompt: String(raw['personaPrompt'] ?? ''),
    icon: String(raw['icon'] ?? ''),
    selected: index === selected,
  };
}

export async function readPersonas(): Promise<PersonaList> {
  const slice = await readSlice();
  const raw = slice['personas'] as Record<string, unknown>[];
  const selected = Number(slice['selectedPersona'] ?? 0) || 0;
  return {
    personas: raw.map((p, i) => toPersona(p ?? {}, i, selected)),
    selected,
  };
}

/** Where `p` sits in the list now: by id when it has one, else by index+name. */
function locate(raw: Record<string, unknown>[], p: Persona): number {
  if (p.id) return raw.findIndex((x) => String(x?.['id'] ?? '') === p.id);
  const at = raw[p.index];
  return at && String(at['name'] ?? '') === p.name && !at['id'] ? p.index : -1;
}

export const SELECTED_REFUSAL =
  'RisuAI에서 지금 선택된 페르소나는 여기서 고칠 수 없습니다 — RisuAI가 선택된 페르소나를 따로 복사해 두고 쓰기 때문에, '
  + '고쳐도 화면에 안 보이고 다음에 페르소나를 바꿀 때 옛 내용으로 덮어써집니다. '
  + 'RisuAI에서 다른 페르소나를 잠깐 선택한 뒤 다시 시도해 주세요.';

/**
 * Write one persona's name / description / picture back, and confirm it.
 *
 * `before` is the persona as it was read when editing started; the write is
 * refused when RisuAI's copy has moved since (someone edited it there), or
 * when it has become the selected persona. `imageBytes`, when given, is
 * saved as a new asset first and becomes the icon.
 */
export async function writePersona(before: Persona, next: { name: string; prompt: string; icon?: string },
  imageBytes?: Uint8Array | null): Promise<Persona> {
  const slice = await readSlice();
  const raw = (slice['personas'] as Record<string, unknown>[]).slice();
  const selected = Number(slice['selectedPersona'] ?? 0) || 0;
  const at = locate(raw, before);
  if (at < 0) throw new HostError('missing', 'RisuAI에서 이 페르소나를 찾지 못했습니다 (지워졌을 수 있습니다). 목록을 다시 읽어 주세요');
  if (at === selected) throw new HostError('changed', SELECTED_REFUSAL);
  const live = toPersona(raw[at] ?? {}, at, selected);
  if (live.name !== before.name || live.prompt !== before.prompt || live.icon !== before.icon) {
    throw new HostError('changed', 'RisuAI 쪽에서 이 페르소나가 바뀌었습니다. 목록으로 돌아가 다시 열어 주세요 (편집 내용은 남겨 두었습니다)');
  }
  let icon = next.icon ?? live.icon;
  if (imageBytes && imageBytes.byteLength) {
    try {
      icon = await Risuai.saveAsset(imageBytes);
    } catch (e) {
      throw new HostError('failed', '프로필 이미지를 RisuAI에 저장하지 못했습니다: ' + String(e));
    }
  }
  raw[at] = { ...(raw[at] ?? {}), name: next.name, personaPrompt: next.prompt, icon };
  await Risuai.setDatabase({ personas: raw });
  // Read it back: the write is only reported once RisuAI holds it.
  const check = await readSlice();
  const after = (check['personas'] as Record<string, unknown>[]);
  const got = after[at] ? toPersona(after[at], at, Number(check['selectedPersona'] ?? 0) || 0) : null;
  if (!got || got.name !== next.name || got.prompt !== next.prompt || got.icon !== icon) {
    throw new HostError('failed', 'RisuAI가 페르소나 쓰기를 받지 않았습니다. RisuAI가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요');
  }
  return got;
}

/** The picture's bytes, or null (no icon, or the host would not hand it over). */
export async function personaImage(icon: string): Promise<Uint8Array | null> {
  if (!icon) return null;
  try {
    const b = await Risuai.readImage(icon);
    return b && (b as Uint8Array).byteLength ? (b as Uint8Array) : null;
  } catch {
    return null;
  }
}
