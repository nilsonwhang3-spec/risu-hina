/** App state and every backend call the UI makes. */
import { persistBaseline, watchPersist } from './persistwatch';
import { transport, BackendError, clientLog, type HealthInfo } from './transport';
import * as host from './host';
import * as personaHost from './persona';
import type { Persona } from './persona';
import * as moduleHost from './modules';

/** A RisuAI module's working copy, as the backend lists it (pyserver/app/modules.py). */
export interface ModuleRow {
  key: string; id: string; name: string; baseName: string; description: string;
  lore: number; regex: number; trigger: number; assets: number; toggles: boolean; lowLevelAccess: boolean;
  total: number; dirty: boolean; conflicts: number; folder: string; syncedAt: number;
}

/** A module as RisuAI holds it right now (the + picker and the 모듈 편집 list). */
export interface LiveModule {
  id: string; name: string; description: string; namespace: string;
  lore: number; regex: number; trigger: number; assets: number; toggles: boolean; lowLevelAccess: boolean;
  /** An MCP module: nothing here to edit. */
  mcp: boolean;
  /** On for every chat (RisuAI 설정 → 모듈). */
  global: boolean;
  /** Turned on for the open bot or the open chat. */
  linked: boolean;
}

/** A persona's backend row: RisuAI's copy (base) and the working copy (work). */
export interface PersonaRow {
  key: string; id: string; index: number; name: string; selected: boolean; gone: boolean;
  /** RisuAI changed it while it had unapplied edits here: 반영 overwrites that. */
  risuChanged?: boolean;
  folder: string;
  base: { name: string; prompt: string };
  work: { name: string; prompt: string; image: string };
  dirty: boolean; total: number;
  /** Made in Hina and not in RisuAI yet: 반영 appends it to RisuAI's list. */
  isNew?: boolean;
  /** The RisuAI picture, cached as a file (the AI views it); '' until cached. */
  iconPath: string; iconKey: string;
  checkpoints?: number;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
import { boundedAssets, foregroundWrite } from './operation';
import { syncAssets, syncBusy, describeSync, type SyncProgress, type SyncController } from './assets';
import type { RisuChat, RisuCharacter, RisuMessage } from './risuai';

/** The tabs that show a card - the bot's, or a module's while one is the target. */
const CARD_TABS = new Set(['meta', 'botlore', 'regex', 'trigger', 'assets']);

export interface ChatInfo {
  chatKey: string;
  chatId: string;
  chatIndex: number | null;
  name: string;
  turns: number;
  originalTurns: number;
  /** Set when the backend refused the upload (a stub read - RisuAI has not
   * loaded this chat itself yet). The text says what to do about it. */
  skipped?: string;
}

/** GET /workspace/dirty: pending state across the whole bot, for the leave
 * guard and the picker's badges. */
export interface DirtySummary {
  charKey: string;
  card: { dirty: boolean; total: number; conflicts: number };
  chats: {
    chatKey: string; chatId?: string; name: string;
    dirty: boolean; total: number; conflicts: number;
  }[];
  /** Personas holding unapplied work (§1-89); not bot-scoped. */
  personas?: { key: string; name: string; total: number }[];
  /** RisuAI modules holding unapplied work; not bot-scoped either. */
  modules?: { key: string; name: string; total: number; conflicts: number }[];
}

export interface WorkspaceInfo {
  /** The workspace shared with this bot's other versions ('' = its own). */
  familyKey?: string;
  /**
   * What the re-open merge did: how many rows followed RisuAI (`adopt`),
   * arrived (`insert`), went away (`delete`) and need a decision (`conflict`).
   * Absent on a first load and on a repeat open where nothing moved.
   */
  merge?: { adopt?: number; keep?: number; conflict?: number; insert?: number; delete?: number };
  charKey: string;
  charId: string;
  characterName: string;
  characterIndex: number | null;
  chats: ChatInfo[];
  totalTurns?: number;
  paths?: Record<string, string>;
}

export interface Turn {
  seq: number;
  msgId: string;
  role: string;
  time: number | null;
  name: string | null;
  body: string;
  /** Only present when the turn differs from the frozen original. */
  original?: string | null;
  changed: boolean;
  isNew: boolean;
  origin: string;
  /** Set when RisuAI changed this turn too; 반영 waits for a decision. */
  conflict?: { kind: string; theirs?: unknown; base?: unknown } | null;
}

export interface Patch {
  chatKey: string;
  edits: { msgId: string; seq: number; before: string; after: string }[];
  added: { msgId: string; seq: number; role: string; after: string }[];
  removed: { msgId: string; seq: number; before: string }[];
  structural: boolean;
  reordered: boolean;
  messages?: RisuMessage[];
  /** The ordered turn ids + body hashes a whole-array replace is based on. */
  beforeTurns?: { id: string; h: number }[];
  warnings: string[];
  /** This chat's lorebook, whole, plus how much of it differs from RisuAI. */
  lore?: { localLore: unknown[]; before?: unknown[]; changed: number; added: number; edited: number; deleted: number };
  /** The long-term memory fields, plus how many entries differ. */
  memory?: { data: Record<string, unknown>; changed: number };
}

/**
 * What is pending on the active chat, as counts.
 *
 * One object for turns, lorebook and memory, because the user sees them as one
 * thing - "what will 반영 write" - and a bar that counted only turns would say
 * 변경 없음 over a chat whose lorebook was rewritten.
 */
export interface Changes {
  chatKey: string;
  turns: { edited: number; added: number; removed: number; reordered: boolean; structural: boolean; total: number };
  lore: { added: number; edited: number; deleted: number; total: number };
  memory: { changed: number; vars: number; total: number; entries: number };
  total: number;
  staged: number;
  actions: number;
  /** Rows where our copy and RisuAI's both moved. 반영 waits for these. */
  conflicts: number;
  warnings: string[];
}

export interface WriteBackResult {
  mode: 'noop' | 'edits' | 'replace';
  applied: number;
  lore: number;
  memory: number;
  warnings: string[];
  /** Read back and confirmed kept (host.WriteResult.verified). A `false`
   * means the caller must not commit or re-read - the working copy is the
   * only surviving copy of the edit. */
  verified: boolean;
  drift?: string;
}

/** One row the merge could not decide on its own. */
export interface ConflictItem {
  kind: 'turn' | 'lore' | 'card_field' | 'card_script' | 'memory';
  id: string;
  label: string;
  charKey: string | null;
  chatKey: string | null;
  /** both-moved | deleted-upstream | weak-match */
  reason: string;
  tier: string;
  mine: unknown;
  /** null when RisuAI no longer has the item at all. */
  theirs: unknown;
  base: unknown;
  canTakeTheirs: boolean;
}

export interface StagedEdit {
  id: string;
  op: 'edit' | 'insert' | 'delete';
  msgId: string;
  seq: number | null;
  before: string | null;
  after: string | null;
  reason: string;
  batchId: string | null;
}

export interface AgentSessionInfo {
  sessionId: string;
  title: string;
  turns: number;
  cost: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkPlan {
  revision: number;
  mode: 'plan' | 'execute';
  document: string;
  tasks: { id: string; title: string; status: 'pending' | 'in_progress' | 'blocked' | 'completed'; evidence: string }[];
}

export interface AgentSession {
  plan?: WorkPlan;
  session: { sessionId: string; chatKey: string; title: string } | null;
  messages: { seq: number; role: string; content: unknown; cost: number | null;
              usage: Record<string, unknown> | null }[];
  /** Shown messages in the whole session; more than `messages.length` when
   * a `limit` clipped the list (§1-55). */
  messagesTotal?: number;
  staged: StagedEdit[];
  agentReady?: boolean;
  webSearch?: boolean;
}

/** One row of the backend's asset manifest for a bot (`GET /assets/list`). */
export interface AssetItem {
  seq: number;
  field: 'image' | 'emotion' | 'additional' | 'cc' | 'vits';
  name: string;
  key: string;
  ext: string;
  state: 'present' | 'missing' | 'failed';
  error: string;
  size: number | null;
  hash: string | null;
}

export interface WebsearchProvider {
  id: string; name: string; needsKey: boolean; needsUrl: boolean; note: string;
}

export type WebsearchMode = 'native' | 'gemini' | 'provider';

export interface WebsearchStatus {
  modes: { id: WebsearchMode; name: string; note: string }[];
  mode: WebsearchMode;
  nativeShape: string;
  nativeShapeLabel: string;
  agent: { model: string; host: string };
  gemini: {
    model: string; defaultModel: string; keyRef: string; apiKeySet: boolean;
    instructions: string; defaultInstructions: string;
  };
  providers: WebsearchProvider[];
  provider: string;
  apiKeySet: boolean;
  baseUrl: string;
  maxResults: number;
  ready: boolean;
  whyNot: string;
  keepSentinel: string;
}

export interface WebsearchTest {
  ok: boolean; mode: WebsearchMode; detail: string; query?: string; text?: string; error?: string; ms: number;
}

/** The vision tool (§1-42): who looks at images, and whether it can. */
export type VisionMode = 'native' | 'helper' | 'off';

export interface VisionStatus {
  modes: { id: VisionMode; name: string; note: string }[];
  mode: VisionMode;
  agent: { model: string; host: string };
  nativeProbe: { model?: string; ok?: boolean; at?: string; error?: string };
  nativeProbeStale: boolean;
  helper: {
    baseUrl: string; model: string; defaultModel: string; keyRef: string; apiKeySet: boolean;
    instructions: string; defaultInstructions: string; effectiveHost: string;
  };
  maxWidth: number; detail: string; maxImagesPerCall: number; maxCallsPerTurn: number; timeoutSeconds: number;
  pillow: boolean;
  ready: boolean;
  whyNot: string;
  keepSentinel: string;
}

export interface VisionTest {
  ok: boolean; mode: VisionMode; detail: string; path?: string; text?: string;
  metrics?: Record<string, unknown> | null; refused: boolean; ms: number; error?: string;
}

export interface CharxPreview {
  charKey: string; name: string; assets: number; present: number;
  missing: { name: string; type: string; key: string }[];
  lore: number; regex: number; triggers: number; greetings: number;
}

export interface CharxBuilt {
  ok: boolean; file: string; path: string; size: number; assets: number; dropped: number;
  missing: { name: string; type: string; key: string }[]; assetBytes: number; seconds: number;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  modified: number;
  textual: boolean;
}

/** A batched fs verb's answer: what worked, and who was skipped why. */
export interface BatchFsResult {
  done: number;
  results: Record<string, string>[];
  failed: { path: string; error: string }[];
}

export interface FileArea {
  area: string;
  /** Whether the panel may delete individual files here. */
  deletable: boolean;
  /** Whether 정리 empties it. original/ and uploads/ are never cleaned. */
  cleanable: boolean;
  count: number;
  size: number;
  /** Files held back by the default machinery/dot filter (hidden=1 reveals). */
  hidden?: number;
  files: WorkspaceFile[];
  /** Folders inside the area, empty ones included. */
  dirs?: string[];
}

export interface FileListing {
  charKey: string;
  root: string;
  totalSize: number;
  areas: FileArea[];
  /** The asked-for bot's folder name under projects/ and hina/ (`bot=`). */
  botFolder?: string;
}

export interface AgentPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  /** null = not sent (OpenAI's reasoning models reject any value but the default). */
  temperature: number | null;
  maxTokens: number;
  /** Request-parameter JSON: real field names, null = do not send. */
  params: string;
  reasoning: string;
  cache: boolean;
  flex: boolean;
  /** Extra instructions appended after the built-in rules. */
  instructions: string;
  /** Never the key itself - only whether one is stored and how long it is. */
  apiKey: { set: boolean; length: number };
  /** general = the editing agent; search = the research agent it delegates to. */
  kind: 'general' | 'search';
  /** An API key entry to borrow credentials from; '' = this preset's own. */
  keyRef: string;
  /** '' = OpenAI-compatible endpoint; 'codex' = the OpenAI subscription (login, no key). */
  provider: '' | 'codex';
  /** What the agent calls itself. */
  agentName: string;
  /** One preset per kind carries this. */
  selected?: boolean;
  updatedAt: number;
}

export interface ApiKeyEntry {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  note: string;
  apiKey: { set: boolean; length: number };
  updatedAt: number;
}

/** A known provider's OpenAI-compatible surface and its quirks (backend providers.py). */
export interface ProviderProfile {
  id: string;
  name: string;
  /** Base URL, or '' when it varies (Vertex). */
  api: string;
  hosts: string[];
  auth: string;
  modelExample: string;
  /** Which API the agent uses by default: 'chat' | 'responses'. */
  endpoint: string;
  capField: string;
  strictTools: boolean;
  unsupported: string[];
  template: Record<string, unknown>;
  note: string;
  modelNotes: string[];
  docs: string;
}

export interface CatalogModel {
  provider: string; id: string; name: string; reasoning: boolean; toolCall: boolean;
  context: number | null; output: number | null; costIn: number | null; costOut: number | null; releaseDate: string;
}
export interface CatalogProvider { id: string; name: string; api: string; doc: string; env: string[]; models: number }
/** A shell / pip request the agent is waiting on (GET /permits). */
export interface PermitRequest {
  id: string; sessionId: string; kind: 'shell' | 'pip'; summary: string; detail: string; createdAt: number;
}

/** The ChatGPT plan login (Sign in with ChatGPT; provider id `codex`). */
export interface CodexStatus {
  /** Signed in AND plan usage granted: the agent can run on it. */
  loggedIn: boolean;
  /** This account has a registration (issued client id) to sign in with again. */
  registered: boolean; signedIn: boolean; planEnabled: boolean;
  email: string; expiresAt: number;
  accounts: { clientId: string; email: string; active: boolean; signedIn: boolean }[];
  /** A pre-2026-09 Codex CLI login that no longer works. */
  legacy: boolean;
  /** Show the first-sign-in notice once. */
  welcome: boolean;
  pending: boolean; listening: boolean;
  models: string[]; modelNames: Record<string, string>; modelsError: string;
  base: string; usageUrl: string; redirectUri: string;
}

export interface CatalogResult {
  providers: CatalogProvider[]; models: CatalogModel[]; truncated: boolean;
  totalProviders: number; cachedAt: number; stale: boolean; source: string;
}

/**
 * A skill folder: `data/skills/<id>/SKILL.md` plus its files. The id is the
 * folder name. Only name and description reach the prompt; the body comes
 * when the agent calls load_skill.
 */
export interface Skill {
  id: string;
  name: string;
  /** The trigger: when the agent should load this. */
  description: string;
  /** Body goes into the prompt on every request, not only on load. */
  always: boolean;
  enabled: boolean;
  sortOrder: number;
  /** Empty in listings; filled by state.skill(id). */
  body: string;
  bodyChars: number;
  files: { path: string; size: number; textual: boolean }[];
  updatedAt: number;
}

export interface SkillListing {
  skills: Skill[];
  catalogChars: number;
  catalogLimit: number;
  maxBodyChars: number;
  maxDescriptionChars: number;
  dir: string;
}

export interface LoreEntry {
  id: string;
  scope: 'global' | 'local';
  chatKey: string | null;
  seq: number;
  /** 'original' until it is edited here, then 'edited'; 'added' if we made it. */
  origin: string;
  /** The RisuAI lorebook entry, kept whole - it has fields we do not model. */
  entry: Record<string, unknown>;
  /** The frozen baseline entry, for edited rows only (the diff view). */
  original?: Record<string, unknown> | null;
  /** Set when RisuAI changed this entry too; 반영 waits for a decision. */
  conflict?: { kind: string; theirs?: unknown; base?: unknown } | null;
}

export interface MemoryItem {
  id: string;
  chatKey: string;
  /** hypaV3Data | hypaV2Data | supaMemoryData | lastMemory */
  kind: string;
  seq: number;
  title: string;
  body: string;
  original: string | null;
  changed: boolean;
  isNew: boolean;
  updatedAt: number;
  /** For kind `scriptstate`: how the value goes back (string · number · bool · json · null). */
  valueType?: string | null;
}

export interface PendingAction {
  id: string;
  kind: string;
  summary: string;
  args: Record<string, unknown>;
  /** True when only the plugin can carry it out (RisuAI write, save a copy). */
  byHost: boolean;
  createdAt: number;
  /** The chat the proposal rode on (bot-wide listing, §1-38). */
  chatKey?: string;
  chatName?: string;
}

export interface CardField {
  id: string;
  field: string;
  seq: number;
  body: string;
  original: string | null;
  changed: boolean;
  isNew: boolean;
  /** An original greeting marked for deletion (purged on commit). */
  deleted: boolean;
  /** Set when RisuAI changed this field too; 반영 waits for a decision. */
  conflict?: { kind: string; theirs?: unknown; base?: unknown } | null;
  updatedAt: number;
}

export interface CardScript {
  id: string;
  kind: 'customscript' | 'triggerscript' | 'assetref';
  seq: number;
  origin: string;
  entry: Record<string, unknown>;
  /** The frozen baseline item, for edited rows only (the diff view). */
  original?: Record<string, unknown> | null;
}

interface ScriptCounts { added: number; edited: number; deleted: number; total: number }

export interface CardChanges {
  charKey: string;
  full: boolean;
  fields: number;
  greetings: ScriptCounts;
  customscript: ScriptCounts;
  triggerscript: ScriptCounts;
  assetref: ScriptCounts;
  lore: ScriptCounts;
  total: number;
  actions: number;
  /** Rows where our copy and RisuAI's both moved. 반영 waits for these. */
  conflicts: number;
}

export interface CardPatch {
  charKey: string;
  chaId: string;
  full: boolean;
  fields: { field: string; before: string; after: string }[];
  // `before` on each list is what RisuAI last showed us, in its order: the
  // host compares it with live and refuses rather than overwriting a change
  // made in RisuAI while the panel was open.
  alternateGreetings: { changed: boolean; list: string[]; before: string[] };
  globalLore: { changed: number; list: unknown[]; before: unknown[] };
  customscript: { changed: number; list: unknown[]; before: unknown[] };
  triggerscript: { changed: number; list: unknown[]; before: unknown[] };
  assetref: { changed: number; list: unknown[]; before: unknown[] };
  /** The asset references as RisuAI's three lists, rebuilt from the working rows. */
  assets: { changed: number; emotionImages: unknown[]; additionalAssets: unknown[]; ccAssets: unknown[];
            before?: { emotionImages: unknown[]; additionalAssets: unknown[]; ccAssets: unknown[] } };
  total: number;
}

export interface BulkPreview {
  dryRun: boolean;
  matchedTurns: number;
  totalHits: number;
  applied: number;
  changes: { msgId: string; seq: number; role: string; hits: number; before: string; after: string }[];
}

/** Anlas and the v5 quota — separate currencies, so both are shown (docs/09 §2). */
export interface StudioStatus {
  configured: boolean;
  library: string;
  /** The backend knows the director-reference request shape (docs/09 §7d). */
  charref?: boolean;
  note?: string;
  error?: string;
  migrationNote?: string;
  account?: {
    anlas: number; fixed: number; purchased: number;
    usagePercent: number | null; usageNegative: boolean;
    tier: number | null; active: boolean; expiresAt: number | null;
  };
}

/**
 * Three independent flags per file, not one "representative" radio.
 *
 * The shape comes from `image-selector`, which the user built and uses: `use`
 * is what goes to the bot, `inpaint` is what needs fixing first, `delete` is
 * what to throw away — and a candidate can legitimately be none of them.
 */
/** An AI review suggestion riding beside the flags (§1-42); the user applies or ignores it. */
export interface SelectionSuggest { verdict: 'use' | 'delete' | 'inpaint'; reason: string; by: string; at: string }
export interface SelectionState { use: boolean; inpaint: boolean; delete: boolean; rep?: boolean; suggest?: SelectionSuggest }
export type SelectionMap = Record<string, SelectionState>;

export interface GroupItem {
  filename: string;
  path: string;
  fields?: Record<string, string>;
  selection: SelectionState;
  /** mtime (ms) - the thumbnail cache stamp, so a rewritten file shows anew. */
  modified?: number;
  asset?: AssetIdentity;
  exportName?: string;
}

export type AssetStatus = 'required' | 'optional' | 'excluded';
export interface AssetRule {
  id: string; name: string; template: string; extension: string;
  allowed?: Record<string, string[]>; empty?: Record<string, string>;
  version?: string; regex?: string;
}
export interface AssetSlot { id: string; fields: Record<string, string>; status: AssetStatus }
export interface AssetSet {
  id: string; name: string; ruleId: string; characters: string[]; slots: AssetSlot[];
  overrides: Record<string, Record<string, AssetStatus>>;
}
export interface AssetRules {
  project: string; revision: number; rules: AssetRule[]; sets: AssetSet[]; projects?: string[];
}
export interface AssetBinding { project: string; setId: string; slotId?: string; fields: Record<string, string> }
export interface AssetIdentity extends AssetBinding {
  rule: AssetRule; exportName: string; imageId: string; parentId: string;
}
export interface AssetCoverage {
  complete: boolean;
  slots: { setId: string; slotId: string; status: AssetStatus; present: boolean }[];
  missing: { setId: string; slotId: string }[];
}

export interface StudioGroups {
  folder: string;
  pattern: string;
  groupBy: string;
  fields: string[];
  groups: { key: string; label?: string; items: GroupItem[] }[];
  /** Files the regex could not read. Shown, never dropped. */
  unmatched: GroupItem[];
  total: number;
}

export interface StudioItem {
  path: string; name: string; folder: string;
  description?: string; count?: number;
  /** The card's own switch and place in the concatenation (styles/characters). */
  enabled?: boolean; order?: number;
  /** Reference counts on a character card. */
  vibe?: number; charref?: number;
}

export interface PlannedImage {
  name: string; scene: string; prompt: string; negative: string;
  seed: number | null; charCaptions: unknown[];
  /** Per-scene size from the preset file; it wins over the panel's. */
  size?: { width: number; height: number };
  /** `<collection.key>` references no fragment provides. Reported, not dropped. */
  unresolved?: string[];
  exportName?: string;
}

export interface BatchEstimate {
  images: number; vibeEncodes: number; anlasCertain: number; note: string;
}

export interface StudioJob {
  cancelRequested?: boolean;
  id: string; kind: string; state: string; error?: string | null;
  created_at?: number; updated_at?: number;
  payload: {
    done: number; total: number; saved: string[];
    failed: { name: string; error: string }[];
    /** The full expansion, in run order - what the batch sections list. */
    items?: { name: string; scene?: string; cast?: string; entryIx?: number }[];
    /** The image being drawn right now (running jobs only). */
    current?: string;
    /** A run-time remark (e.g. references skipped on a v5 model). */
    note?: string;
    anlasBefore: number | null; anlasAfter: number | null;
  } | null;
  result: { saved: number; failed: number; anlasSpent: number | null } | null;
}

/**
 * The asset studio's domain calls (NovelAI, batches, the selector).
 *
 * The library's FILES are ordinary space files now - `studio/…` paths through
 * the shared methods on AppState. Only what is not a file lives here.
 */
class StudioFiles {
  // --- NovelAI ---------------------------------------------------------------

  /** Two meters and the library path. Anlas and the v5 quota are separate. */
  async status(): Promise<StudioStatus> {
    return await transport.get<StudioStatus>('/studio/status');
  }

  /** Does this model id exist? Free — the service is the list (docs/09 §5). */
  async modelCheck(model: string): Promise<{ model: string; exists: boolean; supportsVibe: boolean }> {
    return await transport.post('/studio/model-check', { model });
  }

  /** Danbooru-tag autocomplete, proxied from NovelAI's suggest endpoint.
   * Empty when no token is configured - the editor types fine without it. */
  async suggestTags(q: string, model = ''): Promise<{ tags: { tag: string; count: number }[] }> {
    return await transport.get('/studio/tag-suggest', { q, model });
  }

  async items(area: string): Promise<{ area: string; items: StudioItem[] }> {
    return await transport.get('/studio/list', { area });
  }

  /** One card's front matter: the enable toggle, the order, name, description. */
  async setMeta(path: string, set: { enabled?: boolean; order?: number; name?: string; description?: string })
    : Promise<{ path: string; enabled: boolean; order: number }> {
    return await transport.post('/studio/meta', { path, set });
  }

  /** What a batch would produce, before anything is spent. */
  async plan(spec: Record<string, unknown>): Promise<{ items: PlannedImage[]; estimate: BatchEstimate }> {
    return await transport.post('/studio/plan', spec);
  }

  async generate(spec: Record<string, unknown>): Promise<{ jobId: string; total: number; estimate: BatchEstimate }> {
    return await transport.post('/studio/generate', spec);
  }

  async job(id: string): Promise<StudioJob> {
    return await transport.get<StudioJob>('/studio/job', { id });
  }

  /** The last few batches, newest first - the queue view's 최근 작업 list. */
  async jobs(): Promise<{ jobs: StudioJob[] }> {
    return await transport.get('/studio/job');
  }

  async cancelJob(id: string): Promise<void> {
    await transport.post('/studio/job/cancel', { id });
  }

  /** The running job's newest intermediate frame (streaming generation).
   * `{}` when there is none; `{rev}` alone when `since` already has it. */
  /** `w` > 0 asks for a frame scaled to that width as WebP (`img`/`mime`)
   * instead of the full PNG (§1-55). */
  async jobPreview(id: string, since: number, w = 0): Promise<{
    rev?: number; step?: number; total?: number; current?: string; png?: string; img?: string; mime?: string;
  }> {
    return await transport.get('/studio/job/preview', { id, since: String(since), w: w > 0 ? String(w) : undefined });
  }

  /** Split filenames into fields, and say which ones did not match. */
  async parseNames(names: string[], pattern = ''): Promise<{
    matched: Record<string, string>[]; unmatched: string[]; pattern: string; fields: string[];
  }> {
    return await transport.post('/studio/parse', { names, pattern });
  }

  /** One folder's images, gathered into groups to choose between. */
  async group(folder: string, pattern = '', groupBy = 'emotion'): Promise<StudioGroups> {
    return await transport.post<StudioGroups>('/studio/group', { folder, pattern, groupBy });
  }

  async groupProfile(folder: string): Promise<{ exists: boolean; pattern: string; groupBy: string }> {
    return await transport.post('/studio/group', { folder, operation: 'profile' });
  }

  async saveSelection(folder: string, selections: SelectionMap): Promise<void> {
    await transport.post('/studio/selection', { folder, selections });
  }

  async renamePlan(folder: string, rename: { from: string; to: string }[]): Promise<{
    rename: { from: string; to: string }[];
    problems: { from: string; to: string; why: string }[];
  }> {
    return await transport.post('/studio/rename', { folder, rename });
  }

  async exportSelected(folder: string, character: string, pattern = '', groupBy = 'emotion', preview = false): Promise<{
    folder: string; used: number; inpaint: number; empty: number;
    groups: number; unmatched: number;
    managed?: boolean; mapping?: { source: string; target: string }[]; problems?: string[];
  }> {
    return await transport.post('/studio/export', { folder, character, pattern, groupBy, preview });
  }

  async assetRules(project = ''): Promise<AssetRules> {
    return await transport.get('/studio/asset-rules', { project, charKey: state.activeCharKey });
  }
  async saveAssetRules(document: AssetRules): Promise<AssetRules> {
    return await transport.post('/studio/asset-rules', { project: document.project, document });
  }
  async assetMatch(project: string, path: string): Promise<{ matches: AssetIdentity[]; asset?: AssetIdentity }> {
    return await transport.post('/studio/asset-match', { project, path });
  }
  async assetBind(path: string, asset: AssetBinding): Promise<AssetIdentity> {
    return await transport.post('/studio/asset-bind', { path, asset });
  }
  async assetCoverage(project: string, character: string, folder: string): Promise<AssetCoverage> {
    return await transport.post('/studio/asset-coverage', { project, character, folder });
  }

  /** Check library images for adoption (PNG-ness, size). Nothing is copied:
   *  the library and the workspace are one space now. */
  async stage(charKey: string, paths: string[]): Promise<{
    staged: { path: string; size: number }[]; failed: { path: string; error: string }[];
  }> {
    return await transport.post('/studio/stage', { charKey, paths });
  }
}

class AppState {
  health: HealthInfo | null = null;
  connectError = '';

  slot: host.Slot | null = null;
  slotError = '';
  character: RisuCharacter | null = null;
  liveChat: RisuChat | null = null;

  workspace: WorkspaceInfo | null = null;
  /** What the last upload's merge did, until the shell has announced it. */
  lastMerge: WorkspaceInfo['merge'] | null = null;
  /** Which half of the panel is open ('chat' | 'bot'); the shell keeps it current, the agent is told. */
  editMode: 'chat' | 'bot' | 'persona' | 'module' = 'bot';
  /** The active tab id, verbatim from the shell. The studio is a third screen
   * (neither half), and the agent has to be told the truth about it. */
  activeTab = '';
  activeChatKey = '';
  botChanges: CardChanges | null = null;
  /**
   * The background asset importer's progress for the live bot, or null before
   * it has started. The bot bar's 반영 gate and the picker's bot card both
   * read it; `syncAssets` drives it.
   */
  assetSync: SyncProgress | null = null;
  private assetSyncCtl: SyncController | null = null;
  private assetSyncEmitAt = 0;
  /** Why the current emit fired, for listeners that want to do less than a
   *  full render: 'assetSync' = a progress tick of a RUNNING sync (the picker
   *  used to rebuild its whole page - portrait reload included - every 400ms,
   *  which read as flicker). Settled syncs emit with no reason. Set only for
   *  the synchronous span of emit(). */
  emitReason: '' | 'assetSync' = '';
  turns: Turn[] = [];
  totalTurns = 0;
  warnings: string[] = [];
  changes: Changes | null = null;
  /**
   * out/ files the agent made that the files tab has not shown yet. The tab
   * button wears the count as a badge; opening the tab clears it.
   */
  unseenOutputs: string[] = [];
  /** A file the user asked to see (from an agent log line); the files tab opens it. */
  openFileRequest: string | null = null;
  /** A tab an approved agent proposal asked for; the shell moves there. */
  openTabRequest: string | null = null;
  /** Bumped when the workspace listing changed; the files tab reloads when it moved. */
  filesRev = 0;
  /**
   * Bumped whenever the working state changed underneath the tabs - a
   * restore, a reset, a commit, an approved proposal. Tabs that cache what
   * they show (lorebook, memory) compare it to the value they last rendered
   * and reload when it moved, instead of each tab having to know every path
   * that can change its data.
   */
  epoch = 0;
  /** Invalidates asynchronous work belonging to a previously selected bot. */
  contextRevision = 0;
  private hostReadSequence = 0;

  private resetBotContext(): void {
    void this.stopAgent();
    this.contextRevision += 1;
    this.cancelAssetSync();
    this.assetSync = null;
    this.workspace = null;
    this.lastMerge = null;
    this.activeChatKey = '';
    this.sessionId = '';
    this.turns = [];
    this.totalTurns = 0;
    this.warnings = [];
    this.changes = null;
    this.botChanges = null;
    // The modules opened with the old bot are that bot's combination.
    if (this.moduleOwnerKey.startsWith('bot:')) {
      this.openModules = [];
      this.cardTarget = '';
      this.moduleOwnerKey = '';
    }
    this.unseenOutputs = [];
    this.openFileRequest = null;
    this.openTabRequest = null;
    this.openStudioRequest = null;
    this.promptRequest = null;
    this.filesRev += 1;
    this.epoch += 1;
  }

  listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch (e) { console.log('[risu-hina] listener failed', e); }
    }
  }

  get activeChat(): ChatInfo | null {
    return this.workspace?.chats.find((c) => c.chatKey === this.activeChatKey) ?? null;
  }

  /** The workspace is per bot, so file and upload calls address the character. */
  get activeCharKey(): string {
    return this.workspace?.charKey ?? '';
  }

  /**
   * What the bot tabs address. Always the live workspace: the panel's
   * standing premise is "select the bot in RisuAI, then open the plugin" -
   * other bots are not writable anyway (mainline silently drops writes to a
   * non-selected character), so there is no browsing of other workspaces.
   */
  get botKey(): string {
    // A RisuAI module opened next to the bot or persona (§1-95) is edited by
    // the same tabs: while one is the target, they address its working copy.
    return this.cardTarget || this.activeCharKey;
  }

  /** Whether a live, writable bot is behind the bot tabs right now. */
  get isLiveBot(): boolean {
    return !!this.activeCharKey && !!this.character;
  }

  // --- connection ---------------------------------------------------------

  async connect(): Promise<boolean> {
    this.connectError = '';
    try {
      this.health = await transport.connect();
      return true;
    } catch (e) {
      this.health = null;
      this.connectError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.emit();
    }
  }

  // --- host ---------------------------------------------------------------

  /** Read the selected character and its chats from RisuAI. */
  async readHost(): Promise<boolean> {
    const sequence = ++this.hostReadSequence;
    this.slotError = '';
    try {
      const slot = await host.currentSlot();
      const character = await host.readCharacter(slot.characterIndex);
      const liveChat = await host.readChat(slot);
      if (sequence !== this.hostReadSequence) return false;
      const before = this.character?.chaId || this.workspace?.charId;
      const changed = before && character.chaId
        ? before !== character.chaId
        : this.slot !== null && this.slot.characterIndex !== slot.characterIndex;
      if (changed) this.resetBotContext();
      this.slot = slot;
      this.character = character;
      this.liveChat = liveChat;
      return true;
    } catch (e) {
      if (sequence !== this.hostReadSequence) return false;
      this.resetBotContext();
      this.slot = null;
      this.character = null;
      this.liveChat = null;
      this.slotError = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.emit();
    }
  }

  /**
   * Upload the character's chats to the backend.
   *
   * Only the currently open chat is sent by default. A 394-turn chat is several
   * megabytes, and sending every chat of a character on every panel open would
   * make the common case pay for the rare one. `chatIndex` sends one other
   * chat of the same bot instead - what clicking a row in the picker does.
   */
  async upload(opts: { allChats?: boolean; force?: boolean; cardReset?: boolean;
                       chatReset?: boolean; chatIndex?: number } = {}): Promise<WorkspaceInfo> {
    if (!this.slot || !this.character) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const revision = this.contextRevision;
    const chats = Array.isArray(this.character.chats) ? this.character.chats : [];
    const payload: Record<string, unknown> = {
      charId: this.character.chaId ?? '',
      characterIndex: this.slot.characterIndex,
      card: host.cardOf(this.character),
      // The card is the full character now (minus chats); the backend records
      // this and refuses card write-backs built on whitelist-era uploads.
      cardFull: true,
      force: Boolean(opts.force),
      // Scoped re-reads after a write-back: the card half or the chat half,
      // never both, so writing one does not discard edits pending in the other.
      cardReset: Boolean(opts.cardReset),
      chatReset: Boolean(opts.chatReset),
    };
    // `live` marks the chat RisuAI itself has open: the one chat a lazy host
    // never hands over as a stub, and therefore the one empty upload the
    // backend may take at face value (a genuinely new or genuinely emptied
    // chat). Everything else that arrives empty is a stub and gets refused.
    const liveId = String(this.liveChat?.id ?? '');
    const isLive = (c: RisuChat | null | undefined) => !!liveId && String(c?.id ?? '') === liveId;
    if (opts.allChats) {
      payload.chats = chats.map((c, i) => ({ chat: c, chatIndex: i, live: isLive(c) }));
    } else if (opts.chatIndex !== undefined && opts.chatIndex !== this.slot.chatIndex) {
      const chat = await this.chatAt(opts.chatIndex);
      payload.chats = [{ chat, chatIndex: opts.chatIndex, live: isLive(chat) }];
    } else {
      payload.chats = [{ chat: this.liveChat, chatIndex: this.slot.chatIndex, live: true }];
    }
    const res = await transport.upload<{ workspace: WorkspaceInfo }>('/workspace', payload);
    if (revision !== this.contextRevision) throw new Error('봇 선택이 변경되었습니다');
    this.workspace = res.workspace;
    // Read once by the shell, which turns it into the one-line notice.
    this.lastMerge = res.workspace.merge ?? null;
    if (!this.activeChatKey || !this.workspace.chats.some((c) => c.chatKey === this.activeChatKey)) {
      this.activeChatKey = this.workspace.chats[0]?.chatKey ?? '';
    }
    this.emit();
    void this.refreshBotChanges();
    // The text is in; the images follow in the background. Editing starts
    // now, 반영 waits for the store to catch up (bot bar gate).
    void this.syncAssets();
    return res.workspace;
  }

  /**
   * One of the bot's chats, read fresh from RisuAI.
   *
   * `getChatFromIndex` is asked first and the character object we already hold
   * is only the fallback: PocketRisu hands `readCharacter` **stubs** for chats
   * it has not loaded yet (see host.cloneBot), and a stub has no `message`
   * list at all - uploading one would look like a chat that lost every turn.
   * A stub from both sources throws, and the picker says what to do about it.
   */
  private async chatAt(chatIndex: number): Promise<RisuChat> {
    const characterIndex = this.slot!.characterIndex;
    try {
      return await host.readChat({ characterIndex, chatIndex });
    } catch (e) {
      const fallback = (this.character?.chats ?? [])[chatIndex];
      if (fallback && Array.isArray(fallback.message)) return fallback;
      throw e;
    }
  }

  /**
   * Open one of the bot's chats for editing, loading it if it is not in the
   * workspace yet.
   *
   * The panel used to refuse any chat but the one RisuAI had open ("open that
   * chat in RisuAI and press 🔄"), while 이 봇의 모든 챗 불러오기 right below
   * loaded all of them and let you edit exactly those chats - so the refusal
   * was a detour, not a constraint. RisuAI hands us every chat of the selected
   * character, and the write-back addresses the chat by its own id and index
   * (see `chatSlot`), so a chat that is not on screen in RisuAI is as editable
   * as the one that is.
   */
  // --- RisuAI modules (§1-95) -------------------------------------------------
  //
  // A module is edited as a card: the backend keeps its working copy under a
  // key of its own (pyserver/app/modules.py) and every card call addresses it
  // through `botKey` while it is the `cardTarget`. Modules open next to a bot
  // (봇 편집), a persona (페르소나 편집) or on their own (모듈 편집); which ones
  // were opened together is remembered per owner and reopened next time.

  /** RisuAI's modules as last read; null before the first read. */
  liveModules: LiveModule[] | null = null;
  moduleError = '';
  moduleLoading = false;
  /** The modules open in the tab row, in tab order (their backend rows). */
  openModules: ModuleRow[] = [];
  /** The module the card tabs show, '' = the bot. */
  cardTarget = '';
  /** Whose combination `openModules` is: 'bot:<key>' / 'persona:<key>' / 'module'. */
  private moduleOwnerKey = '';
  /** Each open module's asset import (the bot's is `assetSync`). */
  moduleSyncs: Record<string, SyncProgress> = {};
  private moduleSyncCtl: Record<string, SyncController> = {};

  /** The owner the current screen's combination belongs to. */
  get moduleOwner(): string {
    if (this.editMode === 'persona') return this.persona ? 'persona:' + this.persona.key : '';
    if (this.editMode === 'module') return 'module';
    if (this.editMode === 'bot') return this.activeCharKey ? 'bot:' + this.activeCharKey : '';
    return '';
  }

  get targetModule(): ModuleRow | null {
    return this.cardTarget ? this.openModules.find((m) => m.key === this.cardTarget) ?? null : null;
  }

  /** The screen the agent is told: a module on a card tab is edited like the bot's card. */
  get agentMode(): string {
    if (this.activeTab === 'studio') return 'studio';
    if (this.cardTarget && CARD_TABS.has(this.activeTab)) return 'bot';
    return this.editMode === 'module' ? 'bot' : this.editMode;
  }

  /** The asset import behind the card tabs: the target module's, or the bot's. */
  get targetSync(): SyncProgress | null {
    return this.cardTarget ? this.moduleSyncs[this.cardTarget] ?? null : this.assetSync;
  }

  /** Read RisuAI's module list (the + picker, the 모듈 편집 list). */
  async loadModules(): Promise<LiveModule[]> {
    this.moduleLoading = true;
    this.moduleError = '';
    this.emit();
    try {
      const { modules, enabled } = await moduleHost.readModules();
      // Which modules RisuAI turns on for the bot right now (it may have
      // changed there since the panel read the bot).
      let char: RisuCharacter | null = this.character;
      if (this.slot) { try { char = await host.readCharacter(this.slot.characterIndex); } catch { /* the cached read */ } }
      const linked = new Set<string>([
        ...((char?.['modules'] as unknown[] | undefined) ?? []).map(String),
        ...((this.liveChat?.['modules'] as unknown[] | undefined) ?? []).map(String),
      ]);
      const global = new Set(enabled);
      this.liveModules = modules.map((m) => {
        const c = moduleHost.moduleCounts(m);
        const id = String(m['id'] ?? '');
        const ns = String(m['namespace'] ?? '');
        return {
          id, name: String(m['name'] ?? ''), description: String(m['description'] ?? ''), namespace: ns,
          lore: c.lore, regex: c.regex, trigger: c.trigger, assets: c.assets, toggles: c.toggles,
          lowLevelAccess: !!m['lowLevelAccess'], mcp: c.mcp,
          global: global.has(id) || (!!ns && global.has(ns)),
          linked: linked.has(id) || (!!ns && linked.has(ns)),
        };
      });
      return this.liveModules;
    } catch (e) {
      this.moduleError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.moduleLoading = false;
      this.emit();
    }
  }

  /** Hand one RisuAI module to the backend (first read, a merge, or `reset` after 반영). */
  private async syncModule(raw: Record<string, unknown>, reset = false): Promise<ModuleRow & { merge?: Record<string, number> }> {
    const row = await transport.post<ModuleRow & { merge?: Record<string, number> }>('/module/sync', { module: raw, reset }, 120_000);
    this.openModules = this.openModules.map((m) => (m.key === row.key ? row : m));
    this.syncModuleAssets(raw, row.key);
    return row;
  }

  /** A module's images into the store, like the bot's (assets.ts), in the background. */
  private syncModuleAssets(raw: Record<string, unknown>, key: string): Promise<SyncProgress> {
    this.moduleSyncCtl[key]?.cancel();
    const web = transport.hostPlatform === 'web';
    const ctl = syncAssets(moduleHost.assetCarrier(raw) as RisuCharacter, key, { hubPull: web, concurrency: web ? 4 : 6 }, (p) => {
      this.moduleSyncs = { ...this.moduleSyncs, [key]: p };
      if (!syncBusy(p)) { this.epoch += 1; this.emit(); }
    });
    this.moduleSyncCtl[key] = ctl;
    return ctl.done;
  }

  /** Re-run the target's asset import (the assets tab's 다시 동기화). */
  async resyncTargetAssets(): Promise<void> {
    if (!this.cardTarget) { this.syncAssets(true); return; }
    const m = this.targetModule;
    if (!m) return;
    this.syncModuleAssets(await moduleHost.readModule(m.id), m.key);
  }

  /**
   * The combination for the current screen: when the owner changed (another
   * bot, persona or mode), the previous set closes and this owner's last set
   * reopens. Cheap when nothing changed.
   */
  syncModuleOwner(): Promise<void> {
    const owner = this.moduleOwner;
    if (owner === this.moduleOwnerKey) return this.ownerSync;
    this.moduleOwnerKey = owner;
    this.openModules = [];
    this.cardTarget = '';
    this.emit();
    this.ownerSync = this.reopenCombo(owner);
    return this.ownerSync;
  }

  /** In flight while an owner's combination reopens; joined by a second caller. */
  private ownerSync: Promise<void> = Promise.resolve();

  private async reopenCombo(owner: string): Promise<void> {
    if (!owner || !this.health) return;
    let ids: string[] = [];
    try {
      ids = (await transport.get<{ ids: string[] }>('/module/combo', { owner })).ids ?? [];
    } catch { return; }
    if (!ids.length || this.moduleOwnerKey !== owner) return;
    try {
      const { modules } = await moduleHost.readModules();
      const rows: ModuleRow[] = [];
      for (const id of ids) {
        const raw = modules.find((m) => String(m['id'] ?? '') === id);
        if (!raw || raw['mcp']) continue;
        const row = await transport.post<ModuleRow>('/module/sync', { module: raw }, 120_000);
        rows.push(row);
        this.syncModuleAssets(raw, row.key);
      }
      if (this.moduleOwnerKey !== owner) return;
      this.openModules = rows;
      // A module deleted in RisuAI drops out of the combination.
      if (rows.length !== ids.length) void this.saveModuleCombo();
      this.emit();
    } catch (e) {
      void clientLog('warn', 'module combo reopen', { error: String(e).slice(0, 200) });
    }
  }

  private async saveModuleCombo(): Promise<void> {
    const owner = this.moduleOwnerKey || this.moduleOwner;
    if (!owner) return;
    try {
      await transport.post('/module/combo', { owner, ids: this.openModules.map((m) => m.id) });
    } catch { /* remembered next time */ }
  }

  /**
   * The + picker's answer: exactly these modules open, in this order. New ones
   * are read from RisuAI and synced; the combination is remembered.
   */
  async setOpenModules(ids: string[]): Promise<ModuleRow[]> {
    if (!this.moduleOwnerKey) this.moduleOwnerKey = this.moduleOwner;
    const { modules } = await moduleHost.readModules();
    const rows: ModuleRow[] = [];
    for (const id of ids) {
      const raw = modules.find((m) => String(m['id'] ?? '') === id);
      if (!raw) continue;
      if (raw['mcp']) throw new Error(`'${String(raw['name'] ?? '')}' 은(는) MCP 모듈이라 편집할 내용이 없습니다`);
      const row = await transport.post<ModuleRow>('/module/sync', { module: raw }, 120_000);
      rows.push(row);
      this.syncModuleAssets(raw, row.key);
    }
    this.openModules = rows;
    if (this.cardTarget && !rows.some((m) => m.key === this.cardTarget)) this.cardTarget = '';
    this.epoch += 1;
    await this.saveModuleCombo();
    this.emit();
    void this.refreshBotChanges();
    return rows;
  }

  /** Open one more module (or focus it when it is open already). */
  async openModule(id: string, focus = true): Promise<ModuleRow> {
    const ids = this.openModules.map((m) => m.id);
    if (!ids.includes(id)) await this.setOpenModules([...ids, id]);
    const row = this.openModules.find((m) => m.id === id);
    if (!row) throw new Error('RisuAI에서 이 모듈을 찾지 못했습니다');
    if (focus) this.focusModule(row.key);
    return row;
  }

  async closeModule(key: string): Promise<void> {
    this.openModules = this.openModules.filter((m) => m.key !== key);
    if (this.cardTarget === key) this.cardTarget = '';
    this.moduleSyncCtl[key]?.cancel();
    delete this.moduleSyncCtl[key];
    this.epoch += 1;
    await this.saveModuleCombo();
    this.emit();
    void this.refreshBotChanges();
  }

  /** Point the card tabs at a module, or back at the bot (''). */
  focusModule(key: string): void {
    if (this.cardTarget === key) return;
    this.cardTarget = key;
    this.botChanges = null;
    this.epoch += 1;
    this.emit();
    void this.refreshBotChanges();
  }

  /** The open modules' rows again (counts after an edit or an approval). */
  async refreshModuleRows(): Promise<void> {
    if (!this.openModules.length) return;
    try {
      const r = await transport.get<{ modules: ModuleRow[] }>('/modules');
      const by = new Map(r.modules.map((m) => [m.key, m]));
      this.openModules = this.openModules.map((m) => by.get(m.key) ?? m);
      this.emit();
    } catch { /* next time */ }
  }

  async moduleDirty(): Promise<{ key: string; name: string; total: number; conflicts: number }[]> {
    try {
      return (await transport.get<{ modules: { key: string; name: string; total: number; conflicts: number }[] }>('/module/dirty')).modules ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 반영 for a module: the card patch of its working copy, written into
   * db.modules (modules.ts writeModule), read back, then the working copy
   * reloads from RisuAI.
   */
  async moduleWriteBack(key: string, progress: (text: string) => void = () => {}): Promise<{ applied: number; mode: string; verified: boolean; drift?: string; parts?: string[] }> {
    return foregroundWrite(async (report) => {
      const say = (t: string) => { report(t); progress(t); };
      let row = this.openModules.find((m) => m.key === key);
      if (!row) row = (await transport.get<{ modules: ModuleRow[] }>('/modules')).modules.find((m) => m.key === key);
      if (!row) throw new Error('모듈 작업본을 찾지 못했습니다');
      say(`모듈 '${row.name}' 을(를) RisuAI에 반영하는 중…`);
      const patch = await this.cardPatch(key);
      const update = this.cardUpdateFrom(patch, false);
      if (!update) return { applied: 0, mode: 'noop', verified: true };
      await this.resolveStagedAssets(update, say, key);
      const r = await moduleHost.writeModule(row.id, update);
      if (!r.verified) {
        return { applied: r.applied, mode: r.mode, verified: false, parts: r.parts, ...(r.drift ? { drift: r.drift } : {}) };
      }
      say('RisuAI 반영 확인 완료 · 모듈 작업본을 동기화하는 중…');
      await this.cardCommit('반영 직전', key);
      await this.syncModule(await moduleHost.readModule(row.id), true);
      this.bump();
      void this.refreshBotChanges();
      return { applied: r.applied, mode: r.mode, verified: true, parts: r.parts };
    });
  }

  /** Read RisuAI's copy of the target module again (a change made over there). */
  async rereadModule(key = this.cardTarget): Promise<Record<string, number> | undefined> {
    const row = this.openModules.find((m) => m.key === key);
    if (!row) return undefined;
    const r = await this.syncModule(await moduleHost.readModule(row.id));
    this.bump();
    void this.refreshBotChanges();
    return r.merge;
  }

  /**
   * A .risum / .charx / .json in the space becomes a new RisuAI module: the
   * backend reads it (its images go to the store under pending keys), the
   * images are registered with RisuAI, and the module is appended and opened.
   */
  async importModuleFile(path: string, progress: (text: string) => void = () => {}): Promise<ModuleRow> {
    const parsed = await transport.post<{ module: Record<string, unknown>; summary: { name: string } }>('/module/parse', { path }, 180_000);
    const module = parsed.module;
    const pending = new Set<string>();
    for (const a of (module['assets'] as unknown[] | undefined) ?? []) {
      if (Array.isArray(a) && typeof a[1] === 'string' && a[1].startsWith('assets/hina-pending-')) pending.add(a[1]);
    }
    const icon = String(module['icon'] ?? '');
    if (icon.startsWith('assets/hina-pending-')) pending.add(icon);
    const resolved = new Map<string, string>();
    let done = 0;
    await boundedAssets([...pending], async (key) => {
      const bytes = await transport.getBinary('/assets/blob', { key });
      const real = await Risuai.saveAsset(bytes);
      if (!real || typeof real !== 'string') throw new Error('RisuAI가 에셋 저장 키를 반환하지 않았습니다');
      resolved.set(key, real);
      progress(`에셋 등록 ${++done}/${pending.size}`);
    });
    module['assets'] = ((module['assets'] as unknown[] | undefined) ?? []).map((a) => (
      Array.isArray(a) ? [a[0], resolved.get(String(a[1])) ?? a[1], ...a.slice(2)] : a));
    if (icon) module['icon'] = resolved.get(icon) ?? icon;
    progress('RisuAI 모듈 목록에 추가하는 중…');
    const made = await moduleHost.createModule(module);
    await this.loadModules().catch(() => undefined);
    return await this.openModule(String(made['id']), true);
  }

  /** The target module as a file in its project out/ folder. */
  async exportModule(format: 'charx' | 'risum', allowMissing = false, name = '', key = this.cardTarget): Promise<{ file: string; path: string; size: number; assets: number; dropped: number }> {
    // Its images have to be in the store first: wait for a running import.
    const ctl = this.moduleSyncCtl[key];
    if (ctl) await ctl.done;
    const r = await transport.post<{ file: string; path: string; size: number; assets: number; dropped: number }>(
      '/module/export', { charKey: key, format, allowMissing, name }, 300_000);
    this.touchFiles([r.path]);
    return r;
  }

  /**
   * Save any RisuAI module as a file in its project folder (§1-96) - one that is
   * open (its working copy, unapplied edits included) or one only linked to
   * the bot (read from RisuAI, given a working copy, its images imported first).
   */
  async exportModuleById(id: string, format: 'charx' | 'risum', allowMissing = false): Promise<{ file: string; path: string; size: number; assets: number; dropped: number }> {
    let key = this.openModules.find((m) => m.id === id)?.key ?? '';
    if (!key) {
      const raw = await moduleHost.readModule(id);
      if (raw['mcp']) throw new Error('MCP 모듈은 파일로 저장할 내용이 없습니다');
      const row = await transport.post<ModuleRow>('/module/sync', { module: raw }, 120_000);
      key = row.key;
      await this.syncModuleAssets(raw, key);
    }
    return await this.exportModule(format, allowMissing, '', key);
  }

  /** The modules that go with the current screen: the open ones, and in 봇 편집 also those RisuAI links to the bot. */
  async ownerModules(): Promise<{ id: string; name: string; open: boolean; linked: boolean }[]> {
    const out = this.openModules.map((m) => ({ id: m.id, name: m.name, open: true, linked: false }));
    if (this.editMode === 'bot' || this.editMode === 'module') {
      const live = this.liveModules ?? await this.loadModules().catch(() => [] as LiveModule[]);
      for (const m of live) {
        if (m.mcp) continue;
        const hit = out.find((x) => x.id === m.id);
        if (hit) hit.linked = m.linked;
        else if (this.editMode === 'bot' && m.linked) out.push({ id: m.id, name: m.name, open: false, linked: true });
      }
    }
    return out;
  }


  // --- personas (§1-89) ----------------------------------------------------
  //
  // Same shape as the card: RisuAI holds the persona, the backend holds a
  // working copy (base = what RisuAI had at the last read, work = the edits),
  // snapshots of it, and AI proposals land in it on approval. 반영 is the one
  // write to RisuAI, carried out here because only the plugin can reach it.

  /** Every persona the backend knows, as of the last read of RisuAI; null before it. */
  personas: PersonaRow[] | null = null;
  personaError = '';
  personaLoading = false;
  /** The persona open in the persona tab (its backend row). */
  persona: PersonaRow | null = null;

  /** projects/페르소나/<name>: the open persona's project folder. */
  get personaFolder(): string {
    return this.persona?.folder ?? '';
  }

  /**
   * Read RisuAI's personas and hand them to the backend, which keeps their
   * working copies; the pictures it has not cached yet follow in the
   * background (the AI looks at them as files).
   */
  async loadPersonas(): Promise<PersonaRow[]> {
    this.personaLoading = true;
    this.personaError = '';
    this.emit();
    try {
      const r = await personaHost.readPersonas();
      const res = await transport.post<{ personas: (PersonaRow & { needIcon?: boolean })[] }>('/persona/sync', {
        personas: r.personas.map((p) => ({ id: p.id, index: p.index, name: p.name, prompt: p.prompt, icon: p.icon, selected: p.selected })),
      });
      this.personas = res.personas;
      if (this.persona) this.persona = res.personas.find((p) => p.key === this.persona!.key) ?? this.persona;
      void this.cachePersonaIcons(res.personas.filter((p) => p.needIcon), r.personas);
      return res.personas;
    } catch (e) {
      this.personaError = e instanceof Error ? e.message : String(e);
      throw e;
    } finally {
      this.personaLoading = false;
      this.emit();
    }
  }

  private async cachePersonaIcons(rows: PersonaRow[], live: Persona[]): Promise<void> {
    for (const row of rows) {
      const p = live.find((x) => (row.id ? x.id === row.id : x.index === row.index));
      if (!p?.icon) continue;
      const bytes = await personaHost.personaImage(p.icon);
      if (!bytes) continue;
      try {
        const saved = await transport.post<PersonaRow>('/persona/icon', { key: row.key, iconKey: p.icon, base64: toBase64(bytes) });
        this.patchPersona(saved);
      } catch (e) {
        void clientLog('warn', 'persona icon cache', { error: String(e).slice(0, 200) });
      }
    }
  }

  /** One row changed: the list and the open persona follow, one emit. */
  private patchPersona(row: PersonaRow): PersonaRow {
    if (this.personas) this.personas = this.personas.map((x) => (x.key === row.key ? { ...x, ...row } : x));
    if (this.persona?.key === row.key) this.persona = { ...this.persona, ...row };
    this.emit();
    return row;
  }

  /** Open one persona for editing (its project folder exists from the sync). */
  async openPersona(key: string): Promise<PersonaRow> {
    const row = await transport.get<PersonaRow>('/persona', { key });
    this.persona = row;
    this.touchFiles();
    // Another persona: its own module combination (§1-95).
    if (this.editMode === 'persona') void this.syncModuleOwner();
    return row;
  }

  /** The backend's rows again, without reading RisuAI (an approved AI edit). */
  async refreshPersonaList(): Promise<void> {
    if (this.personas === null && !this.persona) return;
    try {
      const r = await transport.get<{ personas: PersonaRow[] }>('/personas');
      this.personas = r.personas;
      if (this.persona) this.persona = r.personas.find((p) => p.key === this.persona!.key) ?? this.persona;
      this.emit();
    } catch { /* next time */ }
  }

  async refreshPersona(): Promise<void> {
    if (!this.persona) return;
    try { this.patchPersona(await transport.get<PersonaRow>('/persona', { key: this.persona.key })); } catch { /* next time */ }
  }

  /** Edit the working copy: only the given fields; image '' drops a pending new picture. */
  async editPersona(fields: { name?: string; prompt?: string; image?: string }, key = this.persona?.key ?? ''): Promise<PersonaRow> {
    return this.patchPersona(await transport.post<PersonaRow>('/persona/edit', { key, ...fields }));
  }

  async personaReset(key = this.persona?.key ?? ''): Promise<number> {
    const r = await transport.post<PersonaRow & { discarded?: number; deleted?: boolean }>('/persona/reset', { key });
    if (r.deleted) {
      // A new persona discarded is a persona gone: nothing in RisuAI to go back to.
      if (this.personas) this.personas = this.personas.filter((x) => x.key !== key);
      if (this.persona?.key === key) this.persona = null;
      this.emit();
      return 1;
    }
    this.patchPersona(r);
    return r.discarded ?? 0;
  }

  /** A NEW persona in the working copy; RisuAI gets it on 반영. */
  async createPersona(name: string, prompt = ''): Promise<PersonaRow> {
    const row = await transport.post<PersonaRow>('/persona/create', { name, prompt });
    this.personas = [...(this.personas ?? []), row];
    this.persona = row;
    this.touchFiles();
    return row;
  }

  async personaCheckpoints(key = this.persona?.key ?? ''): Promise<{ id: string; label: string; created_at: number; kind?: string }[]> {
    const r = await transport.get<{ checkpoints: any[] }>('/persona/checkpoints', { key });
    return r.checkpoints ?? [];
  }

  async personaCheckpoint(label: string, key = this.persona?.key ?? ''): Promise<void> {
    await transport.post('/persona/checkpoint', { key, label });
    await this.refreshPersona();
  }

  async personaRestore(id: string, key = this.persona?.key ?? ''): Promise<void> {
    const r = await transport.post<PersonaRow>('/persona/checkpoint/restore', { key, id });
    if (r && (r as PersonaRow).key) this.patchPersona(r);
    else await this.refreshPersona();
  }

  async deletePersonaCheckpoint(id: string, key = this.persona?.key ?? ''): Promise<void> {
    await transport.post('/persona/checkpoint/delete', { key, id });
  }

  async renamePersonaCheckpoint(id: string, label: string, key = this.persona?.key ?? ''): Promise<void> {
    await transport.post('/persona/checkpoint/rename', { key, id, label });
  }

  /** Personas holding unapplied work - the title-row 반영 lists them too. */
  async personaDirty(): Promise<{ key: string; name: string; total: number }[]> {
    try {
      const r = await transport.get<{ personas: { key: string; name: string; total: number }[] }>('/persona/dirty');
      return r.personas ?? [];
    } catch {
      return [];
    }
  }

  /**
   * 반영 for one persona: write its working copy into RisuAI, read it back,
   * and move the backend baseline. Refused when RisuAI's copy moved since the
   * last read. While RisuAI has it selected it cannot be written in place
   * (persona.ts), so the working copy is saved as a new persona instead
   * (`copied`), and the original's working copy goes back to RisuAI's.
   */
  async personaWriteBack(key = this.persona?.key ?? ''): Promise<{ written: boolean; name: string; copied?: boolean }> {
    // The same lock as the card and chat 반영: one write to RisuAI at a time.
    return foregroundWrite(async (report) => {
      report('페르소나를 RisuAI에 반영하는 중…');
      return this.performPersonaWriteBack(key);
    });
  }

  private async performPersonaWriteBack(key: string): Promise<{ written: boolean; name: string; copied?: boolean }> {
    const row = await transport.get<PersonaRow>('/persona', { key });
    if (!row.dirty) return { written: false, name: row.work.name };
    if (row.isNew) {
      // A persona made here: RisuAI's list grows by one.
      const bytes = row.work.image ? await this.fileBytes(row.work.image) : null;
      const made = await personaHost.createPersona({ name: row.work.name, prompt: row.work.prompt }, bytes);
      const after = await transport.post<PersonaRow>('/persona/commit', {
        key, id: made.id, index: made.index, name: made.name, prompt: made.prompt, iconKey: made.icon,
      });
      if (this.persona?.key === key) this.persona = after;
      if (this.personas) this.personas = this.personas.map((x) => (x.key === key ? after : x));
      this.patchPersona(after);
      this.touchFiles();
      void this.loadPersonas().catch(() => undefined);
      return { written: true, name: made.name };
    }
    const live = (await personaHost.readPersonas()).personas;
    const p = live.find((x) => (row.id ? x.id === row.id : x.index === row.index && x.name === row.base.name));
    if (!p) throw new Error('RisuAI에서 이 페르소나를 찾지 못했습니다 (지워졌을 수 있습니다). 첫 화면에서 다시 읽어 주세요');
    if (p.selected) return this.personaSaveAsCopy(key, row, p);
    if (p.name !== row.base.name || p.prompt !== row.base.prompt || p.icon !== row.iconKey) {
      throw new Error('RisuAI 쪽에서 이 페르소나가 바뀌었습니다. 첫 화면에서 페르소나를 다시 읽어 주세요 (편집 내용은 작업본에 남아 있습니다)');
    }
    const bytes = row.work.image ? await this.fileBytes(row.work.image) : null;
    const saved = await personaHost.writePersona(p, { name: row.work.name, prompt: row.work.prompt }, bytes);
    const after = await transport.post<PersonaRow>('/persona/commit', {
      key, name: saved.name, prompt: saved.prompt, iconKey: saved.icon,
    });
    // A persona without an id is keyed by its name, so a rename moves its key.
    if (after.key !== key) {
      if (this.persona?.key === key) this.persona = after;
      if (this.personas) this.personas = this.personas.map((x) => (x.key === key ? after : x));
    }
    this.patchPersona(after);
    this.touchFiles();
    // The renamed folder and the new picture: one more read refreshes both.
    void this.loadPersonas().catch(() => undefined);
    return { written: true, name: saved.name };
  }

  /**
   * 반영 of the persona RisuAI has selected: its working copy becomes a new
   * persona (the original's picture, note and portrait setting come along),
   * the original's working copy goes back to RisuAI's (an automatic snapshot
   * keeps the edit there too), and the copy is what the persona tab shows next.
   */
  private async personaSaveAsCopy(key: string, row: PersonaRow, p: Persona): Promise<{ written: boolean; name: string; copied: boolean }> {
    const name = personaHost.copyName(row.base.name, row.work.name);
    const bytes = row.work.image ? await this.fileBytes(row.work.image) : null;
    const made = await personaHost.createPersona({ name, prompt: row.work.prompt }, bytes, p);
    try {
      await transport.post('/persona/reset', { key });
    } catch (e) {
      void clientLog('warn', 'persona copy: original not reset', { error: String(e).slice(0, 200) });
    }
    try {
      await this.loadPersonas();
      const copy = this.personas?.find((x) => x.id === made.id);
      if (copy && this.persona?.key === key) await this.openPersona(copy.key);
    } catch { /* the copy is in RisuAI; the list catches up on the next read */ }
    this.touchFiles();
    return { written: true, name: made.name, copied: true };
  }

  /** The bot's project folder under projects/, and the name it could take (§1-89). */
  async botFolderInfo(): Promise<{ folder: string; key: string; hashLike: boolean; name: string; suggested: string } | null> {
    if (!this.activeCharKey) return null;
    return await transport.get('/workspace/folder', { charKey: this.activeCharKey });
  }

  /** Rename the project folder with everything keyed by it (notes, rules, studio output). */
  async renameBotFolder(folder: string): Promise<{ old: string; folder: string }> {
    // Moving a big studio output folder can take a while; a lost answer is
    // checked against the folder itself rather than reported as a failure
    // (the first real rename finished server-side after the panel gave up).
    const ck = this.activeCharKey;
    try {
      const r = await transport.post<{ old: string; folder: string }>('/workspace/folder/rename', { charKey: ck, folder }, 180_000);
      this.touchFiles();
      return r;
    } catch (e) {
      if (e instanceof BackendError && e.status >= 400 && e.status < 500) throw e;
      const info = await transport.get<{ folder: string }>('/workspace/folder', { charKey: ck }).catch(() => null);
      this.touchFiles();
      if (info && info.folder !== '' && info.folder === folder.trim()) return { old: '', folder: info.folder };
      throw e;
    }
  }

  async openChat(chatIndex: number): Promise<void> {
    const ws = await this.upload({ chatIndex });
    // A single-chat upload answers with just that chat, so it is the one to
    // select - `upload` only re-picks when the previous key went missing.
    const info = ws.chats[0];
    if (info?.skipped) {
      // The backend refused a stub read (RisuAI has not loaded this chat) and
      // changed nothing. Opening the editor on it would show 0턴 over a chat
      // that is not empty - surface the refusal instead.
      throw new Error(info.skipped);
    }
    const key = info?.chatKey ?? '';
    if (key) this.activeChatKey = key;
    await this.loadTurns();
  }

  /**
   * Which chat of the live bot a write-back addresses.
   *
   * Not necessarily the one RisuAI has open: the picker loads any chat of the
   * bot. The index recorded at upload time is only a hint - chats get
   * reordered, deleted and copied in RisuAI while the panel is open - so the
   * chat **id** is what is trusted and the index is re-derived from a fresh
   * read. `writeChat` then re-reads at that index and refuses the write if the
   * id moved again between here and there.
   */
  private async chatSlot(): Promise<host.Slot> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const wanted = this.activeChat?.chatId ?? '';
    if (!wanted || wanted === (this.liveChat?.id ?? '')) return this.slot;
    const characterIndex = this.slot.characterIndex;
    const char = await host.readCharacter(characterIndex);
    const chats = Array.isArray(char.chats) ? char.chats : [];
    const chatIndex = chats.findIndex((c) => String(c?.id ?? '') === wanted);
    if (chatIndex < 0) {
      throw new host.HostError('missing',
        'RisuAI에서 이 챗을 찾지 못했습니다 (지워졌을 수 있습니다). 🔄 로 다시 읽어 주세요');
    }
    return { characterIndex, chatIndex };
  }

  // --- assets (background importer) ----------------------------------------

  /**
   * Start (or restart) the asset sync for the live bot. A run already going
   * for the same bot is left alone unless `force`; a run for another bot is
   * cancelled first. Progress lands in `assetSync` and is emitted at most a
   * few times a second - the picker re-renders on every emit.
   */
  syncAssets(force = false): void {
    const ck = this.activeCharKey;
    const char = this.character;
    if (!ck || !char) return;
    if (this.assetSync && this.assetSync.charKey === ck && syncBusy(this.assetSync) && !force) return;
    this.cancelAssetSync();
    const web = transport.hostPlatform === 'web';
    const revision = this.contextRevision;
    this.assetSyncCtl = syncAssets(char, ck, {
      hubPull: web,
      concurrency: web ? 4 : 6,
    }, (p) => {
      if (revision !== this.contextRevision || ck !== this.activeCharKey) return;
      this.assetSync = p;
      const now = Date.now();
      const settled = !syncBusy(p);
      if (settled || now - this.assetSyncEmitAt > 400) {
        this.assetSyncEmitAt = now;
        this.emitReason = settled ? '' : 'assetSync';
        try { this.emit(); } finally { this.emitReason = ''; }
      }
    });
    this.assetSync = null;
    void this.assetSyncCtl.done.then((p) => {
      if (p.phase === 'error') void clientLog('warn', 'asset sync failed', { error: p.error, charKey: ck });
    });
  }

  cancelAssetSync(): void {
    if (this.assetSyncCtl) {
      this.assetSyncCtl.cancel();
      this.assetSyncCtl = null;
    }
  }

  /** Why 반영 has to wait for the assets, or null when it need not. */
  get assetGateReason(): string | null {
    const p = this.assetSync;
    if (!p || p.charKey !== this.activeCharKey) return null;
    if (syncBusy(p)) return describeSync(p) + ' — 끝나면 반영할 수 있습니다';
    if (p.phase === 'error') return describeSync(p) + ' — 봇 카드에서 다시 동기화해 주세요';
    if (p.phase === 'cancelled') return '에셋 임포트가 중단되었습니다 — 봇 카드에서 다시 동기화해 주세요';
    return null;
  }

  // --- turns --------------------------------------------------------------

  async loadTurns(chatKey = this.activeChatKey, start = 0, limit = 2000): Promise<void> {
    if (!chatKey) return;
    const revision = this.contextRevision;
    const res = await transport.get<{ total: number; turns: Turn[] }>(
      '/turns', { chatKey, start, limit },
    );
    if (revision !== this.contextRevision) return;
    this.activeChatKey = chatKey;
    this.turns = res.turns;
    this.totalTurns = res.total;
    this.emit();
    void this.refreshChanges();
  }

  /**
   * Refresh the pending-change summary for the active chat.
   *
   * Cheap on the server (counts only) and called after anything that can
   * change it, so the shared bar never shows a count that is one save behind.
   * A failure here is not worth surfacing - the next call fixes it.
   */
  async refreshChanges(): Promise<Changes | null> {
    if (!this.activeChatKey) { this.changes = null; this.emit(); return null; }
    const revision = this.contextRevision;
    const key = this.activeChatKey;
    try {
      const result = await transport.get<Changes>('/changes', { chatKey: key });
      if (revision !== this.contextRevision || key !== this.activeChatKey) return null;
      this.changes = result;
    } catch {
      if (revision !== this.contextRevision || key !== this.activeChatKey) return null;
      this.changes = null;
    }
    this.emit();
    return this.changes;
  }

  /** The working state changed underneath the tabs; tell them to reload. */
  bump(): void {
    this.epoch += 1;
    this.emit();
  }

  /** The workspace listing changed (a file was made, uploaded or deleted). */
  touchFiles(newOutputs: string[] = []): void {
    for (const p of newOutputs) if (!this.unseenOutputs.includes(p)) this.unseenOutputs.push(p);
    this.filesRev += 1;
    this.emit();
  }

  /** The same rev bump without telling every listener (§1-78): a studio card
   * save only needs the files tab to re-read when it is next shown, and the
   * emit made each keystroke-save re-run the whole panel's listeners (the
   * title-row counters alone sent three requests). */
  touchFilesQuiet(): void {
    this.filesRev += 1;
  }

  /** A screen asked the agent something on the user's behalf (검수's AI 재검수,
   * §1-46): the agent panel sends it as if typed. */
  promptRequest: string | null = null;
  requestPrompt(text: string): void {
    this.promptRequest = text;
    this.emit();
  }

  requestOpenFile(path: string): void {
    this.openFileRequest = path;
    this.emit();
  }

  /** The agent (or a strip in the chat) asked for the studio's 검수 tab on
   * a folder: the shell switches tabs, the studio consumes the folder. */
  openStudioRequest: { folder: string; view?: 'all' | 'group'; focus?: string[] } | null = null;
  /** `focus`: the images just made (the chat's 검수 strip, §1-62) - the
   * selector unfolds their group and rings them. */
  requestOpenStudio(folder: string, view?: 'all' | 'group', focus?: string[]): void {
    this.openStudioRequest = { folder, view, focus };
    this.emit();
  }

  /** Everything unseen has been seen (a reset; the files tab no longer
   * calls this on open - a folder is seen when it is LOOKED AT, §1-36). */
  markOutputsSeen(): void {
    if (!this.unseenOutputs.length) return;
    this.unseenOutputs = [];
    this.emit();
  }

  /** The files directly in `dir` have been looked at: their dots go, the
   * tab badge shrinks by that many. Files deeper down stay unseen. */
  markOutputsSeenIn(dir: string): void {
    const before = this.unseenOutputs.length;
    this.unseenOutputs = this.unseenOutputs.filter((p) => {
      const cut = p.lastIndexOf('/');
      return (cut < 0 ? '' : p.slice(0, cut)) !== dir;
    });
    if (this.unseenOutputs.length !== before) this.emit();
  }

  /** Whether an unseen file sits in `dir` or anywhere below it. */
  hasUnseenUnder(dir: string): boolean {
    return this.unseenOutputs.some((p) => p.startsWith(dir + '/'));
  }

  /**
   * Edit one turn and patch it locally instead of reloading everything.
   *
   * A 394-turn chat's /turns response was measured at 3.4MB. Refetching it
   * after every single-turn save made each keystroke-to-saved round trip cost
   * megabytes, which is most of why the editor felt sluggish. The server
   * already told us the write succeeded and we know both sides of the text, so
   * the one row that changed is updated in place.
   */
  async editTurn(msgId: string, before: string, after: string): Promise<void> {
    await transport.post('/turn', { chatKey: this.activeChatKey, msgId, before, after });
    const t = this.turns.find((x) => x.msgId === msgId);
    if (t) {
      // `original` is only sent for turns that already differed, so the first
      // edit of a turn has to seed it from what we were showing.
      if (t.original === null || t.original === undefined) t.original = before;
      t.body = after;
      t.changed = !t.isNew && t.original !== after;
      this.emit();
      void this.refreshChanges();
    } else {
      await this.loadTurns();
    }
  }

  async bulk(params: Record<string, unknown>): Promise<BulkPreview> {
    return await transport.post<BulkPreview>('/turn/bulk', { chatKey: this.activeChatKey, ...params });
  }

  async deleteRange(fromSeq: number, toSeq: number): Promise<void> {
    await transport.post('/turn/delete', { chatKey: this.activeChatKey, fromSeq, toSeq });
    await this.loadTurns();
  }

  async patch(): Promise<Patch> {
    return await transport.get<Patch>('/patch', { chatKey: this.activeChatKey });
  }

  /**
   * Make the current state the new baseline, after RisuAI confirmed the write.
   *
   * Called only on success, so a failed write-back leaves the diff intact and
   * the retry meaningful.
   */
  /**
   * The chat landed in RisuAI: snapshot it, then re-read what RisuAI now
   * holds. See `rereadCard` for why the working copy is not kept.
   */
  async commit(label: string): Promise<{ shipped: number }> {
    return foregroundWrite(report => {
      report('RisuAI 반영 확인 완료 · 대화 작업본을 동기화하는 중…');
      return this.performCommit(label);
    });
  }

  private async performCommit(label: string): Promise<{ shipped: number }> {
    const r = await transport.post<{ shipped: number }>(
      '/commit', { chatKey: this.activeChatKey, label });
    await this.rereadChat();
    this.bump();
    return r;
  }

  /** Discard the chat's working copy - turns, local lorebook and memory as
   * one unit. Returns what went, for the confirmation line. */
  async reset(): Promise<{ turns: number; lore: number; memory: number; total: number }> {
    const r = await transport.post<{ discarded?: { turns: number; lore: number; memory: number; total: number } }>(
      '/reset', { chatKey: this.activeChatKey });
    await this.loadTurns();
    this.bump();
    void this.refreshChanges();
    return r.discarded ?? { turns: 0, lore: 0, memory: 0, total: 0 };
  }

  /** `auto` marks the plugin's own protective snapshots (before a bulk
   * replace or a range delete): internal backups, not the version list. */
  async checkpoint(label: string, auto = false): Promise<void> {
    await transport.post('/checkpoint', { chatKey: this.activeChatKey, label, ...(auto ? { auto } : {}) });
  }

  /** Pending state across the whole bot - the leave guard's one call. */
  async dirtySummary(): Promise<DirtySummary | null> {
    const personas = this.health ? this.personaDirty() : Promise.resolve([]);
    const modules = this.health ? this.moduleDirty() : Promise.resolve([]);
    if (!this.activeCharKey) {
      const [ps, ms] = await Promise.all([personas, modules]);
      return ps.length || ms.length
        ? { charKey: '', card: { dirty: false, total: 0, conflicts: 0 }, chats: [], personas: ps, modules: ms } : null;
    }
    try {
      const [s, ps, ms] = await Promise.all([
        transport.get<DirtySummary>('/workspace/dirty', { charKey: this.activeCharKey }), personas, modules]);
      return { ...s, personas: ps, modules: ms };
    } catch {
      // The guard treats "cannot check" as "nothing to resolve": a dead
      // backend must never lock the user inside the panel.
      return null;
    }
  }

  async checkpoints(): Promise<{ id: string; label: string; message_count: number; created_at: number; kind?: string }[]> {
    const res = await transport.get<{ checkpoints: any[] }>('/checkpoints', { chatKey: this.activeChatKey });
    return res.checkpoints ?? [];
  }

  async renameCheckpoint(id: string, label: string): Promise<void> {
    await transport.post('/checkpoint/rename', { chatKey: this.activeChatKey, id, label });
  }

  async deleteCheckpoint(id: string): Promise<void> {
    await transport.post('/checkpoint/delete', { chatKey: this.activeChatKey, id });
  }

  /** Delete this chat's snapshots, keeping the `keep` newest. */
  async clearCheckpoints(keep = 0): Promise<number> {
    const r = await transport.post('/checkpoint/clear', { chatKey: this.activeChatKey, keep }) as { deleted: number };
    return r.deleted;
  }

  async restore(id: string): Promise<{ lore: number | null; memory: number | null }> {
    const r = await transport.post<{ lore: number | null; memory: number | null }>(
      '/checkpoint/restore', { chatKey: this.activeChatKey, id });
    await this.loadTurns();
    this.bump();
    return r;
  }

  // --- write back ---------------------------------------------------------

  /**
   * Push the working state into RisuAI - turns, this chat's lorebook and its
   * memory - in one host write.
   *
   * Which path the turns take is decided by the backend's `structural` flag,
   * not by inspecting the lists: once turns were inserted, deleted or
   * reordered, a per-turn patch cannot express the result and the whole array
   * has to go. Lorebook and memory are sent whole whenever anything in them
   * differs from the baseline; the host write replaces the field either way.
   */
  async writeBack(): Promise<WriteBackResult> {
    // RisuAI's own server save is watched after the write (§1-80): "verified"
    // reads the tab's memory, which is not the same as kept.
    // The lock goes up first (GitHub #3): the save-clock read below can take
    // seconds, and the panel used to sit unlocked through it.
    let since: number | null = null;
    const r = await foregroundWrite(async report => {
      since = await persistBaseline();
      report('대화 저장 및 반영 결과 확인 중…');
      return this.performWriteBack();
    });
    if (r.verified && r.mode !== 'noop') watchPersist(since);
    return r;
  }

  private async performWriteBack(): Promise<WriteBackResult> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.patch();
    const update = this.updateFrom(patch, false);
    if (!update) {
      return { mode: 'noop', applied: 0, lore: 0, memory: 0, warnings: patch.warnings, verified: true };
    }
    // The chat being edited, which is not always the one RisuAI has open.
    const slot = await this.chatSlot();
    const r = await host.writeChat(slot, this.activeChat?.chatId || this.liveChat?.id, update);
    return {
      mode: r.mode, applied: r.applied,
      lore: patch.lore?.changed ?? 0, memory: patch.memory?.changed ?? 0,
      warnings: patch.warnings,
      verified: r.verified, ...(r.drift ? { drift: r.drift } : {}),
    };
  }

  /**
   * The host update a patch calls for, or null when nothing differs.
   *
   * `whole` asks for every part regardless of whether it changed - a copy has
   * to carry the working state in full, not only the parts that moved.
   */
  private updateFrom(patch: Patch, whole: boolean): host.ChatUpdate | null {
    const update: host.ChatUpdate = {};
    if (patch.structural) {
      if (!patch.messages) throw new Error('구조 변경인데 백엔드가 메시지 배열을 주지 않았습니다');
      update.messages = patch.messages;
    } else if (patch.edits.length) {
      update.edits = patch.edits;
    }
    if (patch.lore && (whole || patch.lore.changed)) update.localLore = patch.lore.localLore;
    if (patch.memory && (whole || patch.memory.changed)) update.memory = patch.memory.data;
    // Saving a copy writes a brand-new chat and cannot clobber anything, so it
    // sends no guards; a write-back into the live chat sends both.
    if (!whole) {
      if (update.messages) update.beforeTurns = patch.beforeTurns;
      if (update.localLore) update.loreBefore = patch.lore?.before;
    }
    return Object.keys(update).length ? update : null;
  }

  async saveCopy(name: string): Promise<void> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.patch();
    const update = this.updateFrom(patch, true) ?? {};
    if (!update.messages) update.messages = (await this.messagesFromExport()) ?? undefined;
    delete update.edits;
    await host.saveAsCopy(await this.chatSlot(), update, name);
  }

  private async messagesFromExport(): Promise<RisuMessage[] | null> {
    const res = await transport.get<{ envelope: { data?: { message?: RisuMessage[] } } }>(
      '/export/risuchat', { chatKey: this.activeChatKey },
    );
    return res.envelope?.data?.message ?? null;
  }

  // --- exports ------------------------------------------------------------

  async exportMarkdown(): Promise<{ filename: string; markdown: string }> {
    return await transport.get('/export/md', { chatKey: this.activeChatKey });
  }

  async exportRisuchat(): Promise<{ filename: string; envelope: unknown }> {
    return await transport.get('/export/risuchat', { chatKey: this.activeChatKey });
  }

  // --- agent --------------------------------------------------------------

  sessionId = '';

  /** `limit` = only the last n shown messages: a phone parses 40, not a
   * whole afternoon (the 164MB /session of §1-55 was history rows, now
   * excluded server-side; the limit keeps the rest small too). */
  async agentSession(sessionId?: string, limit = 0): Promise<AgentSession> {
    const revision = this.contextRevision;
    const chatKey = this.activeChatKey;
    const r = await transport.get<AgentSession>('/session', {
      chatKey,
      sessionId: sessionId || undefined,
      limit: limit > 0 ? limit : undefined,
    });
    if (revision !== this.contextRevision || chatKey !== this.activeChatKey) throw new Error('봇 또는 챗 선택이 변경되었습니다');
    this.sessionId = r.session?.sessionId ?? '';
    return r;
  }

  async workPlan(mode?: WorkPlan['mode'], revision?: number): Promise<WorkPlan> {
    if (!this.sessionId) await this.newAgentSession();
    const sid = this.sessionId;
    const context = this.contextRevision;
    const args = { sessionId: sid, chatKey: this.activeChatKey, ...(mode ? { mode, revision } : {}) };
    const result = mode ? await transport.post<WorkPlan>('/agent/plan', args)
      : await transport.get<WorkPlan>('/agent/plan', args);
    if (sid !== this.sessionId || context !== this.contextRevision) throw new Error('대화가 변경되었습니다');
    return result;
  }

  async agentSessions(): Promise<AgentSessionInfo[]> {
    const r = await transport.get<{ sessions: AgentSessionInfo[] }>('/sessions', {
      chatKey: this.activeChatKey,
    });
    return r.sessions ?? [];
  }

  /** Start a fresh conversation; the previous one stays in the history list. */
  async newAgentSession(): Promise<void> {
    const revision = this.contextRevision;
    const chatKey = this.activeChatKey;
    const r = await transport.post<{ sessionId: string }>('/session', { chatKey });
    if (revision !== this.contextRevision || chatKey !== this.activeChatKey) throw new Error('봇 또는 챗 선택이 변경되었습니다');
    this.sessionId = r.sessionId;
  }

  /**
   * Send one instruction, yielding NDJSON events as they arrive.
   *
   * A session is created lazily so opening the tab costs nothing; only actually
   * talking to the agent creates one.
   */
  async *agentChat(prompt: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    if (!this.sessionId) {
      await this.newAgentSession();
    }
    if (signal?.aborted) return;
    yield* transport.stream('/chat', {
      sessionId: this.sessionId, prompt,
      mode: this.agentMode,
      // Which persona the persona tab has open (§1-89); the agent is told.
      persona: this.editMode === 'persona' ? (this.persona?.key ?? '') : '',
      // The module the card tabs show and every module opened (§1-95).
      target: this.cardTarget,
      modules: this.openModules.map((m) => m.key),
    }, signal);
  }

  /** 중단 as a request the backend hears at once (§1-44): the aborted fetch
   * alone reaches it only at the turn's next write when a proxy sits between. */
  async stopAgent(): Promise<void> {
    if (!this.sessionId) return;
    try { await transport.post('/agent/stop', { sessionId: this.sessionId }); } catch { /* the abort still stands */ }
  }

  // --- merge conflicts ------------------------------------------------------

  /** Rows where our copy and RisuAI's both moved since the last open. */
  async conflicts(scope: 'chat' | 'card' | 'both' = 'both'): Promise<ConflictItem[]> {
    const q: Record<string, string> = {};
    if (scope !== 'card' && this.activeChatKey) q.chatKey = this.activeChatKey;
    // The card tabs' target: the bot, or a module (§1-95).
    if (scope !== 'chat' && this.botKey) q.charKey = this.botKey;
    if (!Object.keys(q).length) return [];
    const r = await transport.get<{ conflicts: ConflictItem[] }>('/conflicts', q);
    return r.conflicts ?? [];
  }

  async resolveConflict(kind: string, id: string, choice: 'mine' | 'theirs'): Promise<void> {
    await transport.post('/conflict/resolve', { kind, id, choice });
    await this.afterResolve();
  }

  async resolveAllConflicts(choice: 'mine' | 'theirs', scope: 'chat' | 'card'): Promise<number> {
    const r = await transport.post<{ resolved: number }>('/conflict/resolve', {
      all: true, choice,
      ...(scope === 'chat' ? { chatKey: this.activeChatKey } : { charKey: this.botKey }),
    });
    await this.afterResolve();
    return r.resolved ?? 0;
  }

  private async afterResolve(): Promise<void> {
    if (this.activeChatKey) await this.loadTurns();
    await this.refreshChanges();
    await this.refreshBotChanges();
    this.epoch += 1;
    this.emit();
  }

  async stagedEdits(): Promise<StagedEdit[]> {
    const r = await transport.get<{ staged: StagedEdit[] }>('/staged', { chatKey: this.activeChatKey });
    return r.staged ?? [];
  }

  async approveStaged(approve: boolean): Promise<{ decided: number; applied: number }> {
    const r = await transport.post<{ decided: number; applied: number }>(
      '/approve', { chatKey: this.activeChatKey, all: true, approve });
    void this.refreshChanges();
    return r;
  }

  // --- settings -----------------------------------------------------------

  async getConfig(): Promise<{ config: Record<string, any>; keepSentinel: string }> {
    return await transport.get('/config');
  }

  async setConfig(patch: Record<string, unknown>): Promise<void> {
    await transport.post('/config', { config: patch });
  }

  async testAgent(kind: 'general' | 'search' = 'general'): Promise<Record<string, unknown>> {
    // Two model rounds at up to 110s each on the backend; the panel waits for both.
    return await transport.post('/config/test', { section: kind === 'search' ? 'agent_search' : 'agent' }, 240_000);
  }

  // --- web search provider (what the search agent searches with) ------------

  async websearch(): Promise<WebsearchStatus> {
    return await transport.get('/websearch');
  }

  async saveWebsearch(patch: Record<string, unknown>): Promise<void> {
    await transport.post('/config', { config: { websearch: patch } });
  }

  /** One real search in the configured mode. Native mode probes several
   *  shapes at up to a minute each, so the wait is generous. */
  async testWebsearch(query: string): Promise<WebsearchTest> {
    return await transport.post('/websearch/test', { query }, 330_000);
  }

  // --- the vision tool (§1-42) ---------------------------------------------

  async vision(): Promise<VisionStatus> {
    return await transport.get('/vision');
  }

  async saveVision(patch: Record<string, unknown>): Promise<void> {
    await transport.post('/config', { config: { vision: patch } });
  }

  /** One real look in the configured mode (the native probe goes through
   * the agent model, which can take a while). */
  async testVision(path = '', question = ''): Promise<VisionTest> {
    return await transport.post('/vision/test', { path, question }, 180_000);
  }

  // --- diagnostics ----------------------------------------------------------

  async logs(limit = 300, level = ''): Promise<{ lines: string[]; count: number }> {
    return await transport.get(
      `/logs?limit=${limit}` + (level ? '&level=' + encodeURIComponent(level) : ''));
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    return await transport.get('/diag');
  }

  // --- backend update -------------------------------------------------------

  async updateCheck(): Promise<{
    ok: boolean; configured: boolean; current: string; latest?: string;
    newer?: boolean; ahead?: boolean; notes?: string; installable?: boolean; reason?: string | null;
    error?: string;
  }> {
    return await transport.post('/update/check', {}, 45_000);
  }

  /**
   * Install and restart.
   *
   * The backend replies and then exits on a timer, so the connection this
   * request rode in on is the last one that version answers. Polling /health
   * afterwards is how the panel finds out it came back - and finding out is
   * the point, because a restart that fails looks exactly like a slow one.
   */
  async updateApply(): Promise<{ updated: boolean; version?: string; reason?: string }> {
    return await transport.post('/update/apply', {}, 300_000);
  }

  async waitForBackend(seconds = 60): Promise<string> {
    const deadline = Date.now() + seconds * 1000;
    let lastError = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const h = await transport.connect();
        this.health = h;
        this.emit();
        return h.version;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error('백엔드가 다시 올라오지 않았습니다: ' + lastError);
  }

  // --- the global file space --------------------------------------------------
  //
  // ONE tree every bot shares (projects/ · studio/ · hina/<봇이름>/). No
  // charKey: the scope is the space itself. The per-bot SYSTEM view (frozen
  // originals, machinery) is read-only and reached with `system: 1`.

  /** Save a space file to the user's disk through the browser - with the
   * wait shown and a phone-safe save (ui/download, §1-62). */
  async downloadFile(path: string): Promise<number> {
    const name = path.split('/').pop() || 'file';
    const { saveToDevice } = await import('./ui/download');
    return await saveToDevice(name, (onProgress) => transport.postBinaryProgress('/files/download', { path }, onProgress),
      name.endsWith('.charx') ? 'application/zip' : 'application/octet-stream');
  }

  // --- charx ------------------------------------------------------------------

  async charxPreview(): Promise<CharxPreview> {
    return await transport.get('/charx/preview', { charKey: this.activeCharKey });
  }

  /** Build out/<name>.charx on the backend from the working card + store. */
  async charxBuild(opts: { allowMissing?: boolean; name?: string } = {}): Promise<CharxBuilt> {
    const r = await transport.post<CharxBuilt>('/charx/build', {
      charKey: this.activeCharKey, allowMissing: !!opts.allowMissing, name: opts.name || '',
    }, 600_000);
    this.touchFiles([r.path]);
    return r;
  }

  async files(prefix = '', hidden = false, bot = ''): Promise<FileListing> {
    const q: string[] = [];
    if (prefix) q.push('prefix=' + encodeURIComponent(prefix));
    if (hidden) q.push('hidden=1');
    // The listing names this bot's folder back (`botFolder`) for "이 봇만".
    if (bot) q.push('bot=' + encodeURIComponent(bot));
    let r: FileListing | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await transport.get<FileListing | null>('/files' + (q.length ? '?' + q.join('&') : ''));
        break;
      } catch (error) {
        // Only repeat the read. A lost response to a move/copy may follow a
        // successful mutation, so those operations must not be replayed.
        if (!(error instanceof BackendError) || ![0, 502, 503, 504].includes(error.status) || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
    // A reply without `areas` (an empty body while the backend restarts, a
    // proxy's placeholder) used to surface as "Cannot read properties of
    // null (reading 'areas')" in the files tab (§1-39). Name the condition.
    if (!r || !Array.isArray(r.areas)) {
      throw new Error('파일 목록을 받지 못했습니다 (백엔드가 재시작 중이거나 응답이 비어 있음) — 잠시 뒤 새로고침하세요.');
    }
    return r;
  }

  /** This bot's SYSTEM directory: frozen originals and machinery, read-only. */
  async systemFiles(): Promise<FileListing> {
    return await transport.get('/files?system=1&charKey=' + encodeURIComponent(this.activeCharKey));
  }

  async readFile(path: string): Promise<{ path: string; size: number; textual: boolean;
                                          content: string; truncated?: boolean; note?: string }> {
    return await transport.get('/files/read?path=' + encodeURIComponent(path));
  }

  async uploadFile(name: string, content: string, base64 = false, dir = '', extract = false)
    : Promise<{ path: string; size: number; extracted?: number }> {
    // No folder named (an AI-chat attachment, a portrait swap): the project
    // being edited - the persona's folder in persona mode, otherwise the
    // backend picks the bot's projects/<봇> from `bot`. It used to fall to
    // projects/ itself, the top of the space.
    if (!dir && this.targetModule) dir = `projects/${this.targetModule.folder}`;
    if (!dir && this.editMode === 'persona' && this.personaFolder) dir = this.personaFolder;
    const bot = dir ? undefined : this.activeCharKey || undefined;
    return await transport.upload('/files/upload', base64
      ? { name, base64: content, dir, extract, bot }
      : { name, text: content, dir, bot });
  }

  /** The project folder being edited: the persona's in persona mode, else
   *  the bot's (`botFolder` from the files listing; '' before it is known). */
  projectDir(botFolder: string): string {
    if (this.targetModule) return `projects/${this.targetModule.folder}`;
    if (this.editMode === 'persona' && this.personaFolder) return this.personaFolder;
    return botFolder ? `projects/${botFolder}` : '';
  }

  /**
   * A batch of files as one binary body: [u32 header length][JSON header][bytes…].
   * `entries[i].bytes` go in order; the header carries name, rel (subfolder
   * under `dir`) and size for each.
   */
  async uploadBatch(dir: string, entries: { name: string; rel: string; bytes: Uint8Array }[], extract = false)
    : Promise<{ files: { path: string; name: string; size: number; extracted?: number }[]; count: number; size: number; extracted: number }> {
    const header = new TextEncoder().encode(JSON.stringify({
      dir, extract,
      files: entries.map((e) => ({ name: e.name, rel: e.rel, size: e.bytes.byteLength })),
    }));
    const total = 4 + header.byteLength + entries.reduce((n, e) => n + e.bytes.byteLength, 0);
    const body = new Uint8Array(total);
    new DataView(body.buffer).setUint32(0, header.byteLength);
    body.set(header, 4);
    let at = 4 + header.byteLength;
    for (const e of entries) { body.set(e.bytes, at); at += e.bytes.byteLength; }
    return await transport.postBytes('/files/upload-many', body);
  }

  /**
   * One piece of a file too large to send in a single body.
   *
   * A character's .charx runs to 140-180MB, and every single-shot path caps
   * far below that: the backend's body limit, and a relay in front of it.
   * Pieces are appended server-side at the offset they claim, and the file
   * only appears in the workspace once the last one lands.
   */
  async uploadChunk(dir: string, part: {
    name: string; rel: string; offset: number; total: number; last: boolean; extract?: boolean;
  }, bytes: Uint8Array): Promise<{ done: boolean; received: number; total: number; extracted?: number }> {
    const header = new TextEncoder().encode(JSON.stringify({ dir, ...part }));
    const body = new Uint8Array(4 + header.byteLength + bytes.byteLength);
    new DataView(body.buffer).setUint32(0, header.byteLength);
    body.set(header, 4);
    body.set(bytes, 4 + header.byteLength);
    return await transport.postBytes('/files/upload-chunk', body);
  }

  /** Several files or a folder as one zip, handed to the browser to save. */
  async downloadZip(paths: string[], name: string): Promise<number> {
    const file = name.endsWith('.zip') ? name : name + '.zip';
    const { saveToDevice } = await import('./ui/download');
    return await saveToDevice(file, (onProgress) => transport.postBinaryProgress('/files/zip', { paths, name }, onProgress),
      'application/zip');
  }

  /** Size and pixel dimensions of a space file without its bytes (§1-55). */
  async fileStat(path: string): Promise<{ size: number; width: number; height: number; format: string }> {
    return await transport.post('/files/stat', { path });
  }

  /** Raw bytes of a space file (an image preview, a thumbnail). POST: see tab-assets. */
  async fileBytes(path: string, timeoutMs?: number): Promise<Uint8Array> {
    return await transport.postBinary('/files/download', { path }, timeoutMs);
  }

  /** A small server-side WebP preview (Pillow); the server streams the
   * original bytes instead when it cannot thumb, so callers need no fallback. */
  async fileThumb(path: string, w = 360): Promise<Uint8Array> {
    return await transport.postBinary('/files/thumb', { path, w }, 25_000);
  }

  async mkdirFile(path: string): Promise<void> {
    await transport.post('/files/mkdir', { path });
  }

  async moveFile(from: string, to: string): Promise<{ to: string }> {
    return await transport.post('/files/move', { from, to });
  }

  /** Server-side copy (the context menu's 복사/붙여넣기). A taken name counts
   * up to `이름 (2)` on the backend rather than refusing. */
  async copyFile(from: string, to: string): Promise<{ to: string }> {
    return await transport.post('/files/copy', { from, to });
  }

  async deleteFile(path: string): Promise<void> {
    await transport.post('/files/delete', { path });
  }

  // Batched verbs: ONE round trip for N paths; a name clash or a missing
  // file lands in `failed` while the rest of the batch proceeds.
  async moveFiles(paths: string[], to: string): Promise<BatchFsResult> {
    return await transport.post('/files/move', { paths, to });
  }

  async copyFiles(paths: string[], to: string): Promise<BatchFsResult> {
    return await transport.post('/files/copy', { paths, to });
  }

  async deleteFiles(paths: string[]): Promise<BatchFsResult> {
    return await transport.post('/files/delete', { paths });
  }

  async cleanFiles(areas?: string[]): Promise<{ areas: string[]; removed: number; freed: number }> {
    return await transport.post('/files/clean', { charKey: this.activeCharKey, areas });
  }

  /** The asset studio's domain calls (files go through the shared methods). */
  readonly studio = new StudioFiles();

  // --- agent presets --------------------------------------------------------

  async presets(): Promise<{
    presets: AgentPreset[];
    selected: AgentPreset | null;
    selectedSearch: AgentPreset | null;
    kinds: string[];
    keys: ApiKeyEntry[];
    /** What a new preset's instructions start as, per kind. */
    defaultInstructions?: Record<string, string>;
    defaultAgentName?: string;
    reasoningLevels: string[];
    keepSentinel: string;
    maxInstructions: number;
    providers?: ProviderProfile[];
    maxParams?: number;
  }> {
    return await transport.get('/presets');
  }

  private providerCache: ProviderProfile[] | null = null;

  /** Provider profiles (cached for the panel's lifetime - they are code, not data). */
  async providers(): Promise<ProviderProfile[]> {
    if (this.providerCache) return this.providerCache;
    const r = await transport.get<{ providers: ProviderProfile[] }>('/catalog/providers');
    this.providerCache = r.providers ?? [];
    return this.providerCache;
  }

  /** Make a preset the one the agent runs. Writes through to the live config. */
  async selectPreset(id: string): Promise<string> {
    const r = await transport.post('/presets/select', { id }) as { selected: string };
    return r.selected;
  }

  async savePreset(name: string, values: Record<string, unknown>, id?: string): Promise<AgentPreset> {
    const r = await transport.post('/presets/save', { name, values, id }) as { preset: AgentPreset };
    return r.preset;
  }

  async capturePreset(name: string): Promise<AgentPreset> {
    const r = await transport.post('/presets/capture', { name }) as { preset: AgentPreset };
    return r.preset;
  }

  async applyPreset(id: string): Promise<string> {
    const r = await transport.post('/presets/apply', { id }) as { applied: string };
    return r.applied;
  }

  async deletePreset(id: string): Promise<void> {
    await transport.post('/presets/delete', { id });
  }

  /** Only the search agent may run without a preset. */
  async deselectPreset(kind: 'search'): Promise<void> {
    await transport.post('/presets/deselect', { kind });
  }

  // --- API keys ---------------------------------------------------------------

  async apiKeys(): Promise<{ keys: ApiKeyEntry[]; keepSentinel: string }> {
    return await transport.get('/keys');
  }

  async saveApiKey(values: Record<string, unknown>, id?: string): Promise<ApiKeyEntry> {
    const r = await transport.post<{ key: ApiKeyEntry }>('/keys/save', { values, id });
    return r.key;
  }

  async deleteApiKey(id: string): Promise<void> {
    await transport.post('/keys/delete', { id });
  }

  /** models.dev, through the backend's daily cache. */
  async modelCatalog(q: string, provider = '', refresh = false): Promise<CatalogResult> {
    return await transport.get('/models/catalog', { q, provider, refresh: refresh ? '1' : '' });
  }

  // --- ChatGPT plan login (provider id codex) -----------------------------------------

  async codexStatus(): Promise<CodexStatus> {
    return await transport.get('/codex/status');
  }

  /** `account`: '' = the active registration (or a new one), 'new' = add an
   * account, or a saved client id. `consent` asks again for plan usage. */
  async codexLoginStart(account = '', consent = false): Promise<{ url: string; state: string; listening: boolean; redirectUri: string; newAccount: boolean }> {
    return await transport.post('/codex/login/start', { account, consent });
  }

  async codexLoginStatus(state: string): Promise<{ known: boolean; done: boolean; error: string; loggedIn?: boolean }> {
    return await transport.get('/codex/login/status', { state });
  }

  async codexLoginComplete(redirect: string, state = ''): Promise<CodexStatus> {
    return await transport.post('/codex/login/complete', { redirect, state });
  }

  async codexLogout(): Promise<{ loggedIn: boolean; revoked: boolean }> {
    return await transport.post('/codex/logout', {});
  }

  async codexWelcomeSeen(): Promise<CodexStatus> {
    return await transport.post('/codex/welcome', {});
  }

  // --- permission prompts (shell / pip while a turn runs) --------------------------

  async permits(): Promise<PermitRequest[]> {
    if (!this.sessionId) return [];
    const r = await transport.get<{ pending: PermitRequest[] }>('/permits', { sessionId: this.sessionId });
    return r.pending ?? [];
  }

  async decidePermit(id: string, allow: boolean, always = false): Promise<void> {
    await transport.post('/permits/decide', { id, allow, always });
  }

  // --- skills ---------------------------------------------------------------

  async syncSkills(): Promise<{ updated: number; created: number }> {
    return await transport.post('/skills/sync', { confirmOverwrite: true });
  }

  async skills(): Promise<SkillListing> {
    return await transport.get('/skills');
  }

  async skill(id: string): Promise<Skill> {
    const r = await transport.get('/skills/get', { id }) as { skill: Skill };
    return r.skill;
  }

  async saveSkill(v: {
    id?: string; name: string; description: string; body: string; always?: boolean; enabled?: boolean;
  }): Promise<Skill> {
    const r = await transport.post('/skills/save', v) as { skill: Skill };
    return r.skill;
  }

  /** A file inside a skill folder. Binary-safe: everything goes as base64. */
  async putSkillFile(id: string, path: string, file: File): Promise<{ path: string; size: number }> {
    const body = await fileBase64(file);
    return await transport.post('/skills/file', { id, path, body, base64: true });
  }

  async deleteSkillFile(id: string, path: string): Promise<void> {
    await transport.post('/skills/file/delete', { id, path });
  }

  /** Register a file as a skill. The extension decides whether it is a script. */
  /** Import a skill from a file: .md/.py become a skill of their own, .zip is a whole folder. */
  async uploadSkill(file: File): Promise<Skill> {
    const zip = /\.zip$/i.test(file.name);
    const payload = zip
      ? { filename: file.name, body: await fileBase64(file), base64: true }
      : { filename: file.name, body: await file.text() };
    const r = await transport.post('/skills/upload', payload) as { skill: Skill };
    return r.skill;
  }

  async toggleSkill(id: string, enabled: boolean): Promise<void> {
    await transport.post('/skills/toggle', { id, enabled });
  }

  async deleteSkill(id: string): Promise<void> {
    await transport.post('/skills/delete', { id });
  }

  async skillPrompt(): Promise<{ prompt: string; chars: number }> {
    return await transport.get('/skills/preview');
  }

  // --- the approval queue ----------------------------------------------------

  async actions(): Promise<PendingAction[]> {
    const r = await transport.get(
      '/actions?chatKey=' + encodeURIComponent(this.activeChatKey)) as { actions: PendingAction[] };
    return r.actions;
  }

  /** Every pending proposal of the open bot, whichever chat it rode on. */
  async actionsForBot(): Promise<PendingAction[]> {
    if (!this.activeCharKey) return [];
    const mods = this.openModules.map((m) => m.key).join(',');
    const r = await transport.get(
      '/actions?charKey=' + encodeURIComponent(this.activeCharKey)
      + (mods ? '&modules=' + encodeURIComponent(mods) : '')) as { actions: PendingAction[] };
    return r.actions;
  }

  /** Reject every pending proposal of the open bot. */
  async clearBotActions(): Promise<number> {
    const r = await transport.post('/actions/clear', { charKey: this.activeCharKey }) as { cleared: number };
    this.bump();
    void this.refreshChanges();
    void this.refreshBotChanges();
    return r.cleared;
  }

  /**
   * Approve or reject one proposal, and carry it out if it is ours to do.
   *
   * The backend runs what it can and hands back a `host` block for what it
   * cannot - writing to the live chat and saving a copy both need APIs that
   * only exist inside this iframe. The result is reported back either way, so
   * a failure here does not leave a queue entry claiming success.
   */
  async decideAction(id: string, approve: boolean, chatKey = '', mode?: string): Promise<string> {
    // No screen gate on a decision (§1-76): a proposal is approved from
    // wherever the user is - the title-row 승인, the agent pane, 검수 - not
    // only from the half of the panel it belongs to. `mode` stays for callers
    // that want the gate explicitly.
    const r = await transport.post('/actions/decide', {
      chatKey: chatKey || this.activeChatKey, id, approve, mode: mode ?? '',
    }) as { approved: boolean; result?: string; host?: { kind: string; args: Record<string, any>; charKey?: string } };

    if (!r.approved) return '거절했습니다.';
    if (!r.host) {
      // A lorebook or memory proposal just landed in the working copy; the
      // tabs caching those lists and the shared bar both have to hear it.
      this.bump();
      await Promise.all([this.refreshChanges(), this.refreshBotChanges(), this.refreshPersonaList(), this.refreshModuleRows()]);
      return String(r.result ?? '실행했습니다.');
    }

    try {
      let detail = '';
      if (r.host.kind === 'host_writeback') {
        const out = await this.writeBack();
        if (!out.verified) throw new Error(out.drift || 'RisuAI 저장 결과를 확인하지 못했습니다. 미반영 변경을 보존했습니다.');
        const shipped = out.mode !== 'noop' || out.lore > 0 || out.memory > 0;
        // The write landed: make it the baseline, as the bar's 반영 and the
        // leave guard do (§1-84). Skipping this left the shipped edits counted
        // as pending, and the next 반영 compared RisuAI's chat - which now
        // holds them - against the old turns and refused it as "changed".
        if (shipped) await this.commit('반영 직전');
        // Name what went in: a lorebook- or memory-only write used to read
        // "0건을 반영" (only turns were counted) and looked like a no-op.
        const bits = [
          out.applied ? `턴 ${out.applied}건` : '',
          out.lore ? `챗 로어북 ${out.lore}건` : '',
          out.memory ? `장기기억 ${out.memory}건` : '',
        ].filter(Boolean);
        detail = !shipped
          ? '챗에 반영할 변경이 없었습니다.'
          : `${bits.length ? bits.join(' · ') : '챗 변경'}을 RisuAI에 반영하고 저장을 확인했습니다.`;
      } else if (r.host.kind === 'host_save_copy') {
        const name = String(r.host.args?.name || '') || '사본';
        await this.saveCopy(name);
        detail = `“${name}” 으로 복사본을 저장했습니다.`;
      } else if (r.host.kind === 'host_card_writeback') {
        // The proposal names its working copy: the bot, or a module (§1-95).
        const out = await this.cardWriteBack(() => {}, r.host.charKey || this.activeCharKey);
        if (!out.verified) throw new Error(out.drift || 'RisuAI 저장 결과를 확인하지 못했습니다. 미반영 변경을 보존했습니다.');
        detail = out.mode === 'noop'
          ? '카드에 반영할 변경이 없었습니다.'
          : `카드 변경 ${out.applied}건${out.parts?.length ? `(${host.describeCardParts(out.parts)})` : ""}을 RisuAI에 반영하고 저장을 확인했습니다.`;
      } else if (r.host.kind === 'host_clone_bot') {
        const name = String(r.host.args?.name || '') || '복제 봇';
        await this.cloneBot(name);
        detail = `복제 봇 “${name}” 을 만들었습니다. RisuAI 목록에서 확인해 주세요.`;
      } else if (r.host.kind === 'host_persona_writeback') {
        const out = await this.personaWriteBack(String(r.host.args?.key || ''));
        detail = out.copied
          ? `선택된 페르소나라 원본 대신 새 페르소나 '${out.name}' (사본)으로 RisuAI에 저장하고 확인했습니다.`
          : out.written
          ? `페르소나 '${out.name}' 을(를) RisuAI에 반영하고 저장을 확인했습니다.`
          : '페르소나에 반영할 변경이 없었습니다.';
      } else if (r.host.kind === 'host_open_tab') {
        const tab = String(r.host.args?.tab || '');
        // A proposal made while a module was the target opens that module's tab.
        const mk = r.host.charKey || '';
        if (this.openModules.some((m) => m.key === mk)) this.cardTarget = mk;
        else if (mk === this.activeCharKey) this.cardTarget = '';
        this.openTabRequest = tab;
        this.emit();
        detail = '탭을 이동했습니다.';
      } else if (r.host.kind === 'host_asset_add' || r.host.kind === 'host_asset_replace') {
        throw new Error('에셋 승인 방식이 변경되었습니다. 백엔드를 갱신하고 제안을 다시 만들어 주세요. 에셋은 반영할 때 등록됩니다.');
      } else if (r.host.kind === 'host_asset_add_many') {
        throw new Error('에셋 승인 방식이 변경되었습니다. 백엔드를 갱신하고 제안을 다시 만들어 주세요. 에셋은 반영할 때 등록됩니다.');
      } else {
        throw new Error('플러그인이 모르는 작업입니다: ' + r.host.kind);
      }
      await transport.post('/actions/complete', { chatKey: chatKey || this.activeChatKey, id, ok: true, detail });
      return detail;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await transport.post('/actions/complete', {
        chatKey: chatKey || this.activeChatKey, id, ok: false, detail: why,
      });
      throw e;
    }
  }

  // --- lorebook -------------------------------------------------------------

  /** The agent's save tool runs only for an explicit user writeback request. */
  async requestedCardWriteback(id: string, charKey: string, chatKey: string): Promise<string> {
    if (!id || !charKey) throw new Error('잘못된 봇 저장 요청입니다.');
    if (this.activeCharKey !== charKey && !this.openModules.some((m) => m.key === charKey)) {
      const detail = '요청한 봇과 현재 봇이 달라 저장하지 않았습니다.';
      await transport.post('/actions/complete', { chatKey, id, ok: false, detail });
      throw new Error(detail);
    }
    try {
      return await this.decideAction(id, true, chatKey);
    } catch (error) {
      // Also report failures before the host block (e.g. a stale action), so
      // the waiting tool need not wait for its timeout to learn the outcome.
      await transport.post('/actions/complete', { chatKey, id, ok: false, detail: String(error) }).catch(() => {});
      throw error;
    }
  }

  async lore(scope?: 'global' | 'local'): Promise<LoreEntry[]> {
    const q = '/lore?charKey=' + encodeURIComponent(scope === 'local' ? this.activeCharKey : this.botKey)
      + (scope ? '&scope=' + scope : '');
    const r = await transport.get(q) as { lore: LoreEntry[] };
    return r.lore;
  }

  async saveLore(id: string, entry: Record<string, unknown>): Promise<void> {
    await transport.post('/lore/update', { charKey: this.botKey, id, entry });
    void this.refreshChanges();
  }

  async addLore(entry: Record<string, unknown>, scope: 'global' | 'local'): Promise<string> {
    const r = await transport.post('/lore', {
      charKey: scope === 'local' ? this.activeCharKey : this.botKey, entry, scope,
      chatKey: scope === 'local' ? this.activeChatKey : undefined,
    }) as { id: string };
    void this.refreshChanges();
    return r.id;
  }

  async deleteLore(id: string): Promise<void> {
    await transport.post('/lore/delete', { charKey: this.botKey, id });
    void this.refreshChanges();
  }

  async moveLore(id: string, toSeq: number): Promise<void> {
    await transport.post('/lore/move', { charKey: this.botKey, id, toSeq });
    void this.refreshChanges();
    void this.refreshBotChanges();
  }

  // --- long-term memory -----------------------------------------------------

  async memory(): Promise<{ items: MemoryItem[]; changed: number }> {
    return await transport.get('/memory?chatKey=' + encodeURIComponent(this.activeChatKey));
  }

  async saveMemory(id: string, body: string, title?: string): Promise<MemoryItem> {
    const r = await transport.post('/memory/update', {
      chatKey: this.activeChatKey, id, body, title,
    }) as { item: MemoryItem };
    void this.refreshChanges();
    return r.item;
  }

  async addMemory(kind: string, body: string, title = ''): Promise<MemoryItem> {
    const r = await transport.post('/memory/add', {
      chatKey: this.activeChatKey, kind, body, title,
    }) as { item: MemoryItem };
    void this.refreshChanges();
    return r.item;
  }

  async deleteMemory(id: string): Promise<void> {
    await transport.post('/memory/delete', { chatKey: this.activeChatKey, id });
    void this.refreshChanges();
  }

  // --- the card (bot editing) -----------------------------------------------
  //
  // The char-key twins of the chat calls above, addressed by `botKey`. Editing
  // works on any workspace the backend knows; only 반영/복제 touch RisuAI and
  // carry the isLiveBot gate.

  /** Same contract as refreshChanges, for the bot bar. */
  async refreshBotChanges(): Promise<CardChanges | null> {
    if (!this.botKey) { this.botChanges = null; this.emit(); return null; }
    const revision = this.contextRevision;
    const key = this.botKey;
    try {
      const result = await transport.get<CardChanges>('/card/changes', { charKey: key });
      if (revision !== this.contextRevision || key !== this.botKey) return null;
      this.botChanges = result;
    } catch {
      if (revision !== this.contextRevision || key !== this.botKey) return null;
      this.botChanges = null;
    }
    this.emit();
    return this.botChanges;
  }

  /** The store's view of the bot's assets: the manifest with state and size. */
  async assetList(): Promise<{ items: AssetItem[]; total: number; present: number; missing: number; failed: number; bytes: number; complete: boolean }> {
    return await transport.get('/assets/list', { charKey: this.botKey });
  }

  async cardFields(): Promise<{ full: boolean; fields: CardField[]; changed: number }> {
    return await transport.get('/card', { charKey: this.botKey });
  }

  async cardScripts(kind: CardScript['kind']): Promise<CardScript[]> {
    const r = await transport.get<{ items: CardScript[] }>('/card/scripts', { charKey: this.botKey, kind });
    return r.items ?? [];
  }

  /** Stage a workspace image as the new profile picture (§1-66). */
  async replacePortrait(path: string): Promise<void> {
    await transport.post('/card/portrait', { charKey: this.botKey, path });
    this.bump();
    void this.refreshBotChanges();
  }

  async saveCardField(id: string, body: string): Promise<CardField> {
    const r = await transport.post<{ item: CardField }>('/card/field', { charKey: this.botKey, id, body });
    void this.refreshBotChanges();
    return r.item;
  }

  async addGreeting(body: string): Promise<CardField> {
    const r = await transport.post<{ item: CardField }>('/card/greeting', { charKey: this.botKey, body });
    void this.refreshBotChanges();
    return r.item;
  }

  async deleteGreeting(id: string): Promise<void> {
    await transport.post('/card/greeting/delete', { charKey: this.botKey, id });
    void this.refreshBotChanges();
  }

  async saveScript(id: string, entry: Record<string, unknown>): Promise<void> {
    await transport.post('/card/script', { charKey: this.botKey, id, entry });
    void this.refreshBotChanges();
  }

  async addScript(kind: CardScript['kind'], entry: Record<string, unknown>): Promise<string> {
    const r = await transport.post<{ id: string }>('/card/script/add', { charKey: this.botKey, kind, entry });
    void this.refreshBotChanges();
    return r.id;
  }

  async deleteScript(id: string): Promise<void> {
    await transport.post('/card/script/delete', { charKey: this.botKey, id });
    void this.refreshBotChanges();
  }

  async moveScript(id: string, toSeq: number): Promise<void> {
    await transport.post('/card/script/move', { charKey: this.botKey, id, toSeq });
  }

  async cardPatch(key = this.botKey): Promise<CardPatch> {
    return await transport.get<CardPatch>('/card/patch', { charKey: key, stagedAssets: '1' });
  }

  async cardCommit(label: string, key = this.botKey): Promise<void> {
    await transport.post('/card/commit', { charKey: key, label });
    this.bump();
    void this.refreshBotChanges();
  }

  /** Discard the card's working copy, global lorebook included. Returns how
   * many pending changes went, for the confirmation line. */
  async cardReset(): Promise<number> {
    const r = await transport.post<{ discarded?: number }>('/card/reset', { charKey: this.botKey });
    this.bump();
    void this.refreshBotChanges();
    return r.discarded ?? 0;
  }

  async cardCheckpoint(label: string): Promise<void> {
    await transport.post('/card/checkpoint', { charKey: this.botKey, label });
  }

  async cardCheckpoints(): Promise<{ id: string; label: string; created_at: number; kind?: string }[]> {
    const r = await transport.get<{ checkpoints: any[] }>('/card/checkpoints', { charKey: this.botKey });
    return r.checkpoints ?? [];
  }

  async renameCardCheckpoint(id: string, label: string): Promise<void> {
    await transport.post('/card/checkpoint/rename', { charKey: this.botKey, id, label });
  }

  async deleteCardCheckpoint(id: string): Promise<void> {
    await transport.post('/card/checkpoint/delete', { charKey: this.botKey, id });
  }

  async clearCardCheckpoints(keep = 0): Promise<number> {
    const r = await transport.post('/card/checkpoint/clear', { charKey: this.botKey, keep }) as { deleted: number };
    return r.deleted;
  }

  async cardRestore(id: string): Promise<void> {
    await transport.post('/card/checkpoint/restore', { charKey: this.botKey, id });
    this.bump();
    void this.refreshBotChanges();
  }

  /** The host update a card patch calls for, or null when nothing differs. */
  private cardUpdateFrom(patch: CardPatch, whole: boolean): host.CardUpdate | null {
    const update: host.CardUpdate = {};
    if (patch.fields.length) update.fields = patch.fields;
    if (whole || patch.alternateGreetings.changed) update.alternateGreetings = patch.alternateGreetings.list;
    if (whole || patch.globalLore.changed) update.globalLore = patch.globalLore.list;
    if (whole || patch.customscript.changed) update.customscript = patch.customscript.list;
    if (whole || patch.triggerscript.changed) update.triggerscript = patch.triggerscript.list;
    if (patch.assets && (whole || patch.assets.changed)) {
      // Whole lists, like lore and scripts: RisuAI keeps them as lists and a
      // rename or a removal is a change to the list. Only sent when changed.
      update.emotionImages = patch.assets.emotionImages;
      update.additionalAssets = patch.assets.additionalAssets;
      update.ccAssets = patch.assets.ccAssets;
    }
    // What RisuAI held when we based these lists on it, so the host can refuse
    // rather than overwrite a change made there meanwhile. A clone (`whole`)
    // writes into a brand-new bot and has nothing to clobber, so it sends none.
    if (!whole) {
      update.before = {
        alternateGreetings: patch.alternateGreetings.before,
        globalLore: patch.globalLore.before,
        customscript: patch.customscript.before,
        triggerscript: patch.triggerscript.before,
        emotionImages: patch.assets?.before?.emotionImages,
        additionalAssets: patch.assets?.before?.additionalAssets,
        ccAssets: patch.assets?.before?.ccAssets,
      };
    }
    return Object.keys(update).length ? update : null;
  }

  /**
   * Push the working card into RisuAI and, on success, move the baseline.
   *
   * Unlike the chat flow (where the bar orchestrates write → commit), the
   * whole sequence lives here because two callers need it - the bot bar and
   * an approved host_card_writeback - and they must not drift apart.
   */
  async cardWriteBack(progress: (text: string) => void = () => {}, key = this.botKey): Promise<{ applied: number; mode: string; verified: boolean; drift?: string; parts?: string[] }> {
    // A module's 반영 writes db.modules, not a character (§1-95).
    if (key && key !== this.activeCharKey) return this.moduleWriteBack(key, progress);
    // Locked from the first moment (GitHub #3): the save-clock read used to run
    // before the lock, up to 8s of a panel that looked idle - and still
    // clickable - while a (large) 반영 had already started.
    let since: number | null = null;
    const r = await foregroundWrite(async report => {
      since = await persistBaseline();
      return this.performCardWriteBack(text => { report(text); progress(text); });
    });
    if (r.verified && r.mode !== 'noop') watchPersist(since);
    return r;
  }

  private async performCardWriteBack(progress: (text: string) => void): Promise<{ applied: number; mode: string; verified: boolean; drift?: string; parts?: string[] }> {
    if (!this.isLiveBot) {
      throw new Error('반영은 RisuAI에서 이 봇이 선택되어 있어야 합니다. '
        + 'RisuAI에서 봇을 선택한 뒤 패널을 다시 열어 주세요');
    }
    const slot = await host.currentSlot();
    const botKey = this.activeCharKey;
    const patch = await this.cardPatch(botKey);
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 반영할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    const update = this.cardUpdateFrom(patch, false);
    if (!update) return { applied: 0, mode: 'noop', verified: true };
    await this.resolveStagedAssets(update, progress, botKey);
    const current = await host.currentSlot();
    if (current.characterIndex !== slot.characterIndex) throw new Error('이미지 업로드 중 선택된 봇이 바뀌었습니다. 미반영 변경을 보존했습니다.');
    progress('이미지 준비 완료 · 카드 저장 및 반영 결과 확인 중…');
    const r = await host.writeCharacter(slot.characterIndex, patch.chaId, update);
    if (!r.verified) {
      // No commit and no re-read: the re-read is what used to replace the
      // working copy with the text the write had just failed to change.
      return { applied: r.applied, mode: r.mode, verified: false, parts: r.parts, ...(r.drift ? { drift: r.drift } : {}) };
    }
    progress('RisuAI 반영 확인 완료 · 작업본을 동기화하는 중…');
    await this.cardCommit('반영 직전', botKey);
    await this.rereadCard();
    return { applied: r.applied, mode: r.mode, verified: true, parts: r.parts };
  }

  /**
   * The card landed in RisuAI, so stop holding a copy of it.
   *
   * The old flow moved the baseline onto the working copy and kept both. The
   * diff went to zero and our copy stayed behind, and from that moment it
   * drifted from RisuAI again - which is what made a later re-open show
   * untouched rows as edits. Re-reading is the whole fix: after this the
   * working copy IS RisuAI's current card, with no history to go stale.
   *
   * Scoped to the card: a chat's pending edits are none of this write's
   * business and must not be discarded with it.
   */
  private async rereadCard(): Promise<void> {
    // Carry the chat being edited, exactly as rereadChat does. Without a
    // chatIndex the upload sends only RisuAI's open chat, the response lists
    // only that chat, and upload()'s re-pick quietly moves activeChatKey
    // onto it - the edited chat's work survived in the backend, but the UI
    // was suddenly pointing at a different chat.
    const wanted = this.activeChat?.chatId ?? '';
    const key = this.activeChatKey;
    await this.readHost();
    if (this.slot && this.character) {
      const chats = Array.isArray(this.character.chats) ? this.character.chats : [];
      const at = wanted ? chats.findIndex((c) => String(c?.id ?? '') === wanted) : -1;
      await this.upload(at < 0 ? { cardReset: true } : { cardReset: true, chatIndex: at });
      if (key && this.workspace?.chats.some((c) => c.chatKey === key)) this.activeChatKey = key;
    }
    this.epoch += 1;
    this.emit();
  }

  /**
   * The chat twin of rereadCard.
   *
   * It has to re-read the chat that was written, not whichever one RisuAI has
   * open: taking the live chat here would ingest a chat nobody edited and
   * leave the edited one holding a baseline one write behind.
   */
  private async rereadChat(): Promise<void> {
    const wanted = this.activeChat?.chatId ?? '';
    const key = this.activeChatKey;
    await this.readHost();
    if (this.slot && this.character) {
      const chats = Array.isArray(this.character.chats) ? this.character.chats : [];
      const at = wanted ? chats.findIndex((c) => String(c?.id ?? '') === wanted) : -1;
      await this.upload(at < 0 ? { chatReset: true } : { chatReset: true, chatIndex: at });
      if (key && this.workspace?.chats.some((c) => c.chatKey === key)) this.activeChatKey = key;
    }
    if (this.activeChatKey) await this.loadTurns();
    this.epoch += 1;
    this.emit();
  }

  /** Resolve local asset snapshots only when the user writes the card. */
  private async resolveStagedAssets(update: host.CardUpdate, progress: (text: string) => void, charKey = this.botKey): Promise<void> {
    const pending = new Set<string>();
    const collect = (value: unknown): void => {
      if (typeof value === 'string' && value.startsWith('assets/hina-pending-')) pending.add(value);
    };
    for (const row of update.emotionImages ?? []) if (Array.isArray(row)) collect(row[1]);
    for (const row of update.additionalAssets ?? []) if (Array.isArray(row)) collect(row[1]);
    for (const row of update.ccAssets ?? []) if (row && typeof row === 'object') collect((row as { uri?: unknown }).uri);
    // The profile picture (§1-66) is a scalar row whose text is the asset key.
    for (const f of update.fields ?? []) if (f.field === 'image') collect(f.after);
    const resolved = new Map<string, string>();
    let done = 0;
    if (pending.size) progress(`RisuAI 이미지 등록 0/${pending.size} · 카드 저장 대기`);
    await boundedAssets([...pending], async key => {
      const bytes = await transport.getBinary('/assets/blob', { key });
      const realKey = await Risuai.saveAsset(bytes);
      if (!realKey || typeof realKey !== 'string' || realKey.startsWith('assets/hina-pending-')) throw new Error('RisuAI가 에셋 저장 키를 반환하지 않았습니다. 미반영 변경은 보존됩니다.');
      resolved.set(key, realKey);
      await transport.post('/assets/adopt', { charKey, sourceKey: key, key: realKey });
      progress(`RisuAI 이미지 등록 ${++done}/${pending.size} · 카드 저장 대기`);
    });
    const replace = (value: unknown): unknown => typeof value === 'string' ? resolved.get(value) ?? value : value;
    if (update.fields) update.fields = update.fields.map(f => f.field === 'image' ? { ...f, after: String(replace(f.after)) } : f);
    if (update.emotionImages) update.emotionImages = update.emotionImages.map(row => Array.isArray(row) ? [row[0], replace(row[1]), ...row.slice(2)] : row);
    if (update.additionalAssets) update.additionalAssets = update.additionalAssets.map(row => Array.isArray(row) ? [row[0], replace(row[1]), ...row.slice(2)] : row);
    if (update.ccAssets) update.ccAssets = update.ccAssets.map(row => row && typeof row === 'object' ? { ...row, uri: replace((row as { uri?: unknown }).uri) } : row);
  }

  /**
   * 새 봇으로 저장: keep editing this bot, and keep what it was.
   *
   * The bot as RisuAI holds it now - the baseline, untouched by the working
   * copy - is cloned first as "<name> (백업)", chats included. Then the
   * working copy is written into the live bot and becomes its baseline, so
   * the workspace, snapshots and conversation carry on where they are. The
   * opposite (clone the edited card, leave the original) put the user in a
   * new bot with an empty workspace and the old one still pending.
   */
  async saveAsNewBot(backupName: string): Promise<{ backupChaId: string; applied: number; mode: string }> {
    return foregroundWrite(report => this.performSaveAsNewBot(backupName, report));
  }

  private async performSaveAsNewBot(backupName: string, progress: (text: string) => void): Promise<{ backupChaId: string; applied: number; mode: string }> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.cardPatch(this.activeCharKey);
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 저장할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    // No card update: the backup is the live card as it is.
    const family = this.workspace?.familyKey || this.activeCharKey;
    progress('기존 봇의 백업을 저장하는 중…');
    const backupChaId = await host.cloneBot(this.slot.characterIndex, patch.chaId, backupName, {}, family);
    const r = await this.performCardWriteBack(progress);
    if (!r.verified) {
      throw new Error('RisuAI 가 카드 쓰기를 받지 않았습니다'
        + (r.drift ? ` (${r.drift})` : '')
        + '. 백업 봇은 만들어졌지만 이 봇에는 반영되지 않았습니다 - 편집 내용은 그대로 있습니다.');
    }
    return { backupChaId, applied: r.applied, mode: r.mode };
  }

  /** Create a clone bot in RisuAI carrying the working card. */
  async cloneBot(name: string): Promise<string> {
    return foregroundWrite(report => this.performCloneBot(name, report));
  }

  private async performCloneBot(name: string, progress: (text: string) => void): Promise<string> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.cardPatch(this.activeCharKey);
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 복제할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    const update = this.cardUpdateFrom(patch, true) ?? {};
    await this.resolveStagedAssets(update, progress, this.activeCharKey);
    progress('이미지 준비 완료 · 복제 봇 저장 중…');
    // The clone shares this bot's workspace: it carries the family key.
    const family = this.workspace?.familyKey || this.activeCharKey;
    const chaId = await host.cloneBot(this.slot.characterIndex, patch.chaId, name, update, family);
    await this.cardCommit('복제 직전', this.activeCharKey);
    return chaId;
  }

}

/** A File as base64, without the data: prefix. */
async function fileBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) {
    bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export const state = new AppState();
export { BackendError };
