/**
 * The artifact viewer - one card the agent can put in front of the user.
 *
 * ONE global instance, re-parented into the current tab's centre pane the way
 * the agent panel is (agentpane.ts): an artifact belongs to the conversation,
 * and the conversation is global. It overlays the centre only - the left
 * column and the agent stay visible and usable, so the user keeps talking to
 * 히나 while reading.
 *
 * Content is loaded from the FILE the event names, never carried in the
 * event: the file is the artifact (hina/<봇>/out/artifacts/…, or any space
 * path), so it survives the session, shows in the files tab, and closing the
 * card loses nothing. Markdown renders through the DOM-only whitelist with
 * space images; raw HTML never renders - that decision is the security line
 * (an AI-authored page executing with the plugin's iframe privileges), not a
 * missing feature.
 *
 * No leave-guard involvement: the viewer holds no edit state.
 */
import { el, clear } from './dom';
import { state } from '../state';
import { renderMarkdown } from './markdown';
import { workspaceImage } from './blobimg';
import { showMobileCentre } from './panes';

export interface ArtifactSpec {
  path: string;
  title: string;
  kind?: 'markdown' | 'image' | 'text';
}

let view: HTMLElement | null = null;
let current: ArtifactSpec | null = null;

function build(): HTMLElement {
  const body = el('div', { class: 'artifactbody' });
  const title = el('span', { class: 'artifacttitle grow' });
  const openFile = el('button', { class: 'ghost tiny', text: '파일 탭에서 열기' });
  openFile.addEventListener('click', () => {
    if (current) state.requestOpenFile(current.path);
  });
  const close = el('button', { class: 'ghost tiny', text: '닫기' });
  close.addEventListener('click', () => closeArtifact());
  return el('div', { class: 'artifactview' }, [
    el('div', { class: 'artifacthead' }, [title, openFile, close]),
    body,
  ]);
}

async function load(spec: ArtifactSpec): Promise<void> {
  if (!view) return;
  const body = view.querySelector('.artifactbody') as HTMLElement;
  const title = view.querySelector('.artifacttitle') as HTMLElement;
  title.textContent = spec.title || spec.path;
  title.title = spec.path;
  clear(body);
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

/** The centre pane of the active tab, where the overlay lives. */
function centreOf(): HTMLElement | null {
  return document.querySelector('.panel.active .split > .left');
}

export function showArtifact(spec: ArtifactSpec, opts: { flipMobile?: boolean } = {}): void {
  current = spec;
  if (!view) view = build();
  const centre = centreOf();
  if (centre && view.parentElement !== centre) centre.appendChild(view);
  view.style.display = '';
  void load(spec);
  // Arriving mid-turn never steals a phone's one view; a deliberate tap does.
  if (opts.flipMobile) showMobileCentre();
}

export function closeArtifact(): void {
  if (view) {
    view.style.display = 'none';
    view.remove();
  }
  current = null;
}

/**
 * Follow the active tab: called by the shell after a tab render. A tab whose
 * centre is missing (선택, 설정) parks the viewer; it reappears on the next
 * tab that has one.
 */
export function remountArtifact(): void {
  if (!view || !current) return;
  const centre = centreOf();
  if (!centre) {
    view.remove();
    return;
  }
  if (view.parentElement !== centre) centre.appendChild(view);
}

/** For the agent log's reopen chip. */
export function currentArtifact(): ArtifactSpec | null {
  return current;
}
