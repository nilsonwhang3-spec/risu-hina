/**
 * The leave guard: no path out of an edit leaves work silently pending.
 *
 * The backend keeps a working copy of whatever is being edited, and before
 * this guard existed that copy simply stayed behind on every exit - close the
 * panel, switch 봇 편집 ↔ 챗 편집, open another chat - and surfaced days
 * later as a merge nobody remembered asking for. The rule now is one dirty
 * thing at a time, resolved at the door: leaving prompts 반영 / 버리기 /
 * 계속 편집. The one exit that cannot prompt is the browser closing; that
 * path is what the reopen merge (Risu as the source of truth, conflicts
 * decided in the UI) remains for.
 *
 * Every guarded action funnels through `ensureResolved`, which reads the
 * bot-wide summary from `GET /workspace/dirty` - the active scope's counts
 * the panel already has, but a chat left dirty by an earlier session is
 * something only the backend remembers.
 */
import { el, modal, armed } from './dom';
import { state, type DirtySummary } from '../state';
import { clientLog } from '../transport';
import { shellNotice } from './chatbar';
import { openConflicts } from './conflicts';

interface DirtyItem {
  scope: 'card' | 'chat';
  /** chatKey for a chat; '' for the card. */
  key: string;
  label: string;
  total: number;
  conflicts: number;
}

/** What a guarded action is at home in, and therefore never prompts for:
 * opening a chat is at home in that chat, 봇 편집 is at home in the card. */
export interface LeaveExempt {
  scope: 'card' | 'chat';
  key?: string;
}

let inFlight: Promise<boolean> | null = null;

/**
 * Resolve every pending edit that `action` would leave behind. `true` means
 * the caller may proceed; `false` means the user chose to stay (or closed
 * the prompt, which is the same answer).
 *
 * Re-entry while a prompt is open joins the same answer instead of stacking
 * a second modal.
 */
export function ensureResolved(action: string, except?: LeaveExempt): Promise<boolean> {
  if (inFlight) return inFlight;
  const p = resolveAll(action, except).finally(() => { inFlight = null; });
  inFlight = p;
  return p;
}

async function resolveAll(action: string, except?: LeaveExempt): Promise<boolean> {
  // Not connected: every edit is already in the backend (the panel keeps no
  // local buffer), and nothing could be applied or discarded anyway. Never
  // lock the user in on a dead connection.
  if (!state.health || !state.activeCharKey) return true;
  const summary = await state.dirtySummary();
  if (!summary) return true;
  const dirty = collect(summary, except);
  for (const d of dirty) {
    if (!(await promptOne(action, d))) return false;
  }
  return true;
}

function collect(summary: DirtySummary, except?: LeaveExempt): DirtyItem[] {
  const out: DirtyItem[] = [];
  if (summary.card.dirty && except?.scope !== 'card') {
    out.push({
      scope: 'card', key: '', label: '봇 카드',
      total: summary.card.total, conflicts: summary.card.conflicts,
    });
  }
  for (const c of summary.chats) {
    if (!c.dirty) continue;
    if (except?.scope === 'chat' && except.key && except.key === c.chatKey) continue;
    out.push({
      scope: 'chat', key: c.chatKey, label: `'${c.name || '이름 없는 챗'}' 챗`,
      total: c.total, conflicts: c.conflicts,
    });
  }
  return out;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 반영 for one dirty item; throws with the reason when it did not land. */
async function applyOne(d: DirtyItem): Promise<void> {
  if (d.scope === 'card') {
    const r = await state.cardWriteBack();
    if (!r.verified) {
      throw new Error('RisuAI 가 이 쓰기를 받지 않았습니다' + (r.drift ? ` (${r.drift})` : '')
        + '. 편집 내용은 그대로 있습니다. RisuAI 가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요.');
    }
    return;
  }
  if (state.activeChatKey !== d.key) await state.loadTurns(d.key);
  const r = await state.writeBack();
  if (r.mode === 'noop' && !r.lore && !r.memory) return;
  if (!r.verified) {
    throw new Error('RisuAI 가 이 쓰기를 받지 않았습니다' + (r.drift ? ` (${r.drift})` : '')
      + '. 편집 내용은 그대로 있습니다. RisuAI 가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요.');
  }
  await state.commit('반영 직전');
}

async function discardOne(d: DirtyItem): Promise<string> {
  if (d.scope === 'card') {
    const n = await state.cardReset();
    return n ? `${n}건` : '';
  }
  if (state.activeChatKey !== d.key) await state.loadTurns(d.key);
  const c = await state.reset();
  const bits: string[] = [];
  if (c.turns) bits.push(`턴 ${c.turns}건`);
  if (c.lore) bits.push(`로어북 ${c.lore}건`);
  if (c.memory) bits.push(`장기기억 ${c.memory}건`);
  return bits.join(' · ');
}

function promptOne(action: string, d: DirtyItem): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let close = () => { /* set below */ };
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      close();
      resolve(v);
    };

    const out = el('div', { class: 'notice err', style: { display: 'none' } });
    const say = (text: string) => {
      out.textContent = text;
      out.style.display = '';
    };

    const body = el('div', { class: 'leaveguard' });
    body.appendChild(el('div', {
      text: `${d.label}에 아직 RisuAI에 반영하지 않은 변경 ${d.total}건이 있습니다.`,
    }));
    body.appendChild(el('div', {
      class: 'hint',
      text: `${action} 전에 정리해 주세요. 반영하면 RisuAI에 쓰이고, 버리면 RisuAI 상태로 돌아갑니다.`,
    }));

    const apply = el('button', {
      class: 'primary', text: 'RisuAI에 반영하고 계속',
    }) as HTMLButtonElement;
    apply.disabled = d.conflicts > 0;
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        await applyOne(d);
        shellNotice(`${d.label}의 변경을 RisuAI에 반영했습니다.`, 'ok');
        done(true);
      } catch (e) {
        // The prompt stays: the edits are still in the backend and the user
        // still owes an answer - but now they know why 반영 did not take it.
        void clientLog('error', 'leaveguard apply failed', { error: msg(e) });
        say(msg(e));
        apply.disabled = d.conflicts > 0;
      }
    });

    const discard = el('button', { class: 'ghost' }) as HTMLButtonElement;
    armed(discard, '변경사항 버리고 계속', '정말 버릴까요?', async () => {
      discard.disabled = true;
      try {
        const what = await discardOne(d);
        shellNotice(`${d.label}의 미반영 변경을 버렸습니다${what ? ` (${what})` : ''}.`, 'ok');
        done(true);
      } catch (e) {
        void clientLog('error', 'leaveguard discard failed', { error: msg(e) });
        say(msg(e));
        discard.disabled = false;
      }
    });

    const stay = el('button', { class: 'ghost', text: '계속 편집' });
    stay.addEventListener('click', () => done(false));

    if (d.conflicts > 0) {
      // 반영 cannot write over an undecided conflict; the way through is the
      // conflict UI, and that is a place to stay, not a way out.
      const fix = el('button', { class: 'ghost tiny', text: `충돌 ${d.conflicts}건 정리` });
      fix.addEventListener('click', () => {
        done(false);
        openConflicts(d.scope === 'card' ? 'card' : 'chat', () => {
          void state.refreshChanges();
          void state.refreshBotChanges();
        });
      });
      body.appendChild(el('div', { class: 'notice' }, [
        el('div', { text: `RisuAI 쪽에서도 바뀐 항목이 ${d.conflicts}건 있어 반영이 잠겨 있습니다.` }),
        el('div', { class: 'row', style: { marginTop: '6px' } }, [fix]),
      ]));
    }

    body.appendChild(el('div', { class: 'row', style: { marginTop: '10px' } }, [apply]));
    body.appendChild(el('div', { class: 'row' }, [discard, stay]));
    body.appendChild(out);

    close = modal('미반영 변경이 있습니다', body, {
      sticky: true,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
    });
  });
}
