/**
 * The centre-pane file editors: a style/fragment .md as front-matter fields
 * above the body, a scene preset .json as a form (raw JSON on request), and
 * the raw-text fallback for anything else.
 */
import { el, clear, armed } from '../dom';
import { attachHilite } from '../hilite';
import { state } from '../../state';
import { S, hub, msg, areaOfPath, renameCardFile } from './store';
import { splitFront, joinFront } from './stylefile';

/** Fragment names for `<` completion, shared by every prompt editor here. */
function fragNames(): string[] {
  return (S.cards.fragments ?? []).map((i) => i.name);
}

export function editorHead(path: string, extra: (HTMLElement | null)[] = []): HTMLElement {
  const back = el('button', { class: 'ghost tiny', text: '← 목록' });
  back.addEventListener('click', () => { S.selectedFile = ''; hub.drawLeft(); hub.drawCentre(); });
  return el('div', { class: 'row', style: { marginBottom: '8px' } }, [
    back, el('span', { class: 'sectiontitle grow', text: path }), ...extra,
  ]);
}

export interface CardEditorOpts {
  /** 'centre' (default): ← 목록 head with the path. 'inline': slim controls,
   * for hosting inside the fragment organizer. */
  chrome?: 'centre' | 'inline';
  /** After a successful save; `path` is the (possibly renamed) file. */
  onSaved?: (path: string) => void;
  onDeleted?: () => void;
}

/** The centre-pane wrapper (kept for the selectedFile dispatch). */
export function drawCardEditor(path: string): void {
  if (!S.viewMount) return;
  S.viewMount.appendChild(cardEditor(path, { chrome: 'centre' }));
}

/** A style or fragment .md: front-matter fields above the body. */
export function cardEditor(path: string, opts: CardEditorOpts = {}): HTMLElement {
  const isStyle = areaOfPath(path) === 'styles';
  const out = el('div', { class: 'hint' });
  const name = el('input', { placeholder: '(파일 이름)' }) as HTMLInputElement;
  const desc = el('input', { placeholder: '한 줄 설명' }) as HTMLInputElement;
  const enabledBox = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const order = el('input', { type: 'number', value: '100', step: '10',
                              title: '작을수록 앞에 이어집니다' }) as HTMLInputElement;
  const body = el('textarea', { rows: '18', class: 'promptedit',
    placeholder: isStyle ? '## positive\n…\n\n## negative\n…' : '조각 본문 — <이름> 으로 참조됩니다',
  }) as HTMLTextAreaElement;
  setTimeout(() => attachHilite(body, { mode: 'nai', fragments: fragNames }), 0);

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      if (opts.onDeleted) opts.onDeleted();
      else S.selectedFile = '';
      await hub.refreshArea(areaOfPath(path));
    } catch (e) { out.textContent = msg(e); }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '';
    try {
      const meta = new Map<string, string>();
      if (name.value.trim()) meta.set('name', name.value.trim());
      if (desc.value.trim()) meta.set('description', desc.value.trim());
      if (isStyle) {
        meta.set('enabled', enabledBox.checked ? 'true' : 'false');
        if (order.value.trim() && order.value.trim() !== '100') meta.set('order', String(Math.trunc(Number(order.value)) || 100));
      }
      const dir = path.slice(0, path.lastIndexOf('/'));
      const fname = path.slice(path.lastIndexOf('/') + 1);
      await state.uploadFile(fname, joinFront(meta, body.value), false, dir);
      // The name is the identity: renaming the card renames the file, so a
      // fragment's `<이름>` keeps resolving and the list shows what you typed.
      if (name.value.trim()) {
        try {
          const moved = await renameCardFile(path, name.value.trim());
          if (moved !== path) {
            if (opts.onSaved) opts.onSaved(moved);
            else S.selectedFile = moved;
            path = moved;
          }
        } catch (e) { out.textContent = '이름은 저장됐지만 파일명 변경은 실패했습니다: ' + msg(e); }
      }
      if (!out.textContent) out.textContent = '저장했습니다.';
      await hub.refreshArea(isStyle ? 'styles' : 'fragments');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  const head = (opts.chrome ?? 'centre') === 'centre'
    ? editorHead(path, [del, save])
    : el('div', { class: 'row', style: { marginBottom: '6px', justifyContent: 'flex-end', gap: '6px' } }, [del, save]);

  const rootEl = el('div', {}, [
    head,
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('label', { class: 'field' }, [el('span', { text: '설명' }), desc]),
    isStyle ? el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'row' }, [enabledBox, el('span', { text: '활성 (생성에 실림)' })]),
      el('label', { class: 'field', style: { width: '130px', marginBottom: '0' } }, [el('span', { text: '순서' }), order]),
    ]) : null,
    el('label', { class: 'field' }, [el('span', { text: isStyle ? '본문 (## positive / ## negative)' : '본문' }), body]),
    out,
  ]);

  void state.readFile(path).then((r) => {
    const { meta, body: b } = splitFront(r.content);
    name.value = meta.get('name') ?? '';
    desc.value = meta.get('description') ?? '';
    enabledBox.checked = (meta.get('enabled') ?? '').toLowerCase() === 'true';
    order.value = meta.get('order') ?? '100';
    body.value = b;
  }).catch((e) => { out.textContent = msg(e); });
  return rootEl;
}

/** Scene presets shown raw on request ('원본 JSON') instead of as the form. */
export const rawView = new Set<string>();

/**
 * A scene preset as a form: the preset name, then one row per scene. The file
 * keeps the reference app's shape (read_scenes reads it verbatim) - unknown
 * top-level keys are preserved on save, and '원본 JSON' opens the raw editor
 * for anything the form does not show.
 */
export function drawSceneEditor(path: string): void {
  if (!S.viewMount) return;
  const out = el('div', { class: 'hint' });
  const name = el('input', { placeholder: '프리셋 이름' }) as HTMLInputElement;
  const list = el('div', { class: 'verlist' });
  let extra: Record<string, unknown> = { version: 1 };
  interface SceneRow { name: string; prompt: string; negativePrompt: string; width: number; height: number }
  let scenes: SceneRow[] = [];

  const drawRows = (): void => {
    clear(list);
    if (!scenes.length) list.appendChild(el('div', { class: 'hint', text: '씬이 없습니다.' }));
    scenes.forEach((s, i) => {
      const nm = el('input', { value: s.name, placeholder: '씬 이름 (파일명에 들어갑니다)' }) as HTMLInputElement;
      nm.addEventListener('change', () => { s.name = nm.value; });
      const pr = el('textarea', { rows: '2', class: 'promptedit', placeholder: '프롬프트' }) as HTMLTextAreaElement;
      pr.value = s.prompt;
      pr.addEventListener('change', () => { s.prompt = pr.value; });
      setTimeout(() => attachHilite(pr, { mode: 'nai', fragments: fragNames }), 0);
      const ng = el('input', { value: s.negativePrompt, placeholder: '네거티브 (선택)' }) as HTMLInputElement;
      ng.addEventListener('change', () => { s.negativePrompt = ng.value; });
      const w = el('input', { type: 'number', value: s.width ? String(s.width) : '', placeholder: '가로' }) as HTMLInputElement;
      w.addEventListener('change', () => { s.width = Math.trunc(Number(w.value)) || 0; });
      const h = el('input', { type: 'number', value: s.height ? String(s.height) : '', placeholder: '세로' }) as HTMLInputElement;
      h.addEventListener('change', () => { s.height = Math.trunc(Number(h.value)) || 0; });
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '이 씬을 뺍니다' });
      drop.addEventListener('click', () => { scenes = scenes.filter((_x, j) => j !== i); drawRows(); });
      list.appendChild(el('div', { class: 'scenerow' }, [
        el('div', { class: 'row', style: { gap: '6px' } }, [
          nm, w, h, drop,
        ]),
        pr,
        ng,
      ]));
    });
  };

  const add = el('button', { class: 'ghost tiny', text: '＋ 씬 추가' });
  add.addEventListener('click', () => { scenes.push({ name: '', prompt: '', negativePrompt: '', width: 0, height: 0 }); drawRows(); });
  const raw = el('button', { class: 'ghost tiny', text: '원본 JSON' });
  raw.addEventListener('click', () => { rawView.add(path); hub.drawCentre(); });

  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      S.selectedFile = '';
      await hub.refreshArea(areaOfPath(path));
    } catch (e) { out.textContent = msg(e); }
  });

  save.addEventListener('click', async () => {
    save.disabled = true;
    out.textContent = '';
    try {
      const kept = scenes
        .map((s) => ({ name: s.name.trim(), prompt: s.prompt, negativePrompt: s.negativePrompt,
                       width: s.width || 0, height: s.height || 0 }))
        .filter((s) => s.name);
      if (scenes.length && !kept.length) { out.textContent = '씬 이름을 하나 이상 채워 주세요.'; return; }
      const doc = { ...extra, name: name.value.trim() || path.split('/').pop()!.replace(/\.json$/, ''), scenes: kept };
      const dir = path.slice(0, path.lastIndexOf('/'));
      await state.uploadFile(path.split('/').pop()!, JSON.stringify(doc, null, 2), false, dir);
      if (name.value.trim()) {
        try {
          const moved = await renameCardFile(path, name.value.trim());
          if (moved !== path) { path = moved; S.selectedFile = moved; }
        } catch (e) { out.textContent = '이름은 저장됐지만 파일명 변경은 실패했습니다: ' + msg(e); }
      }
      if (!out.textContent) out.textContent = '저장했습니다.';
      await hub.refreshArea('scenes');
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  S.viewMount.appendChild(el('div', {}, [
    editorHead(path, [raw, del, save]),
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('div', { class: 'sectiontitle', text: '씬' }),
    el('div', { class: 'hint', text: '배치 탭에서 이 프리셋을 불러와 필요한 씬만 예약에 담습니다. 씬 이름이 파일명의 감정 자리에 들어갑니다.' }),
    list,
    el('div', { class: 'row', style: { marginTop: '6px' } }, [add]),
    out,
  ]));

  void state.readFile(path).then((r) => {
    try {
      const d = JSON.parse(r.content) as Record<string, unknown>;
      const { scenes: rawScenes, name: rawName, ...rest } = d;
      extra = rest;
      name.value = String(rawName ?? '');
      scenes = (Array.isArray(rawScenes) ? rawScenes : []).map((s) => ({
        name: String((s as SceneRow).name ?? ''), prompt: String((s as SceneRow).prompt ?? ''),
        negativePrompt: String((s as SceneRow).negativePrompt ?? ''),
        width: Math.trunc(Number((s as SceneRow).width)) || 0,
        height: Math.trunc(Number((s as SceneRow).height)) || 0,
      }));
      drawRows();
    } catch (e) {
      out.textContent = 'JSON 을 읽지 못했습니다 — 원본 JSON 으로 여세요: ' + msg(e);
    }
  }).catch((e) => { out.textContent = msg(e); });
  drawRows();
}

/** A raw file (scene preset JSON, a fragment collection): text in place. */
export function drawRawFile(path: string): void {
  if (!S.viewMount) return;
  const box = el('textarea', { rows: '22', class: 'promptedit' }) as HTMLTextAreaElement;
  const out = el('div', { class: 'hint' });
  const save = el('button', { class: 'primary tiny', text: '저장' }) as HTMLButtonElement;
  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  armed(del, '삭제', '정말 지울까요?', async () => {
    try {
      await state.deleteFile(path);
      S.selectedFile = '';
      await hub.refreshArea(areaOfPath(path));
    } catch (e) { out.textContent = msg(e); }
  });
  let form: HTMLElement | null = null;
  if (rawView.has(path)) {
    form = el('button', { class: 'ghost tiny', text: '폼 편집' });
    form.addEventListener('click', () => { rawView.delete(path); hub.drawCentre(); });
  }
  S.viewMount.append(editorHead(path, [form, del, save]), box, out);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const fname = path.slice(path.lastIndexOf('/') + 1);
      await state.uploadFile(fname, box.value, false, dir);
      out.textContent = '저장했습니다.';
      await hub.refreshArea(areaOfPath(path));
    } catch (e) {
      out.textContent = msg(e);
    } finally { save.disabled = false; }
  });

  void state.readFile(path).then((r) => {
    box.value = r.content;
    if (!r.textual) out.textContent = r.note || '텍스트 파일이 아닙니다.';
  }).catch((e) => { out.textContent = msg(e); });
}
