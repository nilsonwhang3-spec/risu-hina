/**
 * The file view - a workspace browser, promoted to its own tab.
 *
 * It used to be an options panel inside the editor, which put a file tree in a
 * third of a column next to the transcript it has nothing to do with. Files are
 * their own material, so they get the same shape as every other view: tree on
 * the left, contents in the middle, agent on the right.
 *
 * **What is shown by default is what a person put in or would take out.** The
 * workspace also holds the frozen originals, the generated helper, the scoped
 * snapshot and the agent's scratch - all of it real, none of it interesting
 * unless something has gone wrong. Those are hidden behind a toggle rather than
 * removed, because "정리" needs to be able to say what it is about to delete.
 */
import { el, clear, armed } from './dom';
import { state, type FileArea, type FileListing, type WorkspaceFile } from '../state';
import { threePane } from './panes';
import { bindAgent, mountAgent } from './agentpane';

const AREA_LABEL: Record<string, [string, string]> = {
  uploads: ['업로드', '직접 올리신 참고 파일입니다. 정리해도 남습니다.'],
  out: ['결과물', 'AI가 만든 산출물입니다. 내려받기 전이면 남겨 두세요.'],
  original: ['원본', '가져온 그대로의 스냅샷입니다. 비교 기준이라 지울 수 없습니다.'],
  scripts: ['스크립트', 'AI가 작성해 실행한 파이썬입니다.'],
  skills: ['스킬', '켜 둔 스크립트 스킬이 실행 때마다 여기로 복사됩니다.'],
  scratch: ['임시', 'AI의 작업용 파일입니다. 언제 지워도 됩니다.'],
  '.scratch': ['내부', '스코프 스냅샷과 제안 큐입니다. 다음 실행 때 다시 만들어집니다.'],
};

/** The two areas a person actually put things in or takes things out of. */
const USER_AREAS = new Set(['uploads', 'out']);

let built = false;
let treeMount: HTMLElement | null = null;
let viewMount: HTMLElement | null = null;
let noticeMount: HTMLElement | null = null;
let showInternal = false;
let openPath = '';

export function renderFilesTab(mount: HTMLElement): void {
  if (!state.activeCharKey) {
    clear(mount);
    built = false;
    mount.appendChild(el('div', { class: 'pad' }, [
      el('div', { class: 'empty', text: '먼저 “챗 선택” 탭에서 챗을 골라 주세요.' }),
    ]));
    return;
  }

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
    mountAgent(pane.right.querySelector('.right-inner') as HTMLElement);
    built = true;
    void refresh();
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
  if (!treeMount) return;
  clear(treeMount);
  treeMount.appendChild(el('div', { class: 'hint', style: { padding: '8px' }, text: '읽는 중입니다…' }));
  try {
    const data = await state.files();
    drawTree(data);
  } catch (e) {
    clear(treeMount);
    treeMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

function drawTree(data: FileListing): void {
  if (!treeMount) return;
  clear(treeMount);

  const shown = data.areas.filter((a) => showInternal || USER_AREAS.has(a.area));
  const hidden = data.areas.filter((a) => !USER_AREAS.has(a.area) && a.count > 0);

  // --- actions ---------------------------------------------------------------
  const picker = el('input', { type: 'file', style: { display: 'none' } });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      await upload(file);
      notice(`${file.name} 을(를) 올렸습니다. AI가 uploads/ 에서 읽을 수 있습니다.`, 'ok');
      await refresh();
    } catch (e) {
      notice('업로드에 실패했습니다: ' + msg(e), 'err');
    } finally {
      picker.value = '';
    }
  });
  const uploadBtn = el('button', { class: 'primary tiny', text: '올리기' });
  uploadBtn.addEventListener('click', () => picker.click());

  const reloadBtn = el('button', { class: 'ghost tiny', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());

  treeMount.appendChild(el('div', { class: 'treehead' }, [uploadBtn, reloadBtn, picker]));

  let anyFiles = false;
  for (const area of shown) {
    if (!area.count) continue;
    anyFiles = true;
    treeMount.appendChild(areaBranch(area));
  }
  if (!anyFiles) {
    treeMount.appendChild(el('div', {
      class: 'hint', style: { padding: '8px' },
      text: showInternal ? '파일이 없습니다.' : '올린 파일도 결과물도 아직 없습니다.',
    }));
  }

  // --- the hidden half -------------------------------------------------------
  const toggle = el('button', {
    class: 'ghost tiny',
    text: showInternal
      ? '내부 파일 숨기기'
      : `내부 파일 보기 (${hidden.reduce((n, a) => n + a.count, 0)})`,
  });
  toggle.addEventListener('click', () => {
    showInternal = !showInternal;
    void refresh();
  });

  const cleanBtn = el('button', { class: 'ghost tiny' });
  armed(cleanBtn, '임시 정리', '정말 정리할까요?', async () => {
    try {
      const r = await state.cleanFiles();
      notice(`${r.removed}개를 지워 ${fmtSize(r.freed)}를 비웠습니다.`, 'ok');
      await refresh();
    } catch (e) {
      notice('정리에 실패했습니다: ' + msg(e), 'err');
    }
  });

  treeMount.appendChild(el('div', { class: 'treefoot' }, [
    toggle,
    cleanBtn,
    el('div', { class: 'hint', text: `전체 ${fmtSize(data.totalSize)}` }),
  ]));
}

function areaBranch(area: FileArea): HTMLElement {
  const [label, why] = AREA_LABEL[area.area] ?? [area.area, ''];
  const rows = area.files.map((f) => fileRow(area, f));

  const head = el('button', { class: 'treebranch', title: why }, [
    el('span', { class: 'grow', text: label }),
    el('span', { class: 'hint', text: String(area.count) }),
  ]);
  const body = el('div', { class: 'treekids' }, rows);
  head.addEventListener('click', () => {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  });
  // Internal areas start collapsed: they are shown for reference, not for use.
  if (!USER_AREAS.has(area.area)) body.style.display = 'none';

  return el('div', {}, [head, body]);
}

function fileRow(area: FileArea, f: WorkspaceFile): HTMLElement {
  const name = el('button', {
    class: 'treefile' + (f.path === openPath ? ' on' : ''),
    text: f.name,
    title: `${f.path} · ${fmtSize(f.size)}`,
  });
  name.addEventListener('click', () => void open(f, area));

  const row = el('div', { class: 'treerow' }, [name]);
  if (area.deletable) {
    const del = el('button', { class: 'ghost tiny' });
    armed(del, '×', '한 번 더', async () => {
      try {
        await state.deleteFile(f.path);
        if (openPath === f.path) {
          openPath = '';
          if (viewMount) clear(viewMount);
        }
        await refresh();
      } catch (e) {
        notice('삭제하지 못했습니다: ' + msg(e), 'err');
      }
    });
    row.appendChild(del);
  }
  return row;
}

async function open(f: WorkspaceFile, area: FileArea): Promise<void> {
  if (!viewMount) return;
  openPath = f.path;
  for (const b of Array.from(document.querySelectorAll('.treefile'))) {
    b.classList.toggle('on', (b as HTMLElement).title.startsWith(f.path + ' '));
  }

  clear(viewMount);
  if (!f.textual) {
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', { text: f.path }),
      el('div', { class: 'hint', text: `${fmtSize(f.size)} · 텍스트 파일이 아니라 미리보기를 건너뜁니다.` }),
    ]));
    return;
  }
  viewMount.appendChild(el('div', { class: 'hint', text: '여는 중입니다…' }));
  try {
    const r = await state.readFile(f.path);
    clear(viewMount);
    const ask = el('button', { class: 'ghost tiny', text: 'AI에게 이 파일 보여주기' });
    ask.addEventListener('click', () => {
      // The agent reads it itself; handing it the path is cheaper and more
      // honest than pasting a file into the conversation.
      notice(`AI 패널에 “${f.path} 읽어 줘” 라고 물어보시면 됩니다.`);
    });
    viewMount.appendChild(el('div', { class: 'card' }, [
      el('h2', {}, [
        el('span', { text: f.path }),
        el('span', { class: 'spacer' }),
      ]),
      el('div', { class: 'row', style: { marginBottom: '8px' } }, [
        el('span', {
          class: 'hint',
          text: `${fmtSize(r.size)}${r.truncated ? ' · 앞부분만 표시합니다' : ''}`
                + ` · ${AREA_LABEL[area.area]?.[0] ?? area.area}`,
        }),
        el('span', { class: 'spacer' }),
        ask,
      ]),
      el('pre', { class: 'mono filepreview', text: r.content || r.note || '(비어 있습니다)' }),
    ]));
  } catch (e) {
    clear(viewMount);
    viewMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
  }
}

/**
 * Text goes as text, everything else as base64.
 *
 * The only way out of this iframe is Risuai.nativeFetch with a JSON body, so a
 * binary has to survive as characters; base64 is the one encoding that does
 * without corrupting the bytes.
 */
async function upload(file: File): Promise<void> {
  const isText = /\.(md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i.test(file.name);
  if (isText) {
    await state.uploadFile(file.name, await file.text());
    return;
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  await state.uploadFile(file.name, btoa(bin), true);
}

function fmtSize(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
