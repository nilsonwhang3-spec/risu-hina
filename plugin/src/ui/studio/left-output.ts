/**
 * The left OUTPUT tab: the studio/images tree, rendered by the shared tree
 * component so it looks and behaves like the file tab's tree (glyphs,
 * selection highlight, drop outline) instead of a column of bordered buttons.
 */
import { state } from '../../state';
import { treeRow, type TreeNode, type TreeSpec } from '../tree';
import { S, hub, countFiles, msg, type Folder } from './store';

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
    selected: S.selectedFile ? '' : S.selected,
    onOpen(node) {
      if (node.kids.length) S.open.add(node.path);
      S.selected = node.path;
      S.selectedFile = '';
      S.queueView = false;
      S.fragmentsView = false;
      hub.drawLeft();
      hub.drawCentre();
    },
    onToggle(node) {
      if (S.open.has(node.path)) S.open.delete(node.path); else S.open.add(node.path);
      hub.drawLeft();
    },
    // Rows dragged from the centre grid land in a folder here.
    onDropMove(path, sources) {
      void (async () => {
        try {
          for (const src of sources) {
            if (src === path || path.startsWith(src + '/')) continue;
            await state.moveFile(src, path);
          }
          hub.touchQuiet();
          await hub.refresh();
        } catch (e) {
          hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
        }
      })();
    },
  };
}

export function buildLeftOutput(mount: HTMLElement): void {
  if (!S.outputRoot) return;
  mount.appendChild(treeRow(toTreeNode(S.outputRoot), 0, spec()));
}
