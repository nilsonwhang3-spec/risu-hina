/**
 * The left 프롬프트 tab: which ONE style rides, edited in place.
 *
 *   1. the style dropdown - one style is selected, the way an agent preset
 *      is: a compact current row, and 선택 · 수정 · 삭제 · 추가 behind the ›.
 *   2. the selected style's 긍정 / 부정 prompts, always unfolded and saved as
 *      you type (debounced) - the edit-then-generate-one loop lives here.
 *   3. the tool buttons: 캐릭터 swaps this column to the character view,
 *      조각 opens the fragment organizer in the centre.
 *
 * A keystroke here must never rebuild the column under the caret: saves go
 * through touchQuiet, and the debounced unresolved check patches badges in
 * place (hub.syncBadges) instead of redrawing.
 */
import { el } from '../dom';
import { askName } from '../kit';
import { attachHilite } from '../hilite';
import { state, type StudioItem } from '../../state';
import { pickerRow, openListPicker, type PickerEntry } from '../pickers';
import { S, hub, activeOf, checkUnresolved, newCard, msg, fragKeys, temporaryPrompt, gen, persistGen } from './store';
import { openParamsDialog } from './gen';
import { parseStyleDoc, buildStyleDoc, type StyleDoc, genFromMeta, writeGenMeta, clearGenMeta, describeGen, describeStyleFlags, type GenSettings } from './stylefile';

/** Unsaved inline edits, kept across a column rebuild so a redraw (a toggle,
 * a refresh) cannot eat what was just typed. */
let pending: { path: string; positive: string; negative: string } | null = null;
let loadedDoc: { path: string; doc: StyleDoc } | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Live badge elements, patched in place by syncBadges. */
let charBadge: HTMLElement | null = null;
let fragBadge: HTMLElement | null = null;
let fragErrBadge: HTMLElement | null = null;

function styleOpen(): boolean {
  try { return localStorage.getItem('hina.studioStyleOpen') !== '0'; } catch { return true; }
}

function styleItems(): StudioItem[] {
  return [...(S.cards.styles ?? [])].sort((a, b) =>
    ((a.order ?? 100) - (b.order ?? 100)) || a.path.localeCompare(b.path));
}

function currentStyle(): StudioItem | null {
  const path = activeOf('styles')[0];
  return (S.cards.styles ?? []).find((i) => i.path === path) ?? null;
}

export function buildLeftPrompt(mount: HTMLElement): void {
  const cur = currentStyle();
  const items = styleItems();

  // --- the style dropdown ------------------------------------------------------
  const pickTitle = items.length
    ? `저장된 스타일 ${items.length}개 — 선택 · 수정 · 삭제 · 추가`
    : '스타일 추가';
  mount.appendChild(el('div', { class: 'sectiontitle', style: { padding: '6px 8px 0' }, text: '스타일 프롬프트' }));
  mount.appendChild(el('div', { style: { padding: '4px 8px 0' } }, [
    pickerRow(cur ? { name: cur.name, hint: cur.description || undefined } : null, {
      title: pickTitle,
      emptyHint: items.length ? '선택된 스타일 없음 — › 에서 고르세요' : '스타일이 없습니다. › 에서 하나 만들어 주세요.',
      onOpen: openStylePicker,
    }),
  ]));

  // --- the selected style, edited in place - foldable, remembered ------------------
  const editBox = el('div', { class: 'styleedit' });
  if (cur) buildStyleEditor(editBox, cur.path);
  else editBox.appendChild(el('div', { class: 'hint', style: { padding: '6px 0' },
    text: '스타일을 선택하면 긍정/부정 프롬프트를 여기서 바로 수정합니다.' }));
  const fold = el('details', { class: 'advbox stylefold', ...(styleOpen() ? { open: true } : {}) }, [
    el('summary', { text: '프롬프트 수정' }),
    editBox,
  ]) as HTMLDetailsElement;
  fold.addEventListener('toggle', () => {
    try { localStorage.setItem('hina.studioStyleOpen', fold.open ? '1' : '0'); } catch { /* fine */ }
  });
  mount.appendChild(fold);
  buildTemporaryPrompt(mount);
  buildTemporaryPrompt(mount, true);

  // --- the tool buttons ----------------------------------------------------------
  const nChars = activeOf('characters').length;
  charBadge = el('span', { class: 'badge' + (nChars ? ' ok' : ''), text: String(nChars) });
  const charBtn = el('button', { class: 'ghost toolbtn', title: '캐릭터 프롬프트 — 이 열이 캐릭터 목록으로 바뀝니다' },
    [el('span', { text: '캐릭터' }), charBadge]);
  charBtn.addEventListener('click', () => { S.leftView = 'characters'; hub.drawLeft(); });

  const nFrags = (S.cards.fragments ?? []).length;
  fragBadge = el('span', { class: 'badge', text: String(nFrags) });
  fragErrBadge = el('span', {
    class: 'badge err',
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
  // 요청 설정 lives here with the other material (§1-35, user): model ·
  // size · steps · UC are part of the prompt setup, not of the 1장 or 배치
  // view that happens to be open.
  const paramsBtn = el('button', { class: 'ghost toolbtn', title: '요청 설정 — 모델·크기·스텝·UC 등 생성 요청의 파라미터' },
    [el('span', { text: '⚙ 요청 설정' })]);
  paramsBtn.addEventListener('click', () => openParamsDialog());
  mount.appendChild(el('div', { class: 'toolbtns' }, [charBtn, fragBtn, paramsBtn]));

}

function buildTemporaryPrompt(mount: HTMLElement, negative = false): void {
  const label = negative ? '임시 네거티브 프롬프트' : '임시 프롬프트';
  const textKey = negative ? 'negativeText' : 'text';
  const expandedKey = negative ? 'negativeExpanded' : 'expanded';
  const toggle = el('button', { class: 'ghost tiny', title: label + ' 펼치기' }) as HTMLButtonElement;
  const status = el('span', { class: 'hint' });
  const input = el('textarea', { rows: '4', class: 'promptedit', placeholder: negative ? '이번 작업에서 제외할 태그' : '이번 작업에 추가할 태그',
    'aria-label': label + ' (저장되지 않음)' }) as HTMLTextAreaElement;
  input.value = temporaryPrompt[textKey];
  const reset = el('button', { class: 'ghost tiny', text: '비우기' });
  const body = el('div', {}, [input,
    el('div', { class: 'row' }, [el('span', { class: 'hint grow', text: '저장되지 않음 · 새로고침하면 초기화됩니다' }), reset])]);
  const sync = (): void => {
    toggle.textContent = temporaryPrompt[expandedKey] ? '−' : '+';
    toggle.setAttribute('aria-expanded', String(temporaryPrompt[expandedKey]));
    toggle.title = label + (temporaryPrompt[expandedKey] ? ' 접기' : ' 펼치기');
    body.style.display = temporaryPrompt[expandedKey] ? '' : 'none';
    status.textContent = temporaryPrompt[textKey].trim() ? '생성에 적용 중 · 저장되지 않음' : '저장되지 않음';
  };
  toggle.addEventListener('click', () => { temporaryPrompt[expandedKey] = !temporaryPrompt[expandedKey]; sync(); });
  input.addEventListener('input', () => { temporaryPrompt[textKey] = input.value; sync(); checkUnresolved(); });
  reset.addEventListener('click', () => { temporaryPrompt[textKey] = ''; input.value = ''; sync(); checkUnresolved(); });
  mount.appendChild(el('div', { class: 'styleedit' }, [
    el('div', { class: 'row' }, [toggle, el('span', { text: label }), status]), body,
  ]));
  attachHilite(input, { mode: 'nai', fragments: () => fragKeys() });
  sync();
}

/** Patch the counts without rebuilding the column (typing-safe). */
export function syncPromptBadges(): void {
  if (charBadge?.isConnected) {
    const n = activeOf('characters').length;
    charBadge.textContent = String(n);
    charBadge.className = 'badge' + (n ? ' ok' : '');
  }
  if (fragBadge?.isConnected) fragBadge.textContent = String((S.cards.fragments ?? []).length);
  if (fragErrBadge?.isConnected) {
    fragErrBadge.style.display = S.unresolvedRefs.length ? '' : 'none';
    fragErrBadge.textContent = `미해결 ${S.unresolvedRefs.length}`;
    fragErrBadge.title = '프롬프트가 참조하는데 조각이 없는 이름: ' + S.unresolvedRefs.join(', ');
  }
}

// --- the picker ------------------------------------------------------------------

function openStylePicker(): void {
  void flushSave();
  openListPicker({
    title: '스타일 프롬프트 선택',
    hint: '한 번에 하나만 실립니다. 선택하면 바로 적용됩니다.',
    load: async () => styleItems().map((i): PickerEntry => ({
      id: i.path,
      name: i.name,
      hint: i.description || undefined,
      selected: !!i.enabled,
    })),
    onSelect: (e) => selectStyle(e.id),
    // No 수정 here (§1-39): a style is edited in place in this column; the
    // centre card editor for the same file confused more than it helped.
    onDelete: async (e) => {
      // Cheap on purpose: drop the row from memory and redraw the column.
      // The full refreshArea (listing + centre rebuild + dry plan) made
      // every delete feel like a stall.
      await state.deleteFile(e.id);
      S.cards.styles = (S.cards.styles ?? []).filter((i) => i.path !== e.id);
      if (S.selectedFile === e.id) { S.selectedFile = ''; hub.drawCentre(); }
      hub.drawLeft();
      hub.touchQuiet();
    },
    onCreate: () => {
      askName('새 스타일', {
        label: '이름이 곧 파일명입니다.',
        placeholder: '예: 수채화',
        onSubmit: async (nm) => {
          const path = await newCard('styles', '', nm);
          if (!path) return;
          // A fresh style becomes the selection: the very next 생성 uses it.
          void selectStyle(path);
        },
      });
    },
    createLabel: '새 스타일 추가',
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
  // A style that carries generation settings (§1-77) brings them along: the
  // card below shows what the next run will use, and the user sees why.
  try {
    const doc = parseStyleDoc((await state.readFile(path)).content);
    loadedDoc = { path, doc };
    const g = genFromMeta(doc.meta);
    if (applyGen(g)) hub.notice('스타일의 제작 설정을 적용했습니다: ' + describeGen(g), 'ok');
  } catch { /* the style still switched; settings are optional */ }
  hub.drawLeft();
  hub.drawCentre();
  checkUnresolved();
  hub.touchQuiet();
}

/** Put a style's saved settings on the generation card. False = none saved. */
function applyGen(g: GenSettings): boolean {
  if (!Object.keys(g).length) return false;
  Object.assign(gen, g);
  persistGen();
  return true;
}

// --- the inline editor -----------------------------------------------------------

function buildStyleEditor(mountEl: HTMLElement, path: string): void {
  const pos = el('textarea', { rows: '7', class: 'promptedit', placeholder: '긍정 프롬프트' }) as HTMLTextAreaElement;
  const neg = el('textarea', { rows: '4', class: 'promptedit', placeholder: '부정 프롬프트' }) as HTMLTextAreaElement;
  const status = el('div', { class: 'hint', style: { minHeight: '14px' } });

  // Generation settings saved with the style (§1-77): what it carries, and
  // save / load / clear. The prompt text autosaves; the settings are saved
  // on purpose, because the card's values change all the time.
  const genLine = el('div', { class: 'hint stylegen' });
  const saveGen = el('button', { class: 'ghost tiny', text: '현재 제작 설정 저장',
    title: '지금 생성 카드의 모델 · Step · CFG · Sampler · 크기 등을 이 스타일에 저장합니다' }) as HTMLButtonElement;
  const loadGen = el('button', { class: 'ghost tiny', text: '불러오기',
    title: '이 스타일에 저장된 제작 설정을 생성 카드에 적용합니다' }) as HTMLButtonElement;
  const clearGen = el('button', { class: 'ghost tiny', text: '지우기',
    title: '이 스타일에서 제작 설정을 뺍니다 (프롬프트는 그대로)' }) as HTMLButtonElement;
  const paintGen = (meta: Map<string, string> | null) => {
    const g = meta ? genFromMeta(meta) : {};
    const flags = meta ? describeStyleFlags(meta) : '';
    const has = Object.keys(g).length > 0 || !!flags;
    const text = [describeGen(g), flags].filter(Boolean).join(' · ');
    genLine.textContent = has ? '저장된 제작 설정: ' + text : '제작 설정: 저장 안 됨 (켜도 생성 카드의 현재 값을 씁니다)';
    loadGen.style.display = clearGen.style.display = has ? '' : 'none';
  };
  const writeMeta = async (change: (meta: Map<string, string>) => void, said: string) => {
    await flushSave();
    let doc: StyleDoc;
    try {
      doc = loadedDoc && loadedDoc.path === path ? loadedDoc.doc : parseStyleDoc((await state.readFile(path)).content);
    } catch (e) {
      hub.notice('스타일을 읽지 못했습니다: ' + msg(e), 'err');
      return;
    }
    const meta = new Map(doc.meta);
    change(meta);
    const next: StyleDoc = { meta, positive: doc.positive, negative: doc.negative };
    try {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const fname = path.slice(path.lastIndexOf('/') + 1);
      await state.uploadFile(fname, buildStyleDoc(next), false, dir);
      loadedDoc = { path, doc: next };
      paintGen(meta);
      hub.notice(said, 'ok');
      hub.touchQuiet();
    } catch (e) {
      hub.notice('스타일을 저장하지 못했습니다: ' + msg(e), 'err');
    }
  };
  saveGen.addEventListener('click', () => {
    // Read the card at click time, not when the editor was built.
    const now = new Map<string, string>();
    writeGenMeta(now, gen as unknown as Record<string, unknown>);
    void writeMeta((m) => writeGenMeta(m, gen as unknown as Record<string, unknown>),
      '이 스타일에 제작 설정을 저장했습니다: ' + describeGen(genFromMeta(now)));
  });
  loadGen.addEventListener('click', async () => {
    // Read the file now: the agent or a hand edit may have changed the
    // settings since this editor loaded it.
    let meta: Map<string, string>;
    try {
      const doc = parseStyleDoc((await state.readFile(path)).content);
      if (!pending || pending.path !== path) loadedDoc = { path, doc };
      meta = doc.meta;
    } catch (e) {
      hub.notice('스타일을 읽지 못했습니다: ' + msg(e), 'err');
      return;
    }
    paintGen(meta);
    const g = genFromMeta(meta);
    if (applyGen(g)) {
      hub.notice('제작 설정을 불러왔습니다: ' + describeGen(g), 'ok');
      hub.drawCentre();
    } else {
      hub.notice('이 스타일에는 저장된 제작 설정이 없습니다.', '');
    }
  });
  clearGen.addEventListener('click', () => void writeMeta(clearGenMeta, '이 스타일에서 제작 설정을 뺐습니다.'));

  mountEl.append(
    el('label', { class: 'field' }, [el('span', { text: '긍정 프롬프트' }), pos]),
    el('label', { class: 'field' }, [el('span', { text: '부정 프롬프트' }), neg]),
    status,
    el('div', { class: 'row stylegenrow' }, [genLine, el('span', { class: 'spacer' }), saveGen, loadGen, clearGen]),
  );
  paintGen(loadedDoc && loadedDoc.path === path ? loadedDoc.doc.meta : null);
  // NAI syntax tints ({} · [] · N::…:: · <조각> · #주석) plus tag/fragment
  // autocomplete, reference-tool-style (item 9-10 of the field report).
  const fragNames = () => fragKeys();
  attachHilite(pos, { mode: 'nai', fragments: fragNames });
  attachHilite(neg, { mode: 'nai', fragments: fragNames });

  const fill = (positive: string, negative: string) => {
    pos.value = positive;
    neg.value = negative;
  };

  // Unsaved edits win over the file: a rebuild mid-typing must not eat them.
  if (pending && pending.path === path) {
    fill(pending.positive, pending.negative);
    schedule(path, status);
  } else if (loadedDoc && loadedDoc.path === path) {
    fill(loadedDoc.doc.positive, loadedDoc.doc.negative);
  } else {
    status.textContent = '읽는 중입니다…';
    void state.readFile(path).then((r) => {
      const doc = parseStyleDoc(r.content);
      loadedDoc = { path, doc };
      if (!pending || pending.path !== path) {
        if (pos.isConnected) fill(doc.positive, doc.negative);
      }
      if (genLine.isConnected) paintGen(doc.meta);
      status.textContent = '';
    }).catch((e) => { status.textContent = msg(e); });
  }

  const onEdit = () => {
    pending = { path, positive: pos.value, negative: neg.value };
    schedule(path, status);
  };
  pos.addEventListener('input', onEdit);
  neg.addEventListener('input', onEdit);
}

function schedule(path: string, status: HTMLElement): void {
  if (saveTimer) clearTimeout(saveTimer);
  status.textContent = '수정 중…';
  saveTimer = setTimeout(() => {
    void flushSave().then((ok) => {
      if (ok && status.isConnected) {
        status.textContent = `저장됨 ${new Date().toLocaleTimeString()}`;
      }
    });
  }, 800);
  void path;
}

/** Write the pending edit back into the style file, front matter preserved. */
async function flushSave(): Promise<boolean> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const p = pending;
  if (!p) return false;
  // The meta must come from a real read: saving before the load finished
  // would blank name/enabled/order. Read it now if it is not here yet.
  let meta: Map<string, string>;
  if (loadedDoc && loadedDoc.path === p.path) {
    meta = loadedDoc.doc.meta;
  } else {
    try {
      meta = parseStyleDoc((await state.readFile(p.path)).content).meta;
    } catch (e) {
      hub.notice('스타일을 저장하지 못했습니다: ' + msg(e), 'err');
      return false;
    }
  }
  const doc: StyleDoc = { meta, positive: p.positive, negative: p.negative };
  try {
    const dir = p.path.slice(0, p.path.lastIndexOf('/'));
    const fname = p.path.slice(p.path.lastIndexOf('/') + 1);
    await state.uploadFile(fname, buildStyleDoc(doc), false, dir);
    loadedDoc = { path: p.path, doc };
    if (pending === p) pending = null;
    hub.touchQuiet();
    checkUnresolved();
    return true;
  } catch (e) {
    hub.notice('스타일을 저장하지 못했습니다: ' + msg(e), 'err');
    return false;
  }
}
