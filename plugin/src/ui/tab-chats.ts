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
import { el, clear, refocusSearch, fmtTime } from './dom';
import { state } from '../state';
import { setEditMode, setToolbarSearch, setTab } from './shell';
import { shellNotice } from './chatbar';
import type { RisuChat } from '../risuai';
import { describeSync, syncBusy } from '../assets';

/**
 * One line under the bot's name: what the background asset importer is up
 * to. Progress while it runs (a thin bar, re-rendered on each emit), the
 * totals once it is done, and a retry when it stopped short - the bot bar's
 * 반영 waits on exactly this.
 */
/**
 * The bot's snapshots, right on the picker. No snapshots: one 봇 편집
 * button. Snapshots: each row offers to restore it and edit from there, and
 * 현재 상태로 편집 keeps the working copy as it is. Chats do not get this -
 * a chat is always edited as it is now, its snapshots live behind 버전 on
 * the chat bar where they cannot be mistaken for other chats.
 */
function botSnapshots(editBot: HTMLElement, rescan: HTMLElement): HTMLElement {
  const wrap = el('div', { style: { marginTop: '8px' } });
  const row = el('div', { class: 'row' }, [editBot, rescan]);
  wrap.appendChild(row);
  if (!state.activeCharKey) return wrap;
  void (async () => {
    let cps: { id: string; label: string; created_at: number }[] = [];
    try { cps = await state.cardCheckpoints(); } catch { return; }
    if (!cps.length) return;
    editBot.textContent = '현재 상태로 편집';
    const list = el('div', { class: 'snaplist' });
    for (const c of cps.slice(0, 8)) {
      const edit = el('button', { class: 'ghost tiny', text: '이 스냅샷으로 편집' }) as HTMLButtonElement;
      edit.title = '이 스냅샷으로 되돌린 뒤 봇 편집으로 들어갑니다 (되돌리기 직전 상태도 스냅샷으로 남습니다)';
      edit.addEventListener('click', async () => {
        edit.disabled = true;
        try {
          await state.cardRestore(c.id);
          setEditMode('bot', 'meta');
        } catch (e) {
          flash(wrap, '복원하지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
          edit.disabled = false;
        }
      });
      list.appendChild(el('div', { class: 'verrow' }, [
        el('div', { class: 'grow' }, [
          el('div', { text: c.label || '(무제)' }),
          el('div', { class: 'hint', text: fmtTime(c.created_at * 1000) }),
        ]),
        edit,
      ]));
    }
    wrap.insertBefore(el('div', { class: 'hint', style: { marginTop: '8px' }, text: `봇 스냅샷 ${cps.length}개` }), row);
    wrap.insertBefore(list, row);
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
    if (p.phase !== 'unsupported') {
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
    setEditMode('bot', 'meta');
  });

  const rescan = el('button', { class: 'ghost tiny', text: '카드만 다시 읽기' }) as HTMLButtonElement;
  rescan.title = '카드·봇 로어북·Regex·트리거 작업본을 버리고 RisuAI의 현재 카드로 다시 읽습니다. 챗 작업본은 그대로 둡니다.';
  rescan.addEventListener('click', async () => {
    rescan.disabled = true;
    try {
      await state.upload({ cardReset: true });
      state.bump();
      shellNotice('RisuAI의 현재 카드로 다시 읽었습니다. 카드 작업본이 초기화되었습니다.', 'ok');
    } catch (e) {
      flash(pad, '다시 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      rescan.disabled = false;
    }
  });

  const portrait = el('div', { class: 'botinitials', text: initials(String(char.name || '?')) });
  pad.appendChild(el('div', { class: 'botcard' }, [
    portrait,
    el('div', { class: 'grow' }, [
      el('div', { class: 'botname', text: String(char.name || '(이름 없음)') }),
      el('div', { class: 'hint', text: `챗 ${liveChats.length}개` + (folders.length ? ` · 폴더 ${folders.length}개` : '') }),
      assetSyncLine(),
      botSnapshots(editBot, rescan),
      el('div', { class: 'hint', style: { marginTop: '6px' } }, [
        '다른 봇을 편집하시려면 RisuAI에서 그 봇을 열고 🔄 를 눌러 주세요.',
      ]),
    ]),
  ]));
  void loadPortrait(char.image as string | undefined, portrait);

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

  const makeItem = (r: { chat: RisuChat; index: number }) => {
    const loaded = loadedFor(r.chat);
    const isCurrent = r.index === state.slot?.chatIndex;
    const edit = el('button', { class: 'ghost tiny', text: '챗 편집' });
    const item = el('div', {
      class: 'chatitem' + (loaded && loaded.chatKey === state.activeChatKey ? ' current' : ''),
    }, [
      el('span', { class: 'grow', text: String(r.chat.name || `(챗 ${r.index})`) }),
      isCurrent ? el('span', { class: 'badge', text: '열림' }) : null,
      loaded ? el('span', { class: 'badge ok', text: '불러옴' }) : null,
      el('span', { class: 'n', text: `${(r.chat.message ?? []).length}턴` }),
      edit,
    ]);
    const enter = async () => {
      if (loaded) {
        await state.loadTurns(loaded.chatKey);
        setEditMode('chat', 'editor');
        return;
      }
      if (!isCurrent) {
        // Only the chat the host currently has open can be read, and only the
        // selected character's chats persist when written back.
        flash(pad, 'RisuAI에서 그 챗을 먼저 연 다음 🔄 를 눌러 주세요.');
        return;
      }
      await state.upload({});
      await state.loadTurns();
      setEditMode('chat', 'editor');
    };
    item.addEventListener('click', () => void enter());
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); void enter(); });
    return item;
  };

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
    el('span', { class: 'hint', text: '기본적으로 현재 열려 있는 챗만 올립니다.' }),
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
