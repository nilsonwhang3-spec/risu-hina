/**
 * Asset references and the background importer.
 *
 * The bot's images reach the backend store here, after the text did. The
 * shape follows what M0 measured (2026-08-24, 2980 assets / 142.6MB from a
 * risu.xyz account): reading out of the host is the slow side - 862ms per
 * asset, 42.8 minutes in all - and uploading is the fast side (2.6 minutes).
 * So the importer's whole job is to read from the host as little as it can:
 *
 *   1. manifest      tell the backend every key the card references. It
 *                    answers with what it already has, fills what it can from
 *                    a PocketRisu database next door (fast path), and - for
 *                    web users - starts pulling the rest from the RisuAI hub
 *                    itself, with no browser bandwidth involved.
 *   2. wait          while the backend pulls, poll its status.
 *   3. push          whatever is still missing: readImage with a few in
 *                    flight (never one at a time), batched by BYTES into
 *                    uploads, then report the keys the host could not read.
 *
 * Content addressing makes all of this restartable: opening the panel again
 * sends nothing the store already has, and a sync cut off half way resumes
 * where it stopped. The gate on the bot bar's 반영 opens when the backend
 * says `complete` - nothing missing and no pull running. Failed keys are
 * shown, not waited for.
 */
import type { RisuCharacter } from './risuai';
import { transport, BackendError } from './transport';

export interface AssetRef {
  /** Which character field referenced it. */
  field: 'image' | 'emotion' | 'additional' | 'cc' | 'vits';
  /** Display name when the field carries one. */
  name: string;
  /** Storage key, `assets/<hash>.<ext>`. */
  key: string;
}

/**
 * Every asset key a character references, deduplicated.
 *
 * The field list mirrors RisuAI's own GC root scan (getUncleanables):
 * image, emotionImages, additionalAssets, ccAssets, vits.files. CBS text
 * references assets by NAME, not key, so text never needs scanning.
 */
export function extractAssetRefs(char: RisuCharacter): AssetRef[] {
  const out: AssetRef[] = [];
  const seen = new Set<string>();
  const push = (field: AssetRef['field'], name: string, key: unknown): void => {
    if (typeof key !== 'string' || !key.startsWith('assets/')) return;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ field, name, key });
  };

  push('image', '프로필', char.image);
  for (const e of asArray(char['emotionImages'])) {
    if (Array.isArray(e)) push('emotion', String(e[0] ?? ''), e[1]);
  }
  for (const a of asArray(char['additionalAssets'])) {
    if (Array.isArray(a)) push('additional', String(a[0] ?? ''), a[1]);
  }
  for (const c of asArray(char['ccAssets'])) {
    if (c && typeof c === 'object') {
      const cc = c as { name?: unknown; uri?: unknown };
      push('cc', String(cc.name ?? ''), cc.uri);
    }
  }
  const vits = char['vits'] as { files?: Record<string, unknown> } | undefined;
  if (vits && vits.files && typeof vits.files === 'object') {
    for (const [k, v] of Object.entries(vits.files)) push('vits', k, v);
  }
  return out;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Chunked btoa. `String.fromCharCode(...bytes)` blows the call stack on a
 * real asset, and TextDecoder cannot produce latin-1 for btoa.
 */
export function b64encode(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const part = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, part as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * Batch bounds. Bytes first: at the measured 48KB average, a 50-item cap
 * would fill 2.4MB of an 8MB batch, so the count is only a backstop for
 * bots with many tiny files. 8MB raw is ~11MB base64 - well inside the
 * backend's 64MB body limit and Cloudflare's 100MB.
 */
export const BATCH_BYTES = 8 * 1024 * 1024;
export const BATCH_ITEMS = 50;

// --- the importer -----------------------------------------------------------

export type SyncPhase = 'manifest' | 'pulling' | 'pushing' | 'done' | 'cancelled' | 'error' | 'unsupported';

export interface SyncProgress {
  charKey: string;
  phase: SyncPhase;
  /** Keys the card references (deduplicated). */
  total: number;
  present: number;
  missing: number;
  failed: number;
  /** Bytes the store holds for this bot. */
  bytes: number;
  /** This run's own work. */
  read: number;
  readFailed: number;
  sent: number;
  sentBytes: number;
  toPush: number;
  fastFilled: number;
  pull: { total: number; done: number; ok: number; notFound: number; failed: number } | null;
  /** What the backend said at the end: nothing missing, no pull running. */
  complete: boolean;
  error: string;
  startedAt: number;
  finishedAt: number;
}

export interface SyncController {
  cancel(): void;
  done: Promise<SyncProgress>;
}

interface ManifestReply {
  total: number; present: number; missing: string[] | number; failed: number; bytes: number;
  pulling: boolean; pull: SyncProgress['pull']; complete: boolean; fastFilled?: number;
}

interface StatusReply {
  total: number; present: number; missing: number; failed: number; bytes: number;
  pulling: boolean; pull: SyncProgress['pull']; complete: boolean;
}

export interface SyncOptions {
  /** Ask the backend to pull from the RisuAI hub (web / account users). */
  hubPull: boolean;
  /** readImage calls in flight at once. */
  concurrency: number;
  /** Status poll interval while the backend pulls. */
  pollMs?: number;
}

/**
 * Sync one bot's assets into the backend store. Progress is reported through
 * the callback (the same object, mutated); the promise resolves with it.
 * Never rejects - an error is a phase.
 */
export function syncAssets(
  char: RisuCharacter,
  charKey: string,
  opts: SyncOptions,
  onProgress: (p: SyncProgress) => void,
): SyncController {
  let cancelled = false;
  const p: SyncProgress = {
    charKey, phase: 'manifest', total: 0, present: 0, missing: 0, failed: 0, bytes: 0,
    read: 0, readFailed: 0, sent: 0, sentBytes: 0, toPush: 0, fastFilled: 0, pull: null,
    complete: false, error: '', startedAt: Date.now(), finishedAt: 0,
  };
  const report = (): void => { try { onProgress(p); } catch { /* a listener must not stop the sync */ } };
  const absorb = (r: StatusReply | ManifestReply): void => {
    p.total = r.total;
    p.present = r.present;
    p.missing = Array.isArray(r.missing) ? r.missing.length : r.missing;
    p.failed = r.failed;
    p.bytes = r.bytes;
    p.pull = r.pull ?? null;
    p.complete = !!r.complete;
  };
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

  const done = (async (): Promise<SyncProgress> => {
    try {
      const refs = extractAssetRefs(char);
      p.total = refs.length;
      report();

      let m = await transport.upload<ManifestReply>('/assets/manifest', {
        charKey, refs, hubPull: opts.hubPull,
      });
      absorb(m);
      p.fastFilled = m.fastFilled ?? 0;
      report();

      // The backend is pulling from the hub: wait it out, then ask again for
      // what is left - that is the list we have to read ourselves.
      if (m.pulling) {
        p.phase = 'pulling';
        report();
        while (!cancelled) {
          await sleep(opts.pollMs ?? 1500);
          const s = await transport.get<StatusReply>('/assets/status', { charKey });
          absorb(s);
          report();
          if (!s.pulling) break;
        }
        if (cancelled) return finish('cancelled');
        m = await transport.upload<ManifestReply>('/assets/manifest', { charKey, refs, hubPull: false });
        absorb(m);
        report();
      }

      const missing = Array.isArray(m.missing) ? m.missing : [];
      p.toPush = missing.length;
      if (missing.length) {
        p.phase = 'pushing';
        report();
        await push(missing);
        if (cancelled) return finish('cancelled');
      }

      const s = await transport.get<StatusReply>('/assets/status', { charKey });
      absorb(s);
      return finish('done');
    } catch (e) {
      if (e instanceof BackendError && e.status === 404) {
        // An older backend without the store: nothing to sync against, and
        // nothing to gate on.
        return finish('unsupported', '백엔드에 에셋 스토어가 없습니다 (백엔드를 업데이트해 주세요)');
      }
      return finish('error', e instanceof Error ? e.message : String(e));
    }
  })();

  function finish(phase: SyncPhase, error = ''): SyncProgress {
    p.phase = phase;
    p.error = error;
    p.finishedAt = Date.now();
    if (phase === 'unsupported') p.complete = true;
    report();
    return p;
  }

  /**
   * Read the missing keys out of the host with a few in flight and ship them
   * in byte-bounded batches. One batch is being filled while another is in
   * transit; nothing is retained after its upload.
   */
  async function push(keys: string[]): Promise<void> {
    const failed: string[] = [];
    let batch: { key: string; data: string }[] = [];
    let batchBytes = 0;
    let uploading: Promise<void> = Promise.resolve();
    let inTransit = 0;

    const flush = (): void => {
      if (!batch.length) return;
      const items = batch;
      const bytes = batchBytes;
      batch = [];
      batchBytes = 0;
      inTransit += 1;
      uploading = uploading.then(async () => {
        try {
          const r = await transport.upload<{ stored: number; bad: { key: string; error: string }[] }>(
            '/assets/upload', { charKey, items },
          );
          p.sent += r.stored;
          p.sentBytes += bytes;
          for (const b of r.bad ?? []) failed.push(b.key);
        } finally {
          inTransit -= 1;
        }
        report();
      });
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (!cancelled) {
        const i = next++;
        if (i >= keys.length) return;
        const key = keys[i];
        let bytes: Uint8Array | null = null;
        try {
          const raw = await Risuai.readImage(key);
          if (raw && (raw as Uint8Array).byteLength) {
            bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
          }
        } catch { /* counted below */ }
        if (!bytes) {
          failed.push(key);
          p.readFailed += 1;
          report();
          continue;
        }
        p.read += 1;
        batch.push({ key, data: b64encode(bytes) });
        batchBytes += bytes.byteLength;
        if (batchBytes >= BATCH_BYTES || batch.length >= BATCH_ITEMS) flush();
        report();
        // Reading overlaps uploading, but not without bound: with two batches
        // already on the wire, wait rather than fill a third in memory.
        if (inTransit >= 2) await uploading;
      }
    };
    const n = Math.max(1, Math.min(8, opts.concurrency));
    await Promise.all(Array.from({ length: n }, () => worker()));
    if (!cancelled) flush();
    await uploading;

    if (failed.length && !cancelled) {
      try {
        await transport.post('/assets/fail', {
          charKey, keys: failed, reason: 'readImage returned nothing',
        });
      } catch { /* reported by the next status anyway */ }
    }
  }

  return { cancel: () => { cancelled = true; }, done };
}

export function describeSync(p: SyncProgress | null): string {
  if (!p) return '';
  const mb = (n: number) => (n / 1048576).toFixed(1) + 'MB';
  switch (p.phase) {
    case 'manifest':
      return `에셋 목록 대조 중 · ${p.total}개`;
    case 'pulling': {
      const d = p.pull;
      return d
        ? `백엔드가 허브에서 받는 중 ${d.done}/${d.total}` + (d.notFound ? ` · 없음 ${d.notFound}` : '')
        : '백엔드가 허브에서 받는 중';
    }
    case 'pushing':
      return `에셋 임포트 중 ${p.read + p.readFailed}/${p.toPush} · 전송 ${mb(p.sentBytes)}`;
    case 'done': {
      if (!p.total) return '참조하는 에셋 없음';
      // Where this run's bytes came from, so a 0.6s sync of 312 images does
      // not look like magic (or like the wrong store). Every source is
      // verified against the key's SHA-256 by the backend.
      const src: string[] = [];
      if (p.fastFilled) src.push(`같은 PC 의 PocketRisu DB ${p.fastFilled}`);
      if (p.pull && p.pull.ok) src.push(`허브 ${p.pull.ok}`);
      if (p.sent) src.push(`이 브라우저 ${p.sent}`);
      return `에셋 ${p.present}/${p.total}개 · ${mb(p.bytes)}`
        + (src.length ? ` · 이번에 ${src.join(', ')}` : ' · 이미 있었음')
        + (p.failed ? ` · 읽기 실패 ${p.failed}` : '');
    }
    case 'cancelled':
      return `에셋 임포트 중단됨 (${p.present}/${p.total})`;
    case 'unsupported':
      return p.error;
    case 'error':
      return '에셋 임포트 실패: ' + p.error;
  }
  return '';
}

/** Whether a sync is still working - what the bot bar's gate reads. */
export function syncBusy(p: SyncProgress | null): boolean {
  return !!p && (p.phase === 'manifest' || p.phase === 'pulling' || p.phase === 'pushing');
}

// --- M0 measurement (kept: the settings tab's probe) ------------------------

export interface DumpReport {
  refs: number;
  readOk: number;
  readFail: string[];
  bytes: number;
  readMs: number;
  uploadMs: number;
  wallMs: number;
  batches: number;
  /** What the backend said it saw - address tells relay from direct. */
  echoAddr: string;
  rsProbe: Record<string, unknown> | null;
  cancelled: boolean;
}

export interface DumpController {
  cancel(): void;
  done: Promise<DumpReport>;
}

/**
 * Sequentially read every referenced asset and push it through the echo
 * endpoint in batches, timing both sides separately. Sequential on purpose:
 * it measures the per-asset cost of the host, which is the number the
 * importer's design rests on.
 */
export function measureAssetDump(
  char: RisuCharacter,
  onProgress: (text: string) => void,
): DumpController {
  let cancelled = false;
  const done = (async (): Promise<DumpReport> => {
    const refs = extractAssetRefs(char);
    const rep: DumpReport = {
      refs: refs.length, readOk: 0, readFail: [], bytes: 0,
      readMs: 0, uploadMs: 0, wallMs: 0, batches: 0,
      echoAddr: '', rsProbe: null, cancelled: false,
    };
    const t0 = Date.now();

    let batch: { key: string; data: string }[] = [];
    let batchBytes = 0;
    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      batchBytes = 0;
      const u0 = Date.now();
      const res = await transport.upload<{ bytes: number; addr?: string }>(
        '/diag/asset-echo', { items },
      );
      rep.uploadMs += Date.now() - u0;
      rep.batches += 1;
      if (res && typeof res.addr === 'string') rep.echoAddr = res.addr;
    };

    for (const [i, ref] of refs.entries()) {
      if (cancelled) { rep.cancelled = true; break; }
      onProgress(`읽는 중 ${i + 1}/${refs.length} · ${(rep.bytes / 1048576).toFixed(1)}MB`);
      const r0 = Date.now();
      let bytes: Uint8Array | null = null;
      try {
        const raw = await Risuai.readImage(ref.key);
        if (raw && (raw as Uint8Array).byteLength) {
          bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
        }
      } catch { /* recorded below */ }
      rep.readMs += Date.now() - r0;
      if (!bytes) {
        rep.readFail.push(ref.key);
        continue;
      }
      rep.readOk += 1;
      rep.bytes += bytes.byteLength;
      batch.push({ key: ref.key, data: b64encode(bytes) });
      batchBytes += bytes.byteLength;
      if (batchBytes >= BATCH_BYTES || batch.length >= BATCH_ITEMS) {
        onProgress(`전송 중 ${i + 1}/${refs.length} · ${(rep.bytes / 1048576).toFixed(1)}MB`);
        await flush();
      }
    }
    if (!cancelled) await flush();

    // Whether the backend can pull from the RisuAI hub itself - the path that
    // spares the browser entirely for account-synced bots.
    if (refs.length) {
      try {
        rep.rsProbe = await transport.get<Record<string, unknown>>(
          '/diag/rs-probe', { key: refs[0].key },
        );
      } catch (e) {
        rep.rsProbe = { error: String(e instanceof Error ? e.message : e) };
      }
    }

    rep.wallMs = Date.now() - t0;
    return rep;
  })();
  return { cancel: () => { cancelled = true; }, done };
}
