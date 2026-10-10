/**
 * The left 프롬프트 tab: which ONE style rides, edited in place.
 *
 * Top to bottom, in the order the work goes (§1-90, user: "저장되는 부분을
 * 한 곳에 모으고, 저장 안 되는 임시 프롬프트, 그 아래 캐릭터/조각"):
 *
 *   1. the style dropdown - one style is selected, the way an agent preset
 *      is: a compact current row, and 선택 · 이동 · 삭제 · 추가 behind the ›.
 *   2. what the style SAVES, in one block: its 긍정 / 부정 prompts (each
 *      folds, folded by default with a one-line preview), its 요청 설정, and
 *      the block's own 저장 / 되돌리기. Nothing here autosaves any more - an
 *      edit shows 미저장 until 저장; switching style or running with unsaved
 *      prompt edits asks first.
 *   3. what is NOT saved: the temporary prompt and temporary negative.
 *   4. the material buttons: 캐릭터 swaps this column to the character view,
 *      조각 opens the fragment organizer in the centre.
 *
 * A keystroke here must never rebuild the column under the caret: the save
 * bar patches in place, and the debounced unresolved check patches badges in
 * place (hub.syncBadges) instead of redrawing.
 */
import { el, modal } from '../dom';
import { askName, namePopover } from '../kit';
import { attachHilite } from '../hilite';
import { state, type StudioItem } from '../../state';
import { pickerRow, openListPicker, type PickerEntry } from '../pickers';
import { S, hub, activeOf, checkUnresolved, newCard, msg, fragKeys, temporaryPrompt, gen, persistGen, styleSync, cardStem } from './store';
import { openParamsDialog } from './gen';
import { parseStyleDoc, buildStyleDoc, type StyleDoc, genFromMeta, writeGenMeta, describeGen, genSnapshot,
         type GenSettings } from './stylefile';

/** Unsaved prompt edits, kept across a column rebuild (a toggle, a refresh,
 * a tab switch) until 저장 or 되돌리기. */
let pending: { path: string; positive: string; negative: string } | null = null;
/** The style as saved on disk - the base every edit is compared against. */
let loadedDoc: { path: string; doc: StyleDoc } | null = null;
/** The style-bound 요청 설정 as of the last load/save of that style. */
let genAtLoad: { path: string; snap: Record<string, unknown> } | null = null;

/** Live elements of the save bar, patched in place. */
let saveBtn: HTMLButtonElement | null = null;
let revertBtn: HTMLButtonElement | null = null;
let dirtyBadge: HTMLElement | null = null;
let saveStatus: HTMLElement | null = null;
let genSummary: HTMLElement | null = null;

/** Live badge elements, patched in place by syncBadges. */
let charBadge: HTMLElement | null = null;
let fragBadge: HTMLElement | null = null;
let fragErrBadge: HTMLElement | null = null;

const STYLES_DIR = 'studio/config/styles';
/** Folders made this session that hold no style yet (the listing cannot see
 * an empty directory). */
const extraStyleFolders = new Set<string>();

function styleFolder(i: StudioItem): string {
  const f = String(i.folder ?? '');
  return f === '.' ? '' : f;
}

/** Each prompt folds on its own (§1-88) and starts FOLDED (§1-90, user:
 * "기본적으로 접어놓기 - 지저분함"); an unfold is remembered. */
function promptOpen(which: 'pos' | 'neg'): boolean {
  try {
    return localStorage.getItem('hina.studioPromptOpen.' + which) === '1';
  } catch { return false; }
}

function setPromptOpen(which: 'pos' | 'neg', open: boolean): void {
  try { localStorage.setItem('hina.studioPromptOpen.' + which, open ? '1' : '0'); } catch { /* fine */ }
}

function styleItems(): StudioItem[] {
  return [...(S.cards.styles ?? [])].sort((a, b) =>
    ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
}

function currentStyle(): StudioItem | null {
  const path = activeOf('styles')[0];
  return (S.cards.styles ?? []).find((i) => i.path === path) ?? null;
}

function activeStylePath(): string {
  return activeOf('styles')[0] ?? '';
}

// --- dirty state -------------------------------------------------------------------

function promptDirty(path = activeStylePath()): boolean {
  if (!path || !pending || pending.path !== path) return false;
  if (!loadedDoc || loadedDoc.path !== path) return true;
  return pending.positive !== loadedDoc.doc.positive || pending.negative !== loadedDoc.doc.negative;
}

function genDirty(path = activeStylePath()): boolean {
  if (!path || !genAtLoad || genAtLoad.path !== path) return false;
  return JSON.stringify(genSnapshot(gen as unknown as Record<string, unknown>)) !== JSON.stringify(genAtLoad.snap);
}

function isDirty(path = activeStylePath()): boolean {
  return promptDirty(path) || genDirty(path);
}

function markLoaded(path: string, doc: StyleDoc): void {
  loadedDoc = { path, doc };
  genAtLoad = { path, snap: genSnapshot(gen as unknown as Record<string, unknown>) };
}

function shortGen(): string {
  return [gen.model.replace(/^nai-diffusion-/, 'v'), `${gen.steps} steps`, `CFG ${gen.scale}`,
          `${gen.width}×${gen.height}`].join(' · ');
}

/** Patch the save bar (and the settings summary) without a rebuild. */
function updateSaveBar(): void {
  const path = activeStylePath();
  const pd = promptDirty(path);
  const gd = genDirty(path);
  const dirty = pd || gd;
  if (saveBtn?.isConnected) {
    saveBtn.disabled = !dirty;
    saveBtn.classList.toggle('primary', dirty);
  }
  if (revertBtn?.isConnected) revertBtn.disabled = !dirty;
  if (dirtyBadge?.isConnected) {
    dirtyBadge.style.display = dirty ? '' : 'none';
    dirtyBadge.title = [pd ? '프롬프트' : '', gd ? '요청 설정' : ''].filter(Boolean).join(' · ') + ' 수정이 아직 저장되지 않았습니다';
  }
  if (saveStatus?.isConnected && dirty) {
    saveStatus.textContent = pd && gd ? '프롬프트·요청 설정 미저장' : pd ? '프롬프트 미저장 — 생성에는 저장된 프롬프트가 쓰입니다' : '요청 설정 미저장 (이번 생성에는 적용됨)';
  }
  if (genSummary?.isConnected) genSummary.textContent = shortGen();
}

// --- the column ----------------------------------------------------------------------

export function buildLeftPrompt(mount: HTMLElement): void {
  const cur = currentStyle();
  const items = styleItems();

  // --- 1. the style dropdown ------------------------------------------------------
  const pickTitle = items.length
    ? `저장된 스타일 ${items.length}개 — 선택 · 이동 · 삭제 · 추가`
    : '스타일 추가';
  // Each part of the column is ONE section with ONE header (§1-101, user:
  // "섹션 구분 확실히", "카드 안에 카드가 많음"): a rule between sections, no
  // frame around a frame.
  const styleSec = section('스타일 프롬프트', '스타일 파일에 저장됩니다');
  styleSec.body.appendChild(pickerRow(cur ? { name: cur.name, hint: cur.description || undefined,
    badges: styleFolder(cur) ? [{ text: styleFolder(cur) }] : undefined } : null, {
    title: pickTitle,
    emptyHint: items.length ? '선택된 스타일 없음 — › 에서 고르세요' : '스타일이 없습니다. › 에서 하나 만들어 주세요.',
    onOpen: openStylePicker,
  }));

  // --- 2. what the style saves: prompts + 요청 설정 + 저장 ------------------------------
  const editBox = el('div', { class: 'styleedit stylesaved' });
  if (cur) buildStyleEditor(editBox, cur.path);
  else editBox.appendChild(el('div', { class: 'hint', style: { padding: '6px 0' },
    text: '스타일을 선택하면 긍정/부정 프롬프트와 요청 설정을 여기서 고치고 저장합니다.' }));
  editBox.appendChild(paramsRow(!!cur));
  if (cur) editBox.appendChild(saveBar());
  styleSec.body.appendChild(editBox);
  mount.appendChild(styleSec.node);

  // --- 3. not saved: this session's extra tags -----------------------------------------
  // Said ONCE, in the header: every row and the body used to repeat it.
  const tempSec = section('임시 프롬프트', '저장 안 됨');
  buildTemporaryPrompt(tempSec.body);
  buildTemporaryPrompt(tempSec.body, true);
  mount.appendChild(tempSec.node);

  // --- 4. the material: characters and fragments ------------------------------------------
  const matSec = section('캐릭터 · 조각', '');
  const nChars = activeOf('characters').length;
  // A count is text, not a box inside the button (user: "버튼에 숫자표기에
  // 또 중첩된 네모").
  charBadge = el('span', { class: 'toolcount' + (nChars ? ' on' : ''), text: String(nChars) });
  const charBtn = el('button', { class: 'ghost toolbtn', title: '캐릭터 프롬프트 — 이 열이 캐릭터 목록으로 바뀝니다' },
    [el('span', { text: '캐릭터' }), charBadge]);
  charBtn.addEventListener('click', () => { S.leftView = 'characters'; hub.drawLeft(); });

  const nFrags = (S.cards.fragments ?? []).length;
  fragBadge = el('span', { class: 'toolcount', text: String(nFrags) });
  fragErrBadge = el('span', {
    class: 'toolcount err',
    style: { display: S.unresolvedRefs.length ? '' : 'none' },
    text: `미해결 ${S.unresolvedRefs.length}`,
    title: '프롬프트가 참조하는데 조각이 없는 이름',
  });
  const fragBtn = el('button', { class: 'ghost toolbtn', title: '조각 프롬프트 — 중앙에 구조 편집 화면을 엽니다' },
    [el('span', { text: '조각' }), fragBadge, fragErrBadge]);
  fragBtn.addEventListener('click', () => {
    S.centreMode = 'fragments';
    S.selectedFile = '';
    hub.drawCentre();
  });
  matSec.body.appendChild(el('div', { class: 'toolbtns' }, [charBtn, fragBtn]));
  mount.appendChild(matSec.node);
  updateSaveBar();
}

/** One section of the column: a header (title + a muted note) over its body. */
function section(title: string, note: string): { node: HTMLElement; body: HTMLElement } {
  const body = el('div', { class: 'studiosecbody' });
  const node = el('div', { class: 'studiosec' }, [
    el('div', { class: 'studiosechead' }, [
      el('span', { class: 'studiosectitle', text: title }),
      note ? el('span', { class: 'studiosecnote', text: note }) : null,
    ]),
    body,
  ]);
  return { node, body };
}

/** 요청 설정 (§1-35, §1-77) sits inside the style block: it is part of what
 * the style saves. Without a style it is this browser's card only. */
function paramsRow(bound: boolean): HTMLElement {
  const paramsBtn = el('button', { class: 'ghost tiny', title: '요청 설정 — 모델·크기·스텝·UC 등 생성 요청의 파라미터' },
    [el('span', { text: '⚙ 요청 설정' })]);
  paramsBtn.addEventListener('click', () => openParamsDialog());
  genSummary = el('span', { class: 'hint grow genpeek', text: shortGen(),
    title: bound ? '스타일에 함께 저장되는 요청 설정' : '스타일이 없어 이 브라우저에만 저장됩니다' });
  return el('div', { class: 'row genrow' }, [paramsBtn, genSummary]);
}

function saveBar(): HTMLElement {
  saveBtn = el('button', { class: 'tiny stylesave', text: '저장', title: '긍정·부정 프롬프트와 요청 설정을 스타일 파일에 저장합니다 (Ctrl+S)' }) as HTMLButtonElement;
  revertBtn = el('button', { class: 'ghost tiny', text: '되돌리기', title: '저장하지 않은 수정을 버리고 저장된 스타일로 돌아갑니다' }) as HTMLButtonElement;
  dirtyBadge = el('span', { class: 'badge warn stylebadge', text: '미저장' });
  saveStatus = el('span', { class: 'hint grow savestatus' });
  saveBtn.addEventListener('click', () => { void saveStyle(); });
  revertBtn.addEventListener('click', () => revertEdits());
  return el('div', { class: 'row stylesavebar' }, [dirtyBadge, saveStatus, revertBtn, saveBtn]);
}

function buildTemporaryPrompt(mount: HTMLElement, negative = false): void {
  const label = negative ? '임시 네거티브 프롬프트' : '임시 프롬프트';
  const textKey = negative ? 'negativeText' : 'text';
  const expandedKey = negative ? 'negativeExpanded' : 'expanded';
  const toggle = el('button', { class: 'ghost tiny foldcaret', title: label + ' 펼치기' }) as HTMLButtonElement;
  const status = el('span', { class: 'badge ok tempon' });
  const input = el('textarea', { rows: '4', class: 'promptedit', placeholder: negative ? '이번 작업에서 제외할 태그' : '이번 작업에 추가할 태그',
    'aria-label': label + ' (저장되지 않음)' }) as HTMLTextAreaElement;
  input.value = temporaryPrompt[textKey];
  const reset = el('button', { class: 'ghost tiny', text: '비우기' });
  const body = el('div', { class: 'tempbody' }, [input,
    el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, [reset])]);
  const sync = (): void => {
    toggle.textContent = temporaryPrompt[expandedKey] ? '▾' : '▸';
    toggle.setAttribute('aria-expanded', String(temporaryPrompt[expandedKey]));
    toggle.title = label + (temporaryPrompt[expandedKey] ? ' 접기' : ' 펼치기');
    body.style.display = temporaryPrompt[expandedKey] ? '' : 'none';
    // Only the useful fact per row: this one is riding the next run.
    const on = !!temporaryPrompt[textKey].trim();
    status.textContent = on ? '적용 중' : '';
    status.style.display = on ? '' : 'none';
  };
  toggle.addEventListener('click', () => { temporaryPrompt[expandedKey] = !temporaryPrompt[expandedKey]; sync(); });
  input.addEventListener('input', () => { temporaryPrompt[textKey] = input.value; sync(); checkUnresolved(); });
  reset.addEventListener('click', () => { temporaryPrompt[textKey] = ''; input.value = ''; sync(); checkUnresolved(); });
  const head = el('div', { class: 'row promptfoldhead' }, [toggle, el('span', { class: 'promptfoldlabel', text: label }), status]);
  head.addEventListener('click', (ev) => { if (ev.target !== toggle) toggle.click(); });
  mount.appendChild(el('div', { class: 'temporary promptfold' }, [head, body]));
  attachHilite(input, { mode: 'nai', fragments: () => fragKeys() });
  sync();
}

/** Patch the counts without rebuilding the column (typing-safe). */
export function syncPromptBadges(): void {
  if (charBadge?.isConnected) {
    const n = activeOf('characters').length;
    charBadge.textContent = String(n);
    charBadge.className = 'toolcount' + (n ? ' on' : '');
  }
  if (fragBadge?.isConnected) fragBadge.textContent = String((S.cards.fragments ?? []).length);
  if (fragErrBadge?.isConnected) {
    fragErrBadge.style.display = S.unresolvedRefs.length ? '' : 'none';
    fragErrBadge.textContent = `미해결 ${S.unresolvedRefs.length}`;
    fragErrBadge.title = '프롬프트가 참조하는데 조각이 없는 이름: ' + S.unresolvedRefs.join(', ');
  }
}

// --- unsaved edits: ask before they would be lost ------------------------------------

function askChoice(title: string, text: string, choices: { label: string; value: string; cls?: string }[]): Promise<string> {
  return new Promise((resolve) => {
    let done = false;
    let close: () => void = () => { /* set below */ };
    const finish = (v: string): void => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    const btns = choices.map((c) => {
      const b = el('button', { class: c.cls ?? 'ghost', text: c.label });
      b.addEventListener('click', () => finish(c.value));
      return b;
    });
    close = modal(title, el('div', { class: 'unsavedask' }, [
      el('div', { text }),
      el('div', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end', marginTop: '12px', flexWrap: 'wrap' } }, btns),
    ]), { onClose: () => finish('cancel') });
  });
}

/** True = go on (saved or discarded, or nothing to lose); false = stay. */
async function resolveUnsaved(action: string): Promise<boolean> {
  const path = activeStylePath();
  if (!isDirty(path)) return true;
  const name = styleSync.boundName();
  const pick = await askChoice('저장하지 않은 스타일 수정', `스타일 ‘${name}’ 에 저장하지 않은 수정이 있습니다. ${action}`, [
    { label: '취소', value: 'cancel' },
    { label: '버리고 계속', value: 'discard' },
    { label: '저장하고 계속', value: 'save', cls: 'primary' },
  ]);
  if (pick === 'save') return await saveStyle();
  if (pick === 'discard') { revertEdits(false); return true; }
  return false;
}

styleSync.dirty = () => isDirty();
styleSync.beforeRun = async () => {
  // Unsaved 요청 설정 ride the request anyway; unsaved PROMPT edits do not -
  // the backend reads the style file. Say so instead of running the old text.
  if (!promptDirty()) return true;
  const pick = await askChoice('저장하지 않은 스타일 프롬프트',
    `스타일 ‘${styleSync.boundName()}’ 의 프롬프트 수정이 저장되지 않았습니다. 생성은 저장된 프롬프트로 실행됩니다.`, [
      { label: '취소', value: 'cancel' },
      { label: '저장 안 하고 생성', value: 'run' },
      { label: '저장하고 생성', value: 'save', cls: 'primary' },
    ]);
  if (pick === 'save') return await saveStyle();
  return pick === 'run';
};

// --- the picker ------------------------------------------------------------------

function openStylePicker(): void {
  openListPicker({
    title: '스타일 프롬프트 선택',
    hint: '한 번에 하나만 실립니다. 선택하면 바로 적용됩니다.',
    load: async () => styleItems().map((i): PickerEntry => ({
      id: i.path,
      name: i.name,
      hint: i.description || undefined,
      selected: !!i.enabled,
      group: styleFolder(i),
    })),
    // Styles in folders, like fragments (user: "스타일 프리셋도 폴더").
    folders: {
      list: () => [...new Set([...extraStyleFolders, ...styleItems().map(styleFolder)])].filter(Boolean),
      create: (anchor) => new Promise<string>((resolve) => {
        namePopover(anchor, {
          label: '새 폴더 이름', ok: '만들기',
          onSubmit: async (raw) => {
            const nm = cardStem(raw);
            if (!nm) return;
            await state.mkdirFile(`${STYLES_DIR}/${nm}`);
            extraStyleFolders.add(nm);
            resolve(nm);
          },
        });
      }),
      move: async (e, folder) => {
        const r = await state.moveFile(e.id, STYLES_DIR + (folder ? '/' + folder : ''));
        // Unsaved edits follow the file to its new path.
        if (pending?.path === e.id) pending = { ...pending, path: r.to };
        if (loadedDoc?.path === e.id) loadedDoc = { ...loadedDoc, path: r.to };
        if (genAtLoad?.path === e.id) genAtLoad = { ...genAtLoad, path: r.to };
        await hub.refreshArea('styles');
        hub.drawLeft();
      },
      createIn: (folder) => createStyle(folder),
    },
    onSelect: async (e) => {
      if (e.id === activeStylePath()) return;
      if (!(await resolveUnsaved('다른 스타일로 바꾸기 전에 어떻게 할까요?'))) return;
      await selectStyle(e.id);
    },
    // No 수정 here (§1-39): a style is edited in place in this column; the
    // centre card editor for the same file confused more than it helped.
    onDelete: async (e) => {
      // Cheap on purpose: drop the row from memory and redraw the column.
      // The full refreshArea (listing + centre rebuild + dry plan) made
      // every delete feel like a stall.
      await state.deleteFile(e.id);
      S.cards.styles = (S.cards.styles ?? []).filter((i) => i.path !== e.id);
      if (pending?.path === e.id) pending = null;
      if (loadedDoc?.path === e.id) loadedDoc = null;
      if (genAtLoad?.path === e.id) genAtLoad = null;
      if (S.selectedFile === e.id) { S.selectedFile = ''; hub.drawCentre(); }
      hub.drawLeft();
      hub.touchQuiet();
    },
    onCreate: () => createStyle(''),
    createLabel: '새 스타일 추가',
  });
}

function createStyle(folder: string): void {
  askName(folder ? `새 스타일 — ${folder}/` : '새 스타일', {
    label: '이름이 곧 파일명입니다.',
    placeholder: '예: 수채화',
    onSubmit: async (nm) => {
      if (!(await resolveUnsaved('새 스타일로 바꾸기 전에 어떻게 할까요?'))) return;
      const path = await newCard('styles', folder, nm);
      if (!path) return;
      if (folder) extraStyleFolders.delete(folder);
      // A fresh style becomes the selection: the very next 생성 uses it.
      void selectStyle(path);
    },
  });
}

/** Single choice: turning one style ON turns the others OFF (setMeta both
 * ways), so the server-side `active("styles")` and the agent keep working. */
async function selectStyle(path: string): Promise<void> {
  const styles = S.cards.styles ?? [];
  for (const it of styles) {
    if (it.path !== path && it.enabled) {
      await state.studio.setMeta(it.path, { enabled: false });
      it.enabled = false;
    }
  }
  const target = styles.find((i) => i.path === path);
  if (target && !target.enabled) {
    await state.studio.setMeta(path, { enabled: true });
    target.enabled = true;
  }
  pending = null;
  loadedDoc = null;
  genAtLoad = null;
  // The style's request settings come with it, like its prompt does (§1-77).
  try {
    const doc = parseStyleDoc((await state.readFile(path)).content);
    const g = genFromMeta(doc.meta);
    if (applyGen(g)) hub.notice('스타일의 요청 설정을 불러왔습니다: ' + describeGen(g), 'ok');
    markLoaded(path, doc);
  } catch { /* the style still switched; settings are optional */ }
  hub.drawLeft();
  hub.drawCentre();
  checkUnresolved();
  hub.touchQuiet();
}

/** Put a style's saved settings into 요청 설정. False = none saved. */
function applyGen(g: GenSettings): boolean {
  if (!Object.keys(g).length) return false;
  Object.assign(gen, g);
  persistGen();
  return true;
}

// --- request settings <-> the active style (§1-77, §1-90) --------------------------
//
// A style and its 요청 설정 are one thing: loading the style loads its
// settings, and an edit in 요청 설정 belongs to the style - shown as 미저장
// in the style block until its 저장 (the edit already applies to the next run,
// since the panel sends the settings explicitly).

styleSync.edited = () => { updateSaveBar(); };
styleSync.boundName = () => {
  const path = activeStylePath();
  if (!path) return '';
  const card = (S.cards.styles ?? []).find((i) => i.path === path);
  return String(card?.name || path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''));
};
/** The library read carries the active style's text (§1-90): it becomes the
 * saved base, unless the user has edits pending - those are never replaced. */
styleSync.prime = (s) => {
  if (!s || !s.path) return false;
  if (isDirty(s.path)) return false;
  const doc = parseStyleDoc(s.content);
  if (loadedDoc && loadedDoc.path === s.path && buildStyleDoc(loadedDoc.doc) === buildStyleDoc(doc)) return false;
  applyGen(genFromMeta(doc.meta));
  markLoaded(s.path, doc);
  return true;
};

// --- the inline editor -----------------------------------------------------------

function buildStyleEditor(mountEl: HTMLElement, path: string): void {
  const pos = el('textarea', { rows: '7', class: 'promptedit', placeholder: '긍정 프롬프트' }) as HTMLTextAreaElement;
  const neg = el('textarea', { rows: '4', class: 'promptedit', placeholder: '부정 프롬프트' }) as HTMLTextAreaElement;

  const posFold = promptFold('pos', '긍정 프롬프트', pos);
  const negFold = promptFold('neg', '부정 프롬프트', neg);
  mountEl.append(posFold.node, negFold.node);
  // NAI syntax tints ({} · [] · N::…:: · <조각> · #주석) plus tag/fragment
  // autocomplete, reference-tool-style (item 9-10 of the field report).
  const fragNames = () => fragKeys();
  attachHilite(pos, { mode: 'nai', fragments: fragNames });
  attachHilite(neg, { mode: 'nai', fragments: fragNames });

  const fill = (positive: string, negative: string) => {
    pos.value = positive;
    neg.value = negative;
    posFold.preview();
    negFold.preview();
  };

  // Unsaved edits win over the file: a rebuild must not eat them.
  if (pending && pending.path === path) {
    fill(pending.positive, pending.negative);
  } else if (loadedDoc && loadedDoc.path === path) {
    fill(loadedDoc.doc.positive, loadedDoc.doc.negative);
  } else {
    // Only when the library read did not bring the text (an older backend,
    // a style picked before its read landed).
    posFold.setPeek('읽는 중입니다…');
    void state.readFile(path).then((r) => {
      const doc = parseStyleDoc(r.content);
      if (!isDirty(path)) {
        applyGen(genFromMeta(doc.meta));
        markLoaded(path, doc);
      } else if (!loadedDoc || loadedDoc.path !== path) {
        loadedDoc = { path, doc };
      }
      if (pos.isConnected && (!pending || pending.path !== path)) fill(doc.positive, doc.negative);
      updateSaveBar();
    }).catch((e) => { posFold.setPeek(msg(e)); });
  }

  const onEdit = () => {
    posFold.preview();
    negFold.preview();
    pending = { path, positive: pos.value, negative: neg.value };
    updateSaveBar();
  };
  pos.addEventListener('input', onEdit);
  neg.addEventListener('input', onEdit);
  // Ctrl/⌘+S saves the block from either prompt.
  const onKey = (ev: Event) => {
    const k = ev as KeyboardEvent;
    if ((k.ctrlKey || k.metaKey) && (k.key === 's' || k.key === 'S')) {
      k.preventDefault();
      void saveStyle();
    }
  };
  pos.addEventListener('keydown', onKey);
  neg.addEventListener('keydown', onKey);
}

/** One prompt with a −/+ header; folded, it shows its first line instead. */
function promptFold(which: 'pos' | 'neg', label: string, input: HTMLTextAreaElement):
    { node: HTMLElement; preview(): void; setPeek(t: string): void } {
  let open = promptOpen(which);
  const toggle = el('button', { class: 'ghost tiny foldcaret' }) as HTMLButtonElement;
  const peek = el('span', { class: 'hint grow promptpeek' });
  // The hilite wraps the textarea later; folding hides this box, wrapper and all.
  const body = el('div', {}, [input]);
  const sync = (): void => {
    toggle.textContent = open ? '▾' : '▸';
    toggle.title = label + (open ? ' 접기' : ' 펼치기');
    toggle.setAttribute('aria-expanded', String(open));
    body.style.display = open ? '' : 'none';
    peek.style.display = open ? 'none' : '';
  };
  const preview = (): void => {
    const first = input.value.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    peek.textContent = first || '(비어 있음)';
    peek.title = first;
  };
  toggle.addEventListener('click', () => { open = !open; setPromptOpen(which, open); sync(); });
  // A folded row opens from anywhere on it, not only the small button.
  const head = el('div', { class: 'row promptfoldhead' }, [toggle, el('span', { class: 'promptfoldlabel', text: label }), peek]);
  head.addEventListener('click', (ev) => { if (ev.target !== toggle && !open) toggle.click(); });
  sync();
  preview();
  return { node: el('div', { class: 'field promptfold' }, [head, body]), preview,
           setPeek: (t: string) => { peek.textContent = t; } };
}

/** Write the style block - prompts and 요청 설정 - into the style file,
 * front matter preserved. The ONE place a style is written from this column. */
async function saveStyle(): Promise<boolean> {
  const path = activeStylePath();
  if (!path) return false;
  if (!isDirty(path)) return true;
  let base: StyleDoc;
  if (loadedDoc && loadedDoc.path === path) {
    base = loadedDoc.doc;
  } else {
    // The meta must come from a real read: saving without it would blank
    // name/enabled/order.
    try {
      base = parseStyleDoc((await state.readFile(path)).content);
    } catch (e) {
      hub.notice('스타일을 저장하지 못했습니다: ' + msg(e), 'err');
      return false;
    }
  }
  const p = pending && pending.path === path ? pending : null;
  const meta = new Map(base.meta);
  const withGen = genDirty(path);
  if (withGen) writeGenMeta(meta, gen as unknown as Record<string, unknown>);
  const doc: StyleDoc = { meta, positive: p ? p.positive : base.positive, negative: p ? p.negative : base.negative };
  if (saveBtn) saveBtn.disabled = true;
  if (saveStatus) saveStatus.textContent = '저장 중…';
  try {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const fname = path.slice(path.lastIndexOf('/') + 1);
    await state.uploadFile(fname, buildStyleDoc(doc), false, dir);
    loadedDoc = { path, doc };
    if (withGen || !genAtLoad || genAtLoad.path !== path) {
      genAtLoad = { path, snap: genSnapshot(gen as unknown as Record<string, unknown>) };
    }
    // Typing during the upload made a newer pending: that one stays unsaved.
    if (pending === p) pending = null;
    if (saveStatus) saveStatus.textContent = `저장됨 ${new Date().toLocaleTimeString()}`;
    hub.touchQuiet();
    checkUnresolved();
    updateSaveBar();
    return true;
  } catch (e) {
    hub.notice('스타일을 저장하지 못했습니다: ' + msg(e), 'err');
    if (saveStatus) saveStatus.textContent = '저장하지 못했습니다';
    updateSaveBar();
    return false;
  }
}

/** Drop the unsaved edits: the prompts go back to the file, 요청 설정 to
 * what the style held when it was loaded or last saved. */
function revertEdits(redraw = true): void {
  const path = activeStylePath();
  if (pending && pending.path === path) pending = null;
  if (genAtLoad && genAtLoad.path === path) {
    Object.assign(gen, genAtLoad.snap);
    persistGen();
  }
  if (saveStatus) saveStatus.textContent = '';
  if (redraw) hub.drawLeft();
  else updateSaveBar();
}
