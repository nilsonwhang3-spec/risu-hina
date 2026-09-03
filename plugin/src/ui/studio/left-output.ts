/**
 * The left OUTPUT tab: the studio/output tree, rendered by the shared tree
 * component so it looks and behaves like the file tab's tree (glyphs,
 * selection highlight, drop outline) instead of a column of bordered buttons.
 * §1-30: the file tab's right-click folder verbs live here too - 새 폴더,
 * rename, copy/cut/paste (a studio-side clipboard), path, zip, delete.
 */
import { state } from '../../state';
import { menuAt } from '../dom';
import { askName } from '../kit';
import { copyToClipboard } from '../../host';
import { treeRow, type TreeNode, type TreeSpec } from '../tree';
import { S, hub, countFiles, fmtSize, msg, persistCentreTab, type Folder } from './store';

/** The OUTPUT tree's own clipboard (paths only; bytes stay on the backend). */
let clip: { op: 'copy' | 'cut'; paths: string[] } | null = null;

function toTreeNode(n: Folder): TreeNode {
  return {
    path: n.path,
    name: n.name,
    kids: n.children.map(toTreeNode),
    count: countFiles(n),
    title: n.path,
    droppable: true,
  };
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

async function pasteIn(target: string): Promise<void> {
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
  mount.appendChild(treeRow(toTreeNode(S.outputRoot), 0, spec()));
}
