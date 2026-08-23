/**
 * The agent's configuration, as one selected preset.
 *
 * The settings tab shows exactly one preset - the one the agent is running -
 * and nothing else. Everything that used to sit on that page (base URL, model,
 * key, budgets) is now inside that preset, reachable through 수정.
 *
 * That is a real simplification, not a rearrangement: the page previously
 * showed a form *and* a list of saved copies of that form, which meant two
 * things on screen that both looked like the current settings. Now there is one
 * current thing, and the list is behind a button.
 *
 * The list and the editor are modals rather than inline sections because both
 * are whole tasks. An editor with ten fields unfolding inside a settings page
 * pushes everything else off screen and leaves the user unsure whether their
 * half-typed key is saved.
 */
import { el, clear, armed, modal, setSelected, selectedValue } from './dom';
import { state, type AgentPreset } from '../state';

const REASONING_LABEL: Record<string, string> = {
  '': '보내지 않음',
  none: 'none',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

export interface PresetsCardOptions {
  /** Called whenever the selected preset changes, so dependent UI can refresh. */
  onChanged: () => void | Promise<void>;
}

export function buildPresetsCard(opts: PresetsCardOptions): HTMLElement {
  const currentMount = el('div');
  const out = el('div');

  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const refresh = async (): Promise<void> => {
    clear(currentMount);
    currentMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.presets();
      clear(currentMount);
      currentMount.appendChild(currentRow(r.selected, r.presets.length));
    } catch (e) {
      clear(currentMount);
      currentMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
    await opts.onChanged();
  };

  const currentRow = (p: AgentPreset | null, total: number): HTMLElement => {
    if (!p) {
      return el('div', { class: 'hint', text: '프리셋이 없습니다. 새로 하나 만들어 주세요.' });
    }
    const pick = el('button', { class: 'ghost', text: `선택 (${total})`, title: '저장된 프리셋 목록' });
    pick.addEventListener('click', () => openPicker(refresh, say));

    const edit = el('button', { class: 'primary', text: '수정' });
    edit.addEventListener('click', () => openEditor(p.id, refresh, say));

    return el('div', { class: 'presetnow' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'presetnow-name' }, [
          el('span', { text: p.name }),
          !p.apiKey?.set
            ? el('span', { class: 'badge warn', style: { marginLeft: '6px' }, text: '키 없음' })
            : null,
        ]),
        el('div', { class: 'hint', text: summarise(p) }),
      ]),
      pick, edit,
    ]);
  };

  const addBtn = el('button', { class: 'ghost', text: '새 프리셋' });
  addBtn.addEventListener('click', () => openEditor(null, refresh, say));

  const testBtn = el('button', { class: 'ghost', text: '연결 테스트' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    clear(out);
    out.appendChild(el('div', { class: 'hint', text: '테스트 중입니다… (최대 2분)' }));
    try {
      const r = await state.testAgent() as Record<string, any>;
      clear(out);
      if (r.ok) {
        const u = r.usage ?? {};
        out.appendChild(el('div', { class: 'notice ok' }, [
          el('div', { text: `정상 동작합니다 · ${r.model}` }),
          el('div', { class: 'hint', text: `툴 호출 ${r.toolCalls}건 · 토큰 in ${u.in} / out ${u.out}` }),
        ]));
      } else {
        out.appendChild(el('div', { class: 'notice err' }, [
          el('div', { text: `실패했습니다 (${r.stage})` }),
          el('div', { class: 'hint', text: String(r.error ?? '') }),
        ]));
      }
    } catch (e) {
      say(msg(e), 'err');
    } finally {
      testBtn.disabled = false;
    }
  });

  void refresh();

  return el('div', { class: 'card' }, [
    el('h2', { text: 'AI 에이전트 프리셋' }),
    currentMount,
    el('div', { class: 'row' }, [addBtn, testBtn]),
    out,
    el('div', { class: 'hint', style: { marginTop: '8px' } }, [
      '테스트는 일반 응답과 툴 호출을 따로 확인합니다. 툴 호출이 안 되면 에이전트가 동작할 수 없습니다.',
    ]),
  ]);
}

function summarise(p: AgentPreset): string {
  const bits = [p.model || '모델 미설정'];
  if (p.reasoning) bits.push('reasoning ' + p.reasoning);
  if (p.cache) bits.push('캐시');
  if (p.flex) bits.push('Flex');
  bits.push(`${p.maxTokens.toLocaleString()} 토큰`);
  if (p.instructions) bits.push('기본지침 있음');
  return bits.join(' · ');
}

// --- the picker ---------------------------------------------------------------

function openPicker(refresh: () => Promise<void>, say: (t: string, k?: 'ok' | 'err' | '') => void): void {
  const listMount = el('div');
  const body = el('div', {}, [
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '고르면 바로 적용됩니다. 수정한 내용도 그 즉시 에이전트에 반영됩니다.',
    ]),
    listMount,
  ]);
  const close = modal('프리셋 선택', body);

  const draw = async () => {
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.presets();
      clear(listMount);
      for (const p of r.presets) listMount.appendChild(row(p, r.presets.length));
      const add = el('button', { class: 'primary', text: '새 프리셋 추가', style: { marginTop: '10px' } });
      add.addEventListener('click', () => {
        close();
        openEditor(null, refresh, say);
      });
      listMount.appendChild(add);
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  };

  const row = (p: AgentPreset, total: number): HTMLElement => {
    const pickArea = el('div', { class: 'grow' }, [
      el('div', { class: 'pickname' }, [
        el('span', { text: p.name }),
        p.selected ? el('span', { class: 'badge ok', text: '사용 중' }) : null,
        !p.apiKey?.set ? el('span', { class: 'badge warn', text: '키 없음' }) : null,
      ]),
      el('div', { class: 'hint', text: summarise(p) }),
    ]);
    pickArea.addEventListener('click', async () => {
      if (p.selected) return;
      try {
        await state.selectPreset(p.id);
        await refresh();
        close();
        say(`“${p.name}” 을(를) 쓰기 시작했습니다.`, 'ok');
      } catch (e) {
        say(msg(e), 'err');
      }
    });

    const edit = el('button', { class: 'ghost tiny', text: '수정' });
    edit.addEventListener('click', () => {
      close();
      openEditor(p.id, refresh, say);
    });

    const del = el('button', { class: 'ghost tiny' });
    armed(del, '삭제', '한 번 더', async () => {
      try {
        await state.deletePreset(p.id);
        await draw();
        await refresh();
      } catch (e) {
        // The backend refuses to delete the last one; that is a rule worth
        // stating in place rather than as a silent no-op.
        clear(listMount);
        listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
        setTimeout(() => void draw(), 2500);
      }
    });
    // The delete button is hidden on the only preset rather than shown failing.
    if (total <= 1) del.style.display = 'none';

    return el('div', { class: 'pickrow' + (p.selected ? ' on' : '') }, [pickArea, edit, del]);
  };

  void draw();
}

// --- the editor ---------------------------------------------------------------

/**
 * One form for both 추가 and 수정.
 *
 * `id === null` means a new preset. Everything else about the form is identical,
 * because the difference between creating and editing is one field's worth of
 * behaviour and duplicating the form would guarantee the two drift.
 */
function openEditor(
  id: string | null,
  refresh: () => Promise<void>,
  say: (t: string, k?: 'ok' | 'err' | '') => void,
): void {
  const name = el('input', { placeholder: '프리셋 이름 (예: 정밀 · 저렴이)' });
  const baseUrl = el('input', { placeholder: 'https://ai-gateway.vercel.sh/v1' });
  const model = el('input', { placeholder: 'google/gemini-3.7-flash' });
  const apiKey = el('input', { type: 'password', placeholder: '(변경할 때만 입력)' });
  const keyNote = el('span', { class: 'hint' });
  const maxTokens = el('input', { placeholder: '32000' });
  const temperature = el('input', { placeholder: '0.2' });
  const reasoning = reasoningSelect();
  const cache = el('input', { type: 'checkbox' });
  const flex = el('input', { type: 'checkbox' });
  const instructions = el('textarea', {
    placeholder: '에이전트가 항상 지킬 지침을 적어 주세요. 비워 두셔도 됩니다.',
    style: { minHeight: '110px' },
  });
  const instCount = el('div', { class: 'hint' });
  const out = el('div');
  let keepSentinel = '__keep__';

  const syncCount = () => {
    instCount.textContent = `${instructions.value.length}자`;
  };
  instructions.addEventListener('input', syncCount);
  syncCount();

  const load = async () => {
    try {
      const r = await state.presets();
      keepSentinel = r.keepSentinel || keepSentinel;
      const p = id ? r.presets.find((x) => x.id === id) : null;
      if (!p) {
        keyNote.textContent = '설정되지 않음';
        return;
      }
      name.value = p.name;
      baseUrl.value = p.baseUrl;
      model.value = p.model;
      maxTokens.value = String(p.maxTokens);
      temperature.value = String(p.temperature);
      setSelected(reasoning, p.reasoning || '');
      cache.checked = p.cache;
      flex.checked = p.flex;
      instructions.value = p.instructions || '';
      syncCount();
      keyNote.textContent = p.apiKey?.set
        ? `설정됨 (${p.apiKey.length}자) — 바꾸려면 새로 입력`
        : '설정되지 않음';
    } catch (e) {
      keyNote.textContent = msg(e);
    }
  };

  const save = el('button', { class: 'primary', text: '저장' });
  const cancel = el('button', { class: 'ghost', text: '취소' });

  const body = el('div', {}, [
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('label', { class: 'field' }, [el('span', { text: 'Base URL' }), baseUrl]),
    el('label', { class: 'field' }, [el('span', { text: 'Model' }), model]),
    el('label', { class: 'field' }, [el('span', { text: 'API Key' }), apiKey, keyNote]),
    el('div', { class: 'row' }, [
      el('label', { class: 'field grow' }, [el('span', { text: '최대 출력 토큰' }), maxTokens]),
      el('label', { class: 'field grow' }, [el('span', { text: 'temperature' }), temperature]),
    ]),
    el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '10px' } }, [
      '사고(reasoning) 모델은 생각한 토큰도 출력으로 셉니다. 너무 낮으면 답을 내기 전에 예산이 바닥나므로 32000 이상을 권합니다.',
    ]),
    el('label', { class: 'field' }, [el('span', { text: 'Reasoning' }), reasoning]),
    el('div', { class: 'row', style: { marginBottom: '8px' } }, [
      el('label', { class: 'checkrow', title: '같은 지시문·툴 정의를 다시 보낼 때 캐시를 태웁니다' },
         [cache, el('span', { text: '프롬프트 캐시' })]),
      el('label', { class: 'checkrow', title: '싸지만 느립니다. 대기가 길어질 수 있습니다' },
         [flex, el('span', { text: 'Flex 티어' })]),
    ]),
    el('div', { class: 'hint', style: { marginBottom: '12px' } }, [
      '세 항목 모두 게이트웨이·모델에 따라 지원 여부가 다릅니다. 끄면 요청에서 빠지므로, 오류가 나면 먼저 꺼 보세요.',
    ]),
    el('label', { class: 'field' }, [
      el('span', { text: '기본지침' }), instructions, instCount,
    ]),
    el('div', { class: 'hint', style: { marginTop: '-4px', marginBottom: '12px' } }, [
      '기본 규칙 뒤에 덧붙습니다. “전사에 직접 쓰지 않는다” 같은 안전 규칙은 여기서 뒤집을 수 없습니다.',
    ]),
    out,
    el('div', { class: 'row' }, [save, cancel]),
  ]);

  const close = modal(id ? '프리셋 수정' : '새 프리셋', body, { wide: true });
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const saved = await state.savePreset(name.value, {
        baseUrl: baseUrl.value,
        model: model.value,
        // Leave the stored key alone unless a new one was typed.
        apiKey: apiKey.value ? apiKey.value : keepSentinel,
        maxTokens: maxTokens.value === '' ? undefined : Number(maxTokens.value),
        temperature: temperature.value === '' ? undefined : Number(temperature.value),
        reasoning: selectedValue(reasoning),
        cache: cache.checked,
        flex: flex.checked,
        instructions: instructions.value,
      }, id ?? undefined);
      // A brand-new preset is not selected by itself; making it current is
      // almost always why it was created, so offer it as the next click rather
      // than leaving the user to reopen the picker.
      close();
      await refresh();
      if (!id && !saved.selected) {
        say(`“${saved.name}” 을(를) 저장했습니다. 선택에서 고르면 바로 쓸 수 있습니다.`, 'ok');
      } else {
        say('저장했습니다.', 'ok');
      }
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      save.disabled = false;
    }
  });

  void load();
}

/** The reasoning selector. */
export function reasoningSelect(): HTMLSelectElement {
  const sel = el('select');
  for (const [value, label] of Object.entries(REASONING_LABEL)) {
    sel.appendChild(el('option', { value, text: label }));
  }
  return sel;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
