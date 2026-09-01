/**
 * jobSection - one batch's fold-out: summary line, item grid, streaming
 * frame on the cell being drawn.
 *
 * The old standalone tab is gone (usability batch item 5): recent results
 * live on the bottom strip (strip.ts), and the running job's section is the
 * batch tab's live box. This module keeps only the shared renderer.
 */
import { el } from '../dom';
import { workspaceImage } from '../blobimg';
import { type StudioJob } from '../../state';
import { S, stateLabel } from './store';
import { livePreview } from './gen';
import { openImage } from './center-single';

/** Sections the user opened/closed by hand, so a redraw respects them. */
const openState = new Map<string, boolean>();

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
      const pic = workspaceImage(full, it.name, { thumb: true, aspect: '832 / 1216', lazy: true });
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
