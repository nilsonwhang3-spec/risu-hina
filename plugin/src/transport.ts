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
 *       NOT on web RisuAI (§1-117): there the host throws "웹에서는 사설망 직접
 *       호출 불가" for any localhost / LAN address on that route, before any
 *       request. Without it, 'Use Plain Fetch' fetches from the page itself,
 *       which reaches 127.0.0.1 once Chrome's local network access is allowed
 *       (confirmed 2026-10-20 on risuai.xyz, Chrome 155).
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
  /** false: the backend is up only to say why it refuses (e.g. a DB from a newer version). */
  ok?: boolean;
  error?: string;
  /** How the backend is updated: 'docker' (rebuild/pull the image) or 'standard' (in-app). */
  installKind?: string;
  clientIp?: string;
  loopback?: boolean;
  tokenRequired?: boolean;
  /** Whether this backend offers the ChatGPT plan path at all. */
  codexEnabled?: boolean;
  /** The agent's preset runs on the user's ChatGPT plan. */
  chatgptPlan?: boolean;
  workspaces?: number;
  /** The global file space's root path. */
  space?: string;
  /** The optional MCP add-on (docs/08): loaded, /mcp mounted, a panel holding the switch. */
  mcp?: { loaded: boolean; mounted: boolean; active: boolean };
}

export type RouteKind = 'unknown' | 'direct' | 'blocked';

export class BackendError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
    this.name = 'BackendError';
  }
}

const SIGNATURE = 'risu-hina';
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
    const url = normalizeBackendUrl(cfg.url || '');
    if (url !== this.cfg.url) {
      // A different backend has to re-earn the right to see the token.
      this.tokenSafe = false;
      this.route = 'unknown';
      this.lastHealth = null;
      this.privateRefused = false;
    }
    this.cfg = { url, token: (cfg.token || '').trim() };
  }

  get config(): Config { return { ...this.cfg }; }
  get health(): HealthInfo | null { return this.lastHealth; }
  get routeKind(): RouteKind { return this.route; }
  get hostPlatform(): string { return this.platform; }
  get tokenAttached(): boolean { return this.tokenSafe; }
  /**
   * Web RisuAI refused the configured address outright (a private or loopback
   * IP). Retrying cannot help - only a different URL can - so the reconnect
   * loop stops and the "wait 3 minutes" advice is not shown.
   */
  get refusedPrivate(): boolean { return this.privateRefused; }
  private privateRefused = false;

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
    this.privateRefused = false;

    let res: Response;
    try {
      res = await this.probe();
    } catch (e) {
      if (e instanceof BackendError) throw e;
      // The host's fetch threw before any response: the address is wrong, or
      // the tunnel / VPN in front of the backend is not up yet. Say that,
      // and say the panel keeps trying - the shell does (startReconnect).
      this.route = 'blocked';
      this.tokenSafe = false;
      const why = e instanceof Error ? e.message : String(e);
      const web = webPrivateHint(why, this.cfg.url);
      if (web) {
        this.privateRefused = true;
        throw new BackendError(0, `백엔드에 닿지 못했습니다 (${why}). ${web}`);
      }
      const https = localHttpsHint(this.cfg.url);
      const browser = this.platform === 'web' ? webLocalFetchHint(why, this.cfg.url) : '';
      throw new BackendError(0,
        `백엔드에 닿지 못했습니다 (${explainFetchFailure(why)}). ` +
        (https ? https + ' ' : browser ? browser + ' ' : 'URL 이 맞는지, 터널·VPN 이 열려 있는지 확인해 주세요. ') +
        '잠시 뒤 자동으로 다시 시도합니다.');
    }
    const body = (await readJson(res)) as HealthInfo | null;
    if (!body || (body.service !== SIGNATURE)) {
      this.route = 'blocked';
      this.tokenSafe = false;
      // What actually came back is the diagnostic: a relay's error page, a
      // reverse proxy's 502 while the tunnel warms up, someone else's server.
      // It is quoted rather than guessed at - the old text blamed a RisuAI
      // setting, and the one real report turned out to be a tunnel that
      // came up a minute later with nothing changed.
      const what = res.status ? `HTTP ${res.status}` : '빈 응답';
      const raw = body && typeof body === 'object' && '_raw' in body
        ? String((body as { _raw: unknown })._raw).replace(/\s+/g, ' ').trim().slice(0, 80)
        : (body ? JSON.stringify(body).slice(0, 80) : '');
      // Who answered, for the log. Only CORS-safelisted response headers are
      // readable here, which is enough: our own replies are no-store JSON, so
      // an HTML content-type or a cacheable Cache-Control names an
      // intermediary rather than the backend.
      this.probeInfo = [
        `HTTP ${res.status}`,
        `type=${res.headers.get('content-type') || '?'}`,
        `cache=${res.headers.get('cache-control') || '-'}`,
        res.headers.get('age') ? `age=${res.headers.get('age')}` : '',
        res.headers.get('expires') ? `expires=${res.headers.get('expires')}` : '',
        `body=${raw}`,
      ].filter(Boolean).join(' · ');
      throw new BackendError(
        res.status,
        `백엔드에서 Risu Hina 응답을 받지 못했습니다 (${what}${raw ? ' · ' + raw : ''}). ` +
        ((this.platform === 'web' ? webRelayHint(this.cfg.url) : '')
          || relayFailureHint(raw, this.cfg.url)
          || '주소가 다른 서버를 가리키거나 터널이 아직 안 열렸을 수 있습니다. ') +
        '잠시 뒤 자동으로 다시 시도합니다.',
        body,
      );
    }
    // Ours, but refusing to work (a database written by a newer version):
    // its reason is the connection error the panel shows.
    if (body.ok === false && body.error) {
      this.route = 'direct';
      this.tokenSafe = true;
      throw new BackendError(503, String(body.error), body);
    }
    this.route = 'direct';
    this.tokenSafe = true;
    this.lastHealth = body;
    this.probeInfo = '';
    // A plugin and a backend of different minor versions do not speak the
    // same API. Rather than fail somewhere deep with a 404 or a wrong shape,
    // refuse everything but the update paths and say which side to update.
    this.gate = versionGate(__PLUGIN_VERSION__, String(body.version || ''));
    return body;
  }

  /** Why ordinary calls are refused right now (version mismatch), or ''. */
  get versionGate(): string { return this.gate; }
  private gate = '';

  /** What answered the last failed probe (status, type, cache headers), or ''. */
  probeInfo = '';

  /**
   * The connect probe: POST first, GET as the fallback.
   *
   * There is a caching CDN in front of at least one real deployment. When its
   * cache holds an error page for `GET /health`, the panel cannot connect
   * until that entry expires - measured at 49s and 79s in the server log,
   * with **no request reaching the backend** in either window, and the first
   * one that did arrive succeeding immediately. Cache-busting the URL does not
   * work: that edge ignores query strings (0.7.2 caught it serving one asset
   * blob for every key). A POST is never served from a cache, so the probe is
   * a POST; GET remains for backends older than 0.8.4, which have no route
   * for it.
   */
  private async probe(): Promise<Response> {
    const post = await this.raw('POST', '/health', {}, { withToken: false });
    if (post.status !== 404 && post.status !== 405) return post;
    return await this.raw('GET', '/health', undefined, { withToken: false });
  }

  async get<T = unknown>(path: string, query?: Record<string, string | number | undefined>,
                         timeoutMs?: number): Promise<T> {
    const qs = query
      ? '?' + Object.entries(query)
          .filter(([, v]) => v !== undefined && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    return this.json<T>('GET', path + qs, undefined, timeoutMs);
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

  /** POST of raw bytes (application/octet-stream) - the batch upload. */
  async postBytes<T = unknown>(path: string, bytes: Uint8Array): Promise<T> {
    const res = await this.raw('POST', path, undefined, { timeoutMs: UPLOAD_TIMEOUT_MS, bytes });
    if (!res.ok) throw await toError(res);
    const body = await readJson(res);
    if (isRaw(body)) throw new BackendError(res.status, '백엔드 대신 다른 응답이 왔습니다 (JSON 이 아님)');
    return body as T;
  }

  /** POST that answers bytes - a zip of workspace files, an image, a thumb.
   * The default timeout stays generous (a charx download runs minutes);
   * image callers pass a short one so a hung fetch frees its semaphore slot
   * in seconds instead of holding it for three minutes. */
  async postBinary(path: string, payload: unknown, timeoutMs = UPLOAD_TIMEOUT_MS): Promise<Uint8Array> {
    const res = await this.raw('POST', path, payload, { timeoutMs });
    if (!res.ok) throw await toError(res);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * The same, reporting the bytes as they arrive (§1-62: a big download
   * showed nothing for a long time). `total` is the Content-Length when the
   * server sends one (a zip is streamed and has none), else 0. Hosts whose
   * Response has no readable body fall back to one report at the end.
   */
  async postBinaryProgress(path: string, payload: unknown, onProgress: (p: { loaded: number; total: number }) => void,
                           timeoutMs = UPLOAD_TIMEOUT_MS): Promise<Uint8Array> {
    const res = await this.raw('POST', path, payload, { timeoutMs });
    if (!res.ok) throw await toError(res);
    const total = Number(res.headers?.get?.('content-length') || 0) || 0;
    const body = res.body;
    if (!body || typeof body.getReader !== 'function') {
      const out = new Uint8Array(await res.arrayBuffer());
      onProgress({ loaded: out.byteLength, total: out.byteLength });
      return out;
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) { chunks.push(value); loaded += value.byteLength; onProgress({ loaded, total }); }
    }
    const out = new Uint8Array(loaded);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
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
    // 중단 (or a consumer that stops iterating) must release the body too,
    // or the response keeps buffering behind an abandoned reader (§1-55).
    const onAbort = () => { void reader.cancel().catch(() => { /* already closed */ }); };
    signal?.addEventListener('abort', onAbort);
    try {
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
    } finally {
      signal?.removeEventListener('abort', onAbort);
      void reader.cancel().catch(() => { /* already closed */ });
    }
  }

  private async json<T>(method: 'GET' | 'POST', path: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    const budget = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
    const controller = new AbortController();
    const request = async (): Promise<T> => {
      // The deadline covers headers AND response/error body consumption.
      // nativeFetch may settle at headers while text() waits on a stalled relay.
      const res = await this.raw(method, path, payload, { timeoutMs: 0, signal: controller.signal });
      if (!res.ok) throw await toError(res);
      const body = await readJson(res);
      if (isRaw(body)) {
        throw new BackendError(res.status,
          `백엔드 대신 다른 응답이 왔습니다 (JSON 이 아님): “${body._raw.replace(/\s+/g, ' ').trim().slice(0, 100)}” — `
          + '터널·프록시가 대신 답했을 수 있습니다. 잠시 뒤 다시 시도해 주세요.');
      }
      return body as T;
    };
    return await withDeadline(request(), path, budget, () => controller.abort());
  }

  private async raw(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown,
    opts: { withToken?: boolean; timeoutMs?: number; signal?: AbortSignal; bytes?: Uint8Array } = {},
  ): Promise<Response> {
    if (!this.cfg.url) throw new BackendError(0, '백엔드 URL이 설정되어 있지 않습니다');

    if (this.gate && !GATE_EXEMPT.has(path.split('?')[0])) {
      throw new BackendError(0, this.gate);
    }
    const headers: Record<string, string> = {};
    const wantToken = opts.withToken !== false;
    if (wantToken && this.cfg.token) {
      if (!this.tokenSafe && this.platform === 'web') {
        // Refuse rather than risk relaying the token to a third party.
        throw new BackendError(0, '직접 연결이 확인되지 않아 토큰을 보내지 않았습니다. ' + (this.privateRefused
          ? `RisuAI 가 이 주소로 가는 요청을 거절했습니다 — 플러그인을 최신으로 다시 넣고 ${PLAIN_FETCH} 를 켜 주세요`
          : '연결 진단을 먼저 실행해 주세요'));
      }
      headers['Authorization'] = 'Bearer ' + this.cfg.token;
    }

    const init: import('./risuai').NativeFetchOptions = {
      method,
      headers,
      networkRoute: this.platform === 'web' ? 'auto' : 'local_network',
    };
    if (opts.bytes) {
      headers['Content-Type'] = 'application/octet-stream';
      init.body = opts.bytes;
    } else if (method === 'POST') {
      headers['Content-Type'] = 'application/json';
      // nativeFetch throws when a POST has no body at all.
      init.body = JSON.stringify(payload ?? {});
    }
    if (opts.signal) init.signal = opts.signal;

    const url = this.cfg.url + path;
    const budget = opts.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : opts.timeoutMs;
    const call = Risuai.nativeFetch(url, init);
    if (!budget) return await call;

    return await withDeadline(call, path, budget);
  }

}

/** AbortSignal is best effort in the host; the promise itself has a hard bound. */
async function withDeadline<T>(call: Promise<T>, path: string, budget: number, cancel?: () => void): Promise<T> {
  if (!budget) return await call;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new BackendError(0, `${path} 응답이 ${Math.round(budget / 1000)}초 안에 오지 않았습니다`));
          cancel?.();
        }, budget);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
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

function isRaw(v: unknown): v is { _raw: string } {
  return !!v && typeof v === 'object' && '_raw' in v && Object.keys(v as object).length === 1;
}

/**
 * The RisuAI desktop app (Tauri) reports a failed request as
 * `{"success":false, body:<reqwest error>}` - `body` unquoted - so its own
 * JSON.parse throws and the real cause (refused, TLS, timeout) is lost. A user
 * saw "Expected double-quoted property name in JSON at position 18" for an
 * https:// URL on a plain-HTTP backend. Name what it means instead.
 */
export function explainFetchFailure(message: string): string {
  // V8 (WebView2) and WebKit (macOS / Linux webviews) word it differently.
  if (/double-quoted property name|JSON Parse error/i.test(message)) {
    return '연결 자체가 실패했습니다. RisuAI 데스크톱 앱이 원래 오류를 깨진 형식으로 넘겨 원인 문구가 사라졌습니다'
      + ' — 주소의 http/https, 포트, 백엔드 실행 여부를 확인해 주세요';
  }
  return message;
}

/**
 * PocketRisu (and RisuAI's own node server) relays nativeFetch through its
 * /proxy2. When Node's fetch cannot even connect, the relay answers 500
 * {"error":"fetch failed"} - our backend never saw the request. A field report
 * read the old "address points at another server" text as a wrong URL, with
 * the URL untouched and the backend healthy on the same PC. Returns the
 * advice, or ''.
 */
export function relayFailureHint(raw: string, url: string): string {
  if (!/fetch failed|Proxy request failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(raw)) return '';
  let host = '';
  try { host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { /* keep '' */ }
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (loopback) {
    return 'RisuAI(PocketRisu) 서버가 이 주소의 백엔드에 연결하지 못했습니다. 주소는 맞아도 '
      + '① 백엔드가 지금 꺼져 있거나 ② PocketRisu 가 Docker·WSL·다른 PC 에서 돌고 있으면 그쪽의 127.0.0.1 은 '
      + '이 PC 의 백엔드가 아닙니다 — 같은 PC 에서 http://127.0.0.1:6020/health 가 열리는지, '
      + 'PocketRisu 를 어떻게 실행했는지 확인해 주세요. PocketRisu 가 Docker 라면 주소를 '
      + 'http://host.docker.internal:6020 으로 바꿔 보세요(설치 안내서의 Docker 절). ';
  }
  return 'RisuAI 서버가 이 주소의 백엔드에 연결하지 못했습니다 — 백엔드가 실행 중인지, '
    + 'RisuAI 서버가 있는 기기에서 이 주소(포트·터널·방화벽)에 닿는지 확인해 주세요. ';
}

/**
 * The backend serves plain HTTP; https:// on a loopback or private address
 * fails at the TLS handshake. A domain behind a tunnel or reverse proxy is
 * left alone - that is where https belongs. Returns the advice, or ''.
 */
export function localHttpsHint(url: string): string {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return ''; }
  if (u.protocol !== 'https:') return '';
  if (addressKind(url).kind === 'domain') return '';
  return `로컬·사설 주소의 백엔드는 https 가 아니라 http 입니다 — ${url.trim().replace(/^https:/i, 'http:')} 로 바꿔 주세요.`;
}

/**
 * The URL as typed, made absolute. "127.0.0.1:6020" without a scheme is a
 * relative path to nativeFetch: on web RisuAI it fetched risuai.xyz's own
 * index.html and the probe reported "HTTP 200 · <!DOCTYPE html>" (§1-117).
 * A missing scheme becomes http:// - the backend serves plain HTTP; a
 * tunnel's domain is typed with https:// in practice, and if not, the
 * https-only host answers with its own error rather than a page.
 */
export function normalizeBackendUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'http://' + url.replace(/^\/+/, '');
  return url;
}

export type AddressKind = 'loopback' | 'private' | 'tailscale' | 'domain' | 'invalid';

/**
 * What sort of address the backend URL is, without the address itself - the
 * 오류 제보 block masks the URL, and the class is what decides most
 * connection reports (§1-117).
 */
export function addressKind(url: string): { kind: AddressKind; scheme: string } {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return { kind: 'invalid', scheme: '' }; }
  const scheme = u.protocol.replace(/:$/, '');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)) {
    return { kind: 'loopback', scheme };
  }
  // Tailscale hands out 100.64.0.0/10 (CGNAT).
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return { kind: 'tailscale', scheme };
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host) || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) {
    return { kind: 'private', scheme };
  }
  return { kind: 'domain', scheme };
}

/**
 * Web RisuAI will not fetch a private or loopback address at all: its
 * nativeFetch throws "웹에서는 사설망 직접 호출 불가. Tauri 또는 LAN Node
 * self-host 사용" before any request leaves. A field report (2026-10-20) sat
 * on "URL·VPN 확인, 3분 걸릴 수 있음, 자동 재시도" for twenty minutes - none of
 * which can help: Tailscale being up does not matter while the URL is an IP.
 * The way out is an https host name. Returns the advice, or ''.
 */
export function webPrivateHint(message: string, url: string): string {
  // Keyed on the host's own refusal: the plugin no longer asks for that route
  // on web, so this is an older plugin or an undetected platform.
  if (!/사설망 직접 호출 불가/.test(message)) return '';
  const { kind } = addressKind(url);
  const which = kind === 'tailscale' ? 'Tailscale IP(100.x)' : kind === 'private' ? '사설 IP(192.168·10.x 등)'
    : kind === 'loopback' ? '127.0.0.1·localhost' : '이 주소';
  return `RisuAI 가 ${which} 로 가는 요청을 보내기 전에 거절했습니다 — 기다리거나 VPN 을 켜도 바뀌지 않습니다. `
    + `Risu Hina 플러그인을 최신으로 다시 넣고, ${PLAIN_FETCH} 를 켠 다음 브라우저가 묻는 "로컬 네트워크 액세스"를 허용해 주세요. `
    + '다른 기기의 백엔드라면 tailscale serve 의 https://<기기이름>.ts.net 같은 https 주소가 가장 확실합니다.';
}

/** Where web RisuAI keeps "Use Plain Fetch" (hidden by default, Korean label). */
export const PLAIN_FETCH = 'RisuAI 설정 → 고급 설정 → 비권장 설정 보이기 → "직접 요청 보내기"(Use Plain Fetch)';

/**
 * Web RisuAI, an IP address, and the browser's own "Failed to fetch": the
 * request never left the page. With plain fetch on, Chrome asks before an
 * https page reaches 127.0.0.1 or the LAN (Local Network Access); declining,
 * or a backend that is not running, ends here. Confirmed 2026-10-20: plain
 * fetch + the permission connects web RisuAI to http://127.0.0.1:6020.
 * Returns the advice, or ''.
 */
export function webLocalFetchHint(message: string, url: string): string {
  if (!/Failed to fetch|NetworkError|Load failed/i.test(message)) return '';
  const { kind } = addressKind(url);
  if (kind !== 'loopback' && kind !== 'private' && kind !== 'tailscale') return '';
  return '브라우저가 이 주소로 가는 요청을 막았거나 백엔드가 꺼져 있습니다 — 백엔드가 켜져 있다면 '
    + '주소창 자물쇠 → 사이트 설정에서 "로컬 네트워크 액세스"를 허용해 주세요(거부했다면 여기서 다시 허용). '
    + `${PLAIN_FETCH} 도 켜져 있어야 합니다.`;
}

/**
 * Web RisuAI, an IP address, and something other than our backend answered:
 * with plain fetch off the request went to RisuAI's relay server, which
 * cannot reach a private address. Returns the advice, or ''.
 */
export function webRelayHint(url: string): string {
  const { kind } = addressKind(url);
  if (kind !== 'loopback' && kind !== 'private' && kind !== 'tailscale') return '';
  return `요청이 RisuAI 중계 서버를 거쳐 이 주소에 닿지 못했습니다 — ${PLAIN_FETCH} 를 켜고, `
    + '브라우저가 묻는 "로컬 네트워크 액세스"를 허용해 주세요. ';
}

/** Paths that work across versions: the ones an update needs. */
const GATE_EXEMPT = new Set(['/health', '/update/check', '/update/apply', '/plugin', '/logs', '/diag', '/config']);

/**
 * The refusal text when plugin and backend differ in major.minor, or ''.
 * Newer plugin -> update the backend (from 설정 → 연결); newer backend ->
 * update the plugin (RisuAI's +). Patch versions are compatible by contract.
 */
/**
 * The backend is an older PATCH of the plugin's version (§1-91). The gate
 * above lets that through - same major.minor speaks the same API - but a
 * patch can add routes the plugin then calls (0.15.33's personas on a 0.15.32
 * backend). The plugin updates itself from master; the backend waits for its
 * owner, longest in Docker. Returns the advice, or '' when nothing is behind.
 */
export function backendBehind(plugin: string, backend: string, installKind = ''): string {
  const v = (s: string) => s.split('.').map((x) => parseInt(x, 10) || 0);
  if (!backend) return '';
  const [pa, pb, pc] = v(plugin);
  const [ba, bb, bc] = v(backend);
  if (pa !== ba || pb !== bb || !((pc ?? 0) > (bc ?? 0))) return '';
  const how = installKind === 'docker'
    ? '이 백엔드는 Docker 설치입니다 - compose.yaml 이 있는 폴더에서 docker compose pull && docker compose up -d 를 실행해 주세요.'
    : '⚙ → 정보 · 로그 → 백엔드 업데이트를 눌러 주세요.';
  return `백엔드 v${backend} 가 플러그인 v${plugin} 보다 오래됐습니다. 새 기능 일부가 동작하지 않을 수 있습니다. ${how}`;
}

export function versionGate(plugin: string, backend: string): string {
  const mm = (v: string) => v.split('.').slice(0, 2).map((x) => parseInt(x, 10) || 0);
  if (!backend) return '';
  const [pa, pb] = mm(plugin);
  const [ba, bb] = mm(backend);
  if (pa === ba && pb === bb) return '';
  const pluginNewer = pa > ba || (pa === ba && pb > bb);
  return pluginNewer
    ? `플러그인 v${plugin} 과 백엔드 v${backend} 의 버전이 다릅니다. ⚙ → 연결에서 백엔드를 업데이트해 주세요.`
    : `백엔드 v${backend} 가 플러그인 v${plugin} 보다 새 버전입니다. RisuAI 플러그인 화면에서 Risu Hina 를 업데이트(+)해 주세요.`;
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
