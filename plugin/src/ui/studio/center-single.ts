/**
 * The 1장 tab: one big picture and the edit-generate loop.
 *
 * The preview takes the width the collapsed rails free up; under it sit the
 * only controls a quick loop needs - 요청 설정 behind ⚙, the count beside
 * 생성 시작. The strip below shows the latest batch's results; clicking one
 * pins it into the preview (←/→ walks the batch), and the live run stops
 * hijacking the view while a pin holds (라이브 releases it).
 */
import { el, clear } from '../dom';
import { blobUrl, safeWorkspacePath } from '../blobimg';
import { S, hub, gen, persistGen, persistCentreTab, stateLabel } from './store';
import { statusRow, tokenNotice, startRun, cancelRun, pendingCount, loadJobs,
         livePreview } from './gen';

let previewBox: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;
let captionEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
let progressLine: HTMLElement | null = null;
let runBtn: HTMLButtonElement | null = null;
let stripBox: HTMLElement | null = null;
/** What the <img> currently shows: a workspace path, or 'live'. */
let shownKey = '';

export function drawSingle(mount: HTMLElement): void {
  shownKey = '';
  mount.appendChild(statusRow());
  const notice = tokenNotice();
  if (notice) mount.appendChild(notice);

  // One persistent <img>: frames and finished files swap its src, so a
  // completed image replaces the held stream frame without a blank flash.
  imgEl = el('img', { alt: '', style: { display: 'none' } }) as HTMLImageElement;
  captionEl = el('div', { class: 'hint previewname' });
  emptyEl = el('div', { class: 'empty' });
  previewBox = el('div', { class: 'bigpreview' }, [imgEl, captionEl, emptyEl]);
  mount.appendChild(previewBox);

  // ← live → : walking the pinned batch.
  const prev = el('button', { class: 'ghost tiny', text: '◀', title: '같은 배치의 이전 장' }) as HTMLButtonElement;
  const next = el('button', { class: 'ghost tiny', text: '▶', title: '같은 배치의 다음 장' }) as HTMLButtonElement;
  const live = el('button', { class: 'ghost tiny', text: '라이브', title: '고정을 풀고 진행 중인 생성을 따라갑니다' }) as HTMLButtonElement;
  prev.addEventListener('click', () => walk(-1));
  next.addEventListener('click', () => walk(1));
  live.addEventListener('click', () => { S.viewPath = ''; syncPreview(); });

  // The count and 생성 시작 live in the left column now (buildRunControls,
  // §1-39); this row keeps the walk and the progress line.
  progressLine = el('span', { class: 'hint' });
  mount.appendChild(el('div', { class: 'row', style: { margin: '8px 0', flexWrap: 'wrap' } }, [
    prev, live, next,
    el('span', { class: 'grow' }),
    progressLine,
  ]));

  stripBox = el('div', { class: 'stripthumbs' });
  mount.appendChild(stripBox);

  syncControls();
  syncPreview();
  void drawStrip();
}

/** The 1장 run controls - count ± and 생성 시작/취소 - mounted by the left
 * prompt column (§1-39). One live instance: the newest build owns runBtn. */
export function buildRunControls(): HTMLElement {
  const minus = el('button', { class: 'ghost tiny', text: '−' });
  const plus = el('button', { class: 'ghost tiny', text: '＋' });
  const count = el('input', { type: 'number', value: String(gen.count), min: '1', max: '99',
                              class: 'countbox', title: '장수' }) as HTMLInputElement;
  const setCount = (n: number) => {
    gen.count = Math.min(99, Math.max(1, Math.trunc(n) || 1));
    count.value = String(gen.count);
    persistGen();
  };
  minus.addEventListener('click', () => setCount(gen.count - 1));
  plus.addEventListener('click', () => setCount(gen.count + 1));
  count.addEventListener('change', () => setCount(Number(count.value)));

  runBtn = el('button', { class: 'primary tiny' }) as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (S.jobId) cancelRun();
    // The 1장 loop is the current setup only - no scene preset expansion.
    else void startRun({ scenePreset: '', count: gen.count });
  });
  const row = el('div', { class: 'row', style: { gap: '6px' } }, [
    el('span', { class: 'hint', text: '장수' }),
    el('div', { class: 'row', style: { gap: '2px' } }, [minus, count, plus]),
    el('span', { class: 'grow' }),
    runBtn,
  ]);
  syncControls();
  return row;
}

/** The live-job heartbeat (from pollJob): patch, never rebuild. */
export function singleTick(): void {
  if (!previewBox?.isConnected) return;
  syncControls();
  syncPreview();
  void drawStrip();
}

/** The run button (left column) and the progress line (1장 tab) are patched
 * independently: either may be absent while the other is on screen. */
export function syncControls(): void {
  const running = !!S.jobId;
  if (runBtn) {
    runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
    runBtn.textContent = running ? `취소 (${pendingCount()})` : '생성 시작';
    runBtn.classList.toggle('danger', running);
  }
  if (progressLine?.isConnected) {
    const p = S.queueJob?.payload;
    progressLine.textContent = running && p
      ? `${stateLabel(S.queueJob!.state)} · ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`
      : '';
  }
}

/**
 * What the big preview shows, by priority: the pin, then (while running) the
 * live stream frame (4.12), then the newest save. A finished file replaces a
 * held frame only once its blob has loaded - never a blank in between.
 */
function syncPreview(): void {
  const img = imgEl;
  if (!img || !previewBox?.isConnected || !captionEl || !emptyEl) return;
  const running = !!S.jobId;
  const saved = S.queueJob?.payload?.saved ?? [];
  const pinned = S.viewPath;
  const showEmpty = (text: string) => {
    if (shownKey) return; // something is on screen - never blank it for a hint
    emptyEl!.textContent = text;
    emptyEl!.style.display = '';
    img.style.display = 'none';
    captionEl!.style.display = 'none';
  };
  const showImg = (key: string, src: string, caption: string) => {
    shownKey = key;
    img.src = src;
    img.style.display = '';
    emptyEl!.style.display = 'none';
    captionEl!.textContent = caption;
    captionEl!.style.display = '';
  };

  if (!pinned && running && livePreview.url) {
    // The live frame - unless a pin holds the view (openImage mid-run).
    showImg('live', livePreview.url,
            `생성 중 ${livePreview.step}/${livePreview.total}${livePreview.current ? ' · ' + livePreview.current : ''}`);
    return;
  }
  const path = pinned || saved[saved.length - 1] || '';
  if (!path) {
    showEmpty(running
      ? '생성 중입니다… 첫 프레임이 오면 여기 나타납니다.'
      : '생성 시작을 누르거나, 아래 결과에서 한 장을 고르세요.');
    return;
  }
  if (path === shownKey || !safeWorkspacePath(path)) return;
  const want = path;
  void blobUrl(want).then((url) => {
    if (!img.isConnected) return;
    // Still what we want? (the user may have pinned elsewhere meanwhile)
    const nowPath = S.viewPath || (S.queueJob?.payload?.saved ?? []).slice(-1)[0] || '';
    if ((S.viewPath || !(S.jobId && livePreview.url)) && nowPath === want) {
      showImg(want, url, want);
    }
  }).catch(() => {
    if (shownKey === '') showEmpty('이미지를 읽지 못했습니다: ' + want);
  });
}

function walk(dir: 1 | -1): void {
  const list = S.viewList.length ? S.viewList : (S.queueJob?.payload?.saved ?? []);
  if (!list.length) return;
  const cur = S.viewPath || shownKey;
  const at = Math.max(0, list.indexOf(cur));
  const to = Math.min(list.length - 1, Math.max(0, at + dir));
  S.viewPath = list[to];
  if (!S.viewList.length) S.viewList = [...list];
  syncPreview();
}

/** The latest batch's results, as a click-to-pin strip (4.9). */
async function drawStrip(): Promise<void> {
  const box = stripBox;
  if (!box?.isConnected) return;
  let saved = S.queueJob?.payload?.saved ?? [];
  let label = '이번 배치';
  if (!saved.length) {
    const jobs = await loadJobs();
    const last = jobs.find((j) => (j.payload?.saved?.length ?? 0) > 0);
    saved = last?.payload?.saved ?? [];
    label = '최근 배치';
  }
  if (!box.isConnected) return;
  clear(box);
  if (!saved.length) return;
  box.appendChild(el('div', { class: 'hint', style: { marginBottom: '4px' }, text: `${label} 결과 ${saved.length}장` }));
  const row = el('div', { class: 'striprow' });
  for (const path of saved.slice(-24)) {
    const cell = el('button', { class: 'stripcell' + (path === (S.viewPath || shownKey) ? ' on' : ''), title: path });
    void blobUrl(path, '', { thumb: true }).then((url) => {
      if (!cell.isConnected) return;
      cell.appendChild(el('img', { src: url, alt: path.split('/').pop() ?? path }));
    }).catch(() => { /* the strip survives a missing file */ });
    cell.addEventListener('click', () => {
      S.viewPath = path;
      S.viewList = [...saved];
      syncPreview();
      for (const c of row.children) c.classList.toggle('on', (c as HTMLElement).title === path);
    });
    row.appendChild(cell);
  }
  box.appendChild(row);
}

/** Open one image big in the 1장 tab, ←/→ walking `list` (4.4a). The pin
 * keeps a mid-run click from being overwritten by the stream. */
export function openImage(path: string, list: string[]): void {
  S.viewPath = path;
  S.viewList = [...list];
  S.centreTab = 'single';
  S.centreMode = 'tab';
  persistCentreTab();
  hub.drawCentre();
}
