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
import { openConflicts } from './conflicts';
import { syncPendingChip } from './pendingpop';

let bar: HTMLElement | null = null;
let applyBtn: HTMLElement | null = null;
let discardBtn: HTMLButtonElement | null = null;
let applyBadge: HTMLElement | null = null;
let summaryEl: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;

export function buildChatBar(notice: HTMLElement): HTMLElement {
  noticeMount = notice;
  applyBadge = el('span', { class: 'badge warn applybadge', style: { display: 'none' } });
  applyBtn = el('button', {
    class: 'tool', dataset: { tool: 'apply' },
    title: 'RisuAI에 반영 · 복사본 저장',
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

  // 변경 취소: the other half of resolving an edit session. It used to hide
  // inside the 반영 popover as "기준선으로 되돌리기", which meant the way to
  // NOT write something lived behind the button whose job is to write.
  // Visible only while something is pending - exactly when it has meaning.
  discardBtn = el('button', {
    class: 'tool', dataset: { tool: 'discard' },
    title: '이 챗의 미반영 변경(턴·로어북·장기기억)을 모두 버리고 RisuAI 상태로 되돌립니다',
    style: { display: 'none' },
  }) as HTMLButtonElement;
  armed(discardBtn, TOOL.discard + ' 변경 취소', '정말 버릴까요?', async () => {
    try {
      const d = await state.reset();
      const bits: string[] = [];
      if (d.turns) bits.push(`턴 ${d.turns}건`);
      if (d.lore) bits.push(`로어북 ${d.lore}건`);
      if (d.memory) bits.push(`장기기억 ${d.memory}건`);
      shellNotice('미반영 변경을 버렸습니다' + (bits.length ? ` (${bits.join(' · ')})` : '')
        + '. 작업본이 기준선(RisuAI 상태)으로 돌아갔습니다.', 'ok');
    } catch (e) {
      shellNotice('변경 취소에 실패했습니다: ' + msg(e), 'err');
    }
  });

  summaryEl = el('span', { class: 'dim changesum', title: '이 챗에서 아직 RisuAI에 쓰지 않은 변경' });

  bar = el('div', { class: 'toolrow chatbar' }, [applyBtn, snap, versions, discardBtn, summaryEl]);
  refreshChatBar();
  return bar;
}

/** Redraw the counts; the shell calls this on every state change. */
export function refreshChatBar(): void {
  if (!bar || !summaryEl || !applyBadge) return;
  const c = state.changes;
  const parts = describe(c);
  const conflicts = c?.conflicts ?? 0;
  if (conflicts) parts.unshift(`⚠ 충돌 ${conflicts}`);
  summaryEl.textContent = parts.length ? parts.join(' · ') : (state.activeChatKey ? '변경 없음' : '');
  // The proposals chip is a button (§1-38): the count alone was a dead end.
  syncPendingChip(summaryEl, c?.actions || 0);
  const total = c?.total ?? 0;
  applyBadge.textContent = String(total);
  applyBadge.style.display = total ? '' : 'none';
  applyBadge.classList.toggle('conflict', !!conflicts);
  if (discardBtn) discardBtn.style.display = total || conflicts ? '' : 'none';
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

  // A conflict means we are holding two answers for the same row. Writing one
  // of them without saying which is the silent revert this release removes,
  // so 반영 waits until they are decided.
  const conflicts = state.changes?.conflicts ?? 0;
  if (conflicts) {
    const open = el('button', { class: 'ghost tiny', text: `충돌 ${conflicts}건 정리` });
    open.addEventListener('click', () => {
      close();
      openConflicts('chat', () => { void state.refreshChanges(); });
    });
    body.appendChild(el('div', { class: 'notice' }, [
      el('div', { text: `RisuAI 쪽에서도 바뀐 항목이 ${conflicts}건 있습니다. 먼저 정리해 주세요.` }),
      el('div', { class: 'row', style: { marginTop: '6px' } }, [open]),
    ]));
  }

  const apply = el('button', { class: 'primary', text: 'RisuAI에 반영' }) as HTMLButtonElement;
  apply.disabled = conflicts > 0;
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      const r = await state.writeBack();
      if (r.mode === 'noop' && !r.lore && !r.memory) {
        out.textContent = '반영할 변경이 없습니다.';
      } else if (!r.verified) {
        // The write did not stick (see host.WriteResult.verified). Nothing
        // was committed, nothing re-read: the edits are still here.
        const m = 'RisuAI 가 이 쓰기를 받지 않았습니다'
          + (r.drift ? ` (${r.drift})` : '')
          + '. 편집 내용은 그대로 두었습니다. RisuAI 가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요.';
        out.textContent = m;
        void clientLog('error', 'writeBack unverified', { drift: r.drift ?? '' });
        shellNotice(m, 'err');
      } else {
        // The write landed. `commit` snapshots and then re-reads the chat
        // from RisuAI, so the panel stops holding a copy of what it just
        // shipped - keeping one is where the drift used to start.
        await state.commit('반영 직전');
        const bits: string[] = [];
        if (r.mode !== 'noop') bits.push(`${r.mode === 'replace' ? '전체 교체' : '본문 수정'} ${r.applied}건`);
        if (r.lore) bits.push(`로어북 ${r.lore}건`);
        if (r.memory) bits.push(`장기기억 ${r.memory}건`);
        out.textContent = bits.join(' · ');
        shellNotice(`RisuAI에 반영하고 다시 읽었습니다 (${bits.join(' · ')}).`, 'ok');
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
      apply.disabled = (state.changes?.conflicts ?? 0) > 0;
    }
  });

  const copy = el('button', { text: '복사본으로 저장' });
  copy.addEventListener('click', async () => {
    const name = (state.activeChat?.name || 'chat') + ' (Risu Hina)';
    (copy as HTMLButtonElement).disabled = true;
    try {
      await state.saveCopy(name);
      // Deliberately no commit: the copy went into a *new* chat and this one
      // still holds RisuAI's old content, so the edits are still pending
      // against it. Re-reading here would fetch that old content back and
      // throw the edits away.
      await state.loadTurns();
      shellNotice(`복사본 "${name}" 을 만들었습니다. 로어북과 장기기억도 함께 담겼습니다. `
        + '이 챗의 수정은 아직 반영 전 상태로 남아 있습니다.', 'ok');
      close();
    } catch (e) {
      void clientLog('error', 'saveCopy failed', { error: msg(e) });
      shellNotice('복사본 저장에 실패했습니다: ' + msg(e), 'err');
    } finally {
      (copy as HTMLButtonElement).disabled = false;
    }
  });

  body.appendChild(el('div', { class: 'row' }, [apply]));
  body.appendChild(el('div', { class: 'row' }, [copy]));
  body.appendChild(out);
  body.appendChild(el('div', {
    class: 'hint',
    text: '턴·로어북·장기기억이 한 번에 쓰입니다. 반영이 확인되면 RisuAI 상태를 다시 읽어 오고 수정 표시가 사라집니다. '
      + '반영하지 않고 버리려면 바의 ↩ 변경 취소를 눌러 주세요.',
  }));
}

// --- 버전 (popover) -----------------------------------------------------------

async function openVersions(anchor: HTMLElement): Promise<void> {
  const body = el('div', { class: 'verlist' }, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
  const close = popover(anchor, body);
  try {
    const cps = await state.checkpoints();
    clear(body);
    // The version list is what the user saved, by name. What the code saved
    // for itself (before a 반영, a reset, a bulk edit...) is an internal
    // backup: it exists to survive a mistake, not to be a version anyone
    // chose - the user's own words: an automatic save is nothing they can
    // consciously go back to. So it folds away behind one line.
    const users = cps.filter((c) => c.kind !== 'auto');
    const autos = cps.filter((c) => c.kind === 'auto');
    if (!users.length && !autos.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
      return;
    }
    // The working copy first, so "which one is newest" has an answer: the
    // top row is now, the rows below are the past, newest first.
    body.appendChild(el('div', { class: 'verrow' }, [
      el('div', { class: 'grow' }, [
        el('div', {}, [el('span', { text: '지금 편집 중인 상태 ' }), el('span', { class: 'badge now', text: '현재' })]),
        el('div', { class: 'hint', text: '스냅샷이 아닙니다. 아래는 오래된 순이 아니라 최근 순입니다.' }),
      ]),
    ]));
    if (!users.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 저장한 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
    }
    const verRow = (c: (typeof cps)[number], opts: { newest?: boolean; auto?: boolean }) => {
      const b = el('button', { class: 'ghost tiny', text: '되돌리기', title: '작업본을 이 시점으로 되돌립니다 (직전 상태도 스냅샷으로 남습니다)' });
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
      const title = el('div', {}, [
        el('span', { text: c.label || '(무제)' }),
        opts.newest ? el('span', { class: 'badge', style: { marginLeft: '6px' }, text: '최신 스냅샷' }) : null,
      ]);
      // Renaming is what makes a save the user's; an automatic backup keeps
      // the label that says which step took it.
      const ren = opts.auto ? null : el('button', { class: 'ghost tiny', text: '✎', title: '이름 바꾸기' });
      ren?.addEventListener('click', () => {
        openSnapshotName(ren, c.label || '', async (label) => {
          await state.renameCheckpoint(c.id, label);
          (title.firstChild as HTMLElement).textContent = label;
        });
      });
      const row = el('div', { class: 'verrow' });
      const del = el('button', { class: 'ghost tiny', title: '이 스냅샷 삭제' }) as HTMLButtonElement;
      armed(del, '✕', '삭제 확인', async () => {
        // Dim at once (see botbar.ts): the wait is the round trip, not the delete.
        row.classList.add('deleting');
        del.disabled = true;
        try {
          await state.deleteCheckpoint(c.id);
          row.remove();
        } catch (e) {
          row.classList.remove('deleting');
          del.disabled = false;
          shellNotice('삭제하지 못했습니다: ' + msg(e), 'err');
        }
      });
      row.append(
        el('div', { class: 'grow' }, [
          title,
          el('div', { class: 'hint', text: `${c.message_count}턴 · ${fmtTime(c.created_at * 1000)}` }),
        ]),
        ...(ren ? [ren] : []), b, del,
      );
      return row;
    };
    for (const [idx, c] of users.slice(0, 12).entries()) {
      body.appendChild(verRow(c, { newest: idx === 0 }));
    }
    if (users.length > 12) body.appendChild(el('div', { class: 'hint', text: `그 외 ${users.length - 12}개` }));
    if (autos.length) {
      const fold = el('div', { class: 'autofold' });
      const toggle = el('button', { class: 'ghost tiny', text: `자동 백업 ${autos.length}개 보기` }) as HTMLButtonElement;
      toggle.addEventListener('click', () => {
        if (fold.childElementCount) {
          clear(fold);
          toggle.textContent = `자동 백업 ${autos.length}개 보기`;
          return;
        }
        toggle.textContent = '자동 백업 접기';
        fold.appendChild(el('div', {
          class: 'hint',
          text: '자동 백업은 반영·되돌리기 직전에 남긴 내부용 사본입니다. RisuAI의 현재 내용보다 과거일 수 있습니다.',
        }));
        for (const c of autos) fold.appendChild(verRow(c, { auto: true }));
      });
      body.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } }, [toggle]));
      body.appendChild(fold);
    }
    body.appendChild(snapshotCleanup(users.length, async (keep) => {
      const n = await state.clearCheckpoints(keep);
      close();
      shellNotice(`저장한 스냅샷 ${n}개를 지웠습니다.`, 'ok');
    }));
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: msg(e) }));
  }
}

/** The bulk row under a snapshot list: keep the newest few, or drop them all. */
export function snapshotCleanup(total: number, run: (keep: number) => Promise<void>): HTMLElement {
  const keep5 = el('button', { class: 'ghost tiny', title: '최근 5개만 남기고 지웁니다' });
  const all = el('button', { class: 'ghost tiny', title: '스냅샷을 전부 지웁니다' });
  const wrap = el('div', { class: 'row', style: { marginTop: '8px', justifyContent: 'flex-end' } }, [
    // Saved ones only: the automatic backups prune themselves on the backend.
    el('span', { class: 'hint grow', text: `저장한 스냅샷 ${total}개` }),
    total > 5 ? keep5 : null,
    all,
  ]);
  armed(keep5, '최근 5개만 남기기', '정말?', async () => {
    try { await run(5); } catch (e) { shellNotice('정리하지 못했습니다: ' + msg(e), 'err'); }
  });
  armed(all, '전부 삭제', '정말 전부?', async () => {
    try { await run(0); } catch (e) { shellNotice('정리하지 못했습니다: ' + msg(e), 'err'); }
  });
  return wrap;
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
