/**
 * The 배치 tab: unfold a scene preset and PICK what goes into the job.
 *
 * Strictly the queue being built - results ride the bottom strip and 검수. The queue is
 * a MAP, not a formula: reserves[preset][scene] = count, piled per scene
 * (전체 +1 for the whole preset, − n + per card), never reset by switching
 * presets (the keys keep everything), listed in a fold-out with per-row
 * remove, and drained by 씬 생성 n장 into ONE job. WHO is drawn is the left
 * column's checked character cards - one place to pick characters, not two.
 */
import { el, clear, colPicker } from '../dom';
import { namePopover } from '../kit';
import { state, type StudioJob } from '../../state';
import { workspaceImage } from '../blobimg';
import { S, hub, gen, persistCols, stateLabel, activeOf,
         reserves, reserveOf, reserveTotal, adjustReserve, setReserve,
         clearReserves, persistReserves, type ReserveMap } from './store';
import { scenePicker, tokenNotice, openParamsDialog, startRun, cancelRun, pendingCount, loadJobs,
         livePreview, stepMsEma } from './gen';
import { jobSection } from './center-history';

let runBtn: HTMLButtonElement | null = null;
let progressLine: HTMLElement | null = null;
/** The running job's section, drawn under the submit while it runs (10). */
let liveBox: HTMLElement | null = null;
/** The queue summary, rebuilt alone when a reservation moves. */
let summaryBox: HTMLElement | null = null;
/** Per-scene card registry: the working ring and its mini step bar. */
const cardRegs = new Map<string, { card: HTMLElement; prog: HTMLElement; fill: HTMLElement; label: HTMLElement }>();
/** The one-segment-per-image bar above the submit. */
let batchBar: HTMLElement | null = null;
let barKey = '';
let barCur: HTMLElement | null = null;
let barEta: HTMLElement | null = null;

/** Scene lists per preset file, re-read when the library rev moves. */
const sceneCache = new Map<string, { rev: number; scenes: { name: string; prompt: string }[] }>();

export async function scenesOf(preset: string): Promise<{ name: string; prompt: string }[]> {
  const hit = sceneCache.get(preset);
  if (hit && hit.rev === state.filesRev) return hit.scenes;
  try {
    const d = JSON.parse((await state.readFile(preset)).content) as { scenes?: { name?: string; prompt?: string }[] };
    const scenes = (d.scenes ?? []).map((s) => ({ name: String(s.name ?? ''), prompt: String(s.prompt ?? '') }))
      .filter((s) => s.name);
    sceneCache.set(preset, { rev: state.filesRev, scenes });
    return scenes;
  } catch {
    return [];
  }
}

export function drawBatch(mount: HTMLElement): void {
  const notice = tokenNotice();
  if (notice) mount.appendChild(notice);

  // --- toolbar -----------------------------------------------------------------
  const params = el('button', { class: 'ghost tiny', text: '⚙ 요청 설정' });
  params.addEventListener('click', () => openParamsDialog());
  const cols = colPicker({ values: [2, 3, 4], get: () => S.cols, set: (n) => {
    S.cols = n as 2 | 3 | 4; persistCols();
    for (const gEl of Array.from(document.querySelectorAll<HTMLElement>('.scenegrid, .jobgrid'))) {
      gEl.style.gridTemplateColumns = `repeat(${S.cols}, minmax(0, 1fr))`;
    }
  } });
  mount.appendChild(el('div', { class: 'row', style: { marginBottom: '6px', flexWrap: 'wrap' } }, [
    scenePicker(), params, cols,
  ]));
  const nChars = activeOf('characters').length;
  mount.appendChild(el('div', { class: 'hint', style: { marginBottom: '6px' },
    text: `캐릭터는 좌측에서 켠 카드가 실립니다 (지금 ${nChars}개) · 씬 카드의 ＋ 로 필요한 씬만 예약에 담습니다` }));

  // --- the scene cards (the queue's face) ---------------------------------------
  const cardsBox = el('div', {});
  mount.appendChild(cardsBox);
  void drawSceneCards(cardsBox);

  // --- the queue summary and the one submit -------------------------------------
  const summary = el('div', {});
  mount.appendChild(summary);
  summaryBox = summary;
  drawSummary(summary);

  batchBar = el('div', { class: 'batchbar', style: { display: 'none' } });
  mount.appendChild(batchBar);

  runBtn = el('button', { class: 'primary tiny' }) as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (S.jobId) cancelRun();
    else void submitReserved();
  });
  progressLine = el('span', { class: 'hint' });
  mount.appendChild(el('div', { class: 'row', style: { margin: '8px 0', flexWrap: 'wrap' } }, [
    progressLine, el('span', { class: 'grow' }), runBtn,
  ]));
  liveBox = el('div', {});
  mount.appendChild(liveBox);
  syncRunBtn();
  syncLive();
}

/** The live-job heartbeat: the button, the progress line, and the running
 * job's section (streaming frame on the cell being drawn). Finished results
 * belong to the bottom strip and 검수. */
export function batchTick(): void {
  syncRunBtn();
  syncSceneProgress();
  syncBatchBar();
  syncLive();
}

let liveSec: HTMLElement | null = null;
let liveKey = '';
function syncLive(): void {
  if (!liveBox?.isConnected) return;
  if (!S.jobId || !S.queueJob) {
    if (liveSec || liveBox.childNodes.length) { clear(liveBox); liveSec = null; liveKey = ''; }
    return;
  }
  const p = S.queueJob.payload;
  const key = [S.queueJob.id, S.queueJob.state, p?.done ?? 0, p?.saved?.length ?? 0,
               p?.failed?.length ?? 0, p?.current ?? ''].join('|');
  if (liveSec?.isConnected && key === liveKey) {
    // Same shape - only the streaming frame moved. Patch it in place instead
    // of rebuilding every <img> in the section (the old 1.5s jank).
    const frame = liveSec.querySelector<HTMLImageElement>('.liveframe img');
    if (frame && livePreview.url && frame.src !== livePreview.url) frame.src = livePreview.url;
    const badge = liveSec.querySelector<HTMLElement>('.liveframe .badge');
    if (badge) badge.textContent = (badge.textContent || '').replace(/\d+\/\d+/, `${livePreview.step}/${livePreview.total}`);
    return;
  }
  liveKey = key;
  clear(liveBox);
  liveBox.appendChild(el('div', { class: 'hint', style: { margin: '6px 0 4px' },
    text: '진행 중인 배치 — 완성되는 대로 여기 뜨고, 아래 최근 생성 스트립에도 쌓입니다' }));
  liveSec = jobSection(S.queueJob, true, true);
  liveBox.appendChild(liveSec);
}

function syncRunBtn(): void {
  if (!runBtn?.isConnected || !progressLine) return;
  const running = !!S.jobId;
  const total = reserveTotal();
  runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
  runBtn.textContent = running ? `취소 (${pendingCount()})` : `씬 생성 ${total}장`;
  runBtn.classList.toggle('danger', running);
  runBtn.disabled = !running && total === 0;
  runBtn.title = running ? '' : '모든 프리셋의 예약을 하나의 JOB 으로 생성합니다 (순서대로) · 결과는 아래 최근 생성 스트립과 검수에';
  const p = S.queueJob?.payload;
  progressLine.textContent = running && p
    ? `${stateLabel(S.queueJob!.state)} · ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`
    : '';
}

/** The scene of the image being drawn right now, via payload.items. */
function currentScene(): string {
  const p = S.queueJob?.payload;
  if (!S.jobId || !p?.current) return '';
  return p.items?.find((i) => i.name === p.current)?.scene ?? '';
}

/** The card being worked gets a ring and a live step bar (usability 13). */
function syncSceneProgress(): void {
  const p = S.queueJob?.payload;
  const scene = currentScene();
  for (const [name, r] of cardRegs) {
    const working = !!scene && name === scene;
    r.card.classList.toggle('working', working);
    if (!working) { r.prog.style.display = 'none'; continue; }
    r.prog.style.display = '';
    const frac = livePreview.total ? Math.min(1, livePreview.step / livePreview.total) : 0;
    r.fill.style.width = `${Math.round(frac * 100)}%`;
    let done = 0;
    let mine = 0;
    for (const it of p?.items ?? []) {
      if (it.scene !== name) continue;
      mine += 1;
      if (p?.saved?.some((s) => (s.split('/').pop() ?? s) === it.name)) done += 1;
    }
    r.label.textContent = `${done}/${mine} · step ${livePreview.step}/${livePreview.total}`;
  }
}

/** One segment per image above the submit: saved green, failed red, the
 * current one part-filled by the live diffusion step. ETA from the client
 * step EMA - the existing poll channels carry everything needed. */
function syncBatchBar(): void {
  if (!batchBar?.isConnected) return;
  const p = S.queueJob?.payload;
  if (!S.jobId || !p?.total) {
    batchBar.style.display = 'none';
    barKey = '';
    return;
  }
  batchBar.style.display = '';
  const failedN = p.failed?.length ?? 0;
  const key = `${S.queueJob!.id}|${p.total}|${p.saved?.length ?? 0}|${failedN}|${p.current ?? ''}`;
  if (key !== barKey) {
    barKey = key;
    clear(batchBar);
    barCur = null;
    const segs = el('div', { class: 'batchsegs' });
    const savedBy = new Set((p.saved ?? []).map((s) => s.split('/').pop() ?? s));
    const failedBy = new Set((p.failed ?? []).map((f) => f.name));
    for (const it of p.items ?? []) {
      const seg = el('div', { class: 'batchseg', title: it.name });
      if (savedBy.has(it.name)) seg.classList.add('ok');
      else if (failedBy.has(it.name)) seg.classList.add('fail');
      else if (p.current === it.name) {
        seg.classList.add('cur');
        barCur = el('div', { class: 'batchseg-fill' });
        seg.appendChild(barCur);
      }
      segs.appendChild(seg);
    }
    barEta = el('span', { class: 'hint' });
    batchBar.append(segs, barEta);
  }
  if (barCur) {
    const frac = livePreview.total ? Math.min(1, livePreview.step / livePreview.total) : 0;
    barCur.style.width = `${Math.round(frac * 100)}%`;
  }
  if (barEta) {
    const per = stepMsEma();
    const remain = Math.max(0, p.total - p.done - failedN);
    if (per && livePreview.total && remain) {
      const secs = Math.round(((livePreview.total - livePreview.step)
        + Math.max(0, remain - 1) * livePreview.total) * per / 1000);
      barEta.textContent = `남은 ${remain}장 · 약 ${secs >= 60 ? Math.round(secs / 60) + '분' : secs + '초'}`;
    } else {
      barEta.textContent = '';
    }
  }
}

// --- the scene cards ---------------------------------------------------------------

async function drawSceneCards(box: HTMLElement): Promise<void> {
  if (!gen.scenePreset) {
    box.appendChild(el('div', { class: 'hint', style: { margin: '4px 0 8px' },
      text: '씬 프리셋을 불러오면 씬 카드가 펼쳐집니다. 필요한 씬을 골라 예약에 담고, 예약은 프리셋을 오가며 자유롭게 쌓입니다.' }));
    return;
  }
  const scenes = await scenesOf(gen.scenePreset);
  if (!box.isConnected) return;
  if (!scenes.length) {
    box.appendChild(el('div', { class: 'hint', text: '이 프리셋에 씬이 없습니다 — 드롭다운의 수정에서 씬을 추가하세요.' }));
    return;
  }

  // 전체추가 / 부분추가: the preset unfolds, then either everything at once
  // or scene by scene (the ＋ on each card).
  const addAll = el('button', { class: 'ghost tiny', text: '전체 +1', title: '이 프리셋의 모든 씬을 한 장씩 예약에 담습니다' });
  addAll.addEventListener('click', () => {
    for (const s of scenes) adjustReserve(gen.scenePreset, s.name, +1);
    hub.drawCentre();
  });
  const clearHere = el('button', { class: 'ghost tiny', text: '이 프리셋 예약 비우기' }) as HTMLButtonElement;
  clearHere.disabled = !Object.keys(reserves[gen.scenePreset] ?? {}).length;
  clearHere.addEventListener('click', () => { clearReserves(gen.scenePreset); hub.drawCentre(); });
  box.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } }, [
    el('span', { class: 'sectiontitle grow', text: `씬 ${scenes.length}개` }),
    addAll, clearHere,
  ]));

  const jobs = await loadJobs();
  if (!box.isConnected) return;
  const thumbs = sceneThumbs(jobs);
  cardSyncs.clear();
  cardRegs.clear();
  const grid = el('div', { class: 'scenegrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  for (const scene of scenes) grid.appendChild(sceneCard(scene, thumbs));
  box.appendChild(grid);
}

/** scene -> newest saved image, one pass over the jobs array, memoised on
 * (job id, saved count) - the old per-card scan was O(jobs x items) x cards
 * on EVERY redraw. */
let thumbMemo: { key: string; map: Map<string, string> } | null = null;
function sceneThumbs(jobs: StudioJob[]): Map<string, string> {
  const key = jobs.map((j) => j.id + ':' + (j.payload?.saved?.length ?? 0)).join('|');
  if (thumbMemo?.key === key) return thumbMemo.map;
  const map = new Map<string, string>();
  for (const j of jobs) {
    const p = j.payload;
    if (!p?.items || !p.saved?.length) continue;
    const savedBy = new Map<string, string>();
    for (const path of p.saved) savedBy.set(path.split('/').pop() ?? path, path);
    for (const it of p.items) {
      if (it.scene && !map.has(it.scene)) {
        const hit = savedBy.get(it.name);
        if (hit) map.set(it.scene, hit);
      }
    }
  }
  thumbMemo = { key, map };
  return map;
}

/** Registered per-card refreshers, so bulk actions can update the numbers. */
const cardSyncs = new Map<string, () => void>();
function syncSceneNums(): void {
  for (const s of cardSyncs.values()) s();
}

function sceneCard(scene: { name: string; prompt: string }, thumbs: Map<string, string>): HTMLElement {
  const preset = gen.scenePreset;
  const mine = reserveOf(preset, scene.name);

  const face = el('div', { class: 'sceneface' });
  const thumb = thumbs.get(scene.name) ?? '';
  if (thumb) {
    const pic = workspaceImage(thumb, scene.name, { thumb: true, aspect: '832 / 1216', lazy: true });
    pic.classList.add('jobpic');
    face.appendChild(pic);
  } else {
    face.appendChild(el('div', { class: 'scenefallback', text: scene.name }));
  }

  const minus = el('button', { class: 'ghost tiny', text: '−', title: '예약을 하나 뺍니다' });
  const num = el('button', { class: 'ghost tiny reservenum', text: String(mine), title: '눌러서 장수를 직접 입력' });
  const plus = el('button', { class: 'ghost tiny', text: '＋', title: '이 씬을 한 장 예약에 담습니다' });
  // In-place: a +/- click must not redraw the whole tab (and refetch every
  // thumbnail). Only the number, the card ring, the button and the summary.
  minus.addEventListener('click', () => { adjustReserve(preset, scene.name, -1); sync(); });
  plus.addEventListener('click', () => { adjustReserve(preset, scene.name, +1); sync(); });
  num.addEventListener('click', () => {
    namePopover(num, {
      label: `${scene.name} — 예약 장수`, value: String(mine), ok: '적용',
      onSubmit: (raw) => {
        const n = Math.max(0, Math.trunc(Number(raw)) || 0);
        setReserve(preset, scene.name, n);
        sync();
      },
    });
  });

  const fill = el('div', { class: 'sceneprog-fill' });
  const plabel = el('span', { class: 'sceneprog-label hint' });
  const prog = el('div', { class: 'sceneprog', style: { display: 'none' } }, [
    el('div', { class: 'sceneprog-track' }, [fill]), plabel,
  ]);
  const card = el('div', { class: 'scenecard' + (mine ? ' reserved' : ''), title: scene.prompt || scene.name }, [
    face,
    prog,
    el('div', { class: 'row', style: { marginTop: '4px' } }, [
      el('span', { class: 'grow', text: scene.name }),
      minus, num, plus,
    ]),
  ]);
  const sync = (): void => {
    const m = reserveOf(preset, scene.name);
    num.textContent = String(m);
    card.classList.toggle('reserved', m > 0);
    syncRunBtn();
    syncSummary();
  };
  cardSyncs.set(scene.name, sync);
  cardRegs.set(scene.name, { card, prog, fill, label: plabel });
  return card;
}

// --- the queue summary and the submit ------------------------------------------------

/** Rebuild only the summary fold - a reservation click must not redraw the
 * scene cards (and re-fetch every thumbnail). */
function syncSummary(): void {
  if (!summaryBox?.isConnected) return;
  const wasOpen = summaryBox.querySelector('details')?.open ?? true;
  clear(summaryBox);
  drawSummary(summaryBox, wasOpen);
}

function drawSummary(box: HTMLElement, open = true): void {
  const total = reserveTotal();
  if (!total) return;
  const outside = Object.keys(reserves).filter((p) => p !== gen.scenePreset);
  const outsideN = outside.reduce((n, p) =>
    n + Object.values(reserves[p]).reduce((a, b) => a + b, 0), 0);

  const det = el('details', { class: 'advbox', ...(open ? { open: true } : {}) }) as HTMLDetailsElement;
  det.appendChild(el('summary', {}, [
    el('span', { text: `예약 목록 — 총 ${total}장` }),
    outsideN ? el('span', { class: 'badge', style: { marginLeft: '6px' },
      title: '지금 화면의 프리셋 밖에 쌓인 예약 — 제출에 함께 실립니다',
      text: `다른 프리셋 ${outsideN}장` }) : null,
  ]));
  const list = el('div', { class: 'verlist' });
  for (const [preset, scenes] of Object.entries(reserves)) {
    for (const [scene, n] of Object.entries(scenes)) {
      const drop = el('button', { class: 'ghost tiny', text: '✕', title: '이 예약만 뺍니다' });
      drop.addEventListener('click', () => {
        setReserve(preset, scene, 0);
        syncSceneNums();
        syncRunBtn();
        syncSummary();
      });
      list.appendChild(el('div', { class: 'row', style: { padding: '2px 0' } }, [
        el('span', { class: 'hint', text: preset.split('/').pop()?.replace(/\.json$/, '') ?? preset }),
        el('span', { class: 'grow', text: `${scene} × ${n}` }),
        drop,
      ]));
    }
  }
  const clearAll = el('button', { class: 'ghost tiny', text: '전체 예약 취소' });
  clearAll.addEventListener('click', () => { clearReserves(); hub.drawCentre(); });
  det.appendChild(list);
  det.appendChild(el('div', { class: 'row', style: { marginTop: '4px' } }, [clearAll]));
  box.appendChild(det);
}

/** Drain the reservation map into ONE job's entries. A scene that no longer
 * exists in its preset is skipped and reported - its reservation stays. */
async function submitReserved(): Promise<void> {
  const entries: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const leftover: ReserveMap = {};
  for (const [preset, scenes] of Object.entries(reserves)) {
    const known = new Set((await scenesOf(preset)).map((s) => s.name));
    for (const [scene, count] of Object.entries(scenes)) {
      if (!count) continue;
      if (!known.has(scene)) {
        skipped.push(`${preset.split('/').pop()} / ${scene}`);
        (leftover[preset] ??= {})[scene] = count;
        continue;
      }
      entries.push({ scenePreset: preset, scene, count });
    }
  }
  if (!entries.length) {
    hub.notice(skipped.length
      ? '예약된 씬을 프리셋에서 찾지 못했습니다: ' + skipped.join(', ')
      : '예약이 없습니다 — 씬 카드의 ＋ 로 쌓아 주세요.', 'err');
    return;
  }
  if (skipped.length) {
    hub.notice('일부 씬을 찾지 못해 건너뜁니다 (예약은 남습니다): ' + skipped.join(', '), 'err');
  }
  await startRun({ entries, scenePreset: '' });
  if (S.jobId) {
    // Submitted: the queue empties, except what was skipped.
    for (const k of Object.keys(reserves)) delete reserves[k];
    Object.assign(reserves, leftover);
    persistReserves();
    hub.drawCentre();
  }
}
