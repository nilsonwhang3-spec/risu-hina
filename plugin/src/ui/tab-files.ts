/**
 * The file view - the bot's workspace as a file browser.
 *
 *   left     folders only: the areas (업로드 · 결과물 · …) and the folders
 *            inside them, as a tree. Selecting one lists it.
 *   centre   what the selected folder holds - a list (name · size · time), or
 *            a grid of thumbnails when the folder is pictures. Selection with
 *            click / Ctrl / Shift / checkboxes; Delete deletes, Enter opens,
 *            files dropped anywhere on it are uploaded into that folder.
 *   right    the agent, as on every tab.
 *
 * It used to be one tree with every file in it, which read fine at ten files
 * and fell apart at a folder of three hundred assets: no way to pick several,
 * no way to see them, one download button per file. Folder tree plus list is
 * what every file manager does, and the reason is that it scales.
 *
 * **What is shown by default is what a person put in or would take out.** The
 * workspace also holds the frozen originals, the generated helper, the scoped
 * snapshot and the agent's scratch - all of it real, none of it interesting
 * unless something has gone wrong. Those are hidden behind a toggle rather than
 * removed, because "정리" needs to be able to say what it is about to delete.
 * A document the agent wrote into scratch/ or scripts/ is a deliverable that
 * landed in the wrong folder, not an internal file: those get a virtual folder
 * (임시 문서) that is visible without unfolding the internals.
 *
 * Bulk transfer: several files or a folder come down as one zip built on the
 * backend (POST /files/zip); a dropped folder goes up file by file into the
 * matching subfolders; a dropped .zip is offered to be unpacked on arrival.
 */
import { el, clear, armed, popover } from './dom';
import { state, type FileArea, type FileListing, type WorkspaceFile } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

const AREA_LABEL: Record<string, [string, string]> = {
  uploads: ['업로드', '직접 올리신 참고 파일입니다. 정리해도 남습니다.'],
  out: ['결과물', 'AI가 만든 산출물입니다. 내려받기 전이면 남겨 두세요.'],
  original: ['원본', '가져온 그대로의 스냅샷입니다. 비교 기준이라 지울 수 없습니다.'],
  scripts: ['스크립트', 'AI가 작성해 실행한 파이썬입니다.'],
  skills: ['스킬', '켜 둔 스크립트 스킬이 실행 때마다 여기로 복사됩니다.'],
  scratch: ['임시', 'AI의 작업용 파일입니다. 언제 지워도 됩니다.'],
  '.scratch': ['내부', '스코프 스냅샷과 제안 큐입니다. 다음 실행 때 다시 만들어집니다.'],
};

/** The two areas a person actually put things in or takes things out of. */
const USER_AREAS = new Set(['uploads', 'out']);
/** Internal areas whose document-like files are surfaced anyway. */
const SURFACE_FROM = new Set(['scratch', 'scripts']);
const DOCUMENT_EXT = new Set([
  'md', 'markdown', 'txt', 'html', 'htm', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'rtf', 'pdf', 'docx',
]);
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const TEXT_UPLOAD_RE = /\.(md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i;
/** The virtual folder of surfaced documents. */
const DOCS_NODE = '@docs';

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

let built = false;
let seenFilesRev = -1;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let showInternal = false;
let lastListing: FileListing | null = null;
let nodes = new Map<string, Folder>();
let selectedDir = 'uploads';
let selection = new Set<string>();
/** The row clicked last, for Shift ranges. */
let anchorPath = '';
let previewPath = '';
let confirmDelete = false;
let view: 'list' | 'grid' = 'list';
try { if (localStorage.getItem('hina.filesView') === 'grid') view = 'grid'; } catch { /* iframe */ }
const expanded = new Set<string>(['uploads', 'out']);
/** Thumbnail blob URLs by path. */
const thumbs = new Map<string, string>();

export function renderFilesTab(mount: HTMLElement): void {
  if (!state.activeCharKey) {
    clear(mount);
    built = false;
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 “챗 선택” 탭에서 챗을 골라 주세요.' }),
    ]));
    return;
  }

  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree filetree' });
    pane.left.appendChild(treeMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad filepad' });
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(viewMount);
    installDrop(viewMount, () => uploadTarget());
    mount.appendChild(pane.root);
    mountAgent(pane.right.querySelector('.right-inner') as HTMLElement);
    built = true;
    seenFilesRev = state.filesRev;
    void refresh();
  } else if (seenFilesRev !== state.filesRev) {
    // The agent made a file, or one was uploaded or deleted elsewhere, since
    // this view was drawn.
    seenFilesRev = state.filesRev;
    void refresh();
  }
  state.markOutputsSeen();

  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

async function refresh(): Promise<void> {
  if (!treeMount) return;
  try {
    const data = await state.files();
    lastListing = data;
    buildNodes(data);
    if (!nodes.has(selectedDir)) selectedDir = nodes.has('uploads') ? 'uploads' : (nodes.keys().next().value ?? '');
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
  if (!showInternal) {
    const docs: WorkspaceFile[] = [];
    let anyArea: FileArea | null = null;
    for (const area of data.areas) {
      if (!SURFACE_FROM.has(area.area)) continue;
      const mine = area.files.filter(isDocument);
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
  return 'uploads';
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
  let any = false;
  const roots = [...nodes.values()].filter((n) => !n.path.includes('/') && n.path !== DOCS_NODE);
  for (const root of roots) {
    if (!root.area.count && !root.kids.length) continue;
    any = true;
    treeMount.appendChild(nodeRow(root, 0));
  }
  const docs = nodes.get(DOCS_NODE);
  if (docs) { any = true; treeMount.appendChild(nodeRow(docs, 0)); }
  if (!any) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: showInternal ? '파일이 없습니다.' : '올린 파일도 결과물도 아직 없습니다. 파일을 끌어다 놓으면 올라갑니다.',
    }));
  }

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
  const cleanBtn = el('button', { class: 'ghost tiny' });
  armed(cleanBtn, '임시 정리', '정말 정리할까요?', async () => {
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

function nodeRow(n: Folder, depth: number): HTMLElement {
  const isOpen = expanded.has(n.path);
  const caret = el('button', { class: 'caret', text: n.kids.length ? (isOpen ? '▾' : '▸') : '' });
  const count = n.files.length + n.kids.reduce((s, k) => s + countFiles(k), 0);
  const [, why] = AREA_LABEL[n.area.area] ?? ['', ''];
  const branch = el('button', {
    class: 'treebranch' + (n.path === selectedDir ? ' on' : ''),
    title: n.virtual ? `${SURFACE_FROM.size ? 'scratch/·scripts/' : ''} 에 있는 문서입니다. 여기서 바로 볼 수 있습니다.` : (depth ? n.path : why),
  }, [
    el('span', { text: n.virtual ? '📄' : (isOpen && n.kids.length ? '📂' : '📁') }),
    el('span', { class: 'grow', text: n.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
    el('span', { class: 'n', text: String(count) }),
  ]);
  branch.addEventListener('click', () => {
    selectedDir = n.path;
    previewPath = '';
    selection.clear();
    confirmDelete = false;
    if (n.kids.length) expanded.add(n.path);
    drawTree();
    drawCentre();
  });
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (expanded.has(n.path)) expanded.delete(n.path); else expanded.add(n.path);
    drawTree();
  });
  // A folder in the tree is a drop target of its own.
  if (!n.virtual && USER_AREAS.has(n.area.area)) installDrop(branch, () => n.path);

  const kids = el('div', { class: 'treekids', style: { display: isOpen ? '' : 'none' } },
    n.kids.map((k) => nodeRow(k, depth + 1)));
  return el('div', {}, [el('div', { class: 'treerow' }, [caret, branch]), kids]);
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
  const hasImages = n.files.some((f) => IMAGE_RE.test(f.name));
  const [, why] = AREA_LABEL[n.area.area] ?? ['', ''];

  // --- bar ---------------------------------------------------------------------
  const selCount = selection.size;
  const dl = el('button', { class: 'ghost tiny', text: selCount > 1 ? `내려받기 (${selCount}, zip)` : '내려받기', title: '내 PC에 저장합니다. 여러 개나 폴더는 zip 하나로 받습니다.' }) as HTMLButtonElement;
  dl.disabled = !selCount;
  dl.addEventListener('click', () => void downloadSelected(n));
  const mv = el('button', { class: 'ghost tiny', text: '이동', title: '고른 항목을 다른 폴더로 옮깁니다' }) as HTMLButtonElement;
  mv.disabled = !selCount || !deletable;
  mv.addEventListener('click', () => openMove(mv));
  const del = el('button', { class: 'ghost tiny', text: selCount ? `삭제 (${selCount})` : '삭제', title: 'Delete 키로도 됩니다' }) as HTMLButtonElement;
  del.disabled = !selCount || !deletable;
  del.addEventListener('click', () => requestDelete());
  const all = el('button', { class: 'ghost tiny', text: '전체 선택', title: 'Ctrl+A' });
  all.addEventListener('click', () => { selectAll(n); drawCentre(); });
  const viewBtn = el('button', { class: 'ghost tiny', text: view === 'grid' ? '목록 보기' : '미리보기', title: '그림이 있는 폴더는 썸네일로 볼 수 있습니다' });
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

  viewMount.appendChild(el('div', { class: 'filebar' }, [
    el('span', { class: 'filecrumb', text: n.virtual ? '임시 문서' : n.path + '/' }),
    el('span', { class: 'hint', text: `${n.files.length}개` + (n.kids.length ? ` · 폴더 ${n.kids.length}` : '') }),
    el('span', { class: 'spacer' }),
    hasImages ? viewBtn : null,
    all, dl, zipAll, mv, del,
  ]));
  viewMount.appendChild(el('div', { class: 'filehint', text:
    (n.virtual ? 'scratch/·scripts/ 에 AI가 남긴 문서입니다. ' : why + ' ')
    + (writable ? '파일이나 폴더를 여기에 끌어다 놓으면 이 폴더에 올라갑니다 (zip 은 풀어서 올릴 수 있습니다). ' : '')
    + '클릭으로 선택, Ctrl·Shift 로 여러 개, 더블클릭·Enter 로 열기' + (deletable ? ', Delete 로 삭제.' : '.') }));

  const barSlot = el('div', { class: 'fileslot' });
  viewMount.appendChild(barSlot);
  if (confirmDelete && selCount && deletable) barSlot.appendChild(confirmBar(n));

  // --- rows ----------------------------------------------------------------------
  const list = el('div', { class: 'filelist', tabindex: '0' });
  const entries: { path: string; name: string; file?: WorkspaceFile; node?: Folder }[] = [
    ...n.kids.map((k) => ({ path: k.path, name: k.name, node: k })),
    ...n.files.map((f) => ({ path: f.path, name: f.name, file: f })),
  ];
  if (!entries.length) {
    list.appendChild(el('div', { class: 'fempty', text: writable ? '비어 있습니다. 파일을 끌어다 놓거나 왼쪽 “올리기”를 누르세요.' : '비어 있습니다.' }));
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
      if (confirmDelete) void runDelete(n); else requestDelete();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = [...selection][0];
      if (first) openEntry(first, n);
    } else if (e.key === 'Escape') {
      selection.clear();
      confirmDelete = false;
      drawCentre();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll(n);
      drawCentre();
    }
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
  confirmDelete = false;
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
    el('span', { class: 'fname' }, [
      el('span', { class: 'ficon', text: e.node ? '📁' : icon(e.name) }),
      el('span', { text: e.name }),
    ]),
    el('span', { class: 'fsize', text: e.file ? fmtSize(e.file.size) : `${countFiles(e.node!)}개` }),
    el('span', { class: 'ftime', text: e.file ? fmtWhen(e.file.modified) : '' }),
  ]);
  box.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (box.checked) selection.add(e.path); else selection.delete(e.path);
    anchorPath = e.path;
    confirmDelete = false;
    drawCentre();
    focusList();
  });
  row.addEventListener('click', (ev) => { pick(e.path, ev as MouseEvent, order); drawCentre(); focusList(); });
  row.addEventListener('dblclick', () => openEntry(e.path, n));
  return row;
}

function gridCell(e: { path: string; name: string; file?: WorkspaceFile; node?: Folder }, order: { path: string }[], n: Folder): HTMLElement {
  const pic = el('div', { class: 'assetpic' });
  const cell = el('div', { class: 'fcell' + (selection.has(e.path) ? ' sel' : ''), title: e.path }, [
    pic,
    el('div', { class: 'fname', text: e.name }),
    el('div', { class: 'fsize', text: e.file ? fmtSize(e.file.size) : `폴더 · ${countFiles(e.node!)}개` }),
  ]);
  if (e.node) pic.appendChild(el('div', { class: 'assettype', text: '📁' }));
  else if (e.file && IMAGE_RE.test(e.name)) void loadThumb(e.file, pic);
  else pic.appendChild(el('div', { class: 'assettype', text: (e.name.split('.').pop() || '?').toUpperCase().slice(0, 5) }));
  cell.addEventListener('click', (ev) => { pick(e.path, ev as MouseEvent, order); drawCentre(); focusList(); });
  cell.addEventListener('dblclick', () => openEntry(e.path, n));
  return cell;
}

function focusList(): void {
  (viewMount?.querySelector('.filelist') as HTMLElement | null)?.focus();
}

// Thumbnails: a few at a time, from the backend's own copy of the file.
const THUMB_PARALLEL = 6;
let thumbActive = 0;
const thumbQueue: (() => void)[] = [];
async function loadThumb(f: WorkspaceFile, mount: HTMLElement): Promise<void> {
  let url = thumbs.get(f.path + ':' + f.modified) || '';
  if (!url) {
    await new Promise<void>((resolve) => {
      const go = () => { thumbActive += 1; resolve(); };
      if (thumbActive < THUMB_PARALLEL) go(); else thumbQueue.push(go);
    });
    try {
      if (!mount.isConnected) return;
      const bytes = await state.fileBytes(f.path);
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      url = URL.createObjectURL(new Blob([buf]));
      if (thumbs.size > 400) {
        for (const [k, u] of thumbs) { URL.revokeObjectURL(u); thumbs.delete(k); break; }
      }
      thumbs.set(f.path + ':' + f.modified, url);
    } catch {
      mount.appendChild(el('div', { class: 'assettype', text: '?' }));
      return;
    } finally {
      thumbActive -= 1;
      thumbQueue.shift()?.();
    }
  }
  if (!mount.isConnected) return;
  const img = el('img', { src: url, alt: f.name, loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: 'assettype', text: 'IMG' })));
  mount.appendChild(img);
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
      const bytes = await state.fileBytes(f.path);
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      const url = URL.createObjectURL(new Blob([buf]));
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
    body.appendChild(el('pre', { class: 'mono filepreview', text: r.content || r.note || '(비어 있습니다)' }));
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

// --- delete · move · download ----------------------------------------------------

function requestDelete(): void {
  const n = nodes.get(selectedDir);
  if (!n || !selection.size) return;
  if (!n.area.deletable) { notice(`${n.name} 안의 파일은 지울 수 없습니다.`); return; }
  confirmDelete = true;
  drawCentre();
  focusList();
}

function confirmBar(n: Folder): HTMLElement {
  const yes = el('button', { class: 'danger tiny', text: '삭제' });
  const no = el('button', { class: 'ghost tiny', text: '취소' });
  yes.addEventListener('click', () => void runDelete(n));
  no.addEventListener('click', () => { confirmDelete = false; drawCentre(); focusList(); });
  const names = [...selection].map((p) => p.slice(p.lastIndexOf('/') + 1));
  return el('div', { class: 'confirmbar' }, [
    el('span', { text: `${selection.size}개를 지울까요? ` + names.slice(0, 3).join(', ') + (names.length > 3 ? ' …' : '') }),
    el('span', { class: 'hint', text: '(Delete 를 한 번 더 누르면 지웁니다)' }),
    el('span', { class: 'spacer' }),
    yes, no,
  ]);
}

async function runDelete(n: Folder): Promise<void> {
  const paths = [...selection];
  confirmDelete = false;
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
  seenFilesRev = state.filesRev;
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
      seenFilesRev = state.filesRev;
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

interface Incoming { file: File; rel: string }

/** Drag-and-drop onto `target`; `into()` is read at drop time. */
function installDrop(target: HTMLElement, into: () => string): void {
  for (const kind of ['dragover', 'dragenter']) {
    target.addEventListener(kind, (e) => {
      const dt = (e as DragEvent).dataTransfer;
      if (!dt || !Array.from(dt.types).includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      target.classList.add('dropping');
    });
  }
  target.addEventListener('dragleave', (e) => {
    if (!target.contains((e as DragEvent).relatedTarget as globalThis.Node | null)) target.classList.remove('dropping');
  });
  target.addEventListener('drop', async (e) => {
    const dt = (e as DragEvent).dataTransfer;
    target.classList.remove('dropping');
    if (!dt) return;
    e.preventDefault();
    e.stopPropagation();
    const files = await collectDrop(dt);
    if (files.length) void uploadMany(files, into());
  });
}

/** Files from a drop, folders walked so their structure comes along. */
async function collectDrop(dt: DataTransfer): Promise<Incoming[]> {
  const out: Incoming[] = [];
  const items = Array.from(dt.items ?? []);
  const entries = items
    .map((it) => (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.() ?? null)
    .filter((x): x is FileSystemEntry => !!x);
  if (!entries.length) {
    for (const file of Array.from(dt.files)) out.push({ file, rel: '' });
    return out;
  }
  const walk = async (entry: FileSystemEntry, rel: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, rel });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const sub = rel ? rel + '/' + entry.name : entry.name;
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child, sub);
      }
    }
  };
  for (const entry of entries) await walk(entry, '');
  return out;
}

/**
 * Upload a batch into `into` (a folder under uploads/ or out/), one request
 * per file, reporting progress in the centre. Zips are asked about first:
 * unpacked into a folder named after them, or stored as they are.
 */
async function uploadMany(files: Incoming[], into: string): Promise<void> {
  if (!viewMount) return;
  const zips = files.filter((f) => /\.zip$/i.test(f.file.name));
  const plain = files.filter((f) => !/\.zip$/i.test(f.file.name));
  let extractZips: boolean | null = zips.length ? null : false;
  if (zips.length) {
    extractZips = await new Promise<boolean | null>((resolve) => {
      const ask = el('div', { class: 'zipask' });
      const unpack = el('button', { class: 'primary tiny', text: '풀어서 올리기' });
      const keep = el('button', { class: 'ghost tiny', text: 'zip 그대로 올리기' });
      const cancel = el('button', { class: 'ghost tiny', text: '취소' });
      unpack.addEventListener('click', () => { ask.remove(); resolve(true); });
      keep.addEventListener('click', () => { ask.remove(); resolve(false); });
      cancel.addEventListener('click', () => { ask.remove(); resolve(null); });
      ask.append(
        el('span', { text: `zip ${zips.length}개 (${zips.map((z) => z.file.name).slice(0, 3).join(', ')}${zips.length > 3 ? ' …' : ''}) —` }),
        unpack, keep, cancel,
      );
      (viewMount?.querySelector('.fileslot') ?? viewMount)?.prepend(ask);
    });
    if (extractZips === null && !plain.length) return;
  }
  const todo = extractZips === null ? plain : [...plain, ...zips];
  const prog = el('div', { class: 'uploadprog' });
  (viewMount.querySelector('.fileslot') ?? viewMount).prepend(prog);
  let done = 0;
  let failed = 0;
  let extracted = 0;
  for (const { file, rel } of todo) {
    prog.textContent = `올리는 중 ${done + failed + 1}/${todo.length} — ${file.name}`;
    const dir = rel ? into + '/' + rel : into;
    try {
      const r = await uploadOne(file, dir, !!extractZips && /\.zip$/i.test(file.name));
      done += 1;
      if (r.extracted) extracted += r.extracted;
    } catch (e) {
      failed += 1;
      notice(`${file.name}: ` + msg(e), 'err');
    }
  }
  prog.remove();
  notice(`${done}개를 ${into}/ 에 올렸습니다.` + (extracted ? ` (zip 에서 ${extracted}개 풀림)` : '') + (failed ? ` 실패 ${failed}개.` : ''), failed ? 'err' : 'ok');
  if (nodes.has(into)) { selectedDir = into; expandTo(into); }
  state.touchFiles();
  seenFilesRev = state.filesRev;
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

function icon(name: string): string {
  if (IMAGE_RE.test(name)) return '🖼';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'charx' || ext === 'zip') return '🗜';
  if (['md', 'txt', 'rtf', 'docx', 'pdf'].includes(ext)) return '📄';
  if (['py', 'js', 'ts', 'lua', 'html', 'css', 'json', 'yaml', 'yml', 'xml'].includes(ext)) return '📜';
  if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return '🎵';
  if (['mp4', 'webm'].includes(ext)) return '🎬';
  return '📎';
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
