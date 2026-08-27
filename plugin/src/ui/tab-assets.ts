/**
 * 에셋 - the card's images as a grid, the way RisuAI shows them.
 *
 * Two sources drawn as one: the CARD's references (assetref rows in the
 * working copy - name, field, key; renamed and removed here and written on
 * 반영 like any other card material) and the STORE's state for each key
 * (present / missing / failed, size) from the background importer.
 *
 * Editing waits for the importer only here: while it runs, every other tab
 * and 반영 work as usual, but a rename or removal of a reference whose bytes
 * are still arriving is the kind of half-state nobody would guess at, so
 * the grid is read-only until the backend reports the bot complete.
 *
 * Thumbnails come from the host (readImage): the bytes are RisuAI's own,
 * keyed by content hash, so no round trip to the backend. A host whose CSP
 * refuses blob: images gets a type badge instead.
 */
import { el, clear, armed, refocusSearch, popover } from './dom';
import { state, type AssetItem, type CardScript } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { transport } from '../transport';
import { describeSync, syncBusy } from '../assets';
import { setToolbarSearch } from './shell';

const FIELD_LABEL: Record<string, string> = {
  image: '프로필',
  emotion: '감정 이미지',
  additional: '추가 에셋',
  cc: 'CC 에셋',
  vits: 'VITS 음성',
};
const FIELD_ORDER = ['image', 'emotion', 'additional', 'cc', 'vits'];

interface Cell {
  /** The card row when the card references it (renamable); null for the portrait. */
  row: CardScript | null;
  field: string;
  name: string;
  key: string;
  ext: string;
  state: 'present' | 'missing' | 'failed' | 'unknown';
  size: number | null;
  origin: string;
}

let built = false;
let gridMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let sideMount: HTMLElement | null = null;
let cells: Cell[] = [];
let seenEpoch = -1;
let seenKey = '';
let seenSyncAt = 0;
let seenBusy = false;
let filterText = '';
const thumbs = new Map<string, string>();

export function renderAssetsTab(mount: HTMLElement): void {
  if (!state.botKey) {
    clear(mount);
    built = false;
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 패널을 연 봇이 있어야 합니다.' }),
    ]));
    return;
  }
  const syncAt = state.assetSync?.finishedAt ?? 0;
  const busy = syncBusy(state.assetSync);
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    sideMount = el('div', { class: 'tree' });
    pane.left.appendChild(sideMount);
    noticeMount = el('div');
    gridMount = el('div', { class: 'pad' });
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(gridMount);
    mount.appendChild(pane.root);
    built = true;
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    seenSyncAt = syncAt;
    seenBusy = busy;
    void refresh();
  } else if (seenEpoch !== state.epoch || seenKey !== state.botKey || seenSyncAt !== syncAt || seenBusy !== busy) {
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    seenSyncAt = syncAt;
    seenBusy = busy;
    void refresh();
  }
  setToolbarSearch(filterText, (v) => {
    filterText = v;
    drawGrid();
    refocusSearch(null);
  }, '에셋 찾기');
  bindAgent({ notice });
  const inner = mount.querySelector('.right-inner');
  if (inner) mountAgent(inner as HTMLElement);
}

function notice(text: string, kind: 'ok' | 'err' | '' = ''): void {
  if (!noticeMount) return;
  clear(noticeMount);
  noticeMount.appendChild(el('div', { class: 'notice ' + kind, style: { margin: '10px 14px 0' }, text }));
  setTimeout(() => { if (noticeMount) clear(noticeMount); }, 9000);
}

/** The card's rows joined with the store's state, portrait first. */
async function refresh(): Promise<void> {
  let rows: CardScript[] = [];
  let store: AssetItem[] = [];
  try {
    [rows, store] = await Promise.all([
      state.cardScripts('assetref'),
      state.assetList().then((r) => r.items).catch(() => [] as AssetItem[]),
    ]);
  } catch (e) {
    notice('에셋 목록을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
  }
  const byKey = new Map(store.map((i) => [i.key, i]));
  const out: Cell[] = [];
  const portrait = store.find((i) => i.field === 'image') ?? null;
  const image = String(state.character?.image ?? '');
  if (image) {
    out.push({
      row: null, field: 'image', name: '프로필', key: image, ext: image.split('.').pop() || 'png',
      state: portrait?.state ?? 'unknown', size: portrait?.size ?? null, origin: 'original',
    });
  }
  for (const r of rows) {
    const e = r.entry as Record<string, unknown>;
    const key = String(e.key ?? '');
    const st = byKey.get(key);
    out.push({
      row: r, field: String(e.field ?? 'additional'), name: String(e.name ?? ''), key,
      ext: String(e.ext ?? (st?.ext ?? 'png')), state: st?.state ?? 'unknown', size: st?.size ?? null,
      origin: r.origin,
    });
  }
  cells = out;
  drawSide();
  drawGrid();
}

// --- side: totals, sync state, tools ----------------------------------------------

function editable(): boolean {
  return !syncBusy(state.assetSync);
}

function drawSide(): void {
  if (!sideMount) return;
  clear(sideMount);
  const p = state.assetSync;
  const present = cells.filter((c) => c.state === 'present').length;
  const bytes = cells.reduce((n, c) => n + (c.size || 0), 0);
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c.field, (counts.get(c.field) ?? 0) + 1);

  sideMount.appendChild(el('div', { class: 'treehead', text: `에셋 ${cells.length}개 · ${mb(bytes)}` }));
  for (const f of FIELD_ORDER) {
    const n = counts.get(f);
    if (n) sideMount.appendChild(el('div', { class: 'hint', style: { padding: '2px 8px' }, text: `${FIELD_LABEL[f] ?? f} ${n}` }));
  }
  sideMount.appendChild(el('div', { class: 'sectionline', style: { margin: '10px 6px' } }));

  const again = el('button', { class: 'ghost tiny', text: syncBusy(p) ? '동기화 중…' : '다시 동기화' }) as HTMLButtonElement;
  again.disabled = syncBusy(p);
  again.addEventListener('click', () => { state.syncAssets(true); });
  sideMount.appendChild(el('div', { class: 'hint', style: { padding: '0 8px 6px' }, text: p ? describeSync(p) : `스토어 ${present}/${cells.length}` }));
  sideMount.appendChild(el('div', { style: { padding: '0 6px' } }, [again]));

  if (!editable()) return;
  sideMount.appendChild(el('div', { class: 'sectionline', style: { margin: '10px 6px' } }));
  sideMount.appendChild(el('div', { class: 'sectiontitle', style: { padding: '0 8px' }, text: '도구' }));
  const strip = el('button', { class: 'ghost tiny', text: '이름의 확장자 일괄 제거' }) as HTMLButtonElement;
  strip.title = '"face.png" 처럼 이름 끝에 붙은 .png/.webp 를 뗍니다. CBS 는 확장자 없는 이름으로 호출합니다.';
  strip.addEventListener('click', async () => {
    strip.disabled = true;
    try {
      const r = await transport.post<{ changed: number }>('/card/assets/rename', { charKey: state.botKey, mode: 'strip-ext' });
      notice(r.changed ? `${r.changed}개 이름에서 확장자를 뗐습니다. 봇 바의 “반영”을 누르면 RisuAI에 쓰입니다.` : '확장자가 붙은 이름이 없습니다.', r.changed ? 'ok' : '');
      void state.refreshBotChanges();
      await refresh();
    } catch (e) {
      notice('실패했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
    } finally {
      strip.disabled = false;
    }
  });
  const rx = el('button', { class: 'ghost tiny', text: '정규식으로 일괄 이름 변경' });
  rx.addEventListener('click', () => openRegexRename(rx));
  sideMount.appendChild(el('div', { style: { padding: '0 6px' } }, [strip]));
  sideMount.appendChild(el('div', { style: { padding: '4px 6px' } }, [rx]));
}

function openRegexRename(anchor: HTMLElement): void {
  const pattern = el('input', { placeholder: '패턴 (정규식), 예: ^Beatrice-' }) as HTMLInputElement;
  const repl = el('input', { placeholder: '바꿀 문자열, 예: 비어 있으면 삭제' }) as HTMLInputElement;
  const out = el('div', { class: 'hint' });
  const body = el('div', { class: 'applypop' });
  const close = popover(anchor, body);
  const run = el('button', { class: 'primary', text: '적용' }) as HTMLButtonElement;
  run.addEventListener('click', async () => {
    run.disabled = true;
    try {
      const r = await transport.post<{ changed: number }>('/card/assets/rename', {
        charKey: state.botKey, mode: 'regex', pattern: pattern.value, repl: repl.value,
      });
      notice(`${r.changed}개 이름을 바꿨습니다. 봇 바의 “반영”을 누르면 RisuAI에 쓰입니다.`, r.changed ? 'ok' : '');
      void state.refreshBotChanges();
      await refresh();
      close();
    } catch (e) {
      out.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      run.disabled = false;
    }
  });
  body.appendChild(el('div', { class: 'hint', text: '모든 에셋 이름에 re.sub(패턴, 바꿀 문자열) 을 적용합니다.' }));
  body.appendChild(el('div', { class: 'row' }, [pattern]));
  body.appendChild(el('div', { class: 'row' }, [repl]));
  body.appendChild(el('div', { class: 'row' }, [run]));
  body.appendChild(out);
}

function mb(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}

// --- the grid --------------------------------------------------------------------------

function drawGrid(): void {
  if (!gridMount) return;
  clear(gridMount);
  if (!editable()) {
    gridMount.appendChild(el('div', { class: 'notice', text:
      '에셋 동기화 중입니다… 동기화가 끝나기 전까지 에셋 편집이 불가합니다. 다른 탭과 반영은 그대로 쓸 수 있습니다.' }));
  }
  const needle = filterText.trim().toLowerCase();
  const shown = cells.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.key.toLowerCase().includes(needle));
  if (!shown.length) {
    gridMount.appendChild(el('div', { class: 'empty', text: cells.length ? '검색 결과가 없습니다.' : '이 봇은 에셋을 참조하지 않습니다.' }));
    return;
  }
  for (const f of FIELD_ORDER) {
    const list = shown.filter((c) => c.field === f);
    if (!list.length) continue;
    gridMount.appendChild(el('div', { class: 'sectiontitle', text: `${FIELD_LABEL[f] ?? f} · ${list.length}` }));
    const grid = el('div', { class: 'assetgrid' });
    for (const c of list) grid.appendChild(cell(c));
    gridMount.appendChild(grid);
  }
  gridMount.appendChild(el('div', { class: 'hint', style: { marginTop: '10px' }, text:
    '같은 이름이 여럿이면 RisuAI 가 호출 때 무작위로 하나를 고르는 랜덤 풀입니다. 이름을 누르면 바꿀 수 있고, 삭제는 카드의 참조만 지웁니다(파일은 RisuAI 가 정리). 둘 다 반영 때 쓰입니다.' }));
}

function cell(c: Cell): HTMLElement {
  const box = el('div', { class: 'assetcell' + (c.origin !== 'original' ? ' changed' : '') + (c.state === 'failed' ? ' failed' : '') });
  const pic = el('div', { class: 'assetpic' });
  box.appendChild(pic);
  void loadThumb(c, pic);

  const nameEl = el('div', { class: 'assetname', text: c.name || '(이름 없음)', title: `${c.key}${c.size ? ' · ' + mb(c.size) : ''}` });
  if (c.row && editable()) {
    nameEl.classList.add('editable');
    nameEl.addEventListener('click', () => beginRename(c, nameEl));
  }
  box.appendChild(nameEl);

  const meta = el('div', { class: 'assetmeta' }, [
    el('span', { text: c.ext.toUpperCase() }),
    c.state === 'missing' ? el('span', { class: 'badge warn', text: '없음' }) : null,
    c.state === 'failed' ? el('span', { class: 'badge err', text: '실패' }) : null,
    c.origin === 'edited' ? el('span', { class: 'badge warn', text: '수정' }) : null,
    c.origin === 'added' ? el('span', { class: 'badge ok', text: '추가' }) : null,
  ]);
  if (c.row && editable()) {
    const del = el('button', { class: 'ghost tiny', text: '✕', title: '카드에서 이 참조를 지웁니다' }) as HTMLButtonElement;
    const row = c.row;
    armed(del, '✕', '정말?', async () => {
      try {
        await state.deleteScript(row.id);
        void state.refreshBotChanges();
        await refresh();
      } catch (e) {
        notice('지우지 못했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
      }
    });
    meta.appendChild(del);
  }
  box.appendChild(meta);
  return box;
}

function beginRename(c: Cell, nameEl: HTMLElement): void {
  if (!c.row) return;
  const row = c.row;
  const input = el('input', { value: c.name, class: 'assetrename' }) as HTMLInputElement;
  const done = async (commit: boolean): Promise<void> => {
    const v = input.value.trim();
    if (!commit || !v || v === c.name) { input.replaceWith(nameEl); return; }
    try {
      await state.saveScript(row.id, { ...(row.entry as Record<string, unknown>), name: v });
      void state.refreshBotChanges();
      await refresh();
    } catch (e) {
      notice('이름을 바꾸지 못했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
      input.replaceWith(nameEl);
    }
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void done(true);
    else if (ev.key === 'Escape') void done(false);
  });
  input.addEventListener('blur', () => void done(true));
  nameEl.replaceWith(input);
  input.focus();
  try { input.select(); } catch { /* linkedom */ }
}

/**
 * Thumbnail read from the host (readImage -> blob: URL). The web build's
 * iframe CSP used to block blob: images; since RisuAI's 2026-08 mainline it
 * allows `img-src * data: blob:`, so every host gets a try. A host that
 * still refuses fires the img error handler, and the type badge stands in.
 */
/**
 * At most this many thumbnail fetches in flight. Three hundred cells firing
 * at once is what made the grid load half its pictures and drop the rest:
 * the host's readImage on web goes to the hub one request at a time, and a
 * burst of them times out. The backend store answers from disk, and a small
 * window keeps it - and the tunnel in front of it - steady.
 */
const THUMB_PARALLEL = 6;
let thumbActive = 0;
const thumbQueue: (() => void)[] = [];

function thumbSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      thumbActive += 1;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        thumbActive -= 1;
        const next = thumbQueue.shift();
        if (next) next();
      });
    };
    if (thumbActive < THUMB_PARALLEL) grant();
    else thumbQueue.push(grant);
  });
}

/** The bytes of one asset: the backend store first, the host as fallback. */
async function thumbBytes(c: Cell): Promise<Uint8Array | null> {
  // The store is content-addressed and already holds everything the importer
  // finished with, so it is the same bytes without the host's per-image
  // round trip to the hub. A cell the store does not have yet (or that
  // failed) still gets the host's copy.
  if (c.state === 'present') {
    try {
      const bytes = await transport.getBinary('/assets/blob', { key: c.key });
      if (bytes.byteLength) return bytes;
    } catch { /* fall back to the host */ }
  }
  try {
    const bytes = await Risuai.readImage(c.key);
    if (bytes && (bytes as Uint8Array).byteLength) return bytes as Uint8Array;
  } catch { /* nothing to show */ }
  return null;
}

async function loadThumb(c: Cell, mount: HTMLElement): Promise<void> {
  const isImage = /^(png|jpe?g|gif|webp|avif|bmp)$/i.test(c.ext);
  if (!isImage) {
    mount.appendChild(el('div', { class: 'assettype', text: c.ext.toUpperCase() }));
    return;
  }
  let url = thumbs.get(c.key) || '';
  if (!url) {
    const release = await thumbSlot();
    try {
      // The grid may have been redrawn while this waited in the queue.
      if (!mount.isConnected) return;
      const view = await thumbBytes(c);
      if (view) {
        const buf = new Uint8Array(view.byteLength);
        buf.set(view);
        url = URL.createObjectURL(new Blob([buf]));
        if (thumbs.size > 400) {
          for (const [k, u] of thumbs) { URL.revokeObjectURL(u); thumbs.delete(k); break; }
        }
        thumbs.set(c.key, url);
      }
    } finally {
      release();
    }
  }
  if (!url) {
    mount.appendChild(el('div', { class: 'assettype', text: c.state === 'missing' ? '없음' : c.ext.toUpperCase() }));
    return;
  }
  if (!mount.isConnected) return;
  const img = el('img', { src: url, alt: c.name, loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: 'assettype', text: c.ext.toUpperCase() })));
  mount.appendChild(img);
}
