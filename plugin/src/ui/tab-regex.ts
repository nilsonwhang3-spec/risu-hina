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
import { el, clear, armed, searchBox, refocusSearch } from './dom';
import { state, type CardScript, type CardField } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

const TYPES = ['editinput', 'editoutput', 'editprocess', 'editdisplay'];
const TYPE_LABEL: Record<string, string> = {
  editinput: 'editinput — 입력 수정',
  editoutput: 'editoutput — 모델 출력 수정(저장됨)',
  editprocess: 'editprocess — 요청 직전 수정',
  editdisplay: 'editdisplay — 표시만 수정',
};

const BG_LABEL: Record<string, string> = {
  backgroundHTML: '백그라운드 HTML',
  backgroundCSS: '백그라운드 CSS',
};

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let openId = '';
let items: CardScript[] = [];
let bgFields: CardField[] = [];
let seenEpoch = -1;
let seenKey = '';
let filterText = '';

export function renderRegexTab(mount: HTMLElement): void {
  if (!state.botKey) {
    clear(mount);
    built = false;
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 패널을 연 봇이 있어야 합니다.' }),
    ]));
    return;
  }
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree' });
    pane.left.appendChild(treeMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(viewMount);
    mount.appendChild(pane.root);
    built = true;
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    void refresh();
  } else if (seenEpoch !== state.epoch || seenKey !== state.botKey) {
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    openId = '';
    if (viewMount) clear(viewMount);
    void refresh();
  }
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

async function refresh(): Promise<void> {
  if (!treeMount) return;
  clear(treeMount);
  treeMount.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '읽는 중입니다…' }));
  try {
    items = await state.cardScripts('customscript');
    const r = await state.cardFields();
    bgFields = r.fields.filter((f) => f.field in BG_LABEL);
    drawTree();
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
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
      await refresh();
      const made = items.find((s) => s.id === id);
      if (made) open(made);
    } catch (e) {
      notice('만들지 못했습니다: ' + msg(e), 'err');
    }
  });
  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  treeMount.appendChild(el('div', { class: 'treehead' }, [add, reloadBtn]));

  // The background pair first: it is what people usually come here for.
  if (bgFields.length) {
    treeMount.appendChild(el('div', { class: 'treescope', text: '배경' }));
    for (const f of bgFields) {
      const name = el('button', {
        class: 'treefile' + (f.id === openId ? ' on' : ''),
        text: BG_LABEL[f.field] + (f.body ? ` (${f.body.length}자)` : ' (비어 있음)'),
        title: f.id,
      });
      name.addEventListener('click', () => openField(f));
      const row = el('div', { class: 'treerow lorecard' }, [name]);
      if (f.changed) row.appendChild(el('span', { class: 'badge warn', text: '수정' }));
      treeMount.appendChild(row);
    }
  }

  if (!items.length) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: '이 봇의 Regex 스크립트가 없습니다.',
    }));
    return;
  }

  treeMount.appendChild(searchBox(filterText, (v) => {
    filterText = v;
    drawTree();
    refocusSearch(treeMount);
  }, '찾기 (이름·패턴·본문)'));
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
    const name = el('button', {
      class: 'treefile' + (s.id === openId ? ' on' : ''),
      text: `${i + 1}. ${titleOf(s)}`,
      title: s.id,
    });
    name.addEventListener('click', () => open(s));

    const move = async (to: number) => {
      try {
        await state.moveScript(s.id, to);
        await refresh();
      } catch (err) {
        notice('순서를 바꾸지 못했습니다: ' + msg(err), 'err');
      }
    };
    const up = el('button', { class: 'ghost tiny movebtn', text: '↑', title: '위로' }) as HTMLButtonElement;
    const down = el('button', { class: 'ghost tiny movebtn', text: '↓', title: '아래로' }) as HTMLButtonElement;
    up.disabled = i <= 0;
    down.disabled = i >= items.length - 1;
    up.addEventListener('click', () => void move(i - 1));
    down.addEventListener('click', () => void move(i + 1));

    const row = el('div', { class: 'treerow lorecard' }, [name]);
    const size = String(e.out ?? '').length;
    if (size > 2000) row.appendChild(el('span', { class: 'hint', text: `${Math.round(size / 1000)}k자` }));
    if (s.origin !== 'original') {
      row.appendChild(el('span', { class: 'badge warn', text: s.origin === 'added' ? '추가' : '수정' }));
    }
    row.appendChild(up);
    row.appendChild(down);
    treeMount.appendChild(row);
  }
}

/** backgroundHTML / backgroundCSS - card fields edited on this tab. */
function openField(f: CardField): void {
  if (!viewMount) return;
  openId = f.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === f.id);
  }
  const body = el('textarea', {
    class: 'codearea', value: f.body, style: { minHeight: '380px' },
  }) as HTMLTextAreaElement;
  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveCardField(f.id, body.value);
      notice('저장했습니다. 봇 바의 “반영”을 누르면 RisuAI에 쓰입니다.', 'ok');
      await refresh();
      const fresh = bgFields.find((x) => x.id === f.id);
      if (fresh) openField(fresh);
    } catch (err) {
      notice('저장하지 못했습니다: ' + msg(err), 'err');
    } finally {
      save.disabled = false;
    }
  });
  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: BG_LABEL[f.field] }),
    el('div', { class: 'hint', text: 'CSS는 보통 여기(백그라운드 HTML)의 <style> 안에 들어갑니다.' }),
    el('label', { class: 'field' }, [body]),
    el('div', { class: 'row' }, [save]),
  ]));
}

function open(s: CardScript): void {
  if (!viewMount) return;
  openId = s.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === s.id);
  }

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
      notice('저장했습니다. 봇 바의 “반영”을 누르면 RisuAI에 쓰입니다.', 'ok');
      await refresh();
      const fresh = items.find((x) => x.id === s.id);
      if (fresh) open(fresh);
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
      await refresh();
    } catch (err) {
      notice('삭제하지 못했습니다: ' + msg(err), 'err');
    }
  });

  clear(viewMount);
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: 'Regex 스크립트' }),
    el('label', { class: 'field' }, [el('span', { text: '이름 (comment)' }), comment]),
    el('label', { class: 'field' }, [el('span', { text: '종류 (type)' }), type]),
    el('label', { class: 'field' }, [
      el('span', { text: '찾기 (in) — 정규식' }), inPat,
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: '바꾸기 (out) — background HTML도 여기에 들어갑니다' }), outText,
    ]),
    el('label', { class: 'field' }, [el('span', { text: '플래그 (flag)' }), flag]),
    el('div', { class: 'row' }, [save, del]),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
