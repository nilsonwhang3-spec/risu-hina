/**
 * The artifact viewer - one card the agent (or a tab) can put in front of
 * the user: a picture, a markdown document, a text file.
 *
 * It is a MODAL now (§1-43). It used to be an overlay parked in the active
 * tab's centre pane and re-parented on every tab switch; that left it sitting
 * on top of whatever the tab wanted to show next - the 검수 tab most of all
 * ("파일 미리보기를 한 뒤 검수를 눌러도 미리보기가 안 닫힌다"). A modal is above
 * every tab, closes with ✕/Escape/backdrop, and is the one way an asset is
 * shown large (the files tab, the chat strips, the assets tab all use it).
 *
 * Content is loaded from the FILE the event names, never carried in the
 * event: the file is the artifact (projects/<봇>/out/…, or any space path),
 * so it survives the session and closing the card loses nothing. Markdown
 * renders through the DOM-only whitelist with space images; raw HTML never
 * renders - that decision is the security line, not a missing feature.
 */
import { el, clear, modal } from './dom';
import { state } from '../state';
import { renderMarkdown } from './markdown';
import { workspaceImage } from './blobimg';

export interface ArtifactSpec {
  path: string;
  title: string;
  kind?: 'markdown' | 'image' | 'text';
  /** A ready <img>/element to show instead of loading `path` (assets whose
   * bytes are not a space path). */
  node?: HTMLElement;
}

let current: ArtifactSpec | null = null;
let closeCurrent: (() => void) | null = null;

async function fill(body: HTMLElement, spec: ArtifactSpec): Promise<void> {
  clear(body);
  if (spec.node) {
    body.appendChild(spec.node);
    return;
  }
  body.appendChild(el('div', { class: 'hint', text: '여는 중입니다…' }));
  const kind = spec.kind
    ?? (/\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(spec.path) ? 'image'
      : /\.(md|markdown)$/i.test(spec.path) ? 'markdown' : 'text');
  try {
    if (kind === 'image') {
      clear(body);
      body.appendChild(workspaceImage(spec.path, spec.title));
      return;
    }
    const r = await state.readFile(spec.path);
    clear(body);
    if (r.truncated) body.appendChild(el('div', { class: 'hint', text: '앞부분만 표시합니다 — 전체는 파일 탭에서.' }));
    if (kind === 'markdown') {
      body.appendChild(renderMarkdown(r.content, { image: (p, a) => workspaceImage(p, a) }));
    } else {
      body.appendChild(el('pre', { class: 'mono filepreview', text: r.content || r.note || '(비어 있습니다)' }));
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
  }
}

export function showArtifact(spec: ArtifactSpec, _opts: { flipMobile?: boolean } = {}): void {
  closeArtifact();
  current = spec;
  const body = el('div', { class: 'artifactbody' });
  const head = el('div', { class: 'artifacthead row' });
  if (spec.path && !spec.node) {
    const openFile = el('button', { class: 'ghost tiny', text: '파일 탭에서 열기' });
    openFile.addEventListener('click', () => { closeArtifact(); state.requestOpenFile(spec.path); });
    head.append(el('span', { class: 'hint grow', text: spec.path }), openFile);
  }
  // A second, worded way out next to the ✕ (users missed the icon on a
  // picture that filled the screen, §1-49).
  const closeBtn = el('button', { class: 'ghost tiny', text: '닫기 (Esc)' });
  closeBtn.addEventListener('click', () => closeArtifact());
  if (!head.childElementCount) head.appendChild(el('span', { class: 'grow' }));
  head.appendChild(closeBtn);
  const view = el('div', { class: 'artifactview' }, [head, body]);
  closeCurrent = modal(spec.title || spec.path, view, { wide: true, cls: 'artifactmodal', onClose: () => { current = null; closeCurrent = null; } });
  void fill(body, spec);
}

export function closeArtifact(): void {
  const c = closeCurrent;
  closeCurrent = null;
  current = null;
  c?.();
}

/** Kept for the shell's tab-render hook: a modal needs no re-parenting. */
export function remountArtifact(): void {
  /* nothing to do - the viewer is a modal above every tab */
}

/** For the agent log's reopen chip. */
export function currentArtifact(): ArtifactSpec | null {
  return current;
}
