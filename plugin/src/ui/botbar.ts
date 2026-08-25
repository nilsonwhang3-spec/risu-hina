/**
 * The bot-level verbs, shared by every bot tab (메타 · 봇 로어북 · Regex · 트리거).
 *
 * The chat bar's sibling, not a parameterisation of it: the apply sequence is
 * different (card write-back commits inside state.cardWriteBack), the second
 * verb is "복제 봇" rather than "복사본", and the gate is different - a card
 * write requires the bot to be the one RisuAI has selected, because mainline
 * silently drops writes to any other character.
 *
 * The asset gate: 반영 stays disabled until the background importer
 * (assets.ts, started by state.upload) reports the bot's assets in the
 * store - `state.assetGateReason` is the importer's word on that. A card
 * written back before its images arrived would be a card the charx builder
 * cannot complete.
 */
import { el, clear, armed, popover, TOOL, fmtTime } from './dom';
import { state, type CardChanges } from '../state';
import { shellNotice } from './chatbar';
import { clientLog } from '../transport';

let bar: HTMLElement | null = null;
let applyBtn: HTMLButtonElement | null = null;
let applyBadge: HTMLElement | null = null;
let summaryEl: HTMLElement | null = null;

function applyBlockReason(): string | null {
  if (!state.isLiveBot) {
    return 'RisuAI에서 이 봇을 선택해야 반영할 수 있습니다';
  }
  if (state.botChanges && !state.botChanges.full) {
    return '구버전 업로드 상태입니다. 패널을 닫았다 다시 열어 주세요';
  }
  return state.assetGateReason;
}

export function buildBotBar(): HTMLElement {
  applyBadge = el('span', { class: 'badge warn applybadge', style: { display: 'none' } });
  applyBtn = el('button', {
    class: 'tool', dataset: { tool: 'card-apply' },
    title: '카드를 RisuAI에 반영 · 복제 봇 생성 · 기준선으로 되돌리기',
  }, [
    el('span', { class: 'glyph', text: TOOL.apply }),
    el('span', { class: 'tool-label', text: '반영' }),
    applyBadge,
  ]) as HTMLButtonElement;
  applyBtn.addEventListener('click', () => { if (applyBtn) openApply(applyBtn); });

  const snap = el('button', {
    class: 'tool', dataset: { tool: 'card-snapshot' },
    title: '카드·봇 로어북·스크립트를 봇 스냅샷으로 저장합니다',
  }, [
    el('span', { class: 'glyph', text: TOOL.snapshot }),
    el('span', { class: 'tool-label', text: '스냅샷' }),
  ]);
  snap.addEventListener('click', async () => {
    (snap as HTMLButtonElement).disabled = true;
    try {
      await state.cardCheckpoint('수동');
      shellNotice('봇 스냅샷을 저장했습니다. 🕘 버전에서 되돌릴 수 있습니다.', 'ok');
    } catch (e) {
      shellNotice('봇 스냅샷 저장에 실패했습니다: ' + msg(e), 'err');
    } finally {
      (snap as HTMLButtonElement).disabled = false;
    }
  });

  const versions = el('button', {
    class: 'tool', dataset: { tool: 'card-versions' },
    title: '봇 스냅샷 목록에서 되돌리기',
  }, [
    el('span', { class: 'glyph', text: TOOL.versions }),
    el('span', { class: 'tool-label', text: '버전' }),
  ]);
  versions.addEventListener('click', () => void openVersions(versions));

  summaryEl = el('span', { class: 'dim changesum', title: '이 봇의 카드에서 아직 RisuAI에 쓰지 않은 변경' });

  bar = el('div', { class: 'toolrow botbar' }, [applyBtn, snap, versions, summaryEl]);
  refreshBotBar();
  return bar;
}

/** Redraw the counts; the shell calls this on every state change. */
export function refreshBotBar(): void {
  if (!bar || !summaryEl || !applyBadge || !applyBtn) return;
  const c = state.botChanges;
  const parts = describe(c);
  summaryEl.textContent = parts.length ? parts.join(' · ') : (state.botKey ? '변경 없음' : '');
  const total = c?.total ?? 0;
  applyBadge.textContent = String(total);
  applyBadge.style.display = total ? '' : 'none';
  const blocked = applyBlockReason();
  applyBtn.classList.toggle('dimmed', !!blocked);
  applyBtn.title = blocked
    ? blocked + ' (복제·되돌리기는 눌러서 쓸 수 있습니다)'
    : '카드를 RisuAI에 반영 · 복제 봇 생성 · 기준선으로 되돌리기';
}

function describe(c: CardChanges | null): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.fields) out.push(`메타 ${c.fields}`);
  const g = c.greetings;
  if (g.total) out.push('인사말 ' + counts(g));
  const l = c.lore;
  if (l.total) out.push('로어북 ' + counts(l));
  if (c.customscript.total) out.push('Regex ' + counts(c.customscript));
  if (c.triggerscript.total) out.push('트리거 ' + counts(c.triggerscript));
  if (c.actions) out.push(`제안 ${c.actions} 대기`);
  return out;
}

function counts(x: { added: number; edited: number; deleted: number }): string {
  const bits: string[] = [];
  if (x.added) bits.push(`+${x.added}`);
  if (x.edited) bits.push(`~${x.edited}`);
  if (x.deleted) bits.push(`−${x.deleted}`);
  return bits.join(' ');
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- 반영 (popover) -----------------------------------------------------------

function openApply(anchor: HTMLElement): void {
  const out = el('div', { class: 'hint' });
  const body = el('div', { class: 'applypop' });
  const close = popover(anchor, body);

  const lines = describe(state.botChanges);
  body.appendChild(el('div', { class: 'hint', text: lines.length ? lines.join(' · ') : '반영할 변경이 없습니다.' }));
  const blocked = applyBlockReason();
  if (blocked) body.appendChild(el('div', { class: 'notice', text: blocked }));

  const apply = el('button', { class: 'primary', text: 'RisuAI에 반영' }) as HTMLButtonElement;
  apply.disabled = !!blocked;
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      const r = await state.cardWriteBack();
      if (r.mode === 'noop') {
        out.textContent = '반영할 변경이 없습니다.';
      } else {
        shellNotice('카드를 RisuAI에 반영했습니다. 이 상태가 새 기준선이 됩니다.', 'ok');
        close();
      }
    } catch (e) {
      const m = msg(e);
      out.textContent = m;
      void clientLog('error', 'cardWriteBack failed', { error: m });
      shellNotice('카드 반영에 실패했습니다: ' + m, 'err');
    } finally {
      apply.disabled = !!applyBlockReason();
    }
  });

  const nameInput = el('input', {
    value: (state.workspace?.characterName || '봇') + ' (복제)',
    placeholder: '복제 봇 이름',
  }) as HTMLInputElement;
  const clone = el('button', { text: '복제 봇 생성' }) as HTMLButtonElement;
  clone.addEventListener('click', async () => {
    clone.disabled = true;
    try {
      const name = nameInput.value.trim() || '복제 봇';
      await state.cloneBot(name);
      shellNotice(`복제 봇 “${name}” 을 만들었습니다. 편집본이 담겼고, 에셋은 원본과 공유합니다. `
        + 'RisuAI 목록에서 확인해 주세요.', 'ok');
      close();
    } catch (e) {
      void clientLog('error', 'cloneBot failed', { error: msg(e) });
      shellNotice('복제에 실패했습니다: ' + msg(e), 'err');
    } finally {
      clone.disabled = false;
    }
  });

  const reset = el('button', { class: 'ghost' });
  armed(reset, '기준선으로 되돌리기', '정말 되돌릴까요?', async () => {
    try {
      await state.cardReset();
      shellNotice('카드 작업본을 기준선으로 되돌렸습니다.', 'ok');
      close();
    } catch (e) {
      shellNotice('되돌리기에 실패했습니다: ' + msg(e), 'err');
    }
  });

  body.appendChild(el('div', { class: 'row' }, [apply]));
  body.appendChild(el('div', { class: 'row' }, [nameInput, clone]));
  body.appendChild(el('div', { class: 'row' }, [reset]));
  body.appendChild(out);
  body.appendChild(el('div', {
    class: 'hint',
    text: '메타·인사말·봇 로어북·Regex·트리거가 한 번에 쓰입니다. 챗은 절대 건드리지 않습니다. '
      + '복제 봇은 새 캐릭터로 만들어지며 처음 한 번 db 권한 허용이 필요합니다.',
  }));
}

// --- 버전 (popover) -----------------------------------------------------------

async function openVersions(anchor: HTMLElement): Promise<void> {
  const body = el('div', { class: 'verlist' }, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
  const close = popover(anchor, body);
  try {
    const cps = await state.cardCheckpoints();
    clear(body);
    if (!cps.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 봇 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
      return;
    }
    for (const c of cps.slice(0, 12)) {
      const b = el('button', { class: 'ghost tiny', text: '되돌리기' });
      b.addEventListener('click', async () => {
        (b as HTMLButtonElement).disabled = true;
        try {
          await state.cardRestore(c.id);
          close();
          shellNotice('카드·봇 로어북·스크립트를 되돌렸습니다. 되돌리기 직전 상태도 스냅샷으로 남겨 두었습니다.', 'ok');
        } catch (e) {
          shellNotice('복원에 실패했습니다: ' + msg(e), 'err');
        }
      });
      body.appendChild(el('div', { class: 'verrow' }, [
        el('div', { class: 'grow' }, [
          el('div', { text: c.label || '(무제)' }),
          el('div', { class: 'hint', text: fmtTime(c.created_at * 1000) }),
        ]),
        b,
      ]));
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: msg(e) }));
  }
}
