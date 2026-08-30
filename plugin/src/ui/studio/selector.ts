/**
 * The comparison selector, under images/.
 *
 * The model is the standalone image-selector tool, reimplemented in the
 * panel's idiom. Carried over unchanged because they are the design:
 *
 *   - three flags per file (use / inpaint / delete), not one radio. A
 *     candidate can be none of them, and "this one needs fixing first" is a
 *     different answer from "this one is the keeper".
 *   - the files the rule could NOT read are a group of their own. Names are
 *     not deterministic - that is why this screen exists - so hiding the
 *     unreadable ones would hide exactly the work.
 *   - two views: 전체 (one flat grid) and 그룹별 (one REPRESENTATIVE card per
 *     group with its count; click to unfold that group, ← to come back).
 *
 * The grouping RULE is visible, not a regex to decode: pick a delimiter and
 * CLICK the token that is the group key (the chips show the actual first
 * filename split apart). A raw named-group regex stays behind 고급.
 */
import { el, clear } from '../dom';
import { blobUrl } from '../blobimg';
import { state, type GroupItem, type SelectionMap, type SelectionState,
         type StudioGroups, type WorkspaceFile } from '../../state';
import { S, hub, gen, msg, adjustReserve, type Folder } from './store';
import { scenesOf } from './center-batch';

let groups: StudioGroups | null = null;
let selection: SelectionMap = {};
let columns = 3;
let drill = '';
let viewMode: 'all' | 'group' = 'group';
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let patternTimer: ReturnType<typeof setTimeout> | null = null;

// --- the grouping rule, remembered PER FOLDER (4.14) -------------------------------

interface GroupPrefs {
  /** 'default' = the stamp-anchored built-in rule; 'delim' = delimiter +
   * picked token; 'regex' = a raw named-group pattern (고급). */
  mode: 'default' | 'delim' | 'regex';
  delimiter: string;
  tokenIndex: number;
  pattern: string;
  groupBy: string;
}
const DEF: GroupPrefs = { mode: 'default', delimiter: '-', tokenIndex: 2, pattern: '', groupBy: 'emotion' };
const PREFS_KEY = 'hina.studioGroupBy';
let prefs: Record<string, Partial<GroupPrefs>> = {};
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') as Record<string, Partial<GroupPrefs>> | null;
  if (saved && typeof saved === 'object') prefs = saved;
} catch { /* storage may be unavailable in the iframe */ }

function prefsFor(folder: string): GroupPrefs {
  const p = prefs[folder] ?? {};
  // An older save carried only {pattern, groupBy}: a pattern meant regex mode.
  const mode = p.mode ?? (p.pattern ? 'regex' : 'default');
  return { ...DEF, ...p, mode };
}

function setPrefs(folder: string, next: Partial<GroupPrefs>): void {
  prefs[folder] = { ...prefsFor(folder), ...next };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ }
}

/** The delimiter rule as the backend's named-group regex: skip k-1 tokens,
 * capture the k-th (stopping at a '.', so extensions and the image-selector
 * style `.2` dedup suffixes never leak into a group key). */
function delimPattern(d: string, k: number): string {
  const e = d === ' ' ? ' ' : '\\' + d;
  const tok = `[^${e}.]`;
  return k <= 1 ? `^(?P<g>${tok}+)` : `^(?:[^${e}]*${e}){${k - 1}}(?P<g>${tok}+)`;
}

function effective(p: GroupPrefs): { pattern: string; groupBy: string } {
  if (p.mode === 'delim') return { pattern: delimPattern(p.delimiter, p.tokenIndex), groupBy: 'g' };
  if (p.mode === 'regex' && p.pattern.trim()) return { pattern: p.pattern.trim(), groupBy: p.groupBy || 'g' };
  return { pattern: '', groupBy: p.groupBy || 'emotion' };
}

/** Whether the loaded groups belong to this folder - drawCentre's gate. */
export function hasGroups(folder: string): boolean {
  return !!groups && groups.folder === folder;
}

export async function loadGroups(folder: string): Promise<void> {
  try {
    const eff = effective(prefsFor(folder));
    groups = await state.studio.group(folder, eff.pattern, eff.groupBy);
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
  const p = prefsFor(node.path);

  // --- top bar: back · title · 전체/그룹별 · columns · bulk · export -------------
  const bar = el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } });
  const back = el('button', { class: 'ghost tiny', text: '← 폴더', title: '폴더 보기로 돌아갑니다' });
  back.addEventListener('click', () => { S.centreMode = 'folder'; hub.drawCentre(); });
  bar.append(
    back,
    el('span', { class: 'sectiontitle grow', text: `${node.path} · ${g.total}장 · 그룹 ${g.groups.length}` }),
  );
  const mkView = (v: 'all' | 'group', label: string) => {
    const b = el('button', { class: 'ghost tiny' + (viewMode === v ? ' on' : ''), text: label });
    b.addEventListener('click', () => { viewMode = v; drill = ''; hub.drawCentre(); });
    return b;
  };
  bar.append(mkView('group', '그룹별'), mkView('all', '전체'));
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

  // --- the grouping rule, visible ---------------------------------------------------
  // A delimiter and the actual first filename split into clickable tokens:
  // the group key is the chip you press, not a regex you decode.
  const sample = g.groups[0]?.items[0]?.filename ?? g.unmatched[0]?.filename ?? '';
  const stem = sample.replace(/\.[a-z0-9]+$/i, '');
  const rule = el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } });
  rule.appendChild(el('span', { class: 'hint', text: '구분자' }));
  const dsel = el('select', { title: '파일명을 나누는 문자' }) as HTMLSelectElement;
  for (const [v, label] of [['-', '-'], ['_', '_'], ['.', '.'], [' ', '공백']] as const) {
    const o = el('option', { value: v, text: label });
    if (p.delimiter === v) o.setAttribute('selected', 'selected');
    dsel.appendChild(o);
  }
  dsel.addEventListener('change', () => {
    setPrefs(node.path, { delimiter: dsel.value, mode: 'delim' });
    drill = '';
    void loadGroups(node.path);
  });
  rule.appendChild(dsel);
  rule.appendChild(el('span', { class: 'hint', text: '그룹 기준' }));
  if (stem) {
    const tokens = stem.split(p.delimiter).filter((t) => t !== '');
    tokens.slice(0, 6).forEach((tok, i) => {
      const on = p.mode === 'delim' && p.tokenIndex === i + 1;
      const chip = el('button', {
        class: 'ghost tiny tokenchip' + (on ? ' on' : ''),
        text: `${i + 1}·${tok.length > 12 ? tok.slice(0, 12) + '…' : tok}`,
        title: `${i + 1}번째 조각을 그룹 기준으로 (예: ${tok})`,
      });
      chip.addEventListener('click', () => {
        setPrefs(node.path, { mode: 'delim', tokenIndex: i + 1 });
        drill = '';
        void loadGroups(node.path);
      });
      rule.appendChild(chip);
    });
  }
  const auto = el('button', { class: 'ghost tiny' + (p.mode === 'default' ? ' on' : ''), text: '자동',
                              title: '기본 규칙 (캐릭터-감정-날짜-번호 형태를 자동으로 읽습니다)' });
  auto.addEventListener('click', () => {
    setPrefs(node.path, { mode: 'default' });
    drill = '';
    void loadGroups(node.path);
  });
  rule.appendChild(auto);
  rule.appendChild(el('span', { class: 'hint', text: `읽음 ${g.total - g.unmatched.length} / 못 읽음 ${g.unmatched.length}` }));
  viewMount.appendChild(rule);

  // 고급: the raw named-group regex, folded away.
  const adv = el('details', { class: 'advbox', ...(p.mode === 'regex' ? { open: true } : {}) }, [
    el('summary', { text: '고급 (정규식 규칙)' }),
  ]);
  const pat = el('input', {
    value: p.mode === 'regex' ? p.pattern : '', placeholder: '(?P<costume>[^-]+)-(?P<emotion>[^-]+)',
    title: '명명 캡처그룹 정규식 — 그룹 이름이 그룹 기준 후보가 됩니다',
  }) as HTMLInputElement;
  pat.addEventListener('input', () => {
    if (patternTimer) clearTimeout(patternTimer);
    patternTimer = setTimeout(() => {
      setPrefs(node.path, { mode: pat.value.trim() ? 'regex' : 'default', pattern: pat.value });
      drill = '';
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
    setPrefs(node.path, { groupBy: by.value });
    drill = '';
    void loadGroups(node.path);
  });
  adv.appendChild(el('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
    el('span', { class: 'hint', text: '정규식' }), pat,
    el('span', { class: 'hint', text: '필드' }), by,
  ]));
  viewMount.appendChild(adv);

  // 부족분: groups where nothing is chosen and nothing is being fixed - the
  // slots the export would leave a placeholder for. One button turns them
  // into reservations, closing the cycle: 분류 → 부족분 → 다음 배치.
  const missing = g.groups
    .filter((grp) => !grp.items.some((i) => selection[i.filename]?.use || selection[i.filename]?.inpaint))
    .map((grp) => grp.key);
  if (missing.length) {
    const fill = el('button', { class: 'ghost tiny', text: '부족분 예약에 담기',
      title: '씬 프리셋에서 같은 이름의 씬을 찾아 1장씩 배치 예약에 넣습니다' }) as HTMLButtonElement;
    fill.addEventListener('click', () => void reserveMissing(missing, fill));
    viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'badge warn', text: `부족분 ${missing.length}개` }),
      el('span', { class: 'hint grow', text: missing.join(', ') }),
      fill,
    ]));
  }

  // --- the body: a drilled group, the group cards, or the flat grid ------------------
  if (drill) {
    const grp = g.groups.find((x) => x.key === drill);
    const at = g.groups.findIndex((x) => x.key === drill);
    const nav = el('div', { class: 'row', style: { marginBottom: '8px' } });
    const go = (to: number) => { drill = g.groups[to]?.key ?? drill; hub.drawCentre(); };
    const prev = el('button', { class: 'ghost tiny', text: '← 이전' }) as HTMLButtonElement;
    const up = el('button', { class: 'ghost tiny', text: '← 그룹', title: '그룹 카드로 돌아갑니다' });
    const next = el('button', { class: 'ghost tiny', text: '다음 →' }) as HTMLButtonElement;
    prev.disabled = at <= 0;
    next.disabled = at < 0 || at >= g.groups.length - 1;
    prev.addEventListener('click', () => go(at - 1));
    next.addEventListener('click', () => go(at + 1));
    up.addEventListener('click', () => { drill = ''; viewMode = 'group'; hub.drawCentre(); });
    nav.append(up, prev, next, el('span', { class: 'sectiontitle', text: `${drill} · ${grp?.items.length ?? 0}장` }));
    viewMount.appendChild(nav);
    viewMount.appendChild(candidateGrid(grp?.items ?? []));
  } else if (viewMode === 'group') {
    const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } });
    for (const grp of g.groups) grid.appendChild(groupCard(grp));
    viewMount.appendChild(grid);
    if (!g.groups.length) viewMount.appendChild(el('div', { class: 'empty', text: '규칙이 읽어낸 그룹이 없습니다 — 구분자와 그룹 기준을 확인하세요.' }));
  } else {
    viewMount.appendChild(candidateGrid([...g.groups.flatMap((x) => x.items)]));
  }

  if (g.unmatched.length && !drill) {
    viewMount.appendChild(el('div', { class: 'sectionline' }));
    viewMount.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } }, [
      el('span', { class: 'sectiontitle grow', text: `이름 규칙에 안 맞는 파일 ${g.unmatched.length}개` }),
    ]));
    viewMount.appendChild(el('div', { class: 'hint', text:
      '이 파일들은 그룹에 못 들어갑니다. 히나에게 “이 폴더 이름 규칙에 맞게 일괄로 바꿔 줘” 라고 하세요 (studio_rename).' }));
    viewMount.appendChild(candidateGrid(g.unmatched));
  }
}

/** 그룹별: one representative card per group - the first image, the count,
 * and where the choice stands. Click to unfold the group (15). */
function groupCard(grp: { key: string; items: GroupItem[] }): HTMLElement {
  const rep = grp.items[0];
  const chosen = grp.items.filter((i) => selection[i.filename]?.use).length;
  const fixing = grp.items.filter((i) => selection[i.filename]?.inpaint).length;
  const pic = el('div', { class: 'assetpic' });
  if (rep) void loadThumb({ path: rep.path, name: rep.filename, size: 0, modified: 0, textual: false }, pic);
  const cell = el('div', { class: 'fcell groupcard' + (chosen ? ' picked' : ''), title: `${grp.key} — 눌러서 후보를 펼칩니다` }, [
    pic,
    el('div', { class: 'fname row' }, [
      el('span', { class: 'grow', text: grp.key }),
      el('span', { class: 'badge', text: `${grp.items.length}장` }),
      el('span', { class: 'badge' + (chosen ? ' ok' : ' warn'), text: chosen ? `선택 ${chosen}` : '미선택' }),
      fixing ? el('span', { class: 'badge', text: `수정 ${fixing}` }) : null,
    ]),
  ]);
  cell.addEventListener('click', () => { drill = grp.key; hub.drawCentre(); });
  return cell;
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
 * preset, one each. Names with no scene are reported. */
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
    for (const k of found) adjustReserve(gen.scenePreset, k, +1);
    hub.notice(
      (found.length ? `${found.length}개를 배치 예약에 담았습니다 (1장씩). ` : '')
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
      // card name, and the export's canonical names key on the group.
      const eff = effective(prefsFor(node.path));
      const r = await state.studio.exportSelected(node.path, '', eff.pattern, eff.groupBy);
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

// Thumbnails ride the ONE blob pipeline (blobimg) - the selector used to
// keep its own object-URL cache with the same eviction bug (revoking URLs
// still in the DOM), which read as "images flicker back to empty boxes".
export async function loadThumb(f: WorkspaceFile, mount: HTMLElement): Promise<void> {
  try {
    const url = await blobUrl(f.path);
    if (!mount.isConnected) return;
    clear(mount);
    const img = el('img', { class: 'assetimg', src: url, alt: '' });
    img.addEventListener('error', () => {
      clear(mount);
      mount.appendChild(el('div', { class: 'assettype', text: '?' }));
    });
    mount.appendChild(img);
  } catch {
    if (mount.isConnected) mount.appendChild(el('div', { class: 'assettype', text: '?' }));
  }
}
