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
import { el, clear, ICON, iconBtn, pollWhileVisible } from './../dom';
import { evictBlob } from '../blobimg';
import { state } from '../../state';
import { threePane, showMobileCentre } from '../panes';
import { bindAgent, mountAgent } from '../agentpane';
import { CARD_AREAS, OUTPUT_ROOT, S, hub, areaOfPath, canonPath, checkUnresolved,
         persistLeftTab, persistCentreTab, buildOutput, buildExtras, extraPaths, addExtra,
         isOutputPath, find, msg, fetchLibrary, styleSync } from './store';
import { type FileListing } from '../../state';
import { transport } from '../../transport';
import { pollJob, loadJobs, markJobsStale } from './gen';
import { drawCardEditor, drawSceneEditor, drawRawFile, rawView } from './editors';
import { drawCharacterEditor } from './char-edit';
import { buildLeftPrompt, syncPromptBadges } from './left-prompt';
import { buildLeftChars } from './left-chars';
import { buildLeftOutput, openFolderPicker } from './left-output';
import { drawFragments } from './center-frags';
import { drawSingle, singleTick, syncControls, buildRunControls } from './center-single';
import { drawBatch, batchTick } from './center-batch';
import { buildStrip, stripTick, refreshStrip } from './strip';
import { drawFolder } from './center-folder';
import { hasGroups, loadGroups, drawSelector, setViewMode, setFocus, drawSelectedGallery, invalidateGroups, pollGroups } from './selector';
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
hub.studioShowing = () => wasStudioActive;

export function noteStudioLeft(): void {
  // Unsaved style edits stay in the column (it is not torn down on a tab
  // switch), but a reload would lose them: say so once on the way out.
  if (wasStudioActive && styleSync.dirty()) {
    notice(`스타일 ‘${styleSync.boundName()}’ 에 저장하지 않은 수정이 있습니다 — 에셋 스튜디오로 돌아가면 그대로 있지만, 새로고침하면 사라집니다.`, 'err');
  }
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

/* 검수 no longer folds the chat automatically (§1-43): the user found the
 * auto-fold in the way. Only the manual toggles on the tab row fold panels. */

let layBtnL: HTMLElement | null = null;
let layBtnR: HTMLElement | null = null;
/** The Anlas meter on the shell tab row (§1-50): always in view, refreshed
 * with every status read (a finished batch reads it again). */
let anlasBadge: HTMLElement | null = null;

function drawAnlas(): void {
  if (!anlasBadge) return;
  const acc = S.status?.account;
  if (!acc) {
    anlasBadge.textContent = S.status?.error ? 'Anlas ?' : 'Anlas …';
    anlasBadge.title = S.status?.error || 'NovelAI 잔량을 읽는 중입니다';
    anlasBadge.classList.remove('warn');
    return;
  }
  anlasBadge.textContent = `Anlas ${Number(acc.anlas).toLocaleString()}`;
  anlasBadge.title = `NovelAI Anlas 잔량 ${acc.anlas} · v5 사용량 ${acc.usagePercent ?? '?'}% · tier ${acc.tier ?? '?'} (배치가 끝날 때마다 다시 읽습니다)`;
  anlasBadge.classList.toggle('warn', Number(acc.anlas) < 200);
}

function applyPanels(): void {
  if (!splitRoot) return;
  splitRoot.classList.toggle('lcollapse', panels.left);
  splitRoot.classList.toggle('rcollapse', panels.right);
  reclamp(splitRoot);
  layBtnL?.classList.toggle('on', !panels.left);
  layBtnR?.classList.toggle('on', !panels.right);
}

function togglePanel(side: 'left' | 'right'): void {
  panels[side] = !panels[side];
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
  if (!anlasBadge) {
    anlasBadge = el('span', { class: 'badge anlasmeter', text: 'Anlas …' });
    anlasBadge.addEventListener('click', () => { void loadStatus(); });
    drawAnlas();
  }
  setLayoutControls(el('span', { class: 'row', style: { gap: '6px' } }, [anlasBadge, layBtnL, layBtnR]));
  applyPanels();
}

export function renderStudioTab(mount: HTMLElement): void {
  if (state.openStudioRequest) showMobileCentre();
  const entering = !wasStudioActive;
  wasStudioActive = true;
  ensureLayoutControls();
  if (!built || !mount.querySelector('.split')) {
    // A panel opened afresh draws the last library it saw on this device at
    // once (§1-90); the live read below patches whatever moved since.
    if (!S.libraryLoaded) primeFromCache();
    clear(mount);
    // The studio runs its own fold state (검수 auto-fold); no shared controls.
    const pane = threePane(undefined, { controls: false });
    splitRoot = pane.root;

    // The left column: [프롬프트 | OUTPUT] tabs over the content.
    tabbar = el('div', { class: 'studiotabs tabstrip' });
    leftContent = el('div', { class: 'tree filetree' });
    S.leftMount = leftContent;
    pane.left.append(tabbar, leftContent, el('div', {
      class: 'studio-run-footer', style: { flexShrink: '0', padding: '8px', borderTop: '1px solid var(--border)' },
    }, [buildRunControls()]));

    S.noticeMount = el('div');
    S.viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(S.noticeMount, S.viewMount);
    // Data held from an earlier build (the module outlives the DOM) draws
    // at once; a first visit draws the skeleton until the library lands.
    drawLeft();
    if (S.libraryLoaded) drawCentre();
    else S.viewMount.appendChild(el('div', { class: 'hint studioskelhint' }, [
      el('span', { class: 'spin' }), el('span', { text: ' 스튜디오를 불러오는 중입니다…' })]));
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
    // Paused while the page is hidden and skipped while another tab shows
    // (§1-55): a backgrounded phone used to keep asking every five seconds.
    pollWhileVisible(() => {
      // Files changed under us (the agent wrote a card, a batch landed) and
      // no render asked for a refresh: re-read now rather than on the next
      // tab visit (§1-39 "AI 로 수정한 뒤 표시 안 됨").
      // 검수 on screen: re-read its folder even while a batch runs (§1-48).
      if (S.centreMode === 'selector' || (S.centreMode === 'tab' && !S.selectedFile && S.centreTab === 'inspect')) void pollGroups();
      if (renderedRev !== state.filesRev && !S.jobId) { void refresh({ visit: false }); return; }
      // A job on screen whose poll is not running (it never survives a
      // page reload; a network error used to kill it): re-read the list,
      // which adopts, finishes or forgets it (§1-58).
      void loadJobs(true).then(() => hub.jobTick());
    }, 5000, () => wasStudioActive);
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
  drawAnlas();
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

// --- the library, remembered per backend (§1-90) ----------------------------------
const LIB_CACHE_KEY = 'hina.studioLibrary';

function primeFromCache(): void {
  try {
    const c = JSON.parse(localStorage.getItem(LIB_CACHE_KEY) || 'null') as
      { url?: string; lib?: { areas?: Record<string, unknown> } } | null;
    if (!c || c.url !== transport.config.url || !c.lib?.areas) return;
    const lib = c.lib as Awaited<ReturnType<typeof fetchLibrary>>;
    S.cards = Object.fromEntries(CARD_AREAS.map((a) => [a.area, lib.areas[a.area] ?? []]));
    cardsSig = JSON.stringify(S.cards);
    styleSync.prime(lib.activeStyle ?? null);
    S.libraryLoaded = true;
  } catch { /* no cache: the skeleton shows until the read lands */ }
}

function saveCache(lib: Awaited<ReturnType<typeof fetchLibrary>>): void {
  try {
    localStorage.setItem(LIB_CACHE_KEY, JSON.stringify({ url: transport.config.url,
      lib: { areas: S.cards, activeStyle: lib.activeStyle ?? null } }));
  } catch { /* quota or no storage: the cache is only a head start */ }
}

let refreshPending = false;
/** What the last drawn library / OUTPUT looked like: a background re-read
 * that brings the same data back redraws nothing (§1-90). */
let cardsSig = '';
let outputSig = '';

/** The OUTPUT views that depend on the listing (the prompt tab does not). */
function centreShowsOutput(): boolean {
  if (S.selectedFile) return false;
  return S.centreMode === 'folder' || S.centreMode === 'selector'
    || (S.centreMode === 'tab' && S.centreTab === 'inspect');
}

/**
 * Re-read the library and draw it - once per part, and only what changed.
 *
 * §1-90 (field report: "로컬인데도 왼쪽 패널이 한참 빈 채로 있다가 두두두
 * 생겨남"): the left column waited for FIVE requests (four card lists and the
 * whole OUTPUT tree, which the 프롬프트 tab does not even show), then drew,
 * then read the active style's file and filled the prompt in a second step.
 * Now the cards and the style's text come in one /studio/library answer, the
 * OUTPUT listing and pinned folders run beside it, and the 프롬프트 tab draws
 * the moment its own data is in. Coming back to the tab keeps the drawn
 * column and patches it only if the re-read differs.
 */
async function refresh(opts: { visit?: boolean } = {}): Promise<void> {
  // A visit (entering the tab, or a caller asking outright) also re-reads
  // the 검수 groups, whose selection files the OUTPUT listing does not show;
  // the background poll only redraws what its listing says moved.
  const visit = opts.visit !== false;
  // Never rebuild the studio under the user's caret (§1-50): an agent batch
  // bumps filesRev per image, and each bump used to redraw both columns -
  // the prompt being typed lost focus and caret every few seconds. The
  // refresh waits for blur.
  const ae = document.activeElement as HTMLElement | null;
  if (!state.openStudioRequest && ae && splitRoot && splitRoot.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName)) {
    if (!refreshPending) {
      refreshPending = true;
      ae.addEventListener('blur', () => { refreshPending = false; void refresh(opts); }, { once: true });
    }
    return;
  }
  renderedRev = state.filesRev;
  // The agent (or a batch strip in the chat, or the files tab) asked for
  // 검수 on a folder. One outside OUTPUT gets pinned first (§1-33), so its
  // listing rides with the others.
  const want = state.openStudioRequest;
  const wantFolder = want ? canonPath(want.folder) : '';
  if (wantFolder && !isOutputPath(wantFolder)) addExtra(wantFolder);

  // All three in flight at once; each part draws when it lands.
  const outP: Promise<FileListing | Error> = state.files(OUTPUT_ROOT)
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))));
  const extrasP = loadExtras();

  let libChanged = false;
  try {
    const lib = await fetchLibrary();
    // A failed area keeps the list it had (§1-78): replacing it with [] is
    // what made a list "fly away" under a slow or timed-out request.
    const next = Object.fromEntries(CARD_AREAS.map((a) => [a.area, lib.areas?.[a.area] ?? S.cards[a.area] ?? []]));
    const sig = JSON.stringify(next);
    S.cards = next;
    const styleChanged = styleSync.prime(lib.activeStyle ?? null);
    libChanged = !S.libraryLoaded || sig !== cardsSig || styleChanged;
    cardsSig = sig;
    S.libraryLoaded = true;
    S.libraryError = '';
    saveCache(lib);
    if (await migrateSingleStyle()) libChanged = true;
  } catch (e) {
    if (!S.libraryLoaded) {
      S.libraryError = msg(e);
      drawLeft();
      if (S.viewMount) {
        clear(S.viewMount);
        S.viewMount.appendChild(el('div', { class: 'notice err' }, [
          el('div', { text: '스튜디오 라이브러리를 읽지 못했습니다.' }),
          el('div', { class: 'hint', text: msg(e) }),
          el('div', { class: 'hint', text: '설정 → 연결에서 백엔드 상태를 확인해 주세요.' }),
        ]));
      }
      return;
    }
    // Keep showing what we had; the next visit or poll tries again.
  }
  if (libChanged && !want) {
    if (S.leftTab !== 'output') drawLeft();
    if (!centreShowsOutput() || S.outputLoaded) drawCentre();
  }

  const out = await outP;
  const extrasChanged = await extrasP;
  let outChanged = extrasChanged;
  if (out instanceof Error) {
    if (!S.outputLoaded) notice('OUTPUT 목록을 읽지 못했습니다: ' + out.message, 'err');
  } else {
    const sig = JSON.stringify(out.areas);
    if (!S.outputLoaded || sig !== outputSig) outChanged = true;
    outputSig = sig;
    S.listing = out;
  }
  const firstOutput = !S.outputLoaded;
  S.outputLoaded = true;
  if (outChanged || firstOutput) buildOutput();
  if (outChanged || firstOutput || visit) invalidateGroups();
  if (want) {
    state.openStudioRequest = null;
    const folder = wantFolder;
    if (find(folder)) {
      // The chat's 검수 asks for the flat view - every image with its flags.
      if (want.view) setViewMode(want.view);
      // The batch's own images (§1-62): straight into their group.
      if (want.focus?.length) setFocus(folder, want.focus);
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
    drawLeft();
    drawCentre();
  } else {
    if (S.leftTab === 'output' && (outChanged || firstOutput || libChanged)) drawLeft();
    if (centreShowsOutput() && (outChanged || firstOutput || libChanged || visit)) drawCentre();
  }
  if (libChanged) checkUnresolved();
  markJobsStale();
  void refreshStrip();
  if (S.jobId) void pollJob();
}

/** The pinned folders' own listings (one request each; usually zero or one).
 * True when what they hold changed since the last read. */
let extrasSig = '';
async function loadExtras(): Promise<boolean> {
  const pairs = await Promise.all(extraPaths.map(async (p) => {
    try { return [p, await state.files(p)] as const; } catch { return [p, null] as const; }
  }));
  const sig = JSON.stringify(pairs.map(([p, l]) => [p, l?.areas ?? null]));
  if (sig === extrasSig) return false;
  extrasSig = sig;
  buildExtras(Object.fromEntries(pairs));
  for (const p of extraPaths) S.open.add(p);
  return true;
}

/** The dropdown means ONE style. Cards written before the dropdown could have
 * several enabled; the first (order, path) stays on and the rest are turned
 * off, said out loud once. */
let migrated = false;
async function migrateSingleStyle(): Promise<boolean> {
  const on = (S.cards.styles ?? [])
    .filter((i) => i.enabled)
    .sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
  if (on.length <= 1) return false;
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
  return true;
}

/** Tell the files tab about a studio write without re-reading our own world:
 * touchFiles bumps filesRev by one, and pre-advancing renderedRev keeps the
 * guard in renderStudioTab from turning that bump back into a full refresh. */
function touchQuiet(paths: string[] = []): void {
  renderedRev = state.filesRev + 1;
  // A batch that rewrote files under existing names must not keep showing
  // the old thumbnails (§1-42).
  if (paths.length) {
    evictBlob(paths);
    state.touchFiles(paths);   // new outputs badge the files tab: that needs the emit
  } else {
    state.touchFilesQuiet();   // a card save: no panel-wide emit (§1-78)
  }
}

/** Re-read ONE card area after a save - a card edit cannot change the output
 * tree or the other areas, so one listing call replaces the old five.
 *
 * `keepEditor` (§1-78): the save came from an open card editor, which already
 * shows what was saved. Rebuilding it re-read the card and its reference
 * images, and the column jumped - so the list data refreshes, and only the
 * views that are NOT that editor redraw. */
async function refreshArea(area: string, opts: { keepEditor?: boolean } = {}): Promise<void> {
  try {
    S.cards[area] = (await state.studio.items(area)).items;
  } catch { /* keep what we have; the next full refresh corrects it */ }
  const editorLeft = area === 'characters' && S.leftView === 'characters' && !!S.charOpen && S.leftTab !== 'output';
  const editorCentre = !!S.selectedFile && areaOfPath(S.selectedFile) === area;
  if (!(opts.keepEditor && editorLeft)) drawLeft();
  if (!(opts.keepEditor && editorCentre)) drawCentre();
  else syncPromptBadges();
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

let leftRedrawPending = false;

function drawLeft(): void {
  if (!tabbar || !leftContent) return;
  // A batch lands a file every few seconds and each one re-renders the tab;
  // rebuilding the prompt editor under the caret ate keystrokes and read as
  // "입력이 계속 리셋됨" (§1-49). While a field in this column has focus the
  // redraw waits for blur.
  const ae = document.activeElement as HTMLElement | null;
  if (ae && leftContent.contains(ae) && /^(TEXTAREA|INPUT|SELECT)$/.test(ae.tagName)) {
    if (!leftRedrawPending) {
      leftRedrawPending = true;
      ae.addEventListener('blur', () => { leftRedrawPending = false; drawLeft(); }, { once: true });
    }
    return;
  }
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
  // Nothing to draw yet: a skeleton with a spinner, not an empty column
  // (§1-90) - and the real content replaces it in one go.
  const waiting = S.leftTab === 'output' ? !S.outputLoaded : !S.libraryLoaded;
  if (waiting) {
    leftContent.appendChild(skeleton(S.libraryError));
    return;
  }
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

function skeleton(error: string): HTMLElement {
  if (error) {
    return el('div', { class: 'studioskel' }, [
      el('div', { class: 'hint err', text: '스튜디오 라이브러리를 읽지 못했습니다: ' + error }),
    ]);
  }
  const bars = [70, 100, 100, 55, 85, 85].map((w) =>
    el('div', { class: 'skelrow', style: { width: w + '%' } }));
  return el('div', { class: 'studioskel', 'aria-busy': 'true' }, [
    el('div', { class: 'row hint skelhead' }, [el('span', { class: 'spin' }), el('span', { text: '불러오는 중…' })]),
    ...bars,
  ]);
}

// --- the centre: tabs, and the modes that override them ---------------------------

function drawCentre(): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  clear(viewMount);

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
  // A selected/ folder shows what was chosen, not the selector again (§1-40).
  if (/\/selected$/.test(node.path)) {
    const keep = S.viewMount;
    S.viewMount = body;
    try { drawSelectedGallery(node); } finally { S.viewMount = keep; }
    return;
  }
  if (!hasGroups(node.path)) {
    body.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    void loadGroups(node.path);
    return;
  }
  drawSelector(node);
}
