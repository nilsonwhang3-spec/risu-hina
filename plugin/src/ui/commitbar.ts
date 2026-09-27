/**
 * 승인 and 반영 in the title row (§1-76).
 *
 * Both used to live where their material lives: the approval card inside the
 * agent pane (gone when the pane is folded, and on a phone often off screen),
 * 반영 on the chat bar or the bot bar (only on that half's tabs). And the
 * one-dirty-thing rule meant approving a chat edit from the bot screen, or
 * adopting assets from the studio, sent the user across the panel first.
 *
 * Now the title row - the one row that is always on screen, phone included -
 * carries both, with counts:
 *   승인 N  every proposal of the bot + the open chat's turn edits, decided in
 *           one popover from any tab (ui/pendingpop.ts). Amber and pulsing
 *           while anything waits, so it is not only the chat log that says so.
 *   반영 N  the card and every chat holding unapplied work, listed by name and
 *           written in one go. What it writes is named before and after -
 *           the old rule existed so that nothing was saved *quietly*.
 *
 * Counts refresh on state changes (debounced) and on a slow visible-only
 * poll, which also catches work the MCP client or another tab added.
 */
import { el, clear, popover, pollWhileVisible } from './dom';
import { state, type DirtySummary } from '../state';
import { openPendingPopover, setOnDecided } from './pendingpop';
import { collect, applyOne, type DirtyItem } from './leaveguard';
import { openConflicts } from './conflicts';

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const POLL_MS = 8000;

export function commitControls(): HTMLElement {
  const approveCount = el('span', { class: 'commitn' });
  const applyCount = el('span', { class: 'commitn' });
  const approveBtn = el('button', { class: 'ghost commitchip approve', title: '승인을 기다리는 제안' },
    [el('span', { class: 'commitlabel', text: '승인' }), approveCount]) as HTMLButtonElement;
  const applyBtn = el('button', { class: 'ghost commitchip apply', title: 'RisuAI 에 아직 반영하지 않은 변경' },
    [el('span', { class: 'commitlabel', text: '반영' }), applyCount]) as HTMLButtonElement;
  const wrap = el('span', { class: 'commitctl', style: { display: 'none' } }, [approveBtn, applyBtn]);

  let pending = 0;
  let dirty = 0;
  let summary: DirtySummary | null = null;
  let seq = 0;

  const paint = () => {
    wrap.style.display = state.activeCharKey && state.health ? '' : 'none';
    approveCount.textContent = String(pending);
    applyCount.textContent = String(dirty);
    approveBtn.classList.toggle('hot', pending > 0);
    applyBtn.classList.toggle('hot', dirty > 0);
    approveBtn.title = pending ? `승인을 기다리는 제안 ${pending}건 — 눌러서 승인·거절` : '승인을 기다리는 제안이 없습니다';
    applyBtn.title = dirty ? `RisuAI 에 아직 반영하지 않은 변경 ${dirty}건 — 눌러서 한 번에 반영` : 'RisuAI 에 반영할 변경이 없습니다';
  };

  const refresh = async (): Promise<void> => {
    if (!state.activeCharKey || !state.health) { paint(); return; }
    const mine = ++seq;
    try {
      const [acts, staged, sum] = await Promise.all([
        state.actionsForBot().catch(() => []),
        state.activeChatKey ? state.stagedEdits().catch(() => []) : Promise.resolve([]),
        state.dirtySummary(),
      ]);
      if (mine !== seq) return;
      pending = acts.length + staged.length;
      summary = sum;
      dirty = sum ? (sum.card.dirty ? sum.card.total : 0) + sum.chats.reduce((n, c) => n + (c.dirty ? c.total : 0), 0) : 0;
    } catch { /* keep the last numbers; the next tick tries again */ }
    paint();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void refresh(); }, 700);
  };
  // Refresh on any state change - but refresh itself never emits, so this
  // cannot loop.
  state.onChange(soon);
  pollWhileVisible(() => void refresh(), POLL_MS, () => !!state.activeCharKey);
  setOnDecided(() => { state.bump(); soon(); });

  approveBtn.addEventListener('click', () => openPendingPopover(approveBtn));
  applyBtn.addEventListener('click', () => openApplyPopover(applyBtn, () => summary, async () => { await refresh(); }));

  paint();
  void refresh();
  return wrap;
}

/** Write every pending scope (or one), naming each before and after. */
function openApplyPopover(anchor: HTMLElement, last: () => DirtySummary | null, refresh: () => Promise<void>): void {
  const body = el('div', { class: 'applypop commitpop' });
  const close = popover(anchor, body);
  const head = el('div', { class: 'row', style: { marginBottom: '6px' } });
  const note = el('div');
  const list = el('div');
  body.append(head, note, list);
  const say = (text: string, kind: '' | 'err' | 'ok' = '') => {
    note.appendChild(el('div', { class: kind === 'err' ? 'notice err' : kind === 'ok' ? 'notice ok' : 'hint', text }));
  };

  const draw = async (): Promise<void> => {
    clear(head);
    clear(list);
    const summary = (await state.dirtySummary()) ?? last();
    const items: DirtyItem[] = summary ? collect(summary) : [];
    head.appendChild(el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' },
      text: items.length ? `반영할 변경 ${items.reduce((n, d) => n + d.total, 0)}건` : '반영할 변경이 없습니다' }));
    if (!items.length) return;

    const ready = items.filter((d) => !d.conflicts);
    const all = el('button', { class: 'primary tiny', text: `모두 반영 (${ready.length}곳)` }) as HTMLButtonElement;
    all.disabled = !ready.length;
    all.addEventListener('click', () => void run(ready));
    head.appendChild(all);

    for (const d of items) {
      const one = el('button', { class: 'ghost tiny', text: '반영' }) as HTMLButtonElement;
      one.disabled = d.conflicts > 0;
      one.addEventListener('click', () => void run([d]));
      const fix = d.conflicts
        ? el('button', { class: 'ghost tiny', text: `충돌 ${d.conflicts}건 해결` }) as HTMLButtonElement
        : null;
      fix?.addEventListener('click', async () => {
        if (d.scope === 'chat' && d.key !== state.activeChatKey) await state.loadTurns(d.key);
        close();
        openConflicts(d.scope, () => { void refresh(); state.bump(); });
      });
      list.appendChild(el('div', { class: 'stagedrow' }, [
        el('span', { class: 'badge', text: d.scope === 'card' ? '봇' : '챗' }),
        el('div', { class: 'grow' }, [
          el('div', { text: `${d.label} — 변경 ${d.total}건` }),
          d.conflicts ? el('div', { class: 'hint', text: 'RisuAI 쪽과 충돌이 있어 먼저 해결해야 반영됩니다' }) : null,
        ]),
        fix, one,
      ]));
    }
  };

  const run = async (targets: DirtyItem[]): Promise<void> => {
    clear(note);
    for (const b of Array.from(body.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = true;
    // A chat's 반영 opens that chat; come back to the one the user was on.
    const back = state.activeChatKey;
    const done: string[] = [];
    try {
      for (const d of targets) {
        say(`${d.label} 반영 중…`);
        await applyOne(d);
        done.push(d.label);
      }
      clear(note);
      say(`${done.join(', ')} 을(를) RisuAI에 반영하고 저장을 확인했습니다.`, 'ok');
    } catch (e) {
      clear(note);
      if (done.length) say(`${done.join(', ')} 은(는) 반영했습니다.`, 'ok');
      say(`멈췄습니다: ${msg(e)}`, 'err');
    }
    if (back && back !== state.activeChatKey && state.workspace?.chats.some((c) => c.chatKey === back)) {
      try { await state.loadTurns(back); } catch { /* stay where the write left us */ }
    }
    state.bump();
    await refresh();
    await draw();
  };

  void draw();
}
