/**
 * The first screen: what to edit (§1-89).
 *
 * Four modes, four cards - 봇 편집 · 챗 편집 · 페르소나 편집 · 모듈 편집 - and
 * nothing else competing with them. Pressing one unfolds its choices underneath:
 *   봇     the current working copy, or a saved / automatic snapshot of it
 *   챗     the bot's chats, folders as RisuAI keeps them
 *   페르소나 RisuAI's user personas
 *   모듈   RisuAI's modules (§1-95), or one added from a .risum/.charx file
 * and picking one enters that mode's tabs.
 *
 * Built for not blinking. The screen is re-rendered on every state change
 * while a bot opens (connect, read, upload, change counts, the asset sync),
 * and it used to throw its scroller away each time and refetch its lists,
 * so the snapshot list vanished and came back, folders closed, and the page
 * jumped to the top. Now the scroller survives, everything fetched is cached
 * per bot and epoch and drawn synchronously, a list still loading holds its
 * place with a spinner row, and a finished fetch fills its own box in place.
 *
 * While the very first open is still putting the bot on the backend, the
 * choices are shut and the open's steps are shown: nothing on the bot or its
 * chats can be edited before the working copy exists.
 */
import { el, clear, refocusSearch, fmtTime, armed } from './dom';
import { state, type DirtySummary } from '../state';
import { setEditMode, setToolbarSearch, setTab, bootState, type BootStep } from './shell';
import type { RisuChat } from '../risuai';
import { HostError } from '../host';
import { describeSync, syncBusy } from '../assets';
import { transport } from '../transport';
import { personaImage } from '../persona';
import type { PersonaRow } from '../state';
import { shellNotice } from './chatbar';
import { askName } from './kit';
import type { LiveModule } from '../state';
import { moduleLine } from './module-picker';

type Mode = 'bot' | 'chat' | 'persona' | 'module';

/** Which card is unfolded; '' = none. Survives re-renders, not 선택/뒤로. */
let openMode: Mode | '' = '';

/**
 * The tab bar's 선택 (‹ 뒤로) is the way to the dashboard: every card folded.
 * Coming back to the card the user had unfolded read as "still in the
 * persona picker, with no way back" (field report §1-89).
 */
export function foldLanding(): void {
  openMode = '';
  filterText = '';
}
/** Chat folders the user unfolded (by folder id). */
const openFolders = new Set<string>();
let showAutoSnaps = false;
let filterText = '';

/** The scroller, kept across renders so the page does not jump. */
let padEl: HTMLElement | null = null;

// --- asset sync line ---------------------------------------------------------

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
  const line = el('div', { class: 'row assetline' + tone }, busy ? [el('span', { class: 'spin' }), text] : [text]);
  if (busy) {
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { state.cancelAssetSync(); });
    line.appendChild(cancel);
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

/** A sync progress tick: swap the one line, leave the page alone (§1-32). */
export function refreshAssetSyncLine(mount: HTMLElement): boolean {
  const old = mount.querySelector('.assetsync');
  if (!old) return !!mount.querySelector('.landing');
  old.replaceWith(assetSyncLine());
  return true;
}

// --- the open's steps ----------------------------------------------------------

/** Whether the bot and its chats can be picked yet. */
function botReady(): boolean {
  return !!state.workspace && !!state.character && !state.slotError;
}

function bootBox(): HTMLElement | null {
  const b = bootState();
  // A re-open of a bot that is already on the backend does not shut the
  // screen: its working copy is there, the upload only merges.
  if (!b.booting || botReady()) {
    return b.booting ? el('div', { class: 'bootbox slim' }, [
      el('span', { class: 'spin' }), el('span', { class: 'hint', text: b.phase || '불러오는 중…' }),
    ]) : null;
  }
  const mark = (s: BootStep) => (s === 'done' ? '✓' : s === 'err' ? '✕' : s === 'skip' ? '–' : '');
  const step = (s: BootStep, label: string) => el('div', { class: 'bootstep ' + s }, [
    s === 'run' ? el('span', { class: 'spin' }) : el('span', { class: 'bootmark', text: mark(s) }),
    el('span', { text: label }),
  ]);
  return el('div', { class: 'bootbox' }, [
    el('div', { class: 'boothead' }, [
      el('span', { class: 'spin big' }),
      el('div', {}, [
        el('div', { class: 'botname', text: '불러오는 중입니다' }),
        el('div', { class: 'hint', text: '처음 여는 봇은 작업본을 백엔드에 올려야 편집할 수 있습니다. 끝나면 아래 버튼이 열립니다.' }),
      ]),
    ]),
    step(b.steps.connect, '백엔드 연결'),
    step(b.steps.host, 'RisuAI에서 봇 읽기'),
    step(b.steps.upload, '작업본 올리기'),
    el('div', { class: 'hint', style: { marginTop: '4px' }, text: '에셋(이미지)은 그 뒤에 백그라운드로 받습니다 — 기다리지 않아도 됩니다.' }),
  ]);
}

/** A boot step ticked: swap the box; when the open has finished, redraw once. */
export function refreshBootBox(mount: HTMLElement): void {
  const old = mount.querySelector('.bootbox');
  const next = bootBox();
  const wasBlocking = !!old && !old.classList.contains('slim');
  const blocking = !!next && !next.classList.contains('slim');
  if (old && next && wasBlocking === blocking) { old.replaceWith(next); return; }
  if (mount.querySelector('.landing')) renderChatsTab(mount);
}

// --- cached lists --------------------------------------------------------------

interface Snap { id: string; label: string; created_at: number; kind?: string }

/**
 * One fetch per key; the boxes waiting on it are filled in place. A newer key
 * for the same bot keeps showing the previous value until the new one lands
 * (an epoch bump must not flash the list away); another bot starts empty.
 */
class Cached<T> {
  key = '';
  scope = '';
  value: T | null = null;
  error = '';
  loading = false;
  private waiters: (() => void)[] = [];
  constructor(private readonly load: () => Promise<T>) {}
  want(scope: string, key: string, then: () => void): void {
    if (this.key === key && !this.loading) return;
    this.waiters.push(then);
    if (this.key === key && this.loading) return;
    if (this.scope !== scope) this.value = null;
    this.scope = scope;
    this.key = key;
    this.error = '';
    this.loading = true;
    void this.load().then((v) => {
      if (this.key !== key) return;
      this.value = v;
    }, (e) => {
      if (this.key !== key) return;
      this.error = e instanceof Error ? e.message : String(e);
    }).finally(() => {
      if (this.key !== key) return;
      this.loading = false;
      const w = this.waiters;
      this.waiters = [];
      for (const fn of w) { try { fn(); } catch { /* a box gone */ } }
    });
  }
  /** Refetch on the next want, keeping what is shown meanwhile. */
  drop(): void { this.key = ''; this.error = ''; }
}

const snaps = new Cached<Snap[]>(() => state.cardCheckpoints());
const dirty = new Cached<DirtySummary | null>(() => state.dirtySummary());

const snapKey = () => `${state.activeCharKey}:${state.epoch}`;
const dirtyKey = () => `${state.activeCharKey}:${state.epoch}:${state.changes?.total ?? ''}:${state.botChanges?.total ?? ''}`;

function loadingRow(text: string): HTMLElement {
  return el('div', { class: 'chatitem loadingrow' }, [el('span', { class: 'spin' }), el('span', { class: 'hint grow', text })]);
}

// --- the screen ------------------------------------------------------------------

export function renderChatsTab(mount: HTMLElement): void {
  // Keep the scroller: a new one starts at the top.
  if (!padEl || padEl.parentElement !== mount) {
    clear(mount);
    padEl = el('div', { class: 'pad' });
    mount.appendChild(padEl);
  }
  const pad = padEl;
  const top = pad.scrollTop;
  clear(pad);
  const root = el('div', { class: 'landing' });
  pad.appendChild(root);

  if (state.connectError) {
    const go = el('button', { class: 'primary tiny', text: '설정으로 이동' });
    go.addEventListener('click', () => setTab('settings'));
    root.appendChild(el('div', { class: 'notice err' }, [
      el('div', { text: '백엔드에 연결하지 못했습니다.' }),
      el('div', { class: 'hint', text: state.connectError }),
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
    // Bot and chat need a bot; personas do not, so the screen stays.
    root.appendChild(el('div', { class: 'notice' }, [
      el('div', { text: '캐릭터가 선택되어 있지 않습니다. 봇·챗 편집은 RisuAI에서 봇을 연 다음 🔄 를 눌러 주세요 (페르소나 편집은 그대로 됩니다).' }),
      el('div', { class: 'hint', text: state.slotError }),
    ]));
  }

  const box = bootBox();
  if (box) root.appendChild(box);

  const blocked = !!box && !box.classList.contains('slim');
  const char = state.character;
  const chats: RisuChat[] = char && Array.isArray(char.chats) ? char.chats : [];

  const botWhy = blocked ? '불러오는 중입니다'
    : state.slotError ? 'RisuAI에서 봇이 선택되어 있지 않습니다'
    : !state.health ? '백엔드에 연결되어 있지 않습니다'
    : !botReady() ? '작업본이 아직 올라가지 않았습니다' : '';
  const personaWhy = !state.health ? '백엔드에 연결되어 있지 않습니다' : '';

  const cards = el('div', { class: 'modecards' });
  const card = (m: Mode, icon: string, title: string, sub: string, desc: string, why: string) => {
    const b = el('button', { class: 'modecard' + (openMode === m ? ' open' : ''), dataset: { mode: m } }, [
      el('span', { class: 'modeicon', text: icon }),
      el('span', { class: 'modetext' }, [
        el('span', { class: 'modetitle', text: title }),
        el('span', { class: 'modesub' + (why ? ' why' : ''), text: why || sub }),
        el('span', { class: 'hint', text: desc }),
      ]),
      el('span', { class: 'modecaret', text: openMode === m ? '▾' : '▸' }),
    ]) as HTMLButtonElement;
    b.disabled = !!why;
    if (why) b.title = why;
    b.addEventListener('click', () => {
      openMode = openMode === m ? '' : m;
      if (openMode === 'persona' && !state.personas && !state.personaLoading) void state.loadPersonas().catch(() => undefined);
      if (openMode === 'module' && !state.moduleLoading) void state.loadModules().catch(() => undefined);
      renderChatsTab(mount);
    });
    cards.appendChild(b);
  };
  card('bot', '🤖', '봇 편집', char?.name ? String(char.name) : '', '카드·인사말·로어북·Regex·트리거·에셋', botWhy);
  card('chat', '💬', '챗 편집', char ? `챗 ${chats.length}개` : '', '턴·챗 로어북·장기기억·챗 변수', botWhy);
  card('persona', '👤', '페르소나 편집', state.personas ? `페르소나 ${state.personas.length}개` : 'RisuAI 사용자 페르소나', '이름·설명·프로필 사진', personaWhy);
  card('module', '◫', '모듈 편집', state.liveModules ? `모듈 ${state.liveModules.length}개` : 'RisuAI 모듈', '로어북·Regex·트리거·에셋·토글 (봇·페르소나와 조합)', personaWhy);
  root.appendChild(cards);

  // A card that was open but can no longer be used folds itself.
  if ((openMode === 'bot' || openMode === 'chat') && botWhy) openMode = '';
  if ((openMode === 'persona' || openMode === 'module') && personaWhy) openMode = '';

  const body = el('div', { class: 'modebody' });
  if (openMode === 'bot') botBody(body, mount);
  else if (openMode === 'chat') chatBody(body, mount);
  else if (openMode === 'persona') personaBody(body, mount);
  else if (openMode === 'module') moduleBody(body, mount);
  if (openMode) root.appendChild(body);
  else if (!blocked) {
    root.appendChild(el('div', { class: 'hint landingfoot', text: char
      ? '편집할 대상을 고르세요. 다른 봇을 편집하시려면 RisuAI에서 그 봇을 열고 🔄 를 눌러 주세요.'
      : '편집할 대상을 고르세요.' }));
  }

  pad.scrollTop = top;
}

// --- 봇 ------------------------------------------------------------------------

function botBody(body: HTMLElement, mount: HTMLElement): void {
  const char = state.character!;
  const folders = Array.isArray(char.chatFolders) ? char.chatFolders : [];
  const chats = Array.isArray(char.chats) ? char.chats : [];
  const portrait = el('div', { class: 'botinitials', text: initials(String(char.name || '?')) });
  body.appendChild(el('div', { class: 'botcard' }, [
    portrait,
    el('div', { class: 'grow' }, [
      el('div', { class: 'botname', text: String(char.name || '(이름 없음)') }),
      el('div', { class: 'hint', text: `챗 ${chats.length}개` + (folders.length ? ` · 폴더 ${folders.length}개` : '') }),
      assetSyncLine(),
      el('div', { class: 'hint', style: { marginTop: '6px' } }, [
        '다른 봇을 편집하시려면 RisuAI에서 그 봇을 열고 🔄 를 눌러 주세요.',
      ]),
    ]),
  ]));
  void loadPortrait(char.image as string | undefined, portrait);

  body.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '14px' }, text: '어느 시점을 편집할까요' }));
  const list = el('div', { class: 'chatlist snaplist' });
  body.appendChild(list);

  const pending = state.botChanges?.total ?? 0;
  const cur = el('button', { class: 'primary tiny', text: '편집' }) as HTMLButtonElement;
  cur.title = '지금 작업본(아직 반영하지 않은 변경 포함)으로 봇 편집에 들어갑니다';
  const enterBot = () => { state.focusModule(''); setEditMode('bot', 'meta'); };
  cur.addEventListener('click', (ev) => { ev.stopPropagation(); enterBot(); });
  const curRow = el('div', { class: 'chatitem current' }, [
    el('span', { class: 'grow' }, [
      el('span', { text: '현재 작업본' }),
      el('span', { class: 'hint', text: '  RisuAI의 지금 카드 + 편집 중인 변경' }),
    ]),
    pending ? el('span', { class: 'badge warn', text: `미반영 ${pending}` }) : null,
    cur,
  ]);
  curRow.addEventListener('click', enterBot);
  list.appendChild(curRow);

  const rows = el('div', { class: 'snaprows' });
  list.appendChild(rows);
  const fill = () => {
    clear(rows);
    if (snaps.loading && snaps.value === null) { rows.appendChild(loadingRow('스냅샷 목록을 불러오는 중…')); return; }
    if (snaps.error) { rows.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'hint', text: '스냅샷 목록을 읽지 못했습니다: ' + snaps.error })])); return; }
    const all = snaps.value ?? [];
    const saved = all.filter((c) => c.kind !== 'auto');
    const auto = all.filter((c) => c.kind === 'auto');
    for (const c of saved.slice(0, 20)) rows.appendChild(snapRow(c, true, mount));
    if (saved.length > 20) rows.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'hint', text: `그 외 ${saved.length - 20}개 — 봇 편집 → 🕘 버전에서 전부 봅니다` })]));
    if (auto.length) {
      const head = el('div', { class: 'chatitem foldrow' }, [
        el('span', { text: showAutoSnaps ? '▾' : '▸' }),
        el('span', { class: 'grow hint', text: `자동 백업 ${auto.length}개 (반영·복원 직전 등에 저절로 남은 것)` }),
      ]);
      head.addEventListener('click', () => { showAutoSnaps = !showAutoSnaps; fill(); });
      rows.appendChild(head);
      if (showAutoSnaps) for (const c of auto.slice(0, 20)) rows.appendChild(snapRow(c, false, mount));
    }
    if (!saved.length && !auto.length) {
      rows.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'hint', text: '저장된 스냅샷이 없습니다 — 봇 편집 → 🔖 로 지금 상태를 남길 수 있습니다' })]));
    }
  };
  snaps.want(state.activeCharKey, snapKey(), () => { if (rows.isConnected) fill(); });
  fill();
}

function snapRow(c: Snap, deletable: boolean, mount: HTMLElement): HTMLElement {
  const row = el('div', { class: 'chatitem' });
  const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
  edit.title = '작업본을 이 시점으로 되돌린 뒤 봇 편집으로 들어갑니다 (직전 상태도 스냅샷으로 남습니다)';
  edit.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    edit.disabled = true;
    edit.textContent = '되돌리는 중…';
    try {
      state.focusModule('');
      await state.cardRestore(c.id);
      snaps.drop();
      setEditMode('bot', 'meta');
    } catch (e) {
      flash('복원하지 못했습니다: ' + msg(e));
      edit.disabled = false;
      edit.textContent = '편집';
    }
  });
  row.append(
    el('span', { class: 'grow', text: c.label || '(무제)' }),
    el('span', { class: 'n', text: fmtTime(c.created_at * 1000) }),
    edit,
  );
  if (deletable) {
    const del = el('button', { class: 'ghost tiny', title: '이 스냅샷 삭제' }) as HTMLButtonElement;
    armed(del, '✕', '삭제 확인', async () => {
      row.classList.add('deleting');
      del.disabled = true;
      edit.disabled = true;
      try {
        await state.deleteCardCheckpoint(c.id);
        snaps.drop();
        renderChatsTab(mount);
      } catch (e) {
        row.classList.remove('deleting');
        del.disabled = false;
        edit.disabled = false;
        flash('삭제하지 못했습니다: ' + msg(e));
      }
    });
    row.appendChild(del);
  }
  return row;
}

// --- 챗 ------------------------------------------------------------------------

interface FolderDef { id?: string; name?: string; color?: string }

function chatBody(body: HTMLElement, mount: HTMLElement): void {
  const char = state.character!;
  const liveChats: RisuChat[] = Array.isArray(char.chats) ? char.chats : [];
  const folders = Array.isArray(char.chatFolders) ? char.chatFolders as FolderDef[] : [];
  const ws = state.workspace;
  const loadedFor = (c: RisuChat) => ws?.chats.find((w) => w.chatId === (c.id ?? ''));

  if (liveChats.length > 6) {
    setToolbarSearch(filterText, (v) => {
      filterText = v;
      renderChatsTab(mount);
      refocusSearch(null);
    }, '챗 찾기');
  }
  body.appendChild(el('div', { class: 'sectiontitle', text: '편집할 챗을 고르세요' }));
  if (!liveChats.length) {
    body.appendChild(el('div', { class: 'hint', text: '이 봇에는 챗이 없습니다.' }));
    return;
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

  // Which chat still owes a 반영: drawn from the cached summary right away,
  // refreshed in place when a newer one lands.
  const dirtyBadges = new Map<string, HTMLElement>();
  const paintDirty = () => {
    const s = dirty.value;
    for (const [key, b] of dirtyBadges) {
      const c = s?.chats.find((x) => x.chatKey === key);
      const on = !!c && c.dirty;
      b.textContent = on ? `미반영 ${c!.total || c!.conflicts}` : '';
      b.style.display = on ? '' : 'none';
    }
  };

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
      busy = true;
      edit.disabled = true;
      edit.textContent = '불러오는 중…';
      item.classList.add('busy');
      try {
        if (loaded) await state.loadTurns(loaded.chatKey);
        else await state.openChat(r.index);
        setEditMode('chat', 'editor');
      } catch (e) {
        flash(e instanceof HostError && e.code === 'missing'
          ? 'RisuAI가 이 챗을 아직 읽어 두지 않았습니다. RisuAI에서 그 챗을 한 번 연 다음 🔄 를 눌러 주세요.'
          : '챗을 불러오지 못했습니다: ' + msg(e));
      } finally {
        busy = false;
        if (item.isConnected) {
          edit.disabled = false;
          edit.textContent = '챗 편집';
          item.classList.remove('busy');
        }
      }
    };
    item.addEventListener('click', () => void enter());
    edit.addEventListener('click', (ev) => { ev.stopPropagation(); void enter(); });
    return item;
  };

  const loose = grouped.get('') ?? [];
  if (loose.length) {
    const list = el('div', { class: 'chatlist' });
    for (const r of loose) list.appendChild(makeItem(r));
    body.appendChild(list);
  }

  for (const f of folders) {
    const items = grouped.get(String(f.id)) ?? [];
    if (!items.length) continue;
    const fid = String(f.id);
    // A search shows every match: a folded folder would hide the hit.
    const isOpen = openFolders.has(fid) || !!needle;
    const fbody = el('div', { class: 'folderbody' + (isOpen ? ' open' : '') });
    for (const r of items) fbody.appendChild(makeItem(r));
    const caret = el('span', { text: isOpen ? '▾' : '▸' });
    const head = el('button', { class: 'folderhead' }, [
      caret,
      el('span', { class: 'folderdot', style: f.color ? { background: String(f.color) } : {} }),
      el('span', { class: 'grow', text: String(f.name || '폴더') }),
      el('span', { text: `${items.length}` }),
    ]);
    head.addEventListener('click', () => {
      const open = fbody.classList.toggle('open');
      if (open) openFolders.add(fid); else openFolders.delete(fid);
      caret.textContent = open ? '▾' : '▸';
    });
    body.appendChild(el('div', { class: 'folder' }, [head, fbody]));
  }

  const known = new Set(folders.map((f) => String(f.id)));
  const orphans = [...grouped.entries()]
    .filter(([k]) => k !== '' && !known.has(k))
    .flatMap(([, v]) => v);
  if (orphans.length) {
    const list = el('div', { class: 'chatlist' });
    for (const r of orphans) list.appendChild(makeItem(r));
    body.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '10px' }, text: '폴더 없음' }));
    body.appendChild(list);
  }

  body.appendChild(el('div', { class: 'row', style: { marginTop: '12px' } }, [
    buildUploadAll(),
    el('span', { class: 'hint', text: '챗을 누르면 그 챗만 불러옵니다. 여러 챗을 오가며 볼 때만 이 버튼을 쓰세요.' }),
  ]));

  paintDirty();
  dirty.want(state.activeCharKey, dirtyKey(), () => { if (body.isConnected) paintDirty(); });
}

function buildUploadAll(): HTMLElement {
  const b = el('button', { text: '이 봇의 모든 챗 불러오기' }) as HTMLButtonElement;
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

// --- 페르소나 ---------------------------------------------------------------------

function personaBody(body: HTMLElement, mount: HTMLElement): void {
  const head = el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '편집할 페르소나를 고르세요' }),
  ]);
  const again = el('button', { class: 'ghost tiny', text: '다시 읽기', title: 'RisuAI에서 페르소나 목록을 다시 읽어 옵니다' }) as HTMLButtonElement;
  again.disabled = state.personaLoading;
  again.addEventListener('click', () => { void state.loadPersonas().catch(() => undefined); });
  head.append(newPersonaButton(), again);
  body.appendChild(head);

  if (state.personaError) {
    body.appendChild(el('div', { class: 'notice err', text: state.personaError }));
  }
  const list = el('div', { class: 'chatlist personalist' });
  body.appendChild(list);
  const ps = (state.personas ?? []).filter((p) => !p.gone);
  if (!state.personas) {
    list.appendChild(loadingRow(state.personaLoading ? 'RisuAI에서 페르소나를 읽는 중…' : '페르소나 목록이 없습니다'));
    return;
  }
  if (!ps.length) list.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'hint', text: 'RisuAI에 페르소나가 없습니다.' })]));
  for (const p of ps) list.appendChild(personaRow(p, mount));
  body.appendChild(el('div', { class: 'hint', style: { marginTop: '8px' }, text:
    '편집은 작업본에 저장되고, 반영해야 RisuAI에 들어갑니다. RisuAI에서 지금 선택된 페르소나도 편집할 수 있지만, '
    + '반영하면 원본 대신 새 페르소나(사본)로 저장됩니다 (RisuAI가 선택된 페르소나를 따로 복사해 두고 써서, 그대로 쓰면 덮어써집니다).' }));
}

function personaRow(p: PersonaRow, mount: HTMLElement): HTMLElement {
  const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
  const name = p.work.name || p.name;
  const row = el('div', { class: 'chatitem' }, [
    personaAvatar(p.iconKey, name),
    el('span', { class: 'grow' }, [
      el('div', { text: name || '(이름 없음)' }),
      el('div', { class: 'hint clip1', text: (p.work.prompt || '').split('\n')[0].slice(0, 80) || '(설명 없음)' }),
    ]),
    p.selected ? el('span', { class: 'badge', text: 'RisuAI 선택됨', title: 'RisuAI에서 지금 선택된 페르소나 - 편집은 되고, 반영하면 새 페르소나(사본)로 저장됩니다' }) : null,
    p.isNew ? el('span', { class: 'badge', text: '새로 만듦', title: 'Hina에서 만든 페르소나 - 반영하면 RisuAI 목록에 추가됩니다' }) : null,
    p.dirty ? el('span', { class: 'badge warn', text: `미반영 ${p.total}` }) : null,
    edit,
  ]);
  let busy = false;
  const enter = async () => {
    if (busy) return;
    busy = true;
    edit.disabled = true;
    edit.textContent = '여는 중…';
    try {
      await state.openPersona(p.key);
      setEditMode('persona', 'persona');
    } catch (e) {
      flash('페르소나를 열지 못했습니다: ' + msg(e));
    } finally {
      busy = false;
      if (row.isConnected) { edit.disabled = false; edit.textContent = '편집'; }
    }
  };
  row.addEventListener('click', () => void enter());
  edit.addEventListener('click', (ev) => { ev.stopPropagation(); void enter(); });
  void mount;
  return row;
}

// --- 모듈 (§1-95) ------------------------------------------------------------------

/** Enter module editing on one module (it joins the 모듈 편집 set). */
async function enterModule(id: string): Promise<void> {
  setEditMode('module');
  await state.syncModuleOwner();
  await state.openModule(id, true);
  setTab('botlore');
}

/** A module file from the PC: uploaded, read by the backend, added to RisuAI, opened. */
export async function importModuleFromPc(f: File, progress: (text: string) => void): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  progress(`${f.name} 올리는 중…`);
  // Into the bot's project when there is one, else the top of projects/.
  const up = await state.uploadFile(f.name, btoa(bin), true, state.activeCharKey || state.targetModule ? '' : 'projects');
  state.touchFiles([up.path]);
  setEditMode('module');
  await state.syncModuleOwner();
  const row = await state.importModuleFile(up.path, progress);
  setTab('botlore');
  shellNotice(`'${row.name}' 모듈을 RisuAI에 추가하고 열었습니다 (원본 파일: ${up.path}).`, 'ok');
  return row.key;
}

function moduleBody(body: HTMLElement, mount: HTMLElement): void {
  const head = el('div', { class: 'row', style: { marginBottom: '8px', gap: '6px' } }, [
    el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '편집할 모듈을 고르세요' }),
  ]);
  const fileIn = el('input', { type: 'file', accept: '.risum,.charx,.json', style: { display: 'none' } }) as HTMLInputElement;
  const fromFile = el('button', { class: 'ghost tiny', text: '파일에서 가져오기…', title: '.risum · .charx · 모듈 .json 을 RisuAI 모듈 목록에 추가하고 엽니다' }) as HTMLButtonElement;
  fromFile.addEventListener('click', (ev) => { ev.stopPropagation(); fileIn.click(); });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    fromFile.disabled = true;
    try {
      await importModuleFromPc(f, (t) => { fromFile.textContent = t; });
    } catch (e) {
      flash('가져오지 못했습니다: ' + msg(e));
    } finally {
      fromFile.disabled = false;
      fromFile.textContent = '파일에서 가져오기…';
    }
  });
  const again = el('button', { class: 'ghost tiny', text: '다시 읽기', title: 'RisuAI에서 모듈 목록을 다시 읽어 옵니다' }) as HTMLButtonElement;
  again.disabled = state.moduleLoading;
  again.addEventListener('click', () => { void state.loadModules().catch(() => undefined); });
  head.append(fromFile, fileIn, again);
  body.appendChild(head);
  if (state.moduleError) body.appendChild(el('div', { class: 'notice err', text: state.moduleError }));
  const all = state.liveModules;
  const list = el('div', { class: 'chatlist modlist' });
  body.appendChild(list);
  if (!all) {
    list.appendChild(loadingRow(state.moduleLoading ? 'RisuAI에서 모듈을 읽는 중…' : '모듈 목록이 없습니다'));
    return;
  }
  if (all.length > 8) {
    setToolbarSearch(filterText, (v) => { filterText = v; renderChatsTab(mount); refocusSearch(null); }, '모듈 찾기');
  }
  const needle = filterText.trim().toLowerCase();
  const shown = all.filter((m) => !needle || m.name.toLowerCase().includes(needle) || m.description.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!all.length) list.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'hint', text: 'RisuAI에 모듈이 없습니다. 파일에서 가져올 수 있습니다.' })]));
  for (const m of shown) list.appendChild(moduleRow(m));
  body.appendChild(el('div', { class: 'hint', style: { marginTop: '8px' }, text:
    '모듈은 봇 카드와 같은 탭(정보·로어북·Regex·트리거·에셋)으로 편집되고, 반영해야 RisuAI 모듈 목록에 들어갑니다. '
    + '봇 편집·페르소나 편집에서도 탭 줄 끝의 ＋ 로 모듈을 함께 열 수 있고, 그 조합은 기억됩니다. '
    + '파일로 내보내기(.charx 권장 · .risum)는 모듈을 연 뒤 메뉴 줄의 ⬇ 내보내기로 합니다.' }));
}

function moduleRow(m: LiveModule): HTMLElement {
  const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
  const open = state.openModules.find((x) => x.id === m.id);
  const first = m.description.split('\n')[0].slice(0, 80);
  const row = el('div', { class: 'chatitem' + (m.mcp ? ' dim' : '') }, [
    el('span', { class: 'grow' }, [
      el('div', { text: '◫ ' + (m.name || '(이름 없음)') }),
      el('div', { class: 'hint clip1', text: m.mcp ? 'MCP 모듈 - 편집할 내용이 없습니다' : moduleLine(m) + (first ? ' — ' + first : '') }),
    ]),
    m.linked ? el('span', { class: 'badge', text: '이 봇에 연결됨' }) : null,
    m.global ? el('span', { class: 'badge', text: '전역' }) : null,
    open?.total ? el('span', { class: 'badge warn', text: `미반영 ${open.total}` }) : null,
    m.mcp ? null : edit,
  ]);
  if (m.mcp) return row;
  let busy = false;
  const enter = async () => {
    if (busy) return;
    busy = true;
    edit.disabled = true;
    edit.textContent = '여는 중…';
    try {
      await enterModule(m.id);
    } catch (e) {
      flash('모듈을 열지 못했습니다: ' + msg(e));
    } finally {
      busy = false;
      if (row.isConnected) { edit.disabled = false; edit.textContent = '편집'; }
    }
  };
  row.addEventListener('click', () => void enter());
  edit.addEventListener('click', (ev) => { ev.stopPropagation(); void enter(); });
  return row;
}

/** ＋ 새 페르소나: a new persona in the working copy; RisuAI gets it on 반영. */
export function newPersonaButton(onMade?: () => void): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '＋ 새 페르소나', title: '새 페르소나를 만듭니다 - 반영하면 RisuAI 페르소나 목록에 추가됩니다' });
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    askName('새 페르소나', {
      label: '이름을 정하면 바로 편집으로 들어갑니다. 설명·사진을 채운 뒤 반영하면 RisuAI 목록에 추가됩니다.',
      placeholder: '페르소나 이름', ok: '만들기',
      onSubmit: async (name) => {
        try {
          await state.createPersona(name);
          if (onMade) onMade(); else setEditMode('persona', 'persona');
        } catch (e) {
          flash('페르소나를 만들지 못했습니다: ' + msg(e));
        }
      },
    });
  });
  return b;
}

/** Decoded persona pictures by asset key, reused across renders (no blink). */
const avatarCache = new Map<string, string>();

export function personaAvatar(icon: string, name: string, cls = 'personaavatar'): HTMLElement {
  const fallback = el('span', { class: cls + ' initials', text: initials(name || '?') });
  if (!icon || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return fallback;
  const hit = avatarCache.get(icon);
  if (hit) return el('img', { class: cls, src: hit, alt: '' });
  void personaImage(icon).then((bytes) => {
    if (!bytes) return;
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(bytes);
    const url = URL.createObjectURL(new Blob([buf]));
    avatarCache.set(icon, url);
    if (fallback.isConnected) fallback.replaceWith(el('img', { class: cls, src: url, alt: '' }));
  });
  return fallback;
}

// --- shared --------------------------------------------------------------------

function initials(name: string): string {
  const t = name.trim();
  if (!t) return '?';
  return /[가-힣]/.test(t[0]) ? t.slice(0, 1) : t.slice(0, 2).toUpperCase();
}

let portraitUrl = '';
let portraitImg: HTMLImageElement | null = null;
let portraitPath = '';

/**
 * Draw the bot portrait, falling back to initials. One decoded <img> per
 * portrait path, moved into place on every render: no reload, no blink
 * (§1-34). The error handler putting the initials back is load-bearing on a
 * host whose CSP refuses blob: images.
 */
async function loadPortrait(path: string | undefined, mount: HTMLElement): Promise<void> {
  if (!path) return;
  if (portraitPath === path && portraitImg) {
    mount.replaceWith(portraitImg);
    return;
  }
  try {
    const bytes = await Risuai.readImage(path);
    if (!bytes || !(bytes as Uint8Array).byteLength) return;
    if (portraitUrl) URL.revokeObjectURL(portraitUrl);
    const view = bytes as Uint8Array;
    const buf = new Uint8Array(view.byteLength);
    buf.set(view);
    portraitUrl = URL.createObjectURL(new Blob([buf]));
    const img = el('img', { class: 'botportrait', src: portraitUrl, alt: '' });
    img.addEventListener('error', () => { img.replaceWith(mount); portraitImg = null; portraitPath = ''; });
    portraitImg = img;
    portraitPath = path;
    if (mount.isConnected) mount.replaceWith(img);
  } catch {
    /* keep the initials */
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The shell's notice line: it outlives this screen's re-renders. */
function flash(text: string): void {
  shellNotice(text, 'err');
}
