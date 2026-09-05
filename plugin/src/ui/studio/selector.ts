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

/** What the rule is, and what it produced - the count is the feedback the
 * old label lacked ("규칙: 자동" said nothing about 37 groups for 39 files). */
function ruleSummary(p: GroupPrefs, g: StudioGroups | null): string {
  let rule = '자동';
  if (p.mode === 'regex' && p.pattern.trim()) rule = '정규식';
  else if (p.mode === 'delim') {
    const d = p.delimiter === ' ' ? '공백' : p.delimiter;
    rule = `${d} · ${[...p.tokens].sort((a, b) => a - b).join('+')}번째`;
  } else if (p.groupBy && p.groupBy !== 'emotion') {
    rule = `자동 · ${FIELD_LABEL[p.groupBy] ?? p.groupBy}`;
  }
  return g ? `규칙: ${rule} → 그룹 ${g.groups.length}` : `규칙: ${rule}`;
}

const FIELD_LABEL: Record<string, string> = {
  emotion: '감정', character: '캐릭터', 'character+emotion': '캐릭터+감정',
};

/** The grid's columns: a fixed count, or 자동 = as many ~190px cells as fit
 * (§1-33: three 450px-tall cards per row was the default on a laptop). */
function gridCols(): string {
  return S.selCols > 0
    ? `repeat(${S.selCols}, minmax(0, 1fr))`
    : 'repeat(auto-fill, minmax(190px, 1fr))';
}

/** The filesRev the groups were read at: a batch that lands, an upload, a
 * rename - any file change - re-reads them (§1-39: the screen used to keep
 * the old folder until the tab was left and re-entered). */
let groupsRev = -1;

/** Whether the loaded groups belong to this folder AND are current -
 * drawCentre's gate. */
export function hasGroups(folder: string): boolean {
  return !!groups && groups.folder === folder && groupsRev === state.filesRev;
}

export async function loadGroups(folder: string): Promise<void> {
  try {
    const eff = effective(prefsFor(folder));
    groupsRev = state.filesRev;
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
  const next: SelectionState = { ...cur, [key]: !cur[key] };
  // 채택 and 버림 are answers to the same question (§1-39): turning one on
  // turns the other off. 수정 ("fix first") stays independent.
  if (key === 'use' && next.use) next.delete = false;
  if (key === 'delete' && next.delete) { next.use = false; next.rep = false; }
  selection[filename] = next;
  cellSyncs.get(filename)?.();
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

  // --- top: TWO rows (§1-33). The one row of eleven controls overflowed a
  // laptop and read as a wall. Row 1 = where you are + the rule; row 2 =
  // how to look + what to do.
  const head = el('div', { class: 'row selhead', style: { marginBottom: '6px' } });
  const tidy = el('button', { class: 'ghost tiny', text: '정리', title: '폴더 정리 화면 (선택·이동·삭제·업로드)' });
  tidy.addEventListener('click', () => { S.centreMode = 'folder'; hub.drawCentre(); });
  head.append(
    tidy,
    el('span', { class: 'sectiontitle path grow', title: node.path,
                 text: `${node.path} · ${g.total}장` }),
  );
  viewMount.appendChild(head);
  const bar = el('div', { class: 'row seltools', style: { marginBottom: '8px' } });
  const mkView = (v: 'all' | 'group' | 'rep', label: string) => ({
    label, on: viewMode === v, pick: () => { viewMode = v; drill = ''; hub.drawCentre(); },
  });
  // 대표 (the per-group representative) is gone from the screen (§1-39: "왜?"
  // - one more flag nobody asked for); the export still takes the first
  // 채택 as the canonical name. Old selection files keep their rep bits.
  bar.append(segCtl([mkView('group', '그룹별'), mkView('all', '전체')]));
  bar.appendChild(colPicker({ values: [0, 2, 3, 4, 5, 6], labels: { 0: '자동' }, get: () => S.selCols, set: (n) => {
    S.selCols = n; persistSelCols();
    for (const gEl of Array.from(document.querySelectorAll<HTMLElement>('.selgrid'))) {
      gEl.style.gridTemplateColumns = gridCols();
    }
  } }));
  bar.appendChild(el('span', { class: 'spacer' }));
  const none = el('button', { class: 'ghost tiny', text: '선택 해제' });
  none.addEventListener('click', () => {
    for (const k of Object.keys(selection)) selection[k] = { ...selection[k], use: false, rep: false };
    syncAllCells();
    void state.studio.saveSelection(S.selected, selection);
  });
  // 봇에 반영 belongs to the selected/ folder an export made - the folder
  // one adopts FROM - not to the pool of candidates (user).
  bar.append(none, exportButton(node));
  if (/\/selected$/.test(node.path)) bar.appendChild(adoptButton());
  viewMount.appendChild(bar);

  // --- the grouping rule: ONE compact control (§1-30), on the head row ----------
  // The editor folds behind a summary button that also says what the rule
  // produced. Tokens are MULTI-select.
  const ruleBtn = el('button', { class: 'ghost tiny rulebtn', text: ruleSummary(p, g),
    title: '파일 이름을 어떻게 나눠 그룹을 만들지 고칩니다 (토큰은 복수 선택 가능)' });
  ruleBtn.addEventListener('click', () => openRulePopover(ruleBtn, node));
  head.appendChild(ruleBtn);
  if (g.unmatched.length) {
    const badge = el('button', { class: 'ghost tiny badge warn', text: `못 읽음 ${g.unmatched.length}`,
      title: '이름 규칙이 못 읽은 파일 — 아래 별도 목록에 있습니다. 누르면 규칙 편집이 열립니다' });
    badge.addEventListener('click', () => openRulePopover(ruleBtn, node));
    head.appendChild(badge);
  }

  // 부족분: a group that exists but has NO 채택 yet (§1-39, user: not a
  // comparison against the preset - a group with candidates and no pick).
  // The button reserves a re-run for the ones the current preset can name.
  const missingBox = el('div', {});
  viewMount.appendChild(missingBox);
  const renderMissing = (): void => {
    clear(missingBox);
    const missing = g.groups
      .filter((grp) => !grp.items.some((i) => selection[i.filename]?.use))
      .map((grp) => grp.key);
    if (!missing.length) return;
    const fill = el('button', { class: 'ghost tiny', text: '부족분 다시 생성 예약',
      title: '채택이 없는 그룹을 배치 예약에 1장씩 넣습니다 (현재 씬 프리셋에 같은 이름의 씬이 있는 것만)' }) as HTMLButtonElement;
    fill.addEventListener('click', () => void reserveMissing(missing, fill));
    missingBox.appendChild(el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('span', { class: 'badge warn', text: `채택 없는 그룹 ${missing.length}개`, title: '후보는 있는데 아직 채택한 장이 없는 그룹' }),
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
    const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: gridCols() } });
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
    const fix = el('button', { class: 'ghost tiny', text: '규칙 바꾸기',
      title: '구분자 규칙으로 바꾸면 대개 읽힙니다' });
    fix.addEventListener('click', () => {
      const anchor = viewMount.querySelector<HTMLElement>('.rulebtn');
      if (anchor) openRulePopover(anchor, node);
    });
    viewMount.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'hint grow', text:
        '이 파일들은 지금 규칙으로는 그룹에 못 들어갑니다. 규칙을 바꾸거나, 히나에게 “이 폴더 이름 규칙에 맞게 일괄로 바꿔 줘” 라고 하세요.' }),
      fix,
    ]));
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
  const grid = el('div', { class: 'agrid selgrid', style: { gridTemplateColumns: gridCols() } });
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
  // (the 대표 button is retired, §1-39; groupItems is kept for callers)
  void groupItems;
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
  // Every file is a sample (‹ › cycles): the rule used to be shown on the
  // first file only, which is exactly the one the user was not asking about.
  const names = g ? [...g.groups.flatMap((x) => x.items.map((i) => i.filename)), ...g.unmatched.map((u) => u.filename)] : [];
  let sampleAt = 0;
  const stemOf = (n: string): string => n.replace(/\.[a-z0-9]+$/i, '');
  let stagedDelim = p.delimiter;
  const staged = new Set<number>(p.mode === 'delim' ? p.tokens : []);
  let mode: GroupPrefs['mode'] = p.mode;
  let applyTimer: ReturnType<typeof setTimeout> | null = null;

  const body = el('div', { class: 'rulepop' });
  // What the rule produced, refreshed after every change: the feedback loop
  // the old popover lacked (a chip toggled, and nothing said what happened).
  const result = el('div', { class: 'ruleresult' });
  const syncResult = (): void => {
    const gg = groups;
    if (!gg) { result.textContent = '읽는 중…'; return; }
    clear(result);
    result.append(
      el('span', { class: 'badge ok', text: `그룹 ${gg.groups.length}` }),
      el('span', { class: 'badge' + (gg.unmatched.length ? ' warn' : ''), text: `못 읽음 ${gg.unmatched.length}` }),
      el('span', { class: 'hint', text: `${gg.total}장` }),
    );
    if (gg.groups.length === gg.total && gg.total > 1) {
      result.appendChild(el('span', { class: 'hint', text: '— 장마다 그룹 하나: 기준이 너무 잘게 나뉩니다' }));
    }
  };
  const reload = (): void => {
    drill = '';
    void loadGroups(node.path).then(() => { syncResult(); syncModeRow(); });
  };
  const applyDelim = (): void => {
    if (!staged.size) return;
    if (applyTimer) clearTimeout(applyTimer);
    applyTimer = setTimeout(() => {
      setPrefs(node.path, { mode: 'delim', delimiter: stagedDelim, tokens: [...staged].sort((a, b) => a - b) });
      mode = 'delim';
      reload();
    }, 350);
  };

  // --- row 1: the delimiter, and 자동 ---------------------------------------------
  const dsel = el('select', { title: '파일명을 나누는 문자' }) as HTMLSelectElement;
  for (const [v, label] of [['-', '- (하이픈)'], ['_', '_ (밑줄)'], ['.', '. (점)'], [' ', '공백']] as const) {
    const o = el('option', { value: v, text: label });
    if (stagedDelim === v) o.setAttribute('selected', 'selected');
    dsel.appendChild(o);
  }
  const auto = el('button', { class: 'ghost tiny', text: '자동',
    title: '기본 규칙: 캐릭터-감정-날짜-시각-번호 로 지은 이름(스튜디오 기본)을 읽습니다' });
  auto.addEventListener('click', () => {
    setPrefs(node.path, { mode: 'default' });
    mode = 'default';
    reload();
  });

  // --- row 2: the sample, split into toggle chips that READ as the filename --
  const nav = el('div', { class: 'row samplenav' });
  const prev = el('button', { class: 'ghost tiny', text: '‹', title: '이전 파일' }) as HTMLButtonElement;
  const next = el('button', { class: 'ghost tiny', text: '›', title: '다음 파일' }) as HTMLButtonElement;
  const which = el('span', { class: 'hint' });
  nav.append(el('span', { class: 'hint', text: '예시' }), prev, which, next);
  const chipsBox = el('div', { class: 'tokstrip' });
  const renderChips = (): void => {
    clear(chipsBox);
    const sample = names[sampleAt] ?? '';
    which.textContent = names.length ? `${sampleAt + 1}/${names.length}` : '없음';
    prev.disabled = sampleAt <= 0;
    next.disabled = sampleAt >= names.length - 1;
    if (!sample) {
      chipsBox.appendChild(el('span', { class: 'hint', text: '샘플 파일이 없습니다' }));
      return;
    }
    const toks = stemOf(sample).split(stagedDelim).filter((q) => q !== '');
    toks.slice(0, 8).forEach((tok, i) => {
      if (i) chipsBox.appendChild(el('span', { class: 'delimglyph', text: stagedDelim === ' ' ? '␣' : stagedDelim }));
      const chip = el('button', {
        class: 'tokenchip' + (staged.has(i + 1) ? ' on' : ''),
        title: `${i + 1}번째 조각을 그룹 기준에 넣거나 뺍니다`,
      }, [el('span', { class: 'idx', text: String(i + 1) }), el('span', { text: tok.length > 14 ? tok.slice(0, 14) + '…' : tok })]);
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
    if (toks.length > 8) chipsBox.appendChild(el('span', { class: 'hint', text: '…' }));
  };
  prev.addEventListener('click', () => { sampleAt = Math.max(0, sampleAt - 1); renderChips(); });
  next.addEventListener('click', () => { sampleAt = Math.min(names.length - 1, sampleAt + 1); renderChips(); });
  dsel.addEventListener('change', () => {
    stagedDelim = dsel.value;
    staged.clear(); // a new delimiter starts a new pick; nothing applies yet
    renderChips();
  });
  renderChips();

  // --- row 3: in 자동 mode, WHICH field groups (감정 · 캐릭터 · 둘 다) ----------
  const modeRow = el('div', { class: 'row', style: { marginTop: '6px' } });
  const syncModeRow = (): void => {
    clear(modeRow);
    auto.classList.toggle('on', mode === 'default');
    const cur = prefsFor(node.path);
    if (mode === 'default') {
      const by = cur.groupBy || 'emotion';
      const mk = (v: string, label: string) => ({
        label, on: by === v, pick: () => { setPrefs(node.path, { mode: 'default', groupBy: v }); reload(); },
      });
      modeRow.append(el('span', { class: 'hint', text: '묶는 기준' }),
        segCtl([mk('emotion', '감정'), mk('character', '캐릭터'), mk('character+emotion', '캐릭터+감정')]));
    } else if (mode === 'delim') {
      modeRow.appendChild(el('span', { class: 'hint',
        text: `켜진 조각(${[...staged].sort((a, b) => a - b).join('+') || '없음'})이 같은 파일끼리 한 그룹이 됩니다` }));
    } else {
      modeRow.appendChild(el('span', { class: 'hint', text: '정규식 규칙이 켜져 있습니다 (고급)' }));
    }
  };
  syncModeRow();
  syncResult();

  body.append(
    el('div', { class: 'row' }, [el('span', { class: 'hint', text: '나누기' }), dsel, auto]),
    nav,
    chipsBox,
    modeRow,
    result,
  );

  // --- 고급: the raw regex ---------------------------------------------------------
  const pat = el('input', {
    value: p.mode === 'regex' ? p.pattern : '', placeholder: '(?P<costume>[^-]+)-(?P<emotion>[^-]+)',
    title: '명명 캡처그룹 정규식 — 그룹 이름이 그룹 기준 후보가 됩니다',
  }) as HTMLInputElement;
  pat.addEventListener('input', () => {
    if (patternTimer) clearTimeout(patternTimer);
    patternTimer = setTimeout(() => {
      setPrefs(node.path, { mode: pat.value.trim() ? 'regex' : 'default', pattern: pat.value });
      mode = pat.value.trim() ? 'regex' : 'default';
      reload();
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
    reload();
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
    // Review wants a sharper picture than the file grids: ~720px (§1-39).
    const url = await blobUrl(f.path, '', { thumb: true, w: 720 });
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
