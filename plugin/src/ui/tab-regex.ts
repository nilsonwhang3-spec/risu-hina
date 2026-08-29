/**
 * Regex (customscript) - RisuAI's find/replace scripts, order included -
 * plus the card's backgroundHTML/backgroundCSS, which live here because they
 * are display machinery like the scripts, not character prose.
 *
 * Order matters for scripts: later ones see earlier ones' output, so the
 * rows carry ↑↓ in the list itself. The `out` field can be tens of thousands
 * of characters of HTML, so the editor is a monospace area sized for it and
 * the list shows only comments.
 */
import { el, clear, armed, refocusSearch, focusButton, diffCard } from './dom';
import { state, type CardScript, type CardField } from '../state';
import { makeTab, listRow, savedText, type NoticeKind, type TabUi } from './kit';

const TYPES = ['editinput', 'editoutput', 'editprocess', 'editdisplay'];
const TYPE_LABEL: Record<string, string> = {
  editinput: 'editinput — 입력 수정',
  editoutput: 'editoutput — 모델 출력 수정(저장됨)',
  editprocess: 'editprocess — 요청 직전 수정',
  editdisplay: 'editdisplay — 표시만 수정',
};

// backgroundCSS is not here (nor anywhere): RisuAI's own UI has no field for
// it, so the panel does not invent one.
const BG_LABEL: Record<string, string> = {
  backgroundHTML: '백그라운드 HTML',
};

let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let openId = '';
let items: CardScript[] = [];
let bgFields: CardField[] = [];
let filterText = '';
let ui: TabUi | null = null;

function notice(text: string, kind: NoticeKind = ''): void {
  ui?.notice(text, kind);
}

export const renderRegexTab = makeTab({
  gate: 'bot',
  keys: () => [state.epoch, state.botKey],
  search: {
    placeholder: '찾기 (이름·패턴·본문)',
    get: () => filterText,
    set: (v) => { filterText = v; drawTree(); refocusSearch(null); },
  },
  build(pane, u) {
    ui = u;
    treeMount = el('div', { class: 'tree' });
    pane.left.appendChild(treeMount);
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(viewMount);
  },
  async refresh() {
    await refreshNow();
  },
});

async function refreshNow(): Promise<void> {
  if (!treeMount) return;
  clear(treeMount);
  treeMount.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '읽는 중입니다…' }));
  try {
    items = await state.cardScripts('customscript');
    const r = await state.cardFields();
    bgFields = r.fields.filter((f) => f.field in BG_LABEL);
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    return;
  }
  drawTree();
  // The open pane follows the reloaded rows: fresh content, or gone if the
  // row is (a restore, a reset, an approved proposal).
  const freshS = items.find((x) => x.id === openId);
  const freshF = bgFields.find((x) => x.id === openId);
  if (freshS) open(freshS);
  else if (freshF) openField(freshF);
  else if (openId && viewMount) { openId = ''; clear(viewMount); }
}

function titleOf(s: CardScript): string {
  const e = s.entry as Record<string, any>;
  return String(e.comment || e.in || '').trim().slice(0, 60) || '(이름 없음)';
}

function drawTree(): void {
  if (!treeMount) return;
  clear(treeMount);

  const add = el('button', { class: 'primary tiny', text: '새 항목' });
  add.addEventListener('click', async () => {
    try {
      const id = await state.addScript('customscript',
        { comment: '새 스크립트', in: '', out: '', type: 'editdisplay' });
      await refreshNow();
      const made = items.find((s) => s.id === id);
      if (made) open(made);
    } catch (e) {
      notice('만들지 못했습니다: ' + msg(e), 'err');
    }
  });
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refreshNow());
  treeMount.appendChild(el('div', { class: 'treehead' }, [add, reloadBtn]));

  // The background pair first: it is what people usually come here for.
  if (bgFields.length) {
    treeMount.appendChild(el('div', { class: 'treescope', text: '배경' }));
    for (const f of bgFields) {
      treeMount.appendChild(listRow({
        variant: 'tree',
        selected: f.id === openId,
        title: el('button', {
          class: 'treefile' + (f.id === openId ? ' on' : ''),
          text: BG_LABEL[f.field] + (f.body ? ` (${f.body.length}자)` : ' (비어 있음)'),
          title: f.id,
        }),
        badges: f.changed ? [{ text: '수정', kind: 'warn' }] : [],
        onClick: () => openField(f),
      }));
    }
  }

  if (!items.length) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: '이 봇의 Regex 스크립트가 없습니다.',
    }));
    return;
  }

  const needle = filterText.trim().toLowerCase();
  const shown = items.map((s, i) => ({ s, i })).filter(({ s }) => {
    if (!needle) return true;
    const e = s.entry as Record<string, any>;
    return [e.comment, e.in, e.out].some((v) => String(v ?? '').toLowerCase().includes(needle));
  });
  treeMount.appendChild(el('div', {
    class: 'treescope',
    text: `스크립트 · ${needle ? `${shown.length}/${items.length}` : items.length} · 위에서 아래 순서로 적용`,
  }));

  for (const { s, i } of shown) {
    const e = s.entry as Record<string, any>;
    const move = async (to: number) => {
      try {
        await state.moveScript(s.id, to);
        await refreshNow();
      } catch (err) {
        notice('순서를 바꾸지 못했습니다: ' + msg(err), 'err');
      }
    };
    const size = String(e.out ?? '').length;
    const badges: { text: string; kind?: 'ok' | 'warn' | 'err' | '' }[] = [];
    if (s.origin !== 'original') badges.push({ text: s.origin === 'added' ? '추가' : '수정', kind: 'warn' });
    treeMount.appendChild(listRow({
      variant: 'tree',
      selected: s.id === openId,
      title: el('button', {
        class: 'treefile' + (s.id === openId ? ' on' : ''),
        text: `${i + 1}. ${titleOf(s)}`,
        title: s.id,
      }),
      hint: size > 2000 ? `${Math.round(size / 1000)}k자` : undefined,
      badges,
      reorder: {
        up: i > 0 ? () => void move(i - 1) : undefined,
        down: i < items.length - 1 ? () => void move(i + 1) : undefined,
      },
      onClick: () => open(s),
    }));
  }
}

/** backgroundHTML / backgroundCSS - card fields edited on this tab. */
function openField(f: CardField): void {
  if (!viewMount) return;
  const was = openId;
  openId = f.id;
  if (was !== f.id) drawTree();
  const body = el('textarea', {
    class: 'codearea', value: f.body, style: { minHeight: '380px' },
  }) as HTMLTextAreaElement;
  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveCardField(f.id, body.value);
      notice(savedText(BG_LABEL[f.field] + ' 을(를)'), 'ok');
      await refreshNow();
    } catch (err) {
      notice('저장하지 못했습니다: ' + msg(err), 'err');
    } finally {
      save.disabled = false;
    }
  });
  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, [el('span', { text: BG_LABEL[f.field] }), el('span', { class: 'spacer' }),
                  focusButton(body, BG_LABEL[f.field], { code: true })]),
    el('div', { class: 'hint', text: 'CSS는 보통 여기(백그라운드 HTML)의 <style> 안에 들어갑니다.' }),
    el('label', { class: 'field' }, [body]),
    f.changed ? diffCard(f.original, f.body, { code: true }) : null,
    el('div', { class: 'row' }, [save]),
  ]));
}

function open(s: CardScript): void {
  if (!viewMount) return;
  const was = openId;
  openId = s.id;
  if (was !== s.id) drawTree();

  const e = s.entry as Record<string, any>;
  const comment = el('input', { value: String(e.comment ?? '') }) as HTMLInputElement;
  const curType = String(e.type ?? 'editdisplay');
  // Selection via the option's `selected` attribute rather than assigning
  // select.value: linkedom (the smoke test's DOM) exposes value as a getter.
  const typeNames = TYPES.includes(curType) ? TYPES : [...TYPES, curType];
  const type = el('select', {}, typeNames.map((t) => {
    const o = el('option', { value: t, text: TYPE_LABEL[t] || t }) as HTMLOptionElement;
    if (t === curType) o.setAttribute('selected', '');
    return o;
  })) as HTMLSelectElement;
  const inPat = el('textarea', {
    class: 'codearea', value: String(e.in ?? ''), style: { minHeight: '60px' },
  }) as HTMLTextAreaElement;
  const outText = el('textarea', {
    class: 'codearea', value: String(e.out ?? ''), style: { minHeight: '260px' },
  }) as HTMLTextAreaElement;
  const flag = el('input', { value: String(e.flag ?? ''), placeholder: '예: g' }) as HTMLInputElement;

  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      // Whole-entry replacement: fields we do not model ride along untouched.
      await state.saveScript(s.id, {
        ...e, comment: comment.value, type: type.value,
        in: inPat.value, out: outText.value,
        ...(flag.value ? { flag: flag.value } : {}),
      });
      notice(savedText('스크립트를'), 'ok');
      await refreshNow();
    } catch (err) {
      notice('저장하지 못했습니다: ' + msg(err), 'err');
    } finally {
      save.disabled = false;
    }
  });

  const del = el('button', { class: 'ghost' });
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteScript(s.id);
      openId = '';
      if (viewMount) clear(viewMount);
      await refreshNow();
    } catch (err) {
      notice('삭제하지 못했습니다: ' + msg(err), 'err');
    }
  });

  // The lines that changed, for an edited script: `out` is where the bulk
  // of a regex script lives (a background HTML is thousands of lines), and
  // a one-line `in` change is shown as a note.
  const orig = s.origin === 'edited' && s.original ? (s.original as Record<string, any>) : null;
  const diff = orig ? diffCard(String(orig.out ?? ''), String(e.out ?? ''), { code: true }) : null;
  const small: string[] = [];
  if (orig) {
    if (String(orig.in ?? '') !== String(e.in ?? '')) small.push(`찾기: ${String(orig.in ?? '')} → ${String(e.in ?? '')}`);
    if (String(orig.type ?? '') !== String(e.type ?? '')) small.push(`종류: ${String(orig.type ?? '')} → ${String(e.type ?? '')}`);
    if (String(orig.comment ?? '') !== String(e.comment ?? '')) small.push(`이름: ${String(orig.comment ?? '')} → ${String(e.comment ?? '')}`);
  }

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', {}, [el('span', { text: 'Regex 스크립트' }), el('span', { class: 'spacer' }),
                  focusButton(outText, String(e.comment || 'Regex 스크립트') + ' — 바꾸기 (out)', { code: true })]),
    el('label', { class: 'field' }, [el('span', { text: '이름 (comment)' }), comment]),
    el('label', { class: 'field' }, [el('span', { text: '종류 (type)' }), type]),
    el('label', { class: 'field' }, [
      el('span', { text: '찾기 (in) — 정규식' }), inPat,
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: '바꾸기 (out) — background HTML도 여기에 들어갑니다' }), outText,
    ]),
    el('label', { class: 'field' }, [el('span', { text: '플래그 (flag)' }), flag]),
    small.length ? el('div', { class: 'hint diffmeta', text: '기준선과 다른 항목 — ' + small.join(' · ') }) : null,
    diff,
    el('div', { class: 'row' }, [save, del]),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
