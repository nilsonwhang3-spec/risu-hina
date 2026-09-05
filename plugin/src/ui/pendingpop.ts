/**
 * The "제안 N 대기" chip, opened (§1-38).
 *
 * The bars counted every pending proposal of the bot, but the agent panel's
 * approval card only ever listed the ACTIVE chat's - proposals made in other
 * chats, or in a session that ended before the card was looked at, piled up
 * behind a number nobody could act on ("제안 10 대기 … 이거 어케 함").
 *
 * One popover lists them all with the chat each rode on. Reject works
 * anywhere; approve only where the proposal's chat is the open one (the
 * approval may need that chat's working copy and, for host actions, the
 * plugin's write path into it) - elsewhere the row says to open that chat.
 */
import { el, clear, popover } from './dom';
import { state, type PendingAction } from '../state';

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

export function openPendingPopover(anchor: HTMLElement): void {
  const body = el('div', { class: 'applypop pendingpop' });
  const close = popover(anchor, body);
  const list = el('div', {});
  const head = el('div', { class: 'row', style: { marginBottom: '6px' } });
  body.append(head, list);

  const draw = async (): Promise<void> => {
    clear(head);
    clear(list);
    list.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    let items: PendingAction[] = [];
    try {
      items = await state.actionsForBot();
    } catch (e) {
      clear(list);
      list.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
      return;
    }
    clear(list);
    head.appendChild(el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' },
      text: `대기 중인 제안 ${items.length}건` }));
    if (!items.length) {
      list.appendChild(el('div', { class: 'hint', text: '대기 중인 제안이 없습니다.' }));
      return;
    }
    const rejectAll = el('button', { class: 'ghost tiny', text: '전체 거절' }) as HTMLButtonElement;
    rejectAll.addEventListener('click', async () => {
      rejectAll.disabled = true;
      try {
        const n = await state.clearBotActions();
        list.appendChild(el('div', { class: 'hint', text: `${n}건을 거절했습니다.` }));
      } catch (e) {
        list.appendChild(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }));
      }
      await draw();
    });
    head.appendChild(rejectAll);

    for (const a of items) {
      const mine = !a.chatKey || a.chatKey === state.activeChatKey;
      const yes = el('button', { class: 'primary tiny', text: a.byHost ? '승인·실행' : '승인' }) as HTMLButtonElement;
      const no = el('button', { class: 'ghost tiny', text: '거절' }) as HTMLButtonElement;
      const busy = el('span', { class: 'hint' });
      yes.disabled = !mine;
      yes.title = mine ? '' : '이 제안이 올라온 챗을 열어야 승인할 수 있습니다';
      const decide = async (approve: boolean) => {
        yes.disabled = no.disabled = true;
        busy.textContent = approve ? '실행 중…' : '거절 중…';
        try {
          await state.decideAction(a.id, approve, a.chatKey || '');
          void state.refreshChanges();
          void state.refreshBotChanges();
        } catch (e) {
          busy.textContent = '';
          list.insertBefore(el('div', { class: 'notice err', text: e instanceof Error ? e.message : String(e) }), row);
          yes.disabled = !mine;
          no.disabled = false;
          return;
        }
        await draw();
      };
      yes.addEventListener('click', () => void decide(true));
      no.addEventListener('click', () => void decide(false));
      const row = el('div', { class: 'stagedrow' }, [
        a.byHost ? el('span', { class: 'badge err', text: 'RisuAI' }) : null,
        el('div', { class: 'grow' }, [
          el('div', { text: a.summary }),
          el('div', { class: 'hint', text: (a.chatName ? `챗: ${a.chatName}` : '이 봇') + (mine ? '' : ' · 다른 챗') }),
        ]),
        busy, yes, no,
      ]);
      list.appendChild(row);
    }
  };
  void draw();
  return void close;
}
