/**
 * The agent panel.
 *
 * Two things it must never blur:
 *
 *  - A proposal is not an edit. Staged items render as a review list with
 *    explicit 승인 / 거부, and the turn list shows them as previews. The agent
 *    is instructed to say "제안했습니다" rather than "고쳤습니다"; the UI has to
 *    hold up the same distinction visually.
 *  - Cost is per turn, small, and honest. An unpriced model shows "가격 미설정",
 *    never $0.00 - a cost line that silently reads zero is worse than one that
 *    admits it does not know.
 *
 * The tool trace is glyphs, not function names: a run that lists, reads twice
 * and then proposes should read as a sentence, and repeats collapse to ×N so a
 * long run does not become a wall of identical chips.
 */
import { el, clear, popover, TOOL_GLYPH, PAPER_PLANE, ICON } from './dom';
import { state, type StagedEdit, type AgentSessionInfo, type PendingAction } from '../state';
import { renderMarkdown } from './markdown';
import { workspaceImage } from './blobimg';
import { showArtifact } from './artifact';
import { clientLog } from '../transport';
import { currentMode } from './shell';
import { installDrop } from './tree';

const IMG_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

export interface AgentPanelHooks {
  /** Show staged proposals as previews in the turn list. */
  onStagedChanged: (staged: StagedEdit[]) => void;
  onApplied: () => void | Promise<void>;
  notice: (text: string, kind?: 'ok' | 'err' | '') => void;
}

export class AgentPanel {
  readonly root: HTMLElement;
  private log: HTMLElement;
  private stagedBox: HTMLElement;
  private input: HTMLTextAreaElement;
  private send: HTMLButtonElement;
  private status: HTMLElement;
  private historyBtn: HTMLButtonElement;
  private busy = false;
  private loaded = false;
  private picker: HTMLInputElement;
  /** Workspace paths uploaded for the message being composed. */
  private attached: string[] = [];
  private attachBar = el('div', { class: 'attachbar', style: { display: 'none' } });
  private actionBox: HTMLElement;
  /** out/ paths already offered, so the card does not churn every refresh. */
  private outSeen = '';
  private outPrimed = false;

  constructor(private hooks: AgentPanelHooks) {
    this.log = el('div', { class: 'agentlog' });
    this.stagedBox = el('div', { class: 'stagedbox' });
    this.actionBox = el('div', { class: 'stagedbox' });
    this.status = el('div', { class: 'hint grow' });

    const fresh = el('button', {
      class: 'ghost tiny', title: '지금 대화를 접고 새 대화를 시작합니다', text: '새 대화',
    });
    fresh.addEventListener('click', () => void this.newConversation());

    this.historyBtn = el('button', {
      class: 'ghost tiny', title: '이전 대화 목록', text: '이전 대화',
    });
    this.historyBtn.addEventListener('click', () => void this.openHistory());

    this.input = el('textarea', {
      class: 'agentinput',
      placeholder: '챗에서 수정이나 조정이 필요한 부분을 말씀하세요. 궁금한 점이 있다면 무엇이든 물어보세요.',
    });
    this.input.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      // Enter sends, Shift+Enter newlines - the chat convention. Multi-line
      // instructions are common enough that the escape hatch has to exist.
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.submit();
      }
    });

    this.send = el('button', { class: 'primary sendbtn', title: '보내기 (Enter)', html: PAPER_PLANE });
    this.send.addEventListener('click', () => void this.submit());

    // --- attachments ---------------------------------------------------------
    //
    // A file dropped here goes to the workspace's uploads/, and the message
    // names it. That is the honest shape: the agent reads files with a tool, so
    // handing it a path costs a line where pasting the contents would cost the
    // whole file on every turn of the tool loop - and would still be unreadable
    // for anything that is not text.
    this.picker = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
    this.picker.addEventListener('change', () => {
      void this.attachAll(Array.from(this.picker.files ?? []));
      this.picker.value = '';
    });
    const clip = el('button', {
      class: 'ghost attachbtn', title: '파일 첨부 — 워크스페이스에 올라갑니다',
      html: ICON.clip,
    });
    clip.addEventListener('click', () => this.picker.click());

    // Paste and drop are the two ways people actually attach things; a button
    // alone gets used once and then forgotten.
    this.input.addEventListener('paste', (e) => {
      const files = Array.from((e as ClipboardEvent).clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      void this.attachAll(files);
    });
    // (Drops target the whole panel now - installDrop below the root.)

    this.root = el('div', { class: 'agentpanel' }, [
      el('div', { class: 'agenthead' }, [this.status, fresh, this.historyBtn]),
      this.log,
      this.stagedBox,
      this.actionBox,
      this.attachBar,
      // The two buttons stack beside the box, attach above send: the box is
      // two lines tall anyway, and a clip on the far left read as a third
      // control competing with the text rather than an option on sending.
      el('div', { class: 'agentcompose' }, [this.input, el('div', { class: 'agentbtns' }, [clip, this.send]), this.picker]),
    ]);

    // The WHOLE panel takes drops (log, chips, compose): OS files upload as
    // before (folders now walked via collectDrop), and internal drags - tree
    // rows, studio cells, fragment cards, card assets - attach as reference
    // chips, no upload: the agent reads paths itself (read_file/list_files).
    // Installed once here: the panel is a shared instance re-parented between
    // tabs, so these listeners survive every re-mount.
    installDrop(this.root, {
      into: () => '',
      effect: 'copy',
      onFiles: (_p, incoming) => void this.attachAll(incoming.map((i) => i.file)),
      onMove: (_p, sources) => this.attachPaths(sources),
      onAssets: (names) => this.attachAssets(names),
    });
  }

  /**
   * Upload files and remember them until the next message goes out.
   *
   * Uploaded immediately rather than on send: the user should be able to see
   * that it worked, and a failure should surface while they are still looking
   * at the file rather than after they have written a paragraph about it.
   */
  private async attachAll(files: File[]): Promise<void> {
    for (const file of files) {
      const chip = el('span', { class: 'attachchip' }, [
        el('span', { text: file.name }),
        el('span', { class: 'hint', text: '올리는 중…' }),
      ]);
      this.attachBar.appendChild(chip);
      this.attachBar.style.display = 'flex';
      try {
        const isText = /[.](md|txt|json|jsonl|csv|py|html?|css|js|ya?ml|xml|log|sql)$/i.test(file.name);
        let saved;
        if (isText) {
          saved = await state.uploadFile(file.name, await file.text());
        } else {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = '';
          for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
          saved = await state.uploadFile(file.name, btoa(bin), true);
        }
        this.attached.push(saved.path);
        clear(chip);
        const drop = el('button', { class: 'ghost tiny', text: '×', title: '이 메시지에서 빼기' });
        drop.addEventListener('click', () => {
          this.attached = this.attached.filter((p) => p !== saved.path);
          chip.remove();
          if (!this.attachBar.children.length) this.attachBar.style.display = 'none';
        });
        chip.appendChild(el('span', { text: saved.path }));
        chip.appendChild(drop);
      } catch (e) {
        clear(chip);
        chip.classList.add('bad');
        chip.appendChild(el('span', { text: `${file.name} — ${msg(e)}` }));
      }
    }
  }

  /** Reference chips for workspace paths dragged in: no upload - the path
   * already lives in the space, and the agent reads it itself. (This is the
   * 경로 복사 workaround turned into a gesture.) */
  private attachPaths(paths: string[]): void {
    for (const path of paths) {
      if (!path || this.attached.includes(path)) continue;
      this.attached.push(path);
      const chip = el('span', { class: 'attachchip', title: path });
      if (IMG_RE.test(path)) chip.appendChild(workspaceImage(path, path.split('/').pop() ?? path, { thumb: true }));
      chip.appendChild(el('span', { text: path.split('/').pop() || path }));
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '이 메시지에서 빼기' });
      drop.addEventListener('click', () => {
        this.attached = this.attached.filter((q) => q !== path);
        chip.remove();
        if (!this.attachBar.children.length) this.attachBar.style.display = 'none';
      });
      chip.appendChild(drop);
      this.attachBar.appendChild(chip);
      this.attachBar.style.display = 'flex';
    }
  }

  /** Card assets have no workspace path: the chip carries the NAME and the
   * composed message points the agent at list_assets / fetch_assets. */
  private attachedAssets: string[] = [];
  private attachAssets(names: string[]): void {
    for (const name of names) {
      if (!name || this.attachedAssets.includes(name)) continue;
      this.attachedAssets.push(name);
      const chip = el('span', { class: 'attachchip', title: '카드 에셋: ' + name }, [
        el('span', { class: 'hint', text: '에셋' }),
        el('span', { text: name }),
      ]);
      const drop = el('button', { class: 'ghost tiny', text: '×', title: '이 메시지에서 빼기' });
      drop.addEventListener('click', () => {
        this.attachedAssets = this.attachedAssets.filter((q) => q !== name);
        chip.remove();
        if (!this.attachBar.children.length) this.attachBar.style.display = 'none';
      });
      chip.appendChild(drop);
      this.attachBar.appendChild(chip);
      this.attachBar.style.display = 'flex';
    }
  }

  private clearAttachments(): void {
    this.attached = [];
    this.attachedAssets = [];
    clear(this.attachBar);
    this.attachBar.style.display = 'none';
  }

  /** Load once per chat; re-entering the tab must not re-fetch the transcript. */
  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    this.loaded = true;
    await this.render();
  }

  invalidate(): void {
    this.loaded = false;
  }

  private async render(sessionId?: string): Promise<void> {
    clear(this.log);
    // A session is bound to a chat (the workspace, the approval queue, the
    // scope DB all hang off it). With none selected the backend can only say
    // "chatKey is required" - say the useful sentence instead of the error.
    if (!state.activeChatKey) {
      // Not loaded: the next mount retries, so picking a chat later un-gates
      // the panel without an explicit invalidate.
      this.loaded = false;
      this.status.textContent = '';
      this.log.appendChild(el('div', { class: 'notice' }, [
        el('div', { text: '아직 봇의 챗이 선택되지 않았습니다.' }),
        el('div', { class: 'hint', text: '챗 탭에서 챗을 하나 고르면 여기서 히나를 부를 수 있습니다.' }),
      ]));
      this.send.disabled = true;
      return;
    }
    try {
      const s = await state.agentSession(sessionId);
      if (!s.agentReady) {
        this.status.textContent = '';
        this.log.appendChild(el('div', { class: 'notice' }, [
          el('div', { text: '에이전트 자격증명이 아직 설정되지 않았습니다.' }),
          el('div', {
            class: 'hint',
            text: '오른쪽 위 ⚙ → 에이전트에서 Base URL · Model · API Key를 넣고 연결 테스트를 해 주세요.',
          }),
        ]));
        this.send.disabled = true;
        return;
      }
      this.send.disabled = false;
      this.status.textContent = s.session ? '' : '새 대화';

      for (const m of s.messages) {
        if (m.role === 'user') this.addBubble('user', String(m.content ?? ''));
        else if (m.role === 'assistant') {
          this.addBubble('assistant', String(m.content ?? ''), m.usage ?? undefined, m.cost);
        }
      }
      if (!s.messages.length) this.log.appendChild(this.welcome());
      this.setStaged(s.staged ?? []);
      void this.refreshActions();
      void this.refreshOutputs();
      this.scroll();
    } catch (e) {
      this.status.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * What an empty conversation says.
   *
   * A blank panel with a cursor asks "what can this do?" and answers nothing.
   * The three examples are the three sizes of job this tool was built for -
   * one turn, many turns, and restructuring the whole chat - so they double as
   * a description of the tool. Clicking one fills the box rather than sending
   * it: they are starting points to edit, not commands.
   */
  private welcome(): HTMLElement {
    // The examples follow the tab bar's mode: a chat's three sizes of job, or
    // the card's - the agent is the same, the material in front of it differs.
    const bot = currentMode() === 'bot';
    const examples = bot
      ? [
        '봇 로어북을 훑어서 겹치거나 빈 항목을 정리하고 폴더로 묶어줘',
        '퍼스트 메시지와 대체 인사말의 말투를 설명(desc)과 맞춰줘',
        '에셋 이름 끝의 확장자를 떼고, 감정 이미지 이름을 감정 단어로 통일해줘',
      ]
      : [
        '대화에서 페르소나를 조금 더 착한 사람으로 조정해줘',
        '{{char}}에게 고백한 일을 없던 걸로 해줘',
        '챗 이사가고 싶어. 전체 항목을 체계적으로 요약해서 챗 로어북에 넣고, 10턴만 남겨줘',
      ];
    const box = el('div', { class: 'welcome' }, [
      el('div', { class: 'welcome-title', text: bot ? '봇(카드)에서 조정할 항목을 상담하세요' : '조정해야 할 항목을 상담하세요' }),
      el('div', {
        class: 'hint',
        text: '고칠 곳을 말씀하시면 훑어보고 제안을 만들어 옵니다. 반영은 승인하신 뒤에 이루어집니다.',
      }),
      el('div', {
        class: 'hint',
        text: 'AI 에이전트는 현재 탭뿐만 아니라 선택된 봇 및 챗의 전반적인 정보를 모두 알고 있습니다.',
      }),
    ]);
    for (const text of examples) {
      const b = el('button', { class: 'exbtn' }, [
        el('span', { class: 'exmark', text: '→' }),
        el('span', { text }),
      ]);
      b.addEventListener('click', () => {
        this.input.value = text;
        this.input.focus();
      });
      box.appendChild(b);
    }
    box.appendChild(el('div', {
      class: 'hint welcome-foot',
      text: '파일은 아래 클립 버튼이나 붙여넣기·끌어놓기로 올리실 수 있습니다.',
    }));
    return box;
  }

  /**
   * Files the agent left in out/ since the last look.
   *
   * Each new file gets one line in the log, where the conversation is, and
   * that line opens the file in the files tab. There used to be a pinned card
   * listing every output with a download button; it sat between the log and
   * the input and grew with every file, so after a long session it took more
   * of the panel than the conversation did. The files tab is the place that
   * lists files; the log only has to say that one appeared.
   */
  private async refreshOutputs(): Promise<void> {
    try {
      const listing = await state.files();
      // Deliverables live at hina/<봇>/out/ in the global space. Every bot's
      // out is watched: only one agent runs here at a time, and a fresh file
      // in any of them is this turn's product.
      const hina = listing.areas.find((a) => a.area === 'hina');
      const files = (hina?.files ?? []).filter((f) => /^hina\/[^/]+\/out\//.test(f.path));
      const stamp = files.map((f) => `${f.path}:${f.size}:${f.modified}`).join('|');
      // The first look is the baseline - files from earlier sessions are
      // already in the files tab and do not need announcing again. A flag,
      // not "was the stamp empty": an empty out/ has an empty stamp, and the
      // first file would otherwise be taken for the baseline.
      if (!this.outPrimed) {
        this.outPrimed = true;
        this.outSeen = stamp;
        return;
      }
      if (stamp === this.outSeen) return;
      const before = new Set(this.outSeen.split('|').map((s) => s.split(':')[0]));
      this.outSeen = stamp;
      const fresh = files.filter((f) => !before.has(f.path));
      if (!fresh.length) return;
      state.touchFiles(fresh.map((f) => f.path));
      // Artifacts already announced themselves with a chip; images read as a
      // strip; the rest stay one outline line each.
      const plain = fresh.filter((f) => !f.path.includes('/out/artifacts/') && !IMG_RE.test(f.name));
      const pics = fresh.filter((f) => !f.path.includes('/out/artifacts/') && IMG_RE.test(f.name));
      for (const f of plain) {
        const line = el('button', { class: 'outline', title: '파일 탭에서 엽니다' }, [
          el('span', { class: 'glyph', text: '📄' }),
          el('span', { class: 'grow', text: `${f.name} · ${fmtSize(f.size)} — out/ 에 저장했습니다. 파일 탭에서 열기 →` }),
        ]);
        line.addEventListener('click', () => state.requestOpenFile(f.path));
        this.log.appendChild(line);
      }
      if (pics.length) {
        const strip = el('div', { class: 'imgstrip' });
        for (const f of pics.slice(0, 8)) {
          const thumb = workspaceImage(f.path, f.name, { thumb: true });
          thumb.style.cursor = 'pointer';
          thumb.addEventListener('click', () =>
            showArtifact({ path: f.path, title: f.name, kind: 'image' }, { flipMobile: true }));
          strip.appendChild(thumb);
        }
        if (pics.length > 8) {
          const more = el('button', { class: 'ghost tiny', text: `외 ${pics.length - 8}장` });
          more.addEventListener('click', () => state.requestOpenFile(pics[0].path));
          strip.appendChild(more);
        }
        this.log.appendChild(strip);
      }
      this.scroll();
    } catch { /* the panel already reports connection failure */ }
  }

  /** Proposals that are not transcript edits - lorebook, memory, snapshots. */
  private async refreshActions(): Promise<void> {
    try {
      this.setActions(await state.actions());
    } catch { /* the panel already reports connection failure */ }
  }

  private setActions(items: PendingAction[]): void {
    clear(this.actionBox);
    if (!items.length) return;

    /** One decision, shared by the row buttons and the bulk buttons. */
    const decideOne = async (a: PendingAction, approve: boolean, quiet = false): Promise<boolean> => {
      try {
        const said = await state.decideAction(a.id, approve);
        if (!quiet) this.hooks.notice(said, approve ? 'ok' : '');
        // The outcome also goes into the conversation, where it stays -
        // a notice fades, and the question "did it run?" comes later.
        this.note((approve ? '✔ 승인·실행: ' : '✖ 거절: ') + a.summary + (said ? ' — ' + said : ''),
                  approve ? 'ok' : '');
        return true;
      } catch (e) {
        if (!quiet) this.hooks.notice('실행하지 못했습니다: ' + msg(e), 'err');
        this.note('✖ 실행 실패: ' + a.summary + ' — ' + msg(e), 'err');
        return false;
      }
    };

    const rows = items.map((a) => {
      const yes = el('button', { class: 'primary tiny', text: a.byHost ? '승인·실행' : '승인' });
      const no = el('button', { class: 'ghost tiny', text: '거절' });
      const busy = el('span', { class: 'hint', text: '' });
      const decide = async (approve: boolean) => {
        yes.disabled = true;
        no.disabled = true;
        // The row says what is happening while it happens; a host action can
        // take seconds, and a silent button reads as a dead one.
        busy.textContent = approve ? '실행 중…' : '거절 중…';
        const ok = await decideOne(a, approve);
        if (ok) {
          await this.refreshActions();
          if (approve) await this.hooks.onApplied();
        } else {
          busy.textContent = '';
          yes.disabled = false;
          no.disabled = false;
        }
      };
      yes.addEventListener('click', () => void decide(true));
      no.addEventListener('click', () => void decide(false));

      return el('div', { class: 'stagedrow' }, [
        // Host actions touch the live RisuAI chat rather than our working copy,
        // which is a different kind of consequence and says so.
        a.byHost ? el('span', { class: 'badge err', text: 'RisuAI' }) : null,
        el('span', { class: 'grow', text: a.summary }),
        busy, yes, no,
      ]);
    });

    // Twelve asset additions in one turn are twelve rows; deciding them one
    // click each was the complaint. The bulk buttons run through the queue
    // in order (host actions have to happen one at a time anyway) and report
    // as they go; a failure stops the run so the rest can be looked at.
    const progress = el('span', { class: 'hint', text: '' });
    const allYes = el('button', { class: 'primary tiny', text: `전체 승인·실행 (${items.length})` }) as HTMLButtonElement;
    const allNo = el('button', { class: 'ghost tiny', text: '전체 거절' }) as HTMLButtonElement;
    const decideAll = async (approve: boolean) => {
      allYes.disabled = allNo.disabled = true;
      for (const b of Array.from(this.actionBox.querySelectorAll('.stagedrow button'))) (b as HTMLButtonElement).disabled = true;
      let done = 0;
      let failed = false;
      for (const a of items) {
        progress.textContent = `${approve ? '실행' : '거절'} 중 ${done + 1}/${items.length}…`;
        const ok = await decideOne(a, approve, true);
        if (!ok) { failed = true; break; }
        done += 1;
      }
      const said = approve
        ? `승인 요청 ${done}건을 실행했습니다.` + (failed ? ' 실패한 항목에서 멈췄습니다.' : '')
        : `승인 요청 ${done}건을 거절했습니다.`;
      this.hooks.notice(said, failed ? 'err' : 'ok');
      await this.refreshActions();
      if (approve && done) await this.hooks.onApplied();
    };
    allYes.addEventListener('click', () => void decideAll(true));
    allNo.addEventListener('click', () => void decideAll(false));

    // A long queue folds: the first few rows, then a count that unfolds the
    // rest, so the card between the log and the input stays a card.
    const FOLD = 6;
    const shown = rows.slice(0, FOLD);
    const rest = rows.slice(FOLD);
    const restBox = el('div', { style: { display: 'none' } }, rest);
    const unfold = rest.length
      ? el('button', { class: 'ghost tiny', text: `그 외 ${rest.length}건 보기` })
      : null;
    unfold?.addEventListener('click', () => {
      const open = restBox.style.display === 'none';
      restBox.style.display = open ? '' : 'none';
      unfold.textContent = open ? '접기' : `그 외 ${rest.length}건 보기`;
    });

    this.actionBox.appendChild(el('div', { class: 'card staged' }, [
      el('h2', { text: `승인 요청 ${items.length}건` }),
      el('div', { class: 'hint', text: '승인해야 실행됩니다. 전사 수정이 아닌 변경입니다.' }),
      items.length > 1 ? el('div', { class: 'row', style: { margin: '6px 0' } }, [allYes, allNo, progress]) : null,
      ...shown,
      restBox,
      unfold,
    ]));
  }

  private async newConversation(): Promise<void> {
    if (this.busy) return;
    try {
      await state.newAgentSession();
      await this.render();
      this.hooks.notice('새 대화를 시작했습니다.', 'ok');
    } catch (e) {
      this.hooks.notice('새 대화를 시작하지 못했습니다: ' + msg(e), 'err');
    }
  }

  private async openHistory(): Promise<void> {
    const body = el('div', {}, [el('div', { class: 'hint', text: '불러오는 중입니다…' })]);
    const close = popover(this.historyBtn, body);
    try {
      const sessions = await state.agentSessions();
      clear(body);
      if (!sessions.length) {
        body.appendChild(el('div', { class: 'hint', text: '이전 대화가 없습니다.' }));
        return;
      }
      for (const s of sessions) {
        const row = el('div', { class: 'sessrow' }, [
          el('div', { class: 'grow' }, [
            el('div', { text: s.title }),
            el('div', {
              class: 'hint',
              text: `${s.turns}턴` + (s.cost != null ? ` · $${Number(s.cost).toFixed(4)}` : ''),
            }),
          ]),
        ]);
        row.addEventListener('click', async () => {
          close();
          await this.render(s.sessionId);
        });
        body.appendChild(row);
      }
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'hint', text: msg(e) }));
    }
  }

  /** Interval id for the elapsed clock, so a teardown can stop it. */
  private timer: number | null = null;

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private addBubble(role: 'user' | 'assistant', text: string,
                    usage?: Record<string, unknown>, cost?: number | null): HTMLElement {
    const body = el('div', { class: 'bubble-body' });
    // The user's own text is shown verbatim - they typed it, and rendering it
    // would mangle a pasted snippet. Only the model's prose gets markdown.
    if (role === 'assistant') setMarkdown(body, text);
    else body.textContent = text;
    const node = el('div', { class: `bubble ${role}` }, [body]);
    if (role === 'assistant') node.appendChild(this.costLine(usage, cost));
    this.log.appendChild(node);
    return body;
  }

  /** A one-line event in the conversation (an approval ran, a run was stopped). */
  private note(text: string, kind: 'ok' | 'err' | '' = ''): void {
    this.log.appendChild(el('div', { class: 'bubble note' + (kind ? ' ' + kind : ''), text }));
    this.scroll();
  }

  private costLine(usage?: Record<string, unknown>, cost?: number | null): HTMLElement {
    const bits: string[] = [];
    if (cost !== null && cost !== undefined) {
      bits.push('$' + Number(cost).toFixed(4));
    } else if (usage) {
      // Never render an unknown price as zero.
      bits.push('가격 미설정');
    }
    if (usage) {
      const i = usage.input, o = usage.output, t = usage.toolCalls;
      if (i != null || o != null) bits.push(`${fmtTok(i)}↑ / ${fmtTok(o)}↓`);
      if (t) bits.push(`툴 ${t}회`);
    }
    return el('div', { class: 'costline', text: bits.join(' · ') });
  }

  private async submit(): Promise<void> {
    const typed = this.input.value.trim();
    // An attachment on its own is a complete message: "here, look at this".
    if ((!typed && !this.attached.length && !this.attachedAssets.length) || this.busy) return;

    // The paths go in the message rather than the file contents. The agent has
    // read_file, so it fetches what it needs and only what it needs - and a
    // pasted file would otherwise be re-sent on every turn of the tool loop.
    const files = this.attached.slice();
    const assets = this.attachedAssets.slice();
    const extras: string[] = [];
    if (files.length) {
      extras.push('첨부한 파일/폴더: ' + files.join(', ')
        + '\n(워크스페이스 경로입니다. 파일은 read_file 로 읽고, 폴더는 list_files 로 안을 봐 주세요.)');
    }
    if (assets.length) {
      extras.push('첨부한 카드 에셋: ' + assets.join(', ')
        + '\n(list_assets 로 확인하고 fetch_assets 로 scratch/ 에 꺼내 봐 주세요.)');
    }
    const prompt = extras.length
      ? (typed ? typed + '\n\n' : '') + extras.join('\n\n')
      : typed;

    this.busy = true;
    this.input.value = '';
    this.clearAttachments();
    this.send.disabled = true;
    const empty = this.log.querySelector('.empty');
    if (empty) empty.remove();
    this.addBubble('user', prompt);

    // The live bubble is a sequence, in the order things happened: a run of
    // tool chips, then the prose the model wrote after them, then the next
    // run of chips, and so on. One chip strip pinned above one prose block
    // put every later tool call above text it came after, which read as the
    // model having done its reading before it spoke when it had not.
    const bubble = el('div', { class: 'bubble assistant' });
    this.log.appendChild(bubble);
    // A running clock, not just a spinner.
    //
    // An agent turn here is minutes, not seconds - it reads dozens of turns and
    // runs scripts between tokens. Three bouncing dots answer "is it alive"
    // but not "has this been going for 20 seconds or four minutes", which is
    // the question that decides whether to wait or interrupt.
    const elapsed = el('span', { class: 'elapsed', text: '0m 0s' });
    const thinkingText = el('span', { class: 'thinkingtext', text: '생각하는 중입니다…' });
    // 중단: aborts the stream; the backend saves the prompt and what arrived
    // so far into the history, so the next turn still knows what was asked.
    const abort = new AbortController();
    const stopBtn = el('button', { class: 'ghost tiny stopbtn', text: '중단', title: '이 턴을 중단합니다' });
    stopBtn.addEventListener('click', () => { abort.abort(); stopBtn.disabled = true; });
    const thinking = el('div', { class: 'thinking' }, [
      el('span', { class: 'dots' }, [el('i'), el('i'), el('i')]),
      thinkingText,
      elapsed,
      stopBtn,
    ]);
    // Always the last thing in the bubble: segments are inserted before it.
    bubble.appendChild(thinking);

    const startedAt = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      elapsed.textContent = `${Math.floor(s / 60)}m ${s % 60}s`;
    };
    // Kept in `this` so a panel teardown mid-run cannot leave it running. It
    // runs until the turn ends - not until the first text arrives - so the
    // clock next to "스크립트 중입니다…" keeps moving and says the turn is
    // alive; a frozen clock there used to look like a hang.
    this.clearTimer();
    this.timer = setInterval(tick, 1000) as unknown as number;

    const setThinking = (on: boolean, label?: string) => {
      thinking.style.display = on ? 'flex' : 'none';
      if (label) thinkingText.textContent = label;
    };
    /** The turn is over: stop the clock, keep the row as the turn's footer. */
    const finish = (label: string) => {
      stopBtn.style.display = 'none';
      this.clearTimer();
      tick();
      elapsed.classList.add('done');
      thinking.style.display = 'flex';
      thinkingText.textContent = label;
      thinking.querySelector('.dots')?.classList.add('stopped');
    };

    // Segments: the current prose block and the current chip strip. Opening
    // one closes the other, so alternation lands in document order.
    let textNode: HTMLElement | null = null;
    let textAcc = '';
    let tracker: TraceTracker | null = null;
    const proseSegment = (): HTMLElement => {
      if (!textNode) {
        textNode = el('div', { class: 'bubble-body' });
        bubble.insertBefore(textNode, thinking);
        textAcc = '';
        tracker = null;
      }
      return textNode;
    };
    const traceSegment = (): TraceTracker => {
      if (!tracker) {
        const strip = el('div', { class: 'trace' });
        bubble.insertBefore(strip, thinking);
        tracker = new TraceTracker(strip);
        textNode = null;
      }
      return tracker;
    };
    this.scroll();

    // Permission prompts: while the turn runs, the backend may be waiting on
    // a shell / pip request. Poll and draw each once, with three answers -
    // each card goes in at the point of the sequence it was asked at.
    const shown = new Set<string>();
    const askPermit = (p: { id: string; kind: string; summary: string; detail: string }) => {
      const card = el('div', { class: 'permit' });
      const decide = async (allow: boolean, always: boolean) => {
        for (const b of Array.from(card.querySelectorAll('button'))) (b as HTMLButtonElement).disabled = true;
        try {
          await state.decidePermit(p.id, allow, always);
          card.classList.add(allow ? 'allowed' : 'denied');
          card.appendChild(el('div', { class: 'hint', text: allow ? (always ? '허용 (이번 턴 동안 계속 허용)' : '허용') : '거부' }));
        } catch (e) {
          card.appendChild(el('div', { class: 'notice err', text: msg(e) }));
        }
      };
      const allow = el('button', { class: 'primary tiny', text: '허용' });
      const deny = el('button', { class: 'ghost tiny', text: '거부' });
      const always = el('button', { class: 'ghost tiny', text: '이번 턴 항상 허용', title: '이 턴이 끝날 때까지 같은 종류의 요청을 묻지 않고 허용합니다' });
      allow.addEventListener('click', () => void decide(true, false));
      deny.addEventListener('click', () => void decide(false, false));
      always.addEventListener('click', () => void decide(true, true));
      card.appendChild(el('div', { class: 'permit-title', text: (p.kind === 'pip' ? '패키지 설치 허용?' : '셸 명령 실행 허용?') + ' ' + p.summary }));
      card.appendChild(el('pre', { class: 'mono', text: p.detail }));
      card.appendChild(el('div', { class: 'row' }, [allow, deny, always]));
      bubble.insertBefore(card, thinking);
      // A new prose block after the card, not the one before it.
      textNode = null;
      tracker = null;
      this.scroll();
    };
    const permitPoll = setInterval(async () => {
      try {
        for (const p of await state.permits()) {
          if (shown.has(p.id)) continue;
          shown.add(p.id);
          askPermit(p);
        }
      } catch { /* the stream reports real failures */ }
    }, 1500);

    try {
      for await (const ev of state.agentChat(prompt, abort.signal)) {
        const e = ev as Record<string, unknown>;
        switch (e.type) {
          case 'text': {
            const node = proseSegment();
            textAcc += String(e.text ?? '');
            // Text is arriving, so the indicator would only repeat "alive";
            // it comes back the moment the model turns to a tool again.
            setThinking(false);
            setMarkdown(node, textAcc);
            this.scroll();
            break;
          }
          case 'tool': {
            // Naming the tool answers "is it stuck?" during the long quiet
            // stretch while it reads: a spinner alone does not.
            const name = String(e.name ?? '?');
            // A skill load is the one call whose argument is the whole story:
            // "스킬" says nothing, "스킬: 말투 통일" says what the agent decided.
            const detail = name === 'load_skill' ? skillArg(e.args) : '';
            traceSegment().push(name, detail);
            setThinking(true, (TOOL_GLYPH[name]?.[1] ?? name) + (detail ? `: ${detail}` : '') + ' 중입니다…');
            this.scroll();
            break;
          }
          case 'artifact': {
            // The tool already wrote the file; this shows it in the centre
            // pane mid-turn, and leaves a chip that reopens it after 닫기.
            const spec = { path: String(e.path ?? ''), title: String(e.title ?? ''),
                           kind: e.kind as 'markdown' | 'image' | 'text' | undefined };
            if (!spec.path) break;
            showArtifact(spec);
            const chip = el('button', { class: 'outline artifactchip', title: '중앙 패널에 다시 엽니다' }, [
              el('span', { class: 'glyph', text: '📊' }),
              el('span', { class: 'grow', text: `${spec.title || spec.path} — 중앙 패널에 표시했습니다` }),
            ]);
            chip.addEventListener('click', () => showArtifact(spec, { flipMobile: true }));
            this.log.appendChild(chip);
            this.scroll();
            break;
          }
          case 'images': {
            // Fresh images from a tool (a batch's saved paths): a thumbnail
            // strip in place, each opening large in the artifact viewer.
            const paths = Array.isArray(e.paths) ? (e.paths as string[]).filter(Boolean) : [];
            if (!paths.length) break;
            // The files (and studio) tabs learn of the new images NOW, not on
            // a manual 새로고침 - the §1-28 report ("생성해도 새로고침 해야
            // 보임") was exactly this missing bump.
            state.touchFiles(paths);
            const strip = el('div', { class: 'imgstrip' });
            for (const p of paths.slice(0, 8)) {
              const name = p.slice(p.lastIndexOf('/') + 1);
              const thumb = workspaceImage(p, name, { thumb: true });
              thumb.style.cursor = 'pointer';
              thumb.addEventListener('click', () =>
                showArtifact({ path: p, title: name, kind: 'image' }, { flipMobile: true }));
              strip.appendChild(thumb);
            }
            // 검수: the studio's inspection tab on the batch's folder - that
            // is where these get chosen, so the strip offers the way there.
            const folder = String(e.folder || '') || paths[0].slice(0, paths[0].lastIndexOf('/'));
            const inspect = el('button', { class: 'ghost tiny', text: paths.length > 8 ? `외 ${paths.length - 8}장 · 검수` : '검수',
                                           title: '에셋 스튜디오 검수 탭에서 이 폴더를 엽니다' });
            inspect.addEventListener('click', () => state.requestOpenStudio(folder));
            strip.appendChild(inspect);
            if (e.label) strip.appendChild(el('div', { class: 'hint', text: String(e.label) }));
            this.log.appendChild(strip);
            this.scroll();
            break;
          }
          case 'open': {
            // A tool asked for a screen: only the studio's 검수 tab so far.
            if (e.screen === 'inspect' && e.folder) state.requestOpenStudio(String(e.folder));
            break;
          }
          case 'done': {
            // The model is done, the panel is not: the staged edits, the
            // approval queue and the out/ files are fetched next, and with
            // the clock stopped and the dots frozen that fetch looked like a
            // hang right before the cards appeared. Keep it visibly alive
            // until the cards are in, then mark the turn finished.
            setThinking(true, '제안·변경 카드를 정리하는 중입니다…');
            await this.refreshStaged();
            // The turn may have written files ANYWHERE in the space
            // (write_file into studio/, a script into scratch/), and the
            // out/-watcher above only sees hina/*/out. One rev bump per
            // finished turn keeps the files and studio tabs honest without
            // anyone pressing 새로고침 (§1-28).
            state.touchFiles();
            finish('완료');
            bubble.appendChild(this.costLine(
              e.usage as Record<string, unknown> | undefined,
              (e.cost as number | null | undefined) ?? null));
            // A turn ends when the model stops, not when the job is done. One
            // click asks it to pick up where it left off, history and all.
            const more = el('button', { class: 'ghost tiny continuebtn', text: '계속 이어서', title: '방금 턴에서 끝내지 못한 작업을 이어갑니다' });
            more.addEventListener('click', () => {
              more.remove();
              this.input.value = '이어서 진행해 주세요. 방금 턴에서 끝내지 못한 작업이 있으면 마저 해 주세요.';
              void this.submit();
            });
            bubble.appendChild(el('div', { class: 'row', style: { marginTop: '4px' } }, [more]));
            if (typeof e.total === 'number') {
              this.status.textContent = `이 대화 누적 $${e.total.toFixed(4)}`;
            }
            break;
          }
          case 'error':
            finish('중단됨');
            bubble.appendChild(
              el('div', { class: 'notice err', text: String(e.error ?? '알 수 없는 오류가 발생했습니다') }));
            void clientLog('error', 'agent stream error', { error: e.error });
            break;
        }
      }
    } catch (e) {
      finish('중단됨');
      bubble.appendChild(el('div', { class: 'notice err', text: msg(e) }));
      void clientLog('error', 'agent chat failed', { error: String(e) });
    } finally {
      clearInterval(permitPoll);
      // A turn that ended without the clock being stopped (an early return,
      // a stream that closed without 'done') still gets its footer.
      if (this.timer !== null) finish('종료');
      this.busy = false;
      this.send.disabled = false;
      this.scroll();
    }
  }

  private async refreshStaged(): Promise<void> {
    try {
      this.setStaged(await state.stagedEdits());
      await this.refreshActions();
      await this.refreshOutputs();
    } catch { /* the turn already reported its own failure */ }
  }

  private setStaged(items: StagedEdit[]): void {
    clear(this.stagedBox);
    this.hooks.onStagedChanged(items);
    if (!items.length) return;

    const label = (op: string) => op === 'edit' ? '수정' : op === 'delete' ? '삭제' : '삽입';
    const byOp = items.reduce<Record<string, number>>((a, i) => {
      a[i.op] = (a[i.op] ?? 0) + 1;
      return a;
    }, {});
    const summary = Object.entries(byOp).map(([op, n]) => `${label(op)} ${n}`).join(' · ');

    const approve = el('button', { class: 'primary', text: '전체 승인하고 적용' });
    approve.addEventListener('click', async () => {
      approve.disabled = true;
      const was = approve.textContent;
      approve.textContent = '적용 중…';
      try {
        const r = await state.approveStaged(true);
        const said = `제안 ${r.decided}건을 승인해 ${r.applied}건을 적용했습니다.`;
        this.hooks.notice(said, 'ok');
        this.note('✔ ' + said, 'ok');
        await this.refreshStaged();
        await this.hooks.onApplied();
      } catch (e) {
        this.hooks.notice('적용에 실패했습니다: ' + msg(e), 'err');
        this.note('✖ 적용 실패: ' + msg(e), 'err');
      } finally {
        approve.disabled = false;
        approve.textContent = was;
      }
    });

    const reject = el('button', { class: 'ghost', text: '전체 거부' });
    reject.addEventListener('click', async () => {
      reject.disabled = true;
      try {
        await state.approveStaged(false);
        this.hooks.notice('제안을 거부했습니다.', 'ok');
        await this.refreshStaged();
      } catch (e) {
        this.hooks.notice('거부에 실패했습니다: ' + msg(e), 'err');
      } finally {
        reject.disabled = false;
      }
    });

    this.stagedBox.appendChild(el('div', { class: 'card staged' }, [
      el('h2', { text: `승인 대기 ${items.length}건` }),
      el('div', { class: 'hint', text: summary + ' — 왼쪽 패널에 미리보기로 표시했습니다.' }),
      ...items.slice(0, 8).map((i) => el('div', { class: 'stagedrow' }, [
        el('span', { class: 'badge warn', text: label(i.op) }),
        el('span', { class: 'grow hint', text: `#${i.seq ?? '?'} ${i.reason || ''}` }),
      ])),
      items.length > 8 ? el('div', { class: 'hint', text: `그 외 ${items.length - 8}건` }) : null,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [approve, reject]),
    ]));
  }

  private scroll(): void {
    this.log.scrollTop = this.log.scrollHeight;
  }
}

/**
 * Renders the tool trace, collapsing consecutive repeats into ×N.
 *
 * An agent that reads eight ranges in a row produces eight identical chips
 * otherwise, which buries the one call that mattered.
 */
class TraceTracker {
  private lastName = '';
  private count = 0;
  private chip: HTMLElement | null = null;

  constructor(private mount: HTMLElement) {}

  push(name: string, detail = ''): void {
    if (name === this.lastName && this.chip && !detail) {
      this.count += 1;
      const x = this.chip.querySelector('.tx');
      if (x) x.textContent = `×${this.count}`;
      else this.chip.appendChild(el('span', { class: 'tx', text: `×${this.count}` }));
      return;
    }
    const [glyph, label] = TOOL_GLYPH[name] ?? ['🔧', name];
    this.chip = el('span', { class: 'tchip' + (detail ? ' skill' : ''), title: name + (detail ? ` ${detail}` : '') }, [
      el('span', { text: glyph }),
      el('span', { text: detail ? `${label}: ${detail}` : label }),
    ]);
    this.mount.appendChild(this.chip);
    this.lastName = name;
    this.count = 1;
  }
}

/** The `name` argument of a load_skill call, from the streamed args. */
function skillArg(args: unknown): string {
  if (!args) return '';
  try {
    const v = typeof args === 'string' ? JSON.parse(args) : args;
    const name = (v as Record<string, unknown>)?.name;
    return typeof name === 'string' ? name.slice(0, 40) : '';
  } catch {
    const m = /"name"\s*:\s*"([^"]{1,40})/.exec(String(args));
    return m ? m[1] : '';
  }
}

/** Replace a node's contents with rendered markdown. */
function setMarkdown(node: HTMLElement, text: string): void {
  clear(node);
  node.appendChild(renderMarkdown(text, { image: (p, a) => workspaceImage(p, a, { thumb: true }) }));
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

function fmtTok(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

export type { AgentSessionInfo };
