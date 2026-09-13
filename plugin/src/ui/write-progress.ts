import { onWriteProgress } from '../operation';
import { el } from './dom';

let overlay: HTMLElement | null = null;
let label: HTMLElement | null = null;
let previousFocus: HTMLElement | null = null;
let unlock = (): void => {};

function lockBackground(): () => void {
  const nodes = [...document.body.children].filter(node => node !== overlay) as HTMLElement[];
  const changed = nodes.filter(node => !node.hasAttribute('inert'));
  for (const node of changed) node.setAttribute('inert', '');
  const roots = [document.documentElement, document.body];
  const overflow = roots.map(node => node.style.overflow);
  for (const node of roots) node.style.overflow = 'hidden';
  const stop = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const events = ['click', 'dblclick', 'pointerdown', 'pointerup', 'mousedown', 'mouseup',
    'touchstart', 'touchmove', 'wheel', 'keydown', 'keyup', 'keypress', 'contextmenu', 'dragstart', 'drop'];
  for (const type of events) document.addEventListener(type, stop, { capture: true, passive: false });
  return () => {
    for (const type of events) document.removeEventListener(type, stop, true);
    for (const node of changed) node.removeAttribute('inert');
    roots.forEach((node, i) => { node.style.overflow = overflow[i]; });
  };
}
onWriteProgress(message => {
  if (message === null) {
    unlock(); unlock = () => {};
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
    unlock = lockBackground();
    overlay.focus();
  }
  label!.textContent = message;
});
