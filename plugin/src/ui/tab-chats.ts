/**
 * Tab 1 - which bot, then which chat.
 *
 * Two sections divided by a rule, because they answer different questions and
 * only one of them is actionable here: the bot is context (RisuAI decides it),
 * the chat is the choice. The "switch bots in RisuAI" note therefore sits under
 * the bot section as a quiet aside rather than as a warning over the list.
 *
 * Chat counts of 30-50 across folders are normal, so folders collapse and the
 * list is plain rows rather than cards - at that count, cards are a wall.
 */
import { el, clear, refocusSearch, fmtTime, armed } from './dom';
import { state } from '../state';
import { setEditMode, setToolbarSearch, setTab } from './shell';
import { ensureResolved } from './leaveguard';
import type { RisuChat } from '../risuai';
import { HostError } from '../host';
import { describeSync, syncBusy } from '../assets';
import { transport } from '../transport';

/**
 * One line under the bot's name: what the background asset importer is up
 * to. Progress while it runs (a thin bar, re-rendered on each emit), the
 * totals once it is done, and a retry when it stopped short - the bot bar's
 * 반영 waits on exactly this.
 */
/**
 * The bot's snapshots, right on the picker.
 *
 * Two buttons per row and nothing else: 편집 (restore this point and open it)
 * and ✕. The list used to carry a "지금 편집 중인 작업본 · 현재 · 봇 편집" row
 * on top and a cleanup control at the bottom, which put four different ways to
 * start editing on one screen - 봇 편집 above already is that, so the rows here
 * only answer "and from an older point?".
 */
function botSnapshots(editBot: HTMLElement): HTMLElement {
  // Full width under the bot card, in the same list shape as 챗 선택 below -
  // a narrower column beside the portrait made the two lists look unrelated.
  const wrap = el('div');
  if (!state.activeCharKey) return wrap;
  void (async () => {
    let cps: { id: string; label: string; created_at: number }[] = [];
    try { cps = await state.cardCheckpoints(); } catch { return; }
    if (!cps.length) return;
    wrap.appendChild(el('div', { class: 'sectionline' }));
    wrap.appendChild(el('div', { class: 'sectiontitle', text: `봇 스냅샷 ${cps.length}개` }));
    const list = el('div', { class: 'chatlist snaplist' });
    const redraw = () => wrap.replaceWith(botSnapshots(editBot));
    for (const c of cps.slice(0, 8)) {
      const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
      edit.title = '작업본을 이 시점으로 되돌린 뒤 봇 편집으로 들어갑니다 (직전 상태도 스냅샷으로 남습니다)';
      edit.addEventListener('click', async () => {
        edit.disabled = true;
        try {
          // The restore writes the card's working copy, so it is a card edit:
          // a dirty chat has to be resolved first, a dirty card may proceed
          // (the restore is about to replace it anyway, with a snapshot kept).
          if (!(await ensureResolved('스냅샷 복원', { scope: 'card' }))) {
            edit.disabled = false;
            return;
          }
          await state.cardRestore(c.id);
          setEditMode('bot', 'meta');
        } catch (e) {
          flash(wrap, '복원하지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
          edit.disabled = false;
        }
      });
      // Deleting from here too - the picker is where the snapshots are seen
      // first, and going into 봇 편집 → 버전 just to drop one was a detour.
      const row = el('div', { class: 'chatitem' });
      const del = el('button', { class: 'ghost tiny', title: '이 스냅샷 삭제' }) as HTMLButtonElement;
      armed(del, '✕', '삭제 확인', async () => {
        row.classList.add('deleting');
        del.disabled = true;
        edit.disabled = true;
        try {
          await state.deleteCardCheckpoint(c.id);
          redraw();
        } catch (e) {
          row.classList.remove('deleting');
          del.disabled = false;
          edit.disabled = false;
          flash(wrap, '삭제하지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
        }
      });
      row.append(
        el('span', { class: 'grow', text: c.label || '(무제)' }),
        el('span', { class: 'n', text: fmtTime(c.created_at * 1000) }),
        edit, del,
      );
      list.appendChild(row);
    }
    if (cps.length > 8) list.appendChild(el('div', { class: 'hint', style: { padding: '4px 0' }, text: `그 외 ${cps.length - 8}개 — 봇 편집 → 🕘 버전에서 전부 봅니다` }));
    wrap.appendChild(list);
  })();
  return wrap;
}

function assetSyncLine(): HTMLElement {
  const p = state.assetSync;
  const wrap = el('div', { class: 'assetsync' });
  if (!p) {
    wrap.appendChild(el('div', { class: 'hint', text: state.activeCharKey ? '에셋 동기화 대기 중' : '' }));
    return wrap;
  }
  const busy = syncBusy(p);
  const text = el('span', { class: 'hint', text: describeSync(p) });
  const tone = p.phase === 'error' ? ' err' : (p.phase === 'done' && p.failed ? ' warn' : '');
  const line = el('div', { class: 'row assetline' + tone }, [text]);
  if (busy) {
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { state.cancelAssetSync(); });
    line.appendChild(cancel);
    // Pulling: the backend's own count. Pushing: ours. Manifest: indeterminate.
    let ratio = -1;
    if (p.phase === 'pulling' && p.pull && p.pull.total) ratio = p.pull.done / p.pull.total;
    else if (p.phase === 'pushing' && p.toPush) ratio = (p.read + p.readFailed) / p.toPush;
    const bar = el('div', { class: 'assetbar' + (ratio < 0 ? ' indeterminate' : '') });
    const fill = el('div', { class: 'assetfill' });
    if (ratio >= 0) fill.style.width = Math.round(Math.min(1, ratio) * 100) + '%';
    bar.appendChild(fill);
    wrap.appendChild(line);
    wrap.appendChild(bar);
  } else {
    // Only when there is something to retry. A finished sync offering "다시
    // 동기화" is one more button on a screen whose job is "pick what to edit",
    // and the header's 🔄 restarts it anyway.
    if (p.phase === 'error' || p.phase === 'cancelled' || p.failed) {
      const again = el('button', { class: 'ghost tiny', text: '다시 동기화' });
      again.title = '에셋 목록을 다시 대조하고, 빠진 것만 가져옵니다';
      again.addEventListener('click', () => { state.syncAssets(true); });
      line.appendChild(again);
    }
    wrap.appendChild(line);
  }
  return wrap;
}

/** Blob URLs for portraits, revoked when the tab is rebuilt. */
let portraitUrl = '';
let filterText = '';

export function renderChatsTab(mount: HTMLElement): void {
  clear(mount);
  const pad = el('div', { class: 'pad' });
  mount.appendChild(pad);

  if (state.connectError) {
    const go = el('button', { class: 'primary tiny', text: '설정으로 이동' });
    go.addEventListener('click', () => setTab('settings'));
    pad.appendChild(el('div', { class: 'notice err' }, [
      el('div', { text: '백엔드에 연결하지 못했습니다.' }),
      el('div', { class: 'hint', text: state.connectError }),
      // Measured on web RisuAI (risuai.xyz): the first connection after
      // opening can take a couple of minutes while the host falls back from
      // its proxy route to a direct one. The panel keeps retrying meanwhile.
      transport.hostPlatform === 'web'
        ? el('div', { class: 'hint', style: { marginTop: '4px' }, text:
            '웹 RisuAI(risuai.xyz)에서는 최초 연결까지 3분 정도 걸릴 수 있습니다 (프록시 → 직접 연결 폴백에 걸리는 시간). 패널이 30초마다 자동으로 다시 시도하니 그대로 두셔도 됩니다.' })
        : null,
      el('div', { class: 'row', style: { marginTop: '6px' } }, [
        el('span', { class: 'hint', text: '설정 → 연결에서 URL과 토큰을 확인해 주세요.' }), go,
      ]),
    ]));
  }

  if (state.slotError) {
    pad.appendChild(el('div', { class: 'notice' }, [
      el('div', { text: '캐릭터가 선택되어 있지 않습니다.' }),
      el('div', { class: 'hint', text: state.slotError }),
    ]));
    return;
  }

  const char = state.character;
  if (!char) {
    pad.appendChild(el('div', { class: 'empty', text: '캐릭터를 읽는 중입니다…' }));
    return;
  }

  const liveChats: RisuChat[] = Array.isArray(char.chats) ? char.chats : [];
  const folders = Array.isArray(char.chatFolders) ? char.chatFolders as FolderDef[] : [];

  // --- bot section ---------------------------------------------------------
  // The bot's own edit entry lives here: clicking 봇 편집 swaps the tab bar's
  // middle to the bot tabs, the same way clicking a chat swaps it to the chat
  // tabs. One picker, two modes.
  const editBot = el('button', { class: 'primary tiny', text: '봇 편집' });
  editBot.addEventListener('click', () => {
    if (!state.activeCharKey) {
      flash(pad, '백엔드에 봇이 아직 올라가지 않았습니다. 연결을 확인해 주세요.');
      return;
    }
    // 봇 편집 is at home in the card - a dirty card passes, a dirty chat has
    // to be resolved first (one dirty thing at a time).
    void (async () => {
      if (await ensureResolved('봇 편집으로 이동', { scope: 'card' })) setEditMode('bot', 'meta');
    })();
  });

  // Only 봇 편집 here. "카드만 다시 읽기" was a second, differently-scoped
  // reload standing next to it: since 0.9 a re-open merges RisuAI's changes in
  // by itself, and the header's 🔄 is the one "throw my copy away" button.
  const portrait = el('div', { class: 'botinitials', text: initials(String(char.name || '?')) });
  pad.appendChild(el('div', { class: 'botcard' }, [
    portrait,
    el('div', { class: 'grow' }, [
      el('div', { class: 'botname', text: String(char.name || '(이름 없음)') }),
      el('div', { class: 'hint', text: `챗 ${liveChats.length}개` + (folders.length ? ` · 폴더 ${folders.length}개` : '') }),
      assetSyncLine(),
      el('div', { class: 'row', style: { marginTop: '8px' } }, [editBot]),
      el('div', { class: 'hint', style: { marginTop: '6px' } }, [
        '다른 봇을 편집하시려면 RisuAI에서 그 봇을 열고 🔄 를 눌러 주세요.',
      ]),
    ]),
  ]));
  void loadPortrait(char.image as string | undefined, portrait);
  pad.appendChild(botSnapshots(editBot));

  pad.appendChild(el('div', { class: 'sectionline' }));

  // --- chat section --------------------------------------------------------
  pad.appendChild(el('div', { class: 'sectiontitle', text: '챗 선택' }));

  const ws = state.workspace;
  const loadedFor = (c: RisuChat) => ws?.chats.find((w) => w.chatId === (c.id ?? ''));

  if (liveChats.length > 6) {
    setToolbarSearch(filterText, (v) => {
      filterText = v;
      renderChatsTab(mount);
      refocusSearch(null);
    }, '챗 찾기');
  }
  const needle = filterText.trim().toLowerCase();
  const rows = liveChats.map((c, i) => ({ chat: c, index: i }))
    .filter((r) => !needle || String(r.chat.name ?? '').toLowerCase().includes(needle));
  const grouped = new Map<string, { chat: RisuChat; index: number }[]>();
  for (const r of rows) {
    const key = String((r.chat as Record<string, unknown>).folderId ?? '');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  // Which chat still owes a 반영: filled in once the summary arrives, so the
  // user can see from the picker where the leave guard will point.
  const dirtyBadges = new Map<string, HTMLElement>();
  const makeItem = (r: { chat: RisuChat; index: number }) => {
    const loaded = loadedFor(r.chat);
    const edit = el('button', { class: 'ghost tiny', text: '챗 편집' }) as HTMLButtonElement;
    const dirtyBadge = el('span', {
      class: 'badge warn', style: { display: 'none' },
      title: '이 챗에 아직 RisuAI에 반영하지 않은 변경이 있습니다',
    });
    if (loaded) dirtyBadges.set(loaded.chatKey, dirtyBadge);
    const item = el('div', {
      class: 'chatitem' + (loaded && loaded.chatKey === state.activeChatKey ? ' current' : ''),
    }, [
      el('span', { class: 'grow', text: String(r.chat.name || `(챗 ${r.index})`) }),
      dirtyBadge,
      el('span', { class: 'n', text: `${(r.chat.message ?? []).length}턴` }),
      edit,
    ]);
    let busy = false;
    const enter = async () => {
      if (busy) return;
      // Opening a chat is at home in that chat; anything else dirty (the
      // card, another chat) is resolved at this door.
      if (!(await ensureResolved('챗 열기', { scope: 'chat', key: loaded?.chatKey ?? '' }))) return;
      if (loaded) {
        await state.loadTurns(loaded.chatKey);
        setEditMode('chat', 'editor');
        return;
      }
      // Any chat of this bot, not only the one RisuAI has open: clicking one
      // loads it. A chat of a few hundred turns is megabytes, so the row says
      // it is working - this is the one click here that is not instant.
      busy = true;
      edit.disabled = true;
      edit.textContent = '불러오는 중…';
      try {
        await state.openChat(r.index);
        setEditMode('chat', 'editor');
      } catch (e) {
        // One case is still a real refusal, and only one: RisuAI has not read
        // this chat itself yet, so all it can hand over is a stub with no
        // turns (PocketRisu loads chats lazily). Opening it there fills it in.
        // Anything else is a failure and has to say so rather than send the
        // user off to fix something that is not broken.
        flash(pad, e instanceof HostError && e.code === 'missing'
          ? 'RisuAI가 이 챗을 아직 읽어 두지 않았습니다. RisuAI에서 그 챗을 한 번 연 다음 🔄 를 눌러 주세요.'
          : '챗을 불러오지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
      } finally {
        busy = false;
        edit.disabled = false;
        edit.textContent = '챗 편집';
      }
    };
    item.addEventListener('click', () => void enter());
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); void enter(); });
    return item;
  };
  void (async () => {
    // After the synchronous list build: the await above the loop guarantees
    // every row has registered its badge before this runs.
    const s = await state.dirtySummary();
    if (!s) return;
    for (const c of s.chats) {
      const b = dirtyBadges.get(c.chatKey);
      if (!b || !c.dirty) continue;
      b.textContent = `미반영 ${c.total || c.conflicts}`;
      b.style.display = '';
    }
  })();

  // Unfoldered chats first, then each folder - matching how RisuAI lists them.
  const loose = grouped.get('') ?? [];
  if (loose.length) {
    const list = el('div', { class: 'chatlist' });
    for (const r of loose) list.appendChild(makeItem(r));
    pad.appendChild(list);
  }

  for (const f of folders) {
    const items = grouped.get(String(f.id)) ?? [];
    if (!items.length) continue;
    const body = el('div', { class: 'folderbody' });
    for (const r of items) body.appendChild(makeItem(r));

    const caret = el('span', { text: '▸' });
    const head = el('button', { class: 'folderhead' }, [
      caret,
      el('span', { class: 'folderdot', style: f.color ? { background: String(f.color) } : {} }),
      el('span', { class: 'grow', text: String(f.name || '폴더') }),
      el('span', { text: `${items.length}` }),
    ]);
    head.addEventListener('click', () => {
      const open = body.classList.toggle('open');
      caret.textContent = open ? '▾' : '▸';
    });
    pad.appendChild(el('div', { class: 'folder' }, [head, body]));
  }

  // Chats whose folder no longer exists would otherwise vanish from the list.
  const known = new Set(folders.map((f) => String(f.id)));
  const orphans = [...grouped.entries()]
    .filter(([k]) => k !== '' && !known.has(k))
    .flatMap(([, v]) => v);
  if (orphans.length) {
    const list = el('div', { class: 'chatlist' });
    for (const r of orphans) list.appendChild(makeItem(r));
    pad.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '10px' }, text: '폴더 없음' }));
    pad.appendChild(list);
  }

  pad.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } }, [
    buildUploadAll(),
    el('span', { class: 'hint', text: '챗을 누르면 그 챗만 불러옵니다. 여러 챗을 오가며 볼 때만 이 버튼을 쓰세요.' }),
  ]));
}

interface FolderDef { id?: string; name?: string; color?: string }

function initials(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  // Korean names have no word breaks to take initials from, so the first
  // character is the only thing that reads as an identifier.
  return /[가-힣]/.test(t[0]) ? t.slice(0, 1) : t.slice(0, 2).toUpperCase();
}

/**
 * Draw the bot portrait, falling back to initials.
 *
 * `readImage` returns bytes, so the blob URL is built here. PocketRisu's plugin
 * CSP allows `blob:` for img-src; mainline's has no img-src at all, so the
 * error handler putting the initials back is the load-bearing part on that
 * host, not a nicety.
 */
async function loadPortrait(path: string | undefined, mount: HTMLElement): Promise<void> {
  if (!path) return;
  try {
    const bytes = await Risuai.readImage(path);
    if (!bytes || !(bytes as Uint8Array).byteLength) return;
    if (portraitUrl) URL.revokeObjectURL(portraitUrl);
    // Copy into a plain ArrayBuffer: the host's Uint8Array may be backed by a
    // SharedArrayBuffer, which Blob does not accept.
    const view = bytes as Uint8Array;
    const buf = new Uint8Array(view.byteLength);
    buf.set(view);
    portraitUrl = URL.createObjectURL(new Blob([buf]));
    const img = el('img', { class: 'botportrait', src: portraitUrl, alt: '' });
    img.addEventListener('error', () => img.replaceWith(mount));
    mount.replaceWith(img);
  } catch {
    /* keep the initials */
  }
}

function buildUploadAll(): HTMLElement {
  const b = el('button', { text: '이 봇의 모든 챗 불러오기' });
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = '불러오는 중입니다…';
    try {
      await state.upload({ allChats: true });
      if (state.activeChatKey) await state.loadTurns();
    } catch (e) {
      console.log('[risu-hina] upload all failed', e);
    } finally {
      b.disabled = false;
      b.textContent = '이 봇의 모든 챗 불러오기';
    }
  });
  return b;
}

function flash(pad: HTMLElement, text: string): void {
  const n = el('div', { class: 'notice', text });
  pad.insertBefore(n, pad.firstChild);
  setTimeout(() => n.remove(), 5000);
}
