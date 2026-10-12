/**
 * 설정 → 저장공간 정리 (§1-102, §1-106): four sections behind one row of
 * buttons, because each is its own job and some people have hundreds of bots.
 *
 *   봇 · 챗 · 모듈   Hina's working copies of what RisuAI no longer has. One
 *                   'RisuAI와 대조' reads RisuAI's characters (with their chat
 *                   ids) and modules once; the backend records what is gone:
 *                   a bot deleted / trashed / imported again as a new bot, a
 *                   chat deleted from a bot that is still there, a module
 *                   deleted. Nothing RisuAI has is ever offered.
 *   스냅샷          every snapshot (bot, module, chat, persona) in one list -
 *                   the automatic backups piled up where only each owner's
 *                   버전 popover could reach them.
 *   이미지          the image store (§1-103).
 *   임시파일        the workspace's temporary files by kind, split by bot.
 *
 * The lists share one shape (pagedList): a filter, state chips, 30 rows a page,
 * checkboxes and one bulk 삭제. Nothing here touches RisuAI.
 */
import { el, clear, armed, fmtTime } from './dom';
import * as host from '../host';
import { fmtSize } from './studio/store';
import {
  state, type HinaBot, type AssetUsage, type OrphanChat, type OrphanModule, type StoredSnapshot, type TempKind,
} from '../state';

const PAGE = 30;

// --- the shared list ----------------------------------------------------------

type Chip<T> = [string, string, (t: T) => boolean];

interface ListSpec<T> {
  key: (t: T) => string;
  /** What the filter box matches against. */
  text: (t: T) => string;
  sort?: (a: T, b: T) => number;
  /** Rows of chips; the first chip of each row is 'all'. */
  chips?: Chip<T>[][];
  row: (t: T, ctx: RowCtx<T>) => HTMLElement;
  /** Deletes; returns the notice to show. */
  remove: (keys: string[]) => Promise<{ text: string; err?: boolean }>;
  empty: string;
  placeholder?: string;
}

interface RowCtx<T> {
  pick: (t: T) => HTMLInputElement;
  del: (t: T, item: HTMLElement) => HTMLButtonElement;
}

interface PagedList<T> {
  root: HTMLElement;
  set: (items: T[]) => void;
  notice: (text: string, err?: boolean) => void;
}

function pagedList<T>(spec: ListSpec<T>): PagedList<T> {
  let items: T[] = [];
  let filter = '';
  let page = 0;
  const on = (spec.chips ?? []).map(() => 0);
  const picked = new Set<string>();

  const out = el('div', {});
  const chipBox = el('div', {});
  const tools = el('div', { class: 'row botcleantools' });
  const list = el('div', { class: 'chatlist botcleanlist' });
  const nav = el('div', {});
  const search = el('input', { class: 'searchinput', type: 'search', placeholder: spec.placeholder ?? '이름으로 찾기' }) as HTMLInputElement;
  search.addEventListener('input', () => { filter = search.value; page = 0; drawRows(); });
  const pickAll = el('input', { type: 'checkbox', title: '이 쪽에 보이는 것 전체 선택' }) as HTMLInputElement;
  const pickEvery = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  const bulk = el('button', { class: 'ghost tiny danger' }) as HTMLButtonElement;

  const passes = (t: T, skip = -1): boolean => (spec.chips ?? []).every((row, i) => i === skip || row[on[i]][2](t));
  const shown = (): T[] => {
    const needle = filter.trim().toLowerCase();
    const rows = items.filter((t) => passes(t) && (!needle || spec.text(t).toLowerCase().includes(needle)));
    return spec.sort ? rows.sort(spec.sort) : rows;
  };
  const visible = (): T[] => shown().slice(page * PAGE, page * PAGE + PAGE);

  const sync = (): void => {
    const keys = new Set(items.map(spec.key));
    for (const k of [...picked]) if (!keys.has(k)) picked.delete(k);
    bulk.textContent = picked.size ? `선택한 ${picked.size}개 삭제` : '선택 삭제';
    bulk.disabled = !picked.size;
    const vis = visible();
    pickAll.checked = vis.length > 0 && vis.every((t) => picked.has(spec.key(t)));
    const all = shown();
    pickEvery.textContent = `조건에 맞는 ${all.length}개 모두 선택`;
    pickEvery.style.display = all.length > PAGE && !all.every((t) => picked.has(spec.key(t))) ? '' : 'none';
  };

  const drawChips = (): void => {
    clear(chipBox);
    (spec.chips ?? []).forEach((row, i) => {
      const box = el('div', { class: 'row botcleanchips' });
      row.forEach(([, label, pred], j) => {
        const n = items.filter((t) => passes(t, i) && pred(t)).length;
        const b = el('button', { class: 'ghost tiny chip' + (on[i] === j ? ' on' : ''), text: `${label} ${n}` });
        b.addEventListener('click', () => { on[i] = j; page = 0; drawChips(); drawRows(); });
        box.appendChild(b);
      });
      chipBox.appendChild(box);
    });
  };

  const ctx: RowCtx<T> = {
    pick: (t) => {
      const box = el('input', { type: 'checkbox', title: '선택' }) as HTMLInputElement;
      box.checked = picked.has(spec.key(t));
      box.addEventListener('change', () => { if (box.checked) picked.add(spec.key(t)); else picked.delete(spec.key(t)); sync(); });
      return box;
    },
    del: (t, item) => {
      const b = el('button', { class: 'ghost tiny danger', title: 'Hina에서 지웁니다 (RisuAI는 그대로)' }) as HTMLButtonElement;
      armed(b, '삭제', '정말 지울까요?', async () => {
        b.disabled = true;
        item.classList.add('deleting');
        await removeKeys([spec.key(t)]);
      });
      return b;
    },
  };

  const drawRows = (): void => {
    clear(list);
    clear(nav);
    const rows = shown();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    page = Math.min(page, pages - 1);
    tools.style.display = items.length ? '' : 'none';
    list.style.display = rows.length ? '' : 'none';
    for (const t of visible()) list.appendChild(spec.row(t, ctx));
    if (!rows.length) nav.appendChild(el('div', { class: 'hint', text: items.length ? '조건에 맞는 항목이 없습니다.' : spec.empty }));
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
    sync();
  };

  const notice = (text: string, err = false): void => {
    out.replaceChildren(el('div', { class: 'notice ' + (err ? 'err' : 'ok'), text }));
  };

  const removeKeys = async (keys: string[]): Promise<void> => {
    bulk.disabled = true;
    try {
      const r = await spec.remove(keys);
      for (const k of keys) picked.delete(k);
      notice(r.text, r.err);
    } catch (e) {
      notice('지우지 못했습니다: ' + msg(e), true);
    }
  };

  pickAll.addEventListener('change', () => {
    for (const t of visible()) { if (pickAll.checked) picked.add(spec.key(t)); else picked.delete(spec.key(t)); }
    drawRows();
  });
  pickEvery.addEventListener('click', () => { for (const t of shown()) picked.add(spec.key(t)); drawRows(); });
  armed(bulk, '선택 삭제', '정말 지울까요?', async () => {
    const keys = [...picked];
    bulk.textContent = `${keys.length}개 지우는 중…`;
    await removeKeys(keys);
  });
  tools.append(el('label', { class: 'row', title: '이 쪽에 보이는 것 전체 선택' }, [pickAll, el('span', { class: 'hint', text: '이 쪽 전체' })]),
    pickEvery, el('span', { class: 'grow' }), bulk);

  const root = el('div', {}, [
    out,
    el('div', { class: 'landfilter', style: { marginTop: '8px' } }, [search]),
    chipBox, tools, list, nav,
  ]);
  return {
    root,
    set: (next) => { items = next; drawChips(); drawRows(); },
    notice,
  };
}

// --- 봇 · 챗 · 모듈 ----------------------------------------------------------

const BOT_LABEL: Record<string, string> = { trash: 'RisuAI 휴지통', missing: 'RisuAI에 없음' };

function buildOrphanCard(onMount?: (refresh: () => Promise<void>) => void): HTMLElement {
  let bots: HinaBot[] = [];
  let chats: OrphanChat[] = [];
  let mods: OrphanModule[] = [];
  let kind: 'bot' | 'chat' | 'module' = 'bot';

  const summary = el('div', { class: 'hint' });
  const out = el('div', {});
  const kinds = el('div', { class: 'row botcleanchips' });
  const body = el('div', {});
  const compare = el('button', { class: 'primary tiny', text: 'RisuAI와 대조' }) as HTMLButtonElement;
  compare.title = 'RisuAI의 캐릭터(챗 포함)·모듈 목록을 읽어 Hina의 작업본과 맞춰 봅니다 (처음에는 RisuAI가 데이터 접근 권한을 묻습니다)';

  const goneBots = () => bots.filter((b) => b.state === 'trash' || b.state === 'missing');

  const botList = pagedList<HinaBot>({
    key: (b) => b.charKey,
    text: (b) => b.name,
    sort: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || b.updatedAt - a.updatedAt,
    chips: [[['all', '전체', () => true], ['trash', '휴지통', (b) => b.state === 'trash'],
      ['missing', 'RisuAI에 없음', (b) => b.state === 'missing'], ['namesake', '같은 이름이 RisuAI에 있음', (b) => b.liveNamesake]]],
    row: botRow,
    remove: async (keys) => {
      const r = await state.forgetBots(keys);
      const handed = r.forgotten.reduce((n, f) => n + (f.snapshotsHanded ?? 0), 0);
      await reload();
      return { err: !!r.failed.length, text: `봇 ${r.forgotten.length}개를 Hina에서 지웠습니다.`
        + (r.failed.length ? ` ${r.failed.length}개는 지우지 못했습니다: ${r.failed[0].error}` : '')
        + (handed ? ` 봇 스냅샷 ${handed}개는 같은 이름의 봇으로 넘겼습니다.` : '')
        + ' RisuAI 쪽과 projects/ 의 파일은 그대로입니다.' };
    },
    empty: 'RisuAI에 없는 봇이 없습니다.',
  });
  const chatList = pagedList<OrphanChat>({
    key: (c) => c.chatKey,
    text: (c) => `${c.bot} ${c.name}`,
    sort: (a, b) => a.bot.localeCompare(b.bot, undefined, { numeric: true }) || b.updatedAt - a.updatedAt,
    chips: [[['all', '전체', () => true], ['edits', 'AI 대화·편집이 있는 챗', (c) => c.sessions > 0 || c.staged > 0 || c.snapshots > 0]]],
    row: chatRow,
    remove: async (keys) => {
      const r = await state.forgetChats(keys);
      await reload();
      return { err: !!r.failed.length, text: `챗 ${r.forgotten.length}개를 Hina에서 지웠습니다.`
        + (r.failed.length ? ` ${r.failed.length}개는 지우지 못했습니다: ${r.failed[0].error}` : '') + ' RisuAI 쪽은 그대로입니다.' };
    },
    placeholder: '봇·챗 이름으로 찾기',
    empty: '지운 챗이 남아 있지 않습니다.',
  });
  const modList = pagedList<OrphanModule>({
    key: (m) => m.key,
    text: (m) => m.name,
    sort: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
    row: moduleRow,
    remove: async (keys) => {
      const r = await state.forgetModules(keys);
      await reload();
      return { err: !!r.failed.length, text: `모듈 ${r.forgotten.length}개를 Hina에서 지웠습니다.`
        + (r.failed.length ? ` ${r.failed.length}개는 지우지 못했습니다: ${r.failed[0].error}` : '') + ' RisuAI 쪽은 그대로입니다.' };
    },
    empty: 'RisuAI에 없는 모듈이 없습니다.',
  });

  const drawKinds = (): void => {
    clear(kinds);
    const entries: ['bot' | 'chat' | 'module', string, number][] = [
      ['bot', '고아 봇', goneBots().length], ['chat', '고아 챗', chats.length], ['module', '고아 모듈', mods.length]];
    for (const [id, label, n] of entries) {
      const b = el('button', { class: 'ghost tiny chip' + (kind === id ? ' on' : ''), text: `${label} ${n}`, dataset: { orphanKind: id } });
      b.addEventListener('click', () => { kind = id; drawKinds(); drawBody(); });
      kinds.appendChild(b);
    }
  };
  const drawBody = (): void => {
    const [list, hint] = kind === 'bot'
      ? [botList, 'RisuAI에서 지웠거나 휴지통에 넣은 봇, 다시 임포트해 새 봇이 된 옛 버전의 작업본입니다. CharX로 받아 둘 수 있습니다. '
        + '포켓리스의 휴지통·비활성화(보관) 봇은 플러그인이 볼 수 없어 "RisuAI에 없음"으로 나옵니다. 봇 스냅샷은 RisuAI에 있는 같은 이름의 봇으로 넘어가고, 없으면 함께 지워집니다.']
      : kind === 'chat'
        ? [chatList, 'RisuAI에 있는 봇에서 지운 챗의 작업본입니다. JSON(risuChat)으로 받아 RisuAI에 다시 가져올 수 있습니다. 지우면 그 챗의 턴·AI 대화·편집 대기·챗 스냅샷이 함께 지워집니다. '
          + '휴지통이나 RisuAI에 없는 봇의 챗은 봇과 함께 지워지므로 여기 나오지 않습니다.']
        : [modList, 'RisuAI에서 지운 모듈의 작업본입니다. risum으로 받아 둘 수 있습니다. 지우면 모듈 스냅샷도 함께 지워집니다.'];
    body.replaceChildren(el('div', { class: 'hint', style: { margin: '6px 0' }, text: hint }), list.root);
  };
  const drawSummary = (): void => {
    const by = (s: string) => bots.filter((b) => b.state === s).length;
    const checked = Math.max(0, ...bots.map((b) => b.checkedAt || 0));
    const unchecked = bots.filter((b) => !b.state).length;
    summary.textContent = `Hina의 봇 ${bots.length}개 · RisuAI에 있음 ${by('live')} · 휴지통 ${by('trash')} · 없음 ${by('missing')}`
      + (unchecked ? ` · 대조 안 됨 ${unchecked}` : '')
      + (checked ? ` · 마지막 대조 ${fmtTime(checked * 1000)}` : ' · 아직 대조하지 않았습니다');
  };

  const reload = async (): Promise<void> => {
    try {
      [bots, chats, mods] = await Promise.all([state.hinaBots(), state.orphanChats(), state.orphanModules()]);
    } catch (e) {
      summary.textContent = '목록을 읽지 못했습니다: ' + msg(e);
      return;
    }
    drawSummary();
    drawKinds();
    botList.set(goneBots());
    chatList.set(chats);
    modList.set(mods);
  };

  compare.addEventListener('click', async () => {
    compare.disabled = true;
    compare.textContent = 'RisuAI 목록 읽는 중…';
    clear(out);
    try {
      const r = await state.compareBots();
      await reload();
      const mc = r.moduleCounts && 'missing' in r.moduleCounts ? ` · 모듈 ${r.moduleCounts.missing ?? 0}` : '';
      out.replaceChildren(el('div', { class: 'notice ok', text:
        `RisuAI 캐릭터 ${r.risuCount}개와 대조했습니다 — 봇: 휴지통 ${r.counts.trash ?? 0} · 없음 ${r.counts.missing ?? 0}`
        + ` · 챗 ${r.chatCounts?.missing ?? 0}${mc}` }));
    } catch (e) {
      out.replaceChildren(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      compare.disabled = false;
      compare.textContent = 'RisuAI와 대조';
    }
  });

  onMount?.(reload);
  void reload();
  drawKinds();
  drawBody();
  return el('div', { class: 'card' }, [
    el('h2', { text: 'Hina에만 남은 봇 · 챗 · 모듈' }),
    el('div', { class: 'hint', text: 'Hina는 패널에서 연 봇·챗·모듈마다 작업본을 둡니다. RisuAI에서 지운 뒤에도 남는 그 작업본을 찾아 지웁니다 (RisuAI 쪽은 건드리지 않습니다).' }),
    el('div', { class: 'row', style: { margin: '6px 0' } }, [compare]),
    summary,
    out,
    kinds,
    body,
  ]);
}

function botRow(b: HinaBot, ctx: RowCtx<HinaBot>): HTMLElement {
  const note = el('div', { class: 'hint' });
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
  const item = el('div', { class: 'chatitem botcleanrow' });
  const when = b.state === 'trash' && b.purgeAt ? ` · RisuAI가 ${fmtTime(b.purgeAt)}에 영구 삭제` : '';
  item.append(
    ctx.pick(b),
    el('span', { class: 'grow' }, [
      el('div', { text: b.name || '(이름 없음)' }),
      el('div', { class: 'hint', text: `챗 ${b.chats}개 · ${b.turns}턴 · Hina 수정 ${fmtTime(b.updatedAt * 1000)}${when}`
        + (b.pendingActions ? ` · 승인 대기 ${b.pendingActions}` : '')
        + (b.snapshots ? ` · 봇 스냅샷 ${b.snapshots}개` + (b.snapshotHeir ? ` → 삭제하면 '${b.snapshotHeir}'(으)로 넘어감` : ' (삭제하면 함께 지워짐)') : '') }),
      note,
    ]),
  );
  if (b.liveNamesake) {
    item.appendChild(el('span', { class: 'badge ok', text: '같은 이름이 RisuAI에 있음',
      title: '다시 임포트한 새 버전일 가능성이 큽니다 - 이 항목은 옛 버전의 Hina 작업본입니다' }));
  }
  item.append(el('span', { class: 'badge' + (b.state === 'trash' ? ' warn' : ''), text: BOT_LABEL[b.state] || b.state }),
    save, ctx.del(b, item));
  return item;
}

function chatRow(c: OrphanChat, ctx: RowCtx<OrphanChat>): HTMLElement {
  const item = el('div', { class: 'chatitem botcleanrow' });
  const note = el('div', { class: 'hint' });
  const save = el('button', { class: 'ghost tiny', text: 'JSON으로 저장',
    title: 'Hina 작업본으로 risuChat JSON 을 받습니다 - RisuAI의 챗 가져오기로 다시 넣을 수 있습니다' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await state.chatEnvelope(c.chatKey);
      const name = `${c.bot || 'chat'} - ${c.name || c.chatKey}`.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
      host.download(`${name}.json`, JSON.stringify(r.envelope), 'application/json');
      note.textContent = '내려받았습니다. RisuAI 챗 목록의 가져오기로 다시 넣을 수 있습니다.';
    } catch (e) {
      note.textContent = 'JSON을 만들지 못했습니다: ' + msg(e);
    } finally {
      save.disabled = false;
    }
  });
  const extra = [c.sessions ? `AI 대화 ${c.sessions}` : '', c.staged ? `승인 대기 편집 ${c.staged}` : '',
    c.snapshots ? `챗 스냅샷 ${c.snapshots}개` : ''].filter(Boolean).join(' · ');
  item.append(
    ctx.pick(c),
    el('span', { class: 'grow' }, [
      el('div', { text: `${c.bot || '(이름 없는 봇)'} › ${c.name || '(이름 없는 챗)'}` }),
      el('div', { class: 'hint', text: `${c.turns}턴 · Hina 수정 ${fmtTime(c.updatedAt * 1000)}` + (extra ? ' · ' + extra : '') }),
      note,
    ]),
    el('span', { class: 'badge', text: 'RisuAI에서 지운 챗' }),
    save,
    ctx.del(c, item),
  );
  return item;
}

function moduleRow(m: OrphanModule, ctx: RowCtx<OrphanModule>): HTMLElement {
  const note = el('div', { class: 'hint' });
  const save = el('button', { class: 'ghost tiny', text: 'risum으로 저장', title: 'Hina 작업본으로 .risum 을 만들어 받습니다' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.textContent = '만드는 중…';
    try {
      const r = await state.exportModule('risum', true, '', m.key);
      note.textContent = `${r.path} 에 만들었습니다` + (r.dropped ? ` (Hina에 없는 에셋 ${r.dropped}개는 빠졌습니다)` : '');
      await state.downloadFile(r.path);
    } catch (e) {
      note.textContent = 'risum을 만들지 못했습니다: ' + msg(e);
    } finally {
      save.disabled = false;
      save.textContent = 'risum으로 저장';
    }
  });
  const item = el('div', { class: 'chatitem botcleanrow' });
  const parts = [`로어 ${m.lore}`, `정규식 ${m.regex}`, `트리거 ${m.trigger}`, `에셋 ${m.assets}`];
  if (m.snapshots) parts.push(`스냅샷 ${m.snapshots}개`);
  item.append(
    ctx.pick(m),
    el('span', { class: 'grow' }, [
      el('div', { text: m.name || '(이름 없음)' }),
      el('div', { class: 'hint', text: parts.join(' · ') }),
      note,
    ]),
  );
  if (m.dirty) item.appendChild(el('span', { class: 'badge warn', text: `반영 안 한 수정 ${m.total}`, title: 'Hina에서 고친 뒤 RisuAI에 반영하지 않은 내용이 있습니다 - 지우기 전에 risum으로 받아 두세요' }));
  item.append(el('span', { class: 'badge', text: 'RisuAI에 없음' }), save, ctx.del(m, item));
  return item;
}

// --- 스냅샷 ---------------------------------------------------------------------

const SNAP_TYPE: Record<StoredSnapshot['type'], string> = { bot: '봇', module: '모듈', chat: '챗', persona: '페르소나' };

function buildSnapshotCard(): { card: HTMLElement; load: () => Promise<void> } {
  let rows: StoredSnapshot[] = [];
  const summary = el('div', { class: 'hint', text: '불러오는 중…' });
  const key = (s: StoredSnapshot) => `${s.type}:${s.id}`;
  const list = pagedList<StoredSnapshot>({
    key,
    text: (s) => `${s.owner} ${s.sub} ${s.label}`,
    sort: (a, b) => b.createdAt - a.createdAt,
    chips: [
      [['all', '전체', () => true], ['bot', '봇', (s) => s.type === 'bot'], ['module', '모듈', (s) => s.type === 'module'],
        ['chat', '챗', (s) => s.type === 'chat'], ['persona', '페르소나', (s) => s.type === 'persona']],
      [['all', '모두', () => true], ['user', '직접 만든 것', (s) => !s.auto], ['auto', '자동 백업', (s) => s.auto],
        ['orphan', '주인이 없는 것', (s) => s.orphan || s.ownerState === 'missing' || s.ownerState === 'trash']],
    ],
    row: snapshotRow,
    remove: async (keys) => {
      const items = keys.map((k) => { const i = k.indexOf(':'); return { type: k.slice(0, i), id: k.slice(i + 1) }; });
      const r = await state.deleteSnapshots(items);
      await load();
      return { err: !!r.missing.length, text: `스냅샷 ${r.removed}개를 지웠습니다.`
        + (r.missing.length ? ` ${r.missing.length}개는 이미 없었습니다.` : '')
        + ' 그 스냅샷만 갖고 있던 이미지는 이미지 탭의 정리 대상이 됩니다.' };
    },
    placeholder: '주인·이름으로 찾기',
    empty: '스냅샷이 없습니다.',
  });
  const load = async (): Promise<void> => {
    try {
      rows = await state.storedSnapshots();
    } catch (e) {
      summary.textContent = '스냅샷을 읽지 못했습니다: ' + msg(e);
      return;
    }
    const total = rows.reduce((n, s) => n + s.bytes, 0);
    const auto = rows.filter((s) => s.auto);
    summary.textContent = `스냅샷 ${rows.length}개 · ${fmtSize(total)}`
      + ` (자동 백업 ${auto.length}개 · ${fmtSize(auto.reduce((n, s) => n + s.bytes, 0))})`;
    list.set(rows);
  };
  const card = el('div', { class: 'card' }, [
    el('h2', { text: '스냅샷' }),
    el('div', { class: 'hint', text: '봇·모듈·챗·페르소나의 스냅샷 전부입니다. 자동 백업은 반영·복원·삭제 직전에 Hina가 스스로 만든 것입니다. '
      + '주인이 없는 것은 주인(봇·챗·페르소나)이 Hina나 RisuAI에서 사라진 스냅샷입니다.' }),
    summary,
    list.root,
  ]);
  return { card, load };
}

function snapshotRow(s: StoredSnapshot, ctx: RowCtx<StoredSnapshot>): HTMLElement {
  const item = el('div', { class: 'chatitem botcleanrow' });
  const gone = s.orphan ? '주인 없음' : s.ownerState === 'missing' ? 'RisuAI에 없음' : s.ownerState === 'trash' ? 'RisuAI 휴지통' : '';
  item.append(
    ctx.pick(s),
    el('span', { class: 'badge', text: SNAP_TYPE[s.type] }),
    el('span', { class: 'grow' }, [
      el('div', { text: s.label || '(이름 없음)' }),
      el('div', { class: 'hint', text: [s.owner, s.sub, fmtTime(s.createdAt * 1000), fmtSize(s.bytes)].filter(Boolean).join(' · ') }),
    ]),
  );
  if (s.auto) item.appendChild(el('span', { class: 'badge', text: '자동' }));
  if (gone) item.appendChild(el('span', { class: 'badge warn', text: gone }));
  item.appendChild(ctx.del(s, item));
  return item;
}

// --- 임시파일 -------------------------------------------------------------------

function buildTempCard(): { card: HTMLElement; load: () => Promise<void> } {
  let plan = '';
  let kinds: TempKind[] = [];
  // kind → null (all of it) or the picked groups
  const picks = new Map<string, Set<string> | null>();
  const summary = el('div', { class: 'hint', text: '불러오는 중…' });
  const out = el('div', {});
  const list = el('div', { class: 'tempkinds' });
  const rescan = el('button', { class: 'ghost tiny', text: '다시 확인' }) as HTMLButtonElement;
  const go = el('button', { class: 'tiny danger' }) as HTMLButtonElement;

  const pickedBytes = (): number => kinds.reduce((n, k) => {
    const p = picks.get(k.id);
    if (p === undefined) return n;
    if (p === null) return n + k.bytes;
    return n + k.groups.filter((g) => p.has(g.group)).reduce((m, g) => m + g.bytes, 0);
  }, 0);
  const syncGo = (): void => {
    const b = pickedBytes();
    go.textContent = b ? `선택한 ${fmtSize(b)} 지우기` : '선택한 항목 지우기';
    go.disabled = !b || !plan;
  };

  const draw = (): void => {
    clear(list);
    for (const k of kinds) {
      const p = picks.get(k.id);
      const box = el('input', { type: 'checkbox', title: '이 종류 전체' }) as HTMLInputElement;
      box.checked = p === null;
      box.indeterminate = p instanceof Set && p.size > 0;
      box.disabled = !k.count;
      box.addEventListener('change', () => { if (box.checked) picks.set(k.id, null); else picks.delete(k.id); draw(); });
      const head = el('div', { class: 'row tempkindhead' }, [
        box,
        el('span', { class: 'grow' }, [el('b', { text: k.label }), el('div', { class: 'hint', text: k.hint })]),
        el('span', { class: 'n', text: k.count ? `${k.count.toLocaleString()}개 · ${fmtSize(k.bytes)}` : '없음' }),
      ]);
      const row = el('div', { class: 'tempkind' + (k.count ? '' : ' dim'), dataset: { kind: k.id } }, [head]);
      if (k.count && (k.groups.length > 1 || k.largest.length)) {
        const det = el('details', {});
        det.appendChild(el('summary', { class: 'hint', text: (k.groups.length > 1 ? `봇별 ${k.groups.length}곳` : '자세히')
          + (k.newest ? ` · 가장 최근 ${fmtTime(k.newest * 1000)}` : '') }));
        if (k.groups.length > 1) {
          for (const g of k.groups) {
            const gb = el('input', { type: 'checkbox' }) as HTMLInputElement;
            gb.checked = p === null || (p instanceof Set && p.has(g.group));
            gb.addEventListener('change', () => {
              const cur = picks.get(k.id);
              const set = cur === null ? new Set(k.groups.map((x) => x.group)) : (cur ?? new Set<string>());
              if (gb.checked) set.add(g.group); else set.delete(g.group);
              if (set.size === k.groups.length) picks.set(k.id, null);
              else if (set.size) picks.set(k.id, set);
              else picks.delete(k.id);
              draw();
            });
            det.appendChild(el('label', { class: 'row tempgroup' }, [gb,
              el('span', { class: 'grow', text: g.group || '(공용)' }),
              el('span', { class: 'n', text: `${g.count.toLocaleString()}개 · ${fmtSize(g.bytes)} · ${fmtTime(g.newest * 1000)}` })]));
          }
        }
        if (k.largest.length) {
          det.appendChild(el('div', { class: 'hint', style: { marginTop: '4px' }, text: '큰 파일부터:' }));
          det.appendChild(el('pre', { class: 'templargest', text: k.largest.join('\n') + (k.count > k.largest.length ? `\n… 외 ${k.count - k.largest.length}개` : '') }));
        }
        row.appendChild(det);
      }
      list.appendChild(row);
    }
    syncGo();
  };

  const load = async (): Promise<void> => {
    rescan.disabled = true;
    summary.textContent = '작업 공간을 살펴보는 중…';
    try {
      const r = await state.tempScan();
      plan = r.plan;
      kinds = r.kinds;
      for (const id of [...picks.keys()]) if (!kinds.some((k) => k.id === id && k.count)) picks.delete(id);
      const total = kinds.reduce((n, k) => n + k.bytes, 0);
      summary.textContent = `임시 파일 ${kinds.reduce((n, k) => n + k.count, 0).toLocaleString()}개 · ${fmtSize(total)}`
        + (r.aiRunning ? ' — AI가 작업 중이라 지금은 지울 수 없습니다' : '');
      draw();
    } catch (e) {
      summary.textContent = '임시 파일을 확인하지 못했습니다: ' + msg(e);
    } finally {
      rescan.disabled = false;
    }
  };

  rescan.addEventListener('click', () => { clear(out); void load(); });
  armed(go, '선택한 항목 지우기', '정말 지울까요?', async () => {
    const body: { kind: string; group?: string }[] = [];
    for (const [kind, p] of picks) {
      if (p === null) body.push({ kind });
      else for (const group of p) body.push({ kind, group });
    }
    go.disabled = true;
    go.textContent = '지우는 중…';
    try {
      const r = await state.tempClean(plan, body);
      picks.clear();
      out.replaceChildren(el('div', { class: 'notice ok', text: `${r.removed.toLocaleString()}개 · ${fmtSize(r.freed)}를 지웠습니다.`
        + (r.skipped ? ` 확인 뒤 바뀐 파일 ${r.skipped}개는 건너뛰었습니다.` : '') }));
    } catch (e) {
      out.replaceChildren(el('div', { class: 'notice err', text: '지우지 못했습니다: ' + msg(e) }));
    }
    await load();
  });
  syncGo();
  const card = el('div', { class: 'card' }, [
    el('h2', { text: '워크스페이스 임시파일' }),
    el('div', { class: 'hint', text: '작업 공간과 시스템 폴더의 임시 파일을 종류별로 보여 줍니다. 프로젝트 파일·결과물(out)·스튜디오 이미지·스킬은 여기 나오지 않습니다. '
      + '확인한 뒤 바뀐 파일은 지우지 않습니다.' }),
    el('div', { class: 'row', style: { margin: '6px 0', gap: '8px' } }, [rescan, el('span', { class: 'grow' }), go]),
    summary,
    out,
    list,
  ]);
  return { card, load };
}

// --- 이미지 ---------------------------------------------------------------------

/**
 * The image store (§1-103): every picture Hina has read from RisuAI or made,
 * kept once by content. Split by who still needs a file - a bot (or module)
 * working copy, only a bot snapshot (kept so a restore can register the
 * image in RisuAI again; deleting those snapshots frees it), or nothing.
 * 정리 removes the last kind once it is older than gcDays.
 */
function buildAssetStoreCard(): { card: HTMLElement; load: () => Promise<void> } {
  const stats = el('div', { class: 'assetusage' });
  const out = el('div', {});
  const gc = el('button', { class: 'tiny', text: '안 쓰는 이미지 정리' }) as HTMLButtonElement;
  const mb = (n: number) => `${(n / 1048576).toFixed(1)}MB`;
  const line = (label: string, n: number, bytes: number, hint: string) => el('div', { class: 'row' }, [
    el('span', { class: 'grow', text: label }),
    el('span', { class: 'n', text: `${n.toLocaleString()}개 · ${mb(bytes)}` }),
    el('span', { class: 'hint', style: { flexBasis: '100%' }, text: hint }),
  ]);
  const draw = (u: AssetUsage): void => {
    stats.replaceChildren(
      line('봇·모듈이 쓰는 이미지', u.live.blobs, u.live.bytes, '지우지 않습니다.'),
      line('스냅샷만 가진 이미지', u.snapshot.blobs, u.snapshot.bytes,
        `지운 에셋을 스냅샷으로 되돌릴 때 RisuAI에 다시 등록하려고 남겨 둡니다 (봇 스냅샷 ${u.snapshots}개). 스냅샷 탭에서 그 스냅샷을 지우면 정리 대상이 됩니다.`),
      line('아무도 안 쓰는 이미지', u.orphan.blobs, u.orphan.bytes,
        `${u.gcDays}일이 지난 ${u.orphan.collectable.toLocaleString()}개(${mb(u.orphan.collectableBytes)})를 정리할 수 있습니다. 동기화 중인 이미지를 지우지 않으려고 최근 것은 기다립니다.`),
    );
    gc.disabled = !u.orphan.collectable;
  };
  // Counting reads every bot snapshot, so it waits until the section is
  // opened - opening 설정 must stay instant (§1-100).
  const load = async (): Promise<void> => {
    try { draw(await state.assetUsage()); } catch (e) { stats.replaceChildren(el('div', { class: 'hint', text: '저장소 현황을 읽지 못했습니다: ' + msg(e) })); }
  };
  armed(gc, '안 쓰는 이미지 정리', '정말 지울까요?', async () => {
    gc.disabled = true;
    clear(out);
    try {
      const r = await state.assetGc();
      out.appendChild(el('div', { class: 'notice ok', text: `이미지 ${r.removed}개 · ${mb(r.freed)}를 지웠습니다.` }));
    } catch (e) {
      out.appendChild(el('div', { class: 'notice err', text: '정리하지 못했습니다: ' + msg(e) }));
    }
    await load();
  });
  stats.appendChild(el('div', { class: 'hint', text: '불러오는 중…' }));
  gc.disabled = true;
  const card = el('div', { class: 'card' }, [
    el('h2', { text: '이미지 저장소' }),
    el('div', { class: 'hint', text: 'Hina가 RisuAI에서 읽어 오거나 만든 이미지입니다 (내용이 같으면 한 번만 저장). RisuAI 쪽 파일은 건드리지 않습니다.' }),
    stats,
    el('div', { class: 'row', style: { marginTop: '6px' } }, [gc]),
    out,
  ]);
  return { card, load };
}

// --- the tab --------------------------------------------------------------------

const SECTION_KEY = 'hina.storageSection';

/** The 저장공간 정리 settings tab: a row of section buttons over four cards. */
export function buildStorageCleanup(onMount?: (refresh: () => Promise<void>) => void): HTMLElement {
  let refreshOrphans: (() => Promise<void>) | null = null;
  const orphans = buildOrphanCard((r) => { refreshOrphans = r; });
  const snaps = buildSnapshotCard();
  const images = buildAssetStoreCard();
  const temp = buildTempCard();
  // The last three are loaded the first time they are opened: the snapshot
  // list and the image count read every snapshot, the temp scan walks the space.
  const sections: [string, string, HTMLElement, (() => Promise<void>) | null][] = [
    ['orphans', '봇 · 챗 · 모듈', orphans, null],
    ['snapshots', '스냅샷', snaps.card, snaps.load],
    ['images', '이미지', images.card, images.load],
    ['temp', '임시파일', temp.card, temp.load],
  ];
  const loaded = new Set<string>();
  const nav = el('div', { class: 'row botcleanchips storenav' });
  const panes = el('div', {});
  let current = 'orphans';
  try { current = localStorage.getItem(SECTION_KEY) || 'orphans'; } catch { /* fine */ }
  if (!sections.some((s) => s[0] === current)) current = 'orphans';

  const show = (id: string): void => {
    current = id;
    try { localStorage.setItem(SECTION_KEY, id); } catch { /* fine */ }
    for (const [sid, label, card, load] of sections) {
      card.style.display = sid === id ? '' : 'none';
      const b = nav.querySelector<HTMLElement>(`[data-section="${sid}"]`);
      b?.classList.toggle('on', sid === id);
      if (b) b.textContent = label;
      if (sid === id && load && !loaded.has(sid)) {
        loaded.add(sid);
        void load();
      }
    }
  };
  for (const [sid, label, card] of sections) {
    const b = el('button', { class: 'ghost tiny chip', text: label, dataset: { section: sid } });
    b.addEventListener('click', () => show(sid));
    nav.appendChild(b);
    panes.appendChild(card);
  }
  show(current);
  onMount?.(async () => {
    if (refreshOrphans) await refreshOrphans();
    // Not the temp scan: it walks the whole space, so it runs on 다시 확인.
    const s = sections.find((x) => x[0] === current);
    if (s?.[3] && loaded.has(current) && current !== 'temp') await s[3]();
  });
  return el('div', {}, [nav, panes]);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
