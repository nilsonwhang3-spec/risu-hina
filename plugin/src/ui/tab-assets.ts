/**
 * 에셋 - what the card's images are, and whether the backend store has them.
 *
 * Read-mostly on purpose. The card decides an asset's name and field, so a
 * rename or a removal is a card edit (M1's pipeline) and lands in RisuAI
 * through the same 반영 as any other card change; this tab only shows the
 * result and the store's side of it. Grouped by field, in card order, with
 * the sync state per item and a thumbnail where the host can give us one
 * (PocketRisu; the web build's CSP blocks blob: images inside the iframe,
 * so there a type icon stands in).
 */
import { el, clear, searchBox, refocusSearch } from './dom';
import { state, type AssetItem } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';
import { transport } from '../transport';
import { describeSync, syncBusy } from '../assets';

const FIELD_LABEL: Record<string, string> = {
  image: '프로필',
  emotion: '감정 이미지',
  additional: '추가 에셋',
  cc: 'CC 에셋',
  vits: 'VITS 음성',
};
const FIELD_ORDER = ['image', 'emotion', 'additional', 'cc', 'vits'];

const STATE_LABEL: Record<string, [string, string]> = {
  present: ['저장됨', 'ok'],
  missing: ['없음', 'warn'],
  failed: ['읽기 실패', 'err'],
};

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let items: AssetItem[] = [];
let openKey = '';
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
  if (!built || !mount.querySelector('.split')) {
    clear(mount);
    const pane = threePane();
    treeMount = el('div', { class: 'tree' });
    pane.left.appendChild(treeMount);
    noticeMount = el('div');
    viewMount = el('div', { class: 'pad' });
    pane.centre.appendChild(noticeMount);
    pane.centre.appendChild(viewMount);
    mount.appendChild(pane.root);
    built = true;
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    seenSyncAt = syncAt;
    void refresh();
  } else if (seenEpoch !== state.epoch || seenKey !== state.botKey || seenSyncAt !== syncAt) {
    seenEpoch = state.epoch;
    seenKey = state.botKey;
    seenSyncAt = syncAt;
    seenBusy = syncBusy(state.assetSync);
    void refresh();
  } else if (seenBusy !== syncBusy(state.assetSync)) {
    // Only a change in the importer's state redraws the header: every other
    // emit (a file listing bump after a charx build, say) must leave the
    // result the user is reading where it is.
    seenBusy = syncBusy(state.assetSync);
    renderHeader();
  }
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

async function refresh(): Promise<void> {
  try {
    const r = await state.assetList();
    items = r.items;
  } catch (e) {
    items = [];
    notice('에셋 목록을 읽지 못했습니다: ' + (e instanceof Error ? e.message : String(e)), 'err');
  }
  renderTree();
  renderHeader();
  if (openKey && !items.some((i) => i.key === openKey)) openKey = '';
  if (openKey) renderItem(openKey);
}

// --- header (sync state, totals) ---------------------------------------------

function renderHeader(): void {
  if (!viewMount || openKey) return;
  clear(viewMount);
  const p = state.assetSync;
  const total = items.length;
  const present = items.filter((i) => i.state === 'present').length;
  const failed = items.filter((i) => i.state === 'failed').length;
  const bytes = items.reduce((n, i) => n + (i.size || 0), 0);

  const again = el('button', { class: 'ghost tiny', text: syncBusy(p) ? '동기화 중…' : '다시 동기화' }) as HTMLButtonElement;
  again.disabled = syncBusy(p);
  again.addEventListener('click', () => { state.syncAssets(true); });

  viewMount.appendChild(el('div', { class: 'card' }, [
    el('h2', { text: '에셋 동기화' }),
    el('div', { class: 'row' }, [
      el('span', { class: 'grow', text: p ? describeSync(p) : `에셋 ${present}/${total}개 · ${mb(bytes)}` }),
      again,
    ]),
    failed ? el('div', { class: 'hint', style: { marginTop: '6px' }, text:
      `읽기 실패 ${failed}개 - RisuAI 쪽에 파일이 없는 참조입니다. 카드에서 그 항목을 지우거나, 다시 동기화로 한 번 더 시도할 수 있습니다.` }) : null,
    el('div', { class: 'hint', style: { marginTop: '8px' } }, [
      '백엔드 스토어는 charx 생성·에이전트 이미지 작업의 재료입니다. 이름 변경·삭제는 메타 탭의 카드 편집으로 하고 반영합니다. ',
      '왼쪽에서 항목을 고르면 상세를 봅니다.',
    ]),
  ]));
  viewMount.appendChild(charxCard(present, total));
}

/**
 * charx from the working card: the backend assembles it into out/ (files
 * tab → 내 PC에 저장). Missing assets are the one thing that can stop it -
 * the importer throws on an embedded path that is not in the zip - so the
 * choice is shown up front: wait for the sync, or build without them.
 */
function charxCard(present: number, total: number): HTMLElement {
  const out = el('div', { class: 'outbox' });
  const nameInput = el('input', {
    value: (state.workspace?.characterName || 'character'), placeholder: '파일 이름 (.charx)',
  }) as HTMLInputElement;
  const build = el('button', { class: 'primary', text: 'charx 만들기' }) as HTMLButtonElement;
  const buildAnyway = el('button', { class: 'ghost', text: '빠진 에셋 빼고 만들기' }) as HTMLButtonElement;
  buildAnyway.style.display = 'none';
  const run = async (allowMissing: boolean): Promise<void> => {
    build.disabled = buildAnyway.disabled = true;
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '만드는 중입니다… 에셋이 많으면 몇 분 걸립니다.' }));
    try {
      const r = await state.charxBuild({ allowMissing, name: nameInput.value.trim() });
      clear(out);
      out.appendChild(el('div', { class: 'notice ok', text:
        `${r.file} · ${(r.size / 1048576).toFixed(1)}MB · 에셋 ${r.assets}개` + (r.dropped ? ` (${r.dropped}개 제외)` : '')
        + ` · ${r.seconds}s — 워크스페이스 파일 탭의 out/ 에서 내 PC에 저장할 수 있습니다.` }));
      buildAnyway.style.display = 'none';
    } catch (e) {
      clear(out);
      const body = (e as { body?: { missing?: { name: string; type: string }[] } }).body;
      const missing = body?.missing;
      if (Array.isArray(missing) && missing.length) {
        out.appendChild(el('div', { class: 'notice err', text:
          `에셋 ${missing.length}개가 스토어에 없어 만들지 않았습니다: `
          + missing.slice(0, 6).map((m) => m.name || m.type).join(', ') + (missing.length > 6 ? ' …' : '') }));
        out.appendChild(el('div', { class: 'hint', text: '동기화를 다시 돌려 채우거나, 빠진 항목을 빼고 만들 수 있습니다(그 이미지는 카드에서 사라집니다).' }));
        buildAnyway.style.display = '';
      } else {
        out.appendChild(el('div', { class: 'notice err', text: 'charx 를 만들지 못했습니다: ' + (e instanceof Error ? e.message : String(e)) }));
      }
    } finally {
      build.disabled = buildAnyway.disabled = false;
    }
  };
  build.addEventListener('click', () => { void run(false); });
  buildAnyway.addEventListener('click', () => { void run(true); });
  return el('div', { class: 'card' }, [
    el('h2', { text: 'charx 내보내기' }),
    el('div', { class: 'hint', text:
      `작업본 카드(메타·인사말·봇 로어북·Regex·트리거)와 스토어의 에셋 ${present}/${total}개로 charx 를 만듭니다. `
      + '반영하지 않은 편집도 들어갑니다. module.risum 없이 card.json 에 인라인으로 담기며 RisuAI·PocketRisu 가 그대로 가져옵니다.' }),
    el('div', { class: 'row', style: { marginTop: '8px' } }, [nameInput, build, buildAnyway]),
    out,
  ]);
}

function mb(n: number): string {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB';
}

// --- tree ---------------------------------------------------------------------

function renderTree(): void {
  if (!treeMount) return;
  clear(treeMount);
  if (items.length > 6) {
    treeMount.appendChild(searchBox(filterText, (v) => {
      filterText = v;
      renderTree();
      refocusSearch(treeMount);
    }, '에셋 찾기'));
  }
  const needle = filterText.trim().toLowerCase();
  const shown = items.filter((i) => !needle || i.name.toLowerCase().includes(needle) || i.key.toLowerCase().includes(needle));
  if (!shown.length) {
    treeMount.appendChild(el('div', { class: 'hint', style: { padding: '10px' }, text: items.length ? '검색 결과가 없습니다.' : '이 봇은 에셋을 참조하지 않습니다.' }));
    return;
  }
  const groups = new Map<string, AssetItem[]>();
  for (const it of shown) {
    if (!groups.has(it.field)) groups.set(it.field, []);
    groups.get(it.field)!.push(it);
  }
  for (const field of FIELD_ORDER) {
    const list = groups.get(field);
    if (!list) continue;
    const size = list.reduce((n, i) => n + (i.size || 0), 0);
    treeMount.appendChild(el('div', { class: 'treehead', text: `${FIELD_LABEL[field] ?? field} · ${list.length}개` + (size ? ` · ${mb(size)}` : '') }));
    for (const it of list) treeMount.appendChild(row(it));
  }
}

function row(it: AssetItem): HTMLElement {
  const [label, tone] = STATE_LABEL[it.state] ?? [it.state, ''];
  const btn = el('button', { class: 'treefile' + (it.key === openKey ? ' active' : '') }, [
    el('span', { class: 'grow', text: it.name || '(이름 없음)' }),
    el('span', { class: 'dim', text: it.ext.toUpperCase() }),
    el('span', { class: 'badge ' + tone, text: label }),
  ]);
  btn.addEventListener('click', () => {
    openKey = it.key;
    renderTree();
    renderItem(it.key);
  });
  return el('div', { class: 'treerow' }, [btn]);
}

// --- item -----------------------------------------------------------------------

function renderItem(key: string): void {
  if (!viewMount) return;
  const it = items.find((i) => i.key === key);
  clear(viewMount);
  if (!it) { renderHeader(); return; }
  const [label, tone] = STATE_LABEL[it.state] ?? [it.state, ''];

  const back = el('button', { class: 'ghost tiny', text: '← 목록' });
  back.addEventListener('click', () => { openKey = ''; renderTree(); renderHeader(); });

  const preview = el('div', { class: 'assetpreview' });
  const rows: [string, string][] = [
    ['필드', FIELD_LABEL[it.field] ?? it.field],
    ['이름', it.name || '(이름 없음)'],
    ['키', it.key],
    ['형식', it.ext.toUpperCase()],
    ['크기', it.size ? mb(it.size) + ` (${it.size.toLocaleString()} B)` : '-'],
    ['스토어', label + (it.error ? ` · ${it.error}` : '')],
    ['해시', it.hash || '-'],
  ];
  viewMount.appendChild(el('div', { class: 'card' }, [
    el('div', { class: 'row' }, [
      el('h2', { class: 'grow', text: it.name || it.key }),
      el('span', { class: 'badge ' + tone, text: label }),
      back,
    ]),
    preview,
    el('pre', { class: 'mono', text: rows.map(([k, v]) => `${k.padEnd(4)} ${v}`).join('\n') }),
    el('div', { class: 'hint', text: it.field === 'emotion'
      ? '이 이름은 감정 이미지 이름이며, CBS·Lua 에서 {{asset::이름}} 또는 감정 감지로 쓰입니다. 이름을 바꾸려면 메타 탭에서 카드를 고치고 반영합니다.'
      : '이름을 바꾸거나 지우려면 메타 탭에서 카드를 고치고 반영합니다. 스토어의 파일은 참조가 사라진 뒤 GC 로 정리됩니다.' }),
  ]));
  void loadPreview(it, preview);
}

/**
 * A thumbnail from the host where that works (PocketRisu / desktop), the
 * store's copy as a fallback, and a type icon on the web build where the
 * iframe's CSP forbids blob: images.
 */
async function loadPreview(it: AssetItem, mount: HTMLElement): Promise<void> {
  const isImage = /^(png|jpe?g|gif|webp|avif|bmp)$/i.test(it.ext);
  if (!isImage) {
    mount.appendChild(el('div', { class: 'assettype', text: it.ext.toUpperCase() }));
    return;
  }
  if (transport.hostPlatform === 'web') {
    mount.appendChild(el('div', { class: 'assettype', text: '이미지 · 웹에서는 미리보기 없음' }));
    return;
  }
  let url = thumbs.get(it.key) || '';
  if (!url) {
    try {
      const bytes = await Risuai.readImage(it.key);
      if (bytes && (bytes as Uint8Array).byteLength) {
        const view = bytes as Uint8Array;
        const buf = new Uint8Array(view.byteLength);
        buf.set(view);
        url = URL.createObjectURL(new Blob([buf]));
        if (thumbs.size > 40) {
          for (const [k, u] of thumbs) { URL.revokeObjectURL(u); thumbs.delete(k); break; }
        }
        thumbs.set(it.key, url);
      }
    } catch { /* fall through */ }
  }
  if (!url) {
    mount.appendChild(el('div', { class: 'assettype', text: '미리보기를 읽지 못했습니다' }));
    return;
  }
  if (openKey !== it.key) return;
  const img = el('img', { class: 'assetimg', src: url, alt: it.name });
  img.addEventListener('error', () => img.replaceWith(el('div', { class: 'assettype', text: '표시할 수 없는 이미지' })));
  mount.appendChild(img);
}
