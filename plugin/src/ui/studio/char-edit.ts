/**
 * The character card editor - a folder card, edited in the left column (or
 * the centre, for the file dispatch).
 *
 * A character is not only text: beside the prompt live the reference images
 * and their per-item presets (강도/충실도), which is exactly what NovelAI
 * takes (`reference_*_multiple`, docs/09 §7). Saving writes prompt.md and
 * preset.json; images upload into the card's folder as they are added.
 *
 * Every picked image goes through a canvas and comes out a REAL PNG: the
 * file picker's `accept` is a hint, not a guarantee, and a WebP saved under
 * a .png name read as 0x0 on the backend and failed every generation that
 * carried it. Character references are additionally letterboxed into the
 * 1024x1536 / 1536x1024 buckets the encoder accepts. An entry that is on
 * disk in the wrong shape is flagged and refitted on save.
 */
import { el, clear, armed } from '../dom';
import { state } from '../../state';
import { blobUrl } from '../blobimg';
import { S, hub, msg, cardStem, renameCardFile } from './store';
import { splitFront, joinFront } from './stylefile';
import { editorHead } from './editors';

export interface CharEditorOpts {
  /** 'centre' (default): ← 목록 head with the path. 'inline': no head - the
   * host (the left character view) draws its own. */
  chrome?: 'centre' | 'inline';
  /** After a successful save; `dir` is the (possibly renamed) card folder.
   * Default: select the card in the centre and re-read the area. */
  onSaved?: (dir: string) => void;
  /** After a successful delete. Default: clear the centre selection. */
  onDeleted?: () => void;
}

/** The centre-pane wrapper (kept for the selectedFile dispatch). */
export function drawCharacterEditor(dir: string): void {
  if (!S.viewMount) return;
  clear(S.viewMount);
  S.viewMount.appendChild(characterEditor(dir, { chrome: 'centre' }));
}

interface RefEntry { file: string; strength: number; informationExtracted: number; enabled: boolean; bad?: string }
interface CharRefEntry { file: string; strength: number; fidelity: number;
                         mode: 'character' | 'character&style'; enabled: boolean; bad?: string }

const BUCKETS = [[1024, 1536], [1536, 1024]] as const;

/** Decode any picked/stored image into an <img>. */
async function decode(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('이미지를 읽지 못했습니다'));
    img.src = src;
  });
  return img;
}

/** Re-encode as PNG, optionally letterboxed (black, contain) into a bucket. */
function toPng(img: HTMLImageElement, bucket: boolean): string {
  const portrait = img.height >= img.width;
  const w = bucket ? (portrait ? 1024 : 1536) : img.width;
  const h = bucket ? (portrait ? 1536 : 1024) : img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 를 쓸 수 없습니다');
  if (bucket) {
    // Letterbox on black (contain), not crop: the web client pads the same
    // way, and a reference with its edges cut off references less.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  } else {
    ctx.drawImage(img, 0, 0);
  }
  const data = canvas.toDataURL('image/png');
  return data.slice(data.indexOf(',') + 1);
}

function pngName(original: string, bucket: boolean, w: number, h: number): string {
  const stem = original.replace(/\.[^.]+$/, '').replace(/-\d+x\d+$/, '');
  return bucket ? `${stem}-${w}x${h}.png` : `${stem}.png`;
}

export function characterEditor(dir: string, opts: CharEditorOpts = {}): HTMLElement {
  const rootEl = el('div', { class: 'charedit' });
  const isNew = !dir;
  const out = el('div', { class: 'hint' });

  const name = el('input', { placeholder: '히나' }) as HTMLInputElement;
  const caption = el('textarea', { rows: '5', class: 'promptedit compact',
    placeholder: '이 캐릭터를 그리는 프롬프트 (쉼표로 구분)' }) as HTMLTextAreaElement;
  const negative = el('textarea', { rows: '2', class: 'promptedit compact',
    placeholder: '이 캐릭터에만 붙는 네거티브' }) as HTMLTextAreaElement;
  const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const order = el('input', { type: 'number', value: '100', step: '10' }) as HTMLInputElement;
  const posX = el('input', { type: 'number', step: '0.1', placeholder: 'x 0~1' }) as HTMLInputElement;
  const posY = el('input', { type: 'number', step: '0.1', placeholder: 'y 0~1' }) as HTMLInputElement;

  let vibes: RefEntry[] = [];
  let charrefs: CharRefEntry[] = [];
  /** 바이브와 캐릭터 레퍼런스는 둘 중 하나만 실린다 - 탭이 그 선택이다. */
  let refMode: 'charref' | 'vibe' = 'charref';
  const refList = el('div', { class: 'refgrid' });
  const charrefList = el('div', { class: 'refgrid' });

  const uploadNow = async (fname: string, b64: string): Promise<boolean> => {
    if (!dir) { out.textContent = '먼저 이름을 정하고 저장한 뒤 이미지를 올려 주세요.'; return false; }
    try {
      await state.uploadFile(fname, b64, true, dir);
      return true;
    } catch (e) {
      out.textContent = `${fname}: 올리지 못했습니다 — ${msg(e)}`;
      return false;
    }
  };

  /** A 0..1 slider with its value beside it - dragging, not typing. */
  const slider = (label: string, value: number, onChange: (n: number) => void): HTMLElement => {
    const i = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(value) }) as HTMLInputElement;
    const v = el('span', { class: 'hint refval', text: value.toFixed(2) });
    i.addEventListener('input', () => {
      const n = Math.min(1, Math.max(0, Number(i.value)));
      v.textContent = n.toFixed(2);
      onChange(n);
    });
    return el('div', { class: 'refslider' }, [el('span', { class: 'hint', text: label }), i, v]);
  };

  /** One reference card: the picture (✕ on it, unmistakably ITS ✕), the
   * on/off, the sliders. No filename, no price - the picture is the name. */
  const refCard = (file: string, enabled: boolean, bad: string | undefined,
                   onToggle: (v: boolean) => void, onRemove: () => void, onFix: (() => Promise<void>) | null,
                   controls: HTMLElement[]): HTMLElement => {
    const pic = el('div', { class: 'refpic' });
    void blobUrl(`${dir}/${file}`).then((url) => {
      if (!pic.isConnected) return;
      pic.appendChild(el('img', { src: url, alt: file }));
    }).catch(() => { pic.appendChild(el('span', { class: 'hint', text: '읽지 못함' })); });
    const x = el('button', { class: 'ghost tiny refx', text: '✕', title: '이 레퍼런스를 목록에서 뺍니다 (파일은 남습니다)' });
    x.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    pic.appendChild(x);
    const on = el('input', { type: 'checkbox', title: '이 레퍼런스를 실을지' }) as HTMLInputElement;
    on.checked = enabled;
    on.addEventListener('change', () => onToggle(on.checked));
    const card = el('div', { class: 'refcard' + (enabled ? '' : ' off') + (bad ? ' bad' : '') }, [
      pic,
      el('label', { class: 'row', style: { gap: '4px' } }, [on, el('span', { class: 'hint', text: '사용' })]),
      ...controls,
    ]);
    if (bad) {
      const fix = el('button', { class: 'ghost tiny', text: '맞추기', title: bad }) as HTMLButtonElement;
      fix.addEventListener('click', async () => {
        if (!onFix) return;
        fix.disabled = true;
        try { await onFix(); } finally { fix.disabled = false; }
      });
      card.appendChild(el('div', { class: 'row', style: { gap: '4px' } }, [
        el('span', { class: 'badge err', text: '형식 불일치' }), fix,
      ]));
    }
    return card;
  };

  // --- character references (director reference, docs/09 §7d) ------------------
  const drawCharrefs = (): void => {
    clear(charrefList);
    if (!charrefs.length) {
      charrefList.appendChild(el('div', { class: 'hint', text: '레퍼런스 이미지가 없습니다.' }));
    }
    charrefs.forEach((v, i) => {
      const mode = el('select', { title: '캐릭터만 가져올지, 그림체까지 가져올지' }) as HTMLSelectElement;
      mode.appendChild(el('option', { value: 'character', text: '캐릭터' }));
      mode.appendChild(el('option', { value: 'character&style', text: '캐릭터&스타일' }));
      mode.value = v.mode;
      mode.addEventListener('change', () => { v.mode = mode.value as CharRefEntry['mode']; });
      charrefList.appendChild(refCard(v.file, v.enabled, v.bad,
        (on) => { v.enabled = on; },
        () => { charrefs = charrefs.filter((_x, j) => j !== i); drawCharrefs(); },
        async () => { await refit(v); drawCharrefs(); },
        [mode,
         slider('강도', v.strength, (n) => { v.strength = n; }),
         slider('충실도', v.fidelity, (n) => { v.fidelity = n; })]));
    });
  };

  const drawRefs = (): void => {
    clear(refList);
    if (!vibes.length) {
      refList.appendChild(el('div', { class: 'hint', text: '바이브 이미지가 없습니다.' }));
    }
    vibes.forEach((v, i) => {
      refList.appendChild(refCard(v.file, v.enabled, v.bad,
        (on) => { v.enabled = on; },
        () => { vibes = vibes.filter((_x, j) => j !== i); drawRefs(); },
        async () => { await repng(v); drawRefs(); },
        [slider('강도', v.strength, (n) => { v.strength = n; }),
         slider('정보량', v.informationExtracted, (n) => { v.informationExtracted = n; })]));
    });
  };

  /** Refit a stored charref into a bucket (and a real PNG), replacing its file. */
  const refit = async (v: CharRefEntry): Promise<void> => {
    try {
      const img = await decode(await blobUrl(`${dir}/${v.file}`));
      const b64 = toPng(img, true);
      const portrait = img.height >= img.width;
      const fname = pngName(v.file, true, portrait ? 1024 : 1536, portrait ? 1536 : 1024);
      if (await uploadNow(fname, b64)) { v.file = fname; delete v.bad; }
    } catch (e) { out.textContent = msg(e); }
  };
  /** Re-encode a stored vibe as a real PNG, replacing its file. */
  const repng = async (v: RefEntry): Promise<void> => {
    try {
      const img = await decode(await blobUrl(`${dir}/${v.file}`));
      const fname = pngName(v.file, false, 0, 0);
      if (await uploadNow(fname, toPng(img, false))) { v.file = fname; delete v.bad; }
    } catch (e) { out.textContent = msg(e); }
  };

  /** Flag entries whose stored bytes are not what the encoder wants. */
  const audit = async (): Promise<void> => {
    for (const v of charrefs) {
      try {
        const bytes = await state.fileBytes(`${dir}/${v.file}`);
        const isPng = bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50;
        const w = isPng ? ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0 : 0;
        const h = isPng ? ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0 : 0;
        const ok = BUCKETS.some(([bw, bh]) => bw === w && bh === h);
        v.bad = ok ? undefined : (isPng ? `${w}x${h} — 1024x1536 / 1536x1024 이어야 합니다` : 'PNG 가 아닙니다');
      } catch { /* a missing file shows as 읽지 못함 */ }
    }
    for (const v of vibes) {
      try {
        const bytes = await state.fileBytes(`${dir}/${v.file}`);
        v.bad = (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) ? undefined : 'PNG 가 아닙니다';
      } catch { /* same */ }
    }
    drawCharrefs();
    drawRefs();
  };

  // --- picking: a BUTTON, not an always-open form -------------------------------
  const pickCharref = el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
  pickCharref.addEventListener('change', async () => {
    for (const f of Array.from(pickCharref.files ?? [])) {
      try {
        const url = URL.createObjectURL(f);
        const img = await decode(url);
        URL.revokeObjectURL(url);
        const b64 = toPng(img, true);
        const portrait = img.height >= img.width;
        const fname = pngName(f.name, true, portrait ? 1024 : 1536, portrait ? 1536 : 1024);
        if (!(await uploadNow(fname, b64))) continue;
        charrefs.push({ file: fname, strength: 0.6, fidelity: 0.6, mode: 'character', enabled: true });
      } catch (e) { out.textContent = `${f.name}: ${msg(e)}`; }
    }
    pickCharref.value = '';
    drawCharrefs();
  });
  const pickRef = el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } }) as HTMLInputElement;
  pickRef.addEventListener('change', async () => {
    for (const f of Array.from(pickRef.files ?? [])) {
      try {
        const url = URL.createObjectURL(f);
        const img = await decode(url);
        URL.revokeObjectURL(url);
        const fname = pngName(f.name, false, 0, 0);
        if (!(await uploadNow(fname, toPng(img, false)))) continue;
        vibes.push({ file: fname, strength: 0.6, informationExtracted: 1.0, enabled: true });
      } catch (e) { out.textContent = `${f.name}: ${msg(e)}`; }
    }
    pickRef.value = '';
    drawRefs();
  });
  const addCharref = el('button', { class: 'ghost tiny', text: '＋ 이미지', title: '세로 1024x1536 / 가로 1536x1024 PNG 로 맞춰 올립니다' });
  addCharref.addEventListener('click', () => pickCharref.click());
  const addVibe = el('button', { class: 'ghost tiny', text: '＋ 이미지', title: 'PNG 로 변환해 올립니다' });
  addVibe.addEventListener('click', () => pickRef.click());

  // --- save / delete -------------------------------------------------------------
  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { out.textContent = '이름을 입력해 주세요.'; return; }
    save.disabled = true;
    try {
      if (dir) {
        try {
          const moved = await renameCardFile(dir, nm);
          if (moved !== dir) dir = moved;
        } catch (e) { out.textContent = '파일명 변경 실패 (이름만 저장됩니다): ' + msg(e); }
      }
      const stem = cardStem(nm);
      const target = dir || `studio/characters/${stem}`;
      // Anything flagged is refitted here, so a save never leaves a reference
      // the encoder will refuse.
      for (const v of charrefs) if (v.bad) await refit(v);
      for (const v of vibes) if (v.bad) await repng(v);
      const meta = new Map<string, string>([['name', nm]]);
      meta.set('enabled', enabledBox.checked ? 'true' : 'false');
      if (order.value.trim() && order.value.trim() !== '100') meta.set('order', String(Math.trunc(Number(order.value)) || 100));
      let body = `## 프롬프트\n${caption.value.trim()}\n`;
      if (negative.value.trim()) body += `\n## 네거티브\n${negative.value.trim()}\n`;
      await state.uploadFile('prompt.md', joinFront(meta, body), false, target);
      const position = (posX.value.trim() && posY.value.trim())
        ? { x: Number(posX.value), y: Number(posY.value) } : null;
      await state.uploadFile('preset.json', JSON.stringify({
        version: 1, position, refMode,
        vibe: vibes.map((v) => ({ file: v.file, strength: v.strength,
                                  informationExtracted: v.informationExtracted, enabled: v.enabled })),
        charref: charrefs.map((v) => ({ file: v.file, strength: v.strength,
                                        fidelity: v.fidelity, mode: v.mode, enabled: v.enabled })),
      }, null, 2), false, target);
      hub.notice(`캐릭터 “${nm}” 를 저장했습니다.`, 'ok');
      if (opts.onSaved) opts.onSaved(target);
      else S.selectedFile = target;
      await hub.refreshArea('characters');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '카드 폴더째 지울까요?', async () => {
    if (!dir) return;
    try {
      await state.deleteFile(dir);
      if (opts.onDeleted) opts.onDeleted();
      else S.selectedFile = '';
      await hub.refreshArea('characters');
    } catch (e) { out.textContent = msg(e); }
  });

  const field = (label: string, node: HTMLElement, hint = '') =>
    el('label', { class: 'field' }, [
      el('span', { text: label }), node,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);

  // --- layout: [프롬프트 | 레퍼런스] so the column stays a column ------------------
  let section: 'prompt' | 'refs' = 'prompt';
  const promptPane = el('div', {}, [
    field('이름', name),
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'row' }, [enabledBox, el('span', { text: '활성 (생성에 실림)' })]),
      el('label', { class: 'field', style: { width: '110px', marginBottom: '0' } }, [el('span', { text: '순서' }), order]),
    ]),
    field('프롬프트', caption),
    field('네거티브', negative),
    el('details', { class: 'advbox' }, [
      el('summary', { text: '고급 (위치)' }),
      el('div', { class: 'row', style: { marginBottom: '8px' } }, [
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 x (여럿일 때)' }), posX]),
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 y' }), posY]),
      ]),
    ]),
  ]);

  // 레퍼런스는 탭이다: 바이브와 캐릭터 레퍼런스는 함께 실리지 않으므로
  // (refMode), 두 목록을 나란히 쌓는 대신 하나를 고른다. 기본은 캐릭터.
  const charBtn = el('button', { class: 'tab', text: '캐릭터' }) as HTMLButtonElement;
  const vibeBtn = el('button', { class: 'tab', text: '바이브' }) as HTMLButtonElement;
  const charPane = el('div', {}, [
    el('div', { class: 'row', style: { margin: '6px 0' } }, [
      el('span', { class: 'hint grow', text: '캐릭터 레퍼런스 · v4.5 전용' }), addCharref,
    ]),
    charrefList,
  ]);
  const vibePane = el('div', {}, [
    el('div', { class: 'row', style: { margin: '6px 0' } }, [
      el('span', { class: 'hint grow', text: '바이브 트랜스퍼' }), addVibe,
    ]),
    refList,
  ]);
  const syncRefTabs = (): void => {
    charBtn.classList.toggle('on', refMode === 'charref');
    vibeBtn.classList.toggle('on', refMode === 'vibe');
    charPane.style.display = refMode === 'charref' ? '' : 'none';
    vibePane.style.display = refMode === 'vibe' ? '' : 'none';
  };
  charBtn.addEventListener('click', () => { refMode = 'charref'; syncRefTabs(); });
  vibeBtn.addEventListener('click', () => { refMode = 'vibe'; syncRefTabs(); });
  if (S.status && S.status.charref === false) {
    refMode = 'vibe';
    charBtn.style.display = 'none';
  }
  const refsPane = el('div', {}, [
    el('div', { class: 'tabstrip', style: { marginBottom: '4px' } }, [charBtn, vibeBtn]),
    el('div', { class: 'hint', text: '둘 중 하나만 실립니다 — 지금 열린 탭이 실리는 쪽입니다.' }),
    charPane, vibePane, pickCharref, pickRef,
  ]);

  const secPrompt = el('button', { class: 'tab', text: '프롬프트' });
  const secRefs = el('button', { class: 'tab', text: '레퍼런스' });
  const syncSection = () => {
    secPrompt.classList.toggle('on', section === 'prompt');
    secRefs.classList.toggle('on', section === 'refs');
    promptPane.style.display = section === 'prompt' ? '' : 'none';
    refsPane.style.display = section === 'refs' ? '' : 'none';
  };
  secPrompt.addEventListener('click', () => { section = 'prompt'; syncSection(); });
  secRefs.addEventListener('click', () => { section = 'refs'; syncSection(); });

  const head = (opts.chrome ?? 'centre') === 'centre'
    ? editorHead(dir || '새 캐릭터', [isNew ? null : del, save])
    : el('div', { class: 'row', style: { marginBottom: '6px', justifyContent: 'flex-end', gap: '6px' } },
        [isNew ? null : del, save]);

  rootEl.append(
    head,
    el('div', { class: 'tabstrip', style: { marginBottom: '8px' } }, [secPrompt, secRefs]),
    promptPane,
    refsPane,
    out,
  );
  syncSection();
  syncRefTabs();
  drawRefs();
  drawCharrefs();

  if (dir) {
    void state.readFile(`${dir}/prompt.md`).then((r) => {
      const { meta, body } = splitFront(r.content);
      name.value = meta.get('name') ?? dir.split('/').pop() ?? '';
      enabledBox.checked = (meta.get('enabled') ?? '').toLowerCase() === 'true';
      order.value = meta.get('order') ?? '100';
      const secs = body.split(/^##+\s*(프롬프트|네거티브|positive|negative)\s*$/im);
      if (secs.length === 1) {
        caption.value = body.trim();
      } else {
        for (let i = 1; i + 1 < secs.length; i += 2) {
          const which = secs[i].toLowerCase();
          if (which === '네거티브' || which === 'negative') negative.value = secs[i + 1].trim();
          else caption.value = secs[i + 1].trim();
        }
      }
    }).catch((e) => { out.textContent = msg(e); });
    void state.readFile(`${dir}/preset.json`).then((r) => {
      try {
        const d = JSON.parse(r.content) as { position?: { x?: number; y?: number } | null;
                                             refMode?: string; vibe?: RefEntry[];
                                             charref?: (CharRefEntry & { description?: string })[] };
        if (d.position && typeof d.position === 'object') {
          posX.value = String(d.position.x ?? '');
          posY.value = String(d.position.y ?? '');
        }
        vibes = (d.vibe ?? []).map((v) => ({
          file: String(v.file || ''), strength: Number(v.strength ?? 0.6),
          informationExtracted: Number(v.informationExtracted ?? 1.0),
          enabled: v.enabled !== false,
        })).filter((v) => v.file);
        charrefs = (d.charref ?? []).map((v) => ({
          file: String(v.file || ''), strength: Number(v.strength ?? 0.6),
          fidelity: Number(v.fidelity ?? 0.6),
          mode: v.mode === 'character&style' ? 'character&style' as const : 'character' as const,
          enabled: v.enabled !== false,
        })).filter((v) => v.file);
        // Same inference the backend applies: an explicit refMode wins, an
        // old preset without one means "the list that has something".
        if (d.refMode === 'vibe' || d.refMode === 'charref') refMode = d.refMode;
        else if (vibes.length && !charrefs.length) refMode = 'vibe';
        if (S.status && S.status.charref === false) refMode = 'vibe';
        syncRefTabs();
        drawRefs();
        drawCharrefs();
        void audit();
      } catch { /* a fresh card has no preset yet */ }
    }).catch(() => { /* same */ });
  }
  return rootEl;
}
