/**
 * The 1장 tab: one big picture and the edit-generate loop.
 *
 * The preview takes the width the collapsed rails free up; under it sit the
 * only controls a quick loop needs - 요청 설정 behind ⚙, the count beside
 * 생성 시작. The strip below shows the latest batch's results; clicking one
 * pins it into the preview (←/→ walks the batch), and the live run stops
 * hijacking the view while a pin holds (라이브 releases it).
 */
import { el } from '../dom';
import { blobUrl, safeWorkspacePath, smallScreen } from '../blobimg';
import { S, gen, persistGen, stateLabel } from './store';
import { showArtifact } from '../artifact';
import { statusRow, tokenNotice, startRun, cancelRun, pendingCount,
         livePreview, releasePreview } from './gen';

let previewBox: HTMLElement | null = null;
let imgEl: HTMLImageElement | null = null;
let captionEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;
/** The line over the picture: 마무리 중 / 완성본 불러오는 중 / an error + 다시. */
let stateEl: HTMLElement | null = null;
/** The finished file a load is under way (or failed) for. */
let loadingPath = '';
let failedPath = '';
let progressLine: HTMLElement | null = null;
let runBtn: HTMLButtonElement | null = null;
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
  imgEl.style.cursor = 'zoom-in';
  imgEl.addEventListener('click', () => { if (shownKey && shownKey !== 'live') openImage(shownKey, S.viewList); });
  captionEl = el('div', { class: 'hint previewname' });
  emptyEl = el('div', { class: 'empty' });
  stateEl = el('div', { class: 'previewstate', style: { display: 'none' } });
  loadingPath = '';
  failedPath = '';
  previewBox = el('div', { class: 'bigpreview' }, [imgEl, stateEl, captionEl, emptyEl]);
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


  syncControls();
  syncPreview();
}

/** The 1장 run controls - count ± and 생성 시작/취소 - mounted by the left
 * prompt column (§1-39). One live instance: the newest build owns runBtn. */
export function buildRunControls(): HTMLElement {
  const minus = el('button', { class: 'ghost', text: '−', title: '한 장 줄이기' });
  const plus = el('button', { class: 'ghost', text: '+', title: '한 장 늘리기' });
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
    if (S.jobId) void cancelRun();
    // The 1장 loop is the current setup only - no scene preset expansion.
    else void startRun({ scenePreset: '', count: gen.count });
  });
  // − 장수 + is one joined stepper of one height (user: "장수 토글 때문에
  // 높이가 다른게 못생겨 보임" - the number box was taller than its buttons).
  const row = el('div', { class: 'row runctl' }, [
    el('span', { class: 'studiosectitle', text: '장수' }),
    el('div', { class: 'stepper' }, [minus, count, plus]),
    el('span', { class: 'grow' }),
    runBtn,
  ]);
  syncControls();
  return row;
}

/** The live-job heartbeat (from pollJob): patch, never rebuild. */
export function singleTick(): void {
  syncControls();
  if (!previewBox?.isConnected) return;
  syncPreview();
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
 *
 * §1-101 (field report: "28 step 1장이 끝까지 안 가고 흐린 채로 멈춤"): the
 * held frame is NovelAI's last intermediate - small and blurry - and nothing
 * on screen said the run was over. The step read 26/28 (step_ix is 0-based),
 * the finished PNG queued behind the strip's thumbnails, and a load that
 * failed (or a run that saved nothing) kept the blurry frame for good, since
 * a hint never blanks a picture. Now the frame carries 마무리 중 / 완성본
 * 불러오는 중, the finished picture comes as a large WebP at the front of the
 * fetch queue, and a failure drops the frame for the reason and 다시.
 */
function syncPreview(): void {
  const img = imgEl;
  if (!img || !previewBox?.isConnected || !captionEl || !emptyEl) return;
  const running = !!S.jobId;
  const saved = S.queueJob?.payload?.saved ?? [];
  const pinned = S.viewPath;
  const showEmpty = (text: string, force = false) => {
    if (shownKey && !force) return; // something is on screen - never blank it for a hint
    shownKey = '';
    emptyEl!.textContent = text;
    emptyEl!.style.display = '';
    img.style.display = 'none';
    captionEl!.style.display = 'none';
    setState('');
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
    const last = livePreview.total > 0 && livePreview.step >= livePreview.total - 2;
    const noStream = S.queueJob?.payload?.streaming === false;
    showImg('live', livePreview.url,
            `생성 중 ${livePreview.step}/${livePreview.total}${livePreview.current ? ' · ' + livePreview.current : ''}`);
    setState(noStream ? '스트리밍이 끊겨 미리보기 없이 다시 생성하는 중…'
      : last ? '마무리 중… 완성본을 기다립니다' : '');
    return;
  }
  const path = pinned || saved[saved.length - 1] || '';
  if (!path) {
    const failed = S.queueJob?.payload?.failed ?? [];
    if (!running && (shownKey === 'live' || failed.length)) {
      // The run ended with nothing to show (it failed or was cancelled):
      // say why, and never let the blurry frame stand in for a result.
      const why = failed.length ? String(failed[failed.length - 1].error || '') : '';
      showEmpty(why ? '생성에 실패했습니다: ' + why : '저장된 이미지가 없습니다.', true);
      if (shownKey === '') releasePreview();
      return;
    }
    showEmpty(running
      ? '생성 중입니다… 첫 프레임이 오면 여기 나타납니다.'
      : '생성 시작을 누르거나, 아래 결과에서 한 장을 고르세요.');
    return;
  }
  if (path === shownKey || !safeWorkspacePath(path)) return;
  if (path === loadingPath || path === failedPath) return;
  if (shownKey === 'live') setState('완성본 불러오는 중…');
  loadFinal(path);
}

function loadFinal(want: string): void {
  const img = imgEl;
  if (!img) return;
  loadingPath = want;
  failedPath = '';
  // A large WebP, not the 1-2 MB PNG: on a remote backend the original took
  // long enough to read as "stuck". The full file opens on click.
  void blobUrl(want, '', { thumb: true, w: smallScreen() ? 720 : 1280, front: true }).then((url) => {
    if (loadingPath === want) loadingPath = '';
    if (!img.isConnected) return;
    // Still what we want? (the user may have pinned elsewhere meanwhile)
    const nowPath = S.viewPath || (S.queueJob?.payload?.saved ?? []).slice(-1)[0] || '';
    if ((S.viewPath || !(S.jobId && livePreview.url)) && nowPath === want) {
      shownKey = want;
      img.src = url;
      img.style.display = '';
      emptyEl!.style.display = 'none';
      captionEl!.textContent = want;
      captionEl!.style.display = '';
      setState('');
      // The finished file is on screen: the held stream frame can go.
      if (!S.jobId) releasePreview();
    }
  }).catch((e: unknown) => {
    if (loadingPath === want) loadingPath = '';
    failedPath = want;
    if (!img.isConnected) return;
    const why = e instanceof Error ? e.message : String(e);
    if (shownKey === 'live' || shownKey === '') {
      // Never leave the blurry frame posing as the result.
      shownKey = '';
      img.style.display = 'none';
      captionEl!.style.display = 'none';
      emptyEl!.textContent = '';
      emptyEl!.style.display = 'none';
      if (!S.jobId) releasePreview();
    }
    setState('완성본을 불러오지 못했습니다: ' + why, () => { failedPath = ''; setState(''); syncPreview(); });
  });
}

/** The line over the picture; '' hides it. `retry` adds 다시. */
function setState(text: string, retry?: () => void): void {
  if (!stateEl) return;
  stateEl.textContent = '';
  stateEl.style.display = text ? '' : 'none';
  stateEl.classList.toggle('err', !!retry);
  if (!text) return;
  stateEl.appendChild(el('span', { text }));
  if (retry) {
    const b = el('button', { class: 'ghost tiny', text: '다시' });
    b.addEventListener('click', retry);
    stateEl.appendChild(b);
  }
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

// (the per-tab result strip is gone, §1-40: the bottom 최근 생성 strip is the one list)

/** Open one image big in the 1장 tab, ←/→ walking `list` (4.4a). The pin
 * keeps a mid-run click from being overwritten by the stream. */
export function openImage(path: string, list: string[]): void {
  showArtifact({ path, title: path.split('/').pop() || path, kind: 'image', images: list });
}
