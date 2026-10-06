/**
 * The tab row's ＋ (§1-95): which RisuAI modules to open next to the bot, the
 * persona, or on their own (모듈 편집).
 *
 * Several at once - a bot is usually played with an asset module, a prompt
 * module and a status-window module together - and the set is remembered for
 * that bot / persona and reopened next time (state.setOpenModules). Modules
 * RisuAI already turns on for this bot or chat are marked, and one button
 * selects them all; MCP modules have nothing to edit and are not offered.
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

/** Whom the set belongs to, in the popover's words. */
function ownerWord(): string {
  if (state.editMode === 'persona') return '이 페르소나';
  if (state.editMode === 'module') return '모듈 편집';
  return '이 봇';
}

export function openModulePicker(anchor: HTMLElement): void {
  const body = el('div', { class: 'applypop modpicker' });
  const close = popover(anchor, body);
  const chosen: string[] = state.openModules.map((m) => m.id);
  const rowsBefore = [...chosen];
  let needle = '';

  const head = el('div', { class: 'row', style: { marginBottom: '6px', gap: '6px' } });
  const search = el('input', { class: 'searchinput', placeholder: '모듈 찾기' }) as HTMLInputElement;
  const reread = el('button', { class: 'ghost tiny', text: '다시 읽기', title: 'RisuAI에서 모듈 목록을 다시 읽어 옵니다' }) as HTMLButtonElement;
  head.append(el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '모듈 열기' }), reread);
  const note = el('div');
  const list = el('div', { class: 'chatlist modlist' });
  const foot = el('div', { class: 'row', style: { marginTop: '8px', gap: '6px', flexWrap: 'wrap' } });
  const apply = el('button', { class: 'primary tiny' }) as HTMLButtonElement;
  const linkedAll = el('button', { class: 'ghost tiny', text: '연결된 모듈 모두 선택', title: 'RisuAI에서 이 봇·챗에 켜 둔 모듈을 모두 고릅니다' }) as HTMLButtonElement;
  const fileIn = el('input', { type: 'file', accept: '.risum,.charx,.json', style: { display: 'none' } }) as HTMLInputElement;
  const fromFile = el('button', { class: 'ghost tiny', text: '파일에서 가져오기…', title: '.risum · .charx · 모듈 .json 을 RisuAI 모듈 목록에 추가하고 엽니다' }) as HTMLButtonElement;
  foot.append(apply, linkedAll, fromFile, fileIn);
  body.append(head, el('div', { class: 'row', style: { marginBottom: '6px' } }, [search]), note, list, foot,
    el('div', { class: 'hint', style: { marginTop: '6px' }, text:
      `고른 조합은 ${ownerWord()}에 기억되어 다음에 열 때 함께 열립니다. 모듈은 봇 카드와 같은 탭(정보·로어북·Regex·트리거·에셋)으로 편집하고, `
      + '반영하면 RisuAI 모듈 목록의 그 모듈이 바뀝니다. ' + MODULE_CACHE_NOTE }));

  const paintApply = () => {
    const before = state.openModules.map((m) => m.id).join(',');
    apply.textContent = chosen.length ? `열기 (${chosen.length})` : '모두 닫기';
    apply.disabled = chosen.join(',') === before;
  };

  const row = (m: LiveModule): HTMLElement => {
    const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = chosen.includes(m.id);
    box.disabled = m.mcp;
    const open = state.openModules.find((x) => x.id === m.id);
    const item = el('label', { class: 'chatitem modrow' + (m.mcp ? ' dim' : '') }, [
      box,
      el('span', { class: 'grow' }, [
        el('div', { text: m.name || '(이름 없음)' }),
        el('div', { class: 'hint clip1', text: m.mcp ? 'MCP 모듈 - 편집할 내용이 없습니다' : moduleLine(m) + (m.description ? ' — ' + m.description.split('\n')[0].slice(0, 60) : '') }),
      ]),
      m.linked ? el('span', { class: 'badge', text: '연결됨', title: 'RisuAI에서 이 봇이나 챗에 켜 둔 모듈입니다' }) : null,
      m.global ? el('span', { class: 'badge', text: '전역', title: 'RisuAI에서 모든 챗에 켜 둔 모듈입니다' }) : null,
      m.lowLevelAccess ? el('span', { class: 'badge', text: '저수준' }) : null,
      open?.total ? el('span', { class: 'badge warn', text: `미반영 ${open.total}` }) : null,
    ]);
    box.addEventListener('change', () => {
      const i = chosen.indexOf(m.id);
      if (box.checked && i < 0) chosen.push(m.id);
      if (!box.checked && i >= 0) chosen.splice(i, 1);
      paintApply();
    });
    return item;
  };

  const draw = () => {
    clear(list);
    clear(note);
    if (state.moduleError) note.appendChild(el('div', { class: 'notice err', text: state.moduleError }));
    const all = state.liveModules;
    if (!all) {
      list.appendChild(el('div', { class: 'chatitem' }, [el('span', { class: 'spin' }), el('span', { class: 'hint', text: 'RisuAI에서 모듈을 읽는 중…' })]));
      return;
    }
    const q = needle.trim().toLowerCase();
    const shown = all.filter((m) => !q || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
    // Linked first: they are what this bot is played with.
    shown.sort((a, b) => Number(b.linked) - Number(a.linked) || a.name.localeCompare(b.name));
    if (!all.length) list.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: 'RisuAI에 모듈이 없습니다. 파일에서 가져올 수 있습니다.' }));
    for (const m of shown) list.appendChild(row(m));
    const linked = all.filter((m) => m.linked && !m.mcp);
    linkedAll.style.display = linked.length && state.editMode === 'bot' ? '' : 'none';
    paintApply();
  };

  search.addEventListener('input', () => { needle = search.value; draw(); });
  reread.addEventListener('click', () => {
    reread.disabled = true;
    void state.loadModules().catch(() => undefined).finally(() => { reread.disabled = false; if (body.isConnected) draw(); });
  });
  linkedAll.addEventListener('click', () => {
    for (const m of state.liveModules ?? []) if (m.linked && !m.mcp && !chosen.includes(m.id)) chosen.push(m.id);
    draw();
  });
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    apply.textContent = '여는 중…';
    try {
      const rows = await state.setOpenModules(chosen);
      close();
      if (rows.length) {
        // Open the first new module straight away; the rest wait on the tab row.
        const fresh = rows.find((r) => r.key !== state.cardTarget && !rowsBefore.includes(r.id));
        if (fresh) onFocus(fresh.key);
        shellNotice(`모듈 ${rows.length}개를 열었습니다. 탭 줄의 모듈 이름을 누르면 그 모듈을 편집합니다.`, 'ok');
      }
    } catch (e) {
      shellNotice('모듈을 열지 못했습니다: ' + msg(e), 'err');
      paintApply();
    }
  });
  fromFile.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    fromFile.disabled = true;
    const say = (t: string) => { clear(note); note.appendChild(el('div', { class: 'hint', text: t })); };
    try {
      say(`${f.name} 올리는 중…`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const up = await state.uploadFile(f.name, btoa(bin), true);
      state.touchFiles([up.path]);
      const row = await state.importModuleFile(up.path, say);
      close();
      onFocus(row.key);
      shellNotice(`'${row.name}' 모듈을 RisuAI에 추가하고 열었습니다 (원본 파일: ${up.path}).`, 'ok');
    } catch (e) {
      clear(note);
      note.appendChild(el('div', { class: 'notice err', text: '가져오지 못했습니다: ' + msg(e) }));
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
