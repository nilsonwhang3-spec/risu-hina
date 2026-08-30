/**
 * The generation card, the run/poll loop, and the live queue view.
 *
 * The card sits under the tree because none of it changes inside one batch:
 * the ACTIVE cards say what is drawn, this card says how. The two meters live
 * here too — Anlas and the v5 quota are different currencies and neither is
 * derived from the other, so both are shown as NovelAI reports them
 * (docs/09 §2).
 */
import { el, clear } from '../dom';
import { state } from '../../state';
import { workspaceImage } from '../blobimg';
import { S, hub, gen, persistGen, activeOf, spec, checkUnresolved, msg, stateLabel } from './store';

let jobTimer: ReturnType<typeof setInterval> | null = null;

export function drawGen(): void {
  const genMount = S.genMount;
  if (!genMount) return;
  clear(genMount);
  genMount.appendChild(el('div', { class: 'sectionline' }));
  genMount.appendChild(el('div', { class: 'sectiontitle', text: '생성' }));

  // What a run will actually send: the active cards, said out loud so the
  // list on the left and the request stay one thing - with or without a token.
  const nStyles = activeOf('styles').length;
  const nChars = activeOf('characters').length;
  genMount.appendChild(el('div', { class: 'hint', style: { margin: '4px 0' },
    text: `활성 카드: 스타일 ${nStyles} · 캐릭터 ${nChars} — 위 목록의 체크가 배치에 실립니다` }));

  const status = S.status;
  if (!status) {
    genMount.appendChild(el('div', { class: 'hint', text: '상태를 읽는 중입니다…' }));
    return;
  }
  // No token hides only the run button: planning is free (the dry plan never
  // spends), and the setup someone types should not vanish with the notice.
  if (!status.configured) {
    genMount.appendChild(el('div', { class: 'notice' }, [
      el('div', { class: 'hint', text: status.note || status.error || 'NovelAI 토큰이 없습니다.' }),
      el('div', { class: 'hint', style: { marginTop: '4px' },
                  text: '토큰 없이도 계획을 세우고, 이미지를 넣고, 정리하고, 봇에 반영할 수 있습니다.' }),
    ]));
  }
  const acc = status.account;
  if (acc) {
    genMount.appendChild(el('div', { class: 'row', style: { gap: '8px' } }, [
      el('span', { class: 'badge', title: 'Anlas — 레퍼런스 인코딩과 디렉터 툴이 쓰는 잔량',
                   text: `Anlas ${acc.anlas}` }),
      el('span', {
        class: 'badge' + (acc.usageNegative ? ' warn' : ''),
        title: 'v5 사용량 — Anlas 와 별개의 한도입니다',
        text: `v5 ${acc.usagePercent ?? '?'}%`,
      }),
      el('span', { class: 'hint', text: `tier ${acc.tier ?? '?'}` }),
    ]));
  }
  if (status.error) genMount.appendChild(el('div', { class: 'hint err', text: status.error }));

  const field = (label: string, node: HTMLElement) =>
    el('label', { class: 'field' }, [el('span', { text: label }), node]);

  const modelInput = el('input', { value: gen.model, placeholder: 'nai-diffusion-4-5-full' }) as HTMLInputElement;
  modelInput.addEventListener('change', () => {
    gen.model = modelInput.value.trim();
    persistGen();
    refSync?.();
  });
  const checkBtn = el('button', { class: 'ghost tiny', text: '확인' }) as HTMLButtonElement;
  const checkOut = el('span', { class: 'hint' });
  // Free, and the only thing that knows the model list is the service itself
  // (docs/09 §5) - so this asks rather than validating against a list here.
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    checkOut.textContent = '확인 중…';
    try {
      const r = await state.studio.modelCheck(modelInput.value.trim());
      checkOut.textContent = r.exists
        ? (r.supportsVibe ? '있음 · 레퍼런스 가능' : '있음 · 레퍼런스 불가(v5)')
        : '그런 모델이 없습니다';
    } catch (e) {
      checkOut.textContent = msg(e);
    } finally {
      checkBtn.disabled = false;
    }
  });

  const two = (a: HTMLElement, b: HTMLElement) => el('div', { class: 'row' }, [a, b]);

  // 요청 설정: everything a request carries beyond "what and how many" - the
  // model, the reference switch, and the sampling parameters - folded away so
  // the daily controls stay at the top. Its open/closed state is remembered.
  const req = el('details', { class: 'advbox' }, [
    el('summary', { text: '요청 설정' }),
    field('모델', modelInput),
    el('div', { class: 'row' }, [checkBtn, checkOut]),
    referenceToggle(),
    two(numField('스텝', 'steps'), numField('CFG', 'scale')),
    two(numField('Rescale', 'rescale'), selField('샘플러', 'sampler', [
      'k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m_sde',
      'k_dpmpp_2m', 'k_dpmpp_sde', 'ddim_v3'])),
    two(selField('스케줄', 'schedule', ['karras', 'native', 'exponential', 'polyexponential']),
        selField('UC 프리셋', 'ucPreset', [], [
          { value: 0, label: 'Heavy' }, { value: 1, label: 'Light' },
          { value: 3, label: 'Human Focus' }, { value: 4, label: '없음' }])),
    two(numField('가로', 'width'), numField('세로', 'height')),
    qualityToggle(),
  ]) as HTMLDetailsElement;
  try { req.open = localStorage.getItem('hina.studioReqOpen') === '1'; } catch { /* fine */ }
  req.addEventListener('toggle', () => {
    try { localStorage.setItem('hina.studioReqOpen', req.open ? '1' : '0'); } catch { /* fine */ }
  });

  genMount.append(
    scenePicker(),
    two(numField('장수', 'count'), textField('시드', 'seed', '비우면 랜덤')),
    textField('캐릭터명', 'characterName', '파일 이름에 들어갑니다 (비우면 생략)'),
    textField('저장 폴더', 'folder', 'studio/images/…'),
    req,
  );

  const planBtn = el('button', { class: 'ghost tiny', text: '계획 보기' }) as HTMLButtonElement;
  const queueBtn = el('button', { class: 'ghost tiny', text: '큐', title: '생성 큐와 최근 작업' }) as HTMLButtonElement;
  const runBtn = el('button', { class: 'primary tiny', text: '생성 시작' }) as HTMLButtonElement;
  planBtn.addEventListener('click', () => void showPlan());
  queueBtn.addEventListener('click', () => { S.queueView = true; hub.drawCentre(); });
  runBtn.addEventListener('click', () => void run());
  genMount.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } },
                          [planBtn, queueBtn, status.configured ? runBtn : null]));
  genMount.appendChild(el('div', { class: 'genstatus' }));
  if (S.jobId) void pollJob();
}

/** The scene preset <select> - the one thing still picked per run. */
function scenePicker(): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  sel.appendChild(el('option', { value: '', text: '(없음)' }));
  for (const it of S.cards.scenes ?? []) {
    const o = el('option', { value: it.path, text: it.name + (it.count ? ` (${it.count})` : '') });
    if (it.path === gen.scenePreset) o.setAttribute('selected', 'selected');
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => { gen.scenePreset = sel.value; persistGen(); checkUnresolved(); });
  return el('label', { class: 'field' }, [el('span', { text: 'SD스튜디오 프리셋' }), sel]);
}

/**
 * Whether this batch uses the active characters' reference presets.
 *
 * Off by default and labelled with its price, because this is the one control
 * on the card that certainly spends Anlas: an encode is 2 each, and v5 cannot
 * do it at all (docs/09 §7). The encoding is cached, so a second batch with
 * the same reference costs nothing. Strength and 충실도 live on each card.
 */
let refSync: (() => void) | null = null;

function referenceToggle(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = gen.useReference;
  const why = el('div', { class: 'hint' });
  const sync = () => {
    gen.useReference = box.checked;
    const v5 = !gen.model.includes('diffusion-4');
    // Both kinds count: a card carries charrefs OR vibes (refMode), and the
    // listing already reports only the side that will ride.
    const active = (S.cards.characters ?? []).filter((i) => i.enabled);
    const charrefN = active.reduce((n, i) => n + (i.charref ?? 0), 0);
    const vibeN = active.reduce((n, i) => n + (i.vibe ?? 0), 0);
    why.textContent = v5
      ? 'v5 모델은 레퍼런스를 지원하지 않습니다 — 4.5 를 고르세요.'
      : !(charrefN + vibeN)
        ? '활성 캐릭터 카드에 레퍼런스가 없습니다 — 카드를 열어 이미지를 올려 두세요.'
        : (box.checked
            ? `캐릭터 ${charrefN}장 (장당 5 Anlas) · 바이브 ${vibeN}장 (인코딩 2 Anlas, 캐시 시 0)`
            : '');
  };
  box.addEventListener('change', () => { sync(); persistGen(); });
  refSync = sync;
  sync();
  return el('div', {}, [
    el('label', { class: 'row' }, [box, el('span', { text: '레퍼런스 사용 (활성 카드대로)' })]),
    why,
  ]);
}

function numField(label: string, key: 'steps' | 'scale' | 'rescale' | 'width' | 'height' | 'count'): HTMLElement {
  const i = el('input', { value: String(gen[key]), type: 'number',
                          ...(key === 'rescale' ? { step: '0.05', min: '0', max: '1' } : {}) }) as HTMLInputElement;
  i.addEventListener('change', () => {
    const n = Number(i.value);
    if (!Number.isNaN(n)) gen[key] = n;
    persistGen();
  });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function textField(label: string, key: 'seed' | 'characterName' | 'folder',
                   placeholder = ''): HTMLElement {
  const i = el('input', { value: gen[key], placeholder }) as HTMLInputElement;
  i.addEventListener('change', () => { gen[key] = i.value; persistGen(); });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function selField(label: string, key: 'sampler' | 'schedule' | 'ucPreset', values: string[],
                  options?: { value: number; label: string }[]): HTMLElement {
  const sel = el('select') as HTMLSelectElement;
  for (const o of options ?? values.map((v) => ({ value: v as string | number, label: v }))) {
    const opt = el('option', { value: String(o.value), text: String(o.label) });
    if (String(gen[key]) === String(o.value)) opt.setAttribute('selected', 'selected');
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => {
    if (key === 'ucPreset') gen.ucPreset = Number(sel.value) || 0;
    else gen[key] = sel.value;
    persistGen();
  });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), sel]);
}

function qualityToggle(): HTMLElement {
  const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
  box.checked = gen.quality;
  box.addEventListener('change', () => { gen.quality = box.checked; persistGen(); });
  return el('label', { class: 'row', title: '켜면 very aesthetic, masterpiece, no text 가 뒤에 붙습니다' },
            [box, el('span', { text: '퀄리티 태그' })]);
}

async function showPlan(): Promise<void> {
  const out = S.genMount?.querySelector('.genstatus') as HTMLElement | null;
  if (!out) return;
  clear(out);
  try {
    const r = await state.studio.plan(spec());
    out.appendChild(el('div', { class: 'hint', text: `${r.items.length}장 · ${r.estimate.note}` }));
    // A `<collection.key>` no fragment provides is left in the prompt and
    // said out loud: it would otherwise generate happily and wrongly.
    const unresolved = [...new Set(r.items.flatMap((i) => i.unresolved ?? []))];
    if (unresolved.length) {
      out.appendChild(el('div', { class: 'notice err' }, [
        el('div', { text: `조각을 찾지 못한 참조 ${unresolved.length}개` }),
        el('div', { class: 'hint', text: unresolved.join(', ') }),
        el('div', { class: 'hint', text: '조각 프롬프트에 그 이름의 컬렉션을 만들어 주세요. 지금 생성하면 프롬프트에 그대로 들어갑니다.' }),
      ]));
    }
    for (const i of r.items.slice(0, 12)) {
      out.appendChild(el('div', { class: 'hint', text: `${i.name}  seed=${i.seed ?? '랜덤'}` }));
    }
    if (r.items.length > 12) out.appendChild(el('div', { class: 'hint', text: `… 이하 ${r.items.length - 12}개 생략` }));
  } catch (e) {
    out.appendChild(el('div', { class: 'hint err', text: msg(e) }));
  }
}

async function run(): Promise<void> {
  try {
    const r = await state.studio.generate(spec());
    S.jobId = r.jobId;
    hub.notice(`배치를 시작했습니다 (${r.total}장). ${r.estimate.note}`, 'ok');
    S.queueView = true;
    S.queueJob = null;
    hub.drawCentre();
    void pollJob();
  } catch (e) {
    hub.notice('시작하지 못했습니다: ' + msg(e), 'err');
  }
}

/**
 * The live queue, in the centre pane - one row per planned image with where
 * it stands (완료 with its thumbnail, 실패 with the error, 생성 중, 대기).
 * The 1.5s job poll redraws it; the data is the job payload the backend
 * already keeps, plus its `current` marker.
 */
export function drawQueue(): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  clear(viewMount);
  const back = el('button', { class: 'ghost tiny', text: '← 나가기' });
  back.addEventListener('click', () => { S.queueView = false; hub.drawCentre(); });
  const j = S.queueJob;
  const head = el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    back,
    el('span', { class: 'sectiontitle grow', text: '생성 큐' + (j ? ` — ${stateLabel(j.state)}` : '') }),
  ]);
  viewMount.appendChild(head);
  if (!j || !j.payload) {
    viewMount.appendChild(el('div', { class: 'hint',
      text: S.jobId ? '읽는 중입니다…' : '진행 중인 배치가 없습니다.' }));
    void drawRecentJobs();
    return;
  }
  const p = j.payload;
  const running = j.state === 'running' || j.state === 'pending';
  const bits: string[] = [`${p.done}/${p.total}`];
  if (j.created_at) bits.push(`${Math.max(0, Math.round(Date.now() / 1000 - j.created_at))}s 경과`);
  const spent = j.result?.anlasSpent;
  if (typeof spent === 'number') bits.push(`Anlas ${spent} 소모`);
  head.appendChild(el('span', { class: 'hint', text: bits.join(' · ') }));
  if (running) {
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { void state.studio.cancelJob(j.id); });
    head.appendChild(cancel);
  }
  if (j.error) viewMount.appendChild(el('div', { class: 'notice err', text: j.error }));

  const savedBy = new Map<string, string>();
  for (const path of p.saved ?? []) savedBy.set(path.split('/').pop() ?? path, path);
  const failedBy = new Map((p.failed ?? []).map((f) => [f.name, f.error] as const));
  const list = el('div', { class: 'verlist' });
  for (const it of p.items ?? []) {
    let badge: HTMLElement;
    let pic: HTMLElement | null = null;
    const full = savedBy.get(it.name);
    if (failedBy.has(it.name)) {
      badge = el('span', { class: 'badge err', text: '실패' });
    } else if (full) {
      badge = el('span', { class: 'badge ok', text: '완료' });
      pic = workspaceImage(full, it.name, { thumb: true });
    } else if (running && p.current === it.name) {
      badge = el('span', { class: 'badge warn', text: '생성 중' });
    } else {
      badge = el('span', { class: 'badge', text: running ? '대기' : '—' });
    }
    list.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px', padding: '3px 0' } }, [
      badge, pic, el('span', { class: 'grow hint', text: it.name }),
    ]));
    const err = failedBy.get(it.name);
    if (err) list.appendChild(el('div', { class: 'hint err', style: { paddingLeft: '8px' }, text: err }));
  }
  viewMount.appendChild(list);
  if (!running) void drawRecentJobs();
}

/** The last few batches - a way back into a finished queue's detail. */
async function drawRecentJobs(): Promise<void> {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  const box = el('div', {});
  viewMount.appendChild(box);
  let jobs;
  try {
    jobs = (await state.studio.jobs()).jobs ?? [];
  } catch { return; }
  if (!box.isConnected || !jobs.length) return;
  box.appendChild(el('div', { class: 'sectiontitle', style: { marginTop: '12px' }, text: '최근 작업' }));
  for (const r of jobs) {
    if (S.queueJob && r.id === S.queueJob.id) continue;
    const row = el('div', { class: 'chatitem', style: { cursor: 'pointer' }, title: '이 배치의 큐 보기' }, [
      el('span', { class: 'grow', text: `${stateLabel(r.state)} · ${r.payload?.done ?? 0}/${r.payload?.total ?? 0}` }),
      el('span', { class: 'hint', text: r.id }),
    ]);
    row.addEventListener('click', () => { S.queueJob = r; drawQueue(); });
    box.appendChild(row);
  }
}

/**
 * Poll the batch. The same shape the panel already uses for permits and the
 * asset importer - the backend runs the work and this asks how far it got.
 */
export async function pollJob(): Promise<void> {
  if (jobTimer) return;
  const tick = async () => {
    const out = S.genMount?.querySelector('.genstatus') as HTMLElement | null;
    if (!S.jobId || !out) return stop();
    let j;
    try {
      j = await state.studio.job(S.jobId);
    } catch {
      return stop();
    }
    const p = j.payload;
    S.queueJob = j;
    if (S.queueView) drawQueue();
    clear(out);
    const line = el('div', { class: 'hint', style: { cursor: 'pointer' },
                             title: '진행 상황을 중앙에 크게 봅니다',
                             text: `${stateLabel(j.state)} · ${p?.done ?? 0}/${p?.total ?? 0}` });
    line.addEventListener('click', () => { S.queueView = true; hub.drawCentre(); });
    out.appendChild(line);
    for (const f of (p?.failed ?? []).slice(0, 3)) {
      out.appendChild(el('div', { class: 'hint err', text: `${f.name}: ${f.error}` }));
    }
    if (['done', 'partial', 'error', 'cancelled'].includes(j.state)) {
      const spent = j.result?.anlasSpent;
      hub.notice(`배치 ${j.state} — ${j.result?.saved ?? 0}장 저장`
        + (j.result?.failed ? `, ${j.result.failed}장 실패` : '')
        + (typeof spent === 'number' ? ` · Anlas ${spent} 소모` : ''),
        j.state === 'error' ? 'err' : 'ok');
      S.jobId = '';
      stop();
      // The batch wrote images: the files tab gets the news (and the unseen
      // badge) while we re-read our own slice.
      hub.touchQuiet(p?.saved ?? []);
      await hub.refresh();
      await hub.loadStatus();
      return;
    }
    const cancel = el('button', { class: 'ghost tiny', text: '중단' });
    cancel.addEventListener('click', () => { void state.studio.cancelJob(S.jobId); });
    out.appendChild(cancel);
  };
  const stop = () => { if (jobTimer) { clearInterval(jobTimer); jobTimer = null; } };
  jobTimer = setInterval(() => { void tick(); }, 1500);
  await tick();
}
