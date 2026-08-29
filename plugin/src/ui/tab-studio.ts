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
import { el, clear, armed, modal } from './dom';
import { state, type FileListing, type GroupItem, type SelectionMap, type SelectionState,
         type StudioGroups, type StudioItem, type StudioStatus, type WorkspaceFile } from '../state';
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
let genMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let listing: FileListing | null = null;
let roots: Folder[] = [];
let selected = 'images';
const open = new Set<string>(['images']);
const thumbs = new Map<string, string>();

/** What the generation card is set to. Held across renders, saved per panel. */
const gen = {
  model: 'nai-diffusion-4-5-full',
  style: '', character: '', emotionPreset: '',
  characterName: '', outfit: '',
  steps: 23, scale: 5, width: 832, height: 1216, count: 1, seed: '',
  folder: 'images',
  // The one control that certainly spends Anlas, so it is off unless asked.
  useReference: false, refStrength: 0.6,
  // The selector's regex. Empty means the backend's default; it is edited on
  // screen because it is the thing most likely to need adjusting.
  pattern: '',
};
let status: StudioStatus | null = null;
let jobId = '';
let jobTimer: ReturnType<typeof setInterval> | null = null;

export function renderStudioTab(mount: HTMLElement): void {
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree filetree' });
    genMount = el('div', { class: 'genpanel' });
    pane.left.append(treeMount, genMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad filepad' });
    pane.centre.append(noticeMount, viewMount);
    mount.appendChild(pane.root);
    built = true;
    void refresh();
    void loadStatus();
  } else {
    // Re-entering the tab re-reads the library. Files arrive from outside this
    // view - a batch Hina ran, a drop onto the files tab, another machine
    // writing into the same library - and a stale tree that silently omits
    // them is worse than the one extra listing call.
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

/**
 * The generation card, under the tree.
 *
 * Left, because none of it changes inside one batch: you pick a model, a
 * style, a character and an emotion set, and then produce a run. The two
 * meters live here too — Anlas and the v5 quota are different currencies and
 * neither is derived from the other, so both are shown as NovelAI reports
 * them (docs/09 §2).
 */
function drawGen(): void {
  if (!genMount) return;
  clear(genMount);
  genMount.appendChild(el('div', { class: 'sectionline' }));
  genMount.appendChild(el('div', { class: 'sectiontitle', text: '생성' }));

  if (!status) {
    genMount.appendChild(el('div', { class: 'hint', text: '상태를 읽는 중입니다…' }));
    return;
  }
  if (!status.configured) {
    genMount.appendChild(el('div', { class: 'notice' }, [
      el('div', { class: 'hint', text: status.note || status.error || 'NovelAI 토큰이 없습니다.' }),
      el('div', { class: 'hint', style: { marginTop: '4px' },
                  text: '토큰 없이도 이미지를 넣고, 정리하고, 봇에 반영할 수 있습니다.' }),
    ]));
    return;
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
  modelInput.addEventListener('change', () => { gen.model = modelInput.value.trim(); });
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

  genMount.append(
    field('모델', modelInput),
    el('div', { class: 'row' }, [checkBtn, checkOut]),
    pickerField('스타일', 'styles', 'style'),
    pickerField('캐릭터', 'characters', 'character'),
    characterButtons(),
    pickerField('감정 프리셋', 'emotions', 'emotionPreset'),
    referenceToggle(),
  );

  const two = (a: HTMLElement, b: HTMLElement) => el('div', { class: 'row' }, [a, b]);
  genMount.append(
    two(numField('스텝', 'steps'), numField('CFG', 'scale')),
    two(numField('가로', 'width'), numField('세로', 'height')),
    two(numField('장수', 'count'), textField('시드', 'seed', '비우면 랜덤')),
    two(textField('캐릭터명', 'characterName', '파일 이름에 들어갑니다'),
        textField('복장', 'outfit', '파일 이름에 들어갑니다')),
    textField('저장 폴더', 'folder', 'images/…'),
  );

  const planBtn = el('button', { class: 'ghost tiny', text: '계획 보기' }) as HTMLButtonElement;
  const runBtn = el('button', { class: 'primary tiny', text: '생성 시작' }) as HTMLButtonElement;
  planBtn.addEventListener('click', () => void showPlan());
  runBtn.addEventListener('click', () => void run());
  genMount.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } }, [planBtn, runBtn]));
  genMount.appendChild(el('div', { class: 'genstatus' }));
  if (jobId) void pollJob();
}

function characterButtons(): HTMLElement {
  const add = el('button', { class: 'ghost tiny', text: '＋ 새 캐릭터' });
  const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
  add.addEventListener('click', () => openCharacter(''));
  edit.addEventListener('click', () => { if (gen.character) openCharacter(gen.character); });
  edit.disabled = !gen.character;
  return el('div', { class: 'row' }, [add, edit]);
}

/**
 * Whether this batch uses the character's reference image.
 *
 * Off by default and labelled with its price, because this is the one control
 * on the card that certainly spends Anlas: an encode is 2 each, and v5 cannot
 * do it at all (docs/09 §7). The encoding is cached, so a second batch with
 * the same reference costs nothing.
 */
function referenceToggle(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = gen.useReference;
  const strength = el('input', { type: 'number', value: String(gen.refStrength), step: '0.05' }) as HTMLInputElement;
  strength.addEventListener('change', () => { gen.refStrength = Number(strength.value) || gen.refStrength; });
  const why = el('div', { class: 'hint' });
  const sync = () => {
    gen.useReference = box.checked;
    const v5 = !gen.model.includes('diffusion-4');
    why.textContent = !gen.character
      ? '캐릭터를 먼저 고르세요.'
      : v5
        ? 'v5 모델은 레퍼런스를 지원하지 않습니다 — 4.5 를 고르세요.'
        : (box.checked ? '인코딩 2 Anlas (캐시되면 0). 배치당 한 번입니다.' : '');
    strength.disabled = !box.checked;
  };
  box.addEventListener('change', sync);
  sync();
  return el('div', {}, [
    el('label', { class: 'row' }, [box, el('span', { text: '레퍼런스 이미지 사용 (바이브)' })]),
    el('label', { class: 'field' }, [el('span', { text: '강도' }), strength]),
    why,
  ]);
}

function spec(): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: gen.model,
    characterName: gen.characterName, outfit: gen.outfit,
    count: gen.count, folder: gen.folder,
    params: { steps: gen.steps, scale: gen.scale, width: gen.width, height: gen.height },
  };
  if (gen.style) out.style = gen.style;
  if (gen.character) out.characters = [gen.character];
  if (gen.emotionPreset) out.emotionPreset = gen.emotionPreset;
  if (gen.seed.trim()) out.seed = Number(gen.seed.trim());
  // A reference is a list entry with its own strength: NovelAI takes several
  // (reference_*_multiple), and the backend encodes each once per batch.
  if (gen.useReference && gen.character) {
    out.vibes = [{ path: gen.character.replace(/\.json$/, '.png'), strength: gen.refStrength }];
  }
  return out;
}

function numField(label: string, key: 'steps' | 'scale' | 'width' | 'height' | 'count'): HTMLElement {
  const i = el('input', { value: String(gen[key]), type: 'number' }) as HTMLInputElement;
  i.addEventListener('change', () => { gen[key] = Number(i.value) || gen[key]; });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function textField(label: string, key: 'seed' | 'characterName' | 'outfit' | 'folder',
                   placeholder = ''): HTMLElement {
  const i = el('input', { value: gen[key], placeholder }) as HTMLInputElement;
  i.addEventListener('change', () => { gen[key] = i.value; });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

/**
 * The character editor.
 *
 * A character is not a line of prose, which is why it is not a `.md` like a
 * style: it is a caption, a negative, and — the part a text file cannot hold —
 * a **reference image**. NovelAI takes references as a list with per-item
 * strengths (`reference_*_multiple`, docs/09 §7), and a reference has to be
 * encoded before it can be used, at 2 Anlas a time. So the reference lives
 * beside the JSON as `<name>.png` and is encoded once per batch, cached.
 *
 * Position (`char_captions` + `use_coords`) is what puts several characters in
 * one image; that is the next increment and the field is written here so the
 * files are already the right shape.
 */
function openCharacter(path: string): void {
  const body = el('div', { class: 'verlist' });
  const out = el('div', { class: 'hint' });
  const close = modal(path ? '캐릭터 편집' : '새 캐릭터', body, { sticky: true });

  const name = el('input', { placeholder: '히나' }) as HTMLInputElement;
  const caption = el('textarea', { rows: '3', placeholder: '1girl, silver hair, blue eyes' }) as HTMLTextAreaElement;
  const negative = el('textarea', { rows: '2', placeholder: 'multiple girls' }) as HTMLTextAreaElement;
  const folder = el('input', { value: 'characters', placeholder: 'characters/폴더' }) as HTMLInputElement;
  const refInfo = el('div', { class: 'hint' });
  let refBytes: string = '';

  const pickRef = el('input', { type: 'file', accept: 'image/png' }) as HTMLInputElement;
  pickRef.addEventListener('change', () => {
    const f = pickRef.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      refBytes = s.slice(s.indexOf(',') + 1);
      refInfo.textContent = `${f.name} · ${Math.round(f.size / 1024)}KB — 저장하면 함께 들어갑니다`;
    };
    r.readAsDataURL(f);
  });

  if (path) {
    void state.studio.read(path).then((r) => {
      try {
        const d = JSON.parse(r.content) as Record<string, unknown>;
        name.value = String(d.name ?? '');
        caption.value = String(d.caption ?? d.prompt ?? '');
        negative.value = String(d.negative ?? '');
        folder.value = path.slice(0, path.lastIndexOf('/')) || 'characters';
        if (d.reference) refInfo.textContent = '레퍼런스: ' + String(d.reference);
      } catch { out.textContent = '이 파일을 읽지 못했습니다 (JSON 아님).'; }
    }).catch((e) => { out.textContent = msg(e); });
  }

  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { out.textContent = '이름을 입력해 주세요.'; return; }
    save.disabled = true;
    try {
      const dir = folder.value.trim() || 'characters';
      const stem = nm.replace(/[<>:"/\\|?*]/g, '');
      if (refBytes) {
        await state.studio.upload(dir, stem + '.png', refBytes);
      }
      await state.studio.write(dir, stem + '.json', JSON.stringify({
        name: nm,
        caption: caption.value.trim(),
        negative: negative.value.trim(),
        // Beside the JSON, same stem: one thing to move, one thing to delete.
        reference: refBytes || refInfo.textContent ? `${dir}/${stem}.png` : '',
        position: null,
      }, null, 2));
      close();
      notice(`캐릭터 “${nm}” 를 저장했습니다.`, 'ok');
      await refresh();
      drawGen();
    } catch (e) {
      out.textContent = msg(e);
      save.disabled = false;
    }
  });
  const cancel = el('button', { class: 'ghost', text: '취소' });
  cancel.addEventListener('click', close);

  const field = (label: string, node: HTMLElement, hint = '') =>
    el('label', { class: 'field' }, [
      el('span', { text: label }), node,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);

  body.append(
    field('이름', name, '파일 이름과 프롬프트 조립에 쓰입니다'),
    field('프롬프트', caption),
    field('네거티브', negative),
    field('레퍼런스 이미지 (PNG)', pickRef,
          '바이브 트랜스퍼용입니다. 인코딩은 회당 2 Anlas 이고 배치마다 한 번만 합니다. v5 모델은 아직 지원하지 않습니다.'),
    refInfo,
    field('폴더', folder),
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save, cancel]),
    out,
  );
}

/** A <select> of one library area, filled when the card is drawn. */
function pickerField(label: string, area: string, key: 'style' | 'character' | 'emotionPreset'): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  sel.appendChild(el('option', { value: '', text: '(없음)' }));
  sel.addEventListener('change', () => { gen[key] = sel.value; });
  void state.studio.items(area).then((r) => {
    for (const it of r.items as StudioItem[]) {
      const o = el('option', { value: it.path, text: it.name + (it.count ? ` (${it.count})` : '') });
      if (it.path === gen[key]) o.setAttribute('selected', 'selected');
      sel.appendChild(o);
    }
    sel.value = gen[key];
  }).catch(() => { /* the area may simply be empty */ });
  return el('label', { class: 'field' }, [el('span', { text: label }), sel]);
}

async function showPlan(): Promise<void> {
  const out = genMount?.querySelector('.genstatus') as HTMLElement | null;
  if (!out) return;
  clear(out);
  try {
    const r = await state.studio.plan(spec());
    out.appendChild(el('div', { class: 'hint', text: `${r.items.length}장 · ${r.estimate.note}` }));
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
    void pollJob();
  } catch (e) {
    notice('시작하지 못했습니다: ' + msg(e), 'err');
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
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: `${j.state} · ${p?.done ?? 0}/${p?.total ?? 0}` }));
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

  // Under images/, comparing is the job, so the selector replaces the plain
  // grid: candidates are looked at against each other, not browsed.
  if (isImagesFolder(node.path) && node.files.some((f) => IMAGE_RE.test(f.name))) {
    if (!groups || groups.folder !== node.path) {
      viewMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
      void loadGroups(node.path);
      return;
    }
    drawSelector(node);
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

function isImagesFolder(path: string): boolean {
  return path === 'images' || path.startsWith('images/');
}

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
    const open = el('button', { class: 'ghost tiny', text: '크게 보기' });
    open.addEventListener('click', () => { drill = grp.key; drawCentre(); });
    const chosen = grp.items.filter((i) => selection[i.filename]?.use).length;
    head.append(
      el('span', { class: 'sectiontitle grow', text: `${grp.key} · ${grp.items.length}장` }),
      el('span', { class: 'badge' + (chosen ? '' : ' warn'), text: chosen ? `선택 ${chosen}` : '미선택' }),
      open,
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
  const cell = el('div', { class: cls, title: it.filename }, [
    pic, el('div', { class: 'fname', text: it.filename }), flags,
  ]);
  // The picture itself toggles 채택: that is the click being made ninety times.
  pic.addEventListener('click', () => flag(it.filename, 'use'));
  void loadThumb({ path: it.path, name: it.filename, size: 0, modified: 0, textual: false }, pic);
  return cell;
}

function exportButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '내보내기' }) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const r = await state.studio.exportSelected(node.path, gen.characterName, gen.pattern);
      notice(`${r.folder} — 채택 ${r.used}, 수정 ${r.inpaint}, 빈 슬롯 ${r.empty}`, 'ok');
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
      notice(`${r.staged.length}장을 봇 워크스페이스로 옮겼습니다. `
        + '히나에게 "방금 옮긴 것들을 감정 이미지로 넣어 줘" 라고 하면 승인 후 카드에 붙습니다.'
        + (r.failed.length ? ` (${r.failed.length}장 실패)` : ''), 'ok');
    } catch (e) {
      notice('옮기지 못했습니다: ' + msg(e), 'err');
    } finally { b.disabled = !state.activeCharKey; }
  });
  return b;
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
