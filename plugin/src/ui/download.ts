/**
 * Saving a space file (or a zip) to the device - with the wait visible, and
 * a way that works on a phone (§1-62).
 *
 * Two problems the plain `<a download>` had:
 *
 *   - A big file took "한참" with nothing on screen: the bytes were fetched
 *     whole, then handed to the browser. Now a corner card shows the bytes
 *     as they arrive (Content-Length when the server sends it).
 *   - On iOS the anchor click inside the sandboxed iframe did nothing. The
 *     card ends in a 저장 button the user taps: that tap is a fresh user
 *     gesture, so `navigator.share` (the Files app, AirDrop) is allowed;
 *     without it, the anchor is clicked inside that gesture, which is what
 *     iOS honours. On a desktop the download still starts by itself.
 */
import { el, clear, ICON } from './dom';
import { downloadBytes } from '../host';
import { smallScreen } from './blobimg';
import { fmtSize } from './studio/store';

export interface Progress { loaded: number; total: number }

let card: HTMLElement | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function mount(): HTMLElement {
  if (card && card.isConnected) return card;
  card = el('div', { class: 'uploadpanel dlpanel' });
  document.body.appendChild(card);
  return card;
}

function dismiss(after = 0): void {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { card?.remove(); card = null; }, after);
}

/** Fetch with progress, then save - the one path every download button takes. */
export async function saveToDevice(
  name: string,
  fetch: (onProgress: (p: Progress) => void) => Promise<Uint8Array>,
  mime = 'application/octet-stream',
): Promise<number> {
  const box = mount();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  box.className = 'uploadpanel dlpanel';
  clear(box);
  const close = el('button', { class: 'iconbtn', html: ICON.close, title: '닫기' });
  close.addEventListener('click', () => dismiss(0));
  const head = el('div', { class: 'uphead' }, [el('span', { class: 'grow', text: `받는 중 · ${name}` }), close]);
  const line = el('div', { class: 'upline' }, [el('span', { class: 'grow', text: '서버가 파일을 준비하는 중입니다…' })]);
  const bar = el('div', { class: 'assetbar' }, [el('div', { class: 'assetfill', style: { width: '0%' } })]);
  const fill = bar.firstElementChild as HTMLElement;
  box.append(head, line, bar);
  let bytes: Uint8Array;
  try {
    bytes = await fetch((p) => {
      const pct = p.total > 0 ? Math.min(100, Math.round(p.loaded * 100 / p.total)) : 0;
      fill.style.width = p.total > 0 ? pct + '%' : '100%';
      bar.classList.toggle('indeterminate', !(p.total > 0));
      (line.firstElementChild as HTMLElement).textContent = p.total > 0
        ? `${fmtSize(p.loaded)} / ${fmtSize(p.total)} (${pct}%)`
        : `${fmtSize(p.loaded)} 받았습니다…`;
    });
  } catch (e) {
    box.classList.add('failed');
    (head.firstElementChild as HTMLElement).textContent = `받지 못했습니다 · ${name}`;
    (line.firstElementChild as HTMLElement).textContent = e instanceof Error ? e.message : String(e);
    bar.remove();
    dismiss(8000);
    throw e;
  }
  fill.style.width = '100%';
  box.classList.add('done');
  (head.firstElementChild as HTMLElement).textContent = `받았습니다 · ${name}`;
  (line.firstElementChild as HTMLElement).textContent = fmtSize(bytes.byteLength);
  if (!smallScreen()) {
    downloadBytes(name, bytes, mime);
    dismiss(3500);
    return bytes.byteLength;
  }
  // A phone: the save needs a tap of its own (see the module header).
  const save = el('button', { class: 'primary', text: '내 기기에 저장' }) as HTMLButtonElement;
  const hint = el('div', { class: 'hint', text: '공유 창이 열리면 “파일에 저장” 을 고르세요.' });
  save.addEventListener('click', () => {
    void (async () => {
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      try {
        const file = new File([buf], name, { type: mime });
        if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [file] }))) {
          await nav.share({ files: [file], title: name });
          dismiss(1500);
          return;
        }
      } catch (e) {
        // The user closed the sheet: nothing to report. Anything else falls
        // through to the anchor.
        if ((e as { name?: string })?.name === 'AbortError') return;
      }
      downloadBytes(name, bytes, mime);
      hint.textContent = '다운로드가 시작되지 않으면 브라우저의 다운로드 목록을 확인하세요.';
    })();
  });
  box.append(el('div', { class: 'row', style: { marginTop: '4px' } }, [save]), hint);
  return bytes.byteLength;
}
