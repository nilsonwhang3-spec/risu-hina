/**
 * Space images as blob URLs - the one proven pipeline, extracted.
 *
 * Bytes come by POST /files/download (a cache in front of the backend - a
 * tunnel's edge - was seen serving one GET's body for every query string),
 * at most six fetches in flight, and an LRU-capped cache of object URLs.
 * The files tab proved this three times over before it moved here.
 *
 * Path policy: **space-relative paths only.** Anything with a scheme, a
 * leading slash or a `..` segment renders as a text placeholder - an iframe
 * fetching arbitrary model-chosen URLs is an exfiltration channel, and the
 * images this app shows are local files anyway.
 *
 * Memory (§1-55): the cache is bounded in BYTES as well as entries, a
 * revoked URL is released at once unless a picture on screen still shows it,
 * and a grid cell far off screen drops its <img> (the decoded bitmap is what
 * costs - a 360px thumb is 20KB on the wire and ~700KB decoded) and fetches
 * again when it comes back. iOS reloads the whole page when a tab runs out
 * of memory; the plugin's own numbers are logged as `mem` (see blobStats).
 */
import { el, clear } from './dom';
import { state } from '../state';

const PARALLEL = 6;
let active = 0;
const queue: (() => void)[] = [];
interface Entry { url: string; bytes: number }
/** path[:stamp] -> object URL (thumb keys carry a t: prefix; asset keys an asset: prefix). */
const cache = new Map<string, Entry>();
let cacheBytes = 0;
/** One fetch per key even when a grid rebuild asks again before it lands. */
const inflight = new Map<string, Promise<string>>();
/** Images only: short timeout so a hung fetch frees its 1-of-6 slot fast. */
const IMAGE_TIMEOUT_MS = 45_000;
/** URLs evicted while a connected <img> still showed them - revoked later. */
let deferredRevokes = 0;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A model-written path into the space-relative shape the backend takes:
 * backslashes, a leading slash, an absolute install path or a `data/space/`
 * prefix are all things the agent has produced for a file it just made.
 * Schemes and `..` stay refused (see safeWorkspacePath).
 */
export function normalizeWorkspacePath(path: string): string {
  let p = (path || '').trim().replace(/\\/g, '/');
  if (SCHEME_RE.test(p)) return p;
  const m = p.match(/(?:^|\/)(?:data\/)?space\/(.+)$/);
  if (m) p = m[1];
  p = p.replace(/^\.?\/+/, '');
  return p;
}

/** True for a plain space-relative path (Korean names welcome). */
export function safeWorkspacePath(path: string): boolean {
  if (!path || SCHEME_RE.test(path) || path.startsWith('/') || path.startsWith('\\')) return false;
  return !path.split(/[\\/]/).some((p) => p === '..');
}

export interface BlobOptions {
  /** Fetch the server-side WebP thumbnail instead of the original bytes. */
  thumb?: boolean;
  /** Thumbnail width (default 360; 검수 asks for 720, §1-39). */
  w?: number;
}

/** A phone: ≤760px, or a coarse pointer up to 1024px. iOS reloads the whole
 * page when the tab runs out of memory, which showed as 검수 "계속 리셋" on
 * an iPhone (§1-53); every budget below is smaller here. */
export function smallScreen(): boolean {
  try {
    return window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches;
  } catch { return false; }
}

/** How many object URLs to keep: a desktop can hold hundreds, a phone cannot. */
function cacheCap(): number {
  return smallScreen() ? 90 : 600;
}

/** ...and how many bytes: a count alone let ninety 3MB originals through. */
function byteCap(): number {
  return smallScreen() ? 24 * 1024 * 1024 : 256 * 1024 * 1024;
}

/** The plugin's own memory numbers, for the `mem` log line and ⚙ → 정보. */
export function blobStats(): { count: number; bytes: number; inflight: number; deferredRevokes: number; countCap: number; byteCap: number } {
  return { count: cache.size, bytes: cacheBytes, inflight: inflight.size, deferredRevokes, countCap: cacheCap(), byteCap: byteCap() };
}

/** Let go of a URL: at once when nothing on screen shows it, else after a
 * grace long enough for any redraw (revoking at eviction blanked pictures
 * that were still in the DOM - the cache turned over, the <img> went empty). */
function release(url: string): void {
  let shown = false;
  try {
    const img = document.querySelector(`img[src="${url}"]`);
    shown = !!img && img.isConnected;
  } catch { shown = true; }
  if (!shown) { URL.revokeObjectURL(url); return; }
  deferredRevokes += 1;
  setTimeout(() => { deferredRevokes -= 1; URL.revokeObjectURL(url); }, 30_000);
}

function drop(key: string, e: Entry): void {
  cache.delete(key);
  cacheBytes -= e.bytes;
  release(e.url);
}

/** Make room for `incoming` bytes: oldest first, by count and by bytes. */
function makeRoom(incoming: number): void {
  while (cache.size && (cache.size >= cacheCap() || cacheBytes + incoming > byteCap())) {
    const first = cache.entries().next().value as [string, Entry];
    drop(first[0], first[1]);
  }
}

/** Forget every cached object URL for these paths (or all, with none): a
 * file rewritten under the same name - a regenerated batch, an inpaint, an
 * upload over an old one - showed its OLD picture until the panel reloaded
 * (§1-42 "썸네일이 캐시가 있는지 반복"). */
export function evictBlob(paths?: string[]): void {
  const doomed: string[] = [];
  for (const k of cache.keys()) {
    const bare = k.replace(/^t\d*:/, '');
    const p = bare.includes(':') ? bare.slice(0, bare.lastIndexOf(':')) : bare;
    if (!paths || paths.includes(p) || paths.includes(bare)) doomed.push(k);
  }
  for (const k of doomed) {
    const e = cache.get(k);
    if (e) drop(k, e);
  }
}

/** The object URL for a space file's bytes, cached (a real LRU: a hit
 * re-inserts its key so heavy grids do not evict what is on screen). */
export async function blobUrl(path: string, stamp = '', opts: BlobOptions = {}): Promise<string> {
  const key = (opts.thumb ? `t${opts.w || 360}:` : '') + (stamp ? `${path}:${stamp}` : path);
  return blobFrom(key, () => opts.thumb
    ? state.fileThumb(path, opts.w || 360)
    : state.fileBytes(path, IMAGE_TIMEOUT_MS));
}

/**
 * The same cache and fetch window for bytes that are not a space file - a
 * RisuAI asset by key, say. `fetch` runs inside the 1-of-6 slot; a null
 * result rejects so the caller shows its own placeholder.
 */
export async function blobFrom(key: string, fetch: () => Promise<Uint8Array | null | undefined>): Promise<string> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.url;
  }
  // In-flight dedup: drawCentre() rebuilds used to fetch the same cell twice
  // - both callers passed the semaphore before either had filled the cache.
  const running = inflight.get(key);
  if (running) return running;
  const job = fetchBlob(key, fetch);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

async function fetchBlob(key: string, fetch: () => Promise<Uint8Array | null | undefined>): Promise<string> {
  await new Promise<void>((resolve) => {
    const go = () => { active += 1; resolve(); };
    if (active < PARALLEL) go(); else queue.push(go);
  });
  try {
    // A second waiter for the same key may have filled it meanwhile.
    const again = cache.get(key);
    if (again) return again.url;
    const bytes = await fetch();
    if (!bytes || !bytes.byteLength) throw new Error('no bytes');
    // Blob copies its parts, so the bytes are not held twice here.
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
    makeRoom(bytes.byteLength);
    cache.set(key, { url, bytes: bytes.byteLength });
    cacheBytes += bytes.byteLength;
    return url;
  } finally {
    active -= 1;
    queue.shift()?.();
  }
}

export interface ImgOptions {
  /** Thumbnail: fetches the server-side WebP preview AND caps the height
   * (.thumb class). Full bytes stay for big previews. */
  thumb?: boolean;
  /** Cache-buster, usually the file's mtime. */
  stamp?: string;
  /** Reserve the cell at this CSS aspect-ratio (e.g. '832 / 1216') so grids
   * never show zero-height blanks or jump when the bytes arrive. */
  aspect?: string;
  /** Fetch only when the cell first scrolls near the viewport. Default: on
   * for thumbnails. */
  lazy?: boolean;
  /** Drop the <img> again when the cell scrolls far away (decoded bitmaps
   * are the phone's real cost); it is fetched anew on return. Default: on
   * for thumbnails on a small screen. */
  unload?: boolean;
}

// --- visibility ------------------------------------------------------------------

interface Slot { load: () => void; unload?: () => void; loaded: boolean }
/** Cells with a picture that follows the viewport. Weak: a cell a redraw
 * threw away before it ever scrolled into view must not be pinned here. */
const slots = new WeakMap<Element, Slot>();
let io: IntersectionObserver | null = null;
try {
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const slot = slots.get(e.target);
      if (!slot) { io?.unobserve(e.target); continue; }
      if (e.isIntersecting) {
        if (!slot.loaded) {
          slot.loaded = true;
          slot.load();
        }
        if (!slot.unload) { io?.unobserve(e.target); slots.delete(e.target); }
      } else if (slot.loaded && slot.unload) {
        slot.loaded = false;
        slot.unload();
      }
    }
  }, { rootMargin: '600px' });
} catch {
  io = null; // linkedom (and very old engines): fetch immediately instead
}

/**
 * Run `load` when `elm` first comes near the viewport, and - given `unload`
 * - run it when the cell leaves and `load` again when it returns. Without an
 * IntersectionObserver `load` runs at once and nothing is ever unloaded.
 */
export function watchImage(elm: Element, load: () => void, unload?: () => void): void {
  // A tick later either way: cells are built before they are appended, and
  // a loader that checks `isConnected` at once would see false.
  if (!io) { setTimeout(load, 0); return; }
  slots.set(elm, { load, unload, loaded: false });
  io.observe(elm);
}

/** Whether pictures should let go of their bitmaps off screen. */
export function unloadByDefault(): boolean {
  return smallScreen();
}

/**
 * An <img> for a space file, filled in asynchronously. A blocked path, a
 * missing file, a test DOM without createObjectURL, or a viewer whose CSP
 * refuses blob: all degrade to `[이미지: …]` rather than a broken picture.
 */
export function workspaceImage(path: string, alt: string, opts: ImgOptions = {}): HTMLElement {
  path = normalizeWorkspacePath(path);
  const wrap = el('span', { class: 'wsimg' + (opts.thumb ? ' thumb' : '') + (opts.aspect ? ' phbox' : '') });
  if (opts.aspect) wrap.style.aspectRatio = opts.aspect;
  const fallback = () => {
    clear(wrap);
    wrap.appendChild(el('span', { class: 'hint', text: `[이미지: ${alt || path}]` }));
  };
  if (!safeWorkspacePath(path) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    fallback();
    return wrap;
  }
  const lazy = opts.lazy ?? !!opts.thumb;
  const unload = opts.unload ?? (!!opts.thumb && unloadByDefault());
  let gen = 0;
  let held = false;
  const start = (): void => {
    const my = ++gen;
    void blobUrl(path, opts.stamp, { thumb: opts.thumb }).then((url) => {
      if (my !== gen) return; // unloaded (or reloaded) meanwhile
      const img = el('img', { src: url, alt: alt || path, loading: 'lazy' }) as HTMLImageElement;
      img.addEventListener('error', fallback);
      clear(wrap);
      wrap.appendChild(img);
      if (held) { held = false; wrap.style.width = ''; wrap.style.height = ''; wrap.style.display = ''; }
    }).catch(fallback);
  };
  const stop = (): void => {
    gen += 1;
    // Keep the cell's size so the page does not jump when the picture goes.
    if (!opts.aspect && wrap.offsetWidth && wrap.offsetHeight) {
      wrap.style.width = wrap.offsetWidth + 'px';
      wrap.style.height = wrap.offsetHeight + 'px';
      wrap.style.display = 'inline-block';
      held = true;
    }
    clear(wrap);
  };
  if (lazy || unload) watchImage(wrap, start, unload ? stop : undefined);
  else start();
  return wrap;
}
