/**
 * 트리거 - the same three modes RisuAI's own editor offers, and no more.
 *
 * RisuAI (SideBars/Scripts/TriggerList.svelte) decides the mode from
 * `triggerscript[0].effect[0].type`:
 *
 *   'triggerlua'   Lua: ONE text box bound to triggerscript[0].effect[0].code.
 *                  No event type, no list - the script registers its own
 *                  handlers. This is what nearly every modern card uses.
 *   'v2Header'     V2: a block program. RisuAI edits it with a block editor;
 *                  here it is summarised read-only.
 *   anything else  V1 (deprecated): condition/effect lists, read-only here.
 *
 * Switching modes replaces the whole list with RisuAI's own starting
 * objects, after the same confirmation RisuAI asks for. There is no per-
 * trigger "실행 시점": Lua has none, and V2 events are not edited here.
 */
import { el, clear, armed, focusButton, diffCard } from './dom';
import { state, type CardScript } from '../state';
import { makeTab, savedText, type NoticeKind, type TabUi } from './kit';
import { attachHilite } from './hilite';

type Mode = 'lua' | 'v2' | 'v1' | 'none';

let sideMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let items: CardScript[] = [];
let filter = '';
let ui: TabUi | null = null;

function notice(text: string, kind: NoticeKind = ''): void {
  ui?.notice(text, kind);
}

export const renderTriggerTab = makeTab({
  gate: 'bot',
  keys: () => [state.epoch, state.botKey],
  search: {
    placeholder: '이벤트 찾기',
    get: () => filter,
    set: (v) => { filter = v; drawView(); },
  },
  build(pane, u) {
    ui = u;
    sideMount = el('div', { class: 'tree' });
    pane.left.appendChild(sideMount);
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(viewMount);
  },
  async refresh() {
    await refreshNow();
  },
});

async function refreshNow(): Promise<void> {
  try {
    items = await state.cardScripts('triggerscript');
  } catch (e) {
    items = [];
    notice('트리거를 읽지 못했습니다: ' + msg(e), 'err');
  }
  drawSide();
  drawView();
}

function firstEffectType(): string {
  const e = items[0]?.entry as Record<string, any> | undefined;
  const first = e && Array.isArray(e.effect) ? e.effect[0] : null;
  return first && typeof first.type === 'string' ? first.type : '';
}

function modeOf(): Mode {
  if (!items.length) return 'none';
  const t = firstEffectType();
  if (t === 'triggerlua') return 'lua';
  if (t === 'v2Header') return 'v2';
  return 'v1';
}

// --- the side column: mode switch, as RisuAI draws it --------------------------

function drawSide(): void {
  if (!sideMount) return;
  clear(sideMount);
  const mode = modeOf();
  // Switching away from existing triggers asks twice, the way every other
  // destructive button here does (armed) - RisuAI asks with a dialog.
  const btn = (label: string, on: boolean, run: () => void) => {
    const b = el('button', { class: 'modebtn' + (on ? ' on' : ''), text: label }) as HTMLButtonElement;
    if (on) return b;
    if (items.length) armed(b, label, '정말 바꿀까요? (지금 트리거가 지워집니다)', run);
    else b.addEventListener('click', run);
    return b;
  };
  const row = el('div', { class: 'row', style: { padding: '6px' } });
  if (mode === 'v1') row.appendChild(btn('V1', true, () => { /* legacy: stays until switched */ }));
  row.appendChild(btn('V2', mode === 'v2', () => void switchMode('v2')));
  row.appendChild(btn('Lua', mode === 'lua', () => void switchMode('lua')));
  sideMount.appendChild(row);
  sideMount.appendChild(el('div', { class: 'hint', style: { padding: '0 8px' }, text:
    mode === 'lua' ? 'Lua 스크립트 한 개가 이 봇의 트리거입니다.'
      : mode === 'v2' ? `V2 블록 프로그램 · 이벤트 ${Math.max(0, items.length - 1)}개`
        : mode === 'v1' ? 'V1 (구형) 트리거입니다.'
          : '트리거가 없습니다. 모드를 골라 시작합니다.' }));
}

/**
 * Replace the whole list with RisuAI's starting objects for the mode - the
 * exact shapes TriggerList.svelte writes, so RisuAI reads them as its own.
 */
async function switchMode(to: 'lua' | 'v2'): Promise<void> {
  const mode = modeOf();
  if (mode === to) return;
  try {
    for (const it of items) await state.deleteScript(it.id);
    if (to === 'lua') {
      await state.addScript('triggerscript', {
        comment: '', type: 'start', conditions: [],
        effect: [{ type: 'triggerlua', code: '' }],
      });
    } else {
      await state.addScript('triggerscript', {
        comment: '', type: 'manual', conditions: [],
        effect: [{ type: 'v2Header', code: '', indent: 0 }],
      });
      await state.addScript('triggerscript', {
        comment: 'New Event', type: 'manual', conditions: [], effect: [],
      });
    }
    await refreshNow();
    notice('모드를 바꿨습니다. ' + savedText('트리거를'), 'ok');
  } catch (e) {
    notice('모드를 바꾸지 못했습니다: ' + msg(e), 'err');
  }
}

// --- the centre: one text box (Lua) or a read-only summary ----------------------

function drawView(): void {
  if (!viewMount) return;
  clear(viewMount);
  const mode = modeOf();

  if (mode === 'none') {
    viewMount.appendChild(el('div', { class: 'empty', text: '트리거가 없습니다. 왼쪽에서 V2 또는 Lua 를 고르면 RisuAI 와 같은 초기 상태로 시작합니다.' }));
    return;
  }

  if (mode === 'lua') {
    const s = items[0];
    const e = s.entry as Record<string, any>;
    const first = (Array.isArray(e.effect) ? e.effect[0] : {}) as Record<string, unknown>;
    const body = el('textarea', {
      class: 'codearea', value: String(first.code ?? ''),
      style: { minHeight: '520px' }, spellcheck: 'false',
    }) as HTMLTextAreaElement;
    setTimeout(() => attachHilite(body, { mode: 'lua' }), 0);
    const save = el('button', { class: 'primary', text: '저장' }) as HTMLButtonElement;
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        // Only the code slot moves; everything else on the item rides along.
        const effect = Array.isArray(e.effect) ? e.effect.slice() : [{}];
        effect[0] = { ...(effect[0] as Record<string, unknown>), type: 'triggerlua', code: body.value };
        await state.saveScript(s.id, { ...e, effect });
        notice(savedText('Lua 트리거를'), 'ok');
        await refreshNow();
      } catch (err) {
        notice('저장하지 못했습니다: ' + msg(err), 'err');
      } finally {
        save.disabled = false;
      }
    });
    const origFirst = s.origin === 'edited' && s.original && Array.isArray((s.original as Record<string, any>).effect)
      ? ((s.original as Record<string, any>).effect[0] as Record<string, unknown> | undefined)
      : undefined;
    const diff = origFirst ? diffCard(String(origFirst.code ?? ''), String(first.code ?? ''), { code: true }) : null;
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        el('span', { text: 'Lua' + (s.origin !== 'original' ? ' · 수정됨' : '') }),
        el('span', { class: 'spacer' }),
        focusButton(body, 'Lua 트리거', { code: true, hilite: { mode: 'lua' } }),
      ]),
      body,
      diff,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [save]),
      el('div', { class: 'hint', style: { marginTop: '6px' }, text:
        'RisuAI 의 트리거 편집기와 같은 Lua 스크립트 한 개입니다. 이벤트 등록은 스크립트 안에서 합니다 (listenEdit, onStart 등).' }),
    ]));
    return;
  }

  // V2 / V1: summarise, do not invent a JSON editor.
  const q = filter.trim().toLowerCase();
  const rows = items.filter((s, i) => !(mode === 'v2' && i === 0))
    .filter((s) => !q || String((s.entry as Record<string, any>).comment || '').toLowerCase().includes(q))
    .map((s) => {
    const e = s.entry as Record<string, any>;
    const n = Array.isArray(e.effect) ? e.effect.length : 0;
    const c = Array.isArray(e.conditions) ? e.conditions.length : 0;
    const del = el('button', { class: 'ghost tiny' });
    armed(del, '삭제', '정말?', async () => {
      try { await state.deleteScript(s.id); await refreshNow(); } catch (err) { notice(msg(err), 'err'); }
    });
    return el('div', { class: 'verrow' }, [
      el('div', { class: 'grow' }, [
        el('div', { text: String(e.comment || '(이름 없음)') }),
        el('div', { class: 'hint', text: `${String(e.type || 'manual')} · 조건 ${c} · 효과 ${n}` + (s.origin !== 'original' ? ` · ${s.origin}` : '') }),
      ]),
      del,
    ]);
  });
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: mode === 'v2' ? '트리거 V2 (블록)' : '트리거 V1 (구형)' }),
    el('div', { class: 'notice', text: mode === 'v2'
      ? '블록 프로그램은 RisuAI 의 트리거 편집기에서 편집합니다. 여기서는 이벤트 목록을 보고 지울 수만 있습니다. 에이전트는 run_python 으로 card_scripts 의 entry_json 을 읽어 분석할 수 있습니다.'
      : 'V1 트리거는 RisuAI 에서도 더 이상 권장하지 않습니다. V2 나 Lua 로 바꾸는 것을 권합니다.' }),
    ...(rows.length ? rows : [el('div', { class: 'hint', text: '이벤트가 없습니다.' })]),
  ]));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
