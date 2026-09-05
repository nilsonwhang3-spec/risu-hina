/**
 * 에셋 스튜디오 - the image library, and the one tab that is not about a bot.
 *
 * Every other tab edits the bot RisuAI has open. This one edits a library that
 * outlives any of them: you generate images, sort them, and only then decide
 * which bot gets them. So it renders with **no bot selected at all** - the
 * shell already survives that state (readHost only sets slotError), and it is
 * the per-tab render functions that bail. This one does not.
 *
 *   left    two tabs. 프롬프트: the ONE selected style edited in place, the
 *           character view behind the 캐릭터 button, the 조각 button, and the
 *           generation card. OUTPUT: the studio/output tree. Both rails
 *           collapse to a slim strip - the studio is the crowded tab, and the
 *           centre is where the work happens.
 *   centre  the picked card's editor, the fragment organizer, the live queue,
 *           or the picked output folder (the comparison selector for images).
 *   right   Hina, as on every tab
 *
 * The library is the `studio/` folder of the ONE global space, so its files
 * ride the shared file methods on `state` with space-rooted paths; only the
 * domain calls (NovelAI, batches, the selector) live on `state.studio`.
 *
 * A bot IS needed to *adopt* an image into a card - that is gated per action,
 * where it is true, rather than on the whole tab.
 */
import { el, clear, ICON, iconBtn } from './../dom';
import { state, type StudioItem } from '../../state';
import { threePane } from '../panes';
import { bindAgent, mountAgent } from '../agentpane';
import { CARD_AREAS, OUTPUT_ROOT, S, hub, areaOfPath, canonPath, checkUnresolved,
         persistLeftTab, persistCentreTab, buildOutput, buildExtras, extraPaths, addExtra,
         isOutputPath, find, msg } from './store';
import { pollJob, loadJobs, markJobsStale } from './gen';
import { drawCardEditor, drawSceneEditor, drawRawFile, rawView } from './editors';
import { drawCharacterEditor } from './char-edit';
import { buildLeftPrompt, syncPromptBadges } from './left-prompt';
import { buildLeftChars } from './left-chars';
import { buildLeftOutput, openFolderPicker } from './left-output';
import { drawFragments } from './center-frags';
import { drawSingle, singleTick, syncControls } from './center-single';
import { drawBatch, batchTick } from './center-batch';
import { buildStrip, stripTick, refreshStrip } from './strip';
import { drawFolder } from './center-folder';
import { hasGroups, loadGroups, drawSelector } from './selector';
import { setLayoutControls } from '../shell';
import { reclamp } from '../splitter';

let built = false;
/** The filesRev this tab last drew. While the tab stays active, an unrelated
 * state emit no longer triggers the five-request library re-read. */
let renderedRev = -1;
/** Whether the previous render was already this tab: coming BACK is still a
 * deliberate visit and re-reads (files can arrive from another machine, which
 * bumps no rev here); staying put does not. */
let wasStudioActive = false;
let splitRoot: HTMLElement | null = null;
let leftContent: HTMLElement | null = null;
let tabbar: HTMLElement | null = null;

/** shell.setTab tells us when the user goes elsewhere - there is no emit on a
 * tab switch, so the "came back" signal has to be handed over explicitly. */
export function noteStudioLeft(): void {
  wasStudioActive = false;
}

// --- panel collapse ---------------------------------------------------------------
// Both rails fold to a slim strip: the studio is the crowded tab, and 1장
// previews and batch grids want the width. Independent toggles, remembered.
const PANELS_KEY = 'hina.studioPanels';
const panels = { left: false, right: false };
try {
  const saved = JSON.parse(localStorage.getItem(PANELS_KEY) || 'null') as Partial<typeof panels> | null;
  if (saved && typeof saved === 'object') Object.assign(panels, saved);
} catch { /* storage may be unavailable in the iframe */ }

/** 검수 folds the chat automatically (non-persisted): review is the one
 * screen where Hina is rarely needed and the grid wants the width. A manual
 * toggle wins and clears it; leaving 검수 restores the panel. */
let autoRight = false;
let wasInspect = false;

let layBtnL: HTMLElement | null = null;
let layBtnR: HTMLElement | null = null;

function applyPanels(): void {
  if (!splitRoot) return;
  splitRoot.classList.toggle('lcollapse', panels.left);
  splitRoot.classList.toggle('rcollapse', panels.right || autoRight);
  reclamp(splitRoot);
  layBtnL?.classList.toggle('on', !panels.left);
  layBtnR?.classList.toggle('on', !(panels.right || autoRight));
}

function togglePanel(side: 'left' | 'right'): void {
  if (side === 'right' && autoRight) {
    // The auto-fold from entering 검수: one manual toggle only reopens it.
    autoRight = false;
  } else {
    panels[side] = !panels[side];
  }
  try { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); } catch { /* fine */ }
  applyPanels();
  // The centre strip's arrows read the state; keep them honest.
  if (S.centreMode === 'tab' && !S.selectedFile) drawCentre();
}

/** The two panel toggles, registered on the SHELL tab row (§1-30) - VS Code
 * style, instead of slim rails and a button floating over the agent header
 * (which sat on top of its own controls and made the right side feel broken). */
function ensureLayoutControls(): void {
  if (!layBtnL || !layBtnR) {
    layBtnL = iconBtn(ICON.layoutL, '왼쪽 패널(프롬프트·OUTPUT) 접기/펼치기');
    layBtnL.classList.add('laybtn');
    layBtnL.addEventListener('click', () => togglePanel('left'));
    layBtnR = iconBtn(ICON.layoutR, 'AI 챗 패널 접기/펼치기');
    layBtnR.classList.add('laybtn');
    layBtnR.addEventListener('click', () => togglePanel('right'));
  }
  setLayoutControls(el('span', { class: 'row', style: { gap: '2px' } }, [layBtnL, layBtnR]));
  applyPanels();
}

export function renderStudioTab(mount: HTMLElement): void {
  const entering = !wasStudioActive;
  wasStudioActive = true;
  ensureLayoutControls();
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    // The studio runs its own fold state (검수 auto-fold); no shared controls.
    const pane = threePane(undefined, { controls: false });
    splitRoot = pane.root;

    // The left column: [프롬프트 | OUTPUT] tabs over the content.
    tabbar = el('div', { class: 'studiotabs tabstrip' });
    leftContent = el('div', { class: 'tree filetree' });
    S.leftMount = leftContent;
    pane.left.append(tabbar, leftContent);

    S.noticeMount = el('div');
    S.viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(S.noticeMount, S.viewMount);
    // The bottom strip sits AFTER the scrolling .pad, so it is the fixed bar
    // under every centre view (the .left column is a flex column).
    pane.centre.appendChild(buildStrip());

    applyPanels();

    mount.appendChild(pane.root);
    built = true;
    void refresh();
    void loadStatus();
    // Relocated from the old history tab: while the studio shows and nothing
    // of ours runs, look every few seconds for a batch the agent (or another
    // window) started - loadJobs adopts it and the ordinary poll takes over.
    setInterval(() => {
      if (!wasStudioActive) return;
      // Files changed under us (the agent wrote a card, a batch landed) and
      // no render asked for a refresh: re-read now rather than on the next
      // tab visit (§1-39 "AI 로 수정한 뒤 표시 안 됨").
      if (renderedRev !== state.filesRev && !S.jobId) { void refresh(); return; }
      if (S.jobId) return;
      void loadJobs(true).then(() => hub.jobTick());
    }, 5000);
  } else if (entering || renderedRev !== state.filesRev || state.openStudioRequest) {
    // COMING BACK to the tab re-reads the library (files arrive from outside
    // any rev - another machine writes into the same space), and so does a
    // files change while we sit here. What no longer re-reads is every other
    // state emit - a chat token, a card edit elsewhere - which used to cost
    // the same five requests each.
    void refresh();
  }
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

async function loadStatus(): Promise<void> {
  try {
    S.status = await state.studio.status();
  } catch (e) {
    S.status = { configured: false, library: '', error: msg(e) };
  }
  // The meters live on the centre tabs now.
  if (S.centreMode === 'tab' && !S.selectedFile) drawCentre();
}

/** A toast in the corner, never a bar that shoves the centre down: a notice
 * used to land above the tabs and shift everything under the pointer. */
function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  let wrap = document.querySelector<HTMLElement>('.toastwrap');
  if (!wrap) {
    wrap = el('div', { class: 'toastwrap' });
    document.body.appendChild(wrap);
  }
  const t = el('div', { class: 'toast ' + kind, text, title: '누르면 닫힙니다' });
  t.addEventListener('click', () => t.remove());
  wrap.appendChild(t);
  while (wrap.children.length > 4) wrap.firstChild?.remove();
  setTimeout(() => t.remove(), kind === 'err' ? 12000 : 6000);
}

async function refresh(): Promise<void> {
  renderedRev = state.filesRev;
  try {
    const [l, ...areas] = await Promise.all([
      // Only the output slice: the studio never reads the rest of the space.
      state.files(OUTPUT_ROOT),
      ...CARD_AREAS.map((a) => state.studio.items(a.area).then((r) => r.items).catch(() => [] as StudioItem[])),
    ]);
    S.listing = l;
    S.cards = Object.fromEntries(CARD_AREAS.map((a, i) => [a.area, areas[i]]));
  } catch (e) {
    S.listing = null;
    drawLeft();
    if (S.viewMount) {
      clear(S.viewMount);
      S.viewMount.appendChild(el('div', { class: 'notice err' }, [
        el('div', { text: '스튜디오 라이브러리를 읽지 못했습니다.' }),
        el('div', { class: 'hint', text: e instanceof Error ? e.message : String(e) }),
        el('div', { class: 'hint', text: '설정 → 연결에서 백엔드 상태를 확인해 주세요.' }),
      ]));
    }
    return;
  }
  await migrateSingleStyle();
  buildOutput();
  // The agent (or a batch strip in the chat, or the files tab) asked for
  // 검수 on a folder. One outside OUTPUT gets pinned first (§1-33).
  const want = state.openStudioRequest;
  const wantFolder = want ? canonPath(want.folder) : '';
  if (wantFolder && !isOutputPath(wantFolder)) addExtra(wantFolder);
  await loadExtras();
  if (want) {
    state.openStudioRequest = null;
    const folder = wantFolder;
    if (find(folder)) {
      S.selected = folder;
      const parts = folder.split('/');
      for (let i = 2; i <= parts.length; i++) S.open.add(parts.slice(0, i).join('/'));
      S.selectedFile = '';
      S.centreMode = 'tab';
      S.centreTab = 'inspect';
      S.leftTab = 'output';
      persistCentreTab();
      persistLeftTab();
    } else {
      notice('그 폴더를 찾지 못했습니다: ' + folder, 'err');
    }
  }
  drawLeft();
  drawCentre();
  checkUnresolved();
  markJobsStale();
  void refreshStrip();
  if (S.jobId) void pollJob();
}

/** The pinned folders' own listings (one request each; usually zero or one). */
async function loadExtras(): Promise<void> {
  const pairs = await Promise.all(extraPaths.map(async (p) => {
    try { return [p, await state.files(p)] as const; } catch { return [p, null] as const; }
  }));
  buildExtras(Object.fromEntries(pairs));
  for (const p of extraPaths) S.open.add(p);
}

/** The dropdown means ONE style. Cards written before the dropdown could have
 * several enabled; the first (order, path) stays on and the rest are turned
 * off, said out loud once. */
let migrated = false;
async function migrateSingleStyle(): Promise<void> {
  const on = (S.cards.styles ?? [])
    .filter((i) => i.enabled)
    .sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
  if (on.length <= 1) return;
  const keep = on[0];
  try {
    for (const it of on.slice(1)) {
      await state.studio.setMeta(it.path, { enabled: false });
      it.enabled = false;
    }
    if (!migrated) {
      notice(`스타일 프롬프트는 이제 1개만 실립니다 — “${keep.name}” 만 남기고 나머지는 껐습니다.`);
      migrated = true;
    }
    touchQuiet();
  } catch { /* the next refresh tries again */ }
}

/** Tell the files tab about a studio write without re-reading our own world:
 * touchFiles bumps filesRev by one, and pre-advancing renderedRev keeps the
 * guard in renderStudioTab from turning that bump back into a full refresh. */
function touchQuiet(paths: string[] = []): void {
  renderedRev = state.filesRev + 1;
  state.touchFiles(paths);
}

/** Re-read ONE card area after a save - a card edit cannot change the output
 * tree or the other areas, so one listing call replaces the old five. */
async function refreshArea(area: string): Promise<void> {
  try {
    S.cards[area] = (await state.studio.items(area)).items;
  } catch { /* keep what we have; the next full refresh corrects it */ }
  drawLeft();
  drawCentre();
  checkUnresolved();
  touchQuiet();
}

/** The live-job heartbeat lands on whichever tab is showing. */
function jobTick(): void {
  stripTick();
  syncControls(); // the left column's 생성 시작/취소 follows the run wherever the centre is
  if (S.centreMode !== 'tab' || S.selectedFile) return;
  if (S.centreTab === 'single') singleTick();
  else if (S.centreTab === 'batch') batchTick();
}

// The hub: what the sibling modules call to reach back into this file (and
// gen.ts) without an import cycle. Registered at module load, before any
// render can run.
hub.drawLeft = drawLeft;
hub.drawCentre = drawCentre;
hub.jobTick = jobTick;
hub.syncBadges = syncPromptBadges;
hub.notice = notice;
hub.refresh = refresh;
hub.refreshArea = refreshArea;
hub.loadStatus = loadStatus;
hub.touchQuiet = touchQuiet;

// --- the left column -----------------------------------------------------------

function drawLeft(): void {
  if (!tabbar || !leftContent) return;
  clear(tabbar);
  // Tabs only - the collapse toggles live on the CENTRE strip, which is
  // always wide enough. Two buttons here once pushed the OUTPUT tab clean
  // out of the 300px column.
  const mk = (tab: 'prompt' | 'output', label: string): HTMLElement => {
    const b = el('button', { class: 'tab' + (S.leftTab === tab ? ' on' : ''), text: label });
    b.addEventListener('click', () => {
      if (S.leftTab === tab) return;
      S.leftTab = tab;
      persistLeftTab();
      drawLeft();
    });
    return b;
  };
  tabbar.append(mk('prompt', '프롬프트'), mk('output', 'OUTPUT'));

  // A branch click rebuilds this column; focus comes back to the selected
  // row so Ctrl+C/X/V keep working (§1-35, as in the files tab).
  const hadFocus = leftContent.contains(document.activeElement);
  clear(leftContent);
  if (S.leftTab === 'output') {
    buildLeftOutput(leftContent);
  } else if (S.leftView === 'characters') {
    buildLeftChars(leftContent);
  } else {
    buildLeftPrompt(leftContent);
  }
  if (hadFocus) {
    const row = leftContent.querySelector<HTMLElement>('.treebranch.on') ?? leftContent;
    try { row.focus({ preventScroll: true }); } catch { /* test DOM */ }
  }
}

// --- the centre: tabs, and the modes that override them ---------------------------

function drawCentre(): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  clear(viewMount);

  // Entering any 검수 surface (the tab, the folder grid, the selector) or the
  // fragment organizer folds the chat once; leaving restores it unless the
  // user toggled meanwhile. Both are wide screens: a grid, or a list beside
  // an editor that was living on half the centre (§1-31).
  const inInspect = (S.centreMode === 'tab' && !S.selectedFile && S.centreTab === 'inspect')
    || S.centreMode === 'folder' || S.centreMode === 'selector' || S.centreMode === 'fragments';
  if (inInspect && !wasInspect && !panels.right) { autoRight = true; applyPanels(); }
  else if (!inInspect && wasInspect && autoRight) { autoRight = false; applyPanels(); }
  wasInspect = inInspect;

  // A card picked in a list: its editor, over everything - an editor is
  // always reachable, whatever the tabs are doing.
  if (S.selectedFile) {
    const area = areaOfPath(S.selectedFile);
    if (area === 'characters' && !/\.[a-z0-9]+$/i.test(S.selectedFile)) {
      drawCharacterEditor(S.selectedFile);
    } else if (S.selectedFile.endsWith('.md')) {
      drawCardEditor(S.selectedFile);
    } else if (area === 'scenes' && S.selectedFile.endsWith('.json') && !rawView.has(S.selectedFile)) {
      drawSceneEditor(S.selectedFile);
    } else {
      drawRawFile(S.selectedFile);
    }
    return;
  }

  if (S.centreMode === 'fragments') {
    drawFragments();
    return;
  }

  if (S.centreMode === 'folder' || S.centreMode === 'selector') {
    const node = find(S.selected);
    if (!node) {
      S.centreMode = 'tab';
    } else if (S.centreMode === 'folder') {
      drawFolder(node);
      return;
    } else {
      // The comparison selector - one button past the folder grid.
      if (!hasGroups(node.path)) {
        viewMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
        void loadGroups(node.path);
        return;
      }
      drawSelector(node);
      return;
    }
  }

  // The tabs: 1장 · 배치 · 검수 - a HORIZONTAL strip (never wraps into
  // a column), with the two panel-collapse toggles at its ends: the centre is
  // the one place always wide enough to hold them.
  const mk = (tab: typeof S.centreTab, label: string): HTMLElement => {
    const b = el('button', { class: 'tab' + (S.centreTab === tab ? ' on' : ''), text: label });
    b.addEventListener('click', () => {
      if (S.centreTab === tab) return;
      S.centreTab = tab;
      persistCentreTab();
      drawCentre();
    });
    return b;
  };
  viewMount.appendChild(el('div', { class: 'centretabs tabstrip' }, [
    mk('single', '1장'), mk('batch', '배치'), mk('inspect', '검수'),
  ]));
  const body = el('div', { class: 'centrebody' });
  viewMount.appendChild(body);
  if (S.centreTab === 'single') drawSingle(body);
  else if (S.centreTab === 'batch') drawBatch(body);
  else drawInspect(body);
}

/** 검수: the OUTPUT folder picked on the left, as the comparison selector.
 * The left column is held on OUTPUT while this tab shows (user). */
function drawInspect(body: HTMLElement): void {
  if (S.leftTab !== 'output') { S.leftTab = 'output'; persistLeftTab(); drawLeft(); }
  const node = S.selected && S.selected !== OUTPUT_ROOT ? find(S.selected) : null;
  if (!node) {
    const pick = el('button', { class: 'ghost tiny', text: '다른 폴더 열기…',
      title: 'OUTPUT 밖의 폴더(프로젝트 등)도 검수할 수 있습니다' });
    pick.addEventListener('click', () => openFolderPicker());
    body.appendChild(el('div', { class: 'empty' }, [
      el('div', { text: '왼쪽 OUTPUT 트리에서 검수할 폴더를 고르세요.' }),
      el('div', { class: 'row', style: { justifyContent: 'center', marginTop: '10px' } }, [pick]),
    ]));
    return;
  }
  if (!node.files.length && !node.children.length) {
    body.appendChild(el('div', { class: 'empty', text: `${node.path} — 비어 있습니다.` }));
    return;
  }
  if (!hasGroups(node.path)) {
    body.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    void loadGroups(node.path);
    return;
  }
  drawSelector(node);
}
