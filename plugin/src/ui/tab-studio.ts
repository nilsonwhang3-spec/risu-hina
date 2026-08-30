/**
 * 에셋 스튜디오 - the image library, and the one tab that is not about a bot.
 *
 * Every other tab edits the bot RisuAI has open. This one edits a library that
 * outlives any of them: you generate images, sort them, and only then decide
 * which bot gets them. So it renders with **no bot selected at all** - the
 * shell already survives that state (readHost only sets slotError), and it is
 * the per-tab render functions that bail. This one does not.
 *
 *   left    the prompt CARDS (styles · characters · presets · fragments), the
 *           output tree, and the generation card. A style or a character is a
 *           card with its own on/off and order - the lorebook model - and the
 *           ACTIVE cards are what a run sends.
 *   centre  the picked card's editor, or the picked output folder: for images
 *           that is the comparison selector, otherwise a list.
 *   right   Hina, as on every tab
 *
 * The library is the `studio/` folder of the ONE global space, so its files
 * ride the shared file methods on `state` with space-rooted paths; only the
 * domain calls (NovelAI, batches, the selector) live on `state.studio`.
 *
 * A bot IS needed to *adopt* an image into a card - that is gated per action,
 * where it is true, rather than on the whole tab.
 */
import { el, clear, armed } from './dom';
import { state, type FileListing, type GroupItem, type SelectionMap, type SelectionState,
         type StudioGroups, type StudioItem, type StudioJob, type StudioStatus,
         type WorkspaceFile } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { listRow as kitRow } from './kit';
import { workspaceImage } from './blobimg';

// The card areas, in the order the work goes in. styles/characters carry the
// enable toggle; scenes (SD스튜디오 프리셋) are picked per run; fragments are
// spliced by <이름> and have no on/off - a reference either resolves or not.
const CARD_AREAS: { area: string; label: string; toggle: boolean }[] = [
  { area: 'styles', label: '스타일 프롬프트', toggle: true },
  { area: 'characters', label: '캐릭터 프롬프트', toggle: true },
  { area: 'scenes', label: 'SD스튜디오 프리셋', toggle: false },
  { area: 'fragments', label: '조각 프롬프트', toggle: false },
];

const OUTPUT_ROOT = 'studio/images';
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

interface Folder {
  path: string;
  name: string;
  children: Folder[];
  files: WorkspaceFile[];
}

let built = false;
/** The filesRev this tab last drew. While the tab stays active, an unrelated
 * state emit no longer triggers the five-request library re-read. */
let renderedRev = -1;
/** Whether the previous render was already this tab: coming BACK is still a
 * deliberate visit and re-reads (files can arrive from another machine, which
 * bumps no rev here); staying put does not. */
let wasStudioActive = false;
let cardsMount: HTMLElement | null = null;

/** shell.setTab tells us when the user goes elsewhere - there is no emit on a
 * tab switch, so the "came back" signal has to be handed over explicitly. */
export function noteStudioLeft(): void {
  wasStudioActive = false;
}
let treeMount: HTMLElement | null = null;
let genMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let listing: FileListing | null = null;
let outputRoot: Folder | null = null;
/** The card lists, one per area. */
let cards: Record<string, StudioItem[]> = {};
let selected = OUTPUT_ROOT;
/** A card picked in the list; the centre shows its editor instead of a folder. */
let selectedFile = '';
const open = new Set<string>([OUTPUT_ROOT]);
const thumbs = new Map<string, string>();
/** Fragment references no fragment provides, from the last dry plan. */
let unresolvedRefs: string[] = [];
let unresolvedTimer: ReturnType<typeof setTimeout> | null = null;

/** What the generation card is set to. Persisted, so a reload keeps the run
 * setup. Defaults: steps 28 / CFG 5 are the web client's v4.5 values, rescale
 * 0.4 and quality tags OFF are this studio's own (user, 2026-08-30). */
const GEN_KEY = 'hina.studioGen';
const gen = {
  model: 'nai-diffusion-4-5-full',
  scenePreset: '',
  characterName: '',
  steps: 28, scale: 5, rescale: 0.4,
  sampler: 'k_euler_ancestral', schedule: 'karras',
  width: 832, height: 1216, count: 1, seed: '',
  quality: false, ucPreset: 0,
  folder: OUTPUT_ROOT,
  // The one control that certainly spends Anlas, so it is off unless asked.
  // References come from the ACTIVE character cards' presets now.
  useReference: false,
  // The selector's regex. Empty means the backend's default; it is edited on
  // screen because it is the thing most likely to need adjusting.
  pattern: '',
};
try {
  const savedGen = JSON.parse(localStorage.getItem(GEN_KEY) || 'null') as Partial<typeof gen> | null;
  if (savedGen && typeof savedGen === 'object') Object.assign(gen, savedGen);
} catch { /* storage may be unavailable in the iframe */ }
function persistGen(): void {
  try { localStorage.setItem(GEN_KEY, JSON.stringify(gen)); } catch { /* fine */ }
}
let status: StudioStatus | null = null;
let jobId = '';
let jobTimer: ReturnType<typeof setInterval> | null = null;
/** The centre shows the live queue instead of a folder while this is on. */
let queueView = false;
let queueJob: StudioJob | null = null;

export function renderStudioTab(mount: HTMLElement): void {
  const entering = !wasStudioActive;
  wasStudioActive = true;
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    cardsMount = el('div', { class: 'tree filetree' });
    treeMount = el('div', { class: 'tree filetree' });
    genMount = el('div', { class: 'genpanel' });
    pane.left.append(cardsMount, treeMount, genMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(noticeMount, viewMount);
    mount.appendChild(pane.root);
    built = true;
    void refresh();
    void loadStatus();
  } else if (entering || renderedRev !== state.filesRev) {
    // COMING BACK to the tab re-reads the library (files arrive from outside
    // any rev - another machine writes into the same space), and so does a
    // files change while we sit here. What no longer re-reads is every other
    // state emit - a chat token, a card edit elsewhere - which used to cost
    // the same five requests each.
    void refresh();
  }
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

async function loadStatus(): Promise<void> {
  try {
    status = await state.studio.status();
  } catch (e) {
    status = { configured: false, library: '', error: msg(e) };
  }
  drawGen();
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 8000);
}

export async function refresh(): Promise<void> {
  renderedRev = state.filesRev;
  try {
    const [l, ...areas] = await Promise.all([
      // Only the output slice: the studio never reads the rest of the space.
      state.files(OUTPUT_ROOT),
      ...CARD_AREAS.map((a) => state.studio.items(a.area).then((r) => r.items).catch(() => [] as StudioItem[])),
    ]);
    listing = l;
    cards = Object.fromEntries(CARD_AREAS.map((a, i) => [a.area, areas[i]]));
  } catch (e) {
    listing = null;
    drawCards();
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
  buildOutput();
  drawCards();
  drawTree();
  drawCentre();
  checkUnresolved();
}

/** Tell the files tab about a studio write without re-reading our own world:
 * touchFiles bumps filesRev by one, and pre-advancing renderedRev keeps the
 * guard in renderStudioTab from turning that bump back into a full refresh. */
function touchQuiet(paths: string[] = []): void {
  renderedRev = state.filesRev + 1;
  state.touchFiles(paths);
}

/** Re-read ONE card area after a save - a card edit cannot change the output
 * tree or the other areas, so one listing call replaces the old five. */
async function refreshArea(area: string): Promise<void> {
  try {
    cards[area] = (await state.studio.items(area)).items;
  } catch { /* keep what we have; the next full refresh corrects it */ }
  drawCards();
  drawCentre();
  drawGen();
  checkUnresolved();
  touchQuiet();
}

// --- the card lists -------------------------------------------------------------

/** The active cards of one area, in (order, path) order - what a run sends. */
function activeOf(area: string): string[] {
  return (cards[area] ?? [])
    .filter((i) => i.enabled)
    .sort((a, b) => ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path))
    .map((i) => i.path);
}

// Which card sections are folded. Fragments especially grow into the dozens,
// and four always-open lists made the left column a scroll hunt.
const SECT_KEY = 'hina.studioSections';
let sectOpen: Record<string, boolean> = {};
try { sectOpen = JSON.parse(localStorage.getItem(SECT_KEY) || '{}') as Record<string, boolean> || {}; }
catch { /* storage may be unavailable in the iframe */ }
function sectionOpen(area: string): boolean {
  return sectOpen[area] !== false;
}
function toggleSection(area: string): void {
  sectOpen[area] = !sectionOpen(area);
  try { localStorage.setItem(SECT_KEY, JSON.stringify(sectOpen)); } catch { /* fine */ }
  drawCards();
}

function drawCards(): void {
  if (!cardsMount) return;
  clear(cardsMount);
  for (const spec of CARD_AREAS) {
    const rows = cards[spec.area] ?? [];
    const openNow = sectionOpen(spec.area);
    const head = el('div', { class: 'row secthead', style: { padding: '4px 6px 0', cursor: 'pointer' },
                            title: openNow ? '접기' : '펼치기' }, [
      el('span', { class: 'hint', text: openNow ? '▾' : '▸' }),
      el('span', { class: 'sectiontitle grow', text: spec.label }),
      el('span', { class: 'hint', text: String(rows.length) }),
    ]);
    head.addEventListener('click', () => toggleSection(spec.area));
    if (spec.area === 'fragments' && unresolvedRefs.length) {
      head.appendChild(el('span', {
        class: 'badge err', text: `미해결 ${unresolvedRefs.length}`,
        title: '프롬프트가 참조하는데 조각이 없는 이름: ' + unresolvedRefs.join(', '),
      }));
    }
    const add = el('button', { class: 'ghost tiny', text: '＋', title: '새 카드' });
    add.addEventListener('click', (e) => { e.stopPropagation(); void newCard(spec.area); });
    head.appendChild(add);
    cardsMount.appendChild(head);

    if (!openNow) continue;
    if (!rows.length) {
      cardsMount.appendChild(el('div', { class: 'hint', style: { padding: '0 10px 4px' }, text: '(없음)' }));
      continue;
    }
    const sorted = [...rows].sort((a, b) =>
      ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
    for (const it of sorted) cardsMount.appendChild(cardRow(spec, it));
  }
  cardsMount.appendChild(el('div', {
    class: 'sectionline treesep',
    title: '위는 쓰는 것(프롬프트·프리셋), 아래는 나온 것(생성물)입니다',
  }));
}

function cardRow(spec: { area: string; toggle: boolean }, it: StudioItem): HTMLElement {
  const badges: { text: string; kind?: 'ok' | 'warn' | 'err' | '' ; title?: string }[] = [];
  if (spec.area === 'characters') {
    if (it.vibe) badges.push({ text: `바이브 ${it.vibe}`, title: '레퍼런스 사용 시 이 카드의 바이브가 실립니다' });
    if (it.charref) badges.push({ text: `레퍼런스 ${it.charref}` });
  }
  if (it.count) badges.push({ text: `씬 ${it.count}` });
  if (spec.toggle && !it.enabled) badges.push({ text: '꺼짐' });

  const row = kitRow({
    variant: 'pick',
    selected: selectedFile === it.path,
    title: it.name || it.path.split('/').pop() || it.path,
    hint: it.description || undefined,
    badges,
    toggle: spec.toggle ? {
      checked: !!it.enabled,
      title: '켜면 생성 요청에 이 카드가 실립니다 (순서대로 이어집니다)',
      onChange: async (v) => {
        try {
          await state.studio.setMeta(it.path, { enabled: v });
        } catch (e) {
          notice('바꾸지 못했습니다: ' + msg(e), 'err');
          throw e;
        }
        // One meta write changed one row: update it in memory and redraw,
        // instead of the full five-request library re-read per checkbox.
        it.enabled = v;
        drawCards();
        drawGen();
        checkUnresolved();
        touchQuiet();
      },
    } : undefined,
    onClick: () => {
      selectedFile = it.path;
      drawCards();
      drawCentre();
    },
  });
  if (spec.toggle && typeof it.order === 'number' && it.order !== 100) {
    row.appendChild(el('span', { class: 'hint ordertag', title: '연결 순서 (order)', text: String(it.order) }));
  }
  return row;
}

/** A card name as a filename: the display name IS the identity, so the file
 * carries it (fragments are referenced as `<이름>`, which resolves by stem). */
function cardStem(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '').trim();
}

/** The first `stem`, `stem-2`, `stem-3` … not taken in this area's listing. */
function freeCardPath(area: string, stem: string, suffix: string): string {
  const taken = new Set((cards[area] ?? []).map((i) => i.path));
  for (let n = 1; ; n++) {
    const p = `studio/${area}/${stem}${n > 1 ? `-${n}` : ''}${suffix}`;
    if (!taken.has(p)) return p;
  }
}

async function newCard(area: string): Promise<void> {
  // The name comes first: it is the reference key (fragments), the list row,
  // and the filename - a timestamp slug was a code nobody could read back.
  const raw = window.prompt('새 카드 이름');
  const nm = (raw ?? '').trim();
  if (!nm) return;
  const stem = cardStem(nm);
  if (!stem) { notice('그 이름으로는 파일을 만들 수 없습니다.', 'err'); return; }
  try {
    if (area === 'characters') {
      const path = freeCardPath(area, stem, '');
      await state.uploadFile('prompt.md', `---\nname: ${nm}\nenabled: false\n---\n## 프롬프트\n`,
        false, path);
      selectedFile = path;
    } else if (area === 'scenes') {
      const path = freeCardPath(area, stem, '.json');
      await state.uploadFile(path.split('/').pop()!, JSON.stringify(
        { version: 1, name: nm, scenes: [{ name: 'happy', prompt: '', negativePrompt: '', width: 0, height: 0 }] },
        null, 2), false, 'studio/scenes');
      selectedFile = path;
    } else {
      const path = freeCardPath(area, stem, '.md');
      const front = area === 'styles'
        ? `---\nname: ${nm}\nenabled: false\n---\n`
        : `---\nname: ${nm}\n---\n`;
      await state.uploadFile(path.split('/').pop()!, front, false, `studio/${area}`);
      selectedFile = path;
    }
    await refreshArea(area);
  } catch (e) {
    notice('만들지 못했습니다: ' + msg(e), 'err');
  }
}

/** Rename the file/folder behind a card when its name field changed.
 * Returns the (possibly new) path. A same-name collision keeps the old path
 * and reports, rather than half-renaming. */
async function renameCardFile(path: string, newName: string): Promise<string> {
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

// --- the output tree --------------------------------------------------------------

/** The space listing's studio/images paths into one tree. */
function buildOutput(): void {
  outputRoot = { path: OUTPUT_ROOT, name: 'output', children: [], files: [] };
  if (!listing) return;
  const lib = listing.areas.find((a) => a.area === 'studio');
  if (!lib) return;
  const byPath = new Map<string, Folder>([[OUTPUT_ROOT, outputRoot]]);
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

function find(path: string, node = outputRoot): Folder | null {
  if (!node) return null;
  if (node.path === path) return node;
  for (const c of node.children) {
    const hit = find(path, c);
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
  if (outputRoot) treeMount.appendChild(row(outputRoot, 0));
}

function row(n: Folder, depth: number): HTMLElement {
  const wrap = el('div');
  const isOpen = open.has(n.path);
  const kids = n.children.length > 0;
  const caret = el('span', { class: 'caret', text: kids ? (isOpen ? '▾' : '▸') : '' });
  const line = el('button', {
    class: 'treerow' + (selected === n.path && !selectedFile ? ' on' : ''),
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
    selectedFile = '';
    drawCards();
    drawTree();
    drawCentre();
  });
  wrap.appendChild(line);
  if (isOpen) for (const c of n.children) wrap.appendChild(row(c, depth + 1));
  return wrap;
}

/**
 * The generation card, under the tree.
 *
 * Left, because none of it changes inside one batch: the ACTIVE cards say
 * what is drawn, this card says how. The two meters live here too — Anlas
 * and the v5 quota are different currencies and neither is derived from the
 * other, so both are shown as NovelAI reports them (docs/09 §2).
 */
function drawGen(): void {
  if (!genMount) return;
  clear(genMount);
  genMount.appendChild(el('div', { class: 'sectionline' }));
  genMount.appendChild(el('div', { class: 'sectiontitle', text: '생성' }));

  // What a run will actually send: the active cards, said out loud so the
  // list on the left and the request stay one thing - with or without a token.
  const nStyles = activeOf('styles').length;
  const nChars = activeOf('characters').length;
  genMount.appendChild(el('div', { class: 'hint', style: { margin: '4px 0' },
    text: `활성 카드: 스타일 ${nStyles} · 캐릭터 ${nChars} — 위 목록의 체크가 배치에 실립니다` }));

  if (!status) {
    genMount.appendChild(el('div', { class: 'hint', text: '상태를 읽는 중입니다…' }));
    return;
  }
  // No token hides only the run button: planning is free (the dry plan never
  // spends), and the setup someone types should not vanish with the notice.
  if (!status.configured) {
    genMount.appendChild(el('div', { class: 'notice' }, [
      el('div', { class: 'hint', text: status.note || status.error || 'NovelAI 토큰이 없습니다.' }),
      el('div', { class: 'hint', style: { marginTop: '4px' },
                  text: '토큰 없이도 계획을 세우고, 이미지를 넣고, 정리하고, 봇에 반영할 수 있습니다.' }),
    ]));
  }
  const acc = status.account;
  if (acc) {
    genMount.appendChild(el('div', { class: 'row', style: { gap: '8px' } }, [
      el('span', { class: 'badge', title: 'Anlas — 레퍼런스 인코딩과 디렉터 툴이 쓰는 잔량',
                   text: `Anlas ${acc.anlas}` }),
      el('span', {
        class: 'badge' + (acc.usageNegative ? ' warn' : ''),
        title: 'v5 사용량 — Anlas 와 별개의 한도입니다',
        text: `v5 ${acc.usagePercent ?? '?'}%`,
      }),
      el('span', { class: 'hint', text: `tier ${acc.tier ?? '?'}` }),
    ]));
  }
  if (status.error) genMount.appendChild(el('div', { class: 'hint err', text: status.error }));

  const field = (label: string, node: HTMLElement) =>
    el('label', { class: 'field' }, [el('span', { text: label }), node]);

  const modelInput = el('input', { value: gen.model, placeholder: 'nai-diffusion-4-5-full' }) as HTMLInputElement;
  modelInput.addEventListener('change', () => {
    gen.model = modelInput.value.trim();
    persistGen();
    refSync?.();
  });
  const checkBtn = el('button', { class: 'ghost tiny', text: '확인' }) as HTMLButtonElement;
  const checkOut = el('span', { class: 'hint' });
  // Free, and the only thing that knows the model list is the service itself
  // (docs/09 §5) - so this asks rather than validating against a list here.
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkOut.textContent = '확인 중…';
    try {
      const r = await state.studio.modelCheck(modelInput.value.trim());
      checkOut.textContent = r.exists
        ? (r.supportsVibe ? '있음 · 레퍼런스 가능' : '있음 · 레퍼런스 불가(v5)')
        : '그런 모델이 없습니다';
    } catch (e) {
      checkOut.textContent = msg(e);
    } finally {
      checkBtn.disabled = false;
    }
  });

  const two = (a: HTMLElement, b: HTMLElement) => el('div', { class: 'row' }, [a, b]);

  // 요청 설정: everything a request carries beyond "what and how many" - the
  // model, the reference switch, and the sampling parameters - folded away so
  // the daily controls stay at the top. Its open/closed state is remembered.
  const req = el('details', { class: 'advbox' }, [
    el('summary', { text: '요청 설정' }),
    field('모델', modelInput),
    el('div', { class: 'row' }, [checkBtn, checkOut]),
    referenceToggle(),
    two(numField('스텝', 'steps'), numField('CFG', 'scale')),
    two(numField('Rescale', 'rescale'), selField('샘플러', 'sampler', [
      'k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde',
      'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3'])),
    two(selField('스케줄', 'schedule', ['karras', 'native', 'exponential', 'polyexponential']),
        selField('UC 프리셋', 'ucPreset', [], [
          { value: 0, label: 'Heavy' }, { value: 1, label: 'Light' },
          { value: 3, label: 'Human Focus' }, { value: 4, label: '없음' }])),
    two(numField('가로', 'width'), numField('세로', 'height')),
    qualityToggle(),
  ]) as HTMLDetailsElement;
  try { req.open = localStorage.getItem('hina.studioReqOpen') === '1'; } catch { /* fine */ }
  req.addEventListener('toggle', () => {
    try { localStorage.setItem('hina.studioReqOpen', req.open ? '1' : '0'); } catch { /* fine */ }
  });

  genMount.append(
    scenePicker(),
    two(numField('장수', 'count'), textField('시드', 'seed', '비우면 랜덤')),
    textField('캐릭터명', 'characterName', '파일 이름에 들어갑니다 (비우면 생략)'),
    textField('저장 폴더', 'folder', 'studio/images/…'),
    req,
  );

  const planBtn = el('button', { class: 'ghost tiny', text: '계획 보기' }) as HTMLButtonElement;
  const queueBtn = el('button', { class: 'ghost tiny', text: '큐', title: '생성 큐와 최근 작업' }) as HTMLButtonElement;
  const runBtn = el('button', { class: 'primary tiny', text: '생성 시작' }) as HTMLButtonElement;
  planBtn.addEventListener('click', () => void showPlan());
  queueBtn.addEventListener('click', () => { queueView = true; drawCentre(); });
  runBtn.addEventListener('click', () => void run());
  genMount.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } },
                          [planBtn, queueBtn, status.configured ? runBtn : null]));
  genMount.appendChild(el('div', { class: 'genstatus' }));
  if (jobId) void pollJob();
}

/** The scene preset <select> - the one thing still picked per run. */
function scenePicker(): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  sel.appendChild(el('option', { value: '', text: '(없음)' }));
  for (const it of cards.scenes ?? []) {
    const o = el('option', { value: it.path, text: it.name + (it.count ? ` (${it.count})` : '') });
    if (it.path === gen.scenePreset) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { gen.scenePreset = sel.value; persistGen(); checkUnresolved(); });
  return el('label', { class: 'field' }, [el('span', { text: 'SD스튜디오 프리셋' }), sel]);
}

/**
 * Whether this batch uses the active characters' reference presets.
 *
 * Off by default and labelled with its price, because this is the one control
 * on the card that certainly spends Anlas: an encode is 2 each, and v5 cannot
 * do it at all (docs/09 §7). The encoding is cached, so a second batch with
 * the same reference costs nothing. Strength and 충실도 live on each card.
 */
let refSync: (() => void) | null = null;

function referenceToggle(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = gen.useReference;
  const why = el('div', { class: 'hint' });
  const sync = () => {
    gen.useReference = box.checked;
    const v5 = !gen.model.includes('diffusion-4');
    // Both kinds count: a card carries charrefs OR vibes (refMode), and the
    // listing already reports only the side that will ride.
    const active = (cards.characters ?? []).filter((i) => i.enabled);
    const charrefN = active.reduce((n, i) => n + (i.charref ?? 0), 0);
    const vibeN = active.reduce((n, i) => n + (i.vibe ?? 0), 0);
    why.textContent = v5
      ? 'v5 모델은 레퍼런스를 지원하지 않습니다 — 4.5 를 고르세요.'
      : !(charrefN + vibeN)
        ? '활성 캐릭터 카드에 레퍼런스가 없습니다 — 카드를 열어 이미지를 올려 두세요.'
        : (box.checked
            ? `캐릭터 ${charrefN}장 (장당 5 Anlas) · 바이브 ${vibeN}장 (인코딩 2 Anlas, 캐시 시 0)`
            : '');
  };
  box.addEventListener('change', () => { sync(); persistGen(); });
  refSync = sync;
  sync();
  return el('div', {}, [
    el('label', { class: 'row' }, [box, el('span', { text: '레퍼런스 사용 (활성 카드대로)' })]),
    why,
  ]);
}

function spec(): Record<string, unknown> {
  // What you see is what is sent: the panel names the active cards explicitly
  // rather than leaning on the backend default, so the request is inspectable.
  const out: Record<string, unknown> = {
    model: gen.model,
    styles: activeOf('styles'),
    characters: activeOf('characters'),
    characterName: gen.characterName,
    count: gen.count, folder: gen.folder,
    params: { steps: gen.steps, scale: gen.scale, cfg_rescale: gen.rescale,
              sampler: gen.sampler, noise_schedule: gen.schedule,
              width: gen.width, height: gen.height,
              qualityToggle: gen.quality, ucPreset: gen.ucPreset },
  };
  if (gen.scenePreset) out.scenePreset = gen.scenePreset;
  if (gen.seed.trim()) out.seed = Number(gen.seed.trim());
  if (gen.useReference) out.useReference = true;
  return out;
}

function numField(label: string, key: 'steps' | 'scale' | 'rescale' | 'width' | 'height' | 'count'): HTMLElement {
  const i = el('input', { value: String(gen[key]), type: 'number',
                          ...(key === 'rescale' ? { step: '0.05', min: '0', max: '1' } : {}) }) as HTMLInputElement;
  i.addEventListener('change', () => {
    const n = Number(i.value);
    if (!Number.isNaN(n)) gen[key] = n;
    persistGen();
  });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function textField(label: string, key: 'seed' | 'characterName' | 'folder',
                   placeholder = ''): HTMLElement {
  const i = el('input', { value: gen[key], placeholder }) as HTMLInputElement;
  i.addEventListener('change', () => { gen[key] = i.value; persistGen(); });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function selField(label: string, key: 'sampler' | 'schedule' | 'ucPreset', values: string[],
                  options?: { value: number; label: string }[]): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  for (const o of options ?? values.map((v) => ({ value: v as string | number, label: v }))) {
    const opt = el('option', { value: String(o.value), text: String(o.label) });
    if (String(gen[key]) === String(o.value)) opt.setAttribute('selected', 'selected');
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (key === 'ucPreset') gen.ucPreset = Number(sel.value) || 0;
    else gen[key] = sel.value;
    persistGen();
  });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), sel]);
}

function qualityToggle(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = gen.quality;
  box.addEventListener('change', () => { gen.quality = box.checked; persistGen(); });
  return el('label', { class: 'row', title: '켜면 very aesthetic, masterpiece, no text 가 뒤에 붙습니다' },
            [box, el('span', { text: '퀄리티 태그' })]);
}

/**
 * Unresolved fragment references, checked as they change.
 *
 * A `<이름>` no fragment provides would generate happily and wrongly, so the
 * dry plan (count clamped to 1, nothing spent) runs debounced after toggles
 * and edits, and its unresolved list becomes the 조각 section's badge.
 */
function checkUnresolved(): void {
  if (unresolvedTimer) clearTimeout(unresolvedTimer);
  unresolvedTimer = setTimeout(async () => {
    try {
      const r = await state.studio.plan({ ...spec(), count: 1 });
      unresolvedRefs = [...new Set(r.items.flatMap((i) => i.unresolved ?? []))];
    } catch {
      unresolvedRefs = [];
    }
    drawCards();
  }, 800);
}

// --- the centre: editors, the selector, folders ---------------------------------

function drawCentre(): void {
  if (!viewMount) return;
  clear(viewMount);

  // A running (or just-inspected) batch owns the centre until dismissed:
  // "what is it doing right now" is the question the moment 생성 시작 lands.
  if (queueView) {
    drawQueue();
    return;
  }

  // A card picked in the list: its editor, not the folder it lives in.
  if (selectedFile) {
    const parts = selectedFile.split('/');
    if (parts[1] === 'characters' && !/\.[a-z0-9]+$/i.test(selectedFile)) {
      drawCharacterEditor(selectedFile);
    } else if (selectedFile.endsWith('.md')) {
      drawCardEditor(selectedFile);
    } else if (parts[1] === 'scenes' && selectedFile.endsWith('.json') && !rawView.has(selectedFile)) {
      drawSceneEditor(selectedFile);
    } else {
      drawRawFile(selectedFile);
    }
    return;
  }

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
    viewMount.appendChild(el('div', { class: 'empty', text: '아직 생성물이 없습니다. 이미지를 여기에 넣거나 히나에게 생성을 부탁하세요.' }));
    return;
  }

  // Under images/, comparing is the job, so the selector replaces the plain
  // grid: candidates are looked at against each other, not browsed.
  if (node.files.some((f) => IMAGE_RE.test(f.name))) {
    if (!groups || groups.folder !== node.path) {
      viewMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
      void loadGroups(node.path);
      return;
    }
    drawSelector(node);
    return;
  }

  const list = el('div', { class: 'filelist' });
  for (const f of node.files) list.appendChild(fileRow(f));
  viewMount.appendChild(list);
}

// --- the card editors -------------------------------------------------------------

// The client-side mirror of studio.FRONT: split the front matter off so the
// editor shows fields, not fence syntax. The backend stays the writer of
// meta-only changes (set_meta); a full save goes through upload.
const FRONT_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

function splitFront(text: string): { meta: Map<string, string>; body: string } {
  const meta = new Map<string, string>();
  const m = text.match(FRONT_RE);
  if (!m) return { meta, body: text };
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    meta.set(line.slice(0, at).trim(), line.slice(at + 1).trim().replace(/^["']|["']$/g, ''));
  }
  return { meta, body: text.slice(m[0].length) };
}

function joinFront(meta: Map<string, string>, body: string): string {
  const lines = [...meta.entries()].filter(([, v]) => v !== '').map(([k, v]) => `${k}: ${v}`);
  return lines.length ? `---\n${lines.join('\n')}\n---\n${body}` : body;
}

function editorHead(path: string, extra: (HTMLElement | null)[] = []): HTMLElement {
  const back = el('button', { class: 'ghost tiny', text: '← 목록' });
  back.addEventListener('click', () => { selectedFile = ''; drawCards(); drawCentre(); });
  return el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    back, el('span', { class: 'sectiontitle grow', text: path }), ...extra,
  ]);
}

/** A style or fragment .md: front-matter fields above the body. */
function drawCardEditor(path: string): void {
  if (!viewMount) return;
  const isStyle = path.startsWith('studio/styles/');
  const out = el('div', { class: 'hint' });
  const name = el('input', { placeholder: '(파일 이름)' }) as HTMLInputElement;
  const desc = el('input', { placeholder: '한 줄 설명' }) as HTMLInputElement;
  const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const order = el('input', { type: 'number', value: '100', step: '10',
                              title: '작을수록 앞에 이어집니다' }) as HTMLInputElement;
  const body = el('textarea', { rows: '18', class: 'promptedit',
    placeholder: isStyle ? '## positive\n…\n\n## negative\n…' : '조각 본문 — <이름> 으로 참조됩니다',
  }) as HTMLTextAreaElement;

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      selectedFile = '';
      await refreshArea(path.split('/')[1]);
    } catch (e) { out.textContent = msg(e); }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '';
    try {
      const meta = new Map<string, string>();
      if (name.value.trim()) meta.set('name', name.value.trim());
      if (desc.value.trim()) meta.set('description', desc.value.trim());
      if (isStyle) {
        meta.set('enabled', enabledBox.checked ? 'true' : 'false');
        if (order.value.trim() && order.value.trim() !== '100') meta.set('order', String(Math.trunc(Number(order.value)) || 100));
      }
      const dir = path.slice(0, path.lastIndexOf('/'));
      const fname = path.slice(path.lastIndexOf('/') + 1);
      await state.uploadFile(fname, joinFront(meta, body.value), false, dir);
      // The name is the identity: renaming the card renames the file, so a
      // fragment's `<이름>` keeps resolving and the list shows what you typed.
      if (name.value.trim()) {
        try {
          const moved = await renameCardFile(path, name.value.trim());
          if (moved !== path) { path = moved; selectedFile = moved; }
        } catch (e) { out.textContent = '이름은 저장됐지만 파일명 변경은 실패했습니다: ' + msg(e); }
      }
      if (!out.textContent) out.textContent = '저장했습니다.';
      await refreshArea(isStyle ? 'styles' : 'fragments');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  viewMount.appendChild(el('div', {}, [
    editorHead(path, [del, save]),
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('label', { class: 'field' }, [el('span', { text: '설명' }), desc]),
    isStyle ? el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'row' }, [enabledBox, el('span', { text: '활성 (생성에 실림)' })]),
      el('label', { class: 'field', style: { width: '130px', marginBottom: '0' } }, [el('span', { text: '순서' }), order]),
    ]) : null,
    el('label', { class: 'field' }, [el('span', { text: isStyle ? '본문 (## positive / ## negative)' : '본문' }), body]),
    out,
  ]));

  void state.readFile(path).then((r) => {
    const { meta, body: b } = splitFront(r.content);
    name.value = meta.get('name') ?? '';
    desc.value = meta.get('description') ?? '';
    enabledBox.checked = (meta.get('enabled') ?? '').toLowerCase() === 'true';
    order.value = meta.get('order') ?? '100';
    body.value = b;
  }).catch((e) => { out.textContent = msg(e); });
}

/**
 * The character card editor - a folder card, edited in the centre pane.
 *
 * A character is not only text: beside the prompt live the reference images
 * and their per-item presets (강도/충실도), which is exactly what NovelAI
 * takes (`reference_*_multiple`, docs/09 §7). Saving writes prompt.md and
 * preset.json; images upload into the card's folder as they are added.
 */
function drawCharacterEditor(dir: string): void {
  if (!viewMount) return;
  clear(viewMount);
  const isNew = !dir;
  const out = el('div', { class: 'hint' });

  const name = el('input', { placeholder: '히나' }) as HTMLInputElement;
  const caption = el('textarea', { rows: '4', class: 'promptedit',
    placeholder: '이 캐릭터를 그리는 프롬프트 (쉼표로 구분)' }) as HTMLTextAreaElement;
  const negative = el('textarea', { rows: '2', class: 'promptedit',
    placeholder: '이 캐릭터에만 붙는 네거티브' }) as HTMLTextAreaElement;
  const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const order = el('input', { type: 'number', value: '100', step: '10' }) as HTMLInputElement;
  const posX = el('input', { type: 'number', step: '0.1', placeholder: 'x 0~1' }) as HTMLInputElement;
  const posY = el('input', { type: 'number', step: '0.1', placeholder: 'y 0~1' }) as HTMLInputElement;

  interface RefEntry { file: string; strength: number; informationExtracted: number; enabled: boolean; pendingB64?: string }
  interface CharRefEntry { file: string; strength: number; fidelity: number;
                           mode: 'character' | 'character&style'; enabled: boolean; pendingB64?: string }
  let vibes: RefEntry[] = [];
  let charrefs: CharRefEntry[] = [];
  /** 바이브와 캐릭터 레퍼런스는 둘 중 하나만 실린다 - 탭이 그 선택이다. */
  let refMode: 'charref' | 'vibe' = 'charref';
  const refList = el('div', { class: 'verlist' });
  const charrefList = el('div', { class: 'verlist' });

  // A picked file uploads NOW (into the card folder), not at 저장: the row
  // shows the real thumbnail immediately and a forgotten save cannot lose the
  // image. pendingB64 survives only for the legacy no-folder path.
  const uploadNow = async (fname: string, b64: string): Promise<boolean> => {
    if (!dir) return false;
    try {
      await state.uploadFile(fname, b64, true, dir);
      return true;
    } catch (e) {
      out.textContent = `${fname}: 올리지 못했습니다 — ${msg(e)}`;
      return false;
    }
  };

  const num01 = (value: number, title: string, onChange: (n: number) => void): HTMLInputElement => {
    const i = el('input', { type: 'number', step: '0.05', min: '0', max: '1',
                            value: String(value), title }) as HTMLInputElement;
    i.addEventListener('change', () => {
      const n = Math.min(1, Math.max(0, Number(i.value)));
      if (!Number.isNaN(n)) { i.value = String(n); onChange(n); }
    });
    return i;
  };

  const drawRefs = (): void => {
    clear(refList);
    if (!vibes.length) {
      refList.appendChild(el('div', { class: 'hint', text: 'PNG 를 올리면 바이브로 실립니다.' }));
    }
    vibes.forEach((v, i) => {
      const pic = v.pendingB64
        ? el('span', { class: 'hint', text: '(저장 시 올라갑니다)' })
        : workspaceImage(`${dir}/${v.file}`, v.file, { thumb: true });
      const strength = num01(v.strength, '강도 (reference_strength)', (n) => { v.strength = n; });
      const ie = num01(v.informationExtracted, '충실도 (information_extracted)',
                       (n) => { v.informationExtracted = n; });
      const on = el('input', { type: 'checkbox', title: '이 레퍼런스를 실을지' }) as HTMLInputElement;
      on.checked = v.enabled;
      on.addEventListener('change', () => { v.enabled = on.checked; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '목록에서 빼기 (파일은 남습니다)' });
      drop.addEventListener('click', () => { vibes = vibes.filter((_x, j) => j !== i); drawRefs(); });
      refList.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } }, [
        on, pic, el('span', { class: 'grow hint', text: v.file }),
        el('span', { class: 'hint', text: '강도' }), strength,
        el('span', { class: 'hint', text: '충실도' }), ie,
        drop,
      ]));
    });
  };

  const pickRef = el('input', { type: 'file', accept: 'image/png', multiple: true }) as HTMLInputElement;
  pickRef.addEventListener('change', () => {
    for (const f of Array.from(pickRef.files ?? [])) {
      const r = new FileReader();
      r.onload = () => {
        void (async () => {
          const s = String(r.result || '');
          const b64 = s.slice(s.indexOf(',') + 1);
          const entry: RefEntry = { file: f.name, strength: 0.6, informationExtracted: 1.0, enabled: true };
          if (!(await uploadNow(f.name, b64))) {
            if (!dir) entry.pendingB64 = b64; else return;
          }
          vibes.push(entry);
          drawRefs();
        })();
      };
      r.readAsDataURL(f);
    }
    pickRef.value = '';
  });

  // --- 캐릭터 레퍼런스 (director reference, docs/09 §7d) ---------------------
  // The internal encoder accepts only the 1024x1536 / 1536x1024 buckets, so
  // the upload is fitted here with a canvas (letterbox on black, the web
  // client's own preprocessing) - the backend only checks and refuses.
  const drawCharrefs = (): void => {
    clear(charrefList);
    if (!charrefs.length) {
      charrefList.appendChild(el('div', { class: 'hint', text: '이미지를 올리면 버킷 크기로 맞춰 저장됩니다.' }));
    }
    charrefs.forEach((v, i) => {
      const pic = v.pendingB64
        ? el('span', { class: 'hint', text: '(저장 시 올라갑니다)' })
        : workspaceImage(`${dir}/${v.file}`, v.file, { thumb: true });
      const mode = el('select', { title: '캐릭터만 가져올지, 그림체까지 가져올지' }) as HTMLSelectElement;
      mode.appendChild(el('option', { value: 'character', text: '캐릭터' }));
      mode.appendChild(el('option', { value: 'character&style', text: '캐릭터&스타일' }));
      mode.value = v.mode;
      mode.addEventListener('change', () => { v.mode = mode.value as CharRefEntry['mode']; });
      const strength = num01(v.strength, '강도 (strength)', (n) => { v.strength = n; });
      const fidelity = num01(v.fidelity, '충실도 (fidelity)', (n) => { v.fidelity = n; });
      const on = el('input', { type: 'checkbox', title: '이 레퍼런스를 실을지' }) as HTMLInputElement;
      on.checked = v.enabled;
      on.addEventListener('change', () => { v.enabled = on.checked; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '목록에서 빼기 (파일은 남습니다)' });
      drop.addEventListener('click', () => { charrefs = charrefs.filter((_x, j) => j !== i); drawCharrefs(); });
      charrefList.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } }, [
        on, pic, el('span', { class: 'grow hint', text: v.file }),
        mode,
        el('span', { class: 'hint', text: '강도' }), strength,
        el('span', { class: 'hint', text: '충실도' }), fidelity,
        drop,
      ]));
    });
  };

  const fitToBucket = async (f: File): Promise<{ name: string; b64: string } | null> => {
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('이미지를 읽지 못했습니다'));
        img.src = url;
      });
      const portrait = img.height >= img.width;
      const w = portrait ? 1024 : 1536;
      const h = portrait ? 1536 : 1024;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Letterbox on black (contain), not crop: the web client pads the same
      // way, and a reference with its edges cut off references less.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      const data = canvas.toDataURL('image/png');
      return { name: f.name.replace(/\.[^.]+$/, '') + `-${w}x${h}.png`,
               b64: data.slice(data.indexOf(',') + 1) };
    } catch {
      return null;
    }
  };

  const pickCharref = el('input', { type: 'file', accept: 'image/*', multiple: true }) as HTMLInputElement;
  pickCharref.addEventListener('change', async () => {
    for (const f of Array.from(pickCharref.files ?? [])) {
      const fitted = await fitToBucket(f);
      if (!fitted) { out.textContent = `${f.name}: 버킷 크기로 맞추지 못했습니다.`; continue; }
      const entry: CharRefEntry = { file: fitted.name, strength: 0.6, fidelity: 0.6,
                                    mode: 'character', enabled: true };
      if (!(await uploadNow(fitted.name, fitted.b64))) {
        if (!dir) entry.pendingB64 = fitted.b64; else continue;
      }
      charrefs.push(entry);
      drawCharrefs();
    }
    pickCharref.value = '';
  });

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { out.textContent = '이름을 입력해 주세요.'; return; }
    save.disabled = true;
    try {
      // Renaming the card renames its folder, same rule as the .md cards.
      if (dir) {
        try {
          const moved = await renameCardFile(dir, nm);
          if (moved !== dir) dir = moved;
        } catch (e) { out.textContent = '파일명 변경 실패 (이름만 저장됩니다): ' + msg(e); }
      }
      const stem = cardStem(nm);
      const target = dir || `studio/characters/${stem}`;
      for (const v of [...vibes, ...charrefs]) {
        if (v.pendingB64) {
          await state.uploadFile(v.file, v.pendingB64, true, target);
          delete v.pendingB64;
        }
      }
      const meta = new Map<string, string>([['name', nm]]);
      meta.set('enabled', enabledBox.checked ? 'true' : 'false');
      if (order.value.trim() && order.value.trim() !== '100') meta.set('order', String(Math.trunc(Number(order.value)) || 100));
      let body = `## 프롬프트\n${caption.value.trim()}\n`;
      if (negative.value.trim()) body += `\n## 네거티브\n${negative.value.trim()}\n`;
      await state.uploadFile('prompt.md', joinFront(meta, body), false, target);
      const position = (posX.value.trim() && posY.value.trim())
        ? { x: Number(posX.value), y: Number(posY.value) } : null;
      await state.uploadFile('preset.json', JSON.stringify({
        version: 1, position, refMode,
        vibe: vibes.map((v) => ({ file: v.file, strength: v.strength,
                                  informationExtracted: v.informationExtracted, enabled: v.enabled })),
        charref: charrefs.map((v) => ({ file: v.file, strength: v.strength,
                                        fidelity: v.fidelity, mode: v.mode, enabled: v.enabled })),
      }, null, 2), false, target);
      notice(`캐릭터 “${nm}” 를 저장했습니다.`, 'ok');
      selectedFile = target;
      await refreshArea('characters');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '카드 폴더째 지울까요?', async () => {
    if (!dir) return;
    try {
      await state.deleteFile(dir);
      selectedFile = '';
      await refreshArea('characters');
    } catch (e) { out.textContent = msg(e); }
  });

  const field = (label: string, node: HTMLElement, hint = '') =>
    el('label', { class: 'field' }, [
      el('span', { text: label }), node,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);

  // 레퍼런스는 탭이다: 바이브와 캐릭터 레퍼런스는 함께 실리지 않으므로
  // (refMode), 두 목록을 나란히 쌓는 대신 하나를 고른다. 기본은 캐릭터.
  const charBtn = el('button', { class: 'modebtn', text: '캐릭터 레퍼런스' }) as HTMLButtonElement;
  const vibeBtn = el('button', { class: 'modebtn', text: '바이브 레퍼런스' }) as HTMLButtonElement;
  const charPane = el('div', {}, [
    el('div', { class: 'hint', text: '장당 5 Anlas · v4.5 전용' }),
    charrefList,
    field('이미지 추가', pickCharref),
  ]);
  const vibePane = el('div', {}, [
    el('div', { class: 'hint', text: '인코딩 2 Anlas/장 (캐시 시 0) · v5 미지원' }),
    refList,
    field('PNG 추가', pickRef),
  ]);
  const syncRefTabs = (): void => {
    charBtn.classList.toggle('on', refMode === 'charref');
    vibeBtn.classList.toggle('on', refMode === 'vibe');
    charPane.style.display = refMode === 'charref' ? '' : 'none';
    vibePane.style.display = refMode === 'vibe' ? '' : 'none';
  };
  charBtn.addEventListener('click', () => { refMode = 'charref'; syncRefTabs(); });
  vibeBtn.addEventListener('click', () => { refMode = 'vibe'; syncRefTabs(); });
  if (status && status.charref === false) {
    refMode = 'vibe';
    charBtn.style.display = 'none';
  }

  viewMount.append(
    editorHead(dir || '새 캐릭터', [isNew ? null : del, save]),
    field('이름', name, '카드 폴더 이름과 프롬프트 조립에 쓰입니다'),
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'row' }, [enabledBox, el('span', { text: '활성 (생성에 실림)' })]),
      el('label', { class: 'field', style: { width: '130px', marginBottom: '0' } }, [el('span', { text: '순서' }), order]),
    ]),
    field('프롬프트', caption),
    field('네거티브', negative),
    el('div', { class: 'sectiontitle', text: '레퍼런스' }),
    el('div', { class: 'row', style: { gap: '6px', marginBottom: '6px' } }, [charBtn, vibeBtn]),
    charPane,
    vibePane,
    el('details', { class: 'advbox' }, [
      el('summary', { text: '고급' }),
      el('div', { class: 'row', style: { marginBottom: '8px' } }, [
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 x (여럿일 때)' }), posX]),
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 y' }), posY]),
      ]),
    ]),
    out,
  );
  syncRefTabs();
  drawRefs();
  drawCharrefs();

  if (dir) {
    void state.readFile(`${dir}/prompt.md`).then((r) => {
      const { meta, body } = splitFront(r.content);
      name.value = meta.get('name') ?? dir.split('/').pop() ?? '';
      enabledBox.checked = (meta.get('enabled') ?? '').toLowerCase() === 'true';
      order.value = meta.get('order') ?? '100';
      const secs = body.split(/^##+\s*(프롬프트|네거티브|positive|negative)\s*$/im);
      if (secs.length === 1) {
        caption.value = body.trim();
      } else {
        for (let i = 1; i + 1 < secs.length; i += 2) {
          const which = secs[i].toLowerCase();
          if (which === '네거티브' || which === 'negative') negative.value = secs[i + 1].trim();
          else caption.value = secs[i + 1].trim();
        }
      }
    }).catch((e) => { out.textContent = msg(e); });
    void state.readFile(`${dir}/preset.json`).then((r) => {
      try {
        const d = JSON.parse(r.content) as { position?: { x?: number; y?: number } | null;
                                             refMode?: string; vibe?: RefEntry[];
                                             charref?: (CharRefEntry & { description?: string })[] };
        if (d.position && typeof d.position === 'object') {
          posX.value = String(d.position.x ?? '');
          posY.value = String(d.position.y ?? '');
        }
        vibes = (d.vibe ?? []).map((v) => ({
          file: String(v.file || ''), strength: Number(v.strength ?? 0.6),
          informationExtracted: Number(v.informationExtracted ?? 1.0),
          enabled: v.enabled !== false,
        })).filter((v) => v.file);
        charrefs = (d.charref ?? []).map((v) => ({
          file: String(v.file || ''), strength: Number(v.strength ?? 0.6),
          fidelity: Number(v.fidelity ?? 0.6),
          mode: v.mode === 'character&style' ? 'character&style' as const : 'character' as const,
          enabled: v.enabled !== false,
        })).filter((v) => v.file);
        // Same inference the backend applies: an explicit refMode wins, an
        // old preset without one means "the list that has something".
        if (d.refMode === 'vibe' || d.refMode === 'charref') refMode = d.refMode;
        else if (vibes.length && !charrefs.length) refMode = 'vibe';
        if (status && status.charref === false) refMode = 'vibe';
        syncRefTabs();
        drawRefs();
        drawCharrefs();
      } catch { /* a fresh card has no preset yet */ }
    }).catch(() => { /* same */ });
  }
}

/** Scene presets shown raw on request ('원본 JSON') instead of as the form. */
const rawView = new Set<string>();

/**
 * A scene preset as a form: the preset name, then one row per scene. The file
 * stays NAIS3's shape (read_scenes reads it verbatim) - unknown top-level keys
 * are preserved on save, and '원본 JSON' opens the raw editor for anything the
 * form does not show.
 */
function drawSceneEditor(path: string): void {
  if (!viewMount) return;
  const out = el('div', { class: 'hint' });
  const name = el('input', { placeholder: '프리셋 이름' }) as HTMLInputElement;
  const list = el('div', { class: 'verlist' });
  let extra: Record<string, unknown> = { version: 1 };
  interface SceneRow { name: string; prompt: string; negativePrompt: string; width: number; height: number }
  let scenes: SceneRow[] = [];

  const drawRows = (): void => {
    clear(list);
    if (!scenes.length) list.appendChild(el('div', { class: 'hint', text: '씬이 없습니다.' }));
    scenes.forEach((s, i) => {
      const nm = el('input', { value: s.name, placeholder: '씬 이름 (파일명에 들어갑니다)' }) as HTMLInputElement;
      nm.addEventListener('change', () => { s.name = nm.value; });
      const pr = el('textarea', { rows: '2', class: 'promptedit', placeholder: '프롬프트' }) as HTMLTextAreaElement;
      pr.value = s.prompt;
      pr.addEventListener('change', () => { s.prompt = pr.value; });
      const ng = el('input', { value: s.negativePrompt, placeholder: '네거티브 (선택)' }) as HTMLInputElement;
      ng.addEventListener('change', () => { s.negativePrompt = ng.value; });
      const w = el('input', { type: 'number', value: s.width ? String(s.width) : '', placeholder: '가로' }) as HTMLInputElement;
      w.addEventListener('change', () => { s.width = Math.trunc(Number(w.value)) || 0; });
      const h = el('input', { type: 'number', value: s.height ? String(s.height) : '', placeholder: '세로' }) as HTMLInputElement;
      h.addEventListener('change', () => { s.height = Math.trunc(Number(h.value)) || 0; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '이 씬을 뺍니다' });
      drop.addEventListener('click', () => { scenes = scenes.filter((_x, j) => j !== i); drawRows(); });
      list.appendChild(el('div', { class: 'scenerow' }, [
        el('div', { class: 'row', style: { gap: '6px' } }, [
          nm, w, h, drop,
        ]),
        pr,
        ng,
      ]));
    });
  };

  const add = el('button', { class: 'ghost tiny', text: '＋ 씬 추가' });
  add.addEventListener('click', () => { scenes.push({ name: '', prompt: '', negativePrompt: '', width: 0, height: 0 }); drawRows(); });
  const raw = el('button', { class: 'ghost tiny', text: '원본 JSON' });
  raw.addEventListener('click', () => { rawView.add(path); drawCentre(); });

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      selectedFile = '';
      await refreshArea(path.split('/')[1]);
    } catch (e) { out.textContent = msg(e); }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '';
    try {
      const kept = scenes
        .map((s) => ({ name: s.name.trim(), prompt: s.prompt, negativePrompt: s.negativePrompt,
                       width: s.width || 0, height: s.height || 0 }))
        .filter((s) => s.name);
      if (scenes.length && !kept.length) { out.textContent = '씬 이름을 하나 이상 채워 주세요.'; return; }
      const doc = { ...extra, name: name.value.trim() || path.split('/').pop()!.replace(/\.json$/, ''), scenes: kept };
      const dir = path.slice(0, path.lastIndexOf('/'));
      await state.uploadFile(path.split('/').pop()!, JSON.stringify(doc, null, 2), false, dir);
      if (name.value.trim()) {
        try {
          const moved = await renameCardFile(path, name.value.trim());
          if (moved !== path) { path = moved; selectedFile = moved; }
        } catch (e) { out.textContent = '이름은 저장됐지만 파일명 변경은 실패했습니다: ' + msg(e); }
      }
      if (!out.textContent) out.textContent = '저장했습니다.';
      await refreshArea('scenes');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  viewMount.appendChild(el('div', {}, [
    editorHead(path, [raw, del, save]),
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('div', { class: 'sectiontitle', text: '씬' }),
    el('div', { class: 'hint', text: '씬마다 한 장씩 (장수만큼 반복) 생성되고, 씬 이름이 파일명의 감정 자리에 들어갑니다.' }),
    list,
    el('div', { class: 'row', style: { marginTop: '6px' } }, [add]),
    out,
  ]));

  void state.readFile(path).then((r) => {
    try {
      const d = JSON.parse(r.content) as Record<string, unknown>;
      const { scenes: rawScenes, name: rawName, ...rest } = d;
      extra = rest;
      name.value = String(rawName ?? '');
      scenes = (Array.isArray(rawScenes) ? rawScenes : []).map((s) => ({
        name: String((s as SceneRow).name ?? ''), prompt: String((s as SceneRow).prompt ?? ''),
        negativePrompt: String((s as SceneRow).negativePrompt ?? ''),
        width: Math.trunc(Number((s as SceneRow).width)) || 0,
        height: Math.trunc(Number((s as SceneRow).height)) || 0,
      }));
      drawRows();
    } catch (e) {
      out.textContent = 'JSON 을 읽지 못했습니다 — 원본 JSON 으로 여세요: ' + msg(e);
    }
  }).catch((e) => { out.textContent = msg(e); });
  drawRows();
}

/** A raw file (scene preset JSON, a fragment collection): text in place. */
function drawRawFile(path: string): void {
  if (!viewMount) return;
  const box = el('textarea', { rows: '22', class: 'promptedit' }) as HTMLTextAreaElement;
  const out = el('div', { class: 'hint' });
  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      selectedFile = '';
      await refreshArea(path.split('/')[1]);
    } catch (e) { out.textContent = msg(e); }
  });
  let form: HTMLElement | null = null;
  if (rawView.has(path)) {
    form = el('button', { class: 'ghost tiny', text: '폼 편집' });
    form.addEventListener('click', () => { rawView.delete(path); drawCentre(); });
  }
  viewMount.append(editorHead(path, [form, del, save]), box, out);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const fname = path.slice(path.lastIndexOf('/') + 1);
      await state.uploadFile(fname, box.value, false, dir);
      out.textContent = '저장했습니다.';
      await refreshArea(path.split('/')[1]);
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  void state.readFile(path).then((r) => {
    box.value = r.content;
    if (!r.textual) out.textContent = r.note || '텍스트 파일이 아닙니다.';
  }).catch((e) => { out.textContent = msg(e); });
}

async function showPlan(): Promise<void> {
  const out = genMount?.querySelector('.genstatus') as HTMLElement | null;
  if (!out) return;
  clear(out);
  try {
    const r = await state.studio.plan(spec());
    out.appendChild(el('div', { class: 'hint', text: `${r.items.length}장 · ${r.estimate.note}` }));
    // A `<collection.key>` no fragment provides is left in the prompt and
    // said out loud: it would otherwise generate happily and wrongly.
    const unresolved = [...new Set(r.items.flatMap((i) => i.unresolved ?? []))];
    if (unresolved.length) {
      out.appendChild(el('div', { class: 'notice err' }, [
        el('div', { text: `조각을 찾지 못한 참조 ${unresolved.length}개` }),
        el('div', { class: 'hint', text: unresolved.join(', ') }),
        el('div', { class: 'hint', text: '조각 프롬프트에 그 이름의 컬렉션을 만들어 주세요. 지금 생성하면 프롬프트에 그대로 들어갑니다.' }),
      ]));
    }
    for (const i of r.items.slice(0, 12)) {
      out.appendChild(el('div', { class: 'hint', text: `${i.name}  seed=${i.seed ?? '랜덤'}` }));
    }
    if (r.items.length > 12) out.appendChild(el('div', { class: 'hint', text: `… 이하 ${r.items.length - 12}개 생략` }));
  } catch (e) {
    out.appendChild(el('div', { class: 'hint err', text: msg(e) }));
  }
}

async function run(): Promise<void> {
  try {
    const r = await state.studio.generate(spec());
    jobId = r.jobId;
    notice(`배치를 시작했습니다 (${r.total}장). ${r.estimate.note}`, 'ok');
    queueView = true;
    queueJob = null;
    drawCentre();
    void pollJob();
  } catch (e) {
    notice('시작하지 못했습니다: ' + msg(e), 'err');
  }
}

function stateLabel(s: string): string {
  return ({ pending: '대기', running: '진행 중', done: '완료', partial: '일부 실패',
            error: '오류', cancelled: '중단됨' } as Record<string, string>)[s] ?? s;
}

/**
 * The live queue, in the centre pane - one row per planned image with where
 * it stands (완료 with its thumbnail, 실패 with the error, 생성 중, 대기).
 * The 1.5s job poll redraws it; the data is the job payload the backend
 * already keeps, plus its `current` marker.
 */
function drawQueue(): void {
  if (!viewMount) return;
  clear(viewMount);
  const back = el('button', { class: 'ghost tiny', text: '← 나가기' });
  back.addEventListener('click', () => { queueView = false; drawCentre(); });
  const j = queueJob;
  const head = el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    back,
    el('span', { class: 'sectiontitle grow', text: '생성 큐' + (j ? ` — ${stateLabel(j.state)}` : '') }),
  ]);
  viewMount.appendChild(head);
  if (!j || !j.payload) {
    viewMount.appendChild(el('div', { class: 'hint',
      text: jobId ? '읽는 중입니다…' : '진행 중인 배치가 없습니다.' }));
    void drawRecentJobs();
    return;
  }
  const p = j.payload;
  const running = j.state === 'running' || j.state === 'pending';
  const bits: string[] = [`${p.done}/${p.total}`];
  if (j.created_at) bits.push(`${Math.max(0, Math.round(Date.now() / 1000 - j.created_at))}s 경과`);
  const spent = j.result?.anlasSpent;
  if (typeof spent === 'number') bits.push(`Anlas ${spent} 소모`);
  head.appendChild(el('span', { class: 'hint', text: bits.join(' · ') }));
  if (running) {
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { void state.studio.cancelJob(j.id); });
    head.appendChild(cancel);
  }
  if (j.error) viewMount.appendChild(el('div', { class: 'notice err', text: j.error }));

  const savedBy = new Map<string, string>();
  for (const path of p.saved ?? []) savedBy.set(path.split('/').pop() ?? path, path);
  const failedBy = new Map((p.failed ?? []).map((f) => [f.name, f.error] as const));
  const list = el('div', { class: 'verlist' });
  for (const it of p.items ?? []) {
    let badge: HTMLElement;
    let pic: HTMLElement | null = null;
    const full = savedBy.get(it.name);
    if (failedBy.has(it.name)) {
      badge = el('span', { class: 'badge err', text: '실패' });
    } else if (full) {
      badge = el('span', { class: 'badge ok', text: '완료' });
      pic = workspaceImage(full, it.name, { thumb: true });
    } else if (running && p.current === it.name) {
      badge = el('span', { class: 'badge warn', text: '생성 중' });
    } else {
      badge = el('span', { class: 'badge', text: running ? '대기' : '—' });
    }
    list.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px', padding: '3px 0' } }, [
      badge, pic, el('span', { class: 'grow hint', text: it.name }),
    ]));
    const err = failedBy.get(it.name);
    if (err) list.appendChild(el('div', { class: 'hint err', style: { paddingLeft: '8px' }, text: err }));
  }
  viewMount.appendChild(list);
  if (!running) void drawRecentJobs();
}

/** The last few batches - a way back into a finished queue's detail. */
async function drawRecentJobs(): Promise<void> {
  if (!viewMount) return;
  const box = el('div', {});
  viewMount.appendChild(box);
  let jobs: StudioJob[] = [];
  try {
    jobs = (await state.studio.jobs()).jobs ?? [];
  } catch { return; }
  if (!box.isConnected || !jobs.length) return;
  box.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '12px' }, text: '최근 작업' }));
  for (const r of jobs) {
    if (queueJob && r.id === queueJob.id) continue;
    const row = el('div', { class: 'chatitem', style: { cursor: 'pointer' }, title: '이 배치의 큐 보기' }, [
      el('span', { class: 'grow', text: `${stateLabel(r.state)} · ${r.payload?.done ?? 0}/${r.payload?.total ?? 0}` }),
      el('span', { class: 'hint', text: r.id }),
    ]);
    row.addEventListener('click', () => { queueJob = r; drawQueue(); });
    box.appendChild(row);
  }
}

/**
 * Poll the batch. The same shape the panel already uses for permits and the
 * asset importer - the backend runs the work and this asks how far it got.
 */
async function pollJob(): Promise<void> {
  if (jobTimer) return;
  const tick = async () => {
    const out = genMount?.querySelector('.genstatus') as HTMLElement | null;
    if (!jobId || !out) return stop();
    let j;
    try {
      j = await state.studio.job(jobId);
    } catch {
      return stop();
    }
    const p = j.payload;
    queueJob = j;
    if (queueView) drawQueue();
    clear(out);
    const line = el('div', { class: 'hint', style: { cursor: 'pointer' },
                             title: '진행 상황을 중앙에 크게 봅니다',
                             text: `${stateLabel(j.state)} · ${p?.done ?? 0}/${p?.total ?? 0}` });
    line.addEventListener('click', () => { queueView = true; drawCentre(); });
    out.appendChild(line);
    for (const f of (p?.failed ?? []).slice(0, 3)) {
      out.appendChild(el('div', { class: 'hint err', text: `${f.name}: ${f.error}` }));
    }
    if (['done', 'partial', 'error', 'cancelled'].includes(j.state)) {
      const spent = j.result?.anlasSpent;
      notice(`배치 ${j.state} — ${j.result?.saved ?? 0}장 저장`
        + (j.result?.failed ? `, ${j.result.failed}장 실패` : '')
        + (typeof spent === 'number' ? ` · Anlas ${spent} 소모` : ''),
        j.state === 'error' ? 'err' : 'ok');
      jobId = '';
      stop();
      // The batch wrote images: the files tab gets the news (and the unseen
      // badge) while we re-read our own slice.
      touchQuiet(p?.saved ?? []);
      await refresh();
      await loadStatus();
      return;
    }
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { void state.studio.cancelJob(jobId); });
    out.appendChild(cancel);
  };
  const stop = () => { if (jobTimer) { clearInterval(jobTimer); jobTimer = null; } };
  jobTimer = setInterval(() => { void tick(); }, 1500);
  await tick();
}

// --- the comparison selector -------------------------------------------------
//
// The model is `C:\code\image-selector`, reimplemented here in the panel's
// idiom. Two things carried over unchanged because they are the design:
//
//   - three flags per file (use / inpaint / delete), not one radio. A
//     candidate can be none of them, and "this one needs fixing first" is a
//     different answer from "this one is the keeper".
//   - the files the regex could NOT read are a group of their own. Names are
//     not deterministic - that is why this screen exists - so hiding the
//     unreadable ones would hide exactly the work.

let groups: StudioGroups | null = null;
let selection: SelectionMap = {};
let columns = 3;
let drill = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function loadGroups(folder: string): Promise<void> {
  try {
    groups = await state.studio.group(folder, gen.pattern);
    selection = {};
    for (const g of [...groups.groups.map((x) => x.items), groups.unmatched].flat()) {
      selection[g.filename] = { ...g.selection };
    }
  } catch (e) {
    groups = null;
    notice('그룹을 읽지 못했습니다: ' + msg(e), 'err');
  }
  drawCentre();
}

/** Debounced, like image-selector: a click should not wait on a round trip. */
function flag(filename: string, key: keyof SelectionState): void {
  const cur = selection[filename] || { use: false, inpaint: false, delete: false };
  selection[filename] = { ...cur, [key]: !cur[key] };
  drawCentre();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void state.studio.saveSelection(selected, selection).catch(() => { /* retried on the next click */ });
  }, 500);
}

function drawSelector(node: Folder): void {
  if (!viewMount || !groups) return;
  const g = groups;

  const bar = el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } });
  bar.append(
    el('span', { class: 'sectiontitle grow', text: `${node.path} · ${g.total}장 · 그룹 ${g.groups.length}` }),
  );
  for (const n of [2, 3, 4, 5, 6]) {
    const b = el('button', { class: 'ghost tiny' + (columns === n ? ' on' : ''), text: String(n) });
    b.addEventListener('click', () => { columns = n; drawCentre(); });
    bar.appendChild(b);
  }
  const firstEach = el('button', { class: 'ghost tiny', text: '그룹마다 첫 장' });
  firstEach.addEventListener('click', () => {
    for (const grp of g.groups) {
      const f = grp.items[0];
      if (f) selection[f.filename] = { ...selection[f.filename], use: true };
    }
    drawCentre();
    void state.studio.saveSelection(selected, selection);
  });
  const none = el('button', { class: 'ghost tiny', text: '선택 해제' });
  none.addEventListener('click', () => {
    for (const k of Object.keys(selection)) selection[k] = { ...selection[k], use: false };
    drawCentre();
    void state.studio.saveSelection(selected, selection);
  });
  bar.append(firstEach, none, exportButton(node), adoptButton());
  viewMount.appendChild(bar);

  // A pattern box with a live count: the regex is the thing most likely to be
  // wrong, so how many files it reads is on screen while you edit it.
  const pat = el('input', { value: gen.pattern, placeholder: g.pattern }) as HTMLInputElement;
  pat.addEventListener('change', () => { gen.pattern = pat.value; void loadGroups(selected); });
  viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    el('span', { class: 'hint', text: '이름 규칙' }), pat,
    el('span', { class: 'hint', text: `읽음 ${g.total - g.unmatched.length} / 못 읽음 ${g.unmatched.length}` }),
  ]));

  if (drill) {
    const grp = g.groups.find((x) => x.key === drill);
    const at = g.groups.findIndex((x) => x.key === drill);
    const nav = el('div', { class: 'row', style: { marginBottom: '8px' } });
    const go = (to: number) => { drill = g.groups[to]?.key ?? drill; drawCentre(); };
    const prev = el('button', { class: 'ghost tiny', text: '← 이전' }) as HTMLButtonElement;
    const back = el('button', { class: 'ghost tiny', text: '전체' });
    const next = el('button', { class: 'ghost tiny', text: '다음 →' }) as HTMLButtonElement;
    prev.disabled = at <= 0;
    next.disabled = at < 0 || at >= g.groups.length - 1;
    prev.addEventListener('click', () => go(at - 1));
    next.addEventListener('click', () => go(at + 1));
    back.addEventListener('click', () => { drill = ''; drawCentre(); });
    nav.append(prev, back, next, el('span', { class: 'sectiontitle', text: `${drill} · ${grp?.items.length ?? 0}장` }));
    viewMount.appendChild(nav);
    viewMount.appendChild(candidateGrid(grp?.items ?? []));
    return;
  }

  for (const grp of g.groups) {
    const head = el('div', { class: 'row', style: { marginTop: '10px' } });
    const open2 = el('button', { class: 'ghost tiny', text: '크게 보기' });
    open2.addEventListener('click', () => { drill = grp.key; drawCentre(); });
    const chosen = grp.items.filter((i) => selection[i.filename]?.use).length;
    head.append(
      el('span', { class: 'sectiontitle grow', text: `${grp.key} · ${grp.items.length}장` }),
      el('span', { class: 'badge' + (chosen ? '' : ' warn'), text: chosen ? `선택 ${chosen}` : '미선택' }),
      open2,
    );
    viewMount.appendChild(head);
    viewMount.appendChild(candidateGrid(grp.items));
  }

  if (g.unmatched.length) {
    viewMount.appendChild(el('div', { class: 'sectionline' }));
    viewMount.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } }, [
      el('span', { class: 'sectiontitle grow', text: `이름 규칙에 안 맞는 파일 ${g.unmatched.length}개` }),
    ]));
    viewMount.appendChild(el('div', { class: 'hint', text:
      '이 파일들은 그룹에 못 들어갑니다. 히나에게 “이 폴더 이름 규칙에 맞게 일괄로 바꿔 줘” 라고 하세요 (studio_rename).' }));
    viewMount.appendChild(candidateGrid(g.unmatched));
  }
}

function candidateGrid(items: GroupItem[]): HTMLElement {
  const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } });
  for (const it of items) grid.appendChild(candidate(it));
  return grid;
}

function candidate(it: GroupItem): HTMLElement {
  const s = selection[it.filename] || { use: false, inpaint: false, delete: false };
  const pic = el('div', { class: 'assetpic' });
  const cls = 'fcell selcell'
    + (s.use ? ' picked' : '') + (s.inpaint ? ' fixing' : '') + (s.delete ? ' dropping' : '');
  const flags = el('div', { class: 'row selflags' });
  const mk = (key: keyof SelectionState, label: string, title: string) => {
    const b = el('button', { class: 'ghost tiny' + (s[key] ? ' on' : ''), text: label, title });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); flag(it.filename, key); });
    return b;
  };
  flags.append(
    mk('use', '채택', '이걸 봇에 넣습니다'),
    mk('inpaint', '수정', '먼저 고쳐야 합니다'),
    mk('delete', '버림', '지울 후보입니다'),
  );
  const cell2 = el('div', { class: cls, title: it.filename }, [
    pic, el('div', { class: 'fname', text: it.filename }), flags,
  ]);
  // The picture itself toggles 채택: that is the click being made ninety times.
  pic.addEventListener('click', () => flag(it.filename, 'use'));
  void loadThumb({ path: it.path, name: it.filename, size: 0, modified: 0, textual: false }, pic);
  return cell2;
}

function exportButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '내보내기' }) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await state.studio.exportSelected(node.path, gen.characterName, gen.pattern);
      notice(`${r.folder} — 채택 ${r.used}, 수정 ${r.inpaint}, 빈 슬롯 ${r.empty}`, 'ok');
      touchQuiet();
      await refresh();
    } catch (e) {
      notice('내보내지 못했습니다: ' + msg(e), 'err');
    } finally { b.disabled = false; }
  });
  return b;
}

/**
 * Adopt straight into the bot — the primary path, with export as the
 * reviewable alternative. Needs a bot, and only here: the rest of the tab
 * does not (see the module header).
 */
function adoptButton(): HTMLElement {
  const b = el('button', { class: 'primary tiny', text: '봇에 반영' }) as HTMLButtonElement;
  b.title = state.activeCharKey
    ? '채택한 이미지를 이 봇의 감정 이미지로 넣자고 제안합니다'
    : 'RisuAI에서 봇을 열어야 반영할 수 있습니다';
  b.disabled = !state.activeCharKey;
  b.addEventListener('click', async () => {
    const picked = Object.entries(selection).filter(([, s]) => s.use).map(([f]) => f);
    if (!picked.length) { notice('채택한 이미지가 없습니다.', 'err'); return; }
    b.disabled = true;
    try {
      const paths = picked.map((f) => `${selected}/${f}`);
      const r = await state.studio.stage(state.activeCharKey, paths);
      notice(`${r.staged.length}장을 확인했습니다. `
        + '히나에게 "채택한 이미지들을 감정 이미지로 넣어 줘" 라고 하면 승인 후 카드에 붙습니다.'
        + (r.failed.length ? ` (${r.failed.length}장 확인 실패)` : ''), 'ok');
    } catch (e) {
      notice('옮기지 못했습니다: ' + msg(e), 'err');
    } finally { b.disabled = !state.activeCharKey; }
  });
  return b;
}

function newFolderButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '＋ 폴더' }) as HTMLButtonElement;
  b.addEventListener('click', () => {
    const name = (prompt('새 폴더 이름', '') || '').trim();
    if (!name) return;
    b.disabled = true;
    void state.mkdirFile(node.path + '/' + name)
      .then(() => { open.add(node.path); touchQuiet(); return refresh(); })
      .catch((e) => notice('폴더를 만들지 못했습니다: ' + msg(e), 'err'))
      .finally(() => { b.disabled = false; });
  });
  return b;
}

function fileRow(f: WorkspaceFile): HTMLElement {
  const del = el('button', { class: 'ghost tiny', title: '삭제' }) as HTMLButtonElement;
  const rowEl = el('div', { class: 'chatitem' }, [
    el('span', { class: 'grow', text: f.name }),
    el('span', { class: 'n', text: fmtSize(f.size) }),
    del,
  ]);
  armed(del, '✕', '삭제 확인', async () => {
    del.disabled = true;
    try {
      await state.deleteFile(f.path);
      touchQuiet();
      await refresh();
    } catch (e) {
      del.disabled = false;
      notice('지우지 못했습니다: ' + msg(e), 'err');
    }
  });
  return rowEl;
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
      const bytes = await state.fileBytes(f.path);
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
