/**
 * The tab row's ＋ (§1-95, reworked §1-97): RisuAI modules to open next to the
 * bot, the persona, or on their own (모듈 편집).
 *
 * One click opens: a row's 열기 (or the row itself) opens the module at once
 * and shows it on the card tabs, and the popover stays so several can be
 * opened in a row. An open module says so (✓ 패널에 열림) and offers 편집 /
 * 닫기. The first version made the user tick boxes and press a confirm button,
 * and its "연결됨" badge read as "already opened" - so the two states are now
 * worded apart: "RisuAI: 이 봇에 켜짐" is what RisuAI turns on for this bot or
 * chat, "✓ 패널에 열림" is what the panel has open. The set is remembered for
 * the bot / persona and reopened next time (state.setOpenModules).
 *
 * A module file (.risum, the legacy format; .charx, the recommended one; or a
 * risuModule .json) can be added from the PC: it is uploaded into the project
 * folder, read by the backend and appended to RisuAI's module list.
 */
import { el, clear, popover } from './dom';
import { state, type LiveModule } from '../state';
import { shellNotice } from './chatbar';
import { MODULE_CACHE_NOTE } from '../modules';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** What a module holds, in one short line. */
export function moduleLine(m: { lore: number; regex: number; trigger: number; assets: number; toggles: boolean }): string {
  const bits: string[] = [];
  if (m.lore) bits.push(`로어북 ${m.lore}`);
  if (m.regex) bits.push(`Regex ${m.regex}`);
  if (m.trigger) bits.push(`트리거 ${m.trigger}`);
  if (m.assets) bits.push(`에셋 ${m.assets}`);
  if (m.toggles) bits.push('토글');
  return bits.join(' · ') || '비어 있음';
}

/** RisuAI's own on-state of a module, worded so it cannot read as "opened here". */
export function riskBadges(m: LiveModule): (HTMLElement | null)[] {
  return [
    m.linked ? el('span', { class: 'badge', text: 'RisuAI: 이 봇에 켜짐', title: 'RisuAI에서 이 봇이나 챗에 켜 둔 모듈입니다 (Hina 패널에 열렸다는 뜻은 아닙니다)' }) : null,
    m.global ? el('span', { class: 'badge', text: 'RisuAI: 전역', title: 'RisuAI에서 모든 챗에 켜 둔 모듈입니다' }) : null,
    m.lowLevelAccess ? el('span', { class: 'badge', text: '저수준' }) : null,
  ];
}

/** Whom the set belongs to, in the popover's words. */
function ownerWord(): string {
  if (state.editMode === 'persona') return '이 페르소나';
  if (state.editMode === 'module') return '모듈 편집';
  return '이 봇';
}

export function openModulePicker(anchor: HTMLElement): void {
  const body = el('div', { class: 'modpicker' });
  const close = popover(anchor, body);
  // The list scrolls inside; the popover itself may be taller than its default.
  const pop = body.parentElement as HTMLElement | null;
  if (pop) pop.style.maxHeight = '82vh';
  let needle = '';
  let busy = '';

  const head = el('div', { class: 'row', style: { marginBottom: '6px', gap: '6px' } });
  const search = el('input', { class: 'searchinput', placeholder: '모듈 찾기' }) as HTMLInputElement;
  const reread = el('button', { class: 'ghost tiny', text: '다시 읽기', title: 'RisuAI에서 모듈 목록을 다시 읽어 옵니다' }) as HTMLButtonElement;
  const fileIn = el('input', { type: 'file', accept: '.risum,.charx,.json', style: { display: 'none' } }) as HTMLInputElement;
  const fromFile = el('button', { class: 'ghost tiny', text: '파일에서 가져오기…', title: '.risum · .charx · 모듈 .json 을 RisuAI 모듈 목록에 추가하고 엽니다' }) as HTMLButtonElement;
  head.append(el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '모듈 열기' }), fromFile, fileIn, reread);
  const actions = el('div', { class: 'row', style: { marginBottom: '6px', gap: '6px', flexWrap: 'wrap' } });
  const note = el('div');
  const list = el('div', { class: 'chatlist modlist' });
  body.append(head, el('div', { class: 'row', style: { marginBottom: '6px' } }, [search]), actions, note, list,
    el('div', { class: 'hint', style: { marginTop: '6px' }, text:
      `열기를 누르면 바로 탭 줄에 열리고, 연 모듈은 ${ownerWord()}에 기억되어 다음에도 함께 열립니다. `
      + '“RisuAI: 이 봇에 켜짐”은 RisuAI 쪽 설정이고, 편집하려면 여기서 열어야 합니다. ' + MODULE_CACHE_NOTE }));

  const say = (text: string, kind: '' | 'err' = '') => {
    clear(note);
    if (text) note.appendChild(el('div', { class: kind === 'err' ? 'notice err' : 'hint', text }));
  };

  const open = async (ids: string[], focus: string): Promise<void> => {
    const keep = state.openModules.map((m) => m.id);
    busy = ids.join(',');
    draw();
    try {
      await state.setOpenModules([...keep, ...ids.filter((i) => !keep.includes(i))]);
      const row = state.openModules.find((m) => m.id === focus);
      if (row) onFocus(row.key);
      say(ids.length > 1 ? `모듈 ${ids.length}개를 열었습니다.` : `'${row?.name ?? ''}' 을(를) 열었습니다. 탭 줄에서 편집합니다.`);
    } catch (e) {
      say('열지 못했습니다: ' + msg(e), 'err');
    } finally {
      busy = '';
      if (body.isConnected) draw();
    }
  };

  const row = (m: LiveModule): HTMLElement => {
    const opened = state.openModules.find((x) => x.id === m.id);
    const right: HTMLElement[] = [];
    if (m.mcp) {
      right.push(el('span', { class: 'hint modstate', text: '편집할 내용 없음' }));
    } else if (busy.split(',').includes(m.id)) {
      right.push(el('span', { class: 'hint modstate', text: '여는 중…' }));
    } else if (opened) {
      const edit = el('button', { class: 'ghost tiny', text: '편집' }) as HTMLButtonElement;
      edit.addEventListener('click', (ev) => { ev.stopPropagation(); onFocus(opened.key); close(); });
      const shut = el('button', { class: 'ghost tiny', text: '닫기', title: '패널에서 닫습니다 (작업본과 미반영 변경은 남습니다)' }) as HTMLButtonElement;
      shut.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await state.closeModule(opened.key);
        if (body.isConnected) draw();
      });
      right.push(el('span', { class: 'badge ok modstate', text: '✓ 패널에 열림' }), edit, shut);
    } else {
      const go = el('button', { class: 'primary tiny', text: '열기' }) as HTMLButtonElement;
      go.addEventListener('click', (ev) => { ev.stopPropagation(); void open([m.id], m.id); });
      right.push(go);
    }
    const item = el('div', { class: 'chatitem modrow' + (m.mcp ? ' dim' : '') + (opened ? ' current' : '') }, [
      el('span', { class: 'grow' }, [
        el('div', { text: '◫ ' + (m.name || '(이름 없음)') }),
        el('div', { class: 'hint clip1', text: m.mcp ? 'MCP 모듈' : moduleLine(m) + (m.description ? ' — ' + m.description.split('\n')[0].slice(0, 60) : '') }),
      ]),
      ...riskBadges(m),
      opened?.total ? el('span', { class: 'badge warn', text: `미반영 ${opened.total}` }) : null,
      ...right,
    ]);
    if (!m.mcp) {
      item.addEventListener('click', () => {
        if (busy) return;
        if (opened) { onFocus(opened.key); close(); } else void open([m.id], m.id);
      });
    }
    return item;
  };

  const draw = () => {
    clear(list);
    clear(actions);
    if (state.moduleError) say(state.moduleError, 'err');
    const all = state.liveModules;
    if (!all) {
      list.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'spin' }), el('span', { class: 'hint', text: 'RisuAI에서 모듈을 읽는 중…' })]));
      return;
    }
    const q = needle.trim().toLowerCase();
    const shown = all.filter((m) => !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
    // Open first, then what RisuAI turns on for this bot, then the rest.
    const rank = (m: LiveModule) => (state.openModules.some((x) => x.id === m.id) ? 0 : m.linked ? 1 : 2);
    shown.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    if (!all.length) list.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: 'RisuAI에 모듈이 없습니다. 파일에서 가져올 수 있습니다.' }));
    for (const m of shown) list.appendChild(row(m));
    const pending = all.filter((m) => m.linked && !m.mcp && !state.openModules.some((x) => x.id === m.id));
    if (pending.length && state.editMode === 'bot') {
      const b = el('button', { class: 'ghost tiny', text: `RisuAI에서 켜진 모듈 모두 열기 (${pending.length})` }) as HTMLButtonElement;
      b.disabled = !!busy;
      b.addEventListener('click', () => { void open(pending.map((m) => m.id), pending[0].id); });
      actions.appendChild(b);
    }
  };

  search.addEventListener('input', () => { needle = search.value; draw(); });
  reread.addEventListener('click', () => {
    reread.disabled = true;
    void state.loadModules().catch(() => undefined).finally(() => { reread.disabled = false; if (body.isConnected) draw(); });
  });
  fromFile.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    fromFile.disabled = true;
    try {
      say(`${f.name} 올리는 중…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const up = await state.uploadFile(f.name, btoa(bin), true);
      state.touchFiles([up.path]);
      const made = await state.importModuleFile(up.path, (t) => say(t));
      close();
      onFocus(made.key);
      shellNotice(`'${made.name}' 모듈을 RisuAI에 추가하고 열었습니다 (원본 파일: ${up.path}).`, 'ok');
    } catch (e) {
      say('가져오지 못했습니다: ' + msg(e), 'err');
    } finally {
      fromFile.disabled = false;
    }
  });

  draw();
  if (!state.moduleLoading) {
    void state.loadModules().catch(() => undefined).finally(() => { if (body.isConnected) draw(); });
  }
  setTimeout(() => { try { search.focus(); } catch { /* fine */ } }, 0);
}

/** Set by the shell: focus a module on its card tabs. */
let onFocus: (key: string) => void = (key) => state.focusModule(key);
export function setModuleFocusHandler(fn: (key: string) => void): void {
  onFocus = fn;
}
