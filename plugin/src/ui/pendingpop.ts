/**
 * Everything that waits for the user's approval, in one popover (§1-38,
 * widened in §1-76).
 *
 * Two queues feed it: proposals (lorebook, card, scripts, memory, assets,
 * snapshots, host actions like 반영) for the whole bot, each with the chat it
 * rode on, and the open chat's staged turn edits. Both are decided here from
 * any screen - there is no "go to 챗 편집 first" any more. A host action for
 * a chat that is not the open one (its 반영 writes that chat) opens that chat
 * first, the same way the leave guard's 반영 does.
 *
 * The title row's 승인 button and the bars' "제안 N 대기" chip both open it.
 */
import { el, clear, popover } from './dom';
import { state, type PendingAction, type StagedEdit } from '../state';

let btns = new WeakMap<HTMLElement, HTMLElement>();

/** Keep a chip button right after `anchor`, showing `count` (0 hides it). */
export function syncPendingChip(anchor: HTMLElement, count: number): void {
  let b = btns.get(anchor);
  if (!b) {
    b = el('button', { class: 'ghost tiny pendingchip', title: '대기 중인 제안을 보고 승인하거나 거절합니다' });
    b.addEventListener('click', () => openPendingPopover(b!));
    anchor.after(b);
    btns.set(anchor, b);
  }
  b.textContent = `제안 ${count} 대기`;
  b.style.display = count > 0 ? '' : 'none';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const HOST_OPENS_CHAT = new Set(['host_writeback', 'host_save_copy']);

/** Decide one proposal from anywhere. */
async function decideAnywhere(a: PendingAction, approve: boolean): Promise<string> {
  // A chat's 반영 / 사본 저장 act on the chat the panel has open.
  if (approve && a.byHost && HOST_OPENS_CHAT.has(a.kind) && a.chatKey && a.chatKey !== state.activeChatKey) {
    await state.loadTurns(a.chatKey);
  }
  return await state.decideAction(a.id, approve, a.chatKey || '');
}

function opLabel(s: StagedEdit): string {
  const where = s.seq !== null && s.seq !== undefined ? `#${s.seq}` : '';
  const what = s.op === 'delete' ? '삭제' : s.op === 'insert' ? '삽입' : '수정';
  return `턴 ${where} ${what}`.replace(/\s+/g, ' ').trim();
}

/** Called after anything was decided, so bars, tabs and counters follow. */
let onDecided: () => void = () => { /* set by the title row */ };
export function setOnDecided(fn: () => void): void { onDecided = fn; }

export function openPendingPopover(anchor: HTMLElement): void {
  const body = el('div', { class: 'applypop pendingpop' });
  const close = popover(anchor, body);
  const head = el('div', { class: 'row', style: { marginBottom: '6px' } });
  const note = el('div');
  const list = el('div', {});
  body.append(head, note, list);

  const say = (text: string, kind: '' | 'err' = '') => {
    note.appendChild(el('div', { class: kind === 'err' ? 'notice err' : 'hint', text }));
  };

  const draw = async (): Promise<void> => {
    clear(head);
    clear(list);
    list.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    let items: PendingAction[] = [];
    let staged: StagedEdit[] = [];
    try {
      [items, staged] = await Promise.all([
        state.actionsForBot(),
        state.activeChatKey ? state.stagedEdits() : Promise.resolve([] as StagedEdit[]),
      ]);
    } catch (e) {
      clear(list);
      list.appendChild(el('div', { class: 'notice err', text: msg(e) }));
      return;
    }
    clear(list);
    const total = items.length + staged.length;
    head.appendChild(el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' },
      text: `승인 대기 ${total}건` }));
    if (!total) {
      list.appendChild(el('div', { class: 'hint', text: '승인을 기다리는 제안이 없습니다.' }));
      return;
    }

    const allYes = el('button', { class: 'primary tiny', text: `전체 승인 (${total})` }) as HTMLButtonElement;
    const allNo = el('button', { class: 'ghost tiny', text: '전체 거절' }) as HTMLButtonElement;
    const runAll = async (approve: boolean) => {
      allYes.disabled = allNo.disabled = true;
      clear(note);
      let done = 0;
      try {
        for (const a of items) {
          await decideAnywhere(a, approve);
          done += 1;
        }
        if (staged.length) {
          await state.approveStaged(approve);
          done += staged.length;
        }
        say(`${done}건을 ${approve ? '승인' : '거절'}했습니다.`);
      } catch (e) {
        // Stop at the first failure: the rest stays pending, visible below.
        say(`${done}건 처리 후 멈췄습니다: ${msg(e)}`, 'err');
      }
      onDecided();
      await draw();
    };
    allYes.addEventListener('click', () => void runAll(true));
    allNo.addEventListener('click', () => void runAll(false));
    head.append(allYes, allNo);

    for (const a of items) {
      const yes = el('button', { class: 'primary tiny', text: a.byHost ? '승인·실행' : '승인' }) as HTMLButtonElement;
      const no = el('button', { class: 'ghost tiny', text: '거절' }) as HTMLButtonElement;
      const busy = el('span', { class: 'hint' });
      const other = !!a.chatKey && a.chatKey !== state.activeChatKey;
      // An MCP batch (§1-79) carries its per-batch lines: model, styles,
      // characters, size, cost - what the in-panel confirmation used to show.
      const lines = Array.isArray(a.args?.lines) ? (a.args.lines as unknown[]).map(String).slice(0, 6) : [];
      const row = el('div', { class: 'stagedrow' }, [
        a.kind === 'studio_batch' ? el('span', { class: 'badge warn', text: '생성' })
          : a.byHost ? el('span', { class: 'badge err', text: 'RisuAI' }) : el('span', { class: 'badge', text: '작업본' }),
        el('div', { class: 'grow' }, [
          el('div', { text: a.summary }),
          ...lines.map((t) => el('div', { class: 'hint', text: t })),
          el('div', { class: 'hint', text: (a.chatName ? `챗: ${a.chatName}` : '이 봇')
            + (other && a.byHost && HOST_OPENS_CHAT.has(a.kind) ? ' · 승인하면 그 챗을 엽니다' : '') }),
        ]),
        busy, yes, no,
      ]);
      const decide = async (approve: boolean) => {
        yes.disabled = no.disabled = true;
        busy.textContent = approve ? '실행 중…' : '거절 중…';
        try {
          await decideAnywhere(a, approve);
        } catch (e) {
          busy.textContent = '';
          list.insertBefore(el('div', { class: 'notice err', text: msg(e) }), row);
          yes.disabled = no.disabled = false;
          return;
        }
        onDecided();
        await draw();
      };
      yes.addEventListener('click', () => void decide(true));
      no.addEventListener('click', () => void decide(false));
      list.appendChild(row);
    }

    if (staged.length) {
      const yes = el('button', { class: 'primary tiny', text: `턴 수정 ${staged.length}건 승인` }) as HTMLButtonElement;
      const no = el('button', { class: 'ghost tiny', text: '거절' }) as HTMLButtonElement;
      const decideStaged = async (approve: boolean) => {
        yes.disabled = no.disabled = true;
        try {
          await state.approveStaged(approve);
        } catch (e) {
          list.appendChild(el('div', { class: 'notice err', text: msg(e) }));
          yes.disabled = no.disabled = false;
          return;
        }
        onDecided();
        await draw();
      };
      yes.addEventListener('click', () => void decideStaged(true));
      no.addEventListener('click', () => void decideStaged(false));
      const chatName = state.workspace?.chats.find((c) => c.chatKey === state.activeChatKey)?.name || '열린 챗';
      const preview = staged.slice(0, 5).map((s) => `${opLabel(s)}${s.reason ? ' — ' + s.reason : ''}`);
      list.appendChild(el('div', { class: 'stagedrow' }, [
        el('span', { class: 'badge', text: '턴' }),
        el('div', { class: 'grow' }, [
          el('div', { text: `턴 수정 ${staged.length}건 (챗: ${chatName})` }),
          ...preview.map((t) => el('div', { class: 'hint', text: t })),
          staged.length > 5 ? el('div', { class: 'hint', text: `… 외 ${staged.length - 5}건 (챗 에딧에서 턴별로 볼 수 있습니다)` }) : null,
        ]),
        yes, no,
      ]));
    }
  };
  void draw();
  return void close;
}
