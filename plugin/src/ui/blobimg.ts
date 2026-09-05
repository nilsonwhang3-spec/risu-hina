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
 */
import { el, clear } from './dom';
import { state } from '../state';

const PARALLEL = 6;
let active = 0;
const queue: (() => void)[] = [];
/** path[:stamp] -> object URL (thumb keys carry a t: prefix). */
const cache = new Map<string, string>();
/** One fetch per key even when a grid rebuild asks again before it lands. */
const inflight = new Map<string, Promise<string>>();
/** Images only: short timeout so a hung fetch frees its 1-of-6 slot fast. */
const IMAGE_TIMEOUT_MS = 45_000;

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

/** The object URL for a space file's bytes, cached.
 *
 * A real LRU: a hit re-inserts its key so heavy grids do not evict what is
 * on screen, and an evicted URL is revoked on a DELAY - revoking at eviction
 * blanked pictures that were still in the DOM (the picture showed, the cache
 * turned over, the <img> went empty). Thirty seconds outlives any redraw. */
export interface BlobOptions {
  /** Fetch the server-side WebP thumbnail instead of the original bytes. */
  thumb?: boolean;
  /** Thumbnail width (default 360; 검수 asks for 720, §1-39). */
  w?: number;
}

export async function blobUrl(path: string, stamp = '', opts: BlobOptions = {}): Promise<string> {
  const key = (opts.thumb ? `t${opts.w || 360}:` : '') + (stamp ? `${path}:${stamp}` : path);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  // In-flight dedup: drawCentre() rebuilds used to fetch the same cell twice
  // - both callers passed the semaphore before either had filled the cache.
  const running = inflight.get(key);
  if (running) return running;
  const job = fetchBlob(path, key, opts);
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

async function fetchBlob(path: string, key: string, opts: BlobOptions): Promise<string> {
  await new Promise<void>((resolve) => {
    const go = () => { active += 1; resolve(); };
    if (active < PARALLEL) go(); else queue.push(go);
  });
  try {
    // A second waiter for the same key may have filled it meanwhile.
    const again = cache.get(key);
    if (again) return again;
    const bytes = opts.thumb
      ? await state.fileThumb(path, opts.w || 360)
      : await state.fileBytes(path, IMAGE_TIMEOUT_MS);
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(bytes);
    const url = URL.createObjectURL(new Blob([buf]));
    while (cache.size >= 600) {
      const [k, u] = cache.entries().next().value as [string, string];
      cache.delete(k);
      setTimeout(() => URL.revokeObjectURL(u), 30_000);
    }
    cache.set(key, url);
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
  /** Fetch only when the cell first scrolls near the viewport. */
  lazy?: boolean;
}

// --- lazy loading ----------------------------------------------------------------

/** Cells waiting for their first moment on screen. */
const pending = new Map<Element, () => void>();
let io: IntersectionObserver | null = null;
try {
  io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io?.unobserve(e.target);
      const cb = pending.get(e.target);
      pending.delete(e.target);
      cb?.();
    }
  }, { rootMargin: '300px' });
} catch {
  io = null; // linkedom (and very old engines): fetch immediately instead
}

/** Run `cb` when `elm` first comes near the viewport; immediately without IO. */
function whenVisible(elm: Element, cb: () => void): void {
  if (!io) { cb(); return; }
  pending.set(elm, cb);
  io.observe(elm);
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
  const start = (): void => {
    void blobUrl(path, opts.stamp, { thumb: opts.thumb }).then((url) => {
      const img = el('img', { src: url, alt: alt || path, loading: 'lazy' });
      img.addEventListener('error', fallback);
      clear(wrap);
      wrap.appendChild(img);
    }).catch(fallback);
  };
  if (opts.lazy) whenVisible(wrap, start);
  else start();
  return wrap;
}
