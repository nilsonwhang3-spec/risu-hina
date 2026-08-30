/**
 * The 배치 tab: reservations in, results out - BY JOB.
 *
 * The queue is a MAP, not a formula: reserves[preset][scene][cast] = count.
 * Each scene card piles up its own counts per cast (씬 A 4장 for one cast,
 * 씬 B 1장 for another), switching the preset or the cast never resets what
 * is piled (the keys keep everything - the toolbar only changes what is on
 * screen), and 씬 생성 drains the WHOLE map into one job whose items the
 * runner consumes in order. The results area lists every batch as its own
 * section, newest first; the history tab jumps here and highlights one
 * (4.10); a finished image opens big in the 1장 tab (4.4a).
 */
import { el, clear, modal } from '../dom';
import { state, type StudioJob } from '../../state';
import { workspaceImage } from '../blobimg';
import { pickerRow, openListPicker, type PickerEntry } from '../pickers';
import { S, hub, gen, persistCols, stateLabel, msg, cardStem,
         casts, loadCasts, saveCasts, castById, activeCast, setActiveCast, CAST_COLORS,
         reserves, reserveOf, sceneReserveTotal, reserveTotal, adjustReserve, setReserve,
         clearReserves, persistReserves, type ReserveMap } from './store';
import { scenePicker, tokenNotice, openParamsDialog, startRun, cancelRun, pendingCount, loadJobs } from './gen';
import { openImage } from './center-single';

let sectionsBox: HTMLElement | null = null;
let runBtn: HTMLButtonElement | null = null;
let progressLine: HTMLElement | null = null;
/** The section the live poll rebuilds in place. */
let liveSection: HTMLElement | null = null;

/** Scene lists per preset file, re-read when the library rev moves. */
const sceneCache = new Map<string, { rev: number; scenes: { name: string; prompt: string }[] }>();

async function scenesOf(preset: string): Promise<{ name: string; prompt: string }[]> {
  const hit = sceneCache.get(preset);
  if (hit && hit.rev === state.filesRev) return hit.scenes;
  try {
    const d = JSON.parse((await state.readFile(preset)).content) as { scenes?: { name?: string; prompt?: string }[] };
    const scenes = (d.scenes ?? []).map((s) => ({ name: String(s.name ?? ''), prompt: String(s.prompt ?? '') }))
      .filter((s) => s.name);
    sceneCache.set(preset, { rev: state.filesRev, scenes });
    return scenes;
  } catch {
    return [];
  }
}

export function drawBatch(mount: HTMLElement): void {
  const notice = tokenNotice();
  if (notice) mount.appendChild(notice);

  // --- toolbar -----------------------------------------------------------------
  const params = el('button', { class: 'ghost tiny', text: '⚙ 요청 설정' });
  params.addEventListener('click', () => openParamsDialog());
  const cols = el('div', { class: 'row', style: { gap: '2px' } },
    [2, 3, 4].map((n) => {
      const b = el('button', { class: 'ghost tiny' + (S.cols === n ? ' on' : ''), text: String(n),
                               title: `${n}열로 보기` });
      b.addEventListener('click', () => { S.cols = n as 2 | 3 | 4; persistCols(); hub.drawCentre(); });
      return b;
    }));
  mount.appendChild(el('div', { class: 'row', style: { marginBottom: '6px', flexWrap: 'wrap' } }, [
    scenePicker(), castPicker(), params, cols,
  ]));

  // --- the scene cards (the reservation queue's face) --------------------------
  const cardsBox = el('div', {});
  mount.appendChild(cardsBox);
  void drawSceneCards(cardsBox);

  // --- the queue summary and the one submit ------------------------------------
  const summary = el('div', {});
  mount.appendChild(summary);
  drawSummary(summary);

  runBtn = el('button', { class: 'primary tiny' }) as HTMLButtonElement;
  runBtn.addEventListener('click', () => {
    if (S.jobId) cancelRun();
    else void submitReserved();
  });
  progressLine = el('span', { class: 'hint' });
  mount.appendChild(el('div', { class: 'row', style: { margin: '8px 0', flexWrap: 'wrap' } }, [
    progressLine, el('span', { class: 'grow' }), runBtn,
  ]));

  sectionsBox = el('div', {});
  mount.appendChild(sectionsBox);
  syncRunBtn();
  void drawSections();
}

/** The live-job heartbeat: rebuild only the running section. */
export function batchTick(): void {
  if (!sectionsBox?.isConnected) return;
  syncRunBtn();
  if (S.queueJob && liveSection?.isConnected) {
    const fresh = jobSection(S.queueJob, !!S.jobId);
    liveSection.replaceWith(fresh);
    liveSection = fresh;
  } else if (S.queueJob && !liveSection) {
    void drawSections();
  }
}

function syncRunBtn(): void {
  if (!runBtn?.isConnected || !progressLine) return;
  const running = !!S.jobId;
  const total = reserveTotal();
  runBtn.style.display = (S.status && !S.status.configured && !running) ? 'none' : '';
  runBtn.textContent = running ? `취소 (${pendingCount()})` : `씬 생성 ${total}장`;
  runBtn.classList.toggle('danger', running);
  runBtn.disabled = !running && total === 0;
  runBtn.title = running ? '' : '모든 프리셋·모든 출연의 예약을 한 번에 생성합니다 (순서대로)';
  const p = S.queueJob?.payload;
  progressLine.textContent = running && p
    ? `${stateLabel(S.queueJob!.state)} · ${p.done}/${p.total}${p.current ? ' · ' + p.current : ''}`
    : '';
}

// --- the cast dropdown ----------------------------------------------------------

function castLabel(id: string): string {
  return id ? (castById(id)?.name ?? '(지워진 출연)') : '활성 캐릭터 (체크한 카드)';
}

function castPicker(): HTMLElement {
  const wrap = el('div', { class: 'field grow' });
  wrap.appendChild(el('span', { text: '출연 (캐릭터 조합)' }));
  const draw = () => {
    while (wrap.children.length > 1) wrap.lastChild?.remove();
    const cur = activeCast ? castById(activeCast) : null;
    wrap.appendChild(pickerRow(
      { name: castLabel(activeCast), hint: cur ? cur.characters.map((c) => c.split('/').pop()).join(' · ') : undefined },
      {
        title: `저장된 출연 ${casts.length}개 — 선택 · 수정 · 삭제 · 추가`,
        emptyHint: '',
        onOpen: () => openListPicker({
          title: '출연 선택',
          hint: '예약 + 는 지금 선택된 출연으로 쌓입니다. 출연마다 장수가 따로 갑니다.',
          load: async () => {
            await loadCasts();
            return [
              { id: '', name: '활성 캐릭터 (체크한 카드)', selected: !activeCast, noDelete: true },
              ...casts.map((c): PickerEntry => ({
                id: c.id, name: c.name,
                hint: c.characters.map((x) => x.split('/').pop()).join(' · ') || '(캐릭터 없음)',
                selected: activeCast === c.id,
              })),
            ];
          },
          onSelect: async (e) => { setActiveCast(e.id); hub.drawCentre(); },
          onEdit: (e) => { if (e.id) openCastEditor(e.id); },
          onDelete: async (e) => {
            await saveCasts(casts.filter((c) => c.id !== e.id));
            if (activeCast === e.id) setActiveCast('');
            hub.drawCentre();
          },
          onCreate: () => openCastEditor(null),
          createLabel: '새 출연 추가',
        }),
      }));
  };
  draw();
  void loadCasts().then(() => { if (wrap.isConnected) draw(); });
  return wrap;
}

/** The cast editor: a name and the character checklist, folder-grouped. */
function openCastEditor(id: string | null): void {
  const existing = id ? castById(id) : null;
  const name = el('input', { placeholder: '출연 이름 (예: 유나 단독)', value: existing?.name ?? '' }) as HTMLInputElement;
  const picked = new Set(existing?.characters ?? []);
  const list = el('div', { class: 'verlist' });
  const byFolder = new Map<string, typeof items>();
  const items = (S.cards.characters ?? []);
  for (const it of items) {
    const key = (it.folder && it.folder !== '.') ? it.folder : '';
    if (!byFolder.has(key)) byFolder.set(key, [] as typeof items);
    byFolder.get(key)!.push(it);
  }
  for (const [folder, rows] of [...byFolder.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (folder) list.appendChild(el('div', { class: 'sectiontitle', text: folder }));
    for (const it of rows) {
      const box = el('input', { type: 'checkbox' }) as HTMLInputElement;
      box.checked = picked.has(it.path);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(it.path); else picked.delete(it.path);
      });
      list.appendChild(el('label', { class: 'row', style: { padding: '2px 0' } }, [
        box, el('span', { text: it.name }),
        el('span', { class: 'hint', text: it.path }),
      ]));
    }
  }
  if (!items.length) list.appendChild(el('div', { class: 'hint', text: '캐릭터 카드가 없습니다 — 좌측 캐릭터에서 먼저 만들어 주세요.' }));

  const out = el('div', { class: 'hint' });
  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const body = el('div', {}, [
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('div', { class: 'sectiontitle', text: '캐릭터' }),
    list,
    el('div', { class: 'row', style: { marginTop: '8px' } }, [save]),
    out,
  ]);
  const close = modal(existing ? '출연 수정' : '새 출연', body, { sticky: true });
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { out.textContent = '이름을 입력해 주세요.'; return; }
    save.disabled = true;
    try {
      const next = [...casts];
      if (existing) {
        const at = next.findIndex((c) => c.id === existing.id);
        next[at] = { ...existing, name: nm, characters: [...picked] };
      } else {
        next.push({
          id: 'cast_' + cardStem(nm).toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36),
          name: nm,
          color: CAST_COLORS[next.length % CAST_COLORS.length],
          characters: [...picked],
        });
      }
      await saveCasts(next);
      close();
      if (!existing) setActiveCast(next[next.length - 1].id);
      hub.drawCentre();
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });
}

// --- the scene cards ---------------------------------------------------------------

async function drawSceneCards(box: HTMLElement): Promise<void> {
  if (!gen.scenePreset) {
    box.appendChild(el('div', { class: 'hint', style: { margin: '4px 0 8px' },
      text: '씬 프리셋을 고르면 씬 카드가 나옵니다. 예약은 프리셋을 오가며 자유롭게 쌓입니다.' }));
    return;
  }
  const scenes = await scenesOf(gen.scenePreset);
  if (!box.isConnected) return;
  if (!scenes.length) {
    box.appendChild(el('div', { class: 'hint', text: '이 프리셋에 씬이 없습니다 — 드롭다운의 수정에서 씬을 추가하세요.' }));
    return;
  }
  const jobs = await loadJobs();
  if (!box.isConnected) return;
  const grid = el('div', { class: 'scenegrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  for (const scene of scenes) grid.appendChild(sceneCard(scene, jobs));
  box.appendChild(grid);
}

function sceneThumb(scene: string, jobs: StudioJob[]): string {
  for (const j of jobs) {
    const p = j.payload;
    if (!p?.items || !p.saved?.length) continue;
    const savedBy = new Map<string, string>();
    for (const path of p.saved) savedBy.set(path.split('/').pop() ?? path, path);
    for (const it of p.items) {
      if (it.scene === scene) {
        const hit = savedBy.get(it.name);
        if (hit) return hit;
      }
    }
  }
  return '';
}

function sceneCard(scene: { name: string; prompt: string }, jobs: StudioJob[]): HTMLElement {
  const preset = gen.scenePreset;
  const total = sceneReserveTotal(preset, scene.name);
  const mine = reserveOf(preset, scene.name, activeCast);

  const face = el('div', { class: 'sceneface' });
  const thumb = sceneThumb(scene.name, jobs);
  if (thumb) {
    const pic = workspaceImage(thumb, scene.name, { thumb: false });
    pic.classList.add('jobpic');
    face.appendChild(pic);
  } else {
    face.appendChild(el('div', { class: 'scenefallback', text: scene.name }));
  }

  // Per-cast counts as colored badges - a stack, so mixed casts stay visible.
  const badges = el('div', { class: 'row', style: { gap: '4px', flexWrap: 'wrap' } });
  for (const [castId, n] of Object.entries(reserves[preset]?.[scene.name] ?? {})) {
    const c = castId ? castById(castId) : null;
    badges.appendChild(el('span', {
      class: 'badge', text: `${castLabel(castId)} ${n}`,
      style: c ? { borderColor: c.color, color: c.color } : {},
    }));
  }

  const minus = el('button', { class: 'ghost tiny', text: '−', title: '지금 출연의 예약을 하나 뺍니다' });
  const num = el('button', { class: 'ghost tiny reservenum', text: String(mine), title: '눌러서 장수를 직접 입력' });
  const plus = el('button', { class: 'ghost tiny', text: '＋', title: '지금 출연으로 한 장 예약' });
  minus.addEventListener('click', () => { adjustReserve(preset, scene.name, activeCast, -1); hub.drawCentre(); });
  plus.addEventListener('click', () => { adjustReserve(preset, scene.name, activeCast, +1); hub.drawCentre(); });
  num.addEventListener('click', () => {
    const raw = window.prompt(`${scene.name} — ${castLabel(activeCast)} 예약 장수`, String(mine));
    if (raw === null) return;
    const n = Math.max(0, Math.trunc(Number(raw)) || 0);
    setReserve(preset, scene.name, activeCast, n);
    hub.drawCentre();
  });

  return el('div', { class: 'scenecard' + (total ? ' reserved' : ''), title: scene.prompt || scene.name }, [
    face,
    el('div', { class: 'row', style: { marginTop: '4px' } }, [
      el('span', { class: 'grow', text: scene.name }),
      minus, num, plus,
    ]),
    badges,
  ]);
}

// --- the queue summary and the submit ------------------------------------------------

function drawSummary(box: HTMLElement): void {
  const total = reserveTotal();
  if (!total) return;
  const presets = Object.keys(reserves);
  const outside = presets.filter((p) => p !== gen.scenePreset);
  const outsideN = outside.reduce((n, p) =>
    n + Object.values(reserves[p]).reduce((a, s) => a + Object.values(s).reduce((x, y) => x + y, 0), 0), 0);

  const det = el('details', { class: 'advbox' }) as HTMLDetailsElement;
  det.appendChild(el('summary', {}, [
    el('span', { text: `예약 목록 — 총 ${total}장` }),
    outsideN ? el('span', { class: 'badge', style: { marginLeft: '6px' },
      title: '지금 화면의 프리셋 밖에 쌓인 예약 — 제출에 함께 실립니다',
      text: `다른 프리셋 ${outsideN}장` }) : null,
  ]));
  const list = el('div', { class: 'verlist' });
  for (const [preset, scenes] of Object.entries(reserves)) {
    for (const [scene, castsMap] of Object.entries(scenes)) {
      for (const [castId, n] of Object.entries(castsMap)) {
        const drop = el('button', { class: 'ghost tiny', text: '✕', title: '이 예약만 뺍니다' });
        drop.addEventListener('click', () => {
          setReserve(preset, scene, castId, 0);
          hub.drawCentre();
        });
        list.appendChild(el('div', { class: 'row', style: { padding: '2px 0' } }, [
          el('span', { class: 'hint', text: preset.split('/').pop()?.replace(/\.json$/, '') ?? preset }),
          el('span', { class: 'grow', text: `${scene} × ${n}` }),
          el('span', { class: 'hint', text: castLabel(castId) }),
          drop,
        ]));
      }
    }
  }
  const clearAll = el('button', { class: 'ghost tiny', text: '전체 예약 취소' });
  clearAll.addEventListener('click', () => { clearReserves(); hub.drawCentre(); });
  det.appendChild(list);
  det.appendChild(el('div', { class: 'row', style: { marginTop: '4px' } }, [clearAll]));
  box.appendChild(det);
}

/** Drain the reservation map into ONE job's entries. A scene that no longer
 * exists in its preset is skipped and reported - its reservation stays. */
async function submitReserved(): Promise<void> {
  const entries: Record<string, unknown>[] = [];
  const skipped: string[] = [];
  const leftover: ReserveMap = {};
  for (const [preset, scenes] of Object.entries(reserves)) {
    const known = new Set((await scenesOf(preset)).map((s) => s.name));
    for (const [scene, castsMap] of Object.entries(scenes)) {
      for (const [castId, count] of Object.entries(castsMap)) {
        if (!count) continue;
        if (!known.has(scene)) {
          skipped.push(`${preset.split('/').pop()} / ${scene}`);
          ((leftover[preset] ??= {})[scene] ??= {})[castId] = count;
          continue;
        }
        const cast = castId ? castById(castId) : null;
        const entry: Record<string, unknown> = { scenePreset: preset, scene, count };
        if (cast) {
          entry.cast = cast.name;
          entry.characters = cast.characters;
        }
        entries.push(entry);
      }
    }
  }
  if (!entries.length) {
    hub.notice(skipped.length
      ? '예약된 씬을 프리셋에서 찾지 못했습니다: ' + skipped.join(', ')
      : '예약이 없습니다 — 씬 카드의 ＋ 로 쌓아 주세요.', 'err');
    return;
  }
  if (skipped.length) {
    hub.notice('일부 씬을 찾지 못해 건너뜁니다 (예약은 남습니다): ' + skipped.join(', '), 'err');
  }
  await startRun({ entries, scenePreset: '' });
  if (S.jobId) {
    // Submitted: the queue empties, except what was skipped.
    for (const k of Object.keys(reserves)) delete reserves[k];
    Object.assign(reserves, leftover);
    persistReserves();
    hub.drawCentre();
  }
}

// --- the job sections (results, BY batch) --------------------------------------------

async function drawSections(): Promise<void> {
  const box = sectionsBox;
  if (!box?.isConnected) return;
  const jobs = await loadJobs();
  if (!box.isConnected) return;
  clear(box);
  liveSection = null;

  const shown: StudioJob[] = [];
  if (S.queueJob && S.jobId) shown.push(S.queueJob);
  for (const j of jobs) {
    if (shown.some((x) => x.id === j.id)) continue;
    shown.push(j);
  }
  if (!shown.length) {
    box.appendChild(el('div', { class: 'empty', text: '아직 배치가 없습니다. 씬 카드에 예약을 쌓고 씬 생성을 누르세요.' }));
    return;
  }
  for (const j of shown) {
    const live = j.id === S.jobId;
    const sec = jobSection(j, live);
    if (live) liveSection = sec;
    box.appendChild(sec);
  }
  // The history tab pointed at one batch: bring it into view, once.
  if (S.focusJob) {
    const target = box.querySelector<HTMLElement>(`[data-job="${S.focusJob}"]`);
    S.focusJob = '';
    if (target) {
      target.classList.add('focusjob');
      target.scrollIntoView?.({ block: 'start' });
      setTimeout(() => target.classList.remove('focusjob'), 2500);
    }
  }
}

function jobSection(j: StudioJob, live: boolean): HTMLElement {
  const p = j.payload;
  const bits: string[] = [];
  if (j.created_at) bits.push(new Date(j.created_at * 1000).toLocaleString());
  bits.push(stateLabel(j.state));
  if (p) bits.push(`${p.done}/${p.total}`);
  const spent = j.result?.anlasSpent;
  if (typeof spent === 'number') bits.push(`Anlas ${spent}`);

  const head = el('div', { class: 'row jobhead' }, [
    el('span', { class: 'sectiontitle grow', text: bits.join(' · ') }),
    live ? el('span', { class: 'badge warn', text: '진행 중' }) : null,
    el('span', { class: 'hint', text: j.id }),
  ]);
  const sec = el('div', { class: 'jobsec' + (live ? ' live' : ''), dataset: { job: j.id } }, [head]);
  if (j.error) sec.appendChild(el('div', { class: 'notice err', text: j.error }));
  if (!p) return sec;
  if (p.note) sec.appendChild(el('div', { class: 'hint', text: p.note }));

  const savedBy = new Map<string, string>();
  for (const path of p.saved ?? []) savedBy.set(path.split('/').pop() ?? path, path);
  const failedBy = new Map((p.failed ?? []).map((f) => [f.name, f.error] as const));
  const savedList = p.saved ?? [];

  const grid = el('div', { class: 'jobgrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  for (const it of p.items ?? []) {
    const full = savedBy.get(it.name);
    const err = failedBy.get(it.name);
    const cell = el('div', { class: 'jobcell', title: it.name });
    if (full) {
      const pic = workspaceImage(full, it.name, { thumb: false });
      pic.classList.add('jobpic');
      pic.addEventListener('click', () => openImage(full, savedList));
      cell.append(pic);
    } else if (err) {
      cell.appendChild(el('div', { class: 'jobwait err' }, [
        el('span', { class: 'badge err', text: '실패' }),
        el('div', { class: 'hint err', text: err }),
      ]));
    } else if (live && p.current === it.name) {
      cell.appendChild(el('div', { class: 'jobwait' }, [el('span', { class: 'badge warn', text: '생성 중' })]));
    } else {
      cell.appendChild(el('div', { class: 'jobwait' }, [
        el('span', { class: 'badge', text: live ? '대기' : '—' }),
      ]));
    }
    cell.appendChild(el('div', { class: 'fname' }, [
      it.scene ? el('span', { class: 'badge', text: it.scene, style: { marginRight: '4px' } }) : null,
      it.cast ? el('span', { class: 'badge', text: it.cast, style: { marginRight: '4px' } }) : null,
      el('span', { class: 'hint', text: it.name }),
    ]));
    grid.appendChild(cell);
  }
  sec.appendChild(grid);
  return sec;
}
