/** App state and every backend call the UI makes. */
import { transport, BackendError, type HealthInfo } from './transport';
import * as host from './host';
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
  memory: { changed: number; total: number; entries: number };
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
  /** Exactly one preset carries this, and it is what the agent runs. */
  selected?: boolean;
  updatedAt: number;
}

export interface Skill {
  id: string;
  name: string;
  body: string;
  enabled: boolean;
  sortOrder: number;
  /** 'md' goes into the prompt; 'script' is written into the workspace. */
  kind: 'md' | 'script' | 'reference';
  filename: string;
  updatedAt: number;
}

export interface SkillListing {
  skills: Skill[];
  usedChars: number;
  limitChars: number;
  maxBodyChars: number;
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
  activeChatKey = '';
  turns: Turn[] = [];
  totalTurns = 0;
  warnings: string[] = [];
  changes: Changes | null = null;
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
      try { fn(); } catch (e) { console.log('[risu-elf] listener failed', e); }
    }
  }

  get activeChat(): ChatInfo | null {
    return this.workspace?.chats.find((c) => c.chatKey === this.activeChatKey) ?? null;
  }

  /** The workspace is per bot, so file and upload calls address the character. */
  get activeCharKey(): string {
    return this.workspace?.charKey ?? '';
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
  async upload(opts: { allChats?: boolean; force?: boolean } = {}): Promise<WorkspaceInfo> {
    if (!this.slot || !this.character) throw new Error('호스트 상태를 먼저 읽어야 합니다');
    const chats = Array.isArray(this.character.chats) ? this.character.chats : [];
    const payload: Record<string, unknown> = {
      charId: this.character.chaId ?? '',
      characterIndex: this.slot.characterIndex,
      card: host.cardOf(this.character),
      force: Boolean(opts.force),
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
    return res.workspace;
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
  async *agentChat(prompt: string): AsyncGenerator<unknown> {
    if (!this.sessionId) {
      const r = await transport.post<{ sessionId: string }>('/session', { chatKey: this.activeChatKey });
      this.sessionId = r.sessionId;
    }
    yield* transport.stream('/chat', { sessionId: this.sessionId, prompt });
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

  async files(): Promise<FileListing> {
    return await transport.get('/files?charKey=' + encodeURIComponent(this.activeCharKey));
  }

  async readFile(path: string): Promise<{ path: string; size: number; textual: boolean;
                                          content: string; truncated?: boolean; note?: string }> {
    return await transport.get('/files/read?charKey=' + encodeURIComponent(this.activeCharKey)
      + '&path=' + encodeURIComponent(path));
  }

  async uploadFile(name: string, content: string, base64 = false): Promise<{ path: string; size: number }> {
    return await transport.post('/files/upload', base64
      ? { charKey: this.activeCharKey, name, base64: content }
      : { charKey: this.activeCharKey, name, text: content });
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

  // --- skills ---------------------------------------------------------------

  async skills(): Promise<SkillListing> {
    return await transport.get('/skills');
  }

  async saveSkill(v: {
    id?: string; name: string; body: string; enabled?: boolean;
    kind?: 'md' | 'script' | 'reference'; filename?: string;
  }): Promise<Skill> {
    const r = await transport.post('/skills/save', v) as { skill: Skill };
    return r.skill;
  }

  /** Register a file as a skill. The extension decides whether it is a script. */
  async uploadSkill(filename: string, body: string): Promise<Skill> {
    const r = await transport.post('/skills/upload', { filename, body }) as { skill: Skill };
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

}

export const state = new AppState();
export { BackendError };
