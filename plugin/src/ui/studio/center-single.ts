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
import { statusRow, tokenNotice, openParamsDialog, startRun, cancelRun, pendingCount, loadJobs } from './gen';

let previewBox: HTMLElement | null = null;
let progressLine: HTMLElement | null = null;
let runBtn: HTMLButtonElement | null = null;
let stripBox: HTMLElement | null = null;
/** The image the preview currently shows (to skip pointless reloads). */
let shownPath = '';

export function drawSingle(mount: HTMLElement): void {
  shownPath = '';
  mount.appendChild(statusRow());
  const notice = tokenNotice();
  if (notice) mount.appendChild(notice);

  previewBox = el('div', { class: 'bigpreview' });
  mount.appendChild(previewBox);

  // ← live → : walking the pinned batch.
  const prev = el('button', { class: 'ghost tiny', text: '◀', title: '같은 배치의 이전 장' }) as HTMLButtonElement;
  const next = el('button', { class: 'ghost tiny', text: '▶', title: '같은 배치의 다음 장' }) as HTMLButtonElement;
  const live = el('button', { class: 'ghost tiny', text: '라이브', title: '고정을 풀고 진행 중인 생성을 따라갑니다' }) as HTMLButtonElement;
  prev.addEventListener('click', () => walk(-1));
  next.addEventListener('click', () => walk(1));
  live.addEventListener('click', () => { S.viewPath = ''; syncPreview(); });

  const params = el('button', { class: 'ghost tiny', text: '⚙ 요청 설정' });
  params.addEventListener('click', () => openParamsDialog());
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

  progressLine = el('span', { class: 'hint' });
  mount.appendChild(el('div', { class: 'row', style: { margin: '8px 0', flexWrap: 'wrap' } }, [
    prev, live, next,
    el('span', { class: 'grow' }),
    progressLine,
    params,
    el('div', { class: 'row', style: { gap: '2px' } }, [minus, count, plus]),
    runBtn,
  ]));

  stripBox = el('div', { class: 'stripthumbs' });
  mount.appendChild(stripBox);

  syncControls();
  syncPreview();
  void drawStrip();
}

/** The live-job heartbeat (from pollJob): patch, never rebuild. */
export function singleTick(): void {
  if (!previewBox?.isConnected) return;
  syncControls();
  syncPreview();
  void drawStrip();
}

function syncControls(): void {
  if (!runBtn?.isConnected || !progressLine) return;
  const running = !!S.jobId;
  runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
  runBtn.textContent = running ? `취소 (${pendingCount()})` : '생성 시작';
  runBtn.classList.toggle('danger', running);
  const p = S.queueJob?.payload;
  progressLine.textContent = running && p
    ? `${stateLabel(S.queueJob!.state)} · ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`
    : '';
}

/** What the big preview shows: the pinned image, else the run's newest save. */
function syncPreview(): void {
  const box = previewBox;
  if (!box?.isConnected) return;
  const saved = S.queueJob?.payload?.saved ?? [];
  const path = S.viewPath || saved[saved.length - 1] || '';
  if (path && path === shownPath) return;
  shownPath = path;
  clear(box);
  if (!path) {
    box.appendChild(el('div', { class: 'empty', text: S.jobId
      ? '생성 중입니다… 첫 장이 저장되면 여기 나타납니다.'
      : '생성 시작을 누르거나, 아래 결과에서 한 장을 고르세요.' }));
    return;
  }
  if (!safeWorkspacePath(path)) return;
  void blobUrl(path).then((url) => {
    if (shownPath !== path || !box.isConnected) return;
    clear(box);
    const img = el('img', { src: url, alt: path.split('/').pop() ?? path });
    box.appendChild(img);
    box.appendChild(el('div', { class: 'hint previewname', text: path }));
  }).catch(() => {
    clear(box);
    box.appendChild(el('div', { class: 'empty', text: '이미지를 읽지 못했습니다: ' + path }));
  });
}

function walk(dir: 1 | -1): void {
  const list = S.viewList.length ? S.viewList : (S.queueJob?.payload?.saved ?? []);
  if (!list.length) return;
  const cur = S.viewPath || shownPath;
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
    const cell = el('button', { class: 'stripcell' + (path === (S.viewPath || shownPath) ? ' on' : ''), title: path });
    void blobUrl(path).then((url) => {
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
