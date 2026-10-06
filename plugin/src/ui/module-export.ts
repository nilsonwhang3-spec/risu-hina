/**
 * Save RisuAI modules as files in the workspace (§1-96): `.charx` (the format
 * RisuAI now recommends - an asset module usually ships as "○○ 에셋봇.charx")
 * or `.risum` (the legacy one, still common for item / prompt modules).
 *
 * Used beside the bot's charx (the modules opened with the bot and those
 * RisuAI links to it), on the persona bar (the persona's modules) and in
 * 모듈 편집. Each file lands in that module's project folder, out/. An open
 * module is saved as its working copy (unapplied edits included); a module
 * only linked to the bot is read from RisuAI first.
 */
import { el, clear, popover } from './dom';
import { state } from '../state';
import { shellNotice } from './chatbar';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Fmt = 'charx' | 'risum';

/** One row per module: name, badges, .charx / .risum. Plus "모두 .charx". */
export function moduleSaveRows(box: HTMLElement, mods: { id: string; name: string; open: boolean; linked: boolean }[]): void {
  clear(box);
  if (!mods.length) {
    box.appendChild(el('div', { class: 'hint', text: '함께 열거나 연결된 모듈이 없습니다. 탭 줄의 ＋ 로 모듈을 열 수 있습니다.' }));
    return;
  }
  const runners: ((fmt: Fmt) => Promise<boolean>)[] = [];
  for (const m of mods) {
    const status = el('div', { class: 'hint' });
    const charx = el('button', { class: 'ghost tiny', text: '.charx' }) as HTMLButtonElement;
    const risum = el('button', { class: 'ghost tiny', text: '.risum' }) as HTMLButtonElement;
    const run = async (fmt: Fmt, allowMissing = false): Promise<boolean> => {
      charx.disabled = risum.disabled = true;
      clear(status);
      status.textContent = '저장 중…';
      try {
        const r = await state.exportModuleById(m.id, fmt, allowMissing);
        status.textContent = `✔ ${r.path} · 에셋 ${r.assets}개` + (r.dropped ? ` (${r.dropped}개 제외)` : '');
        return true;
      } catch (e) {
        const missing = (e as { body?: { missing?: { name: string }[] } }).body?.missing;
        clear(status);
        if (Array.isArray(missing) && missing.length) {
          status.appendChild(el('span', { text: `에셋 ${missing.length}개가 스토어에 없습니다. ` }));
          const anyway = el('button', { class: 'ghost tiny', text: '빼고 저장' }) as HTMLButtonElement;
          anyway.addEventListener('click', () => { void run(fmt, true); });
          status.appendChild(anyway);
        } else {
          status.textContent = '저장하지 못했습니다: ' + msg(e);
        }
        return false;
      } finally {
        charx.disabled = risum.disabled = false;
      }
    };
    charx.addEventListener('click', () => { void run('charx'); });
    risum.addEventListener('click', () => { void run('risum'); });
    runners.push((fmt) => run(fmt));
    box.appendChild(el('div', { class: 'stagedrow' }, [
      el('div', { class: 'grow' }, [
        el('div', { text: '◫ ' + (m.name || '(이름 없음)') }),
        status,
      ]),
      m.open ? el('span', { class: 'badge', text: '열림', title: '작업본(반영 전 편집 포함)으로 저장합니다' }) : null,
      m.linked ? el('span', { class: 'badge', text: '연결됨', title: 'RisuAI에서 이 봇·챗에 켜 둔 모듈' }) : null,
      charx, risum,
    ]));
  }
  if (mods.length > 1) {
    const all = el('button', { class: 'ghost tiny', text: `모두 .charx 로 저장 (${mods.length})` }) as HTMLButtonElement;
    all.addEventListener('click', async () => {
      all.disabled = true;
      let ok = 0;
      for (const r of runners) if (await r('charx')) ok += 1;
      shellNotice(`모듈 ${ok}/${runners.length}개를 .charx 로 저장했습니다 — 워크스페이스 파일 탭의 각 모듈 폴더 out/ 에 있습니다.`, ok === runners.length ? 'ok' : 'err');
      all.disabled = false;
    });
    box.appendChild(el('div', { class: 'row', style: { marginTop: '6px' } }, [all]));
  }
}

/** A popover with the screen's modules (bot: open + linked; persona/module: open). */
export function openModuleSave(anchor: HTMLElement): void {
  const body = el('div', { class: 'applypop' });
  popover(anchor, body);
  body.appendChild(el('div', { class: 'sectiontitle', text: '모듈을 파일로 저장' }));
  body.appendChild(el('div', { class: 'hint', text:
    '각 모듈 프로젝트 폴더의 out/ 에 저장합니다. .charx 는 RisuAI 권장 형식, .risum 은 예전 형식입니다. 열린 모듈은 반영 전 편집도 들어갑니다.' }));
  const box = el('div', { style: { marginTop: '6px' } }, [el('div', { class: 'hint', text: '모듈을 읽는 중…' })]);
  body.appendChild(box);
  void state.ownerModules().then((mods) => { if (box.isConnected) moduleSaveRows(box, mods); },
    (e) => { clear(box); box.appendChild(el('div', { class: 'notice err', text: msg(e) })); });
}
