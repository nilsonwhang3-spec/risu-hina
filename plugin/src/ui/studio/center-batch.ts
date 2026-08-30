/**
 * The 배치 tab: run scene presets, and read the results BY JOB.
 *
 * The results area is not "the last run" - it is every batch, newest first,
 * each as its own section (header: when · state · done/total · Anlas; body:
 * the item grid at the chosen column count). Scrolling walks back through
 * history; the history tab jumps here and highlights one section (4.10).
 * Clicking a finished image opens it big in the 1장 tab (4.4a).
 */
import { el, clear } from '../dom';
import { workspaceImage } from '../blobimg';
import { type StudioJob } from '../../state';
import { S, hub, gen, persistCols, stateLabel } from './store';
import { scenePicker, tokenNotice, openParamsDialog, startRun, cancelRun, pendingCount, loadJobs } from './gen';
import { openImage } from './center-single';

let sectionsBox: HTMLElement | null = null;
let runBtn: HTMLButtonElement | null = null;
/** The id whose section the live poll rebuilds in place. */
let liveSection: HTMLElement | null = null;

export function drawBatch(mount: HTMLElement): void {
  const notice = tokenNotice();
  if (notice) mount.appendChild(notice);

  // --- toolbar -------------------------------------------------------------------
  const params = el('button', { class: 'ghost tiny', text: '⚙ 요청 설정' });
  params.addEventListener('click', () => openParamsDialog());
  const cols = el('div', { class: 'row', style: { gap: '2px' } },
    [2, 3, 4].map((n) => {
      const b = el('button', { class: 'ghost tiny' + (S.cols === n ? ' on' : ''), text: String(n),
                               title: `${n}열로 보기` });
      b.addEventListener('click', () => { S.cols = n as 2 | 3 | 4; persistCols(); hub.drawCentre(); });
      return b;
    }));
  runBtn = el('button', { class: 'primary tiny' }) as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (S.jobId) cancelRun();
    else void startRun();
  });
  mount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } }, [
    scenePicker(), params, cols, runBtn,
  ]));

  sectionsBox = el('div', {});
  mount.appendChild(sectionsBox);
  syncRunBtn();
  void drawSections();
}

/** The live-job heartbeat: rebuild only the running section. */
export function batchTick(): void {
  if (!sectionsBox?.isConnected) return;
  syncRunBtn();
  if (S.queueJob && liveSection?.isConnected) {
    const fresh = jobSection(S.queueJob, true);
    liveSection.replaceWith(fresh);
    liveSection = fresh;
  } else if (S.queueJob && !liveSection) {
    void drawSections();
  }
}

function syncRunBtn(): void {
  if (!runBtn?.isConnected) return;
  const running = !!S.jobId;
  runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
  runBtn.textContent = running ? `취소 (${pendingCount()})` : '생성 시작';
  runBtn.classList.toggle('danger', running);
  runBtn.title = gen.scenePreset ? '씬 프리셋 × 장수로 생성합니다' : '요청 설정 한 장 구성 × 장수로 생성합니다';
}

async function drawSections(): Promise<void> {
  const box = sectionsBox;
  if (!box?.isConnected) return;
  const jobs = await loadJobs();
  if (!box.isConnected) return;
  clear(box);
  liveSection = null;

  const shown: StudioJob[] = [];
  if (S.queueJob && S.jobId) shown.push(S.queueJob);
  for (const j of jobs) {
    if (shown.some((x) => x.id === j.id)) continue;
    shown.push(j);
  }
  if (!shown.length) {
    box.appendChild(el('div', { class: 'empty', text: '아직 배치가 없습니다. 씬 프리셋을 고르고 생성 시작을 누르세요.' }));
    return;
  }
  for (const j of shown) {
    const live = j.id === S.jobId;
    const sec = jobSection(j, live);
    if (live) liveSection = sec;
    box.appendChild(sec);
  }
  // The history tab pointed at one batch: bring it into view, once.
  if (S.focusJob) {
    const target = box.querySelector<HTMLElement>(`[data-job="${S.focusJob}"]`);
    S.focusJob = '';
    if (target) {
      target.classList.add('focusjob');
      target.scrollIntoView?.({ block: 'start' });
      setTimeout(() => target.classList.remove('focusjob'), 2500);
    }
  }
}

function jobSection(j: StudioJob, live: boolean): HTMLElement {
  const p = j.payload;
  const bits: string[] = [];
  if (j.created_at) bits.push(new Date(j.created_at * 1000).toLocaleString());
  bits.push(stateLabel(j.state));
  if (p) bits.push(`${p.done}/${p.total}`);
  const spent = j.result?.anlasSpent;
  if (typeof spent === 'number') bits.push(`Anlas ${spent}`);

  const head = el('div', { class: 'row jobhead' }, [
    el('span', { class: 'sectiontitle grow', text: bits.join(' · ') }),
    live ? el('span', { class: 'badge warn', text: '진행 중' }) : null,
    el('span', { class: 'hint', text: j.id }),
  ]);
  const sec = el('div', { class: 'jobsec' + (live ? ' live' : ''), dataset: { job: j.id } }, [head]);
  if (j.error) sec.appendChild(el('div', { class: 'notice err', text: j.error }));
  if (!p) return sec;

  const savedBy = new Map<string, string>();
  for (const path of p.saved ?? []) savedBy.set(path.split('/').pop() ?? path, path);
  const failedBy = new Map((p.failed ?? []).map((f) => [f.name, f.error] as const));
  const savedList = p.saved ?? [];

  const grid = el('div', { class: 'jobgrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  for (const it of p.items ?? []) {
    const full = savedBy.get(it.name);
    const err = failedBy.get(it.name);
    const cell = el('div', { class: 'jobcell', title: it.name });
    if (full) {
      const pic = workspaceImage(full, it.name, { thumb: false });
      pic.classList.add('jobpic');
      pic.addEventListener('click', () => openImage(full, savedList));
      cell.append(pic);
    } else if (err) {
      cell.appendChild(el('div', { class: 'jobwait err' }, [
        el('span', { class: 'badge err', text: '실패' }),
        el('div', { class: 'hint err', text: err }),
      ]));
    } else if (live && p.current === it.name) {
      cell.appendChild(el('div', { class: 'jobwait' }, [el('span', { class: 'badge warn', text: '생성 중' })]));
    } else {
      cell.appendChild(el('div', { class: 'jobwait' }, [
        el('span', { class: 'badge', text: live ? '대기' : '—' }),
      ]));
    }
    cell.appendChild(el('div', { class: 'fname' }, [
      it.scene ? el('span', { class: 'badge', text: it.scene, style: { marginRight: '4px' } }) : null,
      el('span', { class: 'hint', text: it.name }),
    ]));
    grid.appendChild(cell);
  }
  sec.appendChild(grid);
  return sec;
}
