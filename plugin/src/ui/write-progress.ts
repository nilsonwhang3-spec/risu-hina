import { onWriteProgress } from '../operation';
import { el } from './dom';

let overlay: HTMLElement | null = null;
let label: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
onWriteProgress(message => {
  if (message === null) {
    overlay?.remove(); overlay = null; label = null;
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
    return;
  }
  if (!overlay) {
    previousFocus = document.activeElement as HTMLElement | null;
    label = el('div', { role: 'status', 'aria-live': 'polite' });
    overlay = el('div', { class: 'write-progress', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'RisuAI에 반영 중', tabindex: '-1' }, [
      el('div', { class: 'write-progress-card' }, [
        el('span', { class: 'write-spinner', 'aria-hidden': 'true' }),
        el('strong', { text: 'RisuAI에 반영 중' }), label,
        el('div', { class: 'hint', text: '완료될 때까지 창을 닫거나 봇을 변경하지 마세요.' }),
      ]),
    ]);
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Tab' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); }
    });
    document.body.appendChild(overlay);
    overlay.focus();
  }
  label!.textContent = message;
});
