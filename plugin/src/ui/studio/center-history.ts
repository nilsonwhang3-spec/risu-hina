/**
 * The 잡 히스토리 tab: every batch, one row each. Picking one jumps to the
 * 배치 tab and highlights that batch's section (4.10) - the history is the
 * index, the batch tab is the reading view.
 */
import { el, clear } from '../dom';
import { workspaceImage } from '../blobimg';
import { S, hub, persistCentreTab, stateLabel } from './store';
import { loadJobs } from './gen';

export function drawHistory(mount: HTMLElement): void {
  const box = el('div', { class: 'verlist' });
  mount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    el('span', { class: 'sectiontitle grow', text: '잡 히스토리' }),
    el('span', { class: 'hint', text: '작업을 고르면 배치 탭에서 결과를 봅니다' }),
  ]));
  mount.appendChild(box);
  box.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));

  void loadJobs(true).then((jobs) => {
    if (!box.isConnected) return;
    clear(box);
    if (!jobs.length) {
      box.appendChild(el('div', { class: 'empty', text: '아직 배치가 없습니다.' }));
      return;
    }
    for (const j of jobs) {
      const p = j.payload;
      const first = p?.saved?.[0];
      const bits: string[] = [];
      if (j.created_at) bits.push(new Date(j.created_at * 1000).toLocaleString());
      if (p) bits.push(`${p.done}/${p.total}`);
      const spent = j.result?.anlasSpent;
      if (typeof spent === 'number') bits.push(`Anlas ${spent}`);
      const row = el('div', { class: 'chatitem jobrow', title: '배치 탭에서 이 작업의 결과를 봅니다' }, [
        first ? workspaceImage(first, first.split('/').pop() ?? first, { thumb: true }) : null,
        el('span', { class: 'badge ' + (j.state === 'done' ? 'ok' : j.state === 'error' ? 'err' : ''),
                     text: stateLabel(j.state) }),
        el('span', { class: 'grow', text: bits.join(' · ') }),
        el('span', { class: 'hint', text: j.id }),
      ]);
      row.addEventListener('click', () => {
        S.focusJob = j.id;
        S.centreTab = 'batch';
        S.centreMode = 'tab';
        persistCentreTab();
        hub.drawCentre();
      });
      box.appendChild(row);
    }
  });
}
