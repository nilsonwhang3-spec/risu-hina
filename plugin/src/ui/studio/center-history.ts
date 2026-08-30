/**
 * The 잡 히스토리 tab: every batch's RESULTS, one fold-out section per job.
 *
 * The batch tab builds the queue; this tab is where what came out lives -
 * newest first, the running job on top (open, live-updating, streaming frame
 * on the cell being drawn), each section a <details> whose summary reads
 * when · state · done/total · Anlas. A finished image opens big in the 1장
 * tab.
 */
import { el, clear } from '../dom';
import { workspaceImage } from '../blobimg';
import { type StudioJob } from '../../state';
import { S, hub, persistCols, stateLabel } from './store';
import { loadJobs, livePreview } from './gen';
import { openImage } from './center-single';

let sectionsBox: HTMLElement | null = null;
/** The section the live poll rebuilds in place. */
let liveSection: HTMLElement | null = null;
/** Sections the user opened/closed by hand, so a redraw respects them. */
const openState = new Map<string, boolean>();

export function drawHistory(mount: HTMLElement): void {
  const cols = el('div', { class: 'row', style: { gap: '2px' } },
    [2, 3, 4].map((n) => {
      const b = el('button', { class: 'ghost tiny' + (S.cols === n ? ' on' : ''), text: String(n),
                               title: `${n}열로 보기` });
      b.addEventListener('click', () => { S.cols = n as 2 | 3 | 4; persistCols(); hub.drawCentre(); });
      return b;
    }));
  mount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    el('span', { class: 'sectiontitle grow', text: '잡 히스토리' }),
    el('span', { class: 'hint', text: '배치가 만든 결과가 JOB 별로 쌓입니다 · 이미지를 누르면 1장 탭에서 크게' }),
    cols,
  ]));
  sectionsBox = el('div', {});
  mount.appendChild(sectionsBox);
  sectionsBox.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
  void drawSections(true);
  watch();
}

// While this tab is showing and no job of ours is running, look every few
// seconds for one the agent started - loadJobs adopts it, and from then on
// the ordinary poll drives the live section.
let watcher: ReturnType<typeof setInterval> | null = null;
function watch(): void {
  if (watcher) return;
  watcher = setInterval(() => {
    if (!sectionsBox?.isConnected) { clearInterval(watcher!); watcher = null; return; }
    if (S.jobId) return;
    void loadJobs(true).then(() => { if (S.jobId) historyTick(); });
  }, 5000);
}

/** The live-job heartbeat: rebuild only the running section. */
export function historyTick(): void {
  if (!sectionsBox?.isConnected) return;
  if (S.queueJob && liveSection?.isConnected) {
    const fresh = jobSection(S.queueJob, !!S.jobId, true);
    liveSection.replaceWith(fresh);
    liveSection = fresh;
  } else {
    void drawSections(false);
  }
}

async function drawSections(force: boolean): Promise<void> {
  const box = sectionsBox;
  if (!box?.isConnected) return;
  const jobs = await loadJobs(force);
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
    box.appendChild(el('div', { class: 'empty', text: '아직 배치가 없습니다. 배치 탭에서 씬을 예약하고 생성하세요.' }));
    return;
  }
  shown.forEach((j, ix) => {
    const live = j.id === S.jobId;
    const sec = jobSection(j, live, openState.get(j.id) ?? (live || ix === 0));
    if (live) liveSection = sec;
    box.appendChild(sec);
  });
}

export function jobSection(j: StudioJob, live: boolean, open: boolean): HTMLElement {
  const p = j.payload;
  const bits: string[] = [];
  if (j.created_at) bits.push(new Date(j.created_at * 1000).toLocaleString());
  bits.push(stateLabel(j.state));
  if (p) bits.push(`${p.done}/${p.total}`);
  const spent = j.result?.anlasSpent;
  if (typeof spent === 'number') bits.push(`Anlas ${spent}`);

  const sec = el('details', { class: 'jobsec' + (live ? ' live' : ''), dataset: { job: j.id },
                              ...(open ? { open: true } : {}) }) as HTMLDetailsElement;
  sec.appendChild(el('summary', { class: 'jobhead' }, [
    live ? el('span', { class: 'badge warn', text: '진행 중' }) : null,
    el('span', { class: 'sectiontitle', text: bits.join(' · ') }),
    el('span', { class: 'hint', text: j.id }),
  ]));
  sec.addEventListener('toggle', () => { openState.set(j.id, sec.open); });
  if (j.error) sec.appendChild(el('div', { class: 'notice err', text: j.error }));
  if (!p) return sec;
  if (p.note) sec.appendChild(el('div', { class: 'hint', text: p.note }));

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
      // The streaming frame lands on the cell being drawn (4.12).
      if (livePreview.url) {
        cell.appendChild(el('div', { class: 'jobpic liveframe' }, [
          el('img', { src: livePreview.url, alt: it.name }),
          el('span', { class: 'badge warn', text: `생성 중 ${livePreview.step}/${livePreview.total}` }),
        ]));
      } else {
        cell.appendChild(el('div', { class: 'jobwait' }, [el('span', { class: 'badge warn', text: '생성 중' })]));
      }
    } else {
      cell.appendChild(el('div', { class: 'jobwait' }, [
        el('span', { class: 'badge', text: live ? '대기' : '—' }),
      ]));
    }
    cell.appendChild(el('div', { class: 'fname' }, [
      it.scene ? el('span', { class: 'badge', text: it.scene, style: { marginRight: '4px' } }) : null,
      it.cast ? el('span', { class: 'badge', text: it.cast, style: { marginRight: '4px' } }) : null,
      el('span', { class: 'hint', text: it.name }),
    ]));
    grid.appendChild(cell);
  }
  sec.appendChild(grid);
  return sec;
}
