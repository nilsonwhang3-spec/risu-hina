/**
 * Everything that leaves the sandbox goes through here.
 *
 * The plugin iframe runs under `connect-src 'none'` (measured in Phase 0 -
 * `fetch()` fails with "Failed to fetch"), so `Risuai.nativeFetch` is the only
 * door. Two request options are load-bearing and are set here once rather than
 * at every call site:
 *
 *   networkRoute: 'local_network'  - without it the browser tries a direct
 *       fetch to a private address first and only falls back to /proxy2 after
 *       it fails. Measured cost: ~2.3s to first byte, every request.
 *   no `interceptor`              - setting it to 'openai_streaming' is what
 *       selects PocketRisu's WebSocket proxy-job path, which batched the first
 *       four chunks of a stream together. Plain /proxy2 streams correctly.
 *
 * Token handling implements the leak guard from the plan (section 7.1): on web
 * RisuAI, `nativeFetch` relays through https://sv.risuai.xyz/proxy2 unless the
 * user enabled "plain fetch", and our Authorization header would go with it.
 * The plugin cannot read that setting (`usePlainFetch` is not in allowedDbKeys),
 * so the connection is probed with an unauthenticated /health first and the
 * token is only attached once the backend's own signature comes back.
 */

export interface Config {
  url: string;
  token: string;
}

export interface HealthInfo {
  service: string;
  version: string;
  agentReady: boolean;
  clientIp?: string;
  loopback?: boolean;
  tokenRequired?: boolean;
  workspaces?: number;
}

export type RouteKind = 'unknown' | 'direct' | 'blocked';

export class BackendError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'BackendError';
  }
}

const SIGNATURE = 'risu-hina';
// What the backend called itself before the rename. Accepted on the client
// because the plugin updates first: for one session a new plugin talks to an
// old backend, and refusing the handshake there would look like the backend
// being down rather than merely older.
const LEGACY_SIGNATURES = new Set(['risu-elf', 'real-ooc']);
const DEFAULT_TIMEOUT_MS = 20_000;
/** Uploading a whole transcript is slow; a 394-turn chat is several MB. */
const UPLOAD_TIMEOUT_MS = 180_000;

export class Transport {
  private cfg: Config = { url: '', token: '' };
  private platform: 'node' | 'tauri' | 'web' | 'unknown' = 'unknown';
  private route: RouteKind = 'unknown';
  private lastHealth: HealthInfo | null = null;
  private tokenSafe = false;

  configure(cfg: Config): void {
    const url = (cfg.url || '').trim().replace(/\/+$/, '');
    if (url !== this.cfg.url) {
      // A different backend has to re-earn the right to see the token.
      this.tokenSafe = false;
      this.route = 'unknown';
      this.lastHealth = null;
    }
    this.cfg = { url, token: (cfg.token || '').trim() };
  }

  get config(): Config { return { ...this.cfg }; }
  get health(): HealthInfo | null { return this.lastHealth; }
  get routeKind(): RouteKind { return this.route; }
  get hostPlatform(): string { return this.platform; }
  get tokenAttached(): boolean { return this.tokenSafe; }

  async detectPlatform(): Promise<void> {
    try {
      const info = await Risuai.getRuntimeInfo();
      this.platform = info?.platform ?? 'unknown';
    } catch {
      this.platform = 'unknown';
    }
  }

  /**
   * Confirm we are talking to our own backend directly, then allow the token.
   *
   * `/health` is auth-exempt on purpose so this probe needs no credential. A
   * hub relay cannot reach a private address, so a correct signature coming
   * back is what proves the path is direct.
   */
  async connect(): Promise<HealthInfo> {
    if (!this.cfg.url) throw new BackendError(0, '백엔드 URL이 설정되어 있지 않습니다');
    if (this.platform === 'unknown') await this.detectPlatform();

    const res = await this.raw('GET', '/health', undefined, { withToken: false });
    const body = (await readJson(res)) as HealthInfo | null;
    if (!body || (body.service !== SIGNATURE && !LEGACY_SIGNATURES.has(String(body.service)))) {
      this.route = 'blocked';
      this.tokenSafe = false;
      throw new BackendError(
        res.status,
        this.platform === 'web'
          ? '백엔드에 직접 닿지 않습니다. RisuAI 설정에서 Use Plain Fetch를 켜 주세요 ' +
            '(끄면 요청이 sv.risuai.xyz로 릴레이되어 토큰이 새고, 사설 주소에는 닿지도 않습니다)'
          : '백엔드 응답이 Risu Hina의 것이 아닙니다',
        body,
      );
    }
    this.route = 'direct';
    this.tokenSafe = true;
    this.lastHealth = body;
    return body;
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return this.json<T>('GET', path + qs, undefined);
  }

  async post<T = unknown>(path: string, payload: unknown, timeoutMs?: number): Promise<T> {
    return this.json<T>('POST', path, payload, timeoutMs);
  }

  /** POST of something transcript-sized; longer timeout, same path otherwise. */
  async upload<T = unknown>(path: string, payload: unknown): Promise<T> {
    return this.json<T>('POST', path, payload, UPLOAD_TIMEOUT_MS);
  }

  /** GET that answers bytes, not JSON - a charx, an image out of the store. */
  async getBinary(path: string, query?: Record<string, string | number | undefined>): Promise<Uint8Array> {
    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const res = await this.raw('GET', path + qs, undefined, { timeoutMs: UPLOAD_TIMEOUT_MS });
    if (!res.ok) throw await toError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * NDJSON stream. Yields one parsed object per line as it arrives.
   *
   * Phase 0 measured first-byte at ~289ms and lines arriving at the server's
   * own cadence over this path, so the agent panel can render progressively.
   */
  async *stream(path: string, payload: unknown, signal?: AbortSignal): AsyncGenerator<unknown> {
    const res = await this.raw('POST', path, payload, { timeoutMs: 0, signal });
    if (!res.ok) throw await toError(res);
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      // Fall back to reading it whole rather than failing the turn outright.
      const text = await res.text();
      for (const line of text.split('\n')) {
        const v = parseLine(line);
        if (v !== undefined) yield v;
      }
      return;
    }
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const v = parseLine(line);
        if (v !== undefined) yield v;
      }
    }
    const tail = parseLine(buf);
    if (tail !== undefined) yield tail;
  }

  private async json<T>(method: 'GET' | 'POST', path: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.raw(method, path, payload, { timeoutMs });
    if (!res.ok) throw await toError(res);
    return (await readJson(res)) as T;
  }

  private async raw(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    opts: { withToken?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Response> {
    if (!this.cfg.url) throw new BackendError(0, '백엔드 URL이 설정되어 있지 않습니다');

    const headers: Record<string, string> = {};
    const wantToken = opts.withToken !== false;
    if (wantToken && this.cfg.token) {
      if (!this.tokenSafe && this.platform === 'web') {
        // Refuse rather than risk relaying the token to a third party.
        throw new BackendError(0, '직접 연결이 확인되지 않아 토큰을 보내지 않았습니다. 연결 진단을 먼저 실행해 주세요');
      }
      headers['Authorization'] = 'Bearer ' + this.cfg.token;
    }

    const init: import('./risuai').NativeFetchOptions = {
      method,
      headers,
      networkRoute: 'local_network',
    };
    if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      // nativeFetch throws when a POST has no body at all.
      init.body = JSON.stringify(payload ?? {});
    }
    if (opts.signal) init.signal = opts.signal;

    const url = this.cfg.url + path;
    const budget = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    const call = Risuai.nativeFetch(url, init);
    if (!budget) return await call;

    // nativeFetch may ignore AbortSignal depending on the host path, so the
    // wall-clock bound is enforced here with a race rather than trusted to it.
    call.catch(() => { /* consumed below; avoids an unhandled rejection */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new BackendError(0, `${path} 응답이 ${Math.round(budget / 1000)}초 안에 오지 않았습니다`)),
            budget,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function parseLine(line: string): unknown | undefined {
  const s = line.trim();
  if (!s) return undefined;
  try { return JSON.parse(s); } catch { return { type: 'raw', text: s }; }
}

/**
 * Read a body exactly once.
 *
 * Trying `res.json()` and falling back to `res.text()` cannot work: json()
 * has already consumed the body, so the fallback reports "Body has already
 * been read" instead of the real problem. Cost a real debugging detour in the
 * Phase 0 probe.
 */
async function readJson(res: Response): Promise<unknown> {
  let text: string;
  try { text = await res.text(); } catch { return null; }
  try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 500) }; }
}

async function toError(res: Response): Promise<BackendError> {
  const body = await readJson(res);
  let msg = (body && typeof body === 'object' && 'error' in body)
    ? String((body as { error: unknown }).error)
    : `HTTP ${res.status}`;
  // "unauthorized" names the rule, not the fix. Say where the token is.
  if (res.status === 401) {
    msg = '토큰이 맞지 않습니다. 백엔드 PC 의 data/token.txt 내용을 ⚙ → 연결 → 토큰에 넣고 "저장하고 연결"을 눌러 주세요 (127.0.0.1 로 접속할 때는 비워도 됩니다).';
  } else if (res.status === 429) {
    msg = '틀린 토큰이 여러 번 거부되어 잠시 막혔습니다. 1분 뒤 다시 시도해 주세요.';
  }
  return new BackendError(res.status, msg, body);
}

export const transport = new Transport();

/**
 * Report a plugin-side event to the backend log.
 *
 * The sandboxed iframe's console is invisible to anyone not sitting at the
 * browser with devtools open, which made the first real bug report a
 * screenshot rather than a log line. Fire-and-forget: a logging failure must
 * never surface as an error in the thing being logged.
 */
export function clientLog(
  level: 'debug' | 'info' | 'warn' | 'error',
  event: string,
  detail?: unknown,
): Promise<void> {
  return transport
    .post('/clientlog', { level, event, detail })
    .then(() => undefined)
    .catch(() => undefined);
}
