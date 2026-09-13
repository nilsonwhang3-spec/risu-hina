import { el, clear, modal, setSelected, selectedValue } from '../dom';
import { state, type AssetBinding, type AssetRules, type AssetStatus, type GroupItem } from '../../state';
import { S, hub, gen, msg } from './store';

const modes: [string, string][] = [['required', '필수'], ['optional', '선택'], ['excluded', '제외']];
const uid = () => 'r_' + Math.random().toString(36).slice(2, 12);
const fields = (template: string) => [...template.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(m => m[1]);
const field = (name: string, input: HTMLElement) => el('label', { class: 'field' }, [el('span', { text: name }), input]);
function input(value: string, change: (v: string) => void): HTMLInputElement {
  const node = el('input', { value }) as HTMLInputElement;
  node.addEventListener('input', () => change(node.value));
  return node;
}
function select(values: [string, string][], value: string, change: (v: string) => void): HTMLSelectElement {
  const node = el('select') as HTMLSelectElement;
  for (const [id, name] of values) node.appendChild(el('option', { value: id, text: name }));
  setSelected(node, value);
  node.addEventListener('change', () => change(selectedValue(node)));
  return node;
}
function button(text: string, action: () => void): HTMLElement {
  const b = el('button', { class: 'ghost tiny', text });
  b.addEventListener('click', action);
  return b;
}
function projectHint(): string {
  return /^(?:studio\/output|projects)\/([^/]+)/.exec(S.selected)?.[1] || gen.assetProject;
}

/** A reusable binding picker. No implicit first-set choice on opening it. */
export function assetChoice(initial: AssetBinding, change: (value: AssetBinding) => void): HTMLElement {
  let value = { ...initial, fields: { ...initial.fields } };
  const root = el('div', { class: 'card' });
  const choices = el('div');
  const notice = el('div', { class: 'hint' });
  let revision = 0;
  const project = input(value.project, v => { value.project = v; });
  const publish = () => change({ ...value, fields: { ...value.fields } });
  const load = async () => {
    const rev = ++revision;
    try {
      const doc = await state.studio.assetRules(project.value.trim());
      if (rev !== revision) return;
      project.value = value.project = doc.project;
      if (!doc.sets.some(s => s.id === value.setId)) value.setId = '';
      clear(choices);
      const slots = el('div');
      const drawSlots = () => {
        clear(slots);
        const aset = doc.sets.find(s => s.id === value.setId);
        if (!aset) { value.slotId = ''; publish(); return; }
        if (!aset.slots.some(s => s.id === value.slotId)) value.slotId = '';
        slots.appendChild(field('슬롯', select([['', '씬 이름으로 결정'], ...aset.slots.map(s =>
          [s.id, Object.values(s.fields).join(' · ') + ' (' + s.id + ')'] as [string, string])], value.slotId || '', v => {
          value.slotId = v; value.fields = value.fields.character ? { character: value.fields.character } : {}; publish();
        })));
        publish();
      };
      choices.append(field('에셋 세트', select([['', '기존 파일명 방식'], ...doc.sets.map(s => [s.id, s.name] as [string, string])], value.setId, v => {
        value.setId = v; value.slotId = ''; value.fields = value.fields.character ? { character: value.fields.character } : {}; drawSlots();
      })), slots, field('캐릭터명 (비우면 활성 카드)', input(value.fields.character || '', v => {
        value.fields = v ? { character: v } : {}; publish();
      })));
      drawSlots();
      notice.textContent = doc.sets.length ? '세트 규칙으로 이름을 만들고, 인페인트에도 같은 규칙을 유지합니다.' : '아직 세트가 없습니다. 에셋 규칙에서 먼저 저장하세요.';
    } catch (e) { notice.textContent = msg(e); }
  };
  root.append(field('프로젝트 폴더명', project), button('프로젝트 불러오기', () => void load()),
    button('에셋 규칙 편집', () => void openAssetRules(project.value)), choices, notice);
  void load();
  return root;
}

export async function openAssetRules(initialProject = projectHint()): Promise<void> {
  const root = el('div', { style: { minWidth: '280px' } });
  const editor = el('div');
  const notice = el('div', { class: 'notice' });
  const project = input(initialProject, () => {});
  let doc: AssetRules;
  let ruleId = '', setId = '';
  const draw = () => {
    clear(editor);
    const rules = el('details', { open: true });
    rules.appendChild(el('summary', { text: '명명 규칙' }));
    const rulePicker = select(doc.rules.map(r => [r.id, r.name]), ruleId, v => { ruleId = v; draw(); });
    rules.append(rulePicker, button('규칙 추가', () => {
      ruleId = uid();
      doc.rules.push({ id: ruleId, name: '새 규칙', template: '{character}-{emotion}', extension: 'webp', allowed: {}, empty: {} });
      draw();
    }));
    const rule = doc.rules.find(r => r.id === ruleId);
    if (rule) {
      const template = input(rule.template, v => { rule.template = v; });
      template.addEventListener('change', draw);
      rules.append(field('이름', input(rule.name, v => { rule.name = v; })),
        field('파일명 템플릿', template), el('div', { class: 'hint', text: '예: {character}-{emotion}-{outfit}. 확장자는 아래에서 선택합니다. 필드 순서와 구분자를 자유롭게 지정하세요.' }),
        field('확장자', select([['webp', 'webp'], ['png', 'png'], ['jpg', 'jpg']], rule.extension, v => { rule.extension = v; })),
        button('이 규칙 삭제', () => { doc.rules = doc.rules.filter(r => r.id !== rule.id); ruleId = doc.rules[0]?.id || ''; draw(); }));
      for (const key of fields(rule.template)) {
        rules.append(el('div', { class: 'row' }, [
          field(key + ' 허용값 (쉼표 구분, 비우면 자유)', input((rule.allowed?.[key] || []).join(', '), v => {
            (rule.allowed ??= {})[key] = v.split(',').map(x => x.trim()).filter(Boolean);
          })),
          field('빈 값 대체어', input(rule.empty?.[key] || '', v => { (rule.empty ??= {})[key] = v; })),
        ]));
      }
      if (rule.regex) rules.append(field('저장된 regex · 캡처 순서: ' + fields(rule.template).join(', '),
        el('code', { text: rule.regex, style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } })));
    }
    const sets = el('details', { open: true });
    sets.appendChild(el('summary', { text: '에셋 세트와 캐릭터 예외' }));
    sets.append(select(doc.sets.map(s => [s.id, s.name]), setId, v => { setId = v; draw(); }),
      button('세트 추가', () => {
        if (!doc.rules.length) { notice.textContent = '명명 규칙을 먼저 추가하세요.'; return; }
        setId = uid(); doc.sets.push({ id: setId, name: '새 세트', ruleId: ruleId || doc.rules[0].id, characters: [], slots: [], overrides: {} });
        draw();
      }));
    const aset = doc.sets.find(s => s.id === setId);
    if (aset) {
      sets.append(field('세트 이름', input(aset.name, v => { aset.name = v; })),
        field('명명 규칙', select(doc.rules.map(r => [r.id, r.name]), aset.ruleId, v => { aset.ruleId = v; draw(); })),
        field('적용 캐릭터 (쉼표 구분, 비우면 전체)', input(aset.characters.join(', '), v => { aset.characters = v.split(',').map(x => x.trim()).filter(Boolean); })),
        el('div', { class: 'hint', text: '필수: 없으면 부족분 · 선택: 없어도 완성 · 제외: 생성·내보내기 대상 아님' }));
      const names = fields(doc.rules.find(r => r.id === aset.ruleId)?.template || '').filter(k => k !== 'character');
      for (const slot of aset.slots) {
        const row = el('div', { class: 'card' });
        row.appendChild(field('슬롯 ID', input(slot.id, v => { slot.id = v; })));
        for (const key of names) row.appendChild(field(key, input(slot.fields[key] || '', v => { slot.fields[key] = v; })));
        row.append(select(modes, slot.status, v => { slot.status = v as AssetStatus; }),
          button('슬롯 삭제', () => { aset.slots = aset.slots.filter(s => s !== slot); draw(); }));
        sets.appendChild(row);
      }
      sets.appendChild(button('슬롯 추가', () => { aset.slots.push({ id: uid(), fields: {}, status: 'required' }); draw(); }));
      const exceptions = el('details');
      exceptions.appendChild(el('summary', { text: '캐릭터별 예외' }));
      for (const [character, statuses] of Object.entries(aset.overrides || {})) {
        for (const [sid, mode] of Object.entries(statuses)) {
          exceptions.appendChild(el('div', { class: 'row' }, [el('span', { text: character + ' · ' + sid }),
            select(modes, mode, v => { statuses[sid] = v as AssetStatus; }),
            button('예외 삭제', () => { delete statuses[sid]; draw(); })]));
        }
      }
      let who = '', which = aset.slots[0]?.id || '', how: AssetStatus = 'excluded';
      exceptions.append(field('캐릭터명', input('', v => { who = v; })),
        field('대상 슬롯', select(aset.slots.map(s => [s.id, s.id]), which, v => { which = v; })),
        select(modes, how, v => { how = v as AssetStatus; }), button('예외 추가', () => {
          if (!who.trim() || !which) { notice.textContent = '캐릭터명과 슬롯을 지정하세요.'; return; }
          ((aset.overrides ??= {})[who.trim()] ??= {})[which] = how; draw();
        }));
      sets.append(exceptions, button('이 세트 삭제', () => { doc.sets = doc.sets.filter(s => s !== aset); setId = doc.sets[0]?.id || ''; draw(); }));
    }
    const save = button('규칙·세트 저장', () => void (async () => {
      try { doc = await state.studio.saveAssetRules(doc); notice.textContent = '저장했습니다. 기존 이미지는 적용 당시의 명명 규칙을 유지합니다.'; draw(); }
      catch (e) { notice.textContent = msg(e); }
    })());
    editor.append(rules, sets, save);
  };
  const load = async () => {
    try {
      doc = await state.studio.assetRules(project.value.trim());
      project.value = doc.project;
      if (!doc.project) { notice.textContent = '프로젝트 폴더명을 입력하세요.'; return; }
      ruleId = doc.rules[0]?.id || ''; setId = doc.sets[0]?.id || ''; notice.textContent = ''; draw();
    } catch (e) { notice.textContent = msg(e); }
  };
  root.append(field('프로젝트 폴더명', project), button('불러오기', () => void load()), editor, notice);
  modal('프로젝트 에셋 규칙', root, { sticky: true });
  await load();
}

export function openAssetBinding(item: GroupItem): void {
  let binding: AssetBinding = item.asset
    ? { project: item.asset.project, setId: item.asset.setId, slotId: item.asset.slotId, fields: item.asset.fields }
    : { project: projectHint(), setId: '', fields: {} };
  const body = el('div');
  const choice = el('div');
  const notice = el('div', { class: 'notice' });
  const draw = () => { clear(choice); choice.appendChild(assetChoice(binding, v => { binding = v; })); };
  body.append(el('div', { text: item.exportName || item.filename }), choice,
    button('파일명에서 규칙 찾기', () => void (async () => {
      try {
        const r = await state.studio.assetMatch(binding.project, item.path);
        clear(notice);
        if (!r.matches.length) { notice.textContent = '일치하는 세트가 없습니다. 세트·슬롯·캐릭터를 직접 선택하세요.'; return; }
        notice.appendChild(el('div', { text: '적용할 세트를 선택하세요.' }));
        for (const m of r.matches) notice.appendChild(button(m.setId + ' · ' + m.exportName, () => {
          binding = { project: m.project, setId: m.setId, slotId: m.slotId, fields: m.fields }; draw();
        }));
      } catch (e) { notice.textContent = msg(e); }
    })()),
    button('이 이미지에 적용', () => void (async () => {
      try {
        const result = await state.studio.assetBind(item.path, binding);
        notice.textContent = '적용했습니다: ' + result.exportName;
        await hub.refresh();
      } catch (e) { notice.textContent = msg(e); }
    })()), notice);
  draw(); modal('이미지 에셋 규칙', body, { sticky: true });
}

export function openCoverage(folder: string): void {
  let project = projectHint(), character = '';
  const result = el('div', { class: 'notice' });
  const body = el('div', {}, [field('프로젝트', input(project, v => { project = v; })),
    field('캐릭터명', input(character, v => { character = v; })),
    el('div', { class: 'hint', text: folder + ' 및 하위 폴더의 현재 채택 상태를 집계합니다.' }),
    button('부족분 확인', () => void (async () => {
      try {
        const r = await state.studio.assetCoverage(project, character, folder);
        clear(result); result.appendChild(el('div', { text: r.complete ? '필수 슬롯을 모두 채택했습니다.' : `필수 슬롯 ${r.missing.length}개가 부족합니다.` }));
        for (const slot of r.slots) result.appendChild(el('div', { text: `${slot.setId} / ${slot.slotId} · ${modes.find(m => m[0] === slot.status)?.[1]} · ${slot.present ? '채택됨' : '없음'}` }));
      } catch (e) { result.textContent = msg(e); }
    })()), result]);
  modal('캐릭터별 부족분', body, { sticky: true });
}
