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
}

export interface WorkspaceInfo {
  /** The workspace shared with this bot's other versions ('' = its own). */
  familyKey?: string;
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
}

export interface Patch {
  chatKey: string;
  edits: { msgId: string; seq: number; before: string; after: string }[];
  added: { msgId: string; seq: number; role: string; after: string }[];
  removed: { msgId: string; seq: number; before: string }[];
  structural: boolean;
  reordered: boolean;
  messages?: RisuMessage[];
  warnings: string[];
  /** This chat's lorebook, whole, plus how much of it differs from RisuAI. */
  lore?: { localLore: unknown[]; changed: number; added: number; edited: number; deleted: number };
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
  warnings: string[];
}

export interface WriteBackResult {
  mode: 'noop' | 'edits' | 'replace';
  applied: number;
  lore: number;
  memory: number;
  warnings: string[];
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

export interface FileArea {
  area: string;
  /** Whether the panel may delete individual files here. */
  deletable: boolean;
  /** Whether 정리 empties it. original/ and uploads/ are never cleaned. */
  cleanable: boolean;
  count: number;
  size: number;
  files: WorkspaceFile[];
  /** Folders inside the area, empty ones included. */
  dirs?: string[];
}

export interface FileListing {
  charKey: string;
  root: string;
  totalSize: number;
  areas: FileArea[];
}

export interface AgentPreset {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
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

export interface CatalogModel {
  provider: string; id: string; name: string; reasoning: boolean; toolCall: boolean;
  context: number | null; output: number | null; costIn: number | null; costOut: number | null; releaseDate: string;
}
export interface CatalogProvider { id: string; name: string; api: string; doc: string; env: string[]; models: number }
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
  updatedAt: number;
}

export interface CardScript {
  id: string;
  kind: 'customscript' | 'triggerscript' | 'assetref';
  seq: number;
  origin: string;
  entry: Record<string, unknown>;
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
}

export interface CardPatch {
  charKey: string;
  chaId: string;
  full: boolean;
  fields: { field: string; before: string; after: string }[];
  alternateGreetings: { changed: boolean; list: string[] };
  globalLore: { changed: number; list: unknown[] };
  customscript: { changed: number; list: unknown[] };
  triggerscript: { changed: number; list: unknown[] };
  assetref: { changed: number; list: unknown[] };
  /** The asset references as RisuAI's three lists, rebuilt from the working rows. */
  assets: { changed: number; emotionImages: unknown[]; additionalAssets: unknown[]; ccAssets: unknown[] };
  total: number;
}

export interface BulkPreview {
  dryRun: boolean;
  matchedTurns: number;
  totalHits: number;
  applied: number;
  changes: { msgId: string; seq: number; role: string; hits: number; before: string; after: string }[];
}

class AppState {
  health: HealthInfo | null = null;
  connectError = '';

  slot: host.Slot | null = null;
  slotError = '';
  character: RisuCharacter | null = null;
  liveChat: RisuChat | null = null;

  workspace: WorkspaceInfo | null = null;
  /** Which half of the panel is open ('chat' | 'bot'); the shell keeps it current, the agent is told. */
  editMode: 'chat' | 'bot' = 'chat';
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
   * make the common case pay for the rare one.
   */
  async upload(opts: { allChats?: boolean; force?: boolean; cardReset?: boolean } = {}): Promise<WorkspaceInfo> {
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
      cardReset: Boolean(opts.cardReset),
    };
    if (opts.allChats) {
      payload.chats = chats.map((c, i) => ({ chat: c, chatIndex: i }));
    } else {
      payload.chats = [{ chat: this.liveChat, chatIndex: this.slot.chatIndex }];
    }
    const res = await transport.upload<{ workspace: WorkspaceInfo }>('/workspace', payload);
    this.workspace = res.workspace;
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
        this.emit();
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

  /** The files tab is showing; whatever was unseen has now been seen. */
  markOutputsSeen(): void {
    if (!this.unseenOutputs.length) return;
    this.unseenOutputs = [];
    this.emit();
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
  async commit(label: string): Promise<{ previousBaseline: number; newBaseline: number; lore: number; memory: number }> {
    const r = await transport.post<{ previousBaseline: number; newBaseline: number; lore: number; memory: number }>(
      '/commit', { chatKey: this.activeChatKey, label });
    this.bump();
    return r;
  }

  async reset(): Promise<void> {
    await transport.post('/reset', { chatKey: this.activeChatKey });
    await this.loadTurns();
    this.bump();
  }

  async checkpoint(label: string): Promise<void> {
    await transport.post('/checkpoint', { chatKey: this.activeChatKey, label });
  }

  async checkpoints(): Promise<{ id: string; label: string; message_count: number; created_at: number }[]> {
    const res = await transport.get<{ checkpoints: any[] }>('/checkpoints', { chatKey: this.activeChatKey });
    return res.checkpoints ?? [];
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
    if (!update) return { mode: 'noop', applied: 0, lore: 0, memory: 0, warnings: patch.warnings };
    const r = await host.writeChat(this.slot, this.liveChat?.id, update);
    return {
      mode: r.mode, applied: r.applied,
      lore: patch.lore?.changed ?? 0, memory: patch.memory?.changed ?? 0,
      warnings: patch.warnings,
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
    return Object.keys(update).length ? update : null;
  }

  async saveCopy(name: string): Promise<void> {
    if (!this.slot) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const patch = await this.patch();
    const update = this.updateFrom(patch, true) ?? {};
    if (!update.messages) update.messages = (await this.messagesFromExport()) ?? undefined;
    delete update.edits;
    await host.saveAsCopy(this.slot, update, name);
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
    yield* transport.stream('/chat', { sessionId: this.sessionId, prompt, mode: this.editMode }, signal);
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

  async testAgent(): Promise<Record<string, unknown>> {
    return await transport.post('/config/test', {}, 120_000);
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

  // --- workspace files ------------------------------------------------------
  //
  // Scoped to the character, not the chat: the workspace is per bot, and its
  // uploads and outputs are shared across that bot's chats.

  /** Save a workspace file to the user's disk through the browser. */
  async downloadFile(path: string): Promise<number> {
    const bytes = await transport.getBinary('/files/download', { charKey: this.activeCharKey, path });
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

  async files(): Promise<FileListing> {
    return await transport.get('/files?charKey=' + encodeURIComponent(this.activeCharKey));
  }

  async readFile(path: string): Promise<{ path: string; size: number; textual: boolean;
                                          content: string; truncated?: boolean; note?: string }> {
    return await transport.get('/files/read?charKey=' + encodeURIComponent(this.activeCharKey)
      + '&path=' + encodeURIComponent(path));
  }

  async uploadFile(name: string, content: string, base64 = false, dir = ''): Promise<{ path: string; size: number }> {
    return await transport.post('/files/upload', base64
      ? { charKey: this.activeCharKey, name, base64: content, dir }
      : { charKey: this.activeCharKey, name, text: content, dir });
  }

  async mkdirFile(path: string): Promise<void> {
    await transport.post('/files/mkdir', { charKey: this.activeCharKey, path });
  }

  async moveFile(from: string, to: string): Promise<{ to: string }> {
    return await transport.post('/files/move', { charKey: this.activeCharKey, from, to });
  }

  async deleteFile(path: string): Promise<void> {
    await transport.post('/files/delete', { charKey: this.activeCharKey, path });
  }

  async cleanFiles(areas?: string[]): Promise<{ areas: string[]; removed: number; freed: number }> {
    return await transport.post('/files/clean', { charKey: this.activeCharKey, areas });
  }

  // --- agent presets --------------------------------------------------------

  async presets(): Promise<{
    presets: AgentPreset[];
    selected: AgentPreset | null;
    selectedSearch: AgentPreset | null;
    kinds: string[];
    keys: ApiKeyEntry[];
    reasoningLevels: string[];
    keepSentinel: string;
    maxInstructions: number;
  }> {
    return await transport.get('/presets');
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

  /**
   * Approve or reject one proposal, and carry it out if it is ours to do.
   *
   * The backend runs what it can and hands back a `host` block for what it
   * cannot - writing to the live chat and saving a copy both need APIs that
   * only exist inside this iframe. The result is reported back either way, so
   * a failure here does not leave a queue entry claiming success.
   */
  async decideAction(id: string, approve: boolean): Promise<string> {
    const r = await transport.post('/actions/decide', {
      chatKey: this.activeChatKey, id, approve,
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
        detail = await this.applyAssetAction(r.host.kind, r.host.args ?? {});
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

  async cardReset(): Promise<void> {
    await transport.post('/card/reset', { charKey: this.botKey });
    this.bump();
    void this.refreshBotChanges();
  }

  async cardCheckpoint(label: string): Promise<void> {
    await transport.post('/card/checkpoint', { charKey: this.botKey, label });
  }

  async cardCheckpoints(): Promise<{ id: string; label: string; created_at: number }[]> {
    const r = await transport.get<{ checkpoints: any[] }>('/card/checkpoints', { charKey: this.botKey });
    return r.checkpoints ?? [];
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
    return Object.keys(update).length ? update : null;
  }

  /**
   * Push the working card into RisuAI and, on success, move the baseline.
   *
   * Unlike the chat flow (where the bar orchestrates write → commit), the
   * whole sequence lives here because two callers need it - the bot bar and
   * an approved host_card_writeback - and they must not drift apart.
   */
  async cardWriteBack(): Promise<{ applied: number; mode: string }> {
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
    if (!update) return { applied: 0, mode: 'noop' };
    const r = await host.writeCharacter(slot.characterIndex, patch.chaId, update);
    await this.cardCommit('반영 직전');
    await this.readHost();
    return { applied: r.applied, mode: r.mode };
  }

  /**
   * An approved asset proposal: bytes from the workspace -> RisuAI's asset
   * store (saveAsset, which names the key) -> the live card's reference
   * list -> the backend store under that key. Written to RisuAI at once,
   * unlike text: binary material has no working copy to stage in, and the
   * card re-upload afterwards makes the new reference the baseline.
   */
  private async applyAssetAction(kind: string, args: Record<string, unknown>): Promise<string> {
    if (!this.isLiveBot || !this.slot) {
      throw new Error('에셋을 넣으려면 RisuAI에서 이 봇이 선택되어 있어야 합니다');
    }
    const name = String(args.name || '').trim();
    const path = String(args.path || '');
    const field = String(args.field || 'additional');
    if (!name || !path) throw new Error('에셋 이름과 파일 경로가 필요합니다');
    const bytes = await transport.getBinary('/files/download', { charKey: this.activeCharKey, path });
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) throw new Error('PNG 파일만 에셋으로 넣을 수 있습니다');
    const key = await Risuai.saveAsset(bytes);
    if (!key || typeof key !== 'string') throw new Error('RisuAI 가 에셋 키를 돌려주지 않았습니다');

    const slot = await host.currentSlot();
    const fresh = await host.readCharacter(slot.characterIndex);
    const update: host.CardUpdate = {};
    let placed = '';
    if (kind === 'host_asset_add') {
      if (field === 'emotion') {
        const list = Array.isArray(fresh['emotionImages']) ? [...(fresh['emotionImages'] as unknown[])] : [];
        list.push([name, key]);
        update.emotionImages = list;
        placed = '감정 이미지';
      } else {
        const list = Array.isArray(fresh['additionalAssets']) ? [...(fresh['additionalAssets'] as unknown[])] : [];
        list.push([name, key, 'png']);
        update.additionalAssets = list;
        placed = '추가 에셋';
      }
    } else {
      // Replace: same name, new key, wherever the name lives. CBS references
      // the name, so nothing else in the card has to change.
      let hits = 0;
      const swap = (arr: unknown, at: number): unknown[] | null => {
        if (!Array.isArray(arr)) return null;
        const next = arr.map((e) => {
          if (Array.isArray(e) && String(e[0]) === name) { hits += 1; const c = [...e]; c[at] = key; return c; }
          return e;
        });
        return next;
      };
      const emo = swap(fresh['emotionImages'], 1);
      const add = swap(fresh['additionalAssets'], 1);
      const cc = Array.isArray(fresh['ccAssets'])
        ? (fresh['ccAssets'] as { name?: unknown; uri?: unknown }[]).map((c) => {
          if (c && typeof c === 'object' && String(c.name) === name) { hits += 1; return { ...c, uri: key }; }
          return c;
        })
        : null;
      if (!hits) throw new Error(`이름이 “${name}” 인 에셋이 카드에 없습니다`);
      if (emo) update.emotionImages = emo;
      if (add) update.additionalAssets = add;
      if (cc) update.ccAssets = cc;
      placed = `${hits}곳 교체`;
    }
    await host.writeCharacter(slot.characterIndex, fresh.chaId, update);
    try {
      await transport.post('/assets/adopt', { charKey: this.activeCharKey, key, path, name, field });
    } catch (e) {
      void clientLog('warn', 'assets/adopt failed', { error: String(e) });
    }
    // The card changed in RisuAI: re-read so the baseline (and the manifest)
    // carry the new reference, without disturbing the text working copy.
    await this.readHost();
    await this.upload();
    return `에셋 “${name}” 을 RisuAI 에 저장하고 카드에 붙였습니다 (${placed}, ${key}).`;
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
