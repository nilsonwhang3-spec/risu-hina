/**
 * The studio's shared state and cross-module wiring - no DOM in here.
 *
 * The studio used to be one 1900-line module whose functions shared thirty
 * module-level variables. Split into files, that sharing has to be said out
 * loud: `S` is the mutable state every studio module reads and writes, and
 * `hub` is the set of redraw/refresh entry points the owning module registers
 * so that a save in one pane can redraw another without an import cycle.
 */
import { state, type FileListing, type StudioItem, type StudioJob, type StudioStatus,
         type WorkspaceFile } from '../../state';

// The card areas, in the order the work goes in. styles/characters carry the
// enable toggle; scenes (SD스튜디오 프리셋) are picked per run; fragments are
// spliced by <이름> and have no on/off - a reference either resolves or not.
export const CARD_AREAS: { area: string; label: string; toggle: boolean }[] = [
  { area: 'styles', label: '스타일 프롬프트', toggle: true },
  { area: 'characters', label: '캐릭터 프롬프트', toggle: true },
  { area: 'scenes', label: 'SD스튜디오 프리셋', toggle: false },
  { area: 'fragments', label: '조각 프롬프트', toggle: false },
];

export const OUTPUT_ROOT = 'studio/images';
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export interface Folder {
  path: string;
  name: string;
  children: Folder[];
  files: WorkspaceFile[];
}

/** The studio's mutable state. One object so every module sees one truth. */
export const S = {
  /** Mount points, owned by index.ts and set once per build. */
  leftMount: null as HTMLElement | null,
  viewMount: null as HTMLElement | null,
  noticeMount: null as HTMLElement | null,

  listing: null as FileListing | null,
  outputRoot: null as Folder | null,
  /** The card lists, one per area. */
  cards: {} as Record<string, StudioItem[]>,
  selected: OUTPUT_ROOT,
  /** A card picked in the list; the centre shows its editor instead of a folder. */
  selectedFile: '',
  open: new Set<string>([OUTPUT_ROOT]),
  /** Fragment references no fragment provides, from the last dry plan. */
  unresolvedRefs: [] as string[],

  /** The left column's tab (프롬프트 · OUTPUT) and, inside 프롬프트, whether
   * the character view has taken over the column. */
  leftTab: 'prompt' as 'prompt' | 'output',
  leftView: 'main' as 'main' | 'characters',
  /** The character card expanded in the left character view. */
  charOpen: '',

  /** The centre's tab (persisted), and the mode that can override it:
   * the fragment organizer, a folder grid, or the comparison selector
   * (both bound to S.selected). A picked file (S.selectedFile) overrides
   * everything - an editor is always reachable. */
  centreTab: 'single' as 'single' | 'batch' | 'inspect' | 'history',
  /** 'folder' is the tidy-up grid, a sub-view of the 검수 tab; 'selector'
   * is legacy - the 검수 tab draws the selector itself. */
  centreMode: 'tab' as 'tab' | 'fragments' | 'folder' | 'selector',
  /** Batch-tab column count (2·3·4). */
  cols: 3,
  /** The single tab's pinned image ('' = follow the live run), and the list
   * ←/→ walks (the job the image came from). */
  viewPath: '',
  viewList: [] as string[],
  /** Recent jobs, cached for the batch/history tabs. */
  jobs: [] as StudioJob[],

  status: null as StudioStatus | null,
  jobId: '',
  queueJob: null as StudioJob | null,
};
try {
  const t = localStorage.getItem('hina.studioLeftTab');
  if (t === 'output') S.leftTab = 'output';
  const c = localStorage.getItem('hina.studioTab');
  if (c === 'single' || c === 'batch' || c === 'inspect' || c === 'history') S.centreTab = c;
  const n = Number(localStorage.getItem('hina.studioCols'));
  if (n === 2 || n === 3 || n === 4) S.cols = n;
} catch { /* storage may be unavailable in the iframe */ }
export function persistLeftTab(): void {
  try { localStorage.setItem('hina.studioLeftTab', S.leftTab); } catch { /* fine */ }
}
export function persistCentreTab(): void {
  try { localStorage.setItem('hina.studioTab', S.centreTab); } catch { /* fine */ }
}
export function persistCols(): void {
  try { localStorage.setItem('hina.studioCols', String(S.cols)); } catch { /* fine */ }
}

/**
 * The cross-module entry points. index.ts registers the real functions at
 * build time; until then they are no-ops, which is also what a module calling
 * "redraw the cards" before the tab ever rendered should get.
 */
export const hub = {
  drawLeft: () => { /* registered by index */ },
  drawCentre: () => { /* registered by index */ },
  /** A live-job heartbeat: the visible tab patches its progress in place
   * (never a full centre rebuild - inputs keep their focus). */
  jobTick: () => { /* registered by the centre tabs */ },
  /** Patch count badges (활성 캐릭터, 미해결 조각) in place - called from
   * debounced checks so a keystroke in an editor never rebuilds the column
   * under the caret. */
  syncBadges: () => { /* registered by the left prompt view */ },
  notice: (_text: string, _kind: 'ok' | 'err' | '' = '') => { /* registered by index */ },
  refresh: async () => { /* registered by index */ },
  refreshArea: async (_area: string) => { /* registered by index */ },
  loadStatus: async () => { /* registered by index */ },
  touchQuiet: (_paths: string[] = []) => { /* registered by index */ },
};

/** What the generation card is set to. Persisted, so a reload keeps the run
 * setup. Defaults: steps 28 / CFG 5 are the web client's v4.5 values, rescale
 * 0.4 and quality tags OFF are this studio's own (user, 2026-08-30).
 * References follow the CARDS now (no switch), and the filename's
 * {character} comes from the cast/card - the 캐릭터명 form is gone. */
const GEN_KEY = 'hina.studioGen';
export const gen = {
  model: 'nai-diffusion-4-5-full',
  scenePreset: '',
  steps: 28, scale: 5, rescale: 0.4,
  sampler: 'k_euler_ancestral', schedule: 'karras',
  width: 832, height: 1216, count: 1, seed: '',
  quality: false, ucPreset: 0,
  folder: OUTPUT_ROOT,
  // The selector's regex. Empty means the backend's default; it is edited on
  // screen because it is the thing most likely to need adjusting.
  pattern: '',
};
try {
  const savedGen = JSON.parse(localStorage.getItem(GEN_KEY) || 'null') as Partial<typeof gen> | null;
  if (savedGen && typeof savedGen === 'object') Object.assign(gen, savedGen);
} catch { /* storage may be unavailable in the iframe */ }
export function persistGen(): void {
  try { localStorage.setItem(GEN_KEY, JSON.stringify(gen)); } catch { /* fine */ }
}

/** The active cards of one area, in (order, path) order - what a run sends. */
export function activeOf(area: string): string[] {
  return (S.cards[area] ?? [])
    .filter((i) => i.enabled)
    .sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path))
    .map((i) => i.path);
}

export function spec(): Record<string, unknown> {
  // What you see is what is sent: the panel names the active cards explicitly
  // rather than leaning on the backend default, so the request is inspectable.
  const out: Record<string, unknown> = {
    model: gen.model,
    styles: activeOf('styles'),
    characters: activeOf('characters'),
    count: gen.count, folder: gen.folder,
    params: { steps: gen.steps, scale: gen.scale, cfg_rescale: gen.rescale,
              sampler: gen.sampler, noise_schedule: gen.schedule,
              width: gen.width, height: gen.height,
              qualityToggle: gen.quality, ucPreset: gen.ucPreset },
  };
  if (gen.scenePreset) out.scenePreset = gen.scenePreset;
  if (gen.seed.trim()) out.seed = Number(gen.seed.trim());
  return out;
}

// --- reservations: the queue the 배치 tab accumulates -------------------------------
//
// reserves[presetPath][sceneName] = count. THE map is the queue: not a
// multiplication formula but entries piled up scene by scene, each with its
// own count - and switching presets never resets it (the keys keep
// everything). WHO is drawn comes from the left column's checked character
// cards at submit time (the user: one place to pick characters, not two).
// 씬 생성 drains the WHOLE map into one job.

export type ReserveMap = Record<string, Record<string, number>>;
const RESERVE_KEY = 'hina.studioReserve';
export let reserves: ReserveMap = {};
try {
  const saved = JSON.parse(localStorage.getItem(RESERVE_KEY) || 'null') as
    Record<string, Record<string, number | Record<string, number>>> | null;
  if (saved && typeof saved === 'object') {
    // The map briefly had a per-cast third level; fold it back to counts.
    for (const [preset, scenes] of Object.entries(saved)) {
      for (const [scene, v] of Object.entries(scenes || {})) {
        const n = typeof v === 'number' ? v
          : Object.values(v || {}).reduce((a, b) => a + (Number(b) || 0), 0);
        if (n > 0) ((reserves[preset] ??= {})[scene] = n);
      }
    }
  }
} catch { /* storage may be unavailable in the iframe */ }

export function persistReserves(): void {
  try { localStorage.setItem(RESERVE_KEY, JSON.stringify(reserves)); } catch { /* fine */ }
}

export function adjustReserve(preset: string, scene: string, delta: number): void {
  const p = (reserves[preset] ??= {});
  const next = Math.max(0, (p[scene] ?? 0) + delta);
  if (next) p[scene] = next; else delete p[scene];
  if (!Object.keys(p).length) delete reserves[preset];
  persistReserves();
}

export function setReserve(preset: string, scene: string, count: number): void {
  adjustReserve(preset, scene, count - reserveOf(preset, scene));
}

export function reserveOf(preset: string, scene: string): number {
  return reserves[preset]?.[scene] ?? 0;
}

/** Every reservation, across every preset - what 씬 생성 submits. */
export function reserveTotal(): number {
  let n = 0;
  for (const p of Object.values(reserves)) for (const c of Object.values(p)) n += c;
  return n;
}

export function clearReserves(preset?: string): void {
  if (preset) delete reserves[preset];
  else reserves = {};
  persistReserves();
}

/**
 * Unresolved fragment references, checked as they change.
 *
 * A `<이름>` no fragment provides would generate happily and wrongly, so the
 * dry plan (count clamped to 1, nothing spent) runs debounced after toggles
 * and edits, and its unresolved list becomes the 조각 section's badge.
 */
let unresolvedTimer: ReturnType<typeof setTimeout> | null = null;
export function checkUnresolved(): void {
  if (unresolvedTimer) clearTimeout(unresolvedTimer);
  unresolvedTimer = setTimeout(async () => {
    try {
      const r = await state.studio.plan({ ...spec(), count: 1 });
      S.unresolvedRefs = [...new Set(r.items.flatMap((i) => i.unresolved ?? []))];
    } catch {
      S.unresolvedRefs = [];
    }
    hub.syncBadges();
  }, 800);
}

/** A card name as a filename: the display name IS the identity, so the file
 * carries it (fragments are referenced as `<이름>`, which resolves by stem). */
export function cardStem(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').trim();
}

/** The first `stem`, `stem-2`, `stem-3` … not taken in this area's listing.
 * `folder` places the card under `studio/<area>/<folder>/`. */
export function freeCardPath(area: string, stem: string, suffix: string, folder = ''): string {
  const taken = new Set((S.cards[area] ?? []).map((i) => i.path));
  const base = `studio/${area}` + (folder ? `/${folder}` : '');
  for (let n = 1; ; n++) {
    const p = `${base}/${stem}${n > 1 ? `-${n}` : ''}${suffix}`;
    if (!taken.has(p)) return p;
  }
}

/** Create one card in `area` (optionally in a grouping folder) under the
 * given name - the name comes first: it is the reference key (fragments),
 * the list row, and the filename. Returns the new card's path, or '' when
 * nothing was made. The caller collects the name (kit.askName/namePopover -
 * never window.prompt, which looks like a browser security dialog). */
export async function newCard(area: string, folder: string, nm: string): Promise<string> {
  nm = (nm || '').trim();
  if (!nm) return '';
  const stem = cardStem(nm);
  if (!stem) { hub.notice('그 이름으로는 파일을 만들 수 없습니다.', 'err'); return ''; }
  try {
    let path: string;
    if (area === 'characters') {
      path = freeCardPath(area, stem, '', folder);
      await state.uploadFile('prompt.md', `---\nname: ${nm}\nenabled: false\n---\n## 프롬프트\n`,
        false, path);
    } else if (area === 'scenes') {
      path = freeCardPath(area, stem, '.json', folder);
      await state.uploadFile(path.split('/').pop()!, JSON.stringify(
        { version: 1, name: nm, scenes: [{ name: 'happy', prompt: '', negativePrompt: '', width: 0, height: 0 }] },
        null, 2), false, path.slice(0, path.lastIndexOf('/')));
    } else {
      path = freeCardPath(area, stem, '.md', folder);
      const front = area === 'styles'
        ? `---\nname: ${nm}\nenabled: false\n---\n`
        : `---\nname: ${nm}\n---\n`;
      await state.uploadFile(path.split('/').pop()!, front, false, path.slice(0, path.lastIndexOf('/')));
    }
    await hub.refreshArea(area);
    return path;
  } catch (e) {
    hub.notice('만들지 못했습니다: ' + msg(e), 'err');
    return '';
  }
}

/** Rename the file/folder behind a card when its name field changed.
 * Returns the (possibly new) path. A same-name collision keeps the old path
 * and reports, rather than half-renaming. */
export async function renameCardFile(path: string, newName: string): Promise<string> {
  const stem = cardStem(newName);
  if (!stem) return path;
  const isDir = !/\.[a-z0-9]+$/i.test(path);
  const dir = path.slice(0, path.lastIndexOf('/'));
  const old = path.slice(path.lastIndexOf('/') + 1);
  const suffix = isDir ? '' : old.slice(old.lastIndexOf('.'));
  if (old === stem + suffix) return path;
  const to = `${dir}/${stem}${suffix}`;
  const r = await state.moveFile(path, to);
  return r.to;
}

// --- the output tree model ---------------------------------------------------

/** The space listing's studio/images paths into one tree. */
export function buildOutput(): void {
  S.outputRoot = { path: OUTPUT_ROOT, name: 'output', children: [], files: [] };
  if (!S.listing) return;
  const lib = S.listing.areas.find((a) => a.area === 'studio');
  if (!lib) return;
  const byPath = new Map<string, Folder>([[OUTPUT_ROOT, S.outputRoot]]);
  const folder = (path: string): Folder | null => {
    const hit = byPath.get(path);
    if (hit) return hit;
    if (!path.startsWith(OUTPUT_ROOT + '/')) return null;
    const cut = path.lastIndexOf('/');
    const parent = folder(path.slice(0, cut));
    if (!parent) return null;
    const node: Folder = { path, name: path.slice(cut + 1), children: [], files: [] };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };
  for (const d of lib.dirs ?? []) folder(d);
  for (const f of lib.files) {
    if (!f.path.startsWith(OUTPUT_ROOT + '/')) continue;
    const cut = f.path.lastIndexOf('/');
    folder(f.path.slice(0, cut))?.files.push(f);
  }
}

export function find(path: string, node = S.outputRoot): Folder | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const c of node.children) {
    const hit = find(path, c);
    if (hit) return hit;
  }
  return null;
}

export function countFiles(n: Folder): number {
  return n.files.length + n.children.reduce((sum, c) => sum + countFiles(c), 0);
}

// --- small shared formatting ---------------------------------------------------

export function stateLabel(s: string): string {
  return ({ pending: '대기', running: '진행 중', done: '완료', partial: '일부 실패',
            error: '오류', cancelled: '중단됨' } as Record<string, string>)[s] ?? s;
}

export function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
