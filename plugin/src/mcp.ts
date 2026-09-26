/**
 * The panel's half of MCP (backend: mcpbridge.py / mcpserver.py).
 *
 * An MCP client (Claude Code) talks to the backend's `/mcp` directly, but the
 * backend only lets it act while a panel holds the door open: 'MCP 활성화' on
 * the picker starts a long poll that tells the backend which bot and chat are
 * open here, and carries back the one thing only this iframe can do - the
 * requested card save to RisuAI.
 *
 * Why a long poll and not an interval: a hidden or occluded RisuAI tab gets
 * its timers throttled to about once a minute, which would drop the lease the
 * moment the user switches to their terminal. A fetch that the backend holds
 * for 20s and that is re-issued as soon as it returns involves no timer.
 *
 * Deliberately not persisted: after a plugin reload the switch is off again,
 * so a panel nobody is watching never keeps granting a remote client access.
 */
import { transport } from './transport';
import { state } from './state';

export interface McpAddonStatus {
  installed: boolean;
  version: string;
  wanted: string;
  loaded: boolean;
  loadError: string;
  reinstallNeeded: boolean;
  removalPending?: boolean;
  path: string;
  python: string;
  job: { running: boolean; startedAt: number; finishedAt: number; ok: boolean | null; output: string; error: string };
}

export interface McpBridgeStatus {
  enabled: boolean;
  active: boolean;
  mounted: boolean;
  calls: number;
  lastCall: { tool: string; at: number; ok: boolean } | null;
  clientName: string;
}

interface PollReply {
  enabled: boolean;
  jobs: { type: string; id: string; charKey: string; chatKey: string }[];
  pending?: { actions: number; staged: number; rev: string };
  lastCall?: McpBridgeStatus['lastCall'];
  calls?: number;
}

const POLL_TIMEOUT_MS = 40_000;
const RETRY_MS = 3_000;

class McpBridge {
  on = false;
  error = '';
  calls = 0;
  lastCall: McpBridgeStatus['lastCall'] = null;
  private pendingRev = '';
  private loopId = 0;
  private listeners = new Set<() => void>();
  /** Called when a poll reports that the proposal queue changed. */
  onPendingChanged: () => void = () => { /* set by the agent pane */ };
  /** Where a finished host job is announced (a toast, set by the shell). */
  onNotice: (text: string, kind: 'ok' | 'err' | '') => void = () => { /* none yet */ };

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) { try { fn(); } catch { /* one listener must not stop the rest */ } }
  }

  /** Whether the backend has the add-on loaded and /mcp mounted. */
  get available(): boolean {
    return !!state.health?.mcp?.mounted;
  }

  async status(): Promise<{ addon: McpAddonStatus; bridge: McpBridgeStatus }> {
    return await transport.post('/mcp/status', {}) as { addon: McpAddonStatus; bridge: McpBridgeStatus };
  }

  async install(): Promise<{ started: boolean; reason?: string }> {
    return await transport.post('/mcp/install', {}) as { started: boolean; reason?: string };
  }

  async uninstall(): Promise<{ removed: boolean; restartNeeded?: boolean; reason?: string }> {
    if (this.on) await this.deactivate();
    return await transport.post('/mcp/uninstall', {}) as { removed: boolean; restartNeeded?: boolean; reason?: string };
  }

  async token(rotate = false): Promise<string> {
    const r = await transport.post('/mcp/token', rotate ? { rotate: true } : {}) as { token: string };
    return r.token;
  }

  context(): Record<string, string> {
    const chat = state.workspace?.chats.find((c) => c.chatKey === state.activeChatKey);
    return {
      charKey: state.activeCharKey || '',
      chatKey: state.activeChatKey || '',
      botName: state.workspace?.characterName || String(state.character?.name || ''),
      chatName: chat?.name || '',
      mode: state.activeTab === 'chats' ? '' : (state.activeTab === 'studio' ? 'studio' : state.editMode),
    };
  }

  async activate(): Promise<void> {
    this.error = '';
    await transport.post('/mcp/bridge/activate', { context: this.context() });
    this.on = true;
    this.changed();
    void this.loop(++this.loopId);
  }

  async deactivate(): Promise<void> {
    this.on = false;
    this.loopId++;
    this.changed();
    try {
      await transport.post('/mcp/bridge/deactivate', {});
    } catch { /* the lease runs out on its own */ }
  }

  private async loop(id: number): Promise<void> {
    while (this.on && id === this.loopId) {
      try {
        const r = await transport.post('/mcp/bridge/poll',
          { context: { ...this.context(), pendingRev: this.pendingRev } }, POLL_TIMEOUT_MS) as PollReply;
        if (id !== this.loopId) return;
        if (!r.enabled) {
          // The backend restarted or someone else switched it off.
          this.on = false;
          this.error = '백엔드에서 MCP 가 꺼졌습니다. 다시 켜 주세요.';
          this.changed();
          return;
        }
        const hadError = !!this.error;
        this.error = '';
        const callsMoved = (r.calls ?? 0) !== this.calls;
        this.calls = r.calls ?? this.calls;
        this.lastCall = r.lastCall ?? this.lastCall;
        const rev = r.pending?.rev ?? '';
        if (rev !== this.pendingRev) {
          const first = this.pendingRev === '';
          this.pendingRev = rev;
          if (!first) this.onPendingChanged();
        }
        for (const job of r.jobs || []) await this.run(job);
        if (hadError || callsMoved) this.changed();
      } catch (e) {
        if (id !== this.loopId) return;
        this.error = e instanceof Error ? e.message : String(e);
        this.changed();
        await new Promise((res) => setTimeout(res, RETRY_MS));
      }
    }
  }

  private async run(job: PollReply['jobs'][number]): Promise<void> {
    if (job.type !== 'card-writeback') return;
    try {
      const said = await state.requestedCardWriteback(job.id, job.charKey, job.chatKey);
      this.onNotice('MCP 요청으로 반영: ' + said, 'ok');
      this.onPendingChanged();
    } catch (e) {
      this.onNotice('MCP 요청 반영 실패: ' + (e instanceof Error ? e.message : String(e)), 'err');
    }
  }
}

export const mcp = new McpBridge();

// The bot/chat the MCP client acts on must follow the panel at once, not at
// the next poll (which the backend may hold for 20s): a changed context is
// sent on its own. `activate` doubles as "update the context".
let sentContext = '';
state.onChange(() => {
  if (!mcp.on) { sentContext = ''; return; }
  const ctx = mcp.context();
  const key = JSON.stringify(ctx);
  if (key === sentContext) return;
  sentContext = key;
  void transport.post('/mcp/bridge/activate', { context: ctx }).catch(() => { sentContext = ''; });
});
