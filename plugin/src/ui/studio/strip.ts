/**
 * 최근 생성 스트립 - the fixed bar under every centre view.
 *
 * The 잡 히스토리 tab is gone (§1-29 item 5): what replaced it is this one
 * row of the newest saved images across recent jobs, always visible, newest
 * first, clicking one opens it big in the 1장 tab. While a batch runs, cell
 * zero carries the streaming frame with its step counter. The old tab's
 * per-job fold-outs survive as jobSection, drawn by the batch tab's live box.
 */
import { el, clear } from '../dom';
import { blobUrl } from '../blobimg';
import { type StudioJob } from '../../state';
import { S, stateLabel } from './store';
import { loadJobs, livePreview } from './gen';
import { openImage } from './center-single';

const FOLD_KEY = 'hina.studioStrip';
/** How many finished cells the strip holds. */
const CAP = 20;

let folded = false;
try { folded = localStorage.getItem(FOLD_KEY) === '1'; } catch { /* fine */ }

let root: HTMLElement | null = null;
let headLine: HTMLElement | null = null;
let rowBox: HTMLElement | null = null;
let liveImg: HTMLImageElement | null = null;
let liveBadge: HTMLElement | null = null;
let lastKey = '';

/** Recent jobs newest-first, with the polled running job's fresher payload. */
function jobsNow(): StudioJob[] {
  const jobs = [...S.jobs];
  const q = S.queueJob;
  if (q) {
    const ix = jobs.findIndex((j) => j.id === q.id);
    if (ix >= 0) jobs[ix] = q;
    else jobs.unshift(q);
  }
  return jobs;
}

/** The strip's shell; index.ts mounts it once, AFTER the scrolling centre. */
export function buildStrip(): HTMLElement {
  const fold = el('button', { class: 'ghost tiny', text: folded ? '▴' : '▾',
                              title: '최근 생성 접기/펼치기' });
  fold.addEventListener('click', () => {
    folded = !folded;
    try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0'); } catch { /* fine */ }
    root?.classList.toggle('folded', folded);
    fold.textContent = folded ? '▴' : '▾';
  });
  headLine = el('span', { class: 'hint grow', text: '최근 생성' });
  rowBox = el('div', { class: 'striprow' });
  root = el('div', { class: 'genstrip' + (folded ? ' folded' : '') }, [
    el('div', { class: 'row striphead' }, [headLine, fold]),
    rowBox,
  ]);
  return root;
}

/** Re-read the (cached) job list and redraw if anything moved. */
export async function refreshStrip(): Promise<void> {
  if (!root) return;
  await loadJobs();
  renderStrip();
}

/** The heartbeat: cells rebuild only when a job or a save moves; the live
 * frame and its step counter patch in place on every preview tick. */
export function stripTick(): void {
  if (!root?.isConnected) return;
  renderStrip();
  if (S.jobId && livePreview.url && liveImg) {
    liveImg.src = livePreview.url;
    if (liveBadge) liveBadge.textContent = `${livePreview.step}/${livePreview.total}`;
  }
}

function renderStrip(): void {
  if (!rowBox || !headLine) return;
  const jobs = jobsNow();
  const key = (S.jobId ? 'run|' : '')
    + jobs.map((j) => j.id + ':' + (j.payload?.saved?.length ?? 0)).join('|');
  if (key === lastKey) return;
  lastKey = key;

  let count = 0;
  for (const j of jobs) count += j.payload?.saved?.length ?? 0;
  const head = jobs[0];
  const parts = [`최근 생성 ${count}장`];
  if (head) {
    const p = head.payload;
    parts.push(stateLabel(head.state) + (S.jobId && p ? ` ${p.done}/${p.total}` : ''));
  }
  headLine.textContent = parts.join(' · ');

  clear(rowBox);
  liveImg = null;
  liveBadge = null;
  if (S.jobId) {
    liveImg = el('img', { alt: '' }) as HTMLImageElement;
    if (livePreview.url) liveImg.src = livePreview.url;
    liveBadge = el('span', { class: 'badge warn stripbadge',
                             text: `${livePreview.step}/${livePreview.total}` });
    rowBox.appendChild(el('div', { class: 'stripcell live' }, [liveImg, liveBadge]));
  }
  let shown = 0;
  for (const j of jobs) {
    const saved = j.payload?.saved ?? [];
    for (let i = saved.length - 1; i >= 0; i--) {
      if (shown >= CAP) return;
      shown += 1;
      const path = saved[i];
      const cell = el('button', { class: 'stripcell', title: path });
      void blobUrl(path, '', { thumb: true }).then((url) => {
        if (!cell.isConnected) return;
        cell.appendChild(el('img', { src: url, alt: path.split('/').pop() ?? path }));
      }).catch(() => { /* the strip survives a missing file */ });
      cell.addEventListener('click', () => openImage(path, saved));
      rowBox.appendChild(cell);
    }
  }
}
