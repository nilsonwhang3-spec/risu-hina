/**
 * The file view - the ONE global space as a file browser.
 *
 *   left     folders only: the areas (프로젝트 · 스튜디오 · AI 작업) and the
 *            folders inside them, as a tree. Selecting one lists it.
 *   centre   what the selected folder holds - a list (name · size · time), or
 *            a grid of thumbnails when the folder is pictures. Selection with
 *            click / Ctrl / Shift / checkboxes; Delete deletes, Enter opens,
 *            files dropped anywhere on it are uploaded into that folder.
 *   right    the agent, as on every tab.
 *
 * The space is shared by every bot (that is the point), so this tab renders
 * with no bot selected at all; only 정리 - a per-bot verb - needs one.
 *
 * It used to be one tree with every file in it, which read fine at ten files
 * and fell apart at a folder of three hundred assets: no way to pick several,
 * no way to see them, one download button per file. Folder tree plus list is
 * what every file manager does, and the reason is that it scales.
 *
 * A document the agent left in its scratch/scripts folders is a deliverable
 * that landed in the wrong place, not an internal file: those get a virtual
 * folder (임시 문서) so they are visible without digging through hina/.
 *
 * Bulk transfer: several files or a folder come down as one zip built on the
 * backend (POST /files/zip); a dropped folder goes up file by file into the
 * matching subfolders; a dropped .zip is offered to be unpacked on arrival.
 */
import { el, clear, armed, menuAt, popover, svg, type ArmedControl } from './dom';
import { treeRow, installDrop, installDrag, type TreeNode, type TreeSpec, type Incoming } from './tree';
import { state, type FileArea, type FileListing, type WorkspaceFile } from '../state';
import { makeTab, namePopover, type NoticeKind, type TabUi } from './kit';
import { blobUrl, workspaceImage } from './blobimg';
import { renderMarkdown } from './markdown';
import { showArtifact } from './artifact';
import { copyToClipboard } from '../host';
import { clientLog } from '../transport';

const AREA_LABEL: Record<string, [string, string]> = {
  projects: ['프로젝트', '직접 관리하시는 참고 자료·프로젝트 폴더입니다. 봇 이름 폴더로 나뉩니다.'],
  studio: ['스튜디오', '이미지 라이브러리입니다. config/ 에 프롬프트 재료, output/ 에 생성 결과가 삽니다.'],
  hina: ['AI 작업', '히나가 봇별로 쓰는 스크립트·임시·산출물 폴더입니다.'],
  '.hina': ['내부', '스킬 복사본과 이관 기록입니다. 다음 실행 때 다시 만들어집니다.'],
};

/** Every visible area is the user's now - the space is one shared tree. */
const USER_AREAS = new Set(['projects', 'studio', 'hina']);
/** The AI work area whose document-like files are surfaced anyway. */
const SURFACE_FROM = new Set(['hina']);
const DOCUMENT_EXT = new Set([
  'md', 'markdown', 'txt', 'html', 'htm', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'rtf', 'pdf', 'docx',
]);
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT_UPLOAD_RE = /\.(md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i;
/** The virtual folder of surfaced documents. */
const DOCS_NODE = '@docs';

// Filebar glyphs: inline SVG, never emoji - the picture glyphs rendered as
// stray letters on a machine without a colour emoji font (same reason the
// rows carry extension tags instead of pictograms).
const FICON = {
  selectAll: svg('<path d="m2 13 4 4L14 7"/><path d="m10 15 3 3 9-11"/>', 15),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>', 15),
  grid: svg('<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>', 15),
  move: svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 10v7"/><path d="m9 14 3 3 3-3"/>', 15),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 15),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>', 15),
};

/** The internal clipboard for the context menu's 복사/잘라내기 → 붙여넣기.
 * Paths only - the bytes stay on the backend (files/copy · files/move). */
let clipboard: { op: 'copy' | 'cut'; paths: string[] } | null = null;

function isDocument(f: WorkspaceFile): boolean {
  const ext = (f.name.split('.').pop() || '').toLowerCase();
  return ext !== f.name.toLowerCase() && DOCUMENT_EXT.has(ext);
}

/** One folder in the tree. */
interface Folder {
  path: string;
  name: string;
  area: FileArea;
  kids: Folder[];
  files: WorkspaceFile[];
  /** A surfaced-documents node: listing only, nothing is writable there. */
  virtual?: boolean;
}

let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let showInternal = false;
let lastListing: FileListing | null = null;
let nodes = new Map<string, Folder>();
let selectedDir = 'projects';
let selection = new Set<string>();
/** The row clicked last, for Shift ranges. */
let anchorPath = '';
let previewPath = '';
/** The 삭제 button's two-step confirm; the Delete key drives the same one. */
let delCtrl: ArmedControl | null = null;
let filterText = '';
let view: 'list' | 'grid' = 'list';
try { if (localStorage.getItem('hina.filesView') === 'grid') view = 'grid'; } catch { /* iframe */ }
const expanded = new Set<string>(['projects', 'studio']);
let ui: TabUi | null = null;

function notice(text: string, kind: NoticeKind = ''): void {
  ui?.notice(text, kind);
}

const kitRender = makeTab({
  // A pending open-request is a staleness key: consuming it is refresh's job.
  keys: () => [state.filesRev, state.openFileRequest],
  // Deliberately no menu-line search: the folder filter is a fold-out icon on
  // the filebar itself (the full-width box spent a whole row on a field that
  // is empty almost always - field report item 14).
  build(pane, u) {
    ui = u;
    treeMount = el('div', { class: 'tree filetree' });
    pane.left.appendChild(treeMount);
    viewMount = el('div', { class: 'pad filepad' });
    pane.centre.appendChild(viewMount);
    installDrop(viewMount, { into: () => uploadTarget(), onFiles: (path, files) => void uploadMany(files, path) });
  },
  async refresh() {
    await refresh();
  },
});

export function renderFilesTab(mount: HTMLElement): void {
  kitRender(mount);
  state.markOutputsSeen();
}

async function refresh(): Promise<void> {
  if (!treeMount) return;
  try {
    const data = await state.files();
    lastListing = data;
    buildNodes(data);
    if (!nodes.has(selectedDir)) selectedDir = nodes.has('projects') ? 'projects' : (nodes.keys().next().value ?? '');
    // Selection survives a refresh only for paths that still exist.
    const alive = new Set(allPaths());
    selection = new Set([...selection].filter((p) => alive.has(p)));
    // A log line in the agent panel asked for this file: go to its folder
    // and open it.
    const want = state.openFileRequest;
    if (want) {
      state.openFileRequest = null;
      const dir = want.includes('/') ? want.slice(0, want.lastIndexOf('/')) : want;
      if (nodes.has(dir)) { selectedDir = dir; expandTo(dir); }
      previewPath = want;
      selection = new Set([want]);
    }
    drawTree();
    drawCentre();
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    // With the stack: the one report of this was a bare "reading 'filter'",
    // which named the symptom (a non-JSON body) and not the cause.
    void clientLog('error', 'files tab refresh failed', {
      error: msg(e), stack: e instanceof Error ? String(e.stack).slice(0, 1500) : '',
    });
  }
}

// --- the folder model ----------------------------------------------------------

function buildNodes(data: FileListing): void {
  nodes = new Map();
  const shown = data.areas.filter((a) => showInternal || USER_AREAS.has(a.area));
  for (const area of shown) {
    const root: Folder = { path: area.area, name: AREA_LABEL[area.area]?.[0] ?? area.area, area, kids: [], files: [] };
    nodes.set(root.path, root);
    const ensure = (path: string): Folder => {
      const have = nodes.get(path);
      if (have) return have;
      const parentPath = path.slice(0, path.lastIndexOf('/'));
      const parent = ensure(parentPath);
      const node: Folder = { path, name: path.slice(path.lastIndexOf('/') + 1), area, kids: [], files: [] };
      parent.kids.push(node);
      nodes.set(path, node);
      return node;
    };
    for (const d of area.dirs ?? []) ensure(d);
    for (const f of area.files) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : area.area;
      ensure(dir).files.push(f);
    }
    for (const n of nodes.values()) {
      n.kids.sort((a, b) => a.name.localeCompare(b.name));
      n.files.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
  // Deliverables that landed in an internal folder, listed without unfolding
  // the internals. Only while those are folded - unfolded, they are in place.
  {
    const docs: WorkspaceFile[] = [];
    let anyArea: FileArea | null = null;
    for (const area of data.areas) {
      if (!SURFACE_FROM.has(area.area)) continue;
      // The agent's scratch and scripts folders, wherever the bot folder is.
      const mine = area.files.filter((f) =>
        /^hina\/[^/]+\/(scratch|scripts)\//.test(f.path) && isDocument(f));
      if (mine.length) { docs.push(...mine); anyArea = anyArea ?? area; }
    }
    if (docs.length && anyArea) {
      nodes.set(DOCS_NODE, {
        path: DOCS_NODE, name: '임시 문서', area: { ...anyArea, deletable: true }, kids: [], files: docs, virtual: true,
      });
    }
  }
}

function allPaths(): string[] {
  const out: string[] = [];
  for (const n of nodes.values()) {
    out.push(n.path);
    for (const f of n.files) out.push(f.path);
  }
  return out;
}

function expandTo(path: string): void {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
}

/** The folder an upload from the current view lands in. */
function uploadTarget(): string {
  const n = nodes.get(selectedDir);
  if (n && !n.virtual && USER_AREAS.has(n.area.area)) return n.path;
  return 'projects';
}

/** Folders a file may be moved into: the deletable areas and their folders. */
function moveTargets(): string[] {
  const out: string[] = [];
  for (const a of lastListing?.areas ?? []) {
    if (!a.deletable) continue;
    out.push(a.area);
    for (const d of a.dirs ?? []) out.push(d);
  }
  return out;
}

// --- the tree -------------------------------------------------------------------

function drawTree(): void {
  if (!treeMount || !lastListing) return;
  clear(treeMount);
  const data = lastListing;

  // --- actions ---------------------------------------------------------------
  const filePicker = el('input', { type: 'file', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
  filePicker.addEventListener('change', () => {
    const files = Array.from(filePicker.files ?? []).map((file) => ({ file, rel: '' }));
    filePicker.value = '';
    void uploadMany(files, uploadTarget());
  });
  const dirPicker = el('input', { type: 'file', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
  dirPicker.setAttribute('webkitdirectory', '');
  dirPicker.addEventListener('change', () => {
    const files = Array.from(dirPicker.files ?? []).map((file) => {
      const rel = String((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name);
      return { file, rel: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' };
    });
    dirPicker.value = '';
    void uploadMany(files, uploadTarget());
  });
  const uploadBtn = el('button', { class: 'primary tiny', text: '올리기', title: '파일을 골라 지금 폴더에 올립니다' });
  uploadBtn.addEventListener('click', () => filePicker.click());
  const uploadDirBtn = el('button', { class: 'ghost tiny', text: '폴더 올리기', title: '폴더째 올립니다 (안의 폴더 구조 유지)' });
  uploadDirBtn.addEventListener('click', () => dirPicker.click());
  const newDir = el('button', { class: 'ghost tiny', text: '새 폴더', title: '지금 폴더 안에 폴더를 만듭니다' });
  newDir.addEventListener('click', () => {
    const body = el('div', { class: 'applypop' });
    const close = popover(newDir, body);
    const where = uploadTarget();
    const name = el('input', { placeholder: '폴더 이름' }) as HTMLInputElement;
    const ok = el('button', { class: 'primary tiny', text: '만들기' });
    ok.addEventListener('click', async () => {
      const n = name.value.trim().replace(/[\\/]+/g, '-');
      if (!n) return;
      try {
        await state.mkdirFile(where + '/' + n);
        close();
        expandTo(where + '/' + n);
        await refresh();
      } catch (e) {
        notice('만들지 못했습니다: ' + msg(e), 'err');
      }
    });
    name.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') ok.click(); });
    body.appendChild(el('div', { class: 'hint', text: `${where}/ 안에` }));
    body.appendChild(el('div', { class: 'row' }, [name, ok]));
    setTimeout(() => name.focus(), 0);
  });
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  treeMount.appendChild(el('div', { class: 'treehead' }, [uploadBtn, uploadDirBtn, newDir, reloadBtn, filePicker, dirPicker]));

  // --- folders ---------------------------------------------------------------
  // The user areas always show, empty or not: an empty 프로젝트 is still the
  // place to drop the first file. Only a machine area hides when empty.
  const spec = treeSpec();
  const roots = [...nodes.values()].filter((n) => !n.path.includes('/') && n.path !== DOCS_NODE);
  for (const root of roots) {
    if (root.path.startsWith('.') && !root.area.count && !root.kids.length) continue;
    treeMount.appendChild(treeRow(toTreeNode(root, 0), 0, spec));
  }
  const docs = nodes.get(DOCS_NODE);
  if (docs) treeMount.appendChild(treeRow(toTreeNode(docs, 0), 0, spec));

  // --- the hidden half -------------------------------------------------------
  const hidden = data.areas.filter((a) => !USER_AREAS.has(a.area) && a.count > 0);
  const toggle = el('button', {
    class: 'ghost tiny',
    text: showInternal ? '내부 파일 숨기기' : `내부 파일 보기 (${hidden.reduce((n, a) => n + a.count, 0)})`,
  });
  toggle.addEventListener('click', () => {
    showInternal = !showInternal;
    void refresh();
  });
  // 정리 is per bot: this bot's hina/ scratch+scripts and its system scratch.
  const cleanBtn = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  cleanBtn.disabled = !state.activeCharKey;
  cleanBtn.title = state.activeCharKey
    ? '이 봇의 AI 작업 폴더(임시·스크립트)를 비웁니다. 산출물(out)은 남습니다.'
    : '봇을 열어야 그 봇의 작업 폴더를 정리할 수 있습니다';
  armed(cleanBtn, '이 봇 정리', '정말 정리할까요?', async () => {
    try {
      const r = await state.cleanFiles();
      notice(`${r.removed}개를 지워 ${fmtSize(r.freed)}를 비웠습니다.`, 'ok');
      await refresh();
    } catch (e) {
      notice('정리에 실패했습니다: ' + msg(e), 'err');
    }
  });
  treeMount.appendChild(el('div', { class: 'treefoot' }, [
    toggle, cleanBtn, el('div', { class: 'hint', text: `전체 ${fmtSize(data.totalSize)}` }),
  ]));
}

function toTreeNode(n: Folder, depth: number): TreeNode {
  const [, why] = AREA_LABEL[n.area.area] ?? ['', ''];
  return {
    path: n.path,
    name: n.name,
    kids: n.kids.map((k) => toTreeNode(k, depth + 1)),
    count: countFiles(n),
    glyph: n.virtual ? '📄' : undefined,
    title: n.virtual ? 'AI 작업 폴더(임시·스크립트)에 있는 문서입니다. 여기서 바로 볼 수 있습니다.' : (depth ? n.path : why),
    // A folder in the tree is a drop target of its own.
    droppable: !n.virtual && USER_AREAS.has(n.area.area),
  };
}

function treeSpec(): TreeSpec {
  return {
    expanded,
    selected: selectedDir,
    onOpen(node) {
      selectedDir = node.path;
      previewPath = '';
      selection.clear();
      if (node.kids.length) expanded.add(node.path);
      drawTree();
      drawCentre();
    },
    onToggle(node) {
      if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path);
      drawTree();
    },
    onDropFiles: (path, files) => void uploadMany(files, path),
    // Rows dragged from the centre land in a tree folder (item 3).
    onDropMove: (path, sources) => void moveSelected(sources, path),
  };
}

function countFiles(n: Folder): number {
  return n.files.length + n.kids.reduce((s, k) => s + countFiles(k), 0);
}

// --- the centre: list · grid · preview -----------------------------------------

function drawCentre(): void {
  if (!viewMount) return;
  clear(viewMount);
  const n = nodes.get(selectedDir);
  if (!n) {
    viewMount.appendChild(el('div', { class: 'empty', text: '왼쪽에서 폴더를 고르세요.' }));
    return;
  }
  if (previewPath) {
    const f = n.files.find((x) => x.path === previewPath) ?? findFile(previewPath);
    if (f) { void drawPreview(f, n); return; }
    previewPath = '';
  }

  const writable = !n.virtual && USER_AREAS.has(n.area.area);
  const deletable = n.area.deletable;
  const hasImages = hasImagesDeep(n);
  const [, why] = AREA_LABEL[n.area.area] ?? ['', ''];

  // --- bar ---------------------------------------------------------------------
  // The verbs are icons with tooltips now (field report items 1-2): five text
  // buttons ate the row and the crumb had no room left.
  const selCount = selection.size;
  const iconBtn = (html: string, title: string): HTMLButtonElement =>
    el('button', { class: 'iconbtn', html, title }) as HTMLButtonElement;
  const dl = el('button', { class: 'ghost tiny', text: selCount > 1 ? `내려받기 (${selCount}, zip)` : '내려받기', title: '내 PC에 저장합니다. 여러 개나 폴더는 zip 하나로 받습니다.' }) as HTMLButtonElement;
  dl.disabled = !selCount;
  dl.addEventListener('click', () => void downloadSelected(n));
  const mv = iconBtn(FICON.move, selCount ? `이동 (${selCount}) — 다른 폴더로 옮깁니다` : '이동 — 고른 항목을 다른 폴더로 옮깁니다');
  mv.disabled = !selCount || !deletable;
  mv.addEventListener('click', () => openMove(mv));
  const del = iconBtn(FICON.trash, (selCount ? `삭제 (${selCount})` : '삭제') + ' — Delete 키로도 됩니다');
  del.disabled = !selCount || !deletable;
  delCtrl = armedIcon(del, FICON.trash, `정말? (${selCount})`, () => void runDelete(n));
  const all = iconBtn(FICON.selectAll, '전체 선택 (Ctrl+A)');
  all.addEventListener('click', () => { selectAll(n); drawCentre(); });
  const viewBtn = iconBtn(view === 'grid' ? FICON.list : FICON.grid,
                          view === 'grid' ? '목록 보기' : '미리보기 — 썸네일로 봅니다');
  viewBtn.addEventListener('click', () => {
    view = view === 'grid' ? 'list' : 'grid';
    try { localStorage.setItem('hina.filesView', view); } catch { /* fine */ }
    drawCentre();
  });
  const zipAll = el('button', { class: 'ghost tiny', text: '폴더 zip', title: '이 폴더 전체를 zip 하나로 받습니다' }) as HTMLButtonElement;
  zipAll.disabled = n.virtual === true || (!n.files.length && !n.kids.length);
  zipAll.addEventListener('click', async () => {
    zipAll.disabled = true;
    try {
      const bytes = await state.downloadZip([n.path], n.name);
      notice(`${fmtSize(bytes)} zip 을 브라우저 다운로드로 넘겼습니다.`, 'ok');
    } catch (e) { notice('받지 못했습니다: ' + msg(e), 'err'); } finally { zipAll.disabled = false; }
  });

  // 이 폴더에서 찾기, folded into an icon (item 14): the box only takes room
  // while it is open, and it opens right where the list it filters lives.
  const searchWrap = el('span', { class: 'fsearch' + (filterText ? ' open' : '') });
  const searchInput = el('input', { placeholder: '이 폴더에서 찾기', value: filterText }) as HTMLInputElement;
  const searchBtn = iconBtn(FICON.search, '이 폴더에서 찾기');
  searchBtn.addEventListener('click', () => {
    searchWrap.classList.add('open');
    searchInput.focus();
  });
  searchInput.addEventListener('input', () => {
    filterText = searchInput.value;
    drawCentre();
    const again = viewMount?.querySelector('.fsearch input') as HTMLInputElement | null;
    if (again) {
      again.focus();
      try { again.setSelectionRange(again.value.length, again.value.length); } catch { /* fine */ }
    }
  });
  searchInput.addEventListener('keydown', (ev) => {
    if ((ev as KeyboardEvent).key === 'Escape') {
      filterText = '';
      drawCentre();
      focusList();
    }
  });
  searchInput.addEventListener('blur', () => {
    if (!searchInput.value) searchWrap.classList.remove('open');
  });
  searchWrap.append(searchBtn, searchInput);

  viewMount.appendChild(el('div', { class: 'filebar' }, [
    el('span', { class: 'filecrumb', text: n.virtual ? '임시 문서' : n.path + '/' }),
    n.virtual ? null : copyPathButton(n.path),
    el('span', { class: 'hint', text: `${n.files.length}개` + (n.kids.length ? ` · 폴더 ${n.kids.length}` : '') }),
    el('span', { class: 'spacer' }),
    searchWrap,
    hasImages ? viewBtn : null,
    all, dl, zipAll, mv, del,
  ]));
  viewMount.appendChild(el('div', { class: 'filehint', text:
    (n.virtual ? 'AI 작업 폴더에 남은 문서입니다. ' : why + ' ')
    + (writable ? '파일이나 폴더를 끌어다 놓으면 올라가고, 행을 왼쪽 트리의 폴더로 끌면 옮겨집니다. ' : '')
    + '클릭으로 선택, Ctrl·Shift 로 여러 개, 더블클릭·Enter 로 열기, 우클릭에 이름 바꾸기·복사·붙여넣기'
    + (deletable ? ', Delete 로 삭제.' : '.') }));

  // --- rows ----------------------------------------------------------------------
  const list = el('div', { class: 'filelist', tabindex: '0' });
  const q = filterText.trim().toLowerCase();
  const entries: { path: string; name: string; file?: WorkspaceFile; node?: Folder }[] = [
    ...n.kids.map((k) => ({ path: k.path, name: k.name, node: k })),
    ...n.files.map((f) => ({ path: f.path, name: f.name, file: f })),
  ].filter((e) => !q || e.name.toLowerCase().includes(q));
  if (!entries.length) {
    list.appendChild(el('div', { class: 'fempty', text: q
      ? `“${filterText}” 에 맞는 항목이 없습니다.`
      : (writable ? '비어 있습니다. 파일을 끌어다 놓거나 왼쪽 “올리기”를 누르세요.' : '비어 있습니다.') }));
  } else if (view === 'grid' && hasImages) {
    const grid = el('div', { class: 'fgrid' });
    for (const e of entries) grid.appendChild(gridCell(e, entries, n));
    list.appendChild(grid);
  } else {
    list.appendChild(el('div', { class: 'frow head' }, [
      el('span'), el('span', { text: '이름' }), el('span', { class: 'fsize', text: '크기' }), el('span', { class: 'ftime', text: '수정' }),
    ]));
    for (const e of entries) list.appendChild(listRow(e, entries, n));
  }

  // Keyboard: the list is the thing with focus.
  list.addEventListener('keydown', (ev) => {
    const e = ev as KeyboardEvent;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      // The key drives the same two-step confirm as the 삭제 button.
      if (delCtrl && !del.disabled) { if (delCtrl.armed) delCtrl.fire(); else delCtrl.arm(); }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = [...selection][0];
      if (first) openEntry(first, n);
    } else if (e.key === 'Escape') {
      selection.clear();
      drawCentre();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll(n);
      drawCentre();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selection.size) {
      clipboard = { op: 'copy', paths: [...selection] };
      notice(`${clipboard.paths.length}개를 복사했습니다 — 붙여넣을 폴더에서 우클릭하거나 Ctrl+V.`);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && selection.size && deletable) {
      clipboard = { op: 'cut', paths: [...selection] };
      notice(`${clipboard.paths.length}개를 잘라냈습니다 — 붙여넣을 폴더에서 우클릭하거나 Ctrl+V.`);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && clipboard && writable) {
      void pasteInto(uploadTarget());
    }
  });
  // Right-click on the empty part of the list: paste into this folder.
  list.addEventListener('contextmenu', (ev) => {
    if ((ev.target as HTMLElement).closest('.frow:not(.head), .fcell')) return;
    ev.preventDefault();
    menuAt((ev as MouseEvent).clientX, (ev as MouseEvent).clientY, [
      { label: clipboard ? `붙여넣기 (${clipboard.paths.length})` : '붙여넣기',
        disabled: !clipboard || !writable, onClick: () => void pasteInto(uploadTarget()) },
      { label: '전체 선택', onClick: () => { selectAll(n); drawCentre(); } },
    ]);
  });
  viewMount.appendChild(list);
}

function findFile(path: string): WorkspaceFile | undefined {
  for (const n of nodes.values()) {
    const f = n.files.find((x) => x.path === path);
    if (f) return f;
  }
  return undefined;
}

function selectAll(n: Folder): void {
  selection = new Set([...n.kids.map((k) => k.path), ...n.files.map((f) => f.path)]);
}

/** Click semantics shared by rows and cells: plain, Ctrl toggle, Shift range. */
function pick(path: string, e: MouseEvent, order: { path: string }[]): void {
  if (e.shiftKey && anchorPath) {
    const a = order.findIndex((x) => x.path === anchorPath);
    const b = order.findIndex((x) => x.path === path);
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a];
      for (let i = lo; i <= hi; i++) selection.add(order[i].path);
    } else selection.add(path);
  } else if (e.ctrlKey || e.metaKey) {
    if (selection.has(path)) selection.delete(path); else selection.add(path);
    anchorPath = path;
  } else {
    selection = new Set([path]);
    anchorPath = path;
  }
}

function openEntry(path: string, n: Folder): void {
  const kid = n.kids.find((k) => k.path === path);
  if (kid) {
    selectedDir = kid.path;
    expandTo(kid.path);
    selection.clear();
    drawTree();
    drawCentre();
    return;
  }
  previewPath = path;
  drawCentre();
}

function listRow(e: { path: string; name: string; file?: WorkspaceFile; node?: Folder }, order: { path: string }[], n: Folder): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = selection.has(e.path);
  const row = el('div', { class: 'frow' + (selection.has(e.path) ? ' sel' : ''), title: e.path }, [
    box,
    // A folder glyph for folders; files carry their extension as a small tag
    // instead of a pictogram - the picture glyphs rendered as stray letters
    // on a machine without a colour emoji font.
    el('span', { class: 'fname' }, [
      e.node ? el('span', { class: 'ficon', text: '📁' }) : el('span', { class: 'ftag', text: extOf(e.name) }),
      el('span', { text: e.name }),
    ]),
    el('span', { class: 'fsize', text: e.file ? fmtSize(e.file.size) : `${countFiles(e.node!)}개` }),
    el('span', { class: 'ftime', text: e.file ? fmtWhen(e.file.modified) : '' }),
  ]);
  box.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (box.checked) selection.add(e.path); else selection.delete(e.path);
    anchorPath = e.path;
    drawCentre();
    focusList();
  });
  row.addEventListener('click', (ev) => { pick(e.path, ev as MouseEvent, order); drawCentre(); focusList(); });
  row.addEventListener('dblclick', () => openEntry(e.path, n));
  wireRowDnd(row, e, n);
  row.addEventListener('contextmenu', (ev) => openRowMenu(ev as MouseEvent, e, n));
  return row;
}

/** Rows drag as the selection; a folder row is a drop target of its own. */
function wireRowDnd(row: HTMLElement, e: { path: string; node?: Folder }, n: Folder): void {
  if (!n.virtual) installDrag(row, () => (selection.has(e.path) ? [...selection] : [e.path]));
  if (e.node && !n.virtual && USER_AREAS.has(n.area.area)) {
    installDrop(row, {
      into: () => e.path,
      onFiles: (path, files) => void uploadMany(files, path),
      onMove: (path, sources) => void moveSelected(sources, path),
    });
  }
}

/** The right-click menu on a row or cell (field report item 11). */
function openRowMenu(ev: MouseEvent, e: { path: string; name: string; file?: WorkspaceFile; node?: Folder }, n: Folder): void {
  ev.preventDefault();
  ev.stopPropagation();
  // Right-clicking outside the selection retargets it, like every file manager.
  if (!selection.has(e.path)) {
    selection = new Set([e.path]);
    anchorPath = e.path;
    drawCentre();
  }
  const paths = [...selection];
  const many = paths.length > 1;
  const can = n.area.deletable && !n.virtual;
  const pasteTarget = e.node ? e.path : selectedDir;
  menuAt(ev.clientX, ev.clientY, [
    { label: '열기', disabled: many, onClick: () => openEntry(e.path, n) },
    { label: '이름 바꾸기', disabled: many || !can, onClick: () => renameEntry(e) },
    null,
    { label: many ? `복사 (${paths.length})` : '복사',
      onClick: () => { clipboard = { op: 'copy', paths }; notice(`${paths.length}개를 복사했습니다 — 붙여넣을 폴더에서 우클릭하세요.`); } },
    { label: many ? `잘라내기 (${paths.length})` : '잘라내기', disabled: !can,
      onClick: () => { clipboard = { op: 'cut', paths }; notice(`${paths.length}개를 잘라냈습니다 — 붙여넣을 폴더에서 우클릭하세요.`); } },
    { label: clipboard ? `붙여넣기 (${clipboard.paths.length})` : '붙여넣기', disabled: !clipboard,
      onClick: () => void pasteInto(pasteTarget) },
    null,
    { label: '경로 복사', onClick: () => { copyToClipboard(e.path); notice('경로를 복사했습니다.', 'ok'); } },
    { label: many ? `내려받기 (${paths.length})` : '내려받기', onClick: () => void downloadSelected(n) },
    null,
    // The two-step confirm stays: the menu arms the bar's delete, the red
    // button fires it - a context menu must not be a one-click shredder.
    { label: many ? `삭제 (${paths.length})…` : '삭제…', danger: true, disabled: !can,
      onClick: () => { delCtrl?.arm(); notice('삭제하려면 막대의 빨간 확인 버튼을 한 번 더 누르세요.'); } },
  ]);
}

function renameEntry(e: { path: string; name: string }): void {
  const anchor = (viewMount?.querySelector('.filebar') as HTMLElement | null) ?? viewMount;
  if (!anchor) return;
  namePopover(anchor, {
    label: `${e.name} → 새 이름`,
    value: e.name,
    ok: '바꾸기',
    onSubmit: async (raw) => {
      const nm = raw.replace(/[\\/]+/g, '-').trim();
      if (!nm || nm === e.name) return;
      const dir = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
      try {
        const r = await state.moveFile(e.path, (dir ? dir + '/' : '') + nm);
        if (previewPath === e.path) previewPath = r.to;
        selection = new Set([r.to]);
        notice('이름을 바꿨습니다.', 'ok');
        state.touchFiles();
        await refresh();
      } catch (err) {
        notice('바꾸지 못했습니다: ' + msg(err), 'err');
      }
    },
  });
}

async function pasteInto(target: string): Promise<void> {
  const clip = clipboard;
  if (!clip) return;
  let done = 0;
  try {
    for (const p of clip.paths) {
      if (p === target || target.startsWith(p + '/')) continue;
      if (clip.op === 'copy') await state.copyFile(p, target);
      else await state.moveFile(p, target);
      done += 1;
    }
    notice(`${done}개를 ${target}/ 에 ${clip.op === 'copy' ? '복사' : '이동'}했습니다.`, 'ok');
  } catch (e) {
    notice(`${done}개를 처리한 뒤 실패했습니다: ` + msg(e), 'err');
  }
  // A cut is spent by its paste; a copy can paste again elsewhere.
  if (clip.op === 'cut') {
    clipboard = null;
    selection.clear();
  }
  state.touchFiles();
  await refresh();
}

/** Internal drag onto a tree folder (or a folder row): move the batch. */
async function moveSelected(sources: string[], target: string): Promise<void> {
  const list = sources.filter((p) => p !== target && !target.startsWith(p + '/'));
  if (!list.length) return;
  let done = 0;
  try {
    for (const p of list) {
      await state.moveFile(p, target);
      done += 1;
    }
    notice(`${done}개를 ${target}/ 로 옮겼습니다.`, 'ok');
  } catch (e) {
    notice(`${done}개를 옮긴 뒤 실패했습니다: ` + msg(e), 'err');
  }
  selection.clear();
  previewPath = '';
  state.touchFiles();
  await refresh();
}

/** `armed()` writes textContent, which would blow away an SVG icon - this is
 * the same two-step confirm with the icon restored on disarm. */
function armedIcon(button: HTMLButtonElement, iconHtml: string, confirmLabel: string,
                   run: () => void): ArmedControl {
  let armedNow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    armedNow = false;
    button.innerHTML = iconHtml;
    button.classList.remove('danger');
  };
  const arm = () => {
    if (timer) clearTimeout(timer);
    armedNow = true;
    button.textContent = confirmLabel;
    button.classList.add('danger');
    timer = setTimeout(disarm, 4000);
  };
  const fire = () => {
    disarm();
    run();
  };
  button.innerHTML = iconHtml;
  button.addEventListener('click', () => {
    if (!armedNow) arm();
    else fire();
  });
  return { arm, fire, disarm, get armed() { return armedNow; } };
}

/** Whether this folder or anything under it holds an image - the grid toggle
 * used to look only at the folder's own files, so a tree of subfolders full
 * of assets offered no 미리보기 at all. */
function hasImagesDeep(node: Folder): boolean {
  if (node.files.some((f) => IMAGE_RE.test(f.name))) return true;
  return node.kids.some(hasImagesDeep);
}

function firstImage(node: Folder): WorkspaceFile | null {
  const own = node.files.find((f) => IMAGE_RE.test(f.name));
  if (own) return own;
  for (const k of node.kids) {
    const hit = firstImage(k);
    if (hit) return hit;
  }
  return null;
}

function gridCell(e: { path: string; name: string; file?: WorkspaceFile; node?: Folder }, order: { path: string }[], n: Folder): HTMLElement {
  const pic = el('div', { class: 'assetpic' });
  const cell = el('div', { class: 'fcell' + (selection.has(e.path) ? ' sel' : ''), title: e.path }, [
    pic,
    el('div', { class: 'fname', text: e.name }),
    el('div', { class: 'fsize', text: e.file ? fmtSize(e.file.size) : `폴더 · ${countFiles(e.node!)}개` }),
  ]);
  if (e.node) {
    // A folder previews its first image, with the folder mark in the corner.
    const peek = firstImage(e.node);
    if (peek) void loadThumb(peek, pic);
    pic.appendChild(el('div', { class: peek ? 'foldertag' : 'assettype', text: '📁' }));
  } else if (e.file && IMAGE_RE.test(e.name)) void loadThumb(e.file, pic);
  else pic.appendChild(el('div', { class: 'assettype', text: (e.name.split('.').pop() || '?').toUpperCase().slice(0, 5) }));
  cell.addEventListener('click', (ev) => { pick(e.path, ev as MouseEvent, order); drawCentre(); focusList(); });
  cell.addEventListener('dblclick', () => openEntry(e.path, n));
  wireRowDnd(cell, e, n);
  cell.addEventListener('contextmenu', (ev) => openRowMenu(ev as MouseEvent, e, n));
  return cell;
}

function focusList(): void {
  (viewMount?.querySelector('.filelist') as HTMLElement | null)?.focus();
}

/** 경로 복사 - the space path is what gets pasted into 히나 requests and
 * external tools, and selecting it by hand from a crumb was the complaint. */
function copyPathButton(path: string): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '📋', title: '경로 복사' });
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    b.textContent = copyToClipboard(path) ? '복사됨' : '실패';
    setTimeout(() => { b.textContent = '📋'; }, 1500);
  });
  return b;
}

// Thumbnails ride the shared blob pipeline (blobimg.ts: 6 in flight, LRU).
async function loadThumb(f: WorkspaceFile, mount: HTMLElement): Promise<void> {
  try {
    if (!mount.isConnected) return;
    const url = await blobUrl(f.path, String(f.modified));
    if (!mount.isConnected) return;
    const img = el('img', { src: url, alt: f.name, loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(el('div', { class: 'assettype', text: 'IMG' })));
    mount.appendChild(img);
  } catch {
    mount.appendChild(el('div', { class: 'assettype', text: '?' }));
  }
}

// --- preview -------------------------------------------------------------------

async function drawPreview(f: WorkspaceFile, n: Folder): Promise<void> {
  if (!viewMount) return;
  clear(viewMount);
  const back = el('button', { class: 'ghost tiny', text: '‹ 목록으로' });
  back.addEventListener('click', () => { previewPath = ''; drawCentre(); focusList(); });
  const save = el('button', { class: 'primary tiny', text: '내 PC에 저장' }) as HTMLButtonElement;
  const out = el('span', { class: 'hint' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '받는 중입니다…';
    try {
      const bytes = await state.downloadFile(f.path);
      out.textContent = `${fmtSize(bytes)} 를 브라우저 다운로드로 넘겼습니다.`;
    } catch (e) {
      out.textContent = '받지 못했습니다: ' + msg(e);
    } finally {
      save.disabled = false;
    }
  });
  const head = el('div', { class: 'filebar' }, [
    back,
    el('span', { class: 'filecrumb', text: f.path }),
    copyPathButton(f.path),
    el('span', { class: 'hint', text: `${fmtSize(f.size)} · ${fmtWhen(f.modified)} · ${AREA_LABEL[n.area.area]?.[0] ?? n.area.area}` }),
    el('span', { class: 'spacer' }),
    save, out,
  ]);
  viewMount.appendChild(head);
  const body = el('div', { class: 'card fpreview' });
  viewMount.appendChild(body);

  if (IMAGE_RE.test(f.name)) {
    body.appendChild(el('div', { class: 'hint', text: '불러오는 중입니다…' }));
    try {
      const url = await blobUrl(f.path, String(f.modified));
      clear(body);
      const img = el('img', { src: url, alt: f.name });
      img.addEventListener('error', () => { clear(body); body.appendChild(el('div', { class: 'hint', text: '이 호스트에서는 그림을 표시할 수 없습니다. 내 PC에 저장해서 보세요.' })); });
      body.appendChild(img);
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
    return;
  }
  if (!f.textual) {
    body.appendChild(el('div', { class: 'hint', text: '텍스트 파일이 아니라 미리보기를 건너뜁니다. 위 “내 PC에 저장”으로 받으세요.' }));
    if (f.path.endsWith('.charx')) {
      body.appendChild(el('div', { class: 'hint', style: { marginTop: '6px' }, text: '받은 charx 는 RisuAI 의 캐릭터 가져오기로 넣습니다. 300MB 가 넘으면 백엔드 PC 의 out/ 폴더에서 직접 복사하는 편이 빠릅니다.' }));
    }
    return;
  }
  body.appendChild(el('div', { class: 'hint', text: '여는 중입니다…' }));
  try {
    const r = await state.readFile(f.path);
    clear(body);
    if (r.truncated) body.appendChild(el('div', { class: 'hint', text: '앞부분만 표시합니다.' }));
    if (/\.(md|markdown)$/i.test(f.name)) {
      // The same body the artifact viewer shows - rendered, with a way to
      // open it as the card.
      const big = el('button', { class: 'ghost tiny', text: '카드로 크게 보기', title: '중앙 패널 카드로 엽니다' });
      big.addEventListener('click', () =>
        showArtifact({ path: f.path, title: f.name, kind: 'markdown' }, { flipMobile: true }));
      body.appendChild(el('div', { class: 'row', style: { marginBottom: '6px' } }, [big]));
      body.appendChild(el('div', { class: 'filepreview' },
        [renderMarkdown(r.content, { image: (p, a) => workspaceImage(p, a) })]));
    } else {
      body.appendChild(el('pre', { class: 'mono filepreview', text: r.content || r.note || '(비어 있습니다)' }));
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

// --- delete · move · download ----------------------------------------------------

async function runDelete(n: Folder): Promise<void> {
  const paths = [...selection];
  if (!paths.length) return;
  let done = 0;
  try {
    for (const p of paths) {
      await state.deleteFile(p);
      done += 1;
      if (previewPath === p) previewPath = '';
    }
    notice(`${done}개를 지웠습니다.`, 'ok');
  } catch (e) {
    notice(`${done}개를 지운 뒤 실패했습니다: ` + msg(e), 'err');
  }
  selection.clear();
  state.touchFiles();
  await refresh();
  focusList();
}

function openMove(anchor: HTMLElement): void {
  const paths = [...selection];
  if (!paths.length) return;
  const body = el('div', { class: 'applypop' });
  const close = popover(anchor, body);
  body.appendChild(el('div', { class: 'hint', text: `${paths.length}개를 옮길 곳:` }));
  for (const target of moveTargets()) {
    if (target === selectedDir) continue;
    const b = el('button', { class: 'catrow', text: '📁 ' + target });
    b.addEventListener('click', async () => {
      close();
      let done = 0;
      try {
        for (const p of paths) { await state.moveFile(p, target); done += 1; }
        notice(`${done}개를 ${target}/ 로 옮겼습니다.`, 'ok');
      } catch (e) {
        notice(`${done}개를 옮긴 뒤 실패했습니다: ` + msg(e), 'err');
      }
      selection.clear();
      previewPath = '';
      state.touchFiles();
      await refresh();
    });
    body.appendChild(b);
  }
}

async function downloadSelected(n: Folder): Promise<void> {
  const paths = [...selection];
  if (!paths.length) return;
  const single = paths.length === 1 ? n.files.find((f) => f.path === paths[0]) : undefined;
  try {
    if (single) {
      const bytes = await state.downloadFile(single.path);
      notice(`${single.name} · ${fmtSize(bytes)} 를 브라우저 다운로드로 넘겼습니다.`, 'ok');
      return;
    }
    const name = paths.length === 1
      ? paths[0].slice(paths[0].lastIndexOf('/') + 1)
      : `${state.workspace?.characterName || 'files'}-${n.name}`;
    notice('zip 을 만드는 중입니다…');
    const bytes = await state.downloadZip(paths, name);
    notice(`${paths.length}개 · ${fmtSize(bytes)} zip 을 브라우저 다운로드로 넘겼습니다.`, 'ok');
  } catch (e) {
    notice('받지 못했습니다: ' + msg(e), 'err');
  }
}

// --- upload ----------------------------------------------------------------------
// Drag-and-drop wiring (installDrop / collectDrop) lives in ./tree, shared
// with the studio's output tree.

// The upload overlay: a fixed card in the corner that NO redraw can eat. The
// old progress line was prepended into the centre pane, and any refresh
// mid-upload (a state emit, a folder click) cleared it - a 100MB drop showed
// nothing at all (field report item 6). The bar is the graph item 7 asked
// for; errors collect on the card instead of racing past as notices.
let upPanel: HTMLElement | null = null;
let upHideTimer: ReturnType<typeof setTimeout> | null = null;

interface UploadUi {
  ask: HTMLElement;
  set(sentBytes: number, totalBytes: number, label: string): void;
  error(text: string): void;
  finish(ok: boolean, text: string): void;
}

function uploadUi(title: string): UploadUi {
  if (upHideTimer) {
    clearTimeout(upHideTimer);
    upHideTimer = null;
  }
  upPanel?.remove();
  const closeBtn = el('button', { class: 'iconbtn', text: '✕', title: '닫기' });
  const ask = el('div');
  const label = el('span', { class: 'grow', text: title });
  const num = el('span');
  const fill = el('div', { class: 'assetfill' });
  const errs = el('div', { class: 'uperr', style: { display: 'none' } });
  const panel = el('div', { class: 'uploadpanel' }, [
    el('div', { class: 'uphead' }, [el('span', { text: '올리기' }), closeBtn]),
    ask,
    el('div', { class: 'upline' }, [label, num]),
    el('div', { class: 'assetbar' }, [fill]),
    errs,
  ]);
  closeBtn.addEventListener('click', () => {
    panel.remove();
    if (upPanel === panel) upPanel = null;
  });
  document.body.appendChild(panel);
  upPanel = panel;
  return {
    ask,
    set(sentBytes, totalBytes, text) {
      num.textContent = text;
      fill.style.width = totalBytes ? `${Math.min(100, (sentBytes / totalBytes) * 100).toFixed(1)}%` : '0%';
    },
    error(text) {
      errs.style.display = '';
      errs.appendChild(el('div', { text }));
    },
    finish(ok, text) {
      num.textContent = text;
      fill.style.width = '100%';
      fill.style.background = ok ? '#10b981' : '#ef4444';
      panel.classList.add(ok ? 'done' : 'failed');
      // A clean finish tidies itself away; a failure stays until dismissed.
      if (ok) {
        upHideTimer = setTimeout(() => {
          panel.remove();
          if (upPanel === panel) upPanel = null;
        }, 6000);
      }
    },
  };
}

/**
 * Upload a batch into `into`, reporting progress on the corner overlay as a
 * byte-accurate bar. Zips are asked about first (on the overlay, where the
 * question survives redraws): unpacked into a folder named after them, or
 * stored as they are.
 */
async function uploadMany(files: Incoming[], into: string): Promise<void> {
  if (!files.length) return;
  const ui = uploadUi(`${into}/ 에 ${files.length}개`);
  const zips = files.filter((f) => /\.zip$/i.test(f.file.name));
  const plain = files.filter((f) => !/\.zip$/i.test(f.file.name));
  let extractZips: boolean | null = zips.length ? null : false;
  if (zips.length) {
    extractZips = await new Promise<boolean | null>((resolve) => {
      const askRow = el('div', { class: 'zipask' });
      const unpack = el('button', { class: 'primary tiny', text: '풀어서 올리기' });
      const keep = el('button', { class: 'ghost tiny', text: 'zip 그대로 올리기' });
      const cancel = el('button', { class: 'ghost tiny', text: '취소' });
      unpack.addEventListener('click', () => { askRow.remove(); resolve(true); });
      keep.addEventListener('click', () => { askRow.remove(); resolve(false); });
      cancel.addEventListener('click', () => { askRow.remove(); resolve(null); });
      askRow.append(
        el('span', { text: `zip ${zips.length}개 (${zips.map((z) => z.file.name).slice(0, 3).join(', ')}${zips.length > 3 ? ' …' : ''}) —` }),
        unpack, keep, cancel,
      );
      ui.ask.appendChild(askRow);
    });
    if (extractZips === null && !plain.length) {
      ui.finish(true, '취소했습니다');
      return;
    }
  }
  const todo = extractZips === null ? plain : [...plain, ...zips];
  const totalBytes = todo.reduce((s, t) => s + t.file.size, 0) || 1;
  let sentBytes = 0;
  let done = 0;
  let failed = 0;
  let extracted = 0;
  const t0 = Date.now();
  const paint = (extraNote = ''): void => {
    const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
    ui.set(sentBytes, totalBytes,
           extraNote || `${done + failed}/${todo.length} · ${fmtSize(sentBytes)}/${fmtSize(totalBytes)} · ${secs}초`);
  };
  paint();

  // Batches of raw bytes, ~16MB each, two in flight: a thousand small files
  // is ~60 requests instead of a thousand, with no base64 in between.
  //
  // Anything larger than one batch goes through the chunked path instead of
  // being refused: a character's .charx is 140-180MB, which no single body
  // could carry (the backend's limit is 64MB, and a relay in front of it is
  // stricter still). It is also read a slice at a time, so a 180MB file never
  // sits in memory as one array.
  const BATCH = 16 * 1024 * 1024;
  const batches: Incoming[][] = [];
  const big: Incoming[] = [];
  let cur: Incoming[] = [];
  let curSize = 0;
  for (const item of todo) {
    if (item.file.size > BATCH) { big.push(item); continue; }
    if (cur.length && curSize + item.file.size > BATCH) { batches.push(cur); cur = []; curSize = 0; }
    cur.push(item);
    curSize += item.file.size;
  }
  if (cur.length) batches.push(cur);

  const sendBig = async ({ file, rel }: Incoming): Promise<void> => {
    const name = file.name;
    const extract = !!extractZips && /\.zip$/i.test(name);
    const before = sentBytes;
    try {
      for (let offset = 0; offset < file.size; offset += BATCH) {
        const end = Math.min(file.size, offset + BATCH);
        const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
        await state.uploadChunk(into, {
          name, rel, offset, total: file.size, last: end >= file.size, extract,
        }, bytes);
        sentBytes = before + end;
        paint(`${name} ${Math.round((end / file.size) * 100)}% (${Math.round(end / 1048576)}/${Math.round(file.size / 1048576)}MB)`);
      }
      done += 1;
    } catch (e) {
      failed += 1;
      sentBytes = before + file.size;
      ui.error(`${name}: ` + msg(e));
    }
    paint();
  };

  const sendBatch = async (batch: Incoming[]): Promise<void> => {
    const bytes = batch.reduce((s, b) => s + b.file.size, 0);
    try {
      const entries = await Promise.all(batch.map(async ({ file, rel }) => ({
        name: file.name, rel, bytes: new Uint8Array(await file.arrayBuffer()),
      })));
      const r = await state.uploadBatch(into, entries, !!extractZips);
      done += r.count;
      extracted += r.extracted;
      sentBytes += bytes;
    } catch (e) {
      // A batch that failed whole: retry its files one at a time so a single
      // bad file does not take its neighbours with it.
      for (const { file, rel } of batch) {
        try {
          const r = await uploadOne(file, rel ? into + '/' + rel : into, !!extractZips && /\.zip$/i.test(file.name));
          done += 1;
          if (r.extracted) extracted += r.extracted;
        } catch (e2) {
          failed += 1;
          ui.error(`${file.name}: ` + msg(e2));
        }
        sentBytes += file.size;
      }
      void e;
    }
    paint();
  };
  let next = 0;
  const worker = async () => { while (next < batches.length) await sendBatch(batches[next++]); };
  await Promise.all([worker(), worker()]);
  // The large ones after the batches, one at a time: their pieces are ordered
  // and the progress line is per file.
  for (const item of big) await sendBig(item);
  const summary = `${done}개를 ${into}/ 에 올렸습니다.`
    + (extracted ? ` (zip 에서 ${extracted}개 풀림)` : '')
    + (failed ? ` 실패 ${failed}개.` : '');
  ui.finish(!failed, failed ? `완료 · 실패 ${failed}개` : '완료');
  notice(summary, failed ? 'err' : 'ok');
  if (nodes.has(into)) { selectedDir = into; expandTo(into); }
  state.touchFiles();
  await refresh();
}

/**
 * Text goes as text, everything else as base64.
 *
 * The only way out of this iframe is Risuai.nativeFetch with a JSON body, so a
 * binary has to survive as characters; base64 is the one encoding that does
 * without corrupting the bytes. FileReader does the encoding natively - a
 * byte-by-byte string concat took seconds on a 20MB image.
 */
async function uploadOne(file: File, dir: string, extract: boolean): Promise<{ path: string; extracted?: number }> {
  if (TEXT_UPLOAD_RE.test(file.name)) {
    return await state.uploadFile(file.name, await file.text(), false, dir);
  }
  const b64 = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] ?? '');
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(file);
  });
  return await state.uploadFile(file.name, b64, true, dir, extract);
}

// --- small helpers ---------------------------------------------------------------

/** The extension as a short tag: "png", "md", "charx"; "—" when there is none. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '—';
  return name.slice(i + 1).toLowerCase().slice(0, 5);
}

function fmtSize(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function fmtWhen(sec: number): string {
  const n = Number(sec) * 1000;
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const d = new Date(n);
    const p = (x: number) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return ''; }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
