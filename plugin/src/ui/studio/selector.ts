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
import { el, segCtl, colPicker, clear, popover } from '../dom';
import { blobUrl } from '../blobimg';
import { state, type GroupItem, type SelectionMap, type SelectionState,
         type StudioGroups, type WorkspaceFile } from '../../state';
import { S, hub, gen, msg, adjustReserve, type Folder, persistSelCols } from './store';
import { scenesOf } from './center-batch';

let groups: StudioGroups | null = null;
let selection: SelectionMap = {};
let drill = '';
let viewMode: 'all' | 'group' | 'rep' = 'group';
/** Per-cell/per-group refreshers: a flag click patches in place - the old
 * full drawCentre re-fetched every thumbnail (the dominant review lag). */
const cellSyncs = new Map<string, () => void>();
let missingSync: (() => void) | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let patternTimer: ReturnType<typeof setTimeout> | null = null;

// --- the grouping rule, remembered PER FOLDER (4.14) -------------------------------

interface GroupPrefs {
  /** 'default' = the stamp-anchored built-in rule; 'delim' = delimiter +
   * picked tokens; 'regex' = a raw named-group pattern (고급). */
  mode: 'default' | 'delim' | 'regex';
  delimiter: string;
  /** The picked token positions, 1-based - MULTI-select (§1-30): 1-2-3.webp
   * can group by 1, by 2, or by 1+2 joined. */
  tokens: number[];
  /** Legacy single-token saves (pre §1-30); folded into `tokens` on read. */
  tokenIndex?: number;
  pattern: string;
  groupBy: string;
}
const DEF: GroupPrefs = { mode: 'default', delimiter: '-', tokens: [2], pattern: '', groupBy: 'emotion' };
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
  const tokens = p.tokens && p.tokens.length ? p.tokens
    : (p.tokenIndex ? [p.tokenIndex] : DEF.tokens);
  return { ...DEF, ...p, mode, tokens };
}

function setPrefs(folder: string, next: Partial<GroupPrefs>): void {
  prefs[folder] = { ...prefsFor(folder), ...next };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* fine */ }
}

/** The delimiter rule as the backend's named-group regex: every SELECTED
 * position is a capture (stopping at '.', so extensions and the `.2` dedup
 * suffixes never leak in), the rest are skipped. The backend joins t1+t2
 * composites into one key. */
function delimPattern(d: string, tokens: number[]): string {
  const e = d === ' ' ? ' ' : '\\' + d;
  const tok = `[^${e}.]`;
  const max = Math.max(...tokens);
  const set = new Set(tokens);
  const parts: string[] = [];
  for (let i = 1; i <= max; i++) parts.push(set.has(i) ? `(?P<t${i}>${tok}+)` : `[^${e}]*`);
  return '^' + parts.join(e);
}

function effective(p: GroupPrefs): { pattern: string; groupBy: string } {
  if (p.mode === 'delim') {
    const tokens = [...p.tokens].sort((a, b) => a - b);
    return { pattern: delimPattern(p.delimiter, tokens), groupBy: tokens.map((i) => 't' + i).join('+') };
  }
  if (p.mode === 'regex' && p.pattern.trim()) return { pattern: p.pattern.trim(), groupBy: p.groupBy || 'g' };
  return { pattern: '', groupBy: p.groupBy || 'emotion' };
}

function ruleSummary(p: GroupPrefs): string {
  if (p.mode === 'regex' && p.pattern.trim()) return '규칙: 정규식';
  if (p.mode === 'delim') {
    const d = p.delimiter === ' ' ? '공백' : p.delimiter;
    return `규칙: ${d} · ${[...p.tokens].sort((a, b) => a - b).join('+')}번째`;
  }
  return '규칙: 자동';
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
function queueSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void state.studio.saveSelection(S.selected, selection).catch(() => { /* retried on the next click */ });
  }, 500);
}

function flag(filename: string, key: keyof SelectionState): void {
  const cur = selection[filename] || { use: false, inpaint: false, delete: false };
  selection[filename] = { ...cur, [key]: !cur[key] };
  cellSyncs.get(filename)?.();
  missingSync?.();
  queueSave();
}

/** 대표 is exclusive per group; turning it on also 채택s the image (the
 * export writes chosen files only, and the rep takes the canonical name). */
function flagRep(filename: string, groupItems: GroupItem[]): void {
  const cur = !!selection[filename]?.rep;
  for (const gi of groupItems) {
    const s = selection[gi.filename] || { use: false, inpaint: false, delete: false };
    const want = gi.filename === filename ? !cur : false;
    if (!!s.rep !== want) {
      selection[gi.filename] = { ...s, rep: want, ...(want ? { use: true } : {}) };
      cellSyncs.get(gi.filename)?.();
    }
  }
  missingSync?.();
  queueSave();
}

/** Bulk actions: apply, then refresh every registered cell/card in place. */
function syncAllCells(): void {
  for (const s of cellSyncs.values()) s();
  missingSync?.();
}

export function drawSelector(node: Folder): void {
  if (!S.viewMount || !groups) return;
  const viewMount = S.viewMount;
  const g = groups;
  const p = prefsFor(node.path);
  cellSyncs.clear();
  missingSync = null;

  // --- top bar: back · title · 전체/그룹별 · columns · bulk · export -------------
  const bar = el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } });
  const tidy = el('button', { class: 'ghost tiny', text: '정리', title: '폴더 정리 화면 (선택·이동·삭제·업로드)' });
  tidy.addEventListener('click', () => { S.centreMode = 'folder'; hub.drawCentre(); });
  bar.append(
    tidy,
    el('span', { class: 'sectiontitle grow', text: `${node.path} · ${g.total}장 · 그룹 ${g.groups.length}` }),
  );
  const mkView = (v: 'all' | 'group' | 'rep', label: string) => ({
    label, on: viewMode === v, pick: () => { viewMode = v; drill = ''; hub.drawCentre(); },
  });
  bar.append(segCtl([mkView('group', '그룹별'), mkView('all', '전체'), mkView('rep', '대표')]));
  bar.appendChild(colPicker({ values: [2, 3, 4, 5, 6], get: () => S.selCols, set: (n) => {
    S.selCols = n; persistSelCols();
    for (const gEl of Array.from(document.querySelectorAll<HTMLElement>('.selgrid'))) {
      gEl.style.gridTemplateColumns = `repeat(${S.selCols}, minmax(0, 1fr))`;
    }
  } }));
  const firstEach = el('button', { class: 'ghost tiny', text: '그룹마다 첫 장' });
  firstEach.addEventListener('click', () => {
    for (const grp of g.groups) {
      const f = grp.items[0];
      if (f) selection[f.filename] = { ...selection[f.filename], use: true };
    }
    syncAllCells();
    void state.studio.saveSelection(S.selected, selection);
  });
  const none = el('button', { class: 'ghost tiny', text: '선택 해제' });
  none.addEventListener('click', () => {
    for (const k of Object.keys(selection)) selection[k] = { ...selection[k], use: false, rep: false };
    syncAllCells();
    void state.studio.saveSelection(S.selected, selection);
  });
  // 봇에 반영 belongs to the selected/ folder an export made - the folder
  // one adopts FROM - not to the pool of candidates (user).
  bar.append(firstEach, none, exportButton(node));
  if (/\/selected$/.test(node.path)) bar.appendChild(adoptButton());
  viewMount.appendChild(bar);

  // --- the grouping rule: ONE compact control (§1-30) -------------------------------
  // The editor folds behind a small summary button - the old full-width row of
  // labels + chips ate two lines above every grid. Tokens are MULTI-select.
  const ruleBtn = el('button', { class: 'ghost tiny rulebtn', text: ruleSummary(p),
    title: '구분자와 그룹 기준을 고칩니다 (토큰은 복수 선택 가능)' });
  ruleBtn.addEventListener('click', () => openRulePopover(ruleBtn, node));
  bar.appendChild(ruleBtn);
  if (g.unmatched.length) {
    bar.appendChild(el('span', { class: 'badge warn', text: `못 읽음 ${g.unmatched.length}`,
      title: '이름 규칙이 못 읽은 파일 — 아래 별도 목록에 있습니다' }));
  }

  // 부족분: groups where nothing is chosen and nothing is being fixed - the
  // slots the export would leave a placeholder for. One button turns them
  // into reservations, closing the cycle: 분류 → 부족분 → 다음 배치.
  const missingBox = el('div', {});
  viewMount.appendChild(missingBox);
  const renderMissing = (): void => {
    clear(missingBox);
    const missing = g.groups
      .filter((grp) => !grp.items.some((i) => selection[i.filename]?.use || selection[i.filename]?.inpaint))
      .map((grp) => grp.key);
    if (!missing.length) return;
    const fill = el('button', { class: 'ghost tiny', text: '부족분 예약에 담기',
      title: '씬 프리셋에서 같은 이름의 씬을 찾아 1장씩 배치 예약에 넣습니다' }) as HTMLButtonElement;
    fill.addEventListener('click', () => void reserveMissing(missing, fill));
    missingBox.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'badge warn', text: `부족분 ${missing.length}개` }),
      el('span', { class: 'hint grow', text: missing.join(', ') }),
      fill,
    ]));
  };
  renderMissing();
  missingSync = renderMissing;

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
    viewMount.appendChild(candidateGrid(grp?.items ?? [], grp?.items));
  } else if (viewMode === 'group') {
    const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: `repeat(${S.selCols}, minmax(0, 1fr))` } });
    for (const grp of g.groups) grid.appendChild(groupCard(grp));
    viewMount.appendChild(grid);
    if (!g.groups.length) viewMount.appendChild(el('div', { class: 'empty', text: '규칙이 읽어낸 그룹이 없습니다 — 구분자와 그룹 기준을 확인하세요.' }));
  } else if (viewMode === 'rep') {
    // 대표 모아보기: the chosen representative per group side by side - the
    // "씬별 대표 이미지" answer sheet. Click through to the group's candidates.
    const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: `repeat(${S.selCols}, minmax(0, 1fr))` } });
    for (const grp of g.groups) {
      const chosen = grp.items.find((i) => selection[i.filename]?.rep)
        ?? grp.items.find((i) => selection[i.filename]?.use);
      const pic = el('div', { class: 'assetpic' });
      const cellR = el('div', { class: 'fcell groupcard' + (chosen ? ' picked' : ''),
                                title: `${grp.key} — 눌러서 후보를 펼칩니다` }, [
        pic,
        el('div', { class: 'fname row' }, [
          el('span', { class: 'grow', text: grp.key }),
          chosen ? null : el('span', { class: 'badge warn', text: '대표 없음' }),
        ]),
      ]);
      if (chosen) void loadThumb({ path: chosen.path, name: chosen.filename, size: 0, modified: 0, textual: false }, pic);
      else pic.appendChild(el('div', { class: 'assettype', text: '—' }));
      cellR.addEventListener('click', () => { drill = grp.key; hub.drawCentre(); });
      grid.appendChild(cellR);
    }
    viewMount.appendChild(grid);
    if (!g.groups.length) viewMount.appendChild(el('div', { class: 'empty', text: '규칙이 읽어낸 그룹이 없습니다.' }));
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
  // The face prefers the flagged 대표, then any chosen image, then the first.
  const face = grp.items.find((i) => selection[i.filename]?.rep)
    ?? grp.items.find((i) => selection[i.filename]?.use)
    ?? grp.items[0];
  const pic = el('div', { class: 'assetpic' });
  if (face) void loadThumb({ path: face.path, name: face.filename, size: 0, modified: 0, textual: false }, pic);
  const chosenBadge = el('span', { class: 'badge' });
  const fixBadge = el('span', { class: 'badge' });
  const cell = el('div', { class: 'fcell groupcard', title: `${grp.key} — 눌러서 후보를 펼칩니다` }, [
    pic,
    el('div', { class: 'fname row' }, [
      el('span', { class: 'grow', text: grp.key }),
      el('span', { class: 'badge', text: `${grp.items.length}장` }),
      chosenBadge, fixBadge,
    ]),
  ]);
  const sync = (): void => {
    const chosen = grp.items.filter((i) => selection[i.filename]?.use).length;
    const fixing = grp.items.filter((i) => selection[i.filename]?.inpaint).length;
    cell.classList.toggle('picked', chosen > 0);
    chosenBadge.className = 'badge' + (chosen ? ' ok' : ' warn');
    chosenBadge.textContent = chosen ? `선택 ${chosen}` : '미선택';
    fixBadge.style.display = fixing ? '' : 'none';
    fixBadge.textContent = fixing ? `수정 ${fixing}` : '';
  };
  sync();
  cellSyncs.set('grp:' + grp.key, sync);
  cell.addEventListener('click', () => { drill = grp.key; hub.drawCentre(); });
  return cell;
}

function candidateGrid(items: GroupItem[], groupItems?: GroupItem[]): HTMLElement {
  const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: `repeat(${S.selCols}, minmax(0, 1fr))` } });
  for (const it of items) grid.appendChild(candidate(it, groupItems));
  return grid;
}

function candidate(it: GroupItem, groupItems?: GroupItem[]): HTMLElement {
  const pic = el('div', { class: 'assetpic' });
  const btns = new Map<string, HTMLElement>();
  const flags = el('div', { class: 'row selflags' });
  const mk = (key: keyof SelectionState, label: string, title: string) => {
    const b = el('button', { class: 'ghost tiny', text: label, title });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); flag(it.filename, key); });
    btns.set(key, b);
    return b;
  };
  flags.append(
    mk('use', '채택', '이걸 봇에 넣습니다'),
    mk('inpaint', '수정', '먼저 고쳐야 합니다'),
    mk('delete', '버림', '지울 후보입니다'),
  );
  if (groupItems) {
    // Only where the group is known (drill view): 대표 is a per-group choice.
    const b = el('button', { class: 'ghost tiny', text: '대표',
      title: '그룹의 대표로 (그룹당 1장 · 내보낼 때 정식 이름을 가져갑니다)' });
    b.addEventListener('click', (ev) => { ev.stopPropagation(); flagRep(it.filename, groupItems); });
    btns.set('rep', b);
    flags.appendChild(b);
  }
  const cell2 = el('div', { class: 'fcell selcell', title: it.filename }, [
    pic, el('div', { class: 'fname', text: it.filename }), flags,
  ]);
  const sync = (): void => {
    const s = selection[it.filename] || { use: false, inpaint: false, delete: false };
    cell2.classList.toggle('picked', !!s.use);
    cell2.classList.toggle('fixing', !!s.inpaint);
    cell2.classList.toggle('dropping', !!s.delete);
    btns.get('use')?.classList.toggle('on', !!s.use);
    btns.get('inpaint')?.classList.toggle('on', !!s.inpaint);
    btns.get('delete')?.classList.toggle('on', !!s.delete);
    btns.get('rep')?.classList.toggle('on', !!s.rep);
  };
  sync();
  cellSyncs.set(it.filename, sync);
  // The picture itself toggles 채택: that is the click being made ninety times.
  pic.addEventListener('click', () => flag(it.filename, 'use'));
  void loadThumb({ path: it.path, name: it.filename, size: 0, modified: 0, textual: false }, pic);
  return cell2;
}

/** The rule editor: delimiter, multi-select token chips, 자동, and the raw
 * regex behind 고급 - in a popover, not a full-width row (§1-30). A chip
 * toggle applies after a short debounce; the popover survives the redraw. */
function openRulePopover(anchor: HTMLElement, node: Folder): void {
  const p = prefsFor(node.path);
  const g = groups;
  const sample = g?.groups[0]?.items[0]?.filename ?? g?.unmatched[0]?.filename ?? '';
  const stem = sample.replace(/\.[a-z0-9]+$/i, '');
  let stagedDelim = p.delimiter;
  const staged = new Set<number>(p.mode === 'delim' ? p.tokens : []);
  let applyTimer: ReturnType<typeof setTimeout> | null = null;
  const applyDelim = (): void => {
    if (!staged.size) return;
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      setPrefs(node.path, { mode: 'delim', delimiter: stagedDelim, tokens: [...staged].sort((a, b) => a - b) });
      drill = '';
      void loadGroups(node.path);
    }, 350);
  };

  const body = el('div', { class: 'rulepop' });
  const dsel = el('select', { title: '파일명을 나누는 문자' }) as HTMLSelectElement;
  for (const [v, label] of [['-', '-'], ['_', '_'], ['.', '.'], [' ', '공백']] as const) {
    const o = el('option', { value: v, text: label });
    if (stagedDelim === v) o.setAttribute('selected', 'selected');
    dsel.appendChild(o);
  }
  const chipsBox = el('div', { class: 'row', style: { gap: '2px', flexWrap: 'wrap' } });
  const renderChips = (): void => {
    clear(chipsBox);
    if (!stem) {
      chipsBox.appendChild(el('span', { class: 'hint', text: '샘플 파일이 없습니다' }));
      return;
    }
    const toks = stem.split(stagedDelim).filter((q) => q !== '');
    toks.slice(0, 6).forEach((tok, i) => {
      const chip = el('button', {
        class: 'ghost tiny tokenchip' + (staged.has(i + 1) ? ' on' : ''),
        text: `${i + 1}·${tok.length > 12 ? tok.slice(0, 12) + '…' : tok}`,
        title: `${i + 1}번째 조각을 그룹 기준에 넣거나 뺍니다 (예: ${tok})`,
      });
      chip.addEventListener('click', () => {
        // Multi-select: toggle membership; the last one cannot leave.
        if (staged.has(i + 1)) {
          if (staged.size > 1) staged.delete(i + 1);
        } else {
          staged.add(i + 1);
        }
        chip.classList.toggle('on', staged.has(i + 1));
        applyDelim();
      });
      chipsBox.appendChild(chip);
    });
  };
  dsel.addEventListener('change', () => {
    stagedDelim = dsel.value;
    staged.clear(); // a new delimiter starts a new pick; nothing applies yet
    renderChips();
  });
  renderChips();
  const auto = el('button', { class: 'ghost tiny' + (p.mode === 'default' ? ' on' : ''), text: '자동',
    title: '기본 규칙 (캐릭터-감정-날짜-번호 형태를 자동으로 읽습니다)' });
  auto.addEventListener('click', () => {
    setPrefs(node.path, { mode: 'default' });
    drill = '';
    void loadGroups(node.path);
  });
  body.append(
    el('div', { class: 'row' }, [el('span', { class: 'hint', text: '구분자' }), dsel, auto]),
    el('div', { class: 'hint', style: { margin: '6px 0 2px' }, text: '그룹 기준 — 칩을 눌러 넣고 뺍니다 (복수 선택)' }),
    chipsBox,
  );
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
  const fields = [...new Set([g?.groupBy ?? '', ...(g?.fields ?? [])])].filter(Boolean);
  for (const f of fields) {
    const o = el('option', { value: f, text: f });
    if (f === g?.groupBy) o.setAttribute('selected', 'selected');
    by.appendChild(o);
  }
  by.addEventListener('change', () => {
    setPrefs(node.path, { groupBy: by.value });
    drill = '';
    void loadGroups(node.path);
  });
  body.appendChild(el('details', { class: 'advbox', ...(p.mode === 'regex' ? { open: true } : {}) }, [
    el('summary', { text: '고급 (정규식 규칙)' }),
    el('div', { class: 'row', style: { flexWrap: 'wrap' } }, [
      el('span', { class: 'hint', text: '정규식' }), pat,
      el('span', { class: 'hint', text: '필드' }), by,
    ]),
  ]));
  popover(anchor, body);
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
  const b = el('button', { class: 'primary tiny', text: '애셋 채택',
                           title: '채택한 이미지를 selected/ 폴더에 정리해 넣습니다 (그 폴더에서 봇에 반영)' }) as HTMLButtonElement;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      // No character prefix: the filenames in the folder already carry the
      // card name, and the export's canonical names key on the group.
      const eff = effective(prefsFor(node.path));
      const r = await state.studio.exportSelected(node.path, '', eff.pattern, eff.groupBy);
      hub.notice(`${r.folder} — 채택 ${r.used}, 수정 ${r.inpaint}, 빈 슬롯 ${r.empty} · selected 폴더를 열면 봇에 반영할 수 있습니다`, 'ok');
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
    const url = await blobUrl(f.path, '', { thumb: true });
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
