/**
 * The comparison selector, under images/.
 *
 * The model is the standalone image-selector tool, reimplemented in the
 * panel's idiom. Two things carried over unchanged because they are the
 * design:
 *
 *   - three flags per file (use / inpaint / delete), not one radio. A
 *     candidate can be none of them, and "this one needs fixing first" is a
 *     different answer from "this one is the keeper".
 *   - the files the regex could NOT read are a group of their own. Names are
 *     not deterministic - that is why this screen exists - so hiding the
 *     unreadable ones would hide exactly the work.
 */
import { el, clear } from '../dom';
import { state, type GroupItem, type SelectionMap, type SelectionState,
         type StudioGroups, type WorkspaceFile } from '../../state';
import { S, hub, gen, msg, adjustReserve, activeCast, castById, type Folder } from './store';
import { scenesOf } from './center-batch';

let groups: StudioGroups | null = null;
let selection: SelectionMap = {};
let columns = 3;
let drill = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let patternTimer: ReturnType<typeof setTimeout> | null = null;

// The regex and the group-by field, remembered PER FOLDER: a costume-emotion
// folder and a plain emotion folder read by different rules (4.14).
interface GroupPrefs { pattern: string; groupBy: string }
const PREFS_KEY = 'hina.studioGroupBy';
let prefs: Record<string, GroupPrefs> = {};
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as Record<string, GroupPrefs> | null;
  if (saved && typeof saved === 'object') prefs = saved;
} catch { /* storage may be unavailable in the iframe */ }

function prefsFor(folder: string): GroupPrefs {
  return prefs[folder] ?? { pattern: gen.pattern, groupBy: 'emotion' };
}

function setPrefs(folder: string, next: GroupPrefs): void {
  prefs[folder] = next;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ }
}

/** Whether the loaded groups belong to this folder - drawCentre's gate. */
export function hasGroups(folder: string): boolean {
  return !!groups && groups.folder === folder;
}

export async function loadGroups(folder: string): Promise<void> {
  try {
    const p = prefsFor(folder);
    groups = await state.studio.group(folder, p.pattern, p.groupBy);
    selection = {};
    for (const g of [...groups.groups.map((x) => x.items), groups.unmatched].flat()) {
      selection[g.filename] = { ...g.selection };
    }
  } catch (e) {
    groups = null;
    hub.notice('그룹을 읽지 못했습니다: ' + msg(e), 'err');
  }
  hub.drawCentre();
}

/** Debounced, like image-selector: a click should not wait on a round trip. */
function flag(filename: string, key: keyof SelectionState): void {
  const cur = selection[filename] || { use: false, inpaint: false, delete: false };
  selection[filename] = { ...cur, [key]: !cur[key] };
  hub.drawCentre();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void state.studio.saveSelection(S.selected, selection).catch(() => { /* retried on the next click */ });
  }, 500);
}

export function drawSelector(node: Folder): void {
  if (!S.viewMount || !groups) return;
  const viewMount = S.viewMount;
  const g = groups;

  const bar = el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } });
  const back = el('button', { class: 'ghost tiny', text: '← 폴더', title: '폴더 보기로 돌아갑니다' });
  back.addEventListener('click', () => { S.centreMode = 'folder'; hub.drawCentre(); });
  bar.append(
    back,
    el('span', { class: 'sectiontitle grow', text: `${node.path} · ${g.total}장 · 그룹 ${g.groups.length}` }),
  );
  for (const n of [2, 3, 4, 5, 6]) {
    const b = el('button', { class: 'ghost tiny' + (columns === n ? ' on' : ''), text: String(n) });
    b.addEventListener('click', () => { columns = n; hub.drawCentre(); });
    bar.appendChild(b);
  }
  const firstEach = el('button', { class: 'ghost tiny', text: '그룹마다 첫 장' });
  firstEach.addEventListener('click', () => {
    for (const grp of g.groups) {
      const f = grp.items[0];
      if (f) selection[f.filename] = { ...selection[f.filename], use: true };
    }
    hub.drawCentre();
    void state.studio.saveSelection(S.selected, selection);
  });
  const none = el('button', { class: 'ghost tiny', text: '선택 해제' });
  none.addEventListener('click', () => {
    for (const k of Object.keys(selection)) selection[k] = { ...selection[k], use: false };
    hub.drawCentre();
    void state.studio.saveSelection(S.selected, selection);
  });
  bar.append(firstEach, none, exportButton(node), adoptButton());
  viewMount.appendChild(bar);

  // A pattern box with a live count: the regex is the thing most likely to be
  // wrong, so how many files it reads is on screen while you edit it - and a
  // group-by picker over the fields the regex actually produced, so one
  // costume-emotion folder can be read by 복장 today and 감정 tomorrow (4.14).
  const cur = prefsFor(node.path);
  const pat = el('input', {
    value: cur.pattern, placeholder: g.pattern,
    title: '명명 캡처그룹 정규식 — 예: (?P<costume>[^-]+)-(?P<emotion>[^-]+)',
  }) as HTMLInputElement;
  pat.addEventListener('input', () => {
    if (patternTimer) clearTimeout(patternTimer);
    patternTimer = setTimeout(() => {
      setPrefs(node.path, { ...prefsFor(node.path), pattern: pat.value });
      void loadGroups(node.path);
    }, 800);
  });
  const by = el('select', { title: '어느 필드로 묶어 볼지' }) as HTMLSelectElement;
  const fields = [...new Set([g.groupBy, ...(g.fields ?? [])])];
  for (const f of fields) {
    const o = el('option', { value: f, text: f });
    if (f === g.groupBy) o.setAttribute('selected', 'selected');
    by.appendChild(o);
  }
  by.addEventListener('change', () => {
    setPrefs(node.path, { ...prefsFor(node.path), groupBy: by.value });
    drill = '';
    void loadGroups(node.path);
  });
  viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } }, [
    el('span', { class: 'hint', text: '이름 규칙' }), pat,
    el('span', { class: 'hint', text: '그룹 기준' }), by,
    el('span', { class: 'hint', text: `읽음 ${g.total - g.unmatched.length} / 못 읽음 ${g.unmatched.length}` }),
  ]));

  // 부족분: groups where nothing is chosen and nothing is being fixed - the
  // slots the export would leave a placeholder for. One button turns them
  // into reservations, closing the cycle: 분류 → 부족분 → 다음 배치 (feedback).
  const missing = g.groups
    .filter((grp) => !grp.items.some((i) => selection[i.filename]?.use || selection[i.filename]?.inpaint))
    .map((grp) => grp.key);
  if (missing.length) {
    const fill = el('button', { class: 'ghost tiny', text: '부족분 예약에 담기',
      title: '씬 프리셋에서 같은 이름의 씬을 찾아 (지금 출연 × 1장) 씩 배치 예약에 넣습니다' }) as HTMLButtonElement;
    fill.addEventListener('click', () => void reserveMissing(missing, fill));
    viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'badge warn', text: `부족분 ${missing.length}개` }),
      el('span', { class: 'hint grow', text: missing.join(', ') }),
      fill,
    ]));
  }

  if (drill) {
    const grp = g.groups.find((x) => x.key === drill);
    const at = g.groups.findIndex((x) => x.key === drill);
    const nav = el('div', { class: 'row', style: { marginBottom: '8px' } });
    const go = (to: number) => { drill = g.groups[to]?.key ?? drill; hub.drawCentre(); };
    const prev = el('button', { class: 'ghost tiny', text: '← 이전' }) as HTMLButtonElement;
    const back = el('button', { class: 'ghost tiny', text: '전체' });
    const next = el('button', { class: 'ghost tiny', text: '다음 →' }) as HTMLButtonElement;
    prev.disabled = at <= 0;
    next.disabled = at < 0 || at >= g.groups.length - 1;
    prev.addEventListener('click', () => go(at - 1));
    next.addEventListener('click', () => go(at + 1));
    back.addEventListener('click', () => { drill = ''; hub.drawCentre(); });
    nav.append(prev, back, next, el('span', { class: 'sectiontitle', text: `${drill} · ${grp?.items.length ?? 0}장` }));
    viewMount.appendChild(nav);
    viewMount.appendChild(candidateGrid(grp?.items ?? []));
    return;
  }

  for (const grp of g.groups) {
    const head = el('div', { class: 'row', style: { marginTop: '10px' } });
    const open2 = el('button', { class: 'ghost tiny', text: '크게 보기' });
    open2.addEventListener('click', () => { drill = grp.key; hub.drawCentre(); });
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

/** Missing slots become reservations: same-named scenes in the current
 * preset, current cast, one each. Names with no scene are reported. */
async function reserveMissing(missing: string[], btn: HTMLButtonElement): Promise<void> {
  if (!gen.scenePreset) {
    hub.notice('씬 프리셋이 없습니다 — 배치 탭에서 프리셋을 먼저 고르세요.', 'err');
    return;
  }
  btn.disabled = true;
  try {
    const known = new Set((await scenesOf(gen.scenePreset)).map((s) => s.name));
    const found = missing.filter((k) => known.has(k));
    const lost = missing.filter((k) => !known.has(k));
    for (const k of found) adjustReserve(gen.scenePreset, k, activeCast, +1);
    const castName = activeCast ? (castById(activeCast)?.name ?? '') : '활성 캐릭터';
    hub.notice(
      (found.length ? `${found.length}개를 배치 예약에 담았습니다 (${castName} × 1장씩). ` : '')
      + (lost.length ? `프리셋에 같은 이름의 씬이 없는 것: ${lost.join(', ')}` : ''),
      found.length ? 'ok' : 'err');
  } finally { btn.disabled = false; }
}

function exportButton(node: Folder): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text: '내보내기' }) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      // No character prefix: the filenames in the folder already carry the
      // cast/card name, and the export's canonical names key on the group.
      const p = prefsFor(node.path);
      const r = await state.studio.exportSelected(node.path, '', p.pattern, p.groupBy);
      hub.notice(`${r.folder} — 채택 ${r.used}, 수정 ${r.inpaint}, 빈 슬롯 ${r.empty}`, 'ok');
      hub.touchQuiet();
      await hub.refresh();
    } catch (e) {
      hub.notice('내보내지 못했습니다: ' + msg(e), 'err');
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
    if (!picked.length) { hub.notice('채택한 이미지가 없습니다.', 'err'); return; }
    b.disabled = true;
    try {
      const paths = picked.map((f) => `${S.selected}/${f}`);
      const r = await state.studio.stage(state.activeCharKey, paths);
      hub.notice(`${r.staged.length}장을 확인했습니다. `
        + '히나에게 "채택한 이미지들을 감정 이미지로 넣어 줘" 라고 하면 승인 후 카드에 붙습니다.'
        + (r.failed.length ? ` (${r.failed.length}장 확인 실패)` : ''), 'ok');
    } catch (e) {
      hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
    } finally { b.disabled = !state.activeCharKey; }
  });
  return b;
}

// Thumbnails, a few at a time, from the backend's copy - the same shape and
// the same reason as the files tab: POST so an intermediate cache cannot
// answer every key with one body (docs/06 §1-7).
const thumbs = new Map<string, string>();
const THUMB_PARALLEL = 6;
let thumbActive = 0;
const thumbQueue: (() => void)[] = [];

export async function loadThumb(f: WorkspaceFile, mount: HTMLElement): Promise<void> {
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
