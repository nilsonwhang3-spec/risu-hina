/**
 * Merge conflicts: what to do when both sides changed the same thing.
 *
 * A conflict is the one case the re-open merge refuses to decide. Everything
 * else it settles silently - a row nobody touched here follows RisuAI, a row
 * only we changed stays - so what lands in this panel is exactly the set of
 * rows where deciding for the user would mean throwing away someone's work.
 *
 * The two buttons are deliberately blunt. `내 것 유지` keeps the panel's text
 * and lets 반영 write it; `RisuAI 것으로` drops ours and takes theirs (a
 * snapshot is taken first, backend side). Nothing here writes to RisuAI.
 */
import { el, clear, diffView, modal } from './dom';
import { state, type ConflictItem } from '../state';

const REASON: Record<string, string> = {
  'both-moved': '양쪽에서 수정됨',
  'deleted-upstream': 'RisuAI에서 삭제됨',
  'weak-match': '짝을 확신할 수 없음',
};

const KIND: Record<string, string> = {
  turn: '턴',
  lore: '로어북',
  card_field: '카드',
  card_script: '스크립트',
  memory: '장기기억',
};

function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}

/** A badge for a row that is in conflict, for the material tabs. */
export function conflictBadge(): HTMLElement {
  return el('span', {
    class: 'badge conflict', text: '⚠ 충돌',
    title: 'RisuAI 쪽에서도 이 항목이 바뀌었습니다. 어느 쪽을 남길지 골라 주세요',
  });
}

/**
 * The conflict block shown under a row: both versions and the two buttons.
 * `onDone` re-renders whatever showed it.
 */
export function conflictBox(item: ConflictItem, onDone: () => void): HTMLElement {
  const out = el('div', { class: 'outbox' });
  const mine = text(item.mine);
  const theirs = text(item.theirs);

  const decide = async (choice: 'mine' | 'theirs') => {
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '정리하는 중입니다…' }));
    try {
      await state.resolveConflict(item.kind, item.id, choice);
      onDone();
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
    }
  };

  const keep = el('button', { class: 'primary tiny', text: '내 것 유지' });
  keep.addEventListener('click', () => void decide('mine'));
  const take = el('button', { class: 'ghost tiny', text: item.theirs === null ? 'RisuAI대로 삭제' : 'RisuAI 것으로' });
  take.addEventListener('click', () => void decide('theirs'));

  return el('div', { class: 'conflictbox' }, [
    el('div', { class: 'conflicthead' }, [
      el('span', { class: 'badge conflict', text: '⚠ 충돌' }),
      el('span', { class: 'hint', text: `${KIND[item.kind] ?? item.kind} · ${REASON[item.reason] ?? item.reason}` }),
      el('span', { class: 'spacer' }),
      keep, take,
    ]),
    item.theirs === null
      ? el('div', { class: 'hint', text: 'RisuAI 쪽에서는 이 항목이 사라졌습니다. 여기서 편집 중이라 남겨 두었습니다.' })
      : diffView(mine, theirs, { context: 3 }),
    out,
  ]);
}

/**
 * Every conflict in one list, opened from the bar. The per-row boxes are the
 * usual way in; this exists for "there are eleven of them and I want them
 * gone", which is the state a big RisuAI-side edit leaves behind.
 */
export function openConflicts(scope: 'chat' | 'card', onDone: () => void): void {
  const body = el('div');
  const out = el('div', { class: 'outbox' });

  const render = async () => {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    let items: ConflictItem[] = [];
    try {
      items = await state.conflicts(scope);
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
      return;
    }
    clear(body);
    if (!items.length) {
      body.appendChild(el('div', { class: 'empty', text: '남은 충돌이 없습니다.' }));
      onDone();
      return;
    }
    const all = (choice: 'mine' | 'theirs') => async () => {
      clear(out);
      out.appendChild(el('div', { class: 'hint', text: '정리하는 중입니다…' }));
      try {
        const n = await state.resolveAllConflicts(choice, scope);
        clear(out);
        out.appendChild(el('div', { class: 'notice ok', text: `${n}건을 정리했습니다.` }));
        await render();
      } catch (e) {
        clear(out);
        out.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
      }
    };
    const mineAll = el('button', { class: 'ghost tiny', text: '전부 내 것 유지' });
    mineAll.addEventListener('click', all('mine'));
    const theirsAll = el('button', { class: 'ghost tiny', text: '전부 RisuAI 것으로' });
    theirsAll.addEventListener('click', all('theirs'));
    body.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'hint', text: `${items.length}건` }), el('span', { class: 'spacer' }),
      mineAll, theirsAll,
    ]));
    for (const it of items) {
      body.appendChild(el('div', { class: 'conflictrow' }, [
        el('div', { class: 'conflictname', text: `${KIND[it.kind] ?? it.kind} · ${it.label}` }),
        conflictBox(it, () => void render()),
      ]));
    }
    onDone();
  };

  void render();
  modal('충돌 정리', el('div', {}, [
    el('div', { class: 'hint', style: { marginBottom: '8px' },
      text: '패널에서 편집한 항목을 RisuAI 쪽에서도 바꿨습니다. 어느 쪽을 남길지 고르면 반영할 수 있습니다.' }),
    body, out,
  ]), { wide: true });
}
