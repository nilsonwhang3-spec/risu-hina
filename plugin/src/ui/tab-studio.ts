/**
 * 에셋 스튜디오 - the image library, and the one tab that is not about a bot.
 *
 * Every other tab edits the bot RisuAI has open. This one edits a library that
 * outlives any of them: you generate images, sort them, and only then decide
 * which bot gets them. So it renders with **no bot selected at all** - the
 * shell already survives that state (readHost only sets slotError), and it is
 * the per-tab render functions that bail. This one does not.
 *
 *   left    the library's folders, as a tree
 *   centre  what the selected folder holds - a grid for pictures, a list
 *           otherwise
 *   right   Hina, as on every tab
 *
 * The files come from the same endpoints the workspace uses, addressed with
 * `studio: true` (`state.studio`, `app/files.py`). Nothing here reimplements
 * listing, upload, move or delete.
 *
 * A bot IS needed to *adopt* an image into a card - that is gated per action,
 * where it is true, rather than on the whole tab.
 */
import { el, clear, armed } from './dom';
import { state, type FileListing, type WorkspaceFile } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

/** Areas in the order a person works through them; label for each. */
const AREA_LABEL: Record<string, string> = {
  images: '생성물',
  characters: '캐릭터',
  styles: '스타일',
  emotions: '감정 프리셋',
  fragments: '조각',
  presets: '생성 프리셋',
};

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

interface Folder {
  path: string;
  name: string;
  children: Folder[];
  files: WorkspaceFile[];
}

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let listing: FileListing | null = null;
let roots: Folder[] = [];
let selected = 'images';
const open = new Set<string>(['images']);
const thumbs = new Map<string, string>();

export function renderStudioTab(mount: HTMLElement): void {
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree filetree' });
    pane.left.appendChild(treeMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(noticeMount, viewMount);
    mount.appendChild(pane.root);
    built = true;
    void refresh();
  }
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 8000);
}

export async function refresh(): Promise<void> {
  try {
    listing = await state.studio.list();
  } catch (e) {
    listing = null;
    drawTree();
    if (viewMount) {
      clear(viewMount);
      viewMount.appendChild(el('div', { class: 'notice err' }, [
        el('div', { text: '스튜디오 라이브러리를 읽지 못했습니다.' }),
        el('div', { class: 'hint', text: e instanceof Error ? e.message : String(e) }),
        el('div', { class: 'hint', text: '설정 → 연결에서 백엔드 상태를 확인해 주세요.' }),
      ]));
    }
    return;
  }
  build();
  drawTree();
  drawCentre();
}

/** The listing's flat paths into a tree, one root per area. */
function build(): void {
  roots = [];
  if (!listing) return;
  for (const area of listing.areas) {
    if (area.area.startsWith('.')) continue;  // ours, not the user's
    const root: Folder = { path: area.area, name: AREA_LABEL[area.area] ?? area.area, children: [], files: [] };
    const byPath = new Map<string, Folder>([[area.area, root]]);
    const folder = (path: string): Folder => {
      const hit = byPath.get(path);
      if (hit) return hit;
      const cut = path.lastIndexOf('/');
      const node: Folder = { path, name: path.slice(cut + 1), children: [], files: [] };
      byPath.set(path, node);
      folder(path.slice(0, cut)).children.push(node);
      return node;
    };
    for (const d of area.dirs ?? []) folder(d);
    for (const f of area.files) {
      const cut = f.path.lastIndexOf('/');
      folder(f.path.slice(0, cut)).files.push(f);
    }
    roots.push(root);
  }
  // Keep the order of AREA_LABEL - it is the order a person works through.
  const rank = Object.keys(AREA_LABEL);
  roots.sort((a, b) => rank.indexOf(a.path) - rank.indexOf(b.path));
}

function find(path: string, nodes = roots): Folder | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    const hit = find(path, n.children);
    if (hit) return hit;
  }
  return null;
}

function countFiles(n: Folder): number {
  return n.files.length + n.children.reduce((sum, c) => sum + countFiles(c), 0);
}

function drawTree(): void {
  if (!treeMount) return;
  clear(treeMount);
  if (!roots.length) {
    treeMount.appendChild(el('div', { class: 'hint', style: { padding: '10px' }, text: '라이브러리가 비어 있습니다.' }));
    return;
  }
  for (const r of roots) treeMount.appendChild(row(r, 0));
}

function row(n: Folder, depth: number): HTMLElement {
  const wrap = el('div');
  const isOpen = open.has(n.path);
  const kids = n.children.length > 0;
  const caret = el('span', { class: 'caret', text: kids ? (isOpen ? '▾' : '▸') : '' });
  const line = el('button', {
    class: 'treerow' + (selected === n.path ? ' on' : ''),
    style: { paddingLeft: 6 + depth * 12 + 'px' },
    title: n.path,
  }, [
    caret,
    el('span', { class: 'grow', text: n.name }),
    el('span', { class: 'n', text: String(countFiles(n)) }),
  ]);
  line.addEventListener('click', () => {
    if (kids) { if (isOpen) open.delete(n.path); else open.add(n.path); }
    selected = n.path;
    drawTree();
    drawCentre();
  });
  wrap.appendChild(line);
  if (isOpen) for (const c of n.children) wrap.appendChild(row(c, depth + 1));
  return wrap;
}

function drawCentre(): void {
  if (!viewMount) return;
  clear(viewMount);
  const node = find(selected);
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
    viewMount.appendChild(el('div', { class: 'empty', text: emptyHint(node.path) }));
    return;
  }

  // Pictures read as a grid and everything else as a list: a folder of three
  // hundred generations is unusable as filenames, and a folder of prompt
  // files is unusable as blank thumbnails.
  const pictures = node.files.filter((f) => IMAGE_RE.test(f.name));
  if (pictures.length && pictures.length >= node.files.length / 2) {
    const grid = el('div', { class: 'agrid' });
    for (const f of node.files) grid.appendChild(cell(f));
    viewMount.appendChild(grid);
  } else {
    const list = el('div', { class: 'filelist' });
    for (const f of node.files) list.appendChild(listRow(f));
    viewMount.appendChild(list);
  }
}

function emptyHint(area: string): string {
  const root = area.split('/')[0];
  if (root === 'images') return '아직 생성물이 없습니다. 이미지를 여기에 넣거나 히나에게 생성을 부탁하세요.';
  if (root === 'emotions') return '감정 프리셋이 없습니다 — 감정 이름 → 프롬프트 조각을 담은 JSON 입니다.';
  if (root === 'characters') return '캐릭터가 없습니다 — 프롬프트와 레퍼런스 이미지를 함께 둡니다.';
  return '비어 있습니다.';
}

function newFolderButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '＋ 폴더' }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    const name = (prompt('새 폴더 이름', '') || '').trim();
    if (!name) return;
    b.disabled = true;
    void state.studio.mkdir(node.path + '/' + name)
      .then(() => { open.add(node.path); return refresh(); })
      .catch((e) => notice('폴더를 만들지 못했습니다: ' + msg(e), 'err'))
      .finally(() => { b.disabled = false; });
  });
  return b;
}

function listRow(f: WorkspaceFile): HTMLElement {
  const del = el('button', { class: 'ghost tiny', title: '삭제' }) as HTMLButtonElement;
  const rowEl = el('div', { class: 'chatitem' }, [
    el('span', { class: 'grow', text: f.name }),
    el('span', { class: 'n', text: fmtSize(f.size) }),
    del,
  ]);
  armed(del, '✕', '삭제 확인', async () => {
    del.disabled = true;
    try {
      await state.studio.remove(f.path);
      await refresh();
    } catch (e) {
      del.disabled = false;
      notice('지우지 못했습니다: ' + msg(e), 'err');
    }
  });
  return rowEl;
}

function cell(f: WorkspaceFile): HTMLElement {
  const pic = el('div', { class: 'assetpic' });
  const c = el('div', { class: 'fcell', title: f.path }, [
    pic,
    el('div', { class: 'fname', text: f.name }),
    el('div', { class: 'fsize', text: fmtSize(f.size) }),
  ]);
  if (IMAGE_RE.test(f.name)) void loadThumb(f, pic);
  else pic.appendChild(el('div', { class: 'assettype', text: (f.name.split('.').pop() || '?').toUpperCase().slice(0, 5) }));
  return c;
}

// Thumbnails, a few at a time, from the backend's copy - the same shape and
// the same reason as the files tab: POST so an intermediate cache cannot
// answer every key with one body (docs/06 §1-7).
const THUMB_PARALLEL = 6;
let thumbActive = 0;
const thumbQueue: (() => void)[] = [];

async function loadThumb(f: WorkspaceFile, mount: HTMLElement): Promise<void> {
  const key = f.path + ':' + f.modified;
  let url = thumbs.get(key) || '';
  if (!url) {
    await new Promise<void>((resolve) => {
      const go = () => { thumbActive += 1; resolve(); };
      if (thumbActive < THUMB_PARALLEL) go(); else thumbQueue.push(go);
    });
    try {
      if (!mount.isConnected) return;
      const bytes = await state.studio.bytes(f.path);
      // Copy: a SharedArrayBuffer-backed view is refused by Blob.
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      url = URL.createObjectURL(new Blob([buf]));
      if (thumbs.size > 400) {
        for (const [k, u] of thumbs) { URL.revokeObjectURL(u); thumbs.delete(k); break; }
      }
      thumbs.set(key, url);
    } catch {
      mount.appendChild(el('div', { class: 'assettype', text: '?' }));
      return;
    } finally {
      thumbActive -= 1;
      thumbQueue.shift()?.();
    }
  }
  if (!mount.isConnected) return;
  clear(mount);
  const img = el('img', { class: 'assetimg', src: url, alt: '' });
  img.addEventListener('error', () => {
    clear(mount);
    mount.appendChild(el('div', { class: 'assettype', text: '?' }));
  });
  mount.appendChild(img);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
