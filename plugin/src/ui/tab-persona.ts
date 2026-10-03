/**
 * 페르소나 편집 (§1-89): one RisuAI user persona - its name, its description
 * and its profile picture. That is all a persona is, so it is one screen.
 *
 * The edits are a draft held in the panel (state.personaDrafts) until 반영
 * writes them to RisuAI and reads them back; leaving the tab keeps the draft
 * and the first screen marks the persona 미반영. The persona's project folder
 * (projects/페르소나/<이름>) is where pictures for it are made or kept, and
 * 폴더에서 고르기 takes the profile picture from there.
 *
 * The screen is built once per persona and left alone on the panel's many
 * re-renders: a rebuild would drop the caret out of the description box.
 */
import { el, clear, focusButton } from './dom';
import { state } from '../state';
import { setTab } from './shell';
import { personaAvatar } from './tab-chats';
import { shellNotice } from './chatbar';
import { SELECTED_REFUSAL } from '../persona';

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let builtFor = '';
let refreshStatus: (() => void) | null = null;

export function renderPersonaTab(mount: HTMLElement): void {
  const p = state.persona;
  if (!p) {
    builtFor = '';
    clear(mount);
    const back = el('button', { class: 'primary tiny', text: '첫 화면으로' });
    back.addEventListener('click', () => setTab('chats'));
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty' }, [el('div', { text: '편집할 페르소나를 첫 화면에서 골라 주세요.' }), back]),
    ]));
    return;
  }
  const key = state.personaKey(p) + '\u0000' + p.name + '\u0000' + p.icon + '\u0000' + p.prompt.length;
  if (builtFor === key && mount.querySelector('.personaedit')) {
    refreshStatus?.();
    return;
  }
  builtFor = key;
  clear(mount);

  const draftKey = state.personaKey(p);
  const draft = () => state.personaDrafts.get(draftKey);
  const ensureDraft = () => {
    let d = draft();
    if (!d) {
      d = { name: p.name, prompt: p.prompt, image: null, imageName: '' };
      state.personaDrafts.set(draftKey, d);
    }
    return d;
  };
  const settle = () => {
    const d = draft();
    if (d && d.name === p.name && d.prompt === p.prompt && !d.image) state.personaDrafts.delete(draftKey);
    refreshStatus?.();
  };

  const d0 = draft();
  const nameIn = el('input', { value: d0?.name ?? p.name, placeholder: '페르소나 이름' }) as HTMLInputElement;
  nameIn.addEventListener('input', () => { ensureDraft().name = nameIn.value; settle(); });
  const prompt = el('textarea', { class: 'personaprompt', rows: 14, placeholder: '페르소나 설명 — RisuAI가 {{user}} 설명으로 프롬프트에 넣는 글입니다' }) as HTMLTextAreaElement;
  prompt.value = d0?.prompt ?? p.prompt;
  const count = el('span', { class: 'hint' });
  const recount = () => { count.textContent = `${prompt.value.length.toLocaleString()}자`; };
  recount();
  prompt.addEventListener('input', () => { ensureDraft().prompt = prompt.value; recount(); settle(); });

  // --- picture
  const picBox = el('div', { class: 'personapic' });
  let localUrl = '';
  const drawPic = () => {
    clear(picBox);
    const d = draft();
    if (d?.image) {
      if (localUrl) URL.revokeObjectURL(localUrl);
      const buf = new Uint8Array(d.image.byteLength);
      buf.set(d.image);
      try { localUrl = URL.createObjectURL(new Blob([buf])); } catch { localUrl = ''; }
      picBox.appendChild(localUrl ? el('img', { class: 'personabig', src: localUrl, alt: '' }) : el('span', { class: 'hint', text: d.imageName }));
      picBox.appendChild(el('div', { class: 'hint', text: `새 사진: ${d.imageName} (반영하면 바뀝니다)` }));
    } else {
      picBox.appendChild(personaAvatar(p.icon, p.name, 'personabig'));
      if (!p.icon) picBox.appendChild(el('div', { class: 'hint', text: '프로필 사진이 없습니다' }));
    }
  };
  const setImage = (bytes: Uint8Array, name: string) => {
    const d = ensureDraft();
    d.image = bytes;
    d.imageName = name;
    drawPic();
    settle();
  };

  const fileIn = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } }) as HTMLInputElement;
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files?.[0];
    fileIn.value = '';
    if (!f) return;
    try {
      setImage(new Uint8Array(await f.arrayBuffer()), f.name);
    } catch (e) {
      shellNotice('이미지를 읽지 못했습니다: ' + msg(e), 'err');
    }
  });
  const upBtn = el('button', { class: 'ghost tiny', text: '이미지 올리기' });
  upBtn.addEventListener('click', () => fileIn.click());
  const pickBtn = el('button', { class: 'ghost tiny', text: '프로젝트 폴더에서 고르기' });
  const pickList = el('div', { class: 'personapick' });
  pickBtn.addEventListener('click', async () => {
    if (pickList.childElementCount) { clear(pickList); return; }
    pickList.appendChild(el('div', { class: 'hint', text: '폴더를 읽는 중…' }));
    try {
      const listing = await state.files(state.personaFolder);
      const files = listing.areas.flatMap((a) => a.files)
        .filter((f) => f.path.startsWith(state.personaFolder + '/') && IMAGE_RE.test(f.name));
      clear(pickList);
      if (!files.length) {
        pickList.appendChild(el('div', { class: 'hint', text: `${state.personaFolder} 에 이미지가 없습니다 — 에셋 스튜디오에서 만들거나 파일 탭에서 올려 두세요.` }));
        return;
      }
      for (const f of files.slice(0, 60)) {
        const b = el('button', { class: 'ghost tiny', text: f.path.slice(state.personaFolder.length + 1) }) as HTMLButtonElement;
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            setImage(await state.fileBytes(f.path), f.name);
            clear(pickList);
          } catch (e) {
            shellNotice('이미지를 받지 못했습니다: ' + msg(e), 'err');
            b.disabled = false;
          }
        });
        pickList.appendChild(b);
      }
    } catch (e) {
      clear(pickList);
      pickList.appendChild(el('div', { class: 'notice err', text: '폴더를 읽지 못했습니다: ' + msg(e) }));
    }
  });
  const undoPic = el('button', { class: 'ghost tiny', text: '사진 되돌리기' });
  undoPic.addEventListener('click', () => {
    const d = draft();
    if (d) { d.image = null; d.imageName = ''; }
    drawPic();
    settle();
  });

  // --- 반영
  const status = el('div', { class: 'hint' });
  const apply = el('button', { class: 'primary', text: 'RisuAI에 반영' }) as HTMLButtonElement;
  const discard = el('button', { class: 'ghost', text: '편집 버리기' }) as HTMLButtonElement;
  refreshStatus = () => {
    const d = draft();
    const live = state.personas?.find((x) => x.index === p.index && (!p.id || x.id === p.id));
    const lockedNow = !!live?.selected;
    apply.disabled = !d || lockedNow;
    discard.disabled = !d;
    undoPic.style.display = d?.image ? '' : 'none';
    status.textContent = lockedNow ? SELECTED_REFUSAL
      : d ? '미반영 편집이 있습니다 — RisuAI에 반영을 눌러야 RisuAI에 들어갑니다.' : 'RisuAI와 같습니다.';
    status.className = lockedNow ? 'notice err' : 'hint';
  };
  apply.addEventListener('click', async () => {
    apply.disabled = true;
    discard.disabled = true;
    status.className = 'hint';
    status.textContent = 'RisuAI에 쓰고 확인하는 중…';
    try {
      const saved = await state.savePersona();
      shellNotice(`페르소나 '${saved.name}' 을(를) RisuAI에 반영하고 저장을 확인했습니다.`, 'ok');
      builtFor = '';
      state.emit();
    } catch (e) {
      status.className = 'notice err';
      status.textContent = '반영하지 못했습니다: ' + msg(e);
      apply.disabled = false;
      discard.disabled = false;
    }
  });
  discard.addEventListener('click', () => {
    state.personaDrafts.delete(draftKey);
    builtFor = '';
    renderPersonaTab(mount);
    state.emit();
  });

  const openFolder = el('button', { class: 'ghost tiny', text: '파일 탭에서 열기' });
  openFolder.addEventListener('click', () => state.requestOpenFile(state.personaFolder + '/'));

  mount.appendChild(el('div', { class: 'pad personaedit' }, [
    el('div', { class: 'personagrid' }, [
      el('div', { class: 'personaleft' }, [
        picBox,
        el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px', marginTop: '8px' } }, [upBtn, pickBtn, undoPic, fileIn]),
        pickList,
      ]),
      el('div', { class: 'personaright' }, [
        el('label', { class: 'sectiontitle', text: '이름' }),
        nameIn,
        el('div', { class: 'row', style: { marginTop: '12px', marginBottom: '6px' } }, [
          el('label', { class: 'sectiontitle grow', style: { marginBottom: '0' }, text: '설명' }),
          count,
          focusButton(prompt, '페르소나 설명'),
        ]),
        prompt,
        el('div', { class: 'row', style: { marginTop: '10px', gap: '8px' } }, [apply, discard]),
        status,
        el('div', { class: 'sectionline' }),
        el('div', { class: 'row', style: { gap: '8px' } }, [
          el('span', { class: 'hint grow', text: `프로젝트 폴더: ${state.personaFolder}` }),
          openFolder,
        ]),
        el('div', { class: 'hint', style: { marginTop: '4px' }, text: '이 페르소나의 사진·메모를 두는 곳입니다. 페르소나 이름을 바꿔 반영하면 폴더 이름도 따라갑니다.' }),
      ]),
    ]),
  ]));
  drawPic();
  refreshStatus();
}
