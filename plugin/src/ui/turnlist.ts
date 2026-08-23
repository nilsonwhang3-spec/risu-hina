/**
 * Virtualised turn list.
 *
 * A real chat is 394 turns and each body can be thousands of characters;
 * rendering all of them produced a panel that took seconds to open. Only the
 * visible window plus a small overscan is in the DOM, with spacer divs holding
 * the scroll height.
 *
 * Row heights are measured rather than assumed, because turn bodies vary from
 * one line to several screens. Measured heights are cached per msgId and the
 * cache survives re-renders, so scrolling back up does not jump.
 */
import { el, clear, diffFragments, fmtTime, modal, ICON } from './dom';
import { renderBody, type ViewMode, type RenderOptions } from './render';
import type { Turn } from '../state';

const ESTIMATED_ROW = 92;
const OVERSCAN = 6;

export interface TurnListOptions {
  onEdit: (turn: Turn, next: string) => Promise<void>;
  showOriginal: () => boolean;
  viewMode: () => ViewMode;
  renderOptions: () => RenderOptions;
  /** Turns the current bulk preview would touch, keyed by msgId -> after-text. */
  preview: () => Map<string, string> | null;
  /** Turns a pending deletion would remove. */
  deleting: () => Set<string> | null;
}

export class TurnList {
  readonly root: HTMLElement;
  private scroller: HTMLElement;
  private topSpacer: HTMLElement;
  private bottomSpacer: HTMLElement;
  private body: HTMLElement;

  /** Called with the seq of the turn currently at the top of the viewport. */
  onVisible: ((seq: number) => void) | null = null;

  private turns: Turn[] = [];
  private heights = new Map<string, number>();
  private raf = 0;

  constructor(private opts: TurnListOptions) {
    this.topSpacer = el('div', { class: 'spacerTop' });
    this.bottomSpacer = el('div', { class: 'spacerBottom' });
    this.body = el('div');
    this.scroller = el('div', { class: 'scroller' }, [this.topSpacer, this.body, this.bottomSpacer]);
    this.root = this.scroller;
    this.scroller.addEventListener('scroll', () => this.schedule());
    window.addEventListener('resize', () => this.schedule());
  }

  setTurns(turns: Turn[]): void {
    this.turns = turns;
    // Drop cached heights for turns that no longer exist so the map cannot grow
    // without bound across many chats.
    const live = new Set(turns.map((t) => t.msgId));
    for (const k of [...this.heights.keys()]) if (!live.has(k)) this.heights.delete(k);
    this.render();
  }

  scrollToSeq(seq: number): void {
    let y = 0;
    for (const t of this.turns) {
      if (t.seq >= seq) break;
      y += this.heights.get(t.msgId) ?? ESTIMATED_ROW;
    }
    this.scroller.scrollTop = y;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private heightOf(t: Turn): number {
    return this.heights.get(t.msgId) ?? ESTIMATED_ROW;
  }

  private render(): void {
    const viewTop = this.scroller.scrollTop;
    const viewH = this.scroller.clientHeight || 600;

    let first = 0;
    let acc = 0;
    while (first < this.turns.length && acc + this.heightOf(this.turns[first]) < viewTop) {
      acc += this.heightOf(this.turns[first]);
      first++;
    }
    const topPad = acc;

    let last = first;
    let visible = 0;
    while (last < this.turns.length && visible < viewH + ESTIMATED_ROW * OVERSCAN) {
      visible += this.heightOf(this.turns[last]);
      last++;
    }
    first = Math.max(0, first - OVERSCAN);
    last = Math.min(this.turns.length, last + OVERSCAN);

    let padTop = 0;
    for (let i = 0; i < first; i++) padTop += this.heightOf(this.turns[i]);
    let padBottom = 0;
    for (let i = last; i < this.turns.length; i++) padBottom += this.heightOf(this.turns[i]);
    void topPad;

    this.topSpacer.style.height = padTop + 'px';
    this.bottomSpacer.style.height = padBottom + 'px';

    if (this.onVisible && this.turns.length) {
      const top = this.turns[Math.min(first + OVERSCAN, this.turns.length - 1)];
      if (top) this.onVisible(top.seq);
    }

    clear(this.body);
    for (let i = first; i < last; i++) {
      this.body.appendChild(this.renderTurn(this.turns[i]));
    }

    // Measure after layout so the next pass has real heights.
    requestAnimationFrame(() => {
      let dirty = false;
      for (const child of Array.from(this.body.children) as HTMLElement[]) {
        const id = child.dataset.msgid;
        if (!id) continue;
        const h = child.getBoundingClientRect().height;
        if (h > 0 && Math.abs((this.heights.get(id) ?? 0) - h) > 1) {
          this.heights.set(id, h);
          dirty = true;
        }
      }
      if (dirty) this.schedule();
    });
  }

  /**
   * Edit one turn, in a window big enough to read it in.
   *
   * This was an inline textarea inside the row. A turn here is routinely a
   * screen or two of prose, and editing it through a box a few lines tall
   * meant scrolling inside a scroll - the transcript moving underneath while
   * you worked. The modal takes the height it needs and the list holds still.
   *
   * Ctrl+Enter saves, Escape closes. Escape is the modal's own, so an
   * accidental one loses the edit - which is why the button is right there and
   * the box is large enough that nobody reaches for the keyboard to escape a
   * cramped one.
   */
  private openEditor(t: Turn): void {
    const box = el('textarea', { class: 'turnedit', value: t.body });
    const count = el('span', { class: 'hint' });
    const out = el('div');
    const sync = () => {
      const n = box.value.length;
      count.textContent = n === t.body.length
        ? `${n.toLocaleString()}자`
        : `${n.toLocaleString()}자 (${n > t.body.length ? '+' : ''}${n - t.body.length})`;
    };
    box.addEventListener('input', sync);
    sync();

    const save = el('button', { class: 'primary', text: '저장' });
    const cancel = el('button', { class: 'ghost', text: '취소' });

    const body = el('div', { class: 'turneditwrap' }, [
      el('div', { class: 'row', style: { marginBottom: '6px' } }, [
        el('span', { class: `turn-role ${t.role === 'user' ? 'user' : 'char'}`, text: t.role }),
        t.time ? el('span', { class: 'hint', text: fmtTime(t.time) }) : null,
        el('span', { class: 'spacer' }),
        count,
      ]),
      box,
      out,
      el('div', { class: 'row', style: { marginTop: '8px' } }, [save, cancel]),
    ]);

    // The frozen original, for a turn that has already been changed. Comparing
    // against it is the reason to open this at all, half the time.
    if (t.changed && t.original != null) {
      const revert = el('button', { class: 'ghost tiny', text: '원본으로 되돌리기' });
      revert.addEventListener('click', () => {
        box.value = t.original as string;
        sync();
      });
      body.appendChild(el('div', { class: 'card', style: { marginTop: '10px' } }, [
        el('h2', {}, [el('span', { text: '원본' }), el('span', { class: 'spacer' }), revert]),
        el('pre', { class: 'mono filepreview', text: t.original as string }),
      ]));
    }

    const close = modal(`턴 ${t.seq} 편집`, body, { wide: true });
    cancel.addEventListener('click', close);

    const commit = async () => {
      if (box.value === t.body) {
        close();
        return;
      }
      save.disabled = true;
      try {
        await this.opts.onEdit(t, box.value);
        close();
      } catch (e) {
        clear(out);
        out.appendChild(el('div', {
          class: 'notice err',
          text: e instanceof Error ? e.message : String(e),
        }));
      } finally {
        save.disabled = false;
      }
    };
    save.addEventListener('click', () => void commit());
    box.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent;
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        void commit();
      }
    });
  }

  private renderTurn(t: Turn): HTMLElement {
    const doomed = this.opts.deleting()?.has(t.msgId) ?? false;
    const cls = ['turn', t.changed ? 'changed' : '', t.isNew ? 'isnew' : '',
                 doomed ? 'doomed' : ''].filter(Boolean).join(' ');
    const node = el('div', { class: cls, dataset: { msgid: t.msgId } });

    const startEdit = () => this.openEditor(t);

    // A pencil rather than the word 수정: it sits on every row of a 394-row
    // list, and a word there is 394 words of chrome. Still always visible -
    // double-click alone was the original way in and nobody found it.
    const editBtn = el('button', {
      class: 'iconbtn tiny', html: ICON.pencil, title: '이 턴 편집',
    });
    editBtn.addEventListener('click', startEdit);

    node.appendChild(el('div', { class: 'turn-head' }, [
      // The number leads the row. It is how every other control in this panel
      // addresses a turn - 찾기 ranges, 삭제 ranges, the range filter, and the
      // agent's own tool calls all speak in seq - so it has to be readable at a
      // glance rather than sitting mid-row in the same grey as the timestamp.
      el('span', { class: 'turn-no', text: String(t.seq), title: `턴 ${t.seq}` }),
      el('span', { class: `turn-role ${t.role === 'user' ? 'user' : 'char'}`, text: t.role }),
      t.time ? el('span', { text: fmtTime(t.time) }) : null,
      t.changed ? el('span', { class: 'badge warn', text: '수정됨' }) : null,
      t.isNew ? el('span', { class: 'badge ok', text: '추가됨' }) : null,
      doomed ? el('span', { class: 'badge err', text: '삭제 예정' }) : null,
      el('span', { class: 'spacer' }),
      editBtn,
    ]));

    node.addEventListener('dblclick', startEdit);

    // A pending bulk preview is shown in place, on the left, rather than as a
    // sample list in the right-hand card: the whole point of a preview is to
    // see it against the surrounding conversation.
    const pendingAfter = this.opts.preview()?.get(t.msgId);
    if (pendingAfter !== undefined) {
      const { before, after } = diffFragments(t.body, pendingAfter);
      node.classList.add('preview');
      node.appendChild(el('div', { class: 'before-label', text: '미리보기 — 적용 전' }));
      node.appendChild(elWith('turn-body', before));
      node.appendChild(el('div', { class: 'before-label', text: '적용 후' }));
      node.appendChild(elWith('turn-body', after));
      return node;
    }

    const mode = this.opts.viewMode();
    const showDiff = t.changed && t.original != null && this.opts.showOriginal();
    if (showDiff) {
      // Diffs are always character-exact, so they use the raw text even in
      // rendered mode - a diff of cleaned-up text would hide the very edit the
      // user is checking.
      const { before, after } = diffFragments(t.original as string, t.body);
      node.appendChild(el('div', { class: 'before-label', text: '이전' }));
      node.appendChild(elWith('turn-body', before));
      node.appendChild(el('div', { class: 'before-label', text: '이후' }));
      node.appendChild(elWith('turn-body', after));
    } else {
      node.appendChild(renderBody(t.body, mode, this.opts.renderOptions()));
    }
    return node;
  }
}


function elWith(cls: string, frag: Node): HTMLElement {
  const box = el('div', { class: cls });
  box.appendChild(frag);
  return box;
}
