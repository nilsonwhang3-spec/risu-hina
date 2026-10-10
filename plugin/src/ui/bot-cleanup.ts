/**
 * 설정 → 저장공간 정리 (§1-102): the bots Hina holds that RisuAI no longer has.
 *
 * Hina keeps a working copy of every bot opened in the panel. RisuAI gives an
 * imported .charx a new id, so a bot imported again (a new version) is a new
 * entry here and the old one stays after the user deletes or trashes it in
 * RisuAI - and the AI's reference lookup saw both. This tab compares Hina's
 * bots with RisuAI's character list and lists the ones RisuAI no longer has:
 *
 *   RisuAI 휴지통   in RisuAI's trash (gone for good three days after)
 *   RisuAI에 없음   deleted, or PocketRisu 휴지통/비활성화 - a plugin cannot
 *                   tell those apart (PocketRisu keeps them outside the list
 *                   plugins can read), or a bot from another RisuAI
 *
 * Its own settings tab, not a card among the connection's (user: some people
 * have hundreds of bots): a filter, state chips, 30 rows a page, checkboxes
 * and one bulk 삭제. Each row also saves a .charx from Hina's working copy.
 * A bot RisuAI has is never offered, and nothing here touches RisuAI.
 */
import { el, clear, armed, fmtTime } from './dom';
import { state, type HinaBot } from '../state';

const LABEL: Record<string, string> = { trash: 'RisuAI 휴지통', missing: 'RisuAI에 없음' };
const PAGE = 30;
type Chip = 'all' | 'trash' | 'missing' | 'namesake';
const CHIPS: [Chip, string][] = [['all', '전체'], ['trash', '휴지통'], ['missing', 'RisuAI에 없음'], ['namesake', '같은 이름이 RisuAI에 있음']];

export function buildBotCleanupCard(onMount?: (refresh: () => Promise<void>) => void): HTMLElement {
  let bots: HinaBot[] = [];
  let chip: Chip = 'all';
  let filter = '';
  let page = 0;
  const picked = new Set<string>();

  const summary = el('div', { class: 'hint' });
  const out = el('div', {});
  const tools = el('div', { class: 'row botcleantools' });
  const list = el('div', { class: 'chatlist botcleanlist' });
  const nav = el('div', {});
  const compare = el('button', { class: 'primary tiny', text: 'RisuAI와 대조' }) as HTMLButtonElement;
  compare.title = 'RisuAI의 캐릭터 목록을 읽어 Hina의 봇과 맞춰 봅니다 (처음에는 RisuAI가 데이터 접근 권한을 묻습니다)';

  const search = el('input', { class: 'searchinput', type: 'search', placeholder: '이름으로 찾기' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value; page = 0; drawRows(); });
  const chipBox = el('div', { class: 'row botcleanchips' });
  const pickAll = el('input', { type: 'checkbox', title: '보이는 쪽 전체 선택' }) as HTMLInputElement;
  const bulk = el('button', { class: 'ghost tiny danger' }) as HTMLButtonElement;

  const gone = () => bots.filter((b) => b.state === 'trash' || b.state === 'missing');
  const shown = () => {
    const needle = filter.trim().toLowerCase();
    return gone().filter((b) => (chip === 'all' || (chip === 'namesake' ? b.liveNamesake : b.state === chip))
      && (!needle || b.name.toLowerCase().includes(needle)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || b.updatedAt - a.updatedAt);
  };

  const drawSummary = (): void => {
    const by = (s: string) => bots.filter((b) => b.state === s).length;
    const checked = Math.max(0, ...bots.map((b) => b.checkedAt || 0));
    const unchecked = bots.filter((b) => !b.state).length;
    summary.textContent = `Hina의 봇 ${bots.length}개 · RisuAI에 있음 ${by('live')} · 휴지통 ${by('trash')} · 없음 ${by('missing')}`
      + (unchecked ? ` · 대조 안 됨 ${unchecked}` : '')
      + (checked ? ` · 마지막 대조 ${fmtTime(checked * 1000)}` : ' · 아직 대조하지 않았습니다');
  };

  const syncBulk = (): void => {
    for (const k of [...picked]) if (!gone().some((b) => b.charKey === k)) picked.delete(k);
    bulk.textContent = picked.size ? `선택한 ${picked.size}개 Hina에서 삭제` : '선택 삭제';
    bulk.disabled = !picked.size;
    const vis = shown().slice(page * PAGE, page * PAGE + PAGE);
    pickAll.checked = vis.length > 0 && vis.every((b) => picked.has(b.charKey));
  };

  const drawChips = (): void => {
    clear(chipBox);
    for (const [id, label] of CHIPS) {
      const n = id === 'all' ? gone().length : id === 'namesake' ? gone().filter((b) => b.liveNamesake).length
        : gone().filter((b) => b.state === id).length;
      const b = el('button', { class: 'ghost tiny chip' + (chip === id ? ' on' : ''), text: `${label} ${n}` });
      b.addEventListener('click', () => { chip = id; page = 0; drawChips(); drawRows(); });
      chipBox.appendChild(b);
    }
  };

  const drawRows = (): void => {
    clear(list);
    clear(nav);
    const rows = shown();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    page = Math.min(page, pages - 1);
    tools.style.display = gone().length ? '' : 'none';
    list.style.display = rows.length ? '' : 'none';
    for (const b of rows.slice(page * PAGE, page * PAGE + PAGE)) {
      list.appendChild(row(b, picked, () => syncBulk(), () => { void reload(); }));
    }
    if (!rows.length && gone().length) nav.appendChild(el('div', { class: 'hint', text: '조건에 맞는 봇이 없습니다.' }));
    if (pages > 1) {
      const prev = el('button', { class: 'ghost tiny', text: '‹ 이전' }) as HTMLButtonElement;
      const next = el('button', { class: 'ghost tiny', text: '다음 ›' }) as HTMLButtonElement;
      prev.disabled = page === 0;
      next.disabled = page === pages - 1;
      prev.addEventListener('click', () => { page -= 1; drawRows(); });
      next.addEventListener('click', () => { page += 1; drawRows(); });
      const from = page * PAGE + 1;
      nav.appendChild(el('div', { class: 'row pagenav' }, [prev,
        el('span', { class: 'hint grow', style: { textAlign: 'center' }, text: `${from}–${Math.min(rows.length, from + PAGE - 1)} / ${rows.length}` }), next]));
    }
    syncBulk();
  };

  const draw = (next: HinaBot[]): void => {
    bots = next;
    drawSummary();
    drawChips();
    drawRows();
    if (!gone().length && bots.some((b) => b.checkedAt)) {
      out.replaceChildren(el('div', { class: 'hint', text: 'RisuAI에 없는 봇이 없습니다.' }));
    }
  };

  const reload = async (): Promise<void> => {
    try { draw(await state.hinaBots()); } catch (e) { summary.textContent = '봇 목록을 읽지 못했습니다: ' + msg(e); }
  };

  pickAll.addEventListener('change', () => {
    for (const b of shown().slice(page * PAGE, page * PAGE + PAGE)) {
      if (pickAll.checked) picked.add(b.charKey); else picked.delete(b.charKey);
    }
    drawRows();
  });
  armed(bulk, '선택 삭제', '정말 지울까요?', async () => {
    const keys = [...picked];
    bulk.disabled = true;
    bulk.textContent = `${keys.length}개 지우는 중…`;
    clear(out);
    try {
      const r = await state.forgetBots(keys);
      picked.clear();
      out.appendChild(el('div', { class: 'notice ' + (r.failed.length ? 'err' : 'ok'), text:
        `Hina에서 ${r.forgotten.length}개를 지웠습니다.` + (r.failed.length ? ` ${r.failed.length}개는 지우지 못했습니다: ${r.failed[0].error}` : '')
        + ' RisuAI 쪽과 projects/ 의 파일은 그대로입니다.' }));
    } catch (e) {
      out.appendChild(el('div', { class: 'notice err', text: '지우지 못했습니다: ' + msg(e) }));
    }
    await reload();
  });
  tools.append(el('label', { class: 'row', title: '이 쪽에 보이는 봇 전체 선택' }, [pickAll, el('span', { class: 'hint', text: '이 쪽 전체' })]),
    el('span', { class: 'grow' }), bulk);

  compare.addEventListener('click', async () => {
    compare.disabled = true;
    compare.textContent = 'RisuAI 목록 읽는 중…';
    clear(out);
    try {
      const r = await state.compareBots();
      draw(r.bots);
      out.replaceChildren(el('div', { class: 'notice ok', text:
        `RisuAI 캐릭터 ${r.risuCount}개와 대조했습니다 — 휴지통 ${r.counts.trash ?? 0} · 없음 ${r.counts.missing ?? 0}` }));
    } catch (e) {
      out.replaceChildren(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      compare.disabled = false;
      compare.textContent = 'RisuAI와 대조';
    }
  });

  onMount?.(reload);
  void reload();
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Hina에만 남은 봇' }),
    el('div', { class: 'hint', text: 'RisuAI에서 지웠거나 휴지통에 넣은 봇, 다시 임포트해 새 봇이 된 옛 버전의 Hina 작업본입니다. '
      + 'CharX로 받아 두거나 Hina에서 지울 수 있습니다 (RisuAI 쪽은 건드리지 않습니다).' }),
    el('div', { class: 'row', style: { margin: '6px 0' } }, [compare]),
    summary,
    out,
    el('div', { class: 'landfilter', style: { marginTop: '8px' } }, [search]),
    chipBox,
    tools,
    list,
    nav,
    el('div', { class: 'hint', style: { marginTop: '8px' }, text: '포켓리스의 휴지통·비활성화(보관) 봇은 플러그인이 볼 수 없는 곳에 있어 "RisuAI에 없음"으로 나옵니다. '
      + '가리기만 한 봇은 RisuAI에 있음으로 셉니다. 지워도 projects/ 의 파일은 남고, 이미지 저장소는 스토어 정리(GC)가 정리합니다.' }),
  ]);
}

function row(b: HinaBot, picked: Set<string>, onPick: () => void, after: () => void): HTMLElement {
  const note = el('div', { class: 'hint' });
  const pick = el('input', { type: 'checkbox', title: '선택' }) as HTMLInputElement;
  pick.checked = picked.has(b.charKey);
  pick.addEventListener('change', () => { if (pick.checked) picked.add(b.charKey); else picked.delete(b.charKey); onPick(); });
  const save = el('button', { class: 'ghost tiny', text: 'CharX로 저장', title: 'Hina 작업본으로 .charx 를 만들어 받습니다' }) as HTMLButtonElement;
  if (!b.charxReady) {
    save.disabled = true;
    save.title = '옛 방식(카드 일부만)으로 올라간 작업본이라 CharX를 만들 수 없습니다 - RisuAI에 원본이 있다면 거기서 내보내 주세요';
  }
  save.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    save.disabled = true;
    save.textContent = '만드는 중…';
    try {
      const r = await state.charxOf(b.charKey);
      note.textContent = `${r.path} 에 만들었습니다` + (r.missing?.length ? ` (Hina에 없는 에셋 ${r.missing.length}개는 빠졌습니다)` : '');
      await state.downloadFile(r.path);
    } catch (e) {
      note.textContent = 'CharX를 만들지 못했습니다: ' + msg(e);
    } finally {
      save.disabled = false;
      save.textContent = 'CharX로 저장';
    }
  });
  const del = el('button', { class: 'ghost tiny danger', title: 'Hina의 작업본·대화 기록을 지웁니다 (RisuAI는 그대로)' }) as HTMLButtonElement;
  const item = el('div', { class: 'chatitem botcleanrow' });
  armed(del, 'Hina에서 삭제', '정말 지울까요?', async () => {
    del.disabled = true;
    save.disabled = true;
    item.classList.add('deleting');
    try {
      await state.forgetBot(b.charKey);
      picked.delete(b.charKey);
      after();
    } catch (e) {
      item.classList.remove('deleting');
      del.disabled = false;
      save.disabled = !b.charxReady;
      note.textContent = '지우지 못했습니다: ' + msg(e);
    }
  });
  const when = b.state === 'trash' && b.purgeAt ? ` · RisuAI가 ${fmtTime(b.purgeAt)}에 영구 삭제` : '';
  item.append(
    pick,
    el('span', { class: 'grow' }, [
      el('div', { text: b.name || '(이름 없음)' }),
      el('div', { class: 'hint', text: `챗 ${b.chats}개 · ${b.turns}턴 · Hina 수정 ${fmtTime(b.updatedAt * 1000)}${when}`
        + (b.pendingActions ? ` · 승인 대기 ${b.pendingActions}` : '') }),
      note,
    ]),
    el('span', { class: 'badge' + (b.state === 'trash' ? ' warn' : ''), text: LABEL[b.state] || b.state }),
    save, del,
  );
  if (b.liveNamesake) {
    item.insertBefore(el('span', { class: 'badge ok', text: '같은 이름이 RisuAI에 있음',
      title: '다시 임포트한 새 버전일 가능성이 큽니다 - 이 항목은 옛 버전의 Hina 작업본입니다' }), save);
  }
  return item;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
