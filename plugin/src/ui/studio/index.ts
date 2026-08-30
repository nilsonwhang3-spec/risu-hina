/**
 * 에셋 스튜디오 - the image library, and the one tab that is not about a bot.
 *
 * Every other tab edits the bot RisuAI has open. This one edits a library that
 * outlives any of them: you generate images, sort them, and only then decide
 * which bot gets them. So it renders with **no bot selected at all** - the
 * shell already survives that state (readHost only sets slotError), and it is
 * the per-tab render functions that bail. This one does not.
 *
 *   left    the prompt CARDS (styles · characters · presets · fragments), the
 *           output tree, and the generation card. A style or a character is a
 *           card with its own on/off and order - the lorebook model - and the
 *           ACTIVE cards are what a run sends.
 *   centre  the picked card's editor, or the picked output folder: for images
 *           that is the comparison selector, otherwise a list.
 *   right   Hina, as on every tab
 *
 * The library is the `studio/` folder of the ONE global space, so its files
 * ride the shared file methods on `state` with space-rooted paths; only the
 * domain calls (NovelAI, batches, the selector) live on `state.studio`.
 *
 * A bot IS needed to *adopt* an image into a card - that is gated per action,
 * where it is true, rather than on the whole tab.
 *
 * This file owns the tab lifecycle, the left card lists and output tree, and
 * the centre dispatch; the pieces live in the sibling modules (store, gen,
 * editors, char-edit, selector) wired together through the store's hub.
 */
import { el, clear, armed } from './../dom';
import { state, type StudioItem, type WorkspaceFile } from '../../state';
import { threePane } from '../panes';
import { bindAgent, mountAgent } from '../agentpane';
import { listRow as kitRow } from '../kit';
import { CARD_AREAS, OUTPUT_ROOT, IMAGE_RE, S, hub, checkUnresolved,
         cardStem, freeCardPath, buildOutput, find, countFiles, fmtSize, msg,
         type Folder } from './store';
import { drawGen, drawQueue } from './gen';
import { drawCardEditor, drawSceneEditor, drawRawFile, rawView } from './editors';
import { drawCharacterEditor } from './char-edit';
import { hasGroups, loadGroups, drawSelector } from './selector';

let built = false;
/** The filesRev this tab last drew. While the tab stays active, an unrelated
 * state emit no longer triggers the five-request library re-read. */
let renderedRev = -1;
/** Whether the previous render was already this tab: coming BACK is still a
 * deliberate visit and re-reads (files can arrive from another machine, which
 * bumps no rev here); staying put does not. */
let wasStudioActive = false;

/** shell.setTab tells us when the user goes elsewhere - there is no emit on a
 * tab switch, so the "came back" signal has to be handed over explicitly. */
export function noteStudioLeft(): void {
  wasStudioActive = false;
}

export function renderStudioTab(mount: HTMLElement): void {
  const entering = !wasStudioActive;
  wasStudioActive = true;
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    S.cardsMount = el('div', { class: 'tree filetree' });
    S.treeMount = el('div', { class: 'tree filetree' });
    S.genMount = el('div', { class: 'genpanel' });
    pane.left.append(S.cardsMount, S.treeMount, S.genMount);
    S.noticeMount = el('div');
    S.viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(S.noticeMount, S.viewMount);
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
    drawCards();
    drawTree();
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
  buildOutput();
  drawCards();
  drawTree();
  drawCentre();
  checkUnresolved();
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
  drawCards();
  drawCentre();
  drawGen();
  checkUnresolved();
  touchQuiet();
}

// The hub: what the sibling modules call to reach back into this file (and
// gen.ts) without an import cycle. Registered at module load, before any
// render can run.
hub.drawCards = drawCards;
hub.drawTree = drawTree;
hub.drawGen = drawGen;
hub.drawCentre = drawCentre;
hub.notice = notice;
hub.refresh = refresh;
hub.refreshArea = refreshArea;
hub.loadStatus = loadStatus;
hub.touchQuiet = touchQuiet;

// --- the card lists -------------------------------------------------------------

// Which card sections are folded. Fragments especially grow into the dozens,
// and four always-open lists made the left column a scroll hunt.
const SECT_KEY = 'hina.studioSections';
let sectOpen: Record<string, boolean> = {};
try { sectOpen = JSON.parse(localStorage.getItem(SECT_KEY) || '{}') as Record<string, boolean> || {}; }
catch { /* storage may be unavailable in the iframe */ }
function sectionOpen(area: string): boolean {
  return sectOpen[area] !== false;
}
function toggleSection(area: string): void {
  sectOpen[area] = !sectionOpen(area);
  try { localStorage.setItem(SECT_KEY, JSON.stringify(sectOpen)); } catch { /* fine */ }
  drawCards();
}

function drawCards(): void {
  const cardsMount = S.cardsMount;
  if (!cardsMount) return;
  clear(cardsMount);
  for (const spec of CARD_AREAS) {
    const rows = S.cards[spec.area] ?? [];
    const openNow = sectionOpen(spec.area);
    const head = el('div', { class: 'row secthead', style: { padding: '4px 6px 0', cursor: 'pointer' },
                            title: openNow ? '접기' : '펼치기' }, [
      el('span', { class: 'hint', text: openNow ? '▾' : '▸' }),
      el('span', { class: 'sectiontitle grow', text: spec.label }),
      el('span', { class: 'hint', text: String(rows.length) }),
    ]);
    head.addEventListener('click', () => toggleSection(spec.area));
    if (spec.area === 'fragments' && S.unresolvedRefs.length) {
      head.appendChild(el('span', {
        class: 'badge err', text: `미해결 ${S.unresolvedRefs.length}`,
        title: '프롬프트가 참조하는데 조각이 없는 이름: ' + S.unresolvedRefs.join(', '),
      }));
    }
    const add = el('button', { class: 'ghost tiny', text: '＋', title: '새 카드' });
    add.addEventListener('click', (e) => { e.stopPropagation(); void newCard(spec.area); });
    head.appendChild(add);
    cardsMount.appendChild(head);

    if (!openNow) continue;
    if (!rows.length) {
      cardsMount.appendChild(el('div', { class: 'hint', style: { padding: '0 10px 4px' }, text: '(없음)' }));
      continue;
    }
    const sorted = [...rows].sort((a, b) =>
      ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
    for (const it of sorted) cardsMount.appendChild(cardRow(spec, it));
  }
  cardsMount.appendChild(el('div', {
    class: 'sectionline treesep',
    title: '위는 쓰는 것(프롬프트·프리셋), 아래는 나온 것(생성물)입니다',
  }));
}

function cardRow(spec: { area: string; toggle: boolean }, it: StudioItem): HTMLElement {
  const badges: { text: string; kind?: 'ok' | 'warn' | 'err' | '' ; title?: string }[] = [];
  if (spec.area === 'characters') {
    if (it.vibe) badges.push({ text: `바이브 ${it.vibe}`, title: '레퍼런스 사용 시 이 카드의 바이브가 실립니다' });
    if (it.charref) badges.push({ text: `레퍼런스 ${it.charref}` });
  }
  if (it.count) badges.push({ text: `씬 ${it.count}` });
  if (spec.toggle && !it.enabled) badges.push({ text: '꺼짐' });

  const row = kitRow({
    variant: 'pick',
    selected: S.selectedFile === it.path,
    title: it.name || it.path.split('/').pop() || it.path,
    hint: it.description || undefined,
    badges,
    toggle: spec.toggle ? {
      checked: !!it.enabled,
      title: '켜면 생성 요청에 이 카드가 실립니다 (순서대로 이어집니다)',
      onChange: async (v) => {
        try {
          await state.studio.setMeta(it.path, { enabled: v });
        } catch (e) {
          notice('바꾸지 못했습니다: ' + msg(e), 'err');
          throw e;
        }
        // One meta write changed one row: update it in memory and redraw,
        // instead of the full five-request library re-read per checkbox.
        it.enabled = v;
        drawCards();
        drawGen();
        checkUnresolved();
        touchQuiet();
      },
    } : undefined,
    onClick: () => {
      S.selectedFile = it.path;
      drawCards();
      drawCentre();
    },
  });
  if (spec.toggle && typeof it.order === 'number' && it.order !== 100) {
    row.appendChild(el('span', { class: 'hint ordertag', title: '연결 순서 (order)', text: String(it.order) }));
  }
  return row;
}

async function newCard(area: string): Promise<void> {
  // The name comes first: it is the reference key (fragments), the list row,
  // and the filename - a timestamp slug was a code nobody could read back.
  const raw = window.prompt('새 카드 이름');
  const nm = (raw ?? '').trim();
  if (!nm) return;
  const stem = cardStem(nm);
  if (!stem) { notice('그 이름으로는 파일을 만들 수 없습니다.', 'err'); return; }
  try {
    if (area === 'characters') {
      const path = freeCardPath(area, stem, '');
      await state.uploadFile('prompt.md', `---\nname: ${nm}\nenabled: false\n---\n## 프롬프트\n`,
        false, path);
      S.selectedFile = path;
    } else if (area === 'scenes') {
      const path = freeCardPath(area, stem, '.json');
      await state.uploadFile(path.split('/').pop()!, JSON.stringify(
        { version: 1, name: nm, scenes: [{ name: 'happy', prompt: '', negativePrompt: '', width: 0, height: 0 }] },
        null, 2), false, 'studio/scenes');
      S.selectedFile = path;
    } else {
      const path = freeCardPath(area, stem, '.md');
      const front = area === 'styles'
        ? `---\nname: ${nm}\nenabled: false\n---\n`
        : `---\nname: ${nm}\n---\n`;
      await state.uploadFile(path.split('/').pop()!, front, false, `studio/${area}`);
      S.selectedFile = path;
    }
    await refreshArea(area);
  } catch (e) {
    notice('만들지 못했습니다: ' + msg(e), 'err');
  }
}

// --- the output tree --------------------------------------------------------------

function drawTree(): void {
  if (!S.treeMount) return;
  clear(S.treeMount);
  if (S.outputRoot) S.treeMount.appendChild(row(S.outputRoot, 0));
}

function row(n: Folder, depth: number): HTMLElement {
  const wrap = el('div');
  const isOpen = S.open.has(n.path);
  const kids = n.children.length > 0;
  const caret = el('span', { class: 'caret', text: kids ? (isOpen ? '▾' : '▸') : '' });
  const line = el('button', {
    class: 'treerow' + (S.selected === n.path && !S.selectedFile ? ' on' : ''),
    style: { paddingLeft: 6 + depth * 12 + 'px' },
    title: n.path,
  }, [
    caret,
    el('span', { class: 'grow', text: n.name }),
    el('span', { class: 'n', text: String(countFiles(n)) }),
  ]);
  line.addEventListener('click', () => {
    if (kids) { if (isOpen) S.open.delete(n.path); else S.open.add(n.path); }
    S.selected = n.path;
    S.selectedFile = '';
    drawCards();
    drawTree();
    drawCentre();
  });
  wrap.appendChild(line);
  if (isOpen) for (const c of n.children) wrap.appendChild(row(c, depth + 1));
  return wrap;
}

// --- the centre: editors, the selector, folders ---------------------------------

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

  // A card picked in the list: its editor, not the folder it lives in.
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
