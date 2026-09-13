import { el, clear, modal, selectedValue, setSelected } from './dom';
import { state } from '../state';
import { transport } from '../transport';

type Note = { id: string; title: string; body: string; evidence: string; revision: number; updatedAt: number };

export function buildAgentNotesCard(onMount: (refresh: () => Promise<void>) => void): HTMLElement {
  const list = el('div');
  const status = el('div', { class: 'hint' });
  const shared = el('select', {}, [el('option', { value: 'project', text: '현재 프로젝트' }), el('option', { value: 'global', text: '전역 공통' })]);
  setSelected(shared, state.activeCharKey ? 'project' : 'global');
  const enabled = el('input', { type: 'checkbox', checked: true });
  const auto = el('input', { type: 'checkbox', checked: true });
  const windowSize = el('input', { type: 'number', min: 8000, step: 1000, value: '128000' });
  const settings = el('button', { class: 'ghost', text: '설정 저장' });
  const refresh = async () => {
    try {
      const cfg = await transport.get<{ config: { agent?: Record<string, unknown> } }>('/config');
      const agent = cfg.config?.agent ?? {};
      enabled.checked = agent.memoryEnabled !== false;
      auto.checked = agent.autoCompact !== false;
      windowSize.value = String(agent.contextWindowTokens ?? 128000);
      await reload();
    } catch (e) { status.textContent = String(e); }
  };
  const scope = () => ({ charKey: state.activeCharKey, shared: selectedValue(shared) === 'global' });
  const edit = (note?: Note) => {
    const boundScope = scope();
    const title = el('input', { value: note?.title ?? '', placeholder: '기억할 사항의 제목' });
    const body = el('textarea', { value: note?.body ?? '', placeholder: '선호·규칙·결정·남은 작업', style: { minHeight: '140px' } });
    const evidence = el('textarea', { value: note?.evidence ?? '사용자가 직접 작성', placeholder: '확인 근거' });
    const save = el('button', { class: 'primary', text: '저장' });
    const error = el('div', { class: 'hint' });
    const close = modal('AI 메모', el('div', {}, [title, body, evidence, save, error]));
    save.addEventListener('click', async () => {
      save.disabled = true;
      try { await transport.post('/agent/notes/save', { ...boundScope, id: note?.id, revision: note?.revision, title: title.value, body: body.value, evidence: evidence.value }); close(); await reload(); }
      catch (e) { error.textContent = String(e); save.disabled = false; }
    });
  };
  const reload = async () => {
    try {
      const query = scope();
      const response = await transport.get<{ notes: Note[] }>('/agent/notes', { charKey: query.charKey, shared: String(query.shared) });
      clear(list);
      for (const note of response.notes) {
        const change = el('button', { class: 'ghost tiny', text: '수정' });
        change.addEventListener('click', () => edit(note));
        const remove = el('button', { class: 'ghost tiny', text: '삭제' });
        remove.addEventListener('click', async () => {
          remove.disabled = true;
          try { await transport.post('/agent/notes/delete', { ...query, id: note.id, revision: note.revision }); await reload(); }
          catch (e) { status.textContent = String(e); remove.disabled = false; }
        });
        list.appendChild(el('details', {}, [el('summary', { text: note.title }),
          el('pre', { text: note.body, style: { whiteSpace: 'pre-wrap' } }),
          el('div', { class: 'hint', text: `근거: ${note.evidence}` }), el('div', { class: 'row' }, [change, remove])]));
      }
      status.textContent = `${response.notes.length}개 메모 · AI가 필요한 주요 사항을 직접 기록하고 다음 대화에 불러옵니다.`;
    } catch (e) { status.textContent = String(e); }
  };
  settings.addEventListener('click', async () => {
    try {
      const tokens = Number(windowSize.value);
      if (!Number.isInteger(tokens) || tokens < 8000) throw new Error('컨텍스트 크기는 8000 이상 정수로 입력하세요.');
      await transport.post('/config', { config: { agent: { memoryEnabled: enabled.checked, autoCompact: auto.checked, contextWindowTokens: tokens } } });
      status.textContent = '설정을 저장했습니다.';
    } catch (e) { status.textContent = String(e); }
  });
  shared.addEventListener('change', () => void reload());
  const add = el('button', { class: 'ghost', text: '메모 추가' });
  add.addEventListener('click', () => edit());
  const reloadBtn = el('button', { class: 'ghost', text: '새로고침' });
  reloadBtn.addEventListener('click', () => void refresh());
  const history = el('button', { class: 'ghost', text: '최근 압축 기록' });
  history.addEventListener('click', async () => {
    try {
      const data = await transport.get<{ events: { at: number; beforeChars: number; afterChars: number; method: string }[] }>('/agent/context');
      modal('컨텍스트 압축 기록', el('div', {}, data.events.length ? data.events.map(e => el('p', {
        text: `${new Date(e.at * 1000).toLocaleString()} · ${e.beforeChars.toLocaleString()} → ${e.afterChars.toLocaleString()}자 (${e.method})`,
      })) : [el('p', { text: '아직 압축 기록이 없습니다.' })]));
    } catch (e) { status.textContent = String(e); }
  });
  onMount(refresh);
  void refresh();
  return el('div', { class: 'card' }, [
    el('h3', { text: 'AI 메모리 · 자동 컨텍스트 압축' }),
    el('label', {}, [enabled, el('span', { text: ' AI 메모리 사용' })]),
    el('label', {}, [auto, el('span', { text: ' 요청마다 컨텍스트를 확인하고 자동 압축' })]),
    el('label', { class: 'field' }, [el('span', { text: '사용 모델의 컨텍스트 크기 (토큰)' }), windowSize]),
    el('p', { class: 'hint', text: '출력 공간과 도구·지침 크기를 고려해 여유를 두고 압축합니다. 토큰 수는 추정치입니다. 최신 사용자 지시와 미완료 작업을 남기며, 요약에는 설정한 모델을 사용합니다.' }),
    el('div', { class: 'row' }, [settings, history]),
    el('div', { class: 'row' }, [shared, add, reloadBtn]), list, status,
  ]);
}
