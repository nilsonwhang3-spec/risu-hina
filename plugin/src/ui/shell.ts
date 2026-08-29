/**
 * The panel shell: header, three tabs, and the mount points they render into.
 *
 * Sections stay in the DOM and are toggled with CSS rather than being rebuilt,
 * so switching tabs does not lose scroll position or an in-progress edit.
 */
import { el, clear, ICON, searchBox } from './dom';
import { describeSync, syncBusy } from '../assets';
import { injectStyles } from './styles';
import { state } from '../state';
import { transport, clientLog } from '../transport';
import { renderChatsTab } from './tab-chats';
import { renderEditorTab } from './tab-editor';
import { renderFilesTab } from './tab-files';
import { renderLoreTab } from './tab-lore';
import { renderMemoryTab } from './tab-memory';
import { renderVarsTab } from './tab-vars';
import { renderSettingsTab } from './tab-settings';
import { renderMetaTab } from './tab-meta';
import { renderBotLoreTab } from './tab-botlore';
import { renderRegexTab } from './tab-regex';
import { renderTriggerTab } from './tab-trigger';
import { buildChatBar, refreshChatBar, shellNotice } from './chatbar';
import { ensureResolved } from './leaveguard';
import { buildBotBar, refreshBotBar } from './botbar';
import { renderAssetsTab } from './tab-assets';
import { renderStudioTab } from './tab-studio';
import { getSettingsBar } from './tab-settings';

/**
 * Content views in the tab bar; settings is not one of them.
 *
 * Settings is a place you visit occasionally to configure the tool, not a view
 * of the material - it was sitting in the tab bar competing for width with the
 * things the user is actually working on. It lives in the header now, next to
 * the other verbs.
 */
export type TabId = 'chats' | 'editor' | 'lore' | 'memory' | 'vars'
  | 'meta' | 'botlore' | 'regex' | 'trigger' | 'assets' | 'files' | 'studio' | 'settings';

/**
 * What the middle of the tab bar edits: one chat, or the bot's card.
 *
 * One picker screen serves both (the bot with its chats IS the first screen),
 * so instead of eleven tabs competing for width, the bar swaps its middle:
 * 선택 | 챗 에딧 · 챗 로어북 · 장기기억 · 챗 변수 ┃ 워크스페이스 파일   (chat)
 * 선택 | 메타 · 봇 로어북 · Regex · 트리거 ┃ 워크스페이스 파일          (bot)
 * Clicking a chat on the picker enters chat mode; "봇 편집" enters bot mode.
 */
export type EditMode = 'chat' | 'bot';
// The bot half opens first: a session usually starts by looking at the card,
// and the chat tabs are one click away on the picker either way.
let mode: EditMode = 'bot';

const CONTENT_TABS: [TabId, string][] = [
  ['chats', '선택'],
  ['editor', '챗 에딧'],
  ['lore', '챗 로어북'],
  ['memory', '장기기억'],
  ['vars', '챗 변수'],
  ['meta', '메타'],
  ['botlore', '봇 로어북'],
  ['regex', 'Regex'],
  ['trigger', '트리거'],
  ['assets', '에셋'],
  ['files', '워크스페이스 파일'],
  // Not this bot's, and not any bot's: the studio library outlives them.
  ['studio', '에셋 스튜디오'],
];

/** Tabs that show one chat's material - the only place the chat bar belongs. */
const CHAT_TABS = new Set<TabId>(['editor', 'lore', 'memory', 'vars']);

/** Tabs that show the bot's card - where the bot bar belongs. */
const BOT_TABS = new Set<TabId>(['meta', 'botlore', 'regex', 'trigger', 'assets']);

export function setEditMode(m: EditMode, tab?: TabId): void {
  mode = m;
  // The agent is told which half is open with every prompt (Deps.mode).
  state.editMode = m;
  syncModeTabs();
  if (tab) setTab(tab);
  else if ((m === 'chat' ? BOT_TABS : CHAT_TABS).has(active)) setTab('chats');
}

export function currentMode(): EditMode {
  return mode;
}

function syncModeTabs(): void {
  for (const id of CHAT_TABS) {
    const b = document.getElementById('tab-' + id);
    if (b) b.style.display = mode === 'chat' ? '' : 'none';
  }
  for (const id of BOT_TABS) {
    const b = document.getElementById('tab-' + id);
    if (b) b.style.display = mode === 'bot' ? '' : 'none';
  }
}

const ALL_TABS: TabId[] = [...CONTENT_TABS.map(([id]) => id), 'settings'];

let active: TabId = 'chats';
let mounted = false;
const mounts: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
let healthEl: HTMLElement | null = null;
let toolbarSlot: HTMLElement | null = null;
let chatBarEl: HTMLElement | null = null;
let botBarEl: HTMLElement | null = null;
let tabSlot: HTMLElement | null = null;
/** End of the tab row: the asset importer's progress, visible from any tab. */
const syncBadge = el('span', { class: 'syncbadge', style: { display: 'none' } });

function refreshSyncBadge(): void {
  const p = state.assetSync;
  if (!p || !state.botKey) { syncBadge.style.display = 'none'; return; }
  const busy = syncBusy(p);
  let text = '';
  if (busy) {
    let ratio = -1;
    if (p.phase === 'pulling' && p.pull && p.pull.total) ratio = p.pull.done / p.pull.total;
    else if (p.phase === 'pushing' && p.toPush) ratio = (p.read + p.readFailed) / p.toPush;
    text = '에셋 ' + (ratio >= 0 ? Math.round(ratio * 100) + '%' : '대조 중');
  } else if (p.phase === 'error' || p.phase === 'cancelled') {
    text = '에셋 동기화 중단';
  } else if (p.total) {
    text = `에셋 ${p.present}/${p.total}` + (p.failed ? ` (실패 ${p.failed})` : '');
  }
  syncBadge.textContent = text;
  syncBadge.title = describeSync(p);
  syncBadge.className = 'syncbadge' + (busy ? ' busy' : (p.phase === 'error' ? ' err' : ''));
  syncBadge.style.display = text ? '' : 'none';
}

/**
 * Hand the shell this tab's tool row, or null to leave the tab's part of the
 * slot empty.
 *
 * The slot is shared, so whoever renders last owns it - which is exactly right,
 * because only one tab is visible at a time. The chat bar (반영 · 스냅샷 ·
 * 버전) sits ahead of it and is the shell's own: it acts on the chat, not on
 * a tab, so no tab gets to remove it.
 */
export function setToolbar(node: HTMLElement | null): void {
  if (!tabSlot) return;
  clear(tabSlot);
  if (node) tabSlot.appendChild(node);
  syncToolslot();
}

/**
 * A tab's filter box, on the menu line next to the bars rather than inside
 * the tab's own column - the chat editor's 찾기 lives there, and every list
 * tab's search should be found in the same place.
 */
export function setToolbarSearch(value: string, onInput: (v: string) => void, placeholder = '찾기'): void {
  setToolbar(searchBox(value, onInput, placeholder));
}

function syncToolslot(): void {
  if (!toolbarSlot || !chatBarEl || !botBarEl || !tabSlot) return;
  // The two bars are mutually exclusive by construction: CHAT_TABS and
  // BOT_TABS do not overlap. Selection tabs (챗 선택 · 봇 선택) and files show
  // neither - nothing is being edited there.
  const showChat = !!state.activeChatKey && CHAT_TABS.has(active);
  const showBot = !!state.botKey && BOT_TABS.has(active);
  chatBarEl.style.display = showChat ? '' : 'none';
  botBarEl.style.display = showBot ? '' : 'none';
  const showTab = tabSlot.childElementCount > 0;
  tabSlot.style.display = showTab ? '' : 'none';
  toolbarSlot.style.display = showChat || showBot || showTab ? '' : 'none';
}

export function setTab(tab: TabId): void {
  active = tab;
  for (const id of ALL_TABS) {
    mounts[id]?.classList.toggle('active', id === tab);
    document.getElementById('tab-' + id)?.classList.toggle('active', id === tab);
  }
  // The gear is a toggle, so it has to look pressed while settings is open.
  document.getElementById('open-settings')?.classList.toggle('on', tab === 'settings');
  renderActive();
  syncSettingsBar();
  syncToolslot();
  refreshTabBadges();
  // The header's mode chip follows the active tab (edit tabs only).
  refreshStatus();
}

/**
 * While settings is open the tab row shows the settings sections (연결 ·
 * API 키/인증 · 에이전트 · 스킬 · 정보·로그) in place of the content tabs -
 * the row always names what the panel is showing.
 */
function syncSettingsBar(): void {
  const row = document.querySelector('.tabs') as HTMLElement | null;
  if (!row) return;
  const inSettings = active === 'settings';
  for (const b of Array.from(row.querySelectorAll('.tab, .tabsep'))) {
    (b as HTMLElement).style.display = inSettings ? 'none' : '';
  }
  if (!inSettings) syncModeTabs();
  syncBadge.style.visibility = inSettings ? 'hidden' : '';
  const bar = getSettingsBar();
  if (bar) {
    if (bar.parentElement !== row) row.appendChild(bar);
    bar.style.display = inSettings ? '' : 'none';
  }
}

export function currentTab(): TabId {
  return active;
}

function renderActive(): void {
  const node = mounts[active];
  if (!node) return;
  if (active !== 'editor') setToolbar(null);
  if (active === 'chats') renderChatsTab(node);
  else if (active === 'editor') renderEditorTab(node);
  else if (active === 'lore') renderLoreTab(node);
  else if (active === 'memory') renderMemoryTab(node);
  else if (active === 'vars') renderVarsTab(node);
  else if (active === 'meta') renderMetaTab(node);
  else if (active === 'botlore') renderBotLoreTab(node);
  else if (active === 'regex') renderRegexTab(node);
  else if (active === 'trigger') renderTriggerTab(node);
  else if (active === 'assets') renderAssetsTab(node);
  else if (active === 'files') renderFilesTab(node);
  else if (active === 'studio') renderStudioTab(node);
  else renderSettingsTab(node);
}

/**
 * The health strip, above everything else.
 *
 * When the backend is unreachable every other message on screen is a symptom
 * of that, so it belongs where it is read first rather than as one badge among
 * others in the header.
 */
export function refreshStatus(): void {
  if (!healthEl) return;
  clear(healthEl);
  const h = state.health;

  // Health lives in the title row rather than in a strip of its own. Two full
  // rows of chrome above the tabs cost real vertical space in a panel whose
  // whole job is showing a long transcript, and the health state is one dot
  // plus a version - it never needed a row.
  healthEl.className = 'status' + (h ? (h.agentReady ? '' : ' warn') : ' bad');
  healthEl.appendChild(el('span', { class: 'healthdot' }));

  if (!h) {
    // One dot and four words. The error text and the way to settings are on
    // the picker (the notice there) and in ⚙ → 연결 → 연결 진단; in the
    // title row they made a strip of chrome out of a status light.
    healthEl.appendChild(el('span', { text: '백엔드 연결 안 됨' }));
    healthEl.title = (state.connectError || '설정에서 URL과 토큰을 확인해 주세요')
      + (reconnectTimer ? ` (자동 재시도 ${reconnectAttempts + 1}회째)` : '');
    if (reconnectTimer) healthEl.appendChild(el('span', { class: 'hint', text: '재시도 중' }));
  } else if (transport.versionGate) {
    // Different major.minor on the two sides: ordinary calls are refused
    // (transport) and the strip says which side to update.
    healthEl.className = 'status bad';
    healthEl.appendChild(el('span', { text: `백엔드 v${h.version} · 플러그인 v${__PLUGIN_VERSION__} — 버전이 다릅니다` }));
    const go = el('button', { class: 'primary tiny', text: transport.versionGate.includes('백엔드를 업데이트') ? '백엔드 업데이트로' : '안내 보기' });
    go.addEventListener('click', () => setTab('settings'));
    healthEl.appendChild(go);
    healthEl.title = transport.versionGate;
  } else {
    healthEl.appendChild(el('span', { class: 'hint', text: `백엔드 v${h.version}` }));
    if (!h.agentReady) {
      healthEl.appendChild(el('span', { class: 'hint', text: '· AI 미설정' }));
    }
  }

  // While the open is in progress, say which step: reading the bot out of
  // RisuAI can take a while on web RisuAI, and that wait looked like a
  // backend that would not connect.
  if (bootPhase) healthEl.appendChild(el('span', { class: 'hint bootphase', text: '· ' + bootPhase }));

  // Which half is being edited, in the same words Hina is told. Shown only
  // while an edit tab is open - on the picker the question is not answered
  // yet, and in settings or files it is not being asked.
  if (CHAT_TABS.has(active) || BOT_TABS.has(active)) {
    healthEl.appendChild(el('span', {
      class: 'badge modechip',
      text: mode === 'chat' ? '챗 편집' : '봇 편집',
      title: mode === 'chat'
        ? '이 챗의 재료(턴·챗 로어북·장기기억·챗 변수)를 고치는 화면입니다'
        : '봇 카드의 재료(메타·인사말·봇 로어북·Regex·트리거·에셋)를 고치는 화면입니다',
    }));
  }

  // The bot first, then the chat: the bot is what the panel was opened on
  // and the bot tabs have no chat to name.
  const botName = state.character?.name ? String(state.character.name) : '';
  if (botName) healthEl.appendChild(el('span', { class: 'hint botname', text: `· ${botName}` }));
  const chat = state.activeChat;
  if (chat) {
    healthEl.appendChild(el('span', {
      class: 'hint chatname',
      text: `· ${chat.name || chat.chatKey} · ${chat.turns}턴`,
    }));
  }
}

export function buildShell(): void {
  injectStyles();
  clear(document.body);

  healthEl = el('div', { class: 'status' });

  const tabButton = (id: TabId, label: string) => {
    const b = el('button', { class: 'tab', id: 'tab-' + id }, [
      el('span', { text: label }),
      // Only the files tab ever fills this: the count of agent outputs the
      // user has not looked at. Cleared by opening the tab.
      el('span', { class: 'badge warn tabbadge', style: { display: 'none' } }),
    ]);
    b.addEventListener('click', () => {
      // Going back to the picker is leaving the edit; the guard asks first.
      // Moving between tabs of the same scope is not (same working copy).
      if (id === 'chats' && active !== 'chats') {
        void (async () => {
          if (await ensureResolved('선택 화면으로 이동')) setTab(id);
        })();
        return;
      }
      setTab(id);
    });
    return b;
  };

  const close = el('button', { class: 'ghost', html: ICON.close, title: '닫기' });
  close.addEventListener('click', async () => {
    // The X is the front door out, and it must not leave work pending behind
    // it (the browser closing is the one exit that cannot ask; the reopen
    // merge covers that one).
    if (!(await ensureResolved('닫기'))) return;
    try { await Risuai.hideContainer(); } catch { /* already hidden */ }
  });

  const reload = el('button', {
    class: 'iconbtn', html: ICON.reload,
    title: 'RisuAI에서 현재 열려 있는 봇과 챗을 다시 읽어 옵니다. 미반영 변경이 있으면 먼저 물어봅니다',
  });
  reload.addEventListener('click', () => {
    // force=true throws the panel's copy away; with the guard in front it can
    // no longer do so silently.
    void (async () => {
      if (await ensureResolved('다시 읽기')) void bootstrap(true);
    })();
  });

  const settingsBtn = el('button', {
    class: 'iconbtn', id: 'open-settings', html: ICON.gear,
    title: '설정 — 백엔드 연결 · 에이전트 프리셋 · 스킬',
  });
  // A toggle, not a one-way door: pressing it again returns to what was open.
  let cameFrom: TabId = 'chats';
  settingsBtn.addEventListener('click', () => {
    if (active === 'settings') setTab(cameFrom);
    else {
      cameFrom = active;
      setTab('settings');
    }
  });

  for (const id of ALL_TABS) {
    mounts[id] = el('div', { class: 'panel' + (id === 'chats' ? ' active' : '') });
  }

  // A slot below the tabs: the chat bar first, then whatever tool row the
  // active tab adds. The row used to live inside the editor's middle column,
  // which boxed it into a third of the width and made it read as a property of
  // the transcript rather than as the actions available on this tab.
  const shellNotice = el('div', { class: 'shellnotice' });
  chatBarEl = buildChatBar(shellNotice);
  botBarEl = buildBotBar();
  tabSlot = el('div', { class: 'tabslot' });
  toolbarSlot = el('div', { class: 'toolslot' }, [chatBarEl, botBarEl, tabSlot]);

  document.body.appendChild(el('div', { class: 'wrap' }, [
    el('header', {}, [
      el('h1', { html: ICON.app + '<span>Risu Hina</span>' }),
      el('span', { class: 'dim', text: 'v' + __PLUGIN_VERSION__ }),
      healthEl,
      el('span', { class: 'spacer' }),
      reload,
      settingsBtn,
      close,
    ]),
    // The files tab sits right after 에셋, and the importer's badge goes at
    // the far end of the row on its own: it used to sit between the two with
    // margin-left:auto, which pushed 워크스페이스 파일 to the opposite edge
    // of the bar from the tab it belongs beside.
    el('div', { class: 'tabs' }, [
      ...CONTENT_TABS.flatMap(([id, label]) => (
        id === 'files'
          ? [el('span', { class: 'tabsep', title: '여기부터는 편집 대상이 아니라 작업 공간입니다 — 봇의 워크스페이스와, 봇과 무관한 에셋 스튜디오' }), tabButton(id, label)]
          : [tabButton(id, label)]
      )),
      syncBadge,
    ]),
    toolbarSlot,
    shellNotice,
    el('main', {}, ALL_TABS.map((id) => mounts[id])),
  ]));

  document.getElementById('tab-chats')?.classList.add('active');
  mounted = true;
  syncModeTabs();
  refreshStatus();
  syncToolslot();
}

function refreshTabBadges(): void {
  const badge = document.querySelector('#tab-files .tabbadge') as HTMLElement | null;
  if (badge) {
    const n = state.unseenOutputs.length;
    badge.textContent = String(n);
    badge.style.display = n && active !== 'files' ? '' : 'none';
  }
  // Bot tabs: how many things on that tab differ from the baseline. The bot
  // bar's total says "1"; these say where. Shown on the active tab too - it
  // is a state, not an unread count.
  const c = state.botChanges;
  const per: Record<string, number> = {
    meta: c ? c.fields + (c.greetings?.total ?? 0) : 0,
    botlore: c?.lore?.total ?? 0,
    regex: c?.customscript?.total ?? 0,
    trigger: c?.triggerscript?.total ?? 0,
    assets: c?.assetref?.total ?? 0,
  };
  for (const [id, n] of Object.entries(per)) {
    const b = document.querySelector(`#tab-${id} .tabbadge`) as HTMLElement | null;
    if (!b) continue;
    b.textContent = String(n);
    b.title = n ? `기준선과 다른 항목 ${n}개 — 각 항목에 추가/수정 표시가 있습니다` : '';
    b.style.display = n ? '' : 'none';
  }
  // One red badge on the tab bar when something needs deciding, so a conflict
  // is visible from whichever tab the user happens to be on.
  const stuck = (state.botChanges?.conflicts ?? 0) + (state.changes?.conflicts ?? 0);
  for (const id of ['meta', 'botlore', 'regex', 'trigger', 'editor', 'lore', 'memory'] as TabId[]) {
    const b = document.querySelector(`#tab-${id} .tabbadge`) as HTMLElement | null;
    if (b) b.classList.toggle('conflict', stuck > 0 && b.style.display !== 'none');
  }
}

state.onChange(() => {
  if (!mounted) return;
  // An approved agent proposal asked for a tab: go there, switching the
  // bar's middle to whichever mode owns it.
  if (state.openTabRequest) {
    const tab = state.openTabRequest as TabId;
    state.openTabRequest = null;
    const want: EditMode | null = CHAT_TABS.has(tab) ? 'chat' : BOT_TABS.has(tab) ? 'bot' : null;
    if (want && want !== mode) {
      // The agent asked for the other half: that is a mode switch like any
      // other, and the guard asks the same question first.
      void (async () => {
        const except = want === 'bot'
          ? { scope: 'card' as const }
          : { scope: 'chat' as const, key: state.activeChatKey };
        if (await ensureResolved('탭 이동', except)) setEditMode(want, tab);
      })();
    } else if (want) {
      setEditMode(want, tab);
    } else if (tab === 'files' || tab === 'chats') setTab(tab);
    return;
  }
  // A log line in the agent panel asked for a file: go where files are.
  if (state.openFileRequest && active !== 'files') {
    setTab('files');
    return;
  }
  refreshStatus();
  refreshChatBar();
  refreshBotBar();
  refreshTabBadges();
  refreshSyncBadge();
  renderActive();
  syncToolslot();
});

/**
 * Open sequence.
 *
 * Order matters for perceived speed: the shell paints first, then the host read
 * (cheap - 51ms for a 394-turn character), then the upload (seconds for a
 * multi-megabyte transcript). Doing the upload before painting would look like
 * the plugin had hung.
 */
export async function bootstrap(force = false): Promise<void> {
  if (!mounted) buildShell();
  setTab(active);

  // Each step is timed and the whole open is reported once, because the one
  // slow open in the log (web RisuAI, 2 minutes between /health and the
  // upload) sat inside readHost - the host bridge, not the backend - and the
  // panel had no way to say so; the status light said "connected" and the
  // user read the empty panel as "not connected".
  const t0 = Date.now();
  setBootPhase('백엔드에 연결하는 중…');
  await transport.detectPlatform();
  const connected = await state.connect();
  const t1 = Date.now();
  setBootPhase('RisuAI에서 봇을 읽는 중…');
  await state.readHost();
  const t2 = Date.now();

  if (connected) {
    setBootPhase('백엔드에 올리는 중…');
    await uploadAfterConnect(force);
  } else {
    // The backend was not reachable at open (a tunnel warming up, plain
    // fetch not yet in effect, a laptop waking). Keep trying for a while;
    // the first success uploads the bot exactly as a good open would have.
    startReconnect(force);
  }
  const t3 = Date.now();
  setBootPhase('');
  refreshStatus();
  renderActive();
  const hostMs = t2 - t1;
  if (connected) {
    void clientLog(hostMs > 5000 ? 'warn' : 'info', 'boot', {
      connectMs: t1 - t0, hostMs, uploadMs: t3 - t2, platform: transport.hostPlatform,
      hostError: state.slotError.slice(0, 200),
    });
  }
}

/** What the open is doing right now; '' once it is done. Shown in the title row. */
let bootPhase = '';
function setBootPhase(text: string): void {
  bootPhase = text;
  refreshStatus();
}

/**
 * Send the bot up, once.
 *
 * Two things call this on a recovered connection - the reconnect loop and the
 * "connected some other way" watcher below - and `state.connect()` emits
 * before the loop resumes, so both fired for the same recovery: the server log
 * showed every reconnect uploading the workspace and rebuilding the asset
 * manifest twice. The in-flight promise makes the second caller join the first
 * instead of starting another multi-megabyte upload.
 */
let uploadInFlight: Promise<void> | null = null;
/**
 * Say what the re-open merge did, once, in one line.
 *
 * Silence would be wrong here: rows moved on their own. The user needs to
 * know that the panel is showing RisuAI's newer text rather than the copy
 * they left behind - and, when something could not be decided, that 반영 is
 * waiting on them.
 */
function announceMerge(): void {
  const m = state.lastMerge;
  state.lastMerge = null;
  if (!m) return;
  const bits: string[] = [];
  if (m.adopt) bits.push(`수정 ${m.adopt}건`);
  if (m.insert) bits.push(`추가 ${m.insert}건`);
  if (m.delete) bits.push(`삭제 ${m.delete}건`);
  const conflicts = m.conflict ?? 0;
  if (!bits.length && !conflicts) return;
  const head = bits.length ? `RisuAI 쪽 변경을 받았습니다 (${bits.join(' · ')}).` : '';
  const tail = conflicts ? ` 편집 중이던 ${conflicts}건은 충돌로 표시했습니다 — 반영 전에 골라 주세요.` : '';
  shellNotice((head + tail).trim(), conflicts ? 'err' : 'ok');
}

async function uploadAfterConnect(force = false): Promise<void> {
  if (uploadInFlight) return uploadInFlight;
  if (!state.slot || state.slotError) return;
  uploadInFlight = (async () => {
    try {
      await state.upload({ force });
      announceMerge();
      if (state.activeChatKey) await state.loadTurns();
    } catch (e) {
      console.log('[risu-hina] upload failed', e);
      state.emit();
    }
  })();
  try {
    await uploadInFlight;
  } finally {
    uploadInFlight = null;
  }
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** How many probes have failed since the panel opened; 0 once connected. */
let reconnectAttempts = 0;
// Backs off to 30s and then stays there: a /health probe is cheap, and the
// one real failure report was a tunnel that opened a minute or two after
// the panel did - giving up after ten tries meant the user refreshed instead.
const RECONNECT_DELAYS = [3000, 5000, 8000, 12000, 20000, 30000];

export function reconnecting(): boolean { return reconnectTimer !== null; }

function startReconnect(force: boolean): void {
  if (reconnectTimer) return;
  let i = 0;
  const startedAt = Date.now();
  const tick = async () => {
    reconnectTimer = null;
    if (state.health) return;
    reconnectAttempts += 1;
    const lastError = state.connectError;
    const lastProbe = transport.probeInfo;
    const ok = await state.connect();
    if (ok) {
      // The backend can only hear about a connection failure after it ends.
      // Recording how it looked from here is what turns the next "it did not
      // connect for a while" into a log line with the actual error in it.
      void clientLog('warn', 'connect recovered', {
        attempts: reconnectAttempts,
        seconds: Math.round((Date.now() - startedAt) / 1000),
        lastError: lastError.slice(0, 300),
        // Who was answering while it failed. An HTML content-type or a
        // cacheable Cache-Control here means an intermediary replied and the
        // backend never saw the request.
        lastProbe: lastProbe.slice(0, 300),
        platform: transport.hostPlatform,
      });
      reconnectAttempts = 0;
      if (!state.slot) await state.readHost();
      if (!state.workspace) await uploadAfterConnect(force);
      refreshStatus();
      renderActive();
      return;
    }
    refreshStatus();
    reconnectTimer = setTimeout(tick, RECONNECT_DELAYS[Math.min(i++, RECONNECT_DELAYS.length - 1)]);
  };
  reconnectTimer = setTimeout(tick, RECONNECT_DELAYS[Math.min(i++, RECONNECT_DELAYS.length - 1)]);
}

// A connection that comes up some other way (저장하고 연결 in settings, the
// diagnostic probe) also has to finish the open: upload the bot it never got.
let sawConnected = false;
state.onChange(() => {
  const ok = !!state.health;
  if (ok && !sawConnected && mounted && !state.workspace && state.slot && !state.slotError) {
    void uploadAfterConnect().then(() => { refreshStatus(); renderActive(); });
  }
  sawConnected = ok;
});
