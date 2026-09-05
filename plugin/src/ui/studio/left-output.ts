/**
 * The left OUTPUT tab: the studio/output tree, rendered by the shared tree
 * component so it looks and behaves like the file tab's tree (glyphs,
 * selection highlight, drop outline) instead of a column of bordered buttons.
 * §1-30: the file tab's right-click folder verbs live here too - 새 폴더,
 * rename, copy/cut/paste (a studio-side clipboard), path, zip, delete.
 */
import { state } from '../../state';
import { el, menuAt } from '../dom';
import { askName } from '../kit';
import { openListPicker } from '../pickers';
import { copyToClipboard } from '../../host';
import { treeRow, type TreeNode, type TreeSpec } from '../tree';
import { S, hub, countFiles, fmtSize, msg, persistCentreTab, persistLeftTab,
         addExtra, removeExtra, IMAGE_RE, type Folder } from './store';

/** The studio's clipboard (paths only; bytes stay on the backend) - shared
 * by the OUTPUT tree and the 정리 grid (§1-35). */
let clip: { op: 'copy' | 'cut'; paths: string[] } | null = null;

export function setClip(op: 'copy' | 'cut', paths: string[]): void {
  clip = paths.length ? { op, paths } : null;
  if (clip) {
    hub.notice(`${paths.length}개를 ${op === 'copy' ? '복사' : '잘라내기'}했습니다 — 붙여넣을 폴더에서 Ctrl+V 또는 우클릭.`);
  }
  hub.drawLeft();
}

export function hasClip(): boolean {
  return !!clip;
}

/** ' clipcut' | ' clipcopy' | '' for a path on the clipboard. */
export function clipClass(path: string): string {
  if (!clip || !clip.paths.includes(path)) return '';
  return clip.op === 'cut' ? ' clipcut' : ' clipcopy';
}

function toTreeNode(n: Folder): TreeNode {
  return {
    path: n.path,
    name: n.name,
    kids: n.children.map(toTreeNode),
    count: countFiles(n),
    title: n.path,
    droppable: true,
    cls: clipClass(n.path).trim() || undefined,
  };
}

/** Whether a path is one of the tree roots (OUTPUT or a pin): no cut/copy. */
function isRoot(path: string): boolean {
  return path === (S.outputRoot?.path ?? 'studio/output') || S.extraRoots.some((r) => r.path === path);
}

/** Ctrl+C / Ctrl+X on the selected folder, Ctrl+V into it (§1-35). */
function onTreeKey(ev: KeyboardEvent): void {
  const ctrl = ev.ctrlKey || ev.metaKey;
  if (!ctrl) return;
  const k = ev.key.toLowerCase();
  const sel = S.selected;
  if ((k === 'c' || k === 'x') && sel && !isRoot(sel)) {
    ev.preventDefault();
    setClip(k === 'c' ? 'copy' : 'cut', [sel]);
  } else if (k === 'v' && clip && sel) {
    ev.preventDefault();
    void pasteIn(sel);
  }
}

function spec(): TreeSpec {
  return {
    expanded: S.open,
    // The highlight follows the folder only while the centre shows it.
    selected: new Set(S.selectedFile ? [] : [S.selected]),
    onOpen(node) {
      openFolder(node);
    },
    onContext(node, ev) {
      openOutputMenu(node, ev);
    },
    onToggle(node) {
      if (S.open.has(node.path)) S.open.delete(node.path); else S.open.add(node.path);
      hub.drawLeft();
    },
    // Rows dragged from the centre grid land in a folder here.
    onDropMove(path, sources) {
      void (async () => {
        const list = sources.filter((src) => src !== path && !path.startsWith(src + '/'));
        if (!list.length) return;
        try {
          const r = await state.moveFiles(list, path);
          if (r.failed.length) hub.notice(`${r.done}개 이동, ${r.failed.length}개는 건너뜀 — ${r.failed[0].error}`, 'err');
          hub.touchQuiet();
          await hub.refresh();
        } catch (e) {
          hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
        }
      })();
    },
  };
}

/** A folder click opens the 검수 tab on it (the tidy-up grid is one button
 * away there). */
function openFolder(node: TreeNode): void {
  if (node.kids.length) S.open.add(node.path);
  S.selected = node.path;
  S.selectedFile = '';
  S.centreMode = 'tab';
  S.centreTab = 'inspect';
  persistCentreTab();
  hub.drawLeft();
  hub.drawCentre();
}

function openOutputMenu(node: TreeNode, ev: MouseEvent): void {
  const isRoot = node.path === (S.outputRoot?.path ?? 'studio/output');
  menuAt(ev.clientX, ev.clientY, [
    { label: '검수 열기', onClick: () => openFolder(node) },
    { label: '새 폴더', onClick: () => newFolderIn(node.path) },
    { label: '이름 바꾸기', disabled: isRoot, onClick: () => renameFolder(node) },
    null,
    { label: '복사', disabled: isRoot,
      onClick: () => { clip = { op: 'copy', paths: [node.path] }; hub.notice('복사했습니다 — 붙여넣을 폴더에서 우클릭하세요.'); } },
    { label: '잘라내기', disabled: isRoot,
      onClick: () => { clip = { op: 'cut', paths: [node.path] }; hub.notice('잘라냈습니다 — 붙여넣을 폴더에서 우클릭하세요.'); } },
    { label: clip ? `붙여넣기 (${clip.paths.length})` : '붙여넣기', disabled: !clip,
      onClick: () => void pasteIn(node.path) },
    null,
    { label: '경로 복사', onClick: () => { copyToClipboard(node.path); hub.notice('경로를 복사했습니다.', 'ok'); } },
    { label: '내려받기 (zip)', onClick: () => void zipFolder(node.path) },
    null,
    // The two-step confirm as a second one-item menu: no window.confirm in
    // the sandboxed iframe (the file tree's convention).
    { label: '삭제…', danger: true, disabled: isRoot, onClick: () => confirmDelete(node.path, ev) },
  ]);
}

function newFolderIn(where: string): void {
  askName('새 폴더', {
    label: `${where}/ 안에`,
    placeholder: '폴더 이름',
    ok: '만들기',
    onSubmit: async (raw) => {
      const nm = raw.trim().replace(/[\\/]+/g, '-');
      if (!nm) return;
      try {
        await state.mkdirFile(where + '/' + nm);
        S.open.add(where);
        hub.touchQuiet();
        await hub.refresh();
      } catch (e) {
        hub.notice('만들지 못했습니다: ' + msg(e), 'err');
      }
    },
  });
}

function renameFolder(node: TreeNode): void {
  askName('이름 바꾸기', {
    label: `${node.name} → 새 이름`,
    value: node.name,
    ok: '바꾸기',
    onSubmit: async (raw) => {
      const nm = raw.trim().replace(/[\\/]+/g, '-');
      if (!nm || nm === node.name) return;
      const dir = node.path.slice(0, node.path.lastIndexOf('/'));
      try {
        const r = await state.moveFile(node.path, dir + '/' + nm);
        if (S.selected === node.path || S.selected.startsWith(node.path + '/')) S.selected = r.to;
        hub.touchQuiet();
        await hub.refresh();
      } catch (e) {
        hub.notice('바꾸지 못했습니다: ' + msg(e), 'err');
      }
    },
  });
}

export async function pasteIn(target: string): Promise<void> {
  const c = clip;
  if (!c) return;
  const list = c.paths.filter((q) => q !== target && !target.startsWith(q + '/'));
  if (!list.length) return;
  try {
    const r = c.op === 'copy' ? await state.copyFiles(list, target) : await state.moveFiles(list, target);
    hub.notice(r.failed.length
      ? `${r.done}개 처리, ${r.failed.length}개는 건너뜀 — ${r.failed[0].error}`
      : `${r.done}개를 ${target}/ 에 ${c.op === 'copy' ? '복사' : '이동'}했습니다.`,
      r.failed.length ? 'err' : 'ok');
  } catch (e) {
    hub.notice('처리하지 못했습니다: ' + msg(e), 'err');
  }
  if (c.op === 'cut') clip = null;
  hub.touchQuiet();
  await hub.refresh();
}

async function zipFolder(path: string): Promise<void> {
  try {
    const bytes = await state.downloadZip([path], path.split('/').pop() ?? 'output');
    hub.notice(`${fmtSize(bytes)} zip 을 브라우저 다운로드로 넘겼습니다.`, 'ok');
  } catch (e) {
    hub.notice('내려받지 못했습니다: ' + msg(e), 'err');
  }
}

function confirmDelete(path: string, ev: { clientX: number; clientY: number }): void {
  menuAt(ev.clientX, ev.clientY, [
    { label: '정말 삭제 (폴더째, 안의 파일 포함)', danger: true, onClick: () => void doDelete(path) },
  ]);
}

async function doDelete(path: string): Promise<void> {
  try {
    const r = await state.deleteFiles([path]);
    hub.notice(r.failed.length ? `지우지 못했습니다 — ${r.failed[0].error}` : '지웠습니다.',
               r.failed.length ? 'err' : 'ok');
  } catch (e) {
    hub.notice('지우지 못했습니다: ' + msg(e), 'err');
  }
  if (S.selected === path || S.selected.startsWith(path + '/')) S.selected = S.outputRoot?.path ?? 'studio/output';
  hub.touchQuiet();
  await hub.refresh();
}

export function buildLeftOutput(mount: HTMLElement): void {
  if (!S.outputRoot) return;
  // Keyboard verbs on the tree (a property, not addEventListener: the mount
  // outlives every rebuild and must carry exactly one handler).
  mount.tabIndex = 0;
  mount.onkeydown = onTreeKey;
  mount.appendChild(treeRow(toTreeNode(S.outputRoot), 0, spec()));

  // --- folders outside OUTPUT, pinned for 검수 (§1-33) ---------------------------
  // A project's picture folder or an agent batch that landed elsewhere is
  // reviewed the same way; the pin only says where to look.
  const pick = el('button', { class: 'ghost tiny', text: '폴더 열기…',
    title: 'OUTPUT 밖의 폴더를 검수 목록에 넣습니다 (프로젝트·AI 내부 등)' });
  pick.addEventListener('click', () => openFolderPicker());
  mount.appendChild(el('div', { class: 'row extrahead' }, [
    el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '다른 폴더' }), pick,
  ]));
  if (!S.extraRoots.length) {
    mount.appendChild(el('div', { class: 'hint', style: { padding: '2px 8px 6px' },
      text: '파일 탭에서 폴더를 우클릭해 “검수 열기”를 눌러도 여기 들어옵니다.' }));
  }
  const extraSpec: TreeSpec = { ...spec(), onContext(node, ev) { openExtraMenu(node, ev); } };
  for (const r of S.extraRoots) mount.appendChild(treeRow(toTreeNode(r), 0, extraSpec));
}

function openExtraMenu(node: TreeNode, ev: MouseEvent): void {
  const isPin = S.extraRoots.some((r) => r.path === node.path);
  menuAt(ev.clientX, ev.clientY, [
    { label: '검수 열기', onClick: () => openFolder(node) },
    { label: '경로 복사', onClick: () => { copyToClipboard(node.path); hub.notice('경로를 복사했습니다.', 'ok'); } },
    { label: '내려받기 (zip)', onClick: () => void zipFolder(node.path) },
    null,
    { label: '목록에서 빼기', disabled: !isPin, onClick: () => {
      removeExtra(node.path);
      if (S.selected === node.path || S.selected.startsWith(node.path + '/')) S.selected = S.outputRoot?.path ?? 'studio/output';
      hub.drawLeft();
      hub.drawCentre();
    } },
  ]);
}

/** The picker: every folder in the space that directly holds pictures,
 * OUTPUT excluded (those are in the tree already). One listing call. */
export function openFolderPicker(): void {
  openListPicker({
    title: '검수할 폴더',
    hint: '그림이 든 폴더만 보입니다. 고르면 왼쪽 “다른 폴더”에 들어가고 검수가 열립니다.',
    selectedLabel: '열림',
    async load() {
      const listing = await state.files('', true);
      const counts = new Map<string, number>();
      for (const a of listing.areas) {
        for (const f of a.files) {
          if (!IMAGE_RE.test(f.name) || !f.path.includes('/')) continue;
          const dir = f.path.slice(0, f.path.lastIndexOf('/'));
          if (dir === 'studio/output' || dir.startsWith('studio/output/')) continue;
          if (dir.startsWith('studio/config/')) continue;
          counts.set(dir, (counts.get(dir) ?? 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dir, n]) => ({
        id: dir, name: dir, hint: `${n}장`, selected: S.extraRoots.some((r) => r.path === dir),
      }));
    },
    async onSelect(entry) {
      addExtra(entry.id);
      // The tree needs the folder's own listing: a full refresh reads it.
      S.selected = entry.id;
      S.selectedFile = '';
      S.centreMode = 'tab';
      S.centreTab = 'inspect';
      S.leftTab = 'output';
      persistCentreTab();
      persistLeftTab();
      await hub.refresh();
    },
  });
}
