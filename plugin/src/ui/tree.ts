/**
 * The folder tree and its drop wiring, extracted from the file tab so the
 * studio's output tree renders (and behaves) the same way: one row is a
 * `div.treerow` holding a caret button and a `button.treebranch` with glyph ·
 * name · count pill, children in a `div.treekids`. The CSS in styles.ts is
 * written for exactly this shape - a tree built any other way silently loses
 * the selection highlight and the drop outline.
 *
 * Drops carry two things: OS files (uploaded), and rows dragged inside the
 * app (moved). The latter travel as a JSON array of workspace paths under
 * the DRAG_PATHS dataTransfer type.
 */
import { el } from './dom';

/** The dataTransfer type for internal drags: JSON array of workspace paths. */
export const DRAG_PATHS = 'text/x-hina-paths';

export interface Incoming { file: File; rel: string }

export interface TreeNode {
  path: string;
  name: string;
  kids: TreeNode[];
  /** The count pill; null hides it. */
  count?: number | null;
  /** Emoji override; default 📁/📂 by open state, 📄 never implied. */
  glyph?: string;
  title?: string;
  /** Whether this folder accepts drops (uploads and internal moves). */
  droppable?: boolean;
}

export interface TreeSpec {
  /** Caller-owned; the tree only reads it. Toggling happens in onToggle. */
  expanded: Set<string>;
  selected: string;
  onOpen(node: TreeNode): void;
  onToggle(node: TreeNode): void;
  /** OS files dropped on a droppable folder row. */
  onDropFiles?(path: string, files: Incoming[]): void;
  /** Internal rows dropped on a droppable folder row. */
  onDropMove?(path: string, sources: string[]): void;
}

/** One folder row plus its (possibly hidden) children, recursively. */
export function treeRow(n: TreeNode, depth: number, spec: TreeSpec): HTMLElement {
  const isOpen = spec.expanded.has(n.path);
  const caret = el('button', { class: 'caret', text: n.kids.length ? (isOpen ? '▾' : '▸') : '' });
  const branch = el('button', {
    class: 'treebranch' + (n.path === spec.selected ? ' on' : ''),
    title: n.title ?? n.path,
  }, [
    el('span', { text: n.glyph ?? (isOpen && n.kids.length ? '📂' : '📁') }),
    el('span', { class: 'grow', text: n.name, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }),
    n.count == null ? null : el('span', { class: 'n', text: String(n.count) }),
  ]);
  branch.addEventListener('click', () => spec.onOpen(n));
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    spec.onToggle(n);
  });
  if (n.droppable && (spec.onDropFiles || spec.onDropMove)) {
    installDrop(branch, {
      into: () => n.path,
      onFiles: spec.onDropFiles,
      onMove: spec.onDropMove,
    });
  }
  const kids = el('div', { class: 'treekids', style: { display: isOpen ? '' : 'none' } },
    n.kids.map((k) => treeRow(k, depth + 1, spec)));
  return el('div', {}, [el('div', { class: 'treerow' }, [caret, branch]), kids]);
}

export interface DropSpec {
  /** Read at drop time, so a target that means "the current folder" stays current. */
  into(): string;
  onFiles?(path: string, files: Incoming[]): void;
  onMove?(path: string, sources: string[]): void;
}

/** Drag-and-drop onto `target`: OS files, or internal DRAG_PATHS rows. */
export function installDrop(target: HTMLElement, spec: DropSpec): void {
  const accepts = (dt: DataTransfer | null): boolean => {
    if (!dt) return false;
    const types = Array.from(dt.types);
    return (!!spec.onFiles && types.includes('Files')) || (!!spec.onMove && types.includes(DRAG_PATHS));
  };
  for (const kind of ['dragover', 'dragenter']) {
    target.addEventListener(kind, (e) => {
      if (!accepts((e as DragEvent).dataTransfer)) return;
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
    const moved = dt.getData(DRAG_PATHS);
    if (moved && spec.onMove) {
      try {
        const sources = JSON.parse(moved) as string[];
        if (Array.isArray(sources) && sources.length) spec.onMove(spec.into(), sources.map(String));
      } catch { /* a foreign drag that lied about its type */ }
      return;
    }
    if (!spec.onFiles) return;
    const files = await collectDrop(dt);
    if (files.length) spec.onFiles(spec.into(), files);
  });
}

/** Mark an element as an internal drag source carrying these paths. */
export function installDrag(target: HTMLElement, paths: () => string[]): void {
  target.draggable = true;
  target.addEventListener('dragstart', (e) => {
    const dt = (e as DragEvent).dataTransfer;
    if (!dt) return;
    dt.setData(DRAG_PATHS, JSON.stringify(paths()));
    dt.effectAllowed = 'move';
  });
}

/** Files from a drop, folders walked so their structure comes along. */
export async function collectDrop(dt: DataTransfer): Promise<Incoming[]> {
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
