/**
 * Asset references and transfer measurement.
 *
 * M0 of the bot-edit plan: before the real asset store exists, measure what
 * the wire can actually do - how fast `readImage` hands assets out of this
 * host, and how fast batched base64 POSTs reach the backend. The extractor
 * and the read->batch->upload loop here are the prototypes the M2 background
 * importer promotes, which is why they live outside the UI files.
 */
import type { RisuCharacter } from './risuai';
import { transport } from './transport';

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

/** Batch bounds shared with the M2 plan: raw bytes before base64, and count. */
export const BATCH_BYTES = 8 * 1024 * 1024;
export const BATCH_ITEMS = 50;

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
 * endpoint in batches, timing both sides separately.
 *
 * Sequential on purpose: this is the shape the background importer will use
 * (bounded memory - one batch in flight, nothing retained after upload), so
 * the numbers measured here are the numbers that flow matters for.
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
    // would spare the browser entirely for account-synced bots.
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
