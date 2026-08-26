/**
 * The chat-level verbs, shared by every content tab.
 *
 * 반영, 스냅샷 and 버전 act on the chat as a whole - turns, this chat's
 * lorebook and its long-term memory together - so they do not belong to any
 * one tab. They used to live in the editor's tool row, which meant a lorebook
 * edit had to be written back from a different tab than the one it was made
 * in, and the memory tab grew a second 반영 with a second meaning. One bar,
 * one write, one snapshot.
 *
 * The bar is owned by the shell and rendered into the tool slot ahead of
 * whatever tools the active tab adds after it.
 */
import { el, clear, armed, popover, TOOL, fmtTime } from './dom';
import { state, type Changes } from '../state';
import * as host from '../host';
import { clientLog } from '../transport';

let bar: HTMLElement | null = null;
let applyBtn: HTMLElement | null = null;
let applyBadge: HTMLElement | null = null;
let summaryEl: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;

export function buildChatBar(notice: HTMLElement): HTMLElement {
  noticeMount = notice;
  applyBadge = el('span', { class: 'badge warn applybadge', style: { display: 'none' } });
  applyBtn = el('button', {
    class: 'tool', dataset: { tool: 'apply' },
    title: 'RisuAI에 반영 · 복사본 저장 · 기준선으로 되돌리기',
  }, [
    el('span', { class: 'glyph', text: TOOL.apply }),
    el('span', { class: 'tool-label', text: '반영' }),
    applyBadge,
  ]);
  applyBtn.addEventListener('click', () => { if (applyBtn) openApply(applyBtn); });

  const snap = el('button', {
    class: 'tool', dataset: { tool: 'snapshot' },
    title: '지금 상태(턴·로어북·장기기억)를 스냅샷으로 저장합니다',
  }, [
    el('span', { class: 'glyph', text: TOOL.snapshot }),
    el('span', { class: 'tool-label', text: '스냅샷' }),
  ]);
  snap.addEventListener('click', () => {
    // A manual snapshot gets a name up front - "수동 #7" tells nobody what
    // was special about it. The name can still be changed in 버전.
    openSnapshotName(snap, '수동', async (label) => {
      await state.checkpoint(label);
      shellNotice('스냅샷을 저장했습니다. 🕘 버전에서 이름을 바꾸거나 되돌릴 수 있습니다.', 'ok');
    });
  });

  const versions = el('button', {
    class: 'tool', dataset: { tool: 'versions' },
    title: '스냅샷 목록에서 되돌리기',
  }, [
    el('span', { class: 'glyph', text: TOOL.versions }),
    el('span', { class: 'tool-label', text: '버전' }),
  ]);
  versions.addEventListener('click', () => void openVersions(versions));

  summaryEl = el('span', { class: 'dim changesum', title: '이 챗에서 아직 RisuAI에 쓰지 않은 변경' });

  bar = el('div', { class: 'toolrow chatbar' }, [applyBtn, snap, versions, summaryEl]);
  refreshChatBar();
  return bar;
}

/** Redraw the counts; the shell calls this on every state change. */
export function refreshChatBar(): void {
  if (!bar || !summaryEl || !applyBadge) return;
  const c = state.changes;
  const parts = describe(c);
  summaryEl.textContent = parts.length ? parts.join(' · ') : (state.activeChatKey ? '변경 없음' : '');
  const total = c?.total ?? 0;
  applyBadge.textContent = String(total);
  applyBadge.style.display = total ? '' : 'none';
}

function describe(c: Changes | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  const t = c.turns;
  if (t.total) {
    const bits: string[] = [];
    if (t.edited) bits.push(`수정 ${t.edited}`);
    if (t.added) bits.push(`추가 ${t.added}`);
    if (t.removed) bits.push(`삭제 ${t.removed}`);
    if (t.reordered) bits.push('순서 변경');
    out.push('턴 ' + bits.join(' '));
  }
  const l = c.lore;
  if (l.total) {
    const bits: string[] = [];
    if (l.added) bits.push(`+${l.added}`);
    if (l.edited) bits.push(`~${l.edited}`);
    if (l.deleted) bits.push(`−${l.deleted}`);
    out.push('로어북 ' + bits.join(' '));
  }
  if (c.memory.changed) out.push(`장기기억 ${c.memory.changed}`);
  if (c.memory.vars) out.push(`챗 변수 ${c.memory.vars}`);
  const pending = (c.staged || 0) + (c.actions || 0);
  if (pending) out.push(`제안 ${pending} 대기`);
  return out;
}

/**
 * A notice that belongs to the chat, not to a tab.
 *
 * Tabs keep their own notice areas for their own actions; this one sits under
 * the tool slot so a write-back started from the lorebook tab reports in the
 * same place as one started from the editor.
 */
export function shellNotice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- 반영 (popover) -----------------------------------------------------------

function openApply(anchor: HTMLElement): void {
  const out = el('div', { class: 'hint' });
  const body = el('div', { class: 'applypop' });
  const close = popover(anchor, body);

  const lines = describe(state.changes);
  body.appendChild(el('div', { class: 'hint', text: lines.length ? lines.join(' · ') : '반영할 변경이 없습니다.' }));
  if (state.changes?.warnings?.length) {
    for (const w of state.changes.warnings) body.appendChild(el('div', { class: 'notice', text: w }));
  }

  const apply = el('button', { class: 'primary', text: 'RisuAI에 반영' });
  apply.addEventListener('click', async () => {
    (apply as HTMLButtonElement).disabled = true;
    try {
      const r = await state.writeBack();
      if (r.mode === 'noop' && !r.lore && !r.memory) {
        out.textContent = '반영할 변경이 없습니다.';
      } else {
        // The write landed, so this state is the baseline now. Without this
        // the panel keeps every edited turn struck through, which reads as
        // "still pending" when it already shipped.
        const c = await state.commit('반영 직전');
        await state.loadTurns();
        const bits: string[] = [];
        if (r.mode !== 'noop') bits.push(`${r.mode === 'replace' ? '전체 교체' : '본문 수정'} ${r.applied}건`);
        if (r.lore) bits.push(`로어북 ${r.lore}건`);
        if (r.memory) bits.push(`장기기억 ${r.memory}건`);
        out.textContent = `${bits.join(' · ')} · 기준선 ${c.newBaseline}턴`;
        shellNotice(`RisuAI에 반영했습니다 (${bits.join(' · ')}). 이 상태가 새 기준선이 됩니다.`, 'ok');
        close();
      }
      for (const w of r.warnings) shellNotice(w);
    } catch (e) {
      const m = msg(e);
      out.textContent = m;
      void clientLog('error', 'writeBack failed', { error: m });
      shellNotice(
        e instanceof host.HostError && e.code === 'changed'
          ? m + ' — "다시 불러오기"를 누른 뒤 다시 시도해 주세요'
          : '반영에 실패했습니다: ' + m,
        'err',
      );
    } finally {
      (apply as HTMLButtonElement).disabled = false;
    }
  });

  const copy = el('button', { text: '복사본으로 저장' });
  copy.addEventListener('click', async () => {
    const name = (state.activeChat?.name || 'chat') + ' (Risu Hina)';
    (copy as HTMLButtonElement).disabled = true;
    try {
      await state.saveCopy(name);
      const c = await state.commit('복사본 저장 직전');
      await state.loadTurns();
      shellNotice(`복사본 "${name}" 을 만들었습니다 · 기준선 ${c.newBaseline}턴. 로어북과 장기기억도 함께 담겼습니다.`, 'ok');
      close();
    } catch (e) {
      void clientLog('error', 'saveCopy failed', { error: msg(e) });
      shellNotice('복사본 저장에 실패했습니다: ' + msg(e), 'err');
    } finally {
      (copy as HTMLButtonElement).disabled = false;
    }
  });

  const reset = el('button', { class: 'ghost' });
  armed(reset, '기준선으로 되돌리기', '정말 되돌릴까요?', async () => {
    try {
      await state.reset();
      shellNotice('작업본을 기준선으로 되돌렸습니다.', 'ok');
      close();
    } catch (e) {
      shellNotice('되돌리기에 실패했습니다: ' + msg(e), 'err');
    }
  });

  body.appendChild(el('div', { class: 'row' }, [apply]));
  body.appendChild(el('div', { class: 'row' }, [copy]));
  body.appendChild(el('div', { class: 'row' }, [reset]));
  body.appendChild(out);
  body.appendChild(el('div', {
    class: 'hint',
    text: '턴·로어북·장기기억이 한 번에 쓰입니다. 성공하면 그 상태가 새 기준선이 되면서 수정 표시가 사라집니다.',
  }));
}

// --- 버전 (popover) -----------------------------------------------------------

async function openVersions(anchor: HTMLElement): Promise<void> {
  const body = el('div', { class: 'verlist' }, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
  const close = popover(anchor, body);
  try {
    const cps = await state.checkpoints();
    clear(body);
    if (!cps.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
      return;
    }
    for (const c of cps.slice(0, 12)) {
      const b = el('button', { class: 'ghost tiny', text: '되돌리기' });
      b.addEventListener('click', async () => {
        (b as HTMLButtonElement).disabled = true;
        try {
          const r = await state.restore(c.id);
          close();
          shellNotice(
            r.lore === null && r.memory === null
              ? '턴을 되돌렸습니다 (이 스냅샷은 턴만 담고 있습니다). 되돌리기 직전 상태도 스냅샷으로 남겨 두었습니다.'
              : '턴·로어북·장기기억을 되돌렸습니다. 되돌리기 직전 상태도 스냅샷으로 남겨 두었습니다.',
            'ok',
          );
        } catch (e) {
          shellNotice('복원에 실패했습니다: ' + msg(e), 'err');
        }
      });
      const title = el('div', { text: c.label || '(무제)' });
      const ren = el('button', { class: 'ghost tiny', text: '✎', title: '이름 바꾸기' });
      ren.addEventListener('click', () => {
        openSnapshotName(ren, c.label || '', async (label) => {
          await state.renameCheckpoint(c.id, label);
          title.textContent = label;
        });
      });
      body.appendChild(el('div', { class: 'verrow' }, [
        el('div', { class: 'grow' }, [
          title,
          el('div', { class: 'hint', text: `${c.message_count}턴 · ${fmtTime(c.created_at * 1000)}` }),
        ]),
        ren, b,
      ]));
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: msg(e) }));
  }
}

/**
 * A small popover asking for a snapshot's name. Shared by 스냅샷 (name it
 * before saving) and 버전 (rename an existing one); `save` does whichever.
 */
export function openSnapshotName(anchor: HTMLElement, initial: string,
                                 save: (label: string) => Promise<void>): void {
  const input = el('input', { value: initial, placeholder: '스냅샷 이름 (예: 3장 시작 전)' }) as HTMLInputElement;
  const ok = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const cancel = el('button', { class: 'ghost tiny', text: '취소' });
  const out = el('div', { class: 'hint' });
  const body = el('div', { class: 'verlist' }, [
    el('label', { class: 'field' }, [el('span', { text: '스냅샷 이름' }), input]),
    el('div', { class: 'row' }, [ok, cancel]),
    out,
  ]);
  const close = popover(anchor, body);
  cancel.addEventListener('click', close);
  const submit = async () => {
    const label = input.value.trim();
    if (!label) { out.textContent = '이름을 입력해 주세요.'; return; }
    ok.disabled = true;
    try {
      await save(label);
      close();
    } catch (e) {
      out.textContent = msg(e);
      ok.disabled = false;
    }
  };
  ok.addEventListener('click', () => void submit());
  input.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void submit(); }
  });
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
