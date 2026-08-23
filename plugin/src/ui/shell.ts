/**
 * The panel shell: header, three tabs, and the mount points they render into.
 *
 * Sections stay in the DOM and are toggled with CSS rather than being rebuilt,
 * so switching tabs does not lose scroll position or an in-progress edit.
 */
import { el, clear, ICON } from './dom';
import { injectStyles } from './styles';
import { state } from '../state';
import { transport } from '../transport';
import { renderChatsTab } from './tab-chats';
import { renderEditorTab } from './tab-editor';
import { renderFilesTab } from './tab-files';
import { renderLoreTab } from './tab-lore';
import { renderMemoryTab } from './tab-memory';
import { renderSettingsTab } from './tab-settings';

/**
 * Content views in the tab bar; settings is not one of them.
 *
 * Settings is a place you visit occasionally to configure the tool, not a view
 * of the material - it was sitting in the tab bar competing for width with the
 * things the user is actually working on. It lives in the header now, next to
 * the other verbs.
 */
export type TabId = 'chats' | 'editor' | 'lore' | 'memory' | 'files' | 'settings';

const CONTENT_TABS: [TabId, string][] = [
  ['chats', '챗 선택'],
  ['editor', '챗 에딧'],
  ['lore', '챗 로어북'],
  ['memory', '장기기억'],
  ['files', '파일'],
];

const ALL_TABS: TabId[] = [...CONTENT_TABS.map(([id]) => id), 'settings'];

let active: TabId = 'chats';
let mounted = false;
const mounts: Record<TabId, HTMLElement> = {} as Record<TabId, HTMLElement>;
let healthEl: HTMLElement | null = null;
let toolbarSlot: HTMLElement | null = null;

/**
 * Hand the shell this tab's tool row, or null to leave the slot empty.
 *
 * The slot is shared, so whoever renders last owns it - which is exactly right,
 * because only one tab is visible at a time.
 */
export function setToolbar(node: HTMLElement | null): void {
  if (!toolbarSlot) return;
  clear(toolbarSlot);
  toolbarSlot.style.display = node ? 'block' : 'none';
  if (node) toolbarSlot.appendChild(node);
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
  else if (active === 'files') renderFilesTab(node);
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
    healthEl.appendChild(el('span', { text: '백엔드 연결 안 됨' }));
    healthEl.appendChild(el('span', {
      class: 'hint',
      text: state.connectError || '설정 탭에서 URL과 토큰을 확인해 주세요',
    }));
  } else {
    healthEl.appendChild(el('span', { class: 'hint', text: `백엔드 v${h.version}` }));
    if (!h.agentReady) {
      healthEl.appendChild(el('span', { class: 'hint', text: '· AI 미설정' }));
    }
  }

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
    const b = el('button', { class: 'tab', id: 'tab-' + id, text: label });
    b.addEventListener('click', () => setTab(id));
    return b;
  };

  const close = el('button', { class: 'ghost', html: ICON.close, title: '닫기' });
  close.addEventListener('click', async () => {
    try { await Risuai.hideContainer(); } catch { /* already hidden */ }
  });

  const reload = el('button', {
    class: 'iconbtn', html: ICON.reload,
    title: 'RisuAI에서 현재 열려 있는 봇과 챗을 다시 읽어 옵니다',
  });
  reload.addEventListener('click', () => { void bootstrap(true); });

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

  // A slot below the tabs that the active tab fills with its own tool row.
  // The row used to live inside the editor's middle column, which boxed it into
  // a third of the width and made it read as a property of the transcript
  // rather than as the actions available on this tab.
  toolbarSlot = el('div', { class: 'toolslot' });

  document.body.appendChild(el('div', { class: 'wrap' }, [
    el('header', {}, [
      el('h1', { html: ICON.app + '<span>Risu Elf</span>' }),
      el('span', { class: 'dim', text: 'v' + __PLUGIN_VERSION__ }),
      healthEl,
      el('span', { class: 'spacer' }),
      reload,
      settingsBtn,
      close,
    ]),
    el('div', { class: 'tabs' }, CONTENT_TABS.map(([id, label]) => tabButton(id, label))),
    toolbarSlot,
    el('main', {}, ALL_TABS.map((id) => mounts[id])),
  ]));

  document.getElementById('tab-chats')?.classList.add('active');
  mounted = true;
  refreshStatus();
}

state.onChange(() => {
  if (!mounted) return;
  refreshStatus();
  renderActive();
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

  await transport.detectPlatform();
  const connected = await state.connect();
  await state.readHost();

  if (connected && state.slot && !state.slotError) {
    try {
      await state.upload({ force });
      if (state.activeChatKey) await state.loadTurns();
    } catch (e) {
      console.log('[risu-elf] upload failed', e);
      state.emit();
    }
  }
  refreshStatus();
  renderActive();
}
