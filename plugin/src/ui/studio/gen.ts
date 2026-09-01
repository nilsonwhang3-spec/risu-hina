/**
 * Generation control: the 요청 설정 modal, the run/cancel/poll loop, and the
 * recent-jobs cache the batch and history tabs draw from.
 *
 * The generate BUTTONS live on the centre tabs (1장 · 배치); what is shared
 * is here. The poll never rebuilds the centre - it hands the heartbeat to
 * hub.jobTick so the visible tab patches its progress in place.
 */
import { el, clear, modal } from '../dom';
import { askName } from '../kit';
import { state, type StudioJob } from '../../state';
import { pickerRow, openListPicker, type PickerEntry } from '../pickers';
import { S, hub, gen, persistGen, activeOf, spec, checkUnresolved, newCard, msg } from './store';

let jobTimer: ReturnType<typeof setInterval> | null = null;
let jobsStale = true;

// --- the live preview (streaming generation) -----------------------------------------
//
// The backend consumes NovelAI's msgpack stream and keeps the newest frame in
// memory; the iframe cannot stream (nativeFetch buffers), so a fast rev-gated
// poll is the transport: unchanged frames answer with the rev alone. The
// frame survives its item's completion on purpose (anti-flicker) - the tab
// swaps it out only once the finished file has loaded.

export const livePreview = { url: '', step: 0, total: 0, current: '' };
/** ms-per-step EMA measured from preview ticks - the server keeps no
 * timestamps, and poll arrival is steady enough at 800ms for an estimate. */
let emaStepMs = 0;
let lastStepAt = 0;
let lastStep = 0;
export function stepMsEma(): number { return emaStepMs; }
let previewTimer: ReturnType<typeof setInterval> | null = null;
let previewRev = 0;

function pollPreview(): void {
  if (previewTimer) return;
  const tick = async () => {
    if (!S.jobId) return stopPreview();
    try {
      const r = await state.studio.jobPreview(S.jobId, previewRev);
      if (r.png && typeof r.rev === 'number') {
        previewRev = r.rev;
        livePreview.url = 'data:image/png;base64,' + r.png;
        livePreview.step = r.step ?? 0;
        livePreview.total = r.total ?? 0;
        livePreview.current = r.current ?? '';
        const now = Date.now();
        const step = r.step ?? 0;
        if (lastStepAt && step > lastStep) {
          const per = (now - lastStepAt) / (step - lastStep);
          emaStepMs = emaStepMs ? emaStepMs * 0.7 + per * 0.3 : per;
        }
        lastStepAt = now;
        lastStep = step;
        hub.jobTick();
      } else if (typeof r.rev === 'number') {
        previewRev = r.rev;
      }
    } catch { /* the 1.5s job poll is the authority; previews are best-effort */ }
  };
  previewTimer = setInterval(() => { void tick(); }, 800);
  void tick();
}

function stopPreview(): void {
  if (previewTimer) { clearInterval(previewTimer); previewTimer = null; }
  previewRev = 0;
  lastStepAt = 0;
  lastStep = 0;
}

/** The account meters and what a run will send, for the 1장 tab's head. */
export function statusRow(): HTMLElement {
  const row = el('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } });
  const nStyles = activeOf('styles').length;
  const nChars = activeOf('characters').length;
  row.appendChild(el('span', { class: 'hint', text: `활성 카드: 스타일 ${nStyles} · 캐릭터 ${nChars}` }));
  const status = S.status;
  if (!status) {
    row.appendChild(el('span', { class: 'hint', text: '상태를 읽는 중입니다…' }));
    return row;
  }
  const acc = status.account;
  if (acc) {
    row.append(
      el('span', { class: 'badge', title: 'Anlas — 레퍼런스 인코딩과 디렉터 툴이 쓰는 잔량',
                   text: `Anlas ${acc.anlas}` }),
      el('span', {
        class: 'badge' + (acc.usageNegative ? ' warn' : ''),
        title: 'v5 사용량 — Anlas 와 별개의 한도입니다',
        text: `v5 ${acc.usagePercent ?? '?'}%`,
      }),
      el('span', { class: 'hint', text: `tier ${acc.tier ?? '?'}` }),
    );
  }
  if (status.error) row.appendChild(el('span', { class: 'hint err', text: status.error }));
  return row;
}

/** The no-token notice - planning and sorting stay usable without one. */
export function tokenNotice(): HTMLElement | null {
  const status = S.status;
  if (!status || status.configured) return null;
  return el('div', { class: 'notice', style: { marginBottom: '6px' } }, [
    el('div', { class: 'hint', text: status.note || status.error || 'NovelAI 토큰이 없습니다.' }),
    el('div', { class: 'hint', style: { marginTop: '4px' },
                text: '토큰 없이도 계획을 세우고, 이미지를 넣고, 정리하고, 봇에 반영할 수 있습니다.' }),
  ]);
}

// --- the 요청 설정 modal ------------------------------------------------------------

export function openParamsDialog(): void {
  const field = (label: string, node: HTMLElement) =>
    el('label', { class: 'field' }, [el('span', { text: label }), node]);
  const two = (a: HTMLElement, b: HTMLElement) => el('div', { class: 'row' }, [a, b]);
  const out = el('div', {});

  const modelInput = el('input', { value: gen.model, placeholder: 'nai-diffusion-4-5-full' }) as HTMLInputElement;
  modelInput.addEventListener('change', () => {
    gen.model = modelInput.value.trim();
    persistGen();
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

  const planBtn = el('button', { class: 'ghost tiny', text: '계획 보기', title: '무엇이 몇 장 생성될지 미리 봅니다 (무료)' });
  planBtn.addEventListener('click', () => void showPlan(out));

  const body = el('div', { class: 'genform' }, [
    field('모델', modelInput),
    el('div', { class: 'row' }, [checkBtn, checkOut]),
    // References follow the cards (refMode + per-image enabled) - no switch.
    refNote(),
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
    textField('시드', 'seed', '비우면 랜덤'),
    textField('저장 폴더', 'folder', 'studio/output/…'),
    el('div', { class: 'row', style: { marginTop: '8px' } }, [planBtn]),
    out,
  ]);
  modal('요청 설정', body, { sticky: true });
}

/**
 * References ride per the CARDS now - each character card's refMode and its
 * per-image enabled flags - so there is no switch here, only the cost said
 * out loud: an encode is 2 Anlas (cached afterwards), a charref generation
 * is 5 Anlas each, and a model that cannot take a reference skips it.
 */
function refNote(): HTMLElement {
  const v5 = !gen.model.includes('diffusion-4');
  const active = (S.cards.characters ?? []).filter((i) => i.enabled);
  const charrefN = active.reduce((n, i) => n + (i.charref ?? 0), 0);
  const vibeN = active.reduce((n, i) => n + (i.vibe ?? 0), 0);
  const text = v5 && (charrefN + vibeN)
    ? '레퍼런스는 카드대로 실리지만, v5 모델은 지원하지 않아 건너뜁니다 — 4.5 를 고르세요.'
    : (charrefN + vibeN)
      ? `레퍼런스는 카드대로 실립니다 — 캐릭터 ${charrefN}장 (장당 5 Anlas) · 바이브 ${vibeN}장 (인코딩 2 Anlas, 캐시 시 0)`
      : '활성 캐릭터 카드에 레퍼런스가 없습니다 — 카드를 열어 이미지를 올려 두면 그대로 실립니다.';
  return el('div', { class: 'hint', style: { marginBottom: '6px' }, text });
}

function numField(label: string, key: 'steps' | 'scale' | 'rescale' | 'width' | 'height'): HTMLElement {
  const i = el('input', { value: String(gen[key]), type: 'number',
                          ...(key === 'rescale' ? { step: '0.05', min: '0', max: '1' } : {}) }) as HTMLInputElement;
  i.addEventListener('change', () => {
    const n = Number(i.value);
    if (!Number.isNaN(n)) gen[key] = n;
    persistGen();
  });
  return el('label', { class: 'field grow' }, [el('span', { text: label }), i]);
}

function textField(label: string, key: 'seed' | 'folder',
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

async function showPlan(out: HTMLElement): Promise<void> {
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

// --- the scene preset dropdown (the batch tab's) -----------------------------------

export function scenePicker(): HTMLElement {
  const items = S.cards.scenes ?? [];
  const cur = items.find((i) => i.path === gen.scenePreset) ?? null;
  const label = (i: { name: string; count?: number }) => i.name + (i.count ? ` (씬 ${i.count})` : '');
  const row = pickerRow(cur ? { name: label(cur) } : null, {
    title: items.length ? `저장된 프리셋 ${items.length}개 — 선택 · 수정 · 삭제 · 추가` : '프리셋 추가',
    emptyHint: items.length ? '선택된 씬 프리셋 없음 — › 에서 고르세요' : '씬 프리셋이 없습니다. › 에서 하나 만들어 주세요.',
    onOpen: () => openListPicker({
      title: '씬 프리셋 선택',
      hint: '불러온 프리셋의 씬 카드에서 필요한 것만 골라 예약에 담습니다.',
      load: async () => [
        { id: '', name: '(없음)', hint: '요청 설정 한 장 구성', selected: !gen.scenePreset, noDelete: true },
        ...items.map((i): PickerEntry => ({
          id: i.path, name: label(i), selected: gen.scenePreset === i.path,
        })),
      ],
      onSelect: async (e) => {
        gen.scenePreset = e.id;
        persistGen();
        checkUnresolved();
        hub.drawCentre();
      },
      onEdit: (e) => {
        if (!e.id) return;
        S.selectedFile = e.id;
        hub.drawCentre();
      },
      onDelete: async (e) => {
        // Cheap on purpose (see the style picker): no listing, no dry plan.
        await state.deleteFile(e.id);
        S.cards.scenes = (S.cards.scenes ?? []).filter((i) => i.path !== e.id);
        let redraw = false;
        if (gen.scenePreset === e.id) { gen.scenePreset = ''; persistGen(); redraw = true; }
        if (S.selectedFile === e.id) { S.selectedFile = ''; redraw = true; }
        if (redraw) hub.drawCentre();
        hub.touchQuiet();
      },
      onCreate: () => {
        askName('새 씬 프리셋', {
          label: '이름이 곧 파일명입니다.',
          placeholder: '예: 감정 세트',
          onSubmit: async (nm) => {
            const path = await newCard('scenes', '', nm);
            if (!path) return;
            gen.scenePreset = path;
            persistGen();
            S.selectedFile = path;
            hub.drawCentre();
          },
        });
      },
      createLabel: '새 프리셋 추가',
    }),
  });
  return el('div', { class: 'field grow' }, [el('span', { text: '씬 프리셋' }), row]);
}

// --- run · cancel · poll -------------------------------------------------------------

/** Start a batch from the current panel setup, with per-call overrides
 * (the 1장 tab passes `{ scenePreset: '', count: n }`). */
export async function startRun(overrides: Record<string, unknown> = {}): Promise<void> {
  try {
    const body = { ...spec(), ...overrides };
    if (!body.scenePreset) delete body.scenePreset;
    const r = await state.studio.generate(body);
    S.jobId = r.jobId;
    S.queueJob = null;
    S.viewPath = '';
    jobsStale = true;
    hub.notice(`배치를 시작했습니다 (${r.total}장). ${r.estimate.note}`, 'ok');
    hub.drawCentre();
    void pollJob();
    pollPreview();
  } catch (e) {
    hub.notice('시작하지 못했습니다: ' + msg(e), 'err');
  }
}

export function cancelRun(): void {
  if (S.jobId) void state.studio.cancelJob(S.jobId);
}

/** How many images the live job still owes (for the 취소 (n) label). */
export function pendingCount(): number {
  const p = S.queueJob?.payload;
  if (!p) return 0;
  return Math.max(0, p.total - p.done - (p.failed?.length ?? 0));
}

/** Recent jobs for the batch/history tabs, cached until a run finishes. */
export async function loadJobs(force = false): Promise<StudioJob[]> {
  if (!force && !jobsStale && S.jobs.length) return S.jobs;
  try {
    S.jobs = (await state.studio.jobs()).jobs ?? [];
    jobsStale = false;
    // A batch the AGENT started (or one from another window) is not ours to
    // know about otherwise: adopt the running one so the history section
    // updates live and the buttons read 취소.
    if (!S.jobId) {
      const running = S.jobs.find((j) => j.state === 'running' || j.state === 'pending');
      if (running) {
        S.jobId = running.id;
        S.queueJob = running;
        void pollJob();
      }
    }
  } catch { /* keep what we have */ }
  return S.jobs;
}

export function markJobsStale(): void {
  jobsStale = true;
}

/**
 * Poll the batch. The backend runs the work and this asks how far it got;
 * the visible tab draws the progress (hub.jobTick), and the finish reports,
 * re-reads the library, and refreshes the meters.
 */
export async function pollJob(): Promise<void> {
  if (S.jobId) pollPreview();
  if (jobTimer) return;
  const tick = async () => {
    if (!S.jobId) return stop();
    let j;
    try {
      j = await state.studio.job(S.jobId);
    } catch {
      return stop();
    }
    S.queueJob = j;
    if (['done', 'partial', 'error', 'cancelled'].includes(j.state)) {
      const spent = j.result?.anlasSpent;
      hub.notice(`배치 ${j.state} — ${j.result?.saved ?? 0}장 저장`
        + (j.result?.failed ? `, ${j.result.failed}장 실패` : '')
        + (typeof spent === 'number' ? ` · Anlas ${spent} 소모` : ''),
        j.state === 'error' ? 'err' : 'ok');
      S.jobId = '';
      jobsStale = true;
      stop();
      stopPreview();
      // The last streamed frame is HELD (anti-flicker): the tab lets go of it
      // only once the finished file's blob has loaded in its place.
      hub.jobTick();
      // The batch wrote images: the files tab gets the news (and the unseen
      // badge) while we re-read our own slice.
      hub.touchQuiet(j.payload?.saved ?? []);
      await hub.refresh();
      await hub.loadStatus();
      return;
    }
    hub.jobTick();
  };
  const stop = () => { if (jobTimer) { clearInterval(jobTimer); jobTimer = null; } };
  jobTimer = setInterval(() => { void tick(); }, 1500);
  await tick();
}
