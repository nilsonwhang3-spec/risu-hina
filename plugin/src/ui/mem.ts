/**
 * The plugin's own memory numbers (§1-55).
 *
 * Safari has no `performance.memory`, and an iPhone that runs out of memory
 * reloads the page without a word - so what the plugin can count is what the
 * log gets: the blob cache (count, bytes), the pictures and nodes in the
 * DOM, the agent log's length and the polls still running. Read every 30s
 * on a phone into `data/logs/risuhina.log` as `mem`, and shown live in
 * ⚙ → 정보 · 진단 정보.
 */
import { blobStats } from './blobimg';
import { activePolls } from './dom';

export interface MemSnapshot {
  blobCount: number;
  blobMB: number;
  blobCapMB: number;
  inflight: number;
  deferredRevokes: number;
  images: number;
  nodes: number;
  agentLog: number;
  polls: number;
  heapMB: number | null;
  visibility: string;
}

export function memSnapshot(): MemSnapshot {
  const b = blobStats();
  const perf = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  let visibility = '?';
  try { visibility = document.visibilityState; } catch { /* no document */ }
  return {
    blobCount: b.count,
    blobMB: Math.round(b.bytes / 1048576 * 10) / 10,
    blobCapMB: Math.round(b.byteCap / 1048576),
    inflight: b.inflight,
    deferredRevokes: b.deferredRevokes,
    images: document.images?.length ?? 0,
    nodes: document.getElementsByTagName('*').length,
    agentLog: document.querySelector('.agentlog')?.childElementCount ?? 0,
    polls: activePolls(),
    heapMB: perf ? Math.round(perf.usedJSHeapSize / 1048576) : null,
    visibility,
  };
}
