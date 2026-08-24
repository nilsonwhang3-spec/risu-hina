// The slice of RisuAI's v3 API this plugin uses.
//
// Hand-written rather than vendored: RisuAI ships a 63KB risuai.d.ts, but
// pinning to it would couple us to one fork's copy, and PocketRisu's surface is
// a superset of mainline's. Declaring only what we call keeps the compiler
// honest about the boundary and makes every host dependency greppable.
//
// Everything is async: each call is an RPC across the sandbox postMessage
// bridge (factory.ts GUEST_BRIDGE_SCRIPT), so `await` is not optional.

export interface RisuMessage {
  role: 'user' | 'char';
  data: string;
  chatId?: string;
  time?: number;
  name?: string;
  saying?: string;
  disabled?: false | true | 'allBefore';
  isComment?: boolean;
  generationInfo?: Record<string, unknown>;
  promptInfo?: Record<string, unknown>;
  // Phase 0 found live chats carrying fields absent from RisuAI's own
  // interface. Never narrow this type to a closed set.
  [key: string]: unknown;
}

export interface RisuChat {
  message: RisuMessage[];
  folderId?: string;
  name?: string;
  note?: string;
  localLore?: unknown[];
  id?: string;
  fmIndex?: number;
  hypaV3Data?: unknown;
  hypaV2Data?: unknown;
  supaMemory?: unknown;
  lastDate?: number;
  isStreaming?: boolean;
  [key: string]: unknown;
}

export interface RisuCharacter {
  name?: string;
  chaId?: string;
  /** Asset path, e.g. "assets/<hash>.png". Read it with readImage(). */
  image?: string;
  chatFolders?: { id?: string; name?: string; color?: string; folded?: boolean }[];
  type?: string;
  chats?: RisuChat[];
  chatPage?: number;
  desc?: string;
  personality?: string;
  scenario?: string;
  firstMessage?: string;
  alternateGreetings?: string[];
  exampleMessage?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  creatorNotes?: string;
  globalLore?: unknown[];
  [key: string]: unknown;
}

export interface NativeFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Uint8Array | ArrayBuffer;
  signal?: AbortSignal;
  /**
   * PocketRisu only. Routes the request through the server's /proxy2 instead of
   * letting the browser try a direct fetch first.
   *
   * Measured in Phase 0: omitting this costs ~2.3s per request, because the
   * browser attempts a direct fetch to a private address, fails, and only then
   * falls back to the proxy. Mainline RisuAI ignores unknown options, so
   * passing it is safe everywhere.
   */
  networkRoute?: 'auto' | 'local_network';
  /**
   * Do NOT set to 'openai_streaming'. That is the only combination that takes
   * PocketRisu's WebSocket proxy-job path, which was measured delivering the
   * first four chunks batched together. Plain /proxy2 streams properly.
   */
  interceptor?: string;
  requestTimeoutMs?: number;
}

export interface UIPart { id: string }

export interface RisuaiApi {
  getArgument(key: string): Promise<string | number | undefined>;
  setArgument(key: string, value: string | number): Promise<void>;

  getRuntimeInfo(): Promise<{ apiVersion: string; platform: 'node' | 'tauri' | 'web'; saveMethod: string }>;

  nativeFetch(url: string, options?: NativeFetchOptions): Promise<Response>;

  getCurrentCharacterIndex(): Promise<number>;
  /** Throws when no character is selected - it reads db.characters[sel].chatPage. */
  getCurrentChatIndex(): Promise<number>;
  getCharacterFromIndex(index: number): Promise<RisuCharacter | null>;
  setCharacterToIndex(index: number, char: RisuCharacter): Promise<void>;
  getChatFromIndex(characterIndex: number, chatIndex: number): Promise<RisuChat | null>;
  /** Writes only to an index that already exists; cannot append a chat. */
  setChatToIndex(characterIndex: number, chatIndex: number, chat: RisuChat): Promise<void>;

  /**
   * Allowed DB keys only. Prompts the user for the 'db' permission on first
   * use (re-confirmed every 3 days) and resolves to null when refused.
   */
  getDatabase(includeOnly?: string[] | 'all'): Promise<Record<string, unknown> | null>;
  /** Writes allowed keys onto the live DB; no permission gate of its own. */
  setDatabase(patch: Record<string, unknown>): Promise<void>;
  /** Registers new chaIds in characterOrder so the sidebar shows them. */
  checkCharOrder?(): Promise<void>;

  showContainer(type?: 'fullscreen'): Promise<void>;
  hideContainer(): Promise<void>;
  registerSetting(name: string, cb: () => void, icon?: string, iconType?: 'html' | 'img' | 'none'): Promise<UIPart>;
  registerButton(
    arg: { name: string; icon: string; iconType: 'html' | 'img' | 'none'; location?: 'action' | 'chat' | 'hamburger' },
    cb: () => void,
  ): Promise<UIPart>;
  unregisterUIPart(id: string): Promise<void>;

  pluginStorage: {
    getItem(key: string): Promise<unknown>;
    setItem(key: string, value: unknown): Promise<void>;
    removeItem(key: string): Promise<void>;
  };

  /**
   * Asset bytes. The path may not contain a slash except the `assets/` prefix -
   * the host throws otherwise.
   */
  readImage(path: string): Promise<Uint8Array | null>;

  onUnload(cb: () => void | Promise<void>): Promise<void>;
  alert(msg: string): Promise<void>;
  alertError(msg: string): Promise<void>;
}

declare global {
  const Risuai: RisuaiApi;
  const __PLUGIN_VERSION__: string;
}

export {};
