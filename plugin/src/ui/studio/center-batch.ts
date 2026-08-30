/**
 * The 배치 tab: unfold a scene preset and PICK what goes into the job.
 *
 * Strictly the queue being built - results live in 잡 히스토리. The queue is
 * a MAP, not a formula: reserves[preset][scene] = count, piled per scene
 * (전체 +1 for the whole preset, − n + per card), never reset by switching
 * presets (the keys keep everything), listed in a fold-out with per-row
 * remove, and drained by 씬 생성 n장 into ONE job. WHO is drawn is the left
 * column's checked character cards - one place to pick characters, not two.
 */
import { el, clear } from '../dom';
import { namePopover } from '../kit';
import { state, type StudioJob } from '../../state';
import { workspaceImage } from '../blobimg';
import { S, hub, gen, persistCols, stateLabel, activeOf,
         reserves, reserveOf, reserveTotal, adjustReserve, setReserve,
         clearReserves, persistReserves, type ReserveMap } from './store';
import { scenePicker, tokenNotice, openParamsDialog, startRun, cancelRun, pendingCount, loadJobs } from './gen';
import { jobSection } from './center-history';

let runBtn: HTMLButtonElement | null = null;
let progressLine: HTMLElement | null = null;
/** The running job's section, drawn under the submit while it runs (10). */
let liveBox: HTMLElement | null = null;

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
  const cols = el('div', { class: 'row', style: { gap: '2px' } },
    [2, 3, 4].map((n) => {
      const b = el('button', { class: 'ghost tiny' + (S.cols === n ? ' on' : ''), text: String(n),
                               title: `씬 카드를 ${n}열로` });
      b.addEventListener('click', () => { S.cols = n as 2 | 3 | 4; persistCols(); hub.drawCentre(); });
      return b;
    }));
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
  drawSummary(summary);

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
 * belong to 잡 히스토리. */
export function batchTick(): void {
  syncRunBtn();
  syncLive();
}

function syncLive(): void {
  if (!liveBox?.isConnected) return;
  clear(liveBox);
  if (!S.jobId || !S.queueJob) return;
  liveBox.appendChild(el('div', { class: 'hint', style: { margin: '6px 0 4px' }, text: '진행 중인 배치 — 완성되는 대로 여기 뜹니다 (끝나면 잡 히스토리로)' }));
  liveBox.appendChild(jobSection(S.queueJob, true, true));
}

function syncRunBtn(): void {
  if (!runBtn?.isConnected || !progressLine) return;
  const running = !!S.jobId;
  const total = reserveTotal();
  runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
  runBtn.textContent = running ? `취소 (${pendingCount()})` : `씬 생성 ${total}장`;
  runBtn.classList.toggle('danger', running);
  runBtn.disabled = !running && total === 0;
  runBtn.title = running ? '' : '모든 프리셋의 예약을 하나의 JOB 으로 생성합니다 (순서대로) · 결과는 잡 히스토리 탭에';
  const p = S.queueJob?.payload;
  progressLine.textContent = running && p
    ? `${stateLabel(S.queueJob!.state)} · ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''} — 결과는 잡 히스토리 탭`
    : '';
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
  const grid = el('div', { class: 'scenegrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  for (const scene of scenes) grid.appendChild(sceneCard(scene, jobs));
  box.appendChild(grid);
}

function sceneThumb(scene: string, jobs: StudioJob[]): string {
  for (const j of jobs) {
    const p = j.payload;
    if (!p?.items || !p.saved?.length) continue;
    const savedBy = new Map<string, string>();
    for (const path of p.saved) savedBy.set(path.split('/').pop() ?? path, path);
    for (const it of p.items) {
      if (it.scene === scene) {
        const hit = savedBy.get(it.name);
        if (hit) return hit;
      }
    }
  }
  return '';
}

function sceneCard(scene: { name: string; prompt: string }, jobs: StudioJob[]): HTMLElement {
  const preset = gen.scenePreset;
  const mine = reserveOf(preset, scene.name);

  const face = el('div', { class: 'sceneface' });
  const thumb = sceneThumb(scene.name, jobs);
  if (thumb) {
    const pic = workspaceImage(thumb, scene.name, { thumb: false });
    pic.classList.add('jobpic');
    face.appendChild(pic);
  } else {
    face.appendChild(el('div', { class: 'scenefallback', text: scene.name }));
  }

  const minus = el('button', { class: 'ghost tiny', text: '−', title: '예약을 하나 뺍니다' });
  const num = el('button', { class: 'ghost tiny reservenum', text: String(mine), title: '눌러서 장수를 직접 입력' });
  const plus = el('button', { class: 'ghost tiny', text: '＋', title: '이 씬을 한 장 예약에 담습니다' });
  minus.addEventListener('click', () => { adjustReserve(preset, scene.name, -1); hub.drawCentre(); });
  plus.addEventListener('click', () => { adjustReserve(preset, scene.name, +1); hub.drawCentre(); });
  num.addEventListener('click', () => {
    namePopover(num, {
      label: `${scene.name} — 예약 장수`, value: String(mine), ok: '적용',
      onSubmit: (raw) => {
        const n = Math.max(0, Math.trunc(Number(raw)) || 0);
        setReserve(preset, scene.name, n);
        hub.drawCentre();
      },
    });
  });

  return el('div', { class: 'scenecard' + (mine ? ' reserved' : ''), title: scene.prompt || scene.name }, [
    face,
    el('div', { class: 'row', style: { marginTop: '4px' } }, [
      el('span', { class: 'grow', text: scene.name }),
      minus, num, plus,
    ]),
  ]);
}

// --- the queue summary and the submit ------------------------------------------------

function drawSummary(box: HTMLElement): void {
  const total = reserveTotal();
  if (!total) return;
  const outside = Object.keys(reserves).filter((p) => p !== gen.scenePreset);
  const outsideN = outside.reduce((n, p) =>
    n + Object.values(reserves[p]).reduce((a, b) => a + b, 0), 0);

  const det = el('details', { class: 'advbox', open: true }) as HTMLDetailsElement;
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
        hub.drawCentre();
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
