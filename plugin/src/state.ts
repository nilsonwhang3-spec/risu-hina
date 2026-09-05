/** App state and every backend call the UI makes. */
import { transport, BackendError, clientLog, type HealthInfo } from './transport';
import * as host from './host';
import { syncAssets, syncBusy, describeSync, type SyncProgress, type SyncController } from './assets';
import type { RisuChat, RisuCharacter, RisuMessage } from './risuai';

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

export interface AgentSession {
  session: { sessionId: string; chatKey: string; title: string } | null;
  messages: { seq: number; role: string; content: unknown; cost: number | null;
              usage: Record<string, unknown> | null }[];
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

export interface CodexStatus {
  loggedIn: boolean; email: string; accountId: string; plan: string; expiresAt: number;
  pending: boolean; listening: boolean; models: string[]; base: string; redirectUri: string;
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
export interface SelectionState { use: boolean; inpaint: boolean; delete: boolean; rep?: boolean }
export type SelectionMap = Record<string, SelectionState>;

export interface GroupItem {
  filename: string;
  path: string;
  fields?: Record<string, string>;
  selection: SelectionState;
}

export interface StudioGroups {
  folder: string;
  pattern: string;
  groupBy: string;
  fields: string[];
  groups: { key: string; items: GroupItem[] }[];
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
}

export interface BatchEstimate {
  images: number; vibeEncodes: number; anlasCertain: number; note: string;
}

export interface StudioJob {
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
  async jobPreview(id: string, since: number): Promise<{
    rev?: number; step?: number; total?: number; current?: string; png?: string;
  }> {
    return await transport.get('/studio/job/preview', { id, since: String(since) });
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

  async saveSelection(folder: string, selections: SelectionMap): Promise<void> {
    await transport.post('/studio/selection', { folder, selections });
  }

  async renamePlan(folder: string, rename: { from: string; to: string }[]): Promise<{
    rename: { from: string; to: string }[];
    problems: { from: string; to: string; why: string }[];
  }> {
    return await transport.post('/studio/rename', { folder, rename });
  }

  async exportSelected(folder: string, character: string, pattern = '', groupBy = 'emotion'): Promise<{
    folder: string; used: number; inpaint: number; empty: number;
    groups: number; unmatched: number;
  }> {
    return await transport.post('/studio/export', { folder, character, pattern, groupBy });
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
  editMode: 'chat' | 'bot' = 'bot';
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
    return this.activeCharKey;
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
    this.slotError = '';
    try {
      this.slot = await host.currentSlot();
      this.character = await host.readCharacter(this.slot.characterIndex);
      this.liveChat = await host.readChat(this.slot);
      return true;
    } catch (e) {
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
    this.assetSyncCtl = syncAssets(char, ck, {
      hubPull: web,
      concurrency: web ? 4 : 6,
    }, (p) => {
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
    const res = await transport.get<{ total: number; turns: Turn[] }>(
      '/turns', { chatKey, start, limit },
    );
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
    try {
      this.changes = await transport.get<Changes>('/changes', { chatKey: this.activeChatKey });
    } catch {
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

  requestOpenFile(path: string): void {
    this.openFileRequest = path;
    this.emit();
  }

  /** The agent (or a strip in the chat) asked for the studio's 검수 tab on
   * a folder: the shell switches tabs, the studio consumes the folder. */
  openStudioRequest: { folder: string } | null = null;
  requestOpenStudio(folder: string): void {
    this.openStudioRequest = { folder };
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
    if (!this.activeCharKey) return null;
    try {
      return await transport.get<DirtySummary>('/workspace/dirty', { charKey: this.activeCharKey });
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

  async agentSession(sessionId?: string): Promise<AgentSession> {
    const r = await transport.get<AgentSession>('/session', {
      chatKey: this.activeChatKey,
      sessionId: sessionId || undefined,
    });
    this.sessionId = r.session?.sessionId ?? '';
    return r;
  }

  async agentSessions(): Promise<AgentSessionInfo[]> {
    const r = await transport.get<{ sessions: AgentSessionInfo[] }>('/sessions', {
      chatKey: this.activeChatKey,
    });
    return r.sessions ?? [];
  }

  /** Start a fresh conversation; the previous one stays in the history list. */
  async newAgentSession(): Promise<void> {
    const r = await transport.post<{ sessionId: string }>('/session', { chatKey: this.activeChatKey });
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
      const r = await transport.post<{ sessionId: string }>('/session', { chatKey: this.activeChatKey });
      this.sessionId = r.sessionId;
    }
    yield* transport.stream('/chat', {
      sessionId: this.sessionId, prompt,
      mode: this.activeTab === 'studio' ? 'studio' : this.editMode,
    }, signal);
  }

  // --- merge conflicts ------------------------------------------------------

  /** Rows where our copy and RisuAI's both moved since the last open. */
  async conflicts(scope: 'chat' | 'card' | 'both' = 'both'): Promise<ConflictItem[]> {
    const q: Record<string, string> = {};
    if (scope !== 'card' && this.activeChatKey) q.chatKey = this.activeChatKey;
    if (scope !== 'chat' && this.activeCharKey) q.charKey = this.activeCharKey;
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
      ...(scope === 'chat' ? { chatKey: this.activeChatKey } : { charKey: this.activeCharKey }),
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
    newer?: boolean; notes?: string; installable?: boolean; reason?: string | null;
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

  /** Save a space file to the user's disk through the browser. */
  async downloadFile(path: string): Promise<number> {
    const bytes = await transport.postBinary('/files/download', { path });
    const name = path.split('/').pop() || 'file';
    host.downloadBytes(name, bytes, name.endsWith('.charx') ? 'application/zip' : 'application/octet-stream');
    return bytes.byteLength;
  }

  // --- charx ------------------------------------------------------------------

  async charxPreview(): Promise<CharxPreview> {
    return await transport.get('/charx/preview', { charKey: this.botKey });
  }

  /** Build out/<name>.charx on the backend from the working card + store. */
  async charxBuild(opts: { allowMissing?: boolean; name?: string } = {}): Promise<CharxBuilt> {
    const r = await transport.post<CharxBuilt>('/charx/build', {
      charKey: this.botKey, allowMissing: !!opts.allowMissing, name: opts.name || '',
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
    const r = await transport.get<FileListing | null>('/files' + (q.length ? '?' + q.join('&') : ''));
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
    return await transport.upload('/files/upload', base64
      ? { name, base64: content, dir, extract }
      : { name, text: content, dir });
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
    const bytes = await transport.postBinary('/files/zip', { paths, name });
    host.downloadBytes(name.endsWith('.zip') ? name : name + '.zip', bytes, 'application/zip');
    return bytes.byteLength;
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

  // --- OpenAI subscription (codex) login -----------------------------------------

  async codexStatus(): Promise<CodexStatus> {
    return await transport.get('/codex/status');
  }

  async codexLoginStart(): Promise<{ url: string; state: string; listening: boolean; redirectUri: string }> {
    return await transport.post('/codex/login/start', {});
  }

  async codexLoginStatus(state: string): Promise<{ known: boolean; done: boolean; error: string; loggedIn?: boolean }> {
    return await transport.get('/codex/login/status', { state });
  }

  async codexLoginComplete(redirect: string, state = ''): Promise<CodexStatus> {
    return await transport.post('/codex/login/complete', { redirect, state });
  }

  async codexLogout(): Promise<void> {
    await transport.post('/codex/logout', {});
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
    const r = await transport.get(
      '/actions?charKey=' + encodeURIComponent(this.activeCharKey)) as { actions: PendingAction[] };
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
  async decideAction(id: string, approve: boolean, chatKey = ''): Promise<string> {
    const r = await transport.post('/actions/decide', {
      chatKey: chatKey || this.activeChatKey, id, approve,
    }) as { approved: boolean; result?: string; host?: { kind: string; args: Record<string, any> } };

    if (!r.approved) return '거절했습니다.';
    if (!r.host) {
      // A lorebook or memory proposal just landed in the working copy; the
      // tabs caching those lists and the shared bar both have to hear it.
      this.bump();
      void this.refreshChanges();
      return String(r.result ?? '실행했습니다.');
    }

    try {
      let detail = '';
      if (r.host.kind === 'host_writeback') {
        const out = await this.writeBack();
        detail = `${out.applied}건을 RisuAI에 반영했습니다.`;
      } else if (r.host.kind === 'host_save_copy') {
        const name = String(r.host.args?.name || '') || '사본';
        await this.saveCopy(name);
        detail = `“${name}” 으로 복사본을 저장했습니다.`;
      } else if (r.host.kind === 'host_card_writeback') {
        const out = await this.cardWriteBack();
        detail = out.mode === 'noop'
          ? '카드에 반영할 변경이 없었습니다.'
          : `카드 변경 ${out.applied}건을 RisuAI에 반영했습니다.`;
      } else if (r.host.kind === 'host_clone_bot') {
        const name = String(r.host.args?.name || '') || '복제 봇';
        await this.cloneBot(name);
        detail = `복제 봇 “${name}” 을 만들었습니다. RisuAI 목록에서 확인해 주세요.`;
      } else if (r.host.kind === 'host_open_tab') {
        const tab = String(r.host.args?.tab || '');
        this.openTabRequest = tab;
        this.emit();
        detail = '탭을 이동했습니다.';
      } else if (r.host.kind === 'host_asset_add' || r.host.kind === 'host_asset_replace') {
        detail = await this.applyAssetActions(r.host.kind, [r.host.args ?? {}]);
      } else if (r.host.kind === 'host_asset_add_many') {
        const items = Array.isArray(r.host.args?.items) ? (r.host.args.items as Record<string, unknown>[]) : [];
        detail = await this.applyAssetActions('host_asset_add', items);
      } else {
        throw new Error('플러그인이 모르는 작업입니다: ' + r.host.kind);
      }
      await transport.post('/actions/complete', { chatKey: this.activeChatKey, id, ok: true, detail });
      return detail;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      await transport.post('/actions/complete', {
        chatKey: this.activeChatKey, id, ok: false, detail: why,
      });
      throw e;
    }
  }

  // --- lorebook -------------------------------------------------------------

  async lore(scope?: 'global' | 'local'): Promise<LoreEntry[]> {
    const q = '/lore?charKey=' + encodeURIComponent(this.activeCharKey)
      + (scope ? '&scope=' + scope : '');
    const r = await transport.get(q) as { lore: LoreEntry[] };
    return r.lore;
  }

  async saveLore(id: string, entry: Record<string, unknown>): Promise<void> {
    await transport.post('/lore/update', { charKey: this.activeCharKey, id, entry });
    void this.refreshChanges();
  }

  async addLore(entry: Record<string, unknown>, scope: 'global' | 'local'): Promise<string> {
    const r = await transport.post('/lore', {
      charKey: this.activeCharKey, entry, scope,
      chatKey: scope === 'local' ? this.activeChatKey : undefined,
    }) as { id: string };
    void this.refreshChanges();
    return r.id;
  }

  async deleteLore(id: string): Promise<void> {
    await transport.post('/lore/delete', { charKey: this.activeCharKey, id });
    void this.refreshChanges();
  }

  async moveLore(id: string, toSeq: number): Promise<void> {
    await transport.post('/lore/move', { charKey: this.activeCharKey, id, toSeq });
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
    try {
      this.botChanges = await transport.get<CardChanges>('/card/changes', { charKey: this.botKey });
    } catch {
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

  async cardPatch(): Promise<CardPatch> {
    return await transport.get<CardPatch>('/card/patch', { charKey: this.botKey });
  }

  async cardCommit(label: string): Promise<void> {
    await transport.post('/card/commit', { charKey: this.botKey, label });
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
  async cardWriteBack(): Promise<{ applied: number; mode: string; verified: boolean; drift?: string }> {
    if (!this.isLiveBot) {
      throw new Error('반영은 RisuAI에서 이 봇이 선택되어 있어야 합니다. '
        + 'RisuAI에서 봇을 선택한 뒤 패널을 다시 열어 주세요');
    }
    const slot = await host.currentSlot();
    const patch = await this.cardPatch();
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 반영할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    const update = this.cardUpdateFrom(patch, false);
    if (!update) return { applied: 0, mode: 'noop', verified: true };
    const r = await host.writeCharacter(slot.characterIndex, patch.chaId, update);
    if (!r.verified) {
      // No commit and no re-read: the re-read is what used to replace the
      // working copy with the text the write had just failed to change.
      return { applied: r.applied, mode: r.mode, verified: false, ...(r.drift ? { drift: r.drift } : {}) };
    }
    await this.cardCommit('반영 직전');
    await this.rereadCard();
    return { applied: r.applied, mode: r.mode, verified: true };
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

  /**
   * Approved asset proposals: bytes from the workspace -> RisuAI's asset
   * store (saveAsset, which names the key) -> the live card's reference
   * list -> the backend store under that key. Written to RisuAI at once,
   * unlike text: binary material has no working copy to stage in, and the
   * card re-upload afterwards makes the new reference the baseline.
   *
   * MANY items ride ONE host read, ONE card write and ONE re-upload: 37
   * additions used to be 37 host round trips and 37 card uploads, each of
   * which also restarted the asset sync - that is the "hangs at the 20s
   * mark" the user saw, the sync being cancelled and restarted under load.
   */
  private async applyAssetActions(kind: string, list: Record<string, unknown>[]): Promise<string> {
    if (!this.isLiveBot || !this.slot) {
      throw new Error('에셋을 넣으려면 RisuAI에서 이 봇이 선택되어 있어야 합니다');
    }
    if (!list.length) throw new Error('넣을 에셋이 없습니다');
    const t0 = Date.now();
    // 1. Bytes in, keys out - one saveAsset per image (the host names keys).
    const saved: { name: string; path: string; field: string; key: string }[] = [];
    const failed: string[] = [];
    for (const args of list) {
      const name = String(args.name || '').trim();
      const path = String(args.path || '');
      const field = String(args.field || 'additional');
      if (!name || !path) { failed.push(`${name || path}: 이름/경로 없음`); continue; }
      try {
        const bytes = await transport.getBinary('/files/download', { path });
        if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) throw new Error('PNG 파일만 에셋으로 넣을 수 있습니다');
        const key = await Risuai.saveAsset(bytes);
        if (!key || typeof key !== 'string') throw new Error('RisuAI 가 에셋 키를 돌려주지 않았습니다');
        saved.push({ name, path, field, key });
      } catch (e) {
        failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        void clientLog('warn', 'asset save failed', { name, path, error: String(e) });
      }
    }
    if (!saved.length) throw new Error('에셋을 하나도 저장하지 못했습니다: ' + failed.join('; '));

    // 2. One card update carrying every reference.
    const slot = await host.currentSlot();
    const fresh = await host.readCharacter(slot.characterIndex);
    const update: host.CardUpdate = {};
    let placed = '';
    if (kind === 'host_asset_add') {
      const emo = Array.isArray(fresh['emotionImages']) ? [...(fresh['emotionImages'] as unknown[])] : [];
      const add = Array.isArray(fresh['additionalAssets']) ? [...(fresh['additionalAssets'] as unknown[])] : [];
      let nEmo = 0;
      let nAdd = 0;
      for (const s of saved) {
        if (s.field === 'emotion') { emo.push([s.name, s.key]); nEmo += 1; }
        else { add.push([s.name, s.key, 'png']); nAdd += 1; }
      }
      if (nEmo) update.emotionImages = emo;
      if (nAdd) update.additionalAssets = add;
      placed = [nEmo ? `감정 이미지 ${nEmo}` : '', nAdd ? `추가 에셋 ${nAdd}` : ''].filter(Boolean).join(' · ');
    } else {
      // Replace: same name, new key, wherever the name lives. CBS references
      // the name, so nothing else in the card has to change.
      const keyOf = new Map(saved.map((s) => [s.name, s.key]));
      let hits = 0;
      const swap = (arr: unknown, at: number): unknown[] | null => {
        if (!Array.isArray(arr)) return null;
        return arr.map((e) => {
          if (Array.isArray(e) && keyOf.has(String(e[0]))) { hits += 1; const c = [...e]; c[at] = keyOf.get(String(e[0])); return c; }
          return e;
        });
      };
      const emo = swap(fresh['emotionImages'], 1);
      const add = swap(fresh['additionalAssets'], 1);
      const cc = Array.isArray(fresh['ccAssets'])
        ? (fresh['ccAssets'] as { name?: unknown; uri?: unknown }[]).map((c) => {
          if (c && typeof c === 'object' && keyOf.has(String(c.name))) { hits += 1; return { ...c, uri: keyOf.get(String(c.name)) }; }
          return c;
        })
        : null;
      if (!hits) throw new Error(`이름이 “${saved.map((s) => s.name).join(', ')}” 인 에셋이 카드에 없습니다`);
      if (emo) update.emotionImages = emo;
      if (add) update.additionalAssets = add;
      if (cc) update.ccAssets = cc;
      placed = `${hits}곳 교체`;
    }
    const w = await host.writeCharacter(slot.characterIndex, fresh.chaId, update);
    // A resolved write is not a kept write (the save encoder may skip it).
    // Unverified = the action fails, and nothing downstream pretends otherwise.
    if (!w.verified) {
      throw new Error('카드에 에셋이 반영되지 않았습니다: ' + (w.drift || '재확인 실패'));
    }
    // 3. The backend store learns the keys (one call per item is fine: these
    // are small and the store is local).
    for (const s of saved) {
      try {
        await transport.post('/assets/adopt', { charKey: this.activeCharKey, key: s.key, path: s.path, name: s.name, field: s.field });
      } catch (e) {
        void clientLog('warn', 'assets/adopt failed', { name: s.name, error: String(e) });
      }
    }
    // 4. The card changed in RisuAI: re-read ONCE so the baseline (and the
    // manifest) carry the new references, without disturbing the text
    // working copy.
    await this.readHost();
    await this.upload();
    void clientLog('info', 'assets applied', { kind, saved: saved.length, failed: failed.length, ms: Date.now() - t0 });
    const head = saved.length === 1
      ? `에셋 “${saved[0].name}” 을 RisuAI 에 저장하고 카드에 붙였습니다 (${placed}, ${saved[0].key}).`
      : `에셋 ${saved.length}건을 RisuAI 에 저장하고 카드에 한 번에 붙였습니다 (${placed}).`;
    return head + (failed.length ? ` 실패 ${failed.length}건: ${failed.slice(0, 5).join('; ')}` : '');
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
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.cardPatch();
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 저장할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    // No card update: the backup is the live card as it is.
    const family = this.workspace?.familyKey || this.activeCharKey;
    const backupChaId = await host.cloneBot(this.slot.characterIndex, patch.chaId, backupName, {}, family);
    const r = await this.cardWriteBack();
    if (!r.verified) {
      throw new Error('RisuAI 가 카드 쓰기를 받지 않았습니다'
        + (r.drift ? ` (${r.drift})` : '')
        + '. 백업 봇은 만들어졌지만 이 봇에는 반영되지 않았습니다 - 편집 내용은 그대로 있습니다.');
    }
    return { backupChaId, applied: r.applied, mode: r.mode };
  }

  /** Create a clone bot in RisuAI carrying the working card. */
  async cloneBot(name: string): Promise<string> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.cardPatch();
    if (!patch.full) {
      throw new Error('구버전 업로드 상태의 카드라 복제할 수 없습니다. 패널을 닫았다 다시 열어 주세요');
    }
    const update = this.cardUpdateFrom(patch, true) ?? {};
    // The clone shares this bot's workspace: it carries the family key.
    const family = this.workspace?.familyKey || this.activeCharKey;
    const chaId = await host.cloneBot(this.slot.characterIndex, patch.chaId, name, update, family);
    await this.cardCommit('복제 직전');
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
