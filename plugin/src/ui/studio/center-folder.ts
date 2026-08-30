/**
 * The folder grid - the centre pane when an OUTPUT folder is opened (4.11).
 *
 * Browsing and tidying, not choosing: subfolder cells and image thumbnails,
 * multi-select (Ctrl/Shift), Delete, and drags that actually move files -
 * onto a subfolder cell here or onto a folder row in the OUTPUT tree. The
 * comparison selector is one button away (감정 사진 선택), not the default,
 * because sorting a folder and choosing between candidates are different
 * jobs.
 */
import { el, armed } from '../dom';
import { namePopover } from '../kit';
import { state } from '../../state';
import { workspaceImage } from '../blobimg';
import { installDrag, installDrop, type Incoming } from '../tree';
import { S, hub, IMAGE_RE, OUTPUT_ROOT, persistCols, countFiles, fmtSize, msg, type Folder } from './store';
import { openImage } from './center-single';

const selection = new Set<string>();
let anchorPath = '';

export function drawFolder(node: Folder): void {
  const viewMount = S.viewMount;
  if (!viewMount) return;
  // A different folder means a different selection.
  for (const p of [...selection]) if (!p.startsWith(node.path + '/')) selection.delete(p);

  // --- breadcrumb + actions --------------------------------------------------------
  const crumb = el('div', { class: 'row', style: { gap: '2px', flexWrap: 'wrap' } });
  const parts = node.path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('/');
    if (!path.startsWith(OUTPUT_ROOT)) continue;
    const label = path === OUTPUT_ROOT ? 'output' : parts[i];
    const b = el('button', { class: 'ghost tiny', text: label });
    b.addEventListener('click', () => {
      S.selected = path;
      selection.clear();
      hub.drawLeft();
      hub.drawCentre();
    });
    crumb.appendChild(b);
    if (i < parts.length - 1) crumb.appendChild(el('span', { class: 'hint', text: '›' }));
  }

  const close = el('button', { class: 'ghost tiny', text: '✕', title: '폴더 보기를 닫고 탭으로 돌아갑니다' });
  close.addEventListener('click', () => { S.centreMode = 'tab'; hub.drawCentre(); });
  const pick = el('button', { class: 'primary tiny', text: '감정 사진 선택',
                              title: '이 폴더의 후보들을 그룹으로 비교하고 채택합니다' });
  pick.addEventListener('click', () => { S.centreMode = 'selector'; hub.drawCentre(); });
  const mkdir = el('button', { class: 'ghost tiny', text: '＋ 폴더' }) as HTMLButtonElement;
  mkdir.addEventListener('click', () => {
    namePopover(mkdir, {
      label: `${node.path}/ 안에 새 폴더`, ok: '만들기',
      onSubmit: async (name) => {
        try {
          await state.mkdirFile(node.path + '/' + name.replace(/[\\/]+/g, '-'));
          S.open.add(node.path);
          hub.touchQuiet();
          await hub.refresh();
        } catch (e) {
          hub.notice('폴더를 만들지 못했습니다: ' + msg(e), 'err');
        }
      },
    });
  });
  const cols = el('div', { class: 'row', style: { gap: '2px' } },
    [2, 3, 4].map((n) => {
      const b = el('button', { class: 'ghost tiny' + (S.cols === n ? ' on' : ''), text: String(n) });
      b.addEventListener('click', () => { S.cols = n as 2 | 3 | 4; persistCols(); hub.drawCentre(); });
      return b;
    }));

  const del = el('button', { class: 'ghost tiny' }) as HTMLButtonElement;
  const selInfo = el('span', { class: 'hint' });
  armed(del, '삭제', '한 번 더', async () => {
    try {
      for (const p of [...selection]) await state.deleteFile(p);
      selection.clear();
      hub.touchQuiet();
      await hub.refresh();
    } catch (e) { hub.notice('지우지 못했습니다: ' + msg(e), 'err'); }
  });
  const selAll = el('button', { class: 'ghost tiny', text: '전체 선택' });
  const selNone = el('button', { class: 'ghost tiny', text: '해제' }) as HTMLButtonElement;

  viewMount.appendChild(el('div', { class: 'row', style: { marginBottom: '8px', flexWrap: 'wrap' } }, [
    close, crumb, el('span', { class: 'grow' }),
    selInfo, selAll, selNone, del, mkdir, cols, pick,
  ]));
  viewMount.appendChild(el('div', { class: 'hint', style: { marginBottom: '8px' },
    text: `파일 ${node.files.length} · 하위 폴더 ${node.children.length} — 클릭으로 선택 (Shift 범위) · 두 번 클릭으로 크게 · 끌어서 폴더/왼쪽 트리로 이동` }));

  const syncBar = () => {
    selInfo.textContent = selection.size ? `${selection.size}개 선택` : '';
    del.style.display = selection.size ? '' : 'none';
    selNone.style.display = selection.size ? '' : 'none';
  };
  syncBar();

  // --- the grid ----------------------------------------------------------------------
  const grid = el('div', { class: 'foldergrid', style: { gridTemplateColumns: `repeat(${S.cols}, minmax(0, 1fr))` } });
  viewMount.appendChild(grid);

  // Subfolders first - each one a drop target for the tidy-up drags.
  for (const child of node.children) {
    const cell = el('div', { class: 'fcell foldcell', title: child.path }, [
      el('div', { class: 'foldface', text: '📁' }),
      el('div', { class: 'fname' }, [
        el('span', { text: child.name }),
        el('span', { class: 'n', text: String(countFiles(child)) }),
      ]),
    ]);
    cell.addEventListener('click', () => {
      S.selected = child.path;
      S.open.add(node.path);
      selection.clear();
      hub.drawLeft();
      hub.drawCentre();
    });
    installDrop(cell, {
      into: () => child.path,
      onMove: (path, sources) => void moveInto(path, sources),
      onFiles: (path, files) => void uploadInto(path, files),
    });
    grid.appendChild(cell);
  }

  const images = node.files.filter((f) => IMAGE_RE.test(f.name));
  const others = node.files.filter((f) => !IMAGE_RE.test(f.name));
  const imagePaths = images.map((f) => f.path);

  const syncPicked = () => {
    for (const c of grid.querySelectorAll('.imgcell')) {
      c.classList.toggle('picked', selection.has((c as HTMLElement).title));
    }
    syncBar();
  };
  selAll.addEventListener('click', () => {
    for (const p of imagePaths) selection.add(p);
    syncPicked();
  });
  selNone.addEventListener('click', () => {
    selection.clear();
    syncPicked();
  });

  images.forEach((f, ix) => {
    const cell = el('div', { class: 'fcell imgcell' + (selection.has(f.path) ? ' picked' : ''), title: f.path });
    const pic = workspaceImage(f.path, f.name, { thumb: false });
    pic.classList.add('jobpic');
    cell.append(pic, el('div', { class: 'fname' }, [el('span', { class: 'hint', text: f.name })]));
    // A click SELECTS (Shift for a range) - picking-and-moving is this
    // screen's job, so it must not need a modifier key. Double-click opens
    // the image big in the 1장 tab.
    cell.addEventListener('click', (e) => {
      const ev = e as MouseEvent;
      if (ev.shiftKey && anchorPath) {
        const a = imagePaths.indexOf(anchorPath);
        if (a >= 0) {
          selection.clear();
          for (let i = Math.min(a, ix); i <= Math.max(a, ix); i++) selection.add(imagePaths[i]);
        }
      } else {
        if (selection.has(f.path)) selection.delete(f.path); else selection.add(f.path);
        anchorPath = f.path;
      }
      syncPicked();
    });
    cell.addEventListener('dblclick', () => openImage(f.path, imagePaths));
    // Dragging a selected cell moves the whole selection.
    installDrag(cell, () => (selection.has(f.path) ? [...selection] : [f.path]));
    grid.appendChild(cell);
  });

  if (others.length) {
    const list = el('div', { class: 'filelist', style: { marginTop: '10px' } });
    for (const f of others) {
      list.appendChild(el('div', { class: 'chatitem' }, [
        el('span', { class: 'grow', text: f.name }),
        el('span', { class: 'n', text: fmtSize(f.size) }),
      ]));
    }
    viewMount.appendChild(list);
  }

  if (!node.files.length && !node.children.length) {
    grid.appendChild(el('div', { class: 'empty', text: '비어 있습니다. 이미지를 끌어다 놓거나 배치를 이 폴더로 저장하세요.' }));
  }

  // The grid itself takes OS-file drops (upload into this folder).
  installDrop(viewMount, {
    into: () => node.path,
    onFiles: (path, files) => void uploadInto(path, files),
  });
}

async function moveInto(target: string, sources: string[]): Promise<void> {
  try {
    for (const src of sources) {
      if (src === target || target.startsWith(src + '/')) continue;
      await state.moveFile(src, target);
    }
    selection.clear();
    hub.touchQuiet();
    await hub.refresh();
  } catch (e) {
    hub.notice('옮기지 못했습니다: ' + msg(e), 'err');
  }
}

async function uploadInto(dir: string, files: Incoming[]): Promise<void> {
  try {
    for (const f of files) {
      const b64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => { const s = String(r.result || ''); res(s.slice(s.indexOf(',') + 1)); };
        r.onerror = () => rej(new Error('읽지 못했습니다'));
        r.readAsDataURL(f.file);
      });
      await state.uploadFile(f.file.name, b64, true, dir + (f.rel ? '/' + f.rel : ''));
    }
    hub.notice(`${files.length}개를 올렸습니다.`, 'ok');
    hub.touchQuiet();
    await hub.refresh();
  } catch (e) {
    hub.notice('올리지 못했습니다: ' + msg(e), 'err');
  }
}
