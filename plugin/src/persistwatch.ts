/**
 * After a write-back: did RisuAI's own save reach its server? (§1-80)
 *
 * A write-back is verified by reading the character back from the RisuAI tab
 * - its memory, not its server. On 2026-09-27 a RisuAI tab's save failed once
 * (Cloudflare 524 on a thrashing machine) and it then saved nothing for three
 * hours without a visible warning; every write in that window "verified" and
 * was lost on the next reload.
 *
 * The backend can read RisuAI's save time (`/risu/saved`) when the RisuAI save
 * directory is on its machine. The watch takes the server's clock before the
 * write, then polls: saved after that moment = fine (and a warning, if one is
 * up, clears); a minute without = a pinned warning not to reload or close.
 * On a setup where the backend cannot tell, nothing is shown.
 */
import { transport } from './transport';

interface Saved { available: boolean; savedAt: number | null; now: number; reason: string }

const WARN_AFTER_S = 60;
const WATCH_FOR_S = 15 * 60;
const POLL_MS = 5000;

let pending: { since: number; startedAt: number } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let banner: HTMLElement | null = null;

async function saved(): Promise<Saved | null> {
  try {
    return await transport.get<Saved>('/risu/saved', {}, 8000);
  } catch {
    return null;   // an older backend, or a blip: cannot tell
  }
}

/** The server's clock before a write ('' when the backend cannot tell). */
export async function persistBaseline(): Promise<number | null> {
  const s = await saved();
  return s?.available ? s.now : null;
}

function fmt(t: number | null): string {
  if (!t) return '?';
  const d = new Date(t * 1000);
  return d.toLocaleTimeString();
}

function showBanner(last: number | null): void {
  if (!banner) {
    banner = document.createElement('div');
    banner.className = 'persistwarn';
    document.body.appendChild(banner);
  }
  banner.textContent = '';
  const text = document.createElement('div');
  text.textContent = `⚠ RisuAI 가 방금 반영한 내용을 아직 서버에 저장하지 않았습니다 (마지막 서버 저장 ${fmt(last)}). `
    + 'RisuAI 탭의 저장이 멈췄을 수 있습니다 — 새로고침하거나 창을 닫으면 이 변경이 사라질 수 있습니다. '
    + 'RisuAI 에서 아무 설정이나 한 번 바꿔 저장을 다시 일으키거나, 봇을 내보내기로 먼저 보관해 주세요.';
  const close = document.createElement('button');
  close.className = 'ghost tiny';
  close.textContent = '닫기';
  close.addEventListener('click', () => { banner?.remove(); banner = null; });
  banner.append(text, close);
}

function clearBanner(ok: boolean): void {
  if (!banner) return;
  if (ok) {
    banner.className = 'persistwarn ok';
    banner.textContent = '✓ RisuAI 서버 저장을 확인했습니다.';
    const b = banner;
    setTimeout(() => { if (banner === b) { b.remove(); banner = null; } }, 5000);
  } else {
    banner.remove();
    banner = null;
  }
}

async function tick(): Promise<void> {
  timer = null;
  const p = pending;
  if (!p) return;
  const s = await saved();
  if (!s || !s.available) { pending = null; clearBanner(false); return; }
  if ((s.savedAt ?? 0) >= p.since) {
    pending = null;
    clearBanner(true);
    return;
  }
  const waited = s.now - p.since;
  if (waited >= WARN_AFTER_S) showBanner(s.savedAt);
  if (waited >= WATCH_FOR_S) { pending = null; return; }   // the banner stays until closed
  timer = setTimeout(() => void tick(), POLL_MS);
}

/** Start (or restart) the watch for a write that began at server time `since`. */
export function watchPersist(since: number | null): void {
  if (since === null) return;
  // Several writes in a row: the earliest unconfirmed one is what matters.
  if (!pending || since < pending.since) pending = { since, startedAt: Date.now() };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), POLL_MS);
}
