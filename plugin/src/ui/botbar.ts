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
import { shellNotice, openSnapshotName } from './chatbar';
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
  // The asset importer does not hold 반영 any more: text material is
  // written as text, and the store's images are only needed by charx and by
  // asset editing - those two wait (state.assetGateReason), this does not.
  return null;
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
  snap.addEventListener('click', () => {
    openSnapshotName(snap, '수동', async (label) => {
      await state.cardCheckpoint(label);
      shellNotice('봇 스냅샷을 저장했습니다. 🕘 버전에서 이름을 바꾸거나 되돌릴 수 있습니다.', 'ok');
    });
  });

  const versions = el('button', {
    class: 'tool', dataset: { tool: 'card-versions' },
    title: '봇 스냅샷 목록에서 되돌리기',
  }, [
    el('span', { class: 'glyph', text: TOOL.versions }),
    el('span', { class: 'tool-label', text: '버전' }),
  ]);
  versions.addEventListener('click', () => void openVersions(versions));

  charxBtn = el('button', {
    class: 'tool', dataset: { tool: 'card-charx' },
    title: '작업본 카드와 스토어의 에셋으로 charx 파일을 만듭니다',
  }, [
    el('span', { class: 'glyph', text: TOOL.export }),
    el('span', { class: 'tool-label', text: 'charx' }),
  ]) as HTMLButtonElement;
  charxBtn.addEventListener('click', () => { if (charxBtn) openCharx(charxBtn); });

  summaryEl = el('span', { class: 'dim changesum', title: '이 봇의 카드에서 아직 RisuAI에 쓰지 않은 변경' });

  bar = el('div', { class: 'toolrow botbar' }, [applyBtn, snap, versions, charxBtn, summaryEl]);
  refreshBotBar();
  return bar;
}

let charxBtn: HTMLButtonElement | null = null;

/** charx waits for the importer: a zip missing its images is not the card. */
function charxBlockReason(): string | null {
  return state.assetGateReason;
}

// --- charx (popover) -----------------------------------------------------------

function openCharx(anchor: HTMLElement): void {
  const out = el('div', { class: 'outbox' });
  const body = el('div', { class: 'applypop' });
  const close = popover(anchor, body);
  const blocked = charxBlockReason();
  if (blocked) body.appendChild(el('div', { class: 'notice', text: blocked }));

  const nameInput = el('input', {
    value: (state.workspace?.characterName || 'character'), placeholder: '파일 이름 (.charx)',
  }) as HTMLInputElement;
  const build = el('button', { class: 'primary', text: 'charx 만들기' }) as HTMLButtonElement;
  const buildAnyway = el('button', { class: 'ghost', text: '빠진 에셋 빼고 만들기' }) as HTMLButtonElement;
  build.disabled = !!blocked;
  buildAnyway.style.display = 'none';
  const run = async (allowMissing: boolean): Promise<void> => {
    build.disabled = buildAnyway.disabled = true;
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '만드는 중입니다… 에셋이 많으면 몇 분 걸립니다.' }));
    try {
      const r = await state.charxBuild({ allowMissing, name: nameInput.value.trim() });
      clear(out);
      shellNotice(`${r.file} · ${(r.size / 1048576).toFixed(1)}MB · 에셋 ${r.assets}개`
        + (r.dropped ? ` (${r.dropped}개 제외)` : '') + ` — 워크스페이스 파일 탭의 out/ 에서 내 PC에 저장할 수 있습니다.`, 'ok');
      close();
    } catch (e) {
      clear(out);
      const missing = (e as { body?: { missing?: { name: string; type: string }[] } }).body?.missing;
      if (Array.isArray(missing) && missing.length) {
        out.appendChild(el('div', { class: 'notice err', text:
          `에셋 ${missing.length}개가 스토어에 없어 만들지 않았습니다: `
          + missing.slice(0, 6).map((m) => m.name || m.type).join(', ') + (missing.length > 6 ? ' …' : '') }));
        buildAnyway.style.display = '';
      } else {
        out.appendChild(el('div', { class: 'notice err', text: 'charx 를 만들지 못했습니다: ' + msg(e) }));
      }
    } finally {
      build.disabled = !!charxBlockReason();
      buildAnyway.disabled = false;
    }
  };
  build.addEventListener('click', () => { void run(false); });
  buildAnyway.addEventListener('click', () => { void run(true); });

  body.appendChild(el('div', { class: 'hint', text:
    '작업본 카드(메타·인사말·봇 로어북·Regex·트리거·에셋 이름)와 스토어의 이미지로 charx 를 만듭니다. 반영하지 않은 편집도 들어갑니다. '
    + 'module.risum 없이 card.json 에 인라인으로 담기며 RisuAI·PocketRisu 가 그대로 가져옵니다.' }));
  body.appendChild(el('div', { class: 'row' }, [nameInput]));
  body.appendChild(el('div', { class: 'row' }, [build, buildAnyway]));
  body.appendChild(out);
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
  if (charxBtn) {
    const cb = charxBlockReason();
    charxBtn.classList.toggle('dimmed', !!cb);
    charxBtn.title = cb ? cb : '작업본 카드와 스토어의 에셋으로 charx 파일을 만듭니다';
  }
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
  if (c.assetref && c.assetref.total) out.push('에셋 ' + counts(c.assetref));
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
    const was = clone.textContent;
    // The popover itself reports: the shell notice sits above the tabs and
    // is easy to miss, and cloning can wait on RisuAI's permission prompt.
    clone.textContent = '복제 중…';
    out.textContent = '복제하는 중입니다. RisuAI 가 db 권한을 물으면 허용해 주세요.';
    try {
      const name = nameInput.value.trim() || '복제 봇';
      await state.cloneBot(name);
      const said = `복제 봇 “${name}” 을 만들었습니다. 편집본과 챗 전부가 담겼고, 에셋은 원본과 공유합니다. RisuAI 봇 목록에서 확인해 주세요.`;
      shellNotice(said, 'ok');
      clear(body);
      const ok = el('button', { class: 'primary tiny', text: '닫기' });
      ok.addEventListener('click', close);
      body.appendChild(el('div', { class: 'notice ok', text: '✔ ' + said }));
      body.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } }, [ok]));
    } catch (e) {
      void clientLog('error', 'cloneBot failed', { error: msg(e) });
      shellNotice('복제에 실패했습니다: ' + msg(e), 'err');
      out.textContent = '복제에 실패했습니다: ' + msg(e);
      clone.disabled = false;
      clone.textContent = was;
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
      + '복제 봇은 새 캐릭터로 만들어지고 챗도 모두 복사됩니다. 처음 한 번 db 권한 허용이 필요합니다.',
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
      const title = el('div', { text: c.label || '(무제)' });
      const ren = el('button', { class: 'ghost tiny', text: '✎', title: '이름 바꾸기' });
      ren.addEventListener('click', () => {
        openSnapshotName(ren, c.label || '', async (label) => {
          await state.renameCardCheckpoint(c.id, label);
          title.textContent = label;
        });
      });
      body.appendChild(el('div', { class: 'verrow' }, [
        el('div', { class: 'grow' }, [
          title,
          el('div', { class: 'hint', text: fmtTime(c.created_at * 1000) }),
        ]),
        ren, b,
      ]));
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: msg(e) }));
  }
}
