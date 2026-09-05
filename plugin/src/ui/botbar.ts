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
import { shellNotice, openSnapshotName, snapshotCleanup } from './chatbar';
import { clientLog } from '../transport';
import { openConflicts } from './conflicts';
import { syncPendingChip } from './pendingpop';

let bar: HTMLElement | null = null;
let applyBtn: HTMLButtonElement | null = null;
let discardBtn: HTMLButtonElement | null = null;
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
    title: '카드를 RisuAI에 반영 · 새 봇으로 저장',
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

  // The chat bar's 변경 취소, for the card. See there for why it is a bar
  // verb and not a popover row.
  discardBtn = el('button', {
    class: 'tool', dataset: { tool: 'card-discard' },
    title: '카드의 미반영 변경(메타·인사말·봇 로어북·스크립트)을 모두 버리고 RisuAI 상태로 되돌립니다',
    style: { display: 'none' },
  }) as HTMLButtonElement;
  armed(discardBtn, TOOL.discard + ' 변경 취소', '정말 버릴까요?', async () => {
    try {
      const n = await state.cardReset();
      shellNotice('카드의 미반영 변경을 버렸습니다' + (n ? ` (${n}건)` : '')
        + '. 작업본이 기준선(RisuAI 상태)으로 돌아갔습니다.', 'ok');
    } catch (e) {
      shellNotice('변경 취소에 실패했습니다: ' + msg(e), 'err');
    }
  });

  summaryEl = el('span', { class: 'dim changesum', title: '이 봇의 카드에서 아직 RisuAI에 쓰지 않은 변경' });

  bar = el('div', { class: 'toolrow botbar' }, [applyBtn, snap, versions, discardBtn, charxBtn, summaryEl]);
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
  syncPendingChip(summaryEl, c?.actions || 0);
  const total = c?.total ?? 0;
  applyBadge.textContent = String(total);
  applyBadge.style.display = total ? '' : 'none';
  if (discardBtn) discardBtn.style.display = total || (c?.conflicts ?? 0) ? '' : 'none';
  const blocked = applyBlockReason();
  applyBtn.classList.toggle('dimmed', !!blocked);
  if (charxBtn) {
    const cb = charxBlockReason();
    charxBtn.classList.toggle('dimmed', !!cb);
    charxBtn.title = cb ? cb : '작업본 카드와 스토어의 에셋으로 charx 파일을 만듭니다';
  }
  applyBtn.title = blocked
    ? blocked + ' (새 봇으로 저장은 눌러서 쓸 수 있습니다)'
    : '카드를 RisuAI에 반영 · 새 봇으로 저장';
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

  // Same gate as the chat bar: a row both sides changed has to be decided
  // before either answer can be written.
  const conflicts = state.botChanges?.conflicts ?? 0;
  if (conflicts) {
    const open = el('button', { class: 'ghost tiny', text: `충돌 ${conflicts}건 정리` });
    open.addEventListener('click', () => {
      close();
      openConflicts('card', () => { void state.refreshBotChanges(); });
    });
    body.appendChild(el('div', { class: 'notice' }, [
      el('div', { text: `RisuAI 쪽에서도 바뀐 항목이 ${conflicts}건 있습니다. 먼저 정리해 주세요.` }),
      el('div', { class: 'row', style: { marginTop: '6px' } }, [open]),
    ]));
  }

  const apply = el('button', { class: 'primary', text: 'RisuAI에 반영' }) as HTMLButtonElement;
  apply.disabled = !!blocked || conflicts > 0;
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    try {
      const r = await state.cardWriteBack();
      if (r.mode === 'noop') {
        out.textContent = '반영할 변경이 없습니다.';
      } else if (!r.verified) {
        // The write did not stick (see host.WriteResult.verified). Nothing
        // was committed, nothing re-read: the edits are still here.
        const m = 'RisuAI 가 이 쓰기를 받지 않았습니다'
          + (r.drift ? ` (${r.drift})` : '')
          + '. 편집 내용은 그대로 두었습니다. RisuAI 가 다른 창이나 기기에 열려 있지 않은지 확인해 주세요.';
        out.textContent = m;
        void clientLog('error', 'cardWriteBack unverified', { drift: r.drift ?? '' });
        shellNotice(m, 'err');
      } else {
        shellNotice('카드를 RisuAI에 반영하고 다시 읽었습니다.', 'ok');
        close();
      }
    } catch (e) {
      const m = msg(e);
      out.textContent = m;
      void clientLog('error', 'cardWriteBack failed', { error: m });
      shellNotice('카드 반영에 실패했습니다: ' + m, 'err');
    } finally {
      apply.disabled = !!applyBlockReason()
        || (state.botChanges?.conflicts ?? 0) > 0;
    }
  });

  // 새 봇으로 저장: the bot as RisuAI has it now is kept as "(백업)", the
  // edits go into this bot and become its baseline, editing carries on here.
  // It replaced "복제 봇 생성" (a clone of the edited card next to an
  // untouched original), which left the user in a new bot with an empty
  // workspace and the old one still showing every change as pending.
  const nameInput = el('input', {
    value: (state.workspace?.characterName || '봇') + ' (백업)',
    placeholder: '백업 봇 이름',
  }) as HTMLInputElement;
  const saveNew = el('button', { text: '새 봇으로 저장', title: '기준선(편집 전, RisuAI 가 지금 들고 있는 카드)을 백업 봇으로 복제한 뒤, 편집 중인 내용을 이 봇에 반영하고 계속 편집합니다' }) as HTMLButtonElement;
  saveNew.disabled = !!blocked;
  saveNew.addEventListener('click', async () => {
    saveNew.disabled = true;
    const was = saveNew.textContent;
    // The popover itself reports: the shell notice sits above the tabs and
    // is easy to miss, and the backup can wait on RisuAI's permission prompt
    // (the panel steps aside for it and comes back).
    saveNew.textContent = '저장 중…';
    out.textContent = '백업 봇을 만드는 중입니다. RisuAI 가 db 권한을 물으면 허용해 주세요.';
    try {
      const backup = nameInput.value.trim() || '백업';
      const r = await state.saveAsNewBot(backup);
      const said = `현재 편집 중인 봇을 새 봇으로 저장하였습니다. 기존 봇은 “${backup}” 이름으로 복제되었습니다.`
        + (r.mode === 'noop' ? ' (반영할 변경은 없었습니다.)' : ` 변경 ${r.applied}건이 이 봇에 반영되어 새 기준선이 되었습니다.`);
      shellNotice(said, 'ok');
      clear(body);
      const ok = el('button', { class: 'primary tiny', text: '닫기' });
      ok.addEventListener('click', close);
      body.appendChild(el('div', { class: 'notice ok', text: '✔ ' + said }));
      body.appendChild(el('div', { class: 'hint', text: '백업 봇은 RisuAI 봇 목록에 새 캐릭터로 있습니다. 챗도 함께 복사되었고 에셋은 공유합니다.' }));
      body.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } }, [ok]));
    } catch (e) {
      void clientLog('error', 'saveAsNewBot failed', { error: msg(e) });
      shellNotice('새 봇으로 저장하지 못했습니다: ' + msg(e), 'err');
      out.textContent = '저장하지 못했습니다: ' + msg(e);
      saveNew.disabled = !!applyBlockReason();
      saveNew.textContent = was;
    }
  });
  const clone = saveNew;

  body.appendChild(el('div', { class: 'row' }, [apply]));
  body.appendChild(el('div', { class: 'row' }, [nameInput, clone]));
  body.appendChild(out);
  body.appendChild(el('div', {
    class: 'hint',
    text: '반영: 메타·인사말·봇 로어북·Regex·트리거가 한 번에 쓰입니다. 챗은 절대 건드리지 않습니다. '
      + '새 봇으로 저장: 기준선(편집 전 상태)을 백업 봇(챗 포함, 새 캐릭터)으로 남기고 편집본을 이 봇에 반영해 새 기준선으로 삼습니다. 처음 한 번 db 권한 허용이 필요합니다.',
  }));
}

// --- 버전 (popover) -----------------------------------------------------------

async function openVersions(anchor: HTMLElement): Promise<void> {
  const body = el('div', { class: 'verlist' }, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
  const close = popover(anchor, body);
  try {
    const cps = await state.cardCheckpoints();
    clear(body);
    // Same split as the chat bar: named saves are the list, automatic
    // backups fold behind one line.
    const users = cps.filter((c) => c.kind !== 'auto');
    const autos = cps.filter((c) => c.kind === 'auto');
    if (!users.length && !autos.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 봇 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
      return;
    }
    body.appendChild(el('div', { class: 'verrow' }, [
      el('div', { class: 'grow' }, [
        el('div', {}, [el('span', { text: '지금 편집 중인 작업본 ' }), el('span', { class: 'badge now', text: '현재' })]),
        el('div', { class: 'hint', text: '스냅샷이 아닙니다. 아래는 최근 순입니다.' }),
      ]),
    ]));
    if (!users.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 저장한 봇 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
    }
    const verRow = (c: (typeof cps)[number], opts: { newest?: boolean; auto?: boolean }) => {
      const b = el('button', { class: 'ghost tiny', text: '되돌리기', title: '작업본을 이 시점으로 되돌립니다 (직전 상태도 스냅샷으로 남습니다)' });
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
      const title = el('div', {}, [
        el('span', { text: c.label || '(무제)' }),
        opts.newest ? el('span', { class: 'badge', style: { marginLeft: '6px' }, text: '최신 스냅샷' }) : null,
      ]);
      const ren = opts.auto ? null : el('button', { class: 'ghost tiny', text: '✎', title: '이름 바꾸기' });
      ren?.addEventListener('click', () => {
        openSnapshotName(ren, c.label || '', async (label) => {
          await state.renameCardCheckpoint(c.id, label);
          (title.firstChild as HTMLElement).textContent = label;
        });
      });
      const row = el('div', { class: 'verrow' });
      const del = el('button', { class: 'ghost tiny', title: '이 스냅샷 삭제' }) as HTMLButtonElement;
      // The row dims the moment the delete is confirmed: the request itself is
      // milliseconds on the backend, but the round trip from a browser over a
      // tunnel is not, and a row that sits unchanged for a second and then
      // vanishes reads as "nothing happened, then something did".
      armed(del, '✕', '삭제 확인', async () => {
        row.classList.add('deleting');
        del.disabled = true;
        try {
          await state.deleteCardCheckpoint(c.id);
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
          el('div', { class: 'hint', text: fmtTime(c.created_at * 1000) }),
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
      const n = await state.clearCardCheckpoints(keep);
      close();
      shellNotice(`저장한 봇 스냅샷 ${n}개를 지웠습니다.`, 'ok');
    }));
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'hint', text: msg(e) }));
  }
}
