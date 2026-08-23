/**
 * The agent's editable procedures.
 *
 * A skill is something the user writes once instead of re-explaining a workflow
 * in every conversation. Two kinds:
 *
 *   md      prose. Goes into the system prompt, so it costs tokens on every
 *           request - which is what the enable toggle is really controlling.
 *   script  Python. Its source stays out of the prompt; the file is placed in
 *           the workspace and the prompt only says it is there.
 *
 * Three things this panel has to make visible, because each is otherwise an
 * invisible failure mode:
 *
 *   - **Enabled is not the same as stored.** Disabling keeps the skill.
 *   - **What is actually sent.** "왜 스킬대로 안 하지" cannot be answered without
 *     seeing the block that reached the model, truncation included.
 *   - **Which kind a skill is.** A script that was uploaded as prose would sit
 *     in the prompt as a wall of code and look like it simply did not work.
 */
import { el, clear, armed, modal, setSelected, selectedValue } from './dom';
import { state, type Skill } from '../state';

export function buildSkillsCard(): HTMLElement {
  const listMount = el('div');
  const out = el('div');
  const budget = el('div', { class: 'hint' });
  let maxBody = 8000;

  const say = (text: string, kind: 'ok' | 'err' | '' = '') => {
    clear(out);
    out.appendChild(el('div', { class: 'notice ' + kind, text }));
  };

  const refresh = async (): Promise<void> => {
    clear(listMount);
    listMount.appendChild(el('div', { class: 'hint', text: '읽는 중입니다…' }));
    try {
      const r = await state.skills();
      maxBody = r.maxBodyChars || maxBody;
      budget.textContent =
        `프롬프트에 실리는 분량 ${r.usedChars.toLocaleString()}자 / 한도 ${r.limitChars.toLocaleString()}자`
        + (r.usedChars > r.limitChars ? ' — 한도를 넘어 일부가 빠집니다' : '');
      clear(listMount);
      if (!r.skills.length) {
        listMount.appendChild(el('div', { class: 'hint', text: '등록된 스킬이 없습니다.' }));
        return;
      }
      for (const s of r.skills) listMount.appendChild(row(s));
    } catch (e) {
      clear(listMount);
      listMount.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    }
  };

  const row = (s: Skill): HTMLElement => {
    const toggle = el('input', { type: 'checkbox', checked: s.enabled, title: '켜면 매 요청에 함께 보냅니다' });
    toggle.addEventListener('change', async () => {
      try {
        await state.toggleSkill(s.id, toggle.checked);
        await refresh();
      } catch (e) {
        toggle.checked = !toggle.checked;
        say(msg(e), 'err');
      }
    });

    const editBtn = el('button', { class: 'ghost tiny', text: '수정' });
    editBtn.addEventListener('click', () => openEditor(s, refresh, say, maxBody));

    const del = el('button', { class: 'ghost tiny' });
    armed(del, '삭제', '한 번 더', async () => {
      try {
        await state.deleteSkill(s.id);
        await refresh();
      } catch (e) {
        say(msg(e), 'err');
      }
    });

    const meta = s.kind === 'md'
      ? `${s.body.length}자`
      : `${s.kind === 'script' ? '스크립트' : '자료'} · skills/${s.filename}`;

    return el('div', { class: 'pickrow' + (s.enabled ? '' : ' off') }, [
      toggle,
      el('div', { class: 'grow' }, [
        el('div', { class: 'pickname' }, [
          el('span', { text: s.name }),
          s.kind === 'script' ? el('span', { class: 'badge', text: 'PY' }) : null,
          s.kind === 'reference' ? el('span', { class: 'badge', text: 'MD' }) : null,
          s.enabled ? null : el('span', { class: 'badge', text: '꺼짐' }),
        ]),
        el('div', { class: 'hint', text: meta }),
      ]),
      editBtn, del,
    ]);
  };

  const addBtn = el('button', { class: 'primary', text: '스킬 추가' });
  addBtn.addEventListener('click', () => openEditor(null, refresh, say, maxBody));

  // Upload rather than paste, because a script skill is a file the user already
  // has. The extension decides the kind - guessing from the content would be
  // wrong on any markdown file with code fences in it.
  const picker = el('input', {
    type: 'file',
    accept: '.md,.txt,.py',
    style: { display: 'none' },
  });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const skill = await state.uploadSkill(file.name, await file.text());
      await refresh();
      say(skill.kind === 'script'
        ? `${file.name} 을(를) 스크립트 스킬로 등록했습니다. 워크스페이스의 skills/ 에 놓입니다.`
        : `${file.name} 을(를) 스킬로 등록했습니다.`, 'ok');
    } catch (e) {
      say('업로드에 실패했습니다: ' + msg(e), 'err');
    } finally {
      picker.value = '';
    }
  });
  const uploadBtn = el('button', { class: 'ghost', text: '업로드 (.md · .py)' });
  uploadBtn.addEventListener('click', () => picker.click());

  const previewBtn = el('button', { class: 'ghost', text: '보내는 내용 보기' });
  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      const r = await state.skillPrompt();
      modal(`실제로 붙는 내용 · ${r.chars.toLocaleString()}자`, el('div', {}, [
        el('pre', { class: 'mono filepreview', text: r.prompt || '(켜 둔 스킬이 없습니다)' }),
      ]), { wide: true });
    } catch (e) {
      say(msg(e), 'err');
    } finally {
      previewBtn.disabled = false;
    }
  });

  void refresh();

  return el('div', { class: 'card' }, [
    el('h2', { text: '스킬' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '자주 시키는 작업의 순서를 적어 두면 매번 설명하지 않아도 됩니다. 켜 둔 스킬만 함께 보내집니다.',
    ]),
    listMount,
    el('div', { class: 'row', style: { marginTop: '10px' } }, [addBtn, uploadBtn, previewBtn]),
    picker,
    budget,
    out,
  ]);
}

/** One form for both 추가 and 수정, the same way presets do it. */
function openEditor(
  skill: Skill | null,
  refresh: () => Promise<void>,
  say: (t: string, k?: 'ok' | 'err' | '') => void,
  maxBody: number,
): void {
  const name = el('input', { placeholder: '스킬 이름', value: skill?.name ?? '' });
  const kind = el('select');
  kind.appendChild(el('option', { value: 'md', text: '지침 (프롬프트에 실림)' }));
  kind.appendChild(el('option', { value: 'reference', text: '자료 (파일로 놓임 · md)' }));
  kind.appendChild(el('option', { value: 'script', text: '스크립트 (파일로 놓임 · py)' }));
  setSelected(kind, skill?.kind ?? 'md');

  const filename = el('input', { placeholder: 'tidy_names.py', value: skill?.filename ?? '' });
  const fileField = el('label', { class: 'field' }, [
    el('span', { text: '파일 이름' }), filename,
    el('span', { class: 'hint', text: '워크스페이스의 skills/ 아래에 이 이름으로 놓입니다.' }),
  ]);

  const body = el('textarea', {
    value: skill?.body ?? '',
    style: { minHeight: '220px' },
  });
  const count = el('div', { class: 'hint' });
  const out = el('div');

  const syncKind = () => {
    const k = selectedValue(kind);
    // Both non-md kinds live as files, so both need a filename and neither
    // spends the prompt budget.
    const asFile = k !== 'md';
    fileField.style.display = asFile ? 'block' : 'none';
    filename.placeholder = k === 'script' ? 'tidy_names.py' : 'risuai-cbs.md';
    body.placeholder = k === 'script'
      ? '파이썬 코드를 넣어 주세요. 첫 줄 docstring이 설명으로 쓰입니다.'
      : k === 'reference'
        ? '참고 자료를 넣어 주세요. 첫 문단이 “언제 읽어야 하는지”로 쓰입니다.'
        : '이 작업을 할 때 어떤 순서로 해야 하는지 적어 주세요.';
    body.style.fontFamily = k === 'script' ? 'Consolas, monospace' : '';
    count.textContent = asFile
      ? `${body.value.length}자 · 내용은 프롬프트에 실리지 않습니다`
      : `${body.value.length} / ${maxBody}자`;
  };
  kind.addEventListener('change', syncKind);
  body.addEventListener('input', syncKind);
  syncKind();

  const save = el('button', { class: 'primary', text: '저장' });
  const cancel = el('button', { class: 'ghost', text: '취소' });

  const form = el('div', {}, [
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('label', { class: 'field' }, [el('span', { text: '종류' }), kind]),
    fileField,
    el('label', { class: 'field' }, [el('span', { text: '내용' }), body, count]),
    out,
    el('div', { class: 'row' }, [save, cancel]),
  ]);

  const close = modal(skill ? '스킬 수정' : '새 스킬', form, { wide: true });
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveSkill({
        id: skill?.id,
        name: name.value,
        body: body.value,
        enabled: skill ? skill.enabled : true,
        kind: selectedValue(kind) as 'md' | 'script' | 'reference',
        filename: filename.value,
      });
      close();
      await refresh();
      say('저장했습니다.', 'ok');
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      save.disabled = false;
    }
  });
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
