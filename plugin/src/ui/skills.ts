/**
 * The agent's skills - folders it loads when a job calls for them.
 *
 * A skill is `data/skills/<id>/SKILL.md` plus whatever files the procedure
 * needs (references, scripts). Only its name and description go into the
 * prompt; that description is the trigger, and the agent calls `load_skill`
 * when a request matches it. So the panel has to make three things plain:
 *
 *   - **The description is what the agent decides by.** It is edited as a
 *     field of its own, not buried in the body, and the catalog preview shows
 *     exactly the line the model reads.
 *   - **Enabled is not the same as stored.** Disabling keeps the folder.
 *   - **What loading returns.** "왜 스킬대로 안 하지" is answered by seeing the
 *     catalog the model saw and the text `load_skill` would hand it.
 */
import { el, clear, armed, modal } from './dom';
import { state, type Skill } from '../state';

export function buildSkillsCard(opts: { onMount?: (refresh: () => Promise<void>) => void } = {}): HTMLElement {
  const listMount = el('div');
  const out = el('div', { class: 'outbox' });
  const budget = el('div', { class: 'hint' });
  let maxBody = 40000;
  let maxDesc = 400;

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
      maxDesc = r.maxDescriptionChars || maxDesc;
      budget.textContent =
        `프롬프트에 실리는 분량 ${r.catalogChars.toLocaleString()}자 / 한도 ${r.catalogLimit.toLocaleString()}자`
        + ' — 목록(이름·설명)과 “항상 적용” 스킬의 본문만 실립니다. 나머지 본문은 필요할 때 불러옵니다.';
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
    const toggle = el('input', { type: 'checkbox', checked: s.enabled, title: '켜면 목록에 실려 에이전트가 불러올 수 있습니다' });
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
    editBtn.addEventListener('click', () => void openEditor(s.id, refresh, say, { maxBody, maxDesc }));

    const del = el('button', { class: 'ghost tiny' });
    armed(del, '삭제', '폴더째 지웁니다', async () => {
      try {
        await state.deleteSkill(s.id);
        await refresh();
      } catch (e) {
        say(msg(e), 'err');
      }
    });

    const files = s.files?.length ? ` · 파일 ${s.files.length}` : '';
    return el('div', { class: 'pickrow' + (s.enabled ? '' : ' off') }, [
      toggle,
      el('div', { class: 'grow' }, [
        el('div', { class: 'pickname' }, [
          el('span', { text: s.name }),
          s.always ? el('span', { class: 'badge warn', text: '항상' }) : null,
          s.files?.some((f) => f.path.startsWith('scripts/')) ? el('span', { class: 'badge', text: 'PY' }) : null,
          s.enabled ? null : el('span', { class: 'badge', text: '꺼짐' }),
        ]),
        el('div', { class: 'hint', text: s.description || '(설명 없음)' }),
        el('div', { class: 'hint dim', text: `skills/${s.id} · 본문 ${s.bodyChars.toLocaleString()}자${files}` }),
      ]),
      editBtn, del,
    ]);
  };

  const addBtn = el('button', { class: 'primary', text: '스킬 추가' });
  addBtn.addEventListener('click', () => void openEditor(null, refresh, say, { maxBody, maxDesc }));

  // Upload a file (one skill from one .md/.py) or a whole folder as .zip.
  const picker = el('input', { type: 'file', accept: '.md,.txt,.py,.zip', style: { display: 'none' } });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const skill = await state.uploadSkill(file);
      await refresh();
      say(`“${skill.name}” 스킬을 만들었습니다 (skills/${skill.id}). 설명을 다듬어 두면 에이전트가 더 정확히 고릅니다.`, 'ok');
    } catch (e) {
      say('업로드에 실패했습니다: ' + msg(e), 'err');
    } finally {
      picker.value = '';
    }
  });
  const uploadBtn = el('button', { class: 'ghost', text: '가져오기 (.md · .py · .zip)' });
  uploadBtn.addEventListener('click', () => picker.click());

  const previewBtn = el('button', { class: 'ghost', text: '보내는 내용 보기' });
  previewBtn.addEventListener('click', async () => {
    previewBtn.disabled = true;
    try {
      const r = await state.skillPrompt();
      modal(`실제로 붙는 내용 · ${r.chars.toLocaleString()}자`, el('div', {}, [
        el('div', { class: 'hint', style: { marginBottom: '8px' },
          text: '이 블록이 매 요청의 지침 끝에 붙습니다. 본문은 에이전트가 load_skill 을 부를 때 따로 전달됩니다.' }),
        el('pre', { class: 'mono filepreview', text: r.prompt || '(켜 둔 스킬이 없습니다)' }),
      ]), { wide: true });
    } catch (e) {
      say(msg(e), 'err');
    } finally {
      previewBtn.disabled = false;
    }
  });

  void refresh();
  // Re-read once the connection is proven direct: opened before the probe
  // finished, the list held the transport's "token not sent" refusal under a
  // header that already said connected.
  opts.onMount?.(refresh);

  return el('div', { class: 'card' }, [
    el('h2', { text: '스킬' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' } }, [
      '자주 시키는 작업의 절차를 폴더로 둡니다. 이름과 “언제 쓰는지” 한 줄만 프롬프트에 실리고, '
      + '에이전트는 맞는 작업이 오면 load_skill 로 본문을 불러옵니다 — 대화창에 툴 호출로 보입니다.',
    ]),
    listMount,
    el('div', { class: 'row', style: { marginTop: '10px' } }, [addBtn, uploadBtn, previewBtn]),
    picker,
    budget,
    out,
  ]);
}

/** One form for both 추가 and 수정. For an existing skill, its files too. */
async function openEditor(
  id: string | null,
  refresh: () => Promise<void>,
  say: (t: string, k?: 'ok' | 'err' | '') => void,
  caps: { maxBody: number; maxDesc: number },
): Promise<void> {
  let skill: Skill | null = null;
  if (id) {
    try {
      skill = await state.skill(id);
    } catch (e) {
      say(msg(e), 'err');
      return;
    }
  }

  const name = el('input', { placeholder: '스킬 이름', value: skill?.name ?? '' });
  const description = el('textarea', {
    value: skill?.description ?? '',
    placeholder: '언제 쓰는 스킬인지 한두 문장. 예: "한 인물의 말투를 챗 전체에서 맞출 때. 말투 통일·반말로 바꿔 같은 요청."',
    style: { minHeight: '56px' },
  });
  const descCount = el('div', { class: 'hint' });
  const always = el('input', { type: 'checkbox', checked: !!skill?.always });
  const body = el('textarea', {
    value: skill?.body ?? '',
    placeholder: '이 작업을 할 때 어떤 순서로 해야 하는지. 에이전트가 load_skill 로 불러 읽습니다.',
    style: { minHeight: '220px' },
  });
  const bodyCount = el('div', { class: 'hint' });
  const out = el('div', { class: 'outbox' });

  const sync = () => {
    descCount.textContent = `${description.value.length} / ${caps.maxDesc}자 — 이 줄이 매 요청에 실리고, 에이전트가 스킬을 고르는 근거입니다`;
    bodyCount.textContent = `${body.value.length.toLocaleString()} / ${caps.maxBody.toLocaleString()}자`
      + (always.checked ? ' — “항상 적용”이라 매 요청에 실립니다' : ' — 불러올 때만 전달됩니다');
  };
  description.addEventListener('input', sync);
  body.addEventListener('input', sync);
  always.addEventListener('change', sync);
  sync();

  const save = el('button', { class: 'primary', text: '저장' });
  const cancel = el('button', { class: 'ghost', text: '취소' });

  const form = el('div', {}, [
    el('label', { class: 'field' }, [el('span', { text: '이름' }), name]),
    el('label', { class: 'field' }, [el('span', { text: '설명 — 언제 쓰는지 (트리거)' }), description, descCount]),
    el('label', { class: 'checkrow' }, [always, el('span', { text: '항상 적용 — 본문을 매 요청에 함께 보냅니다 (모든 대화에 적용될 규칙에만)' })]),
    el('label', { class: 'field' }, [el('span', { text: '본문 — 절차' }), body, bodyCount]),
  ]);
  if (skill) form.appendChild(buildFiles(skill, say));
  form.appendChild(out);
  form.appendChild(el('div', { class: 'row' }, [save, cancel]));

  const close = modal(skill ? `스킬 수정 · skills/${skill.id}` : '새 스킬', form, { wide: true });
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      await state.saveSkill({
        id: skill?.id,
        name: name.value,
        description: description.value,
        body: body.value,
        always: always.checked,
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

/** The files in the skill folder: list, add, remove. Saved as they happen. */
function buildFiles(skill: Skill, say: (t: string, k?: 'ok' | 'err' | '') => void): HTMLElement {
  const list = el('div', { class: 'skillfiles' });
  const out = el('div', { class: 'outbox' });
  let files = skill.files ?? [];

  const draw = () => {
    clear(list);
    if (!files.length) {
      list.appendChild(el('div', { class: 'hint', text: '파일이 없습니다. 자료(.md)나 스크립트(.py)를 넣으면 본문에서 가리킬 수 있습니다.' }));
      return;
    }
    for (const f of files) {
      const del = el('button', { class: 'ghost tiny' });
      armed(del, '×', '지울까요?', async () => {
        try {
          await state.deleteSkillFile(skill.id, f.path);
          files = files.filter((x) => x.path !== f.path);
          draw();
        } catch (e) {
          clear(out);
          out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
        }
      });
      list.appendChild(el('div', { class: 'pickrow' }, [
        el('span', { class: 'mono grow', text: `skills/${skill.id}/${f.path}` }),
        el('span', { class: 'hint', text: fmtSize(f.size) }),
        del,
      ]));
    }
  };
  draw();

  const picker = el('input', { type: 'file', style: { display: 'none' } });
  const sub = el('select');
  sub.appendChild(el('option', { value: 'references', text: 'references/ (자료)' }));
  sub.appendChild(el('option', { value: 'scripts', text: 'scripts/ (스크립트)' }));
  sub.appendChild(el('option', { value: '', text: '폴더 바로 아래' }));
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const folder = [...sub.querySelectorAll('option')].find((o) => o.selected)?.value ?? 'references';
      const r = await state.putSkillFile(skill.id, (folder ? folder + '/' : '') + file.name, file);
      files = [...files.filter((x) => x.path !== r.path), { path: r.path, size: r.size, textual: true }]
        .sort((a, b) => a.path.localeCompare(b.path));
      draw();
      say(`${r.path} 을(를) 넣었습니다. 본문에서 skills/${skill.id}/${r.path} 로 가리켜 주세요.`, 'ok');
    } catch (e) {
      clear(out);
      out.appendChild(el('div', { class: 'notice err', text: msg(e) }));
    } finally {
      picker.value = '';
    }
  });
  const addBtn = el('button', { class: 'ghost tiny', text: '파일 넣기' });
  addBtn.addEventListener('click', () => picker.click());

  return el('div', { class: 'field' }, [
    el('span', { text: '폴더의 파일' }),
    list,
    el('div', { class: 'row', style: { marginTop: '6px' } }, [sub, addBtn, picker]),
    out,
  ]);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
