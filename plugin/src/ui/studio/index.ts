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
 *           generation card. OUTPUT: the studio/images tree. Both rails
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
import { el, clear, armed } from './../dom';
import { state, type StudioItem, type WorkspaceFile } from '../../state';
import { threePane } from '../panes';
import { bindAgent, mountAgent } from '../agentpane';
import { CARD_AREAS, OUTPUT_ROOT, IMAGE_RE, S, hub, checkUnresolved, persistLeftTab,
         buildOutput, find, fmtSize, msg, type Folder } from './store';
import { drawGen, drawQueue } from './gen';
import { drawCardEditor, drawSceneEditor, drawRawFile, rawView } from './editors';
import { drawCharacterEditor } from './char-edit';
import { buildLeftPrompt, syncPromptBadges } from './left-prompt';
import { buildLeftChars } from './left-chars';
import { buildLeftOutput } from './left-output';
import { drawFragments } from './center-frags';
import { hasGroups, loadGroups, drawSelector } from './selector';

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

function applyPanels(): void {
  if (!splitRoot) return;
  splitRoot.classList.toggle('lcollapse', panels.left);
  splitRoot.classList.toggle('rcollapse', panels.right);
}

function togglePanel(side: 'left' | 'right'): void {
  panels[side] = !panels[side];
  try { localStorage.setItem(PANELS_KEY, JSON.stringify(panels)); } catch { /* fine */ }
  applyPanels();
}

function rail(side: 'left' | 'right'): HTMLElement {
  const openBtn = el('button', { class: 'ghost tiny', text: side === 'left' ? '▸' : '◂',
                                 title: side === 'left' ? '왼쪽 패널 펼치기' : 'AI 챗 펼치기' });
  openBtn.addEventListener('click', () => togglePanel(side));
  return el('div', { class: 'panelrail ' + (side === 'left' ? 'lrail' : 'rrail') }, [
    openBtn,
    el('span', { class: 'vlabel', text: side === 'left' ? '프롬프트 · OUTPUT' : 'AI 챗' }),
  ]);
}

export function renderStudioTab(mount: HTMLElement): void {
  const entering = !wasStudioActive;
  wasStudioActive = true;
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    splitRoot = pane.root;

    // The left column: [프롬프트 | OUTPUT] tabs over the content, the
    // generation card pinned under it.
    tabbar = el('div', { class: 'studiotabs' });
    leftContent = el('div', { class: 'tree filetree' });
    S.leftMount = leftContent;
    S.genMount = el('div', { class: 'genpanel' });
    pane.left.append(tabbar, leftContent, S.genMount);

    S.noticeMount = el('div');
    S.viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(S.noticeMount, S.viewMount);

    // Collapse rails: shown by the lcollapse/rcollapse classes.
    pane.root.insertBefore(rail('left'), pane.left);
    pane.root.appendChild(rail('right'));
    applyPanels();

    mount.appendChild(pane.root);
    built = true;
    void refresh();
    void loadStatus();
  } else if (entering || renderedRev !== state.filesRev) {
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
  drawGen();
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!S.noticeMount) return;
  clear(S.noticeMount);
  S.noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (S.noticeMount) clear(S.noticeMount); }, 8000);
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
  drawLeft();
  drawGen();
  drawCentre();
  checkUnresolved();
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
  drawGen();
  checkUnresolved();
  touchQuiet();
}

// The hub: what the sibling modules call to reach back into this file (and
// gen.ts) without an import cycle. Registered at module load, before any
// render can run.
hub.drawLeft = drawLeft;
hub.drawGen = drawGen;
hub.drawCentre = drawCentre;
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
  const mk = (tab: 'prompt' | 'output', label: string): HTMLElement => {
    const b = el('button', { class: 'modebtn' + (S.leftTab === tab ? ' on' : ''), text: label });
    b.addEventListener('click', () => {
      if (S.leftTab === tab) return;
      S.leftTab = tab;
      persistLeftTab();
      drawLeft();
    });
    return b;
  };
  const collapse = el('button', { class: 'ghost tiny railbtn', text: '◂', title: '왼쪽 패널 접기' });
  collapse.addEventListener('click', () => togglePanel('left'));
  const collapseR = el('button', { class: 'ghost tiny railbtn', text: '▸', title: 'AI 챗 패널 접기' });
  collapseR.addEventListener('click', () => togglePanel('right'));
  tabbar.append(mk('prompt', '프롬프트'), mk('output', 'OUTPUT'),
                el('span', { class: 'grow' }), collapse, collapseR);

  clear(leftContent);
  if (S.leftTab === 'output') {
    buildLeftOutput(leftContent);
  } else if (S.leftView === 'characters') {
    buildLeftChars(leftContent);
  } else {
    buildLeftPrompt(leftContent);
  }
  // The generation card belongs to the 프롬프트 tab's main view; the character
  // view and the tree want the column.
  if (S.genMount) S.genMount.style.display = (S.leftTab === 'prompt' && S.leftView === 'main') ? '' : 'none';
}

// --- the centre: editors, the organizer, the selector, folders --------------------

function drawCentre(): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  clear(viewMount);

  // A running (or just-inspected) batch owns the centre until dismissed:
  // "what is it doing right now" is the question the moment 생성 시작 lands.
  if (S.queueView) {
    drawQueue();
    return;
  }

  if (S.fragmentsView) {
    drawFragments();
    return;
  }

  // A card picked in a list: its editor, not the folder it lives in.
  if (S.selectedFile) {
    const parts = S.selectedFile.split('/');
    if (parts[1] === 'characters' && !/\.[a-z0-9]+$/i.test(S.selectedFile)) {
      drawCharacterEditor(S.selectedFile);
    } else if (S.selectedFile.endsWith('.md')) {
      drawCardEditor(S.selectedFile);
    } else if (parts[1] === 'scenes' && S.selectedFile.endsWith('.json') && !rawView.has(S.selectedFile)) {
      drawSceneEditor(S.selectedFile);
    } else {
      drawRawFile(S.selectedFile);
    }
    return;
  }

  const node = find(S.selected);
  if (!node) {
    viewMount.appendChild(el('div', { class: 'empty', text: '폴더를 골라 주세요.' }));
    return;
  }

  viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    el('span', { class: 'sectiontitle grow', text: node.path }),
    el('span', { class: 'hint', text: `파일 ${node.files.length} · 하위 폴더 ${node.children.length}` }),
    newFolderButton(node),
  ]));

  if (!node.files.length && !node.children.length) {
    viewMount.appendChild(el('div', { class: 'empty', text: '아직 생성물이 없습니다. 이미지를 여기에 넣거나 히나에게 생성을 부탁하세요.' }));
    return;
  }

  // Under images/, comparing is the job, so the selector replaces the plain
  // grid: candidates are looked at against each other, not browsed.
  if (node.files.some((f) => IMAGE_RE.test(f.name))) {
    if (!hasGroups(node.path)) {
      viewMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
      void loadGroups(node.path);
      return;
    }
    drawSelector(node);
    return;
  }

  const list = el('div', { class: 'filelist' });
  for (const f of node.files) list.appendChild(fileRow(f));
  viewMount.appendChild(list);
}

function newFolderButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '＋ 폴더' }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    const name = (prompt('새 폴더 이름', '') || '').trim();
    if (!name) return;
    b.disabled = true;
    void state.mkdirFile(node.path + '/' + name)
      .then(() => { S.open.add(node.path); touchQuiet(); return refresh(); })
      .catch((e) => notice('폴더를 만들지 못했습니다: ' + msg(e), 'err'))
      .finally(() => { b.disabled = false; });
  });
  return b;
}

function fileRow(f: WorkspaceFile): HTMLElement {
  const del = el('button', { class: 'ghost tiny', title: '삭제' }) as HTMLButtonElement;
  const rowEl = el('div', { class: 'chatitem' }, [
    el('span', { class: 'grow', text: f.name }),
    el('span', { class: 'n', text: fmtSize(f.size) }),
    del,
  ]);
  armed(del, '✕', '삭제 확인', async () => {
    del.disabled = true;
    try {
      await state.deleteFile(f.path);
      touchQuiet();
      await refresh();
    } catch (e) {
      del.disabled = false;
      notice('지우지 못했습니다: ' + msg(e), 'err');
    }
  });
  return rowEl;
}
