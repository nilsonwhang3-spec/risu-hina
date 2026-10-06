/**
 * 페르소나 편집 (§1-89): a RisuAI user persona - name, description, profile
 * picture - edited the way the bot and the chats are.
 *
 *   left    every persona (switch without going back to the first screen)
 *   centre  the open persona's working copy
 *   right   the agent (it can read, search and view personas, and propose
 *           edits, snapshots and 반영 for the one open here)
 *
 * The working copy lives in the backend: edits save as they are typed, an
 * approved AI proposal lands in the same copy, 🔖 / 🕘 keep and restore
 * snapshots, and 반영 (the bar, or the title-row 반영 next to the bot and
 * chats) writes it into RisuAI. RisuAI's SELECTED persona can be edited here
 * but not written in place: RisuAI keeps a live copy of it that plugins cannot
 * write (persona.ts), so its 반영 saves the edit as a new persona (a copy).
 * The selection is re-read each time the panel opens (shell bootstrap).
 *
 * Built once per persona and patched in place on the panel's many re-renders:
 * a rebuild would drop the caret out of the description box.
 */
import { el, clear, focusButton, popover, armed, fmtTime, TOOL } from './dom';
import { state, type PersonaRow } from '../state';
import { setTab, setToolbar } from './shell';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { personaAvatar, newPersonaButton } from './tab-chats';
import { shellNotice, openSnapshotName } from './chatbar';
import { workspaceImage } from './blobimg';
import { SELECTED_COPY_NOTE, copyName } from '../persona';
import { openModuleSave } from './module-export';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let builtFor = '';
let paint: (() => void) | null = null;

export function renderPersonaTab(mount: HTMLElement): void {
  const p = state.persona;
  if (!p) {
    builtFor = '';
    paint = null;
    clear(mount);
    setToolbar(null);
    const back = el('button', { class: 'primary tiny', text: '첫 화면으로' });
    back.addEventListener('click', () => setTab('chats'));
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty' }, [el('div', { text: '편집할 페르소나를 첫 화면에서 골라 주세요.' }), back]),
    ]));
    return;
  }
  if (builtFor === p.key && mount.querySelector('.split.personasplit')) {
    paint?.();
    mountRight(mount);
    return;
  }
  builtFor = p.key;
  clear(mount);

  const pane = threePane();
  pane.root.classList.add('personasplit');
  mount.appendChild(pane.root);

  // --- left: every persona
  const list = el('div', { class: 'tree personatree' });
  const reread = el('button', { class: 'ghost tiny', text: '다시 읽기', title: 'RisuAI에서 페르소나 목록을 다시 읽어 옵니다' }) as HTMLButtonElement;
  reread.addEventListener('click', () => { void state.loadPersonas().catch((e) => shellNotice(msg(e), 'err')); });
  pane.left.append(el('div', { class: 'row treehead', style: { padding: '6px 8px', flexWrap: 'wrap', gap: '4px' } }, [
    el('span', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '페르소나' }), newPersonaButton(() => state.emit()), reread,
  ]), list);
  const drawList = () => {
    clear(list);
    for (const r of state.personas ?? [p]) {
      if (r.gone) continue;
      const row = el('div', { class: 'chatitem' + (r.key === state.persona?.key ? ' current' : '') }, [
        personaAvatar(r.iconKey, r.work.name || r.name),
        el('span', { class: 'grow', text: r.work.name || r.name || '(이름 없음)' }),
        r.selected ? el('span', { class: 'badge', text: '선택됨', title: 'RisuAI에서 지금 선택된 페르소나 - 반영하면 새 페르소나(사본)로 저장됩니다' }) : null,
        r.isNew ? el('span', { class: 'badge', text: '새로 만듦' }) : null,
        r.dirty ? el('span', { class: 'badge warn', text: `미반영 ${r.total}` }) : null,
        r.risuChanged ? el('span', { class: 'badge warn', text: 'RisuAI도 바뀜', title: 'RisuAI 쪽에서도 바뀌었습니다 - 반영하면 덮어씁니다' }) : null,
      ]);
      row.addEventListener('click', async () => {
        if (r.key === state.persona?.key) return;
        try { await state.openPersona(r.key); } catch (e) { shellNotice('페르소나를 열지 못했습니다: ' + msg(e), 'err'); }
      });
      list.appendChild(row);
    }
  };

  // --- centre: the working copy
  const nameIn = el('input', { placeholder: '페르소나 이름' }) as HTMLInputElement;
  const prompt = el('textarea', { class: 'personaprompt', rows: 14, placeholder: '페르소나 설명 — RisuAI가 {{user}} 설명으로 프롬프트에 넣는 글입니다' }) as HTMLTextAreaElement;
  const count = el('span', { class: 'hint' });
  const saved = el('span', { class: 'hint' });
  const recount = () => { count.textContent = `${prompt.value.length.toLocaleString()}자`; };

  // Typing saves to the working copy after a pause; the copy is what the AI,
  // snapshots and 반영 all see.
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave: { name?: string; prompt?: string } = {};
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const f = pendingSave;
    pendingSave = {};
    if (!Object.keys(f).length || !state.persona) return;
    saved.textContent = '저장 중…';
    try {
      await state.editPersona(f);
      saved.textContent = '작업본에 저장됨';
    } catch (e) {
      saved.textContent = '';
      shellNotice('저장하지 못했습니다: ' + msg(e), 'err');
    }
  };
  const queue = (f: { name?: string; prompt?: string }) => {
    pendingSave = { ...pendingSave, ...f };
    saved.textContent = '입력 중…';
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void flush(), 700);
  };
  nameIn.addEventListener('input', () => queue({ name: nameIn.value }));
  prompt.addEventListener('input', () => { recount(); queue({ prompt: prompt.value }); });
  nameIn.addEventListener('blur', () => void flush());
  prompt.addEventListener('blur', () => void flush());

  const picBox = el('div', { class: 'personapic' });
  const picNote = el('div', { class: 'hint' });
  let picSig = '';
  const drawPic = (r: PersonaRow) => {
    const sig = r.work.image + '|' + r.iconPath + '|' + r.iconKey;
    if (sig === picSig) return;
    picSig = sig;
    clear(picBox);
    if (r.work.image) {
      picBox.appendChild(workspaceImage(r.work.image, '새 프로필 사진'));
      picNote.textContent = `새 사진: ${r.work.image.split('/').pop()} (반영하면 바뀝니다)`;
    } else {
      // The cached copy keeps its name ('RisuAI 프로필.png') when the picture
      // changes; RisuAI's asset key does not, so it stamps the blob cache -
      // otherwise the old picture's object URL came back after 반영 (#5).
      picBox.appendChild(r.iconPath
        ? workspaceImage(r.iconPath, '프로필 사진', { stamp: r.iconKey })
        : personaAvatar(r.iconKey, r.work.name, 'personabig'));
      picNote.textContent = r.iconKey ? '' : '프로필 사진이 없습니다';
    }
  };

  const fileIn = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } }) as HTMLInputElement;
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f || !state.persona) return;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      // Into the persona's own folder, so the picture is a file like any
      // other the AI or the studio made there.
      const up = await state.uploadFile(f.name, btoa(bin), true, state.personaFolder);
      await state.editPersona({ image: up.path });
      state.touchFiles([up.path]);
    } catch (e) {
      shellNotice('이미지를 올리지 못했습니다: ' + msg(e), 'err');
    }
  });
  const upBtn = el('button', { class: 'ghost tiny', text: '이미지 올리기' });
  upBtn.addEventListener('click', () => fileIn.click());
  const pickBtn = el('button', { class: 'ghost tiny', text: '프로젝트 폴더에서 고르기' });
  const pickList = el('div', { class: 'personapick' });
  pickBtn.addEventListener('click', async () => {
    if (pickList.childElementCount) { clear(pickList); return; }
    const folder = state.personaFolder;
    pickList.appendChild(el('div', { class: 'hint', text: '폴더를 읽는 중…' }));
    try {
      const listing = await state.files(folder);
      const files = listing.areas.flatMap((a) => a.files)
        .filter((f) => f.path.startsWith(folder + '/') && IMAGE_RE.test(f.name));
      clear(pickList);
      if (!files.length) {
        pickList.appendChild(el('div', { class: 'hint', text: `${folder} 에 이미지가 없습니다 — 에셋 스튜디오에서 만들거나 파일 탭에서 올려 두세요.` }));
        return;
      }
      for (const f of files.slice(0, 60)) {
        const cell = el('button', { class: 'ghost personapickcell', title: f.path.slice(folder.length + 1) }, [
          workspaceImage(f.path, f.name, { thumb: true }),
          el('span', { class: 'hint clip1', text: f.name }),
        ]) as HTMLButtonElement;
        cell.addEventListener('click', async () => {
          cell.disabled = true;
          try { await state.editPersona({ image: f.path }); clear(pickList); } catch (e) { shellNotice(msg(e), 'err'); cell.disabled = false; }
        });
        pickList.appendChild(cell);
      }
    } catch (e) {
      clear(pickList);
      pickList.appendChild(el('div', { class: 'notice err', text: '폴더를 읽지 못했습니다: ' + msg(e) }));
    }
  });
  const undoPic = el('button', { class: 'ghost tiny', text: '사진 되돌리기' });
  undoPic.addEventListener('click', () => { void state.editPersona({ image: '' }).catch((e) => shellNotice(msg(e), 'err')); });

  const lockNote = el('div', { class: 'notice', style: { display: 'none', marginBottom: '10px' }, text: SELECTED_COPY_NOTE });
  const driftNote = el('div', { class: 'notice warn', style: { display: 'none', marginBottom: '10px' },
    text: '작업본에 미반영 변경이 있는 동안 RisuAI 쪽에서도 이 페르소나가 바뀌었습니다. 반영하면 RisuAI 쪽 변경을 덮어씁니다. '
      + 'RisuAI 버전은 🕘 버전의 자동 백업 “RisuAI 쪽 변경” 으로 남겨 두었고, 변경 취소를 누르면 RisuAI 버전으로 돌아갑니다.' });
  const openFolder = el('button', { class: 'ghost tiny', text: '파일 탭에서 열기' });
  openFolder.addEventListener('click', () => state.requestOpenFile(state.personaFolder + '/'));
  const folderLine = el('span', { class: 'hint grow' });

  pane.centre.appendChild(el('div', { class: 'pad personaedit' }, [
    lockNote, driftNote,
    el('div', { class: 'personagrid' }, [
      el('div', { class: 'personaleft' }, [
        picBox, picNote,
        el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginTop: '8px' } }, [upBtn, pickBtn, undoPic, fileIn]),
        pickList,
      ]),
      el('div', { class: 'personaright' }, [
        el('label', { class: 'sectiontitle', text: '이름' }),
        nameIn,
        el('div', { class: 'row', style: { marginTop: '12px', marginBottom: '6px' } }, [
          el('label', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '설명' }),
          saved, count,
          focusButton(prompt, '페르소나 설명'),
        ]),
        prompt,
        el('div', { class: 'sectionline' }),
        el('div', { class: 'row', style: { gap: '8px' } }, [folderLine, openFolder]),
        el('div', { class: 'hint', style: { marginTop: '4px' }, text: '이 페르소나의 사진·메모를 두는 곳입니다. RisuAI 프로필 사진도 여기 사본이 있어 AI가 볼 수 있습니다. 이름을 바꿔 반영하면 폴더 이름도 따라갑니다.' }),
      ]),
    ]),
  ]));

  // --- the bar: 반영 · 스냅샷 · 버전 · 변경 취소, like the bot bar
  const applyBadge = el('span', { class: 'badge warn applybadge', style: { display: 'none' } });
  const applyLabel = el('span', { class: 'tool-label', text: '반영' });
  const applyBtn = el('button', { class: 'tool', dataset: { tool: 'persona-apply' }, title: '이 페르소나의 작업본을 RisuAI에 반영합니다' }, [
    el('span', { class: 'glyph', text: TOOL.apply }), applyLabel, applyBadge,
  ]) as HTMLButtonElement;
  applyBtn.addEventListener('click', async () => {
    await flush();
    applyBtn.disabled = true;
    try {
      const r = await state.personaWriteBack();
      shellNotice(r.copied
        ? `선택된 페르소나라 새 페르소나 '${r.name}' (사본)으로 RisuAI에 저장했습니다. 원본은 그대로입니다.`
        : r.written ? `페르소나 '${r.name}' 을(를) RisuAI에 반영하고 저장을 확인했습니다.` : '반영할 변경이 없습니다.', 'ok');
    } catch (e) {
      shellNotice('반영하지 못했습니다: ' + msg(e), 'err');
    } finally {
      applyBtn.disabled = false;
    }
  });
  const snap = el('button', { class: 'tool', dataset: { tool: 'persona-snapshot' }, title: '이 페르소나의 작업본을 스냅샷으로 저장합니다' }, [
    el('span', { class: 'glyph', text: TOOL.snapshot }), el('span', { class: 'tool-label', text: '스냅샷' }),
  ]);
  snap.addEventListener('click', () => {
    openSnapshotName(snap, '수동', async (label) => {
      await flush();
      await state.personaCheckpoint(label);
      shellNotice('페르소나 스냅샷을 저장했습니다. 🕘 버전에서 되돌릴 수 있습니다.', 'ok');
    });
  });
  const versions = el('button', { class: 'tool', dataset: { tool: 'persona-versions' }, title: '페르소나 스냅샷 목록에서 되돌리기' }, [
    el('span', { class: 'glyph', text: TOOL.versions }), el('span', { class: 'tool-label', text: '버전' }),
  ]);
  versions.addEventListener('click', () => void openVersions(versions));
  const discard = el('button', { class: 'tool', dataset: { tool: 'persona-discard' }, title: '이 페르소나의 미반영 변경을 버리고 RisuAI 상태로 되돌립니다' }) as HTMLButtonElement;
  armed(discard, TOOL.discard + ' 변경 취소', '정말 버릴까요?', async () => {
    try {
      const n = await state.personaReset();
      shellNotice('페르소나의 미반영 변경을 버렸습니다' + (n ? ` (${n}건)` : '') + '.', 'ok');
    } catch (e) {
      shellNotice('변경 취소에 실패했습니다: ' + msg(e), 'err');
    }
  });
  const summary = el('span', { class: 'dim changesum' });
  // The persona's modules (＋ on the tab row) as .charx / .risum files (§1-96).
  const saveMods = el('button', { class: 'tool', dataset: { tool: 'persona-modules-save' }, title: '이 페르소나와 함께 연 모듈을 .charx / .risum 으로 워크스페이스에 저장합니다' }, [
    el('span', { class: 'glyph', text: TOOL.export }), el('span', { class: 'tool-label', text: '모듈 저장' }),
  ]);
  saveMods.addEventListener('click', () => openModuleSave(saveMods));
  const bar = el('div', { class: 'toolrow personabar' }, [applyBtn, snap, versions, discard, saveMods, summary]);

  paint = () => {
    const r = state.persona;
    if (!r) return;
    drawList();
    // A value changed underneath (an approved AI edit, a restore, 반영) lands
    // in the boxes - unless the user is typing in that box right now.
    const active = document.activeElement;
    if (active !== nameIn && !pendingSave.name && nameIn.value !== r.work.name) nameIn.value = r.work.name;
    if (active !== prompt && !pendingSave.prompt && prompt.value !== r.work.prompt) { prompt.value = r.work.prompt; recount(); }
    drawPic(r);
    undoPic.style.display = r.work.image ? '' : 'none';
    lockNote.style.display = r.selected ? '' : 'none';
    driftNote.style.display = r.risuChanged ? '' : 'none';
    folderLine.textContent = `프로젝트 폴더: ${r.folder}`;
    const parts: string[] = [];
    if (r.work.name !== r.base.name) parts.push('이름');
    if (r.work.prompt !== r.base.prompt) parts.push('설명');
    if (r.work.image) parts.push('사진');
    summary.textContent = parts.length ? parts.join(' · ') + ' 변경' : '변경 없음';
    applyBadge.textContent = String(r.total);
    applyBadge.style.display = r.total ? '' : 'none';
    const asCopy = r.selected && !r.isNew;
    applyLabel.textContent = asCopy ? '사본으로 반영' : '반영';
    applyBtn.title = asCopy
      ? `선택된 페르소나라 새 페르소나 '${copyName(r.base.name, r.work.name)}' 로 저장합니다 (원본은 그대로)`
      : '이 페르소나의 작업본을 RisuAI에 반영합니다';
    discard.style.display = r.dirty ? '' : 'none';
    discard.title = r.isNew ? '아직 RisuAI에 없는 새 페르소나를 지웁니다 (폴더는 남습니다)' : '이 페르소나의 미반영 변경을 버리고 RisuAI 상태로 되돌립니다';
    applyBtn.title = r.isNew ? '이 새 페르소나를 RisuAI 페르소나 목록에 추가합니다' : applyBtn.title;
    saveMods.style.display = state.openModules.length ? '' : 'none';
    setToolbar(bar);
  };

  nameIn.value = p.work.name;
  prompt.value = p.work.prompt;
  recount();
  paint();
  mountRight(mount);
}

/** The shared agent panel, moved into this tab's right pane. */
function mountRight(mount: HTMLElement): void {
  bindAgent({ notice: (t, k) => shellNotice(t, k === 'err' ? 'err' : k === 'ok' ? 'ok' : '') });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

async function openVersions(anchor: HTMLElement): Promise<void> {
  const body = el('div', { class: 'verlist' }, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
  const close = popover(anchor, body);
  try {
    const cps = await state.personaCheckpoints();
    clear(body);
    if (!cps.length) {
      body.appendChild(el('div', { class: 'hint', text: '아직 페르소나 스냅샷이 없습니다. 🔖 스냅샷 버튼으로 저장해 주세요.' }));
      return;
    }
    const users = cps.filter((c) => c.kind !== 'auto');
    const autos = cps.filter((c) => c.kind === 'auto');
    const row = (c: (typeof cps)[number], auto: boolean) => {
      const back = el('button', { class: 'ghost tiny', text: '되돌리기', title: '작업본을 이 시점으로 되돌립니다 (직전 상태도 스냅샷으로 남습니다)' }) as HTMLButtonElement;
      back.addEventListener('click', async () => {
        back.disabled = true;
        try {
          await state.personaRestore(c.id);
          close();
          shellNotice('페르소나를 되돌렸습니다. 되돌리기 직전 상태도 스냅샷으로 남겨 두었습니다.', 'ok');
        } catch (e) {
          shellNotice('복원에 실패했습니다: ' + msg(e), 'err');
          back.disabled = false;
        }
      });
      const title = el('span', { text: c.label || '(무제)' });
      const r = el('div', { class: 'verrow' }, [
        el('div', { class: 'grow' }, [el('div', {}, [title]), el('div', { class: 'hint', text: fmtTime(c.created_at * 1000) })]),
        back,
      ]);
      if (!auto) {
        const ren = el('button', { class: 'ghost tiny', text: '✎', title: '이름 바꾸기' });
        ren.addEventListener('click', () => openSnapshotName(ren, c.label || '', async (label) => {
          await state.renamePersonaCheckpoint(c.id, label);
          title.textContent = label;
        }));
        const del = el('button', { class: 'ghost tiny', title: '이 스냅샷 삭제' }) as HTMLButtonElement;
        armed(del, '✕', '삭제 확인', async () => {
          r.classList.add('deleting');
          try { await state.deletePersonaCheckpoint(c.id); r.remove(); } catch (e) { r.classList.remove('deleting'); shellNotice(msg(e), 'err'); }
        });
        r.append(ren, del);
      }
      return r;
    };
    for (const c of users) body.appendChild(row(c, false));
    if (autos.length) {
      const fold = el('div', { class: 'autohead' });
      const auto = el('div', { style: { display: 'none' } });
      const head = el('button', { class: 'ghost tiny', text: `▸ 자동 백업 ${autos.length}개` });
      head.addEventListener('click', () => {
        const open = auto.style.display === 'none';
        auto.style.display = open ? '' : 'none';
        head.textContent = `${open ? '▾' : '▸'} 자동 백업 ${autos.length}개`;
      });
      fold.appendChild(head);
      for (const c of autos) auto.appendChild(row(c, true));
      body.append(fold, auto);
    }
  } catch (e) {
    clear(body);
    body.appendChild(el('div', { class: 'notice err', text: '스냅샷 목록을 읽지 못했습니다: ' + msg(e) }));
  }
}
