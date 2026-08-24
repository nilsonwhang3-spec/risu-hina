/**
 * Trigger scripts (triggerscript) - code-first editing.
 *
 * The triggers people actually write are code: `effect[0] = {type:
 * 'triggerlua'|'triggercode', code}` (triggers.ts:66-69, and the dispatcher
 * checks exactly effect[0], :1213). So the editor shows the code as code -
 * real newlines, monospace - and writes it back into effect[0].code with
 * everything else on the item preserved. Never JSON at the user.
 *
 * V1 condition/effect lists and V2 block programs have no code to show; they
 * are summarised read-only and edited in RisuAI's own block editor.
 */
import { el, clear, armed, searchBox, refocusSearch } from './dom';
import { state, type CardScript } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

const EVENTS = ['start', 'manual', 'output', 'input', 'display', 'request'];
const EVENT_LABEL: Record<string, string> = {
  start: 'start — 채팅 시작 시',
  manual: 'manual — 수동 실행',
  output: 'output — 모델 출력 후',
  input: 'input — 입력 전송 시',
  display: 'display — 표시 시',
  request: 'request — 요청 직전',
};

/** The code slot, when this trigger is a code trigger. */
function codeOf(s: CardScript): { kind: string; code: string } | null {
  const e = s.entry as Record<string, any>;
  const first = Array.isArray(e.effect) ? e.effect[0] : null;
  if (first && (first.type === 'triggerlua' || first.type === 'triggercode')) {
    return { kind: first.type, code: String(first.code ?? '') };
  }
  return null;
}

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let openId = '';
let items: CardScript[] = [];
let seenEpoch = -1;
let seenKey = '';
let filterText = '';

export function renderTriggerTab(mount: HTMLElement): void {
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
    items = await state.cardScripts('triggerscript');
    drawTree();
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

function titleOf(s: CardScript): string {
  const e = s.entry as Record<string, any>;
  return String(e.comment || '').trim().slice(0, 60) || '(이름 없음)';
}

function shapeOf(s: CardScript): string {
  const code = codeOf(s);
  if (code) return code.kind === 'triggerlua' ? 'Lua' : 'triggercode';
  const effects = (s.entry as Record<string, any>).effect;
  return Array.isArray(effects) && effects.length ? '블록형' : '빈 트리거';
}

function drawTree(): void {
  if (!treeMount) return;
  clear(treeMount);

  const add = el('button', { class: 'primary tiny', text: '새 Lua 트리거' });
  add.addEventListener('click', async () => {
    try {
      const id = await state.addScript('triggerscript', {
        comment: '새 트리거', type: 'manual', conditions: [],
        effect: [{ type: 'triggerlua', code: '' }],
      });
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

  if (!items.length) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: '이 봇의 트리거 스크립트가 없습니다.',
    }));
    return;
  }

  treeMount.appendChild(searchBox(filterText, (v) => {
    filterText = v;
    drawTree();
    refocusSearch(treeMount);
  }, '찾기 (이름·코드)'));
  const needle = filterText.trim().toLowerCase();
  const shown = items.filter((s) => {
    if (!needle) return true;
    const e = s.entry as Record<string, any>;
    return [e.comment, codeOf(s)?.code].some((v) => String(v ?? '').toLowerCase().includes(needle));
  });
  treeMount.appendChild(el('div', {
    class: 'treescope',
    text: `이 봇 · ${needle ? `${shown.length}/${items.length}` : items.length}`,
  }));

  for (const s of shown) {
    const e = s.entry as Record<string, any>;
    const name = el('button', {
      class: 'treefile' + (s.id === openId ? ' on' : ''),
      text: titleOf(s),
      title: s.id,
    });
    name.addEventListener('click', () => open(s));
    const row = el('div', { class: 'treerow' }, [name]);
    row.appendChild(el('span', { class: 'hint', text: `${String(e.type || '')} · ${shapeOf(s)}` }));
    if (s.origin !== 'original') {
      row.appendChild(el('span', { class: 'badge warn', text: s.origin === 'added' ? '추가' : '수정' }));
    }
    treeMount.appendChild(row);
  }
}

function open(s: CardScript): void {
  if (!viewMount) return;
  openId = s.id;
  for (const b of Array.from(document.querySelectorAll('.tree .treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title === s.id);
  }

  const e = s.entry as Record<string, any>;
  const code = codeOf(s);

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

  if (!code) {
    // Block programs have no code to show; anything else would be JSON at the
    // user, which is exactly what this editor exists to avoid.
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: `트리거 — ${titleOf(s)} (${shapeOf(s)})` }),
      el('div', {
        class: 'notice',
        text: '블록형 트리거입니다. 블록 편집은 RisuAI의 트리거 편집기에서 해 주세요. '
          + '여기서는 삭제만 할 수 있습니다.',
      }),
      el('div', { class: 'row' }, [del]),
    ]));
    return;
  }

  const comment = el('input', { value: String(e.comment ?? '') }) as HTMLInputElement;
  const curEvent = String(e.type ?? 'manual');
  const eventNames = EVENTS.includes(curEvent) ? EVENTS : [...EVENTS, curEvent];
  const eventSel = el('select', {}, eventNames.map((t) => {
    const o = el('option', { value: t, text: EVENT_LABEL[t] || t });
    if (t === curEvent) o.setAttribute('selected', '');
    return o;
  })) as HTMLSelectElement;
  const body = el('textarea', {
    class: 'codearea',
    value: code.code,
    style: { minHeight: '420px' },
    spellcheck: 'false',
  }) as HTMLTextAreaElement;

  const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      // Only comment, event type and the code slot move; conditions,
      // lowLevelAccess and any field we never modelled ride along untouched.
      const effect = Array.isArray(e.effect) ? e.effect.slice() : [{}];
      effect[0] = { ...(effect[0] as Record<string, unknown>), type: code.kind, code: body.value };
      await state.saveScript(s.id, { ...e, comment: comment.value, type: eventSel.value, effect });
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

  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: `트리거 — ${titleOf(s)} (${code.kind === 'triggerlua' ? 'Lua' : 'triggercode'})` }),
    el('label', { class: 'field' }, [el('span', { text: '이름 (comment)' }), comment]),
    el('label', { class: 'field' }, [el('span', { text: '실행 시점 (type)' }), eventSel]),
    el('label', { class: 'field' }, [el('span', { text: '코드' }), body]),
    el('div', { class: 'row' }, [save, del]),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
