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
/** path[:stamp] -> object URL. */
const cache = new Map<string, string>();

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
export async function blobUrl(path: string, stamp = ''): Promise<string> {
  const key = stamp ? `${path}:${stamp}` : path;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  await new Promise<void>((resolve) => {
    const go = () => { active += 1; resolve(); };
    if (active < PARALLEL) go(); else queue.push(go);
  });
  try {
    // A second waiter for the same key may have filled it meanwhile.
    const again = cache.get(key);
    if (again) return again;
    const bytes = await state.fileBytes(path);
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
  /** Thumbnail sizing (the .thumb class caps the height). */
  thumb?: boolean;
  /** Cache-buster, usually the file's mtime. */
  stamp?: string;
}

/**
 * An <img> for a space file, filled in asynchronously. A blocked path, a
 * missing file, a test DOM without createObjectURL, or a viewer whose CSP
 * refuses blob: all degrade to `[이미지: …]` rather than a broken picture.
 */
export function workspaceImage(path: string, alt: string, opts: ImgOptions = {}): HTMLElement {
  path = normalizeWorkspacePath(path);
  const wrap = el('span', { class: 'wsimg' + (opts.thumb ? ' thumb' : '') });
  const fallback = () => {
    clear(wrap);
    wrap.appendChild(el('span', { class: 'hint', text: `[이미지: ${alt || path}]` }));
  };
  if (!safeWorkspacePath(path) || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    fallback();
    return wrap;
  }
  void blobUrl(path, opts.stamp).then((url) => {
    const img = el('img', { src: url, alt: alt || path, loading: 'lazy' });
    img.addEventListener('error', fallback);
    clear(wrap);
    wrap.appendChild(img);
  }).catch(fallback);
  return wrap;
}
