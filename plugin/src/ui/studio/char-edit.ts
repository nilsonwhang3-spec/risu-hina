/**
 * The character card editor - a folder card, edited in the centre pane.
 *
 * A character is not only text: beside the prompt live the reference images
 * and their per-item presets (강도/충실도), which is exactly what NovelAI
 * takes (`reference_*_multiple`, docs/09 §7). Saving writes prompt.md and
 * preset.json; images upload into the card's folder as they are added.
 */
import { el, clear, armed } from '../dom';
import { state } from '../../state';
import { workspaceImage } from '../blobimg';
import { S, hub, msg, cardStem, renameCardFile } from './store';
import { splitFront, joinFront } from './stylefile';
import { editorHead } from './editors';

export interface CharEditorOpts {
  /** 'centre' (default): ← 목록 head with the path. 'inline': a slim control
   * row, for hosting the editor inside the left character view. */
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

export function characterEditor(dir: string, opts: CharEditorOpts = {}): HTMLElement {
  const rootEl = el('div', { class: 'charedit' });
  const isNew = !dir;
  const out = el('div', { class: 'hint' });

  const name = el('input', { placeholder: '히나' }) as HTMLInputElement;
  const caption = el('textarea', { rows: '4', class: 'promptedit',
    placeholder: '이 캐릭터를 그리는 프롬프트 (쉼표로 구분)' }) as HTMLTextAreaElement;
  const negative = el('textarea', { rows: '2', class: 'promptedit',
    placeholder: '이 캐릭터에만 붙는 네거티브' }) as HTMLTextAreaElement;
  const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const order = el('input', { type: 'number', value: '100', step: '10' }) as HTMLInputElement;
  const posX = el('input', { type: 'number', step: '0.1', placeholder: 'x 0~1' }) as HTMLInputElement;
  const posY = el('input', { type: 'number', step: '0.1', placeholder: 'y 0~1' }) as HTMLInputElement;

  interface RefEntry { file: string; strength: number; informationExtracted: number; enabled: boolean; pendingB64?: string }
  interface CharRefEntry { file: string; strength: number; fidelity: number;
                           mode: 'character' | 'character&style'; enabled: boolean; pendingB64?: string }
  let vibes: RefEntry[] = [];
  let charrefs: CharRefEntry[] = [];
  /** 바이브와 캐릭터 레퍼런스는 둘 중 하나만 실린다 - 탭이 그 선택이다. */
  let refMode: 'charref' | 'vibe' = 'charref';
  const refList = el('div', { class: 'verlist' });
  const charrefList = el('div', { class: 'verlist' });

  // A picked file uploads NOW (into the card folder), not at 저장: the row
  // shows the real thumbnail immediately and a forgotten save cannot lose the
  // image. pendingB64 survives only for the legacy no-folder path.
  const uploadNow = async (fname: string, b64: string): Promise<boolean> => {
    if (!dir) return false;
    try {
      await state.uploadFile(fname, b64, true, dir);
      return true;
    } catch (e) {
      out.textContent = `${fname}: 올리지 못했습니다 — ${msg(e)}`;
      return false;
    }
  };

  const num01 = (value: number, title: string, onChange: (n: number) => void): HTMLInputElement => {
    const i = el('input', { type: 'number', step: '0.05', min: '0', max: '1',
                            value: String(value), title }) as HTMLInputElement;
    i.addEventListener('change', () => {
      const n = Math.min(1, Math.max(0, Number(i.value)));
      if (!Number.isNaN(n)) { i.value = String(n); onChange(n); }
    });
    return i;
  };

  const drawRefs = (): void => {
    clear(refList);
    if (!vibes.length) {
      refList.appendChild(el('div', { class: 'hint', text: 'PNG 를 올리면 바이브로 실립니다.' }));
    }
    vibes.forEach((v, i) => {
      const pic = v.pendingB64
        ? el('span', { class: 'hint', text: '(저장 시 올라갑니다)' })
        : workspaceImage(`${dir}/${v.file}`, v.file, { thumb: true });
      const strength = num01(v.strength, '강도 (reference_strength)', (n) => { v.strength = n; });
      const ie = num01(v.informationExtracted, '충실도 (information_extracted)',
                       (n) => { v.informationExtracted = n; });
      const on = el('input', { type: 'checkbox', title: '이 레퍼런스를 실을지' }) as HTMLInputElement;
      on.checked = v.enabled;
      on.addEventListener('change', () => { v.enabled = on.checked; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '목록에서 빼기 (파일은 남습니다)' });
      drop.addEventListener('click', () => { vibes = vibes.filter((_x, j) => j !== i); drawRefs(); });
      refList.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } }, [
        on, pic, el('span', { class: 'grow hint', text: v.file }),
        el('span', { class: 'hint', text: '강도' }), strength,
        el('span', { class: 'hint', text: '충실도' }), ie,
        drop,
      ]));
    });
  };

  const pickRef = el('input', { type: 'file', accept: 'image/png', multiple: true }) as HTMLInputElement;
  pickRef.addEventListener('change', () => {
    for (const f of Array.from(pickRef.files ?? [])) {
      const r = new FileReader();
      r.onload = () => {
        void (async () => {
          const s = String(r.result || '');
          const b64 = s.slice(s.indexOf(',') + 1);
          const entry: RefEntry = { file: f.name, strength: 0.6, informationExtracted: 1.0, enabled: true };
          if (!(await uploadNow(f.name, b64))) {
            if (!dir) entry.pendingB64 = b64; else return;
          }
          vibes.push(entry);
          drawRefs();
        })();
      };
      r.readAsDataURL(f);
    }
    pickRef.value = '';
  });

  // --- 캐릭터 레퍼런스 (director reference, docs/09 §7d) ---------------------
  // The internal encoder accepts only the 1024x1536 / 1536x1024 buckets, so
  // the upload is fitted here with a canvas (letterbox on black, the web
  // client's own preprocessing) - the backend only checks and refuses.
  const drawCharrefs = (): void => {
    clear(charrefList);
    if (!charrefs.length) {
      charrefList.appendChild(el('div', { class: 'hint', text: '이미지를 올리면 버킷 크기로 맞춰 저장됩니다.' }));
    }
    charrefs.forEach((v, i) => {
      const pic = v.pendingB64
        ? el('span', { class: 'hint', text: '(저장 시 올라갑니다)' })
        : workspaceImage(`${dir}/${v.file}`, v.file, { thumb: true });
      const mode = el('select', { title: '캐릭터만 가져올지, 그림체까지 가져올지' }) as HTMLSelectElement;
      mode.appendChild(el('option', { value: 'character', text: '캐릭터' }));
      mode.appendChild(el('option', { value: 'character&style', text: '캐릭터&스타일' }));
      mode.value = v.mode;
      mode.addEventListener('change', () => { v.mode = mode.value as CharRefEntry['mode']; });
      const strength = num01(v.strength, '강도 (strength)', (n) => { v.strength = n; });
      const fidelity = num01(v.fidelity, '충실도 (fidelity)', (n) => { v.fidelity = n; });
      const on = el('input', { type: 'checkbox', title: '이 레퍼런스를 실을지' }) as HTMLInputElement;
      on.checked = v.enabled;
      on.addEventListener('change', () => { v.enabled = on.checked; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '목록에서 빼기 (파일은 남습니다)' });
      drop.addEventListener('click', () => { charrefs = charrefs.filter((_x, j) => j !== i); drawCharrefs(); });
      charrefList.appendChild(el('div', { class: 'row', style: { alignItems: 'center', gap: '6px' } }, [
        on, pic, el('span', { class: 'grow hint', text: v.file }),
        mode,
        el('span', { class: 'hint', text: '강도' }), strength,
        el('span', { class: 'hint', text: '충실도' }), fidelity,
        drop,
      ]));
    });
  };

  const fitToBucket = async (f: File): Promise<{ name: string; b64: string } | null> => {
    try {
      const url = URL.createObjectURL(f);
      const img = new Image();
      await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('이미지를 읽지 못했습니다'));
        img.src = url;
      });
      const portrait = img.height >= img.width;
      const w = portrait ? 1024 : 1536;
      const h = portrait ? 1536 : 1024;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // Letterbox on black (contain), not crop: the web client pads the same
      // way, and a reference with its edges cut off references less.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, w, h);
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
      URL.revokeObjectURL(url);
      const data = canvas.toDataURL('image/png');
      return { name: f.name.replace(/\.[^.]+$/, '') + `-${w}x${h}.png`,
               b64: data.slice(data.indexOf(',') + 1) };
    } catch {
      return null;
    }
  };

  const pickCharref = el('input', { type: 'file', accept: 'image/*', multiple: true }) as HTMLInputElement;
  pickCharref.addEventListener('change', async () => {
    for (const f of Array.from(pickCharref.files ?? [])) {
      const fitted = await fitToBucket(f);
      if (!fitted) { out.textContent = `${f.name}: 버킷 크기로 맞추지 못했습니다.`; continue; }
      const entry: CharRefEntry = { file: fitted.name, strength: 0.6, fidelity: 0.6,
                                    mode: 'character', enabled: true };
      if (!(await uploadNow(fitted.name, fitted.b64))) {
        if (!dir) entry.pendingB64 = fitted.b64; else continue;
      }
      charrefs.push(entry);
      drawCharrefs();
    }
    pickCharref.value = '';
  });

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) { out.textContent = '이름을 입력해 주세요.'; return; }
    save.disabled = true;
    try {
      // Renaming the card renames its folder, same rule as the .md cards.
      if (dir) {
        try {
          const moved = await renameCardFile(dir, nm);
          if (moved !== dir) dir = moved;
        } catch (e) { out.textContent = '파일명 변경 실패 (이름만 저장됩니다): ' + msg(e); }
      }
      const stem = cardStem(nm);
      const target = dir || `studio/characters/${stem}`;
      for (const v of [...vibes, ...charrefs]) {
        if (v.pendingB64) {
          await state.uploadFile(v.file, v.pendingB64, true, target);
          delete v.pendingB64;
        }
      }
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

  // 레퍼런스는 탭이다: 바이브와 캐릭터 레퍼런스는 함께 실리지 않으므로
  // (refMode), 두 목록을 나란히 쌓는 대신 하나를 고른다. 기본은 캐릭터.
  const charBtn = el('button', { class: 'modebtn', text: '캐릭터 레퍼런스' }) as HTMLButtonElement;
  const vibeBtn = el('button', { class: 'modebtn', text: '바이브 레퍼런스' }) as HTMLButtonElement;
  const charPane = el('div', {}, [
    el('div', { class: 'hint', text: '장당 5 Anlas · v4.5 전용' }),
    charrefList,
    field('이미지 추가', pickCharref),
  ]);
  const vibePane = el('div', {}, [
    el('div', { class: 'hint', text: '인코딩 2 Anlas/장 (캐시 시 0) · v5 미지원' }),
    refList,
    field('PNG 추가', pickRef),
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

  const head = (opts.chrome ?? 'centre') === 'centre'
    ? editorHead(dir || '새 캐릭터', [isNew ? null : del, save])
    : el('div', { class: 'row', style: { marginBottom: '6px', justifyContent: 'flex-end', gap: '6px' } },
        [isNew ? null : del, save]);

  rootEl.append(
    head,
    field('이름', name, '카드 폴더 이름과 프롬프트 조립에 쓰입니다'),
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'row' }, [enabledBox, el('span', { text: '활성 (생성에 실림)' })]),
      el('label', { class: 'field', style: { width: '130px', marginBottom: '0' } }, [el('span', { text: '순서' }), order]),
    ]),
    field('프롬프트', caption),
    field('네거티브', negative),
    el('div', { class: 'sectiontitle', text: '레퍼런스' }),
    el('div', { class: 'row', style: { gap: '6px', marginBottom: '6px' } }, [charBtn, vibeBtn]),
    charPane,
    vibePane,
    el('details', { class: 'advbox' }, [
      el('summary', { text: '고급' }),
      el('div', { class: 'row', style: { marginBottom: '8px' } }, [
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 x (여럿일 때)' }), posX]),
        el('label', { class: 'field grow', style: { marginBottom: '0' } }, [el('span', { text: '위치 y' }), posY]),
      ]),
    ]),
    out,
  );
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
      } catch { /* a fresh card has no preset yet */ }
    }).catch(() => { /* same */ });
  }
  return rootEl;
}
