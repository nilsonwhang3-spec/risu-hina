"""Durable, revisioned plan documents and task progress for one assistant session."""
from __future__ import annotations

import json
from pydantic_ai.capabilities import AbstractCapability
from . import db

MARKER = "[현재 작업 계획 — 최신 사용자 지시가 우선]"
# Explicit allowlist: new tools cannot silently bypass planning mode.
PLAN_TOOLS = frozenset("""read_plan update_plan recall_work save_work_state read_tool_result
recall_notes compact_context list_turns read_turns search_turns bot_structure search_bot
read_card read_card_field list_scripts read_script read_script_text read_lore read_lore_entry
list_lore list_skills load_skill skill_history work_status read_memory list_bot_snapshots
list_assets list_snapshots list_proposals list_staged list_files read_file find_files search_files
web_search view_image compare_images image_metrics studio_job studio_naming studio_recipe""".split())


def get(session_id: str) -> dict:
    row = db.one("SELECT content_json FROM agent_messages WHERE session_id=? AND role='plan' ORDER BY seq DESC LIMIT 1", (session_id,))
    return db.unjs(row['content_json']) if row else {
        "revision": 0, "mode": "execute", "document": "", "tasks": []}


def save(session_id: str, revision: int, *, document=None, tasks=None, mode=None) -> dict:
    from . import session
    with db.transaction():
        if not db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
            raise ValueError("작업 중인 대화가 없습니다")
        current = get(session_id)
        if revision != current['revision']:
            raise ValueError("계획이 변경되었습니다. read_plan으로 최신 revision을 읽고 다시 수정하세요")
        result = dict(current)
        if mode is not None:
            if mode not in ('plan', 'execute'):
                raise ValueError("mode는 plan 또는 execute여야 합니다")
            result['mode'] = mode
        if document is not None:
            if not isinstance(document, str) or len(document) > 10000:
                raise ValueError("계획 문서는 10000자 이하여야 합니다")
            result['document'] = document
        if tasks is not None:
            if not isinstance(tasks, list) or len(tasks) > 40:
                raise ValueError("Todo는 40개 이하여야 합니다")
            clean, ids = [], set()
            for task in tasks:
                if not isinstance(task, dict):
                    raise ValueError("Todo 형식을 확인하세요")
                item = {k: str(task.get(k, '')).strip() for k in ('id', 'title', 'status', 'evidence')}
                if not item['id'] or item['id'] in ids or len(item['id']) > 80:
                    raise ValueError("Todo에는 중복 없는 짧은 id가 필요합니다")
                if not item['title'] or len(item['title']) > 300 or len(item['evidence']) > 600:
                    raise ValueError("Todo 제목은 1~300자, 근거는 600자 이하여야 합니다")
                if item['status'] not in ('pending', 'in_progress', 'blocked', 'completed'):
                    raise ValueError("Todo 상태는 pending/in_progress/blocked/completed입니다")
                if item['status'] in ('completed', 'blocked') and not item['evidence']:
                    raise ValueError("완료 근거 또는 차단 사유가 필요합니다")
                ids.add(item['id']); clean.append(item)
            if sum(t['status'] == 'in_progress' for t in clean) > 1:
                raise ValueError("진행 중인 Todo는 하나만 지정하세요")
            result['tasks'] = clean
        if len(json.dumps(result, ensure_ascii=False)) > 18000:
            raise ValueError("계획과 Todo의 합계는 18000자 이하여야 합니다")
        result['revision'] += 1
        session._save_message(session_id, 'plan', result)
    if session_id in session._ACTIVE:
        session.push_stream_event(session_id, {"type": "plan", "plan": result})
    return result


def prompt(session_id: str) -> str:
    plan = get(session_id)
    if not plan["revision"]:
        return ""
    return MARKER + "\n" + json.dumps(plan, ensure_ascii=False) + (
        "\n계획 모드: 조사와 계획/Todo 기록만 가능. 실행은 사용자가 실행 모드로 전환한 뒤 진행하세요."
        if plan['mode'] == 'plan' else
        "\n실행 모드: 사용자가 요청한 계획의 기록입니다. 현재 사용자 지시가 우선하며, 진행 상황이 바뀌면 갱신하세요.")


class PlanGuard(AbstractCapability):
    async def wrap_tool_execute(self, ctx, *, call, tool_def, args, handler):
        if get(ctx.deps.session_id or '')['mode'] == 'plan' and tool_def.name not in PLAN_TOOLS:
            return "계획 모드에서는 이 실행 도구를 사용할 수 없습니다. 조사와 update_plan으로 계획을 작성하세요. 실행 전환은 사용자만 할 수 있습니다."
        return await handler(args)
