import { state } from '../state';

export interface FileClipboard { op: 'copy' | 'cut'; paths: string[] }
/** One live clipboard for OUTPUT, its grid, and the workspace. No file bytes. */
export let fileClipboard: FileClipboard | null = null;
let pasting = false;
export function setFileClipboard(value: FileClipboard | null): void {
  fileClipboard = value ? { op: value.op, paths: [...new Set(value.paths)] } : null;
}
export async function pasteFiles(target: string) {
  const clip = fileClipboard;
  if (!clip || pasting) return null;
  const paths = clip.paths.filter(p => p !== target && !target.startsWith(p + '/'));
  if (!paths.length) return null;
  pasting = true;
  try {
    const result = clip.op === 'copy' ? await state.copyFiles(paths, target) : await state.moveFiles(paths, target);
    if (clip.op === 'cut' && fileClipboard === clip) {
      const failed = new Set(result.failed.map(f => f.path));
      const remaining = clip.paths.filter(p => !paths.includes(p) || failed.has(p));
      setFileClipboard(remaining.length ? { op: 'cut', paths: remaining } : null);
    }
    state.touchFiles();
    return { ...result, op: clip.op };
  } finally { pasting = false; }
}
