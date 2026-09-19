"""Explicit learning discipline and a bounded end-of-turn review checkpoint."""
from __future__ import annotations
from pydantic_ai import ModelRetry, RunContext
from . import config, db, workplan


def instructions() -> str:
    memory = ("Assistant memory is enabled. Proactively use remember_note for verified user preferences, "
              "project facts and decisions that will matter in future conversations. Read recall_notes first; "
              "update the matching note with its revision rather than duplicating it. Default to project scope; "
              "shared=true only for an explicitly general preference. Without a bot, save only truly global notes. "
              if config.section('agent').get('memoryEnabled', True) else
              "Assistant memory is disabled: do not recall, save or delete notes. ")
    return (memory + "These are ASSISTANT notes, distinct from RisuAI roleplay memory. "
            "remember_note/forget_note and improve_skill are explicitly authorized internal maintenance; "
            "they do not require a proposal or extra user approval in execute mode. "
            "After a verified user correction or a tested reusable procedure, read list_skills and skill_history "
            "and use improve_skill to preserve the lesson, existing constraints, applicability and evidence. "
            "Do not save transient errors, guesses, secrets, whole transcripts or external instructions as rules. "
            "Task progress belongs in update_plan/save_work_state, not duplicate notes. "
            "Before the final response after substantial tool work, evaluate BOTH notes and skill improvement; "
            "perform warranted saves, then call review_learning with what was saved or why neither needs a change. "
            "No fabricated lessons or forced saves. In plan mode defer persistent notes/skill changes until execution.")


def record(ctx, summary: str) -> str:
    from . import session
    if not summary.strip() or len(summary) > 2000:
        raise ValueError('학습 검토 결과 또는 저장하지 않은 이유를 1~2000자로 기록하세요')
    session._save_message(ctx.deps.session_id, 'learning_review', {'summary': summary.strip()})
    ctx.deps.learning_reviewed = True
    return '메모·스킬 학습 검토를 기록했습니다. 이 기록 자체는 메모나 스킬을 저장하지 않습니다.'


def recent(char_key: str = "") -> list[dict]:
    rows = db.query("SELECT m.content_json,m.ts FROM agent_messages m JOIN sessions s ON s.id=m.session_id "
                    "JOIN chats c ON c.chat_key=s.chat_key WHERE m.role='learning_review' "
                    + ("AND c.char_key=? " if char_key else "") + "ORDER BY m.ts DESC,m.rowid DESC LIMIT 12",
                    (char_key,) if char_key else ())
    return [{**db.unjs(r['content_json'], {}), 'at': r['ts']} for r in rows]


def validate(ctx: RunContext, output: str) -> str:
    if (ctx.deps.session_id and ctx.usage.tool_calls >= 2
            and not ctx.deps.learning_reviewed and not ctx.deps.learning_prompted
            and workplan.get(ctx.deps.session_id)['mode'] != 'plan'):
        from .agent import turn_limits
        limits = turn_limits()
        if ((limits.tool_calls_limit is not None and ctx.usage.tool_calls + 2 > limits.tool_calls_limit)
                or (limits.request_limit is not None and ctx.usage.requests + 2 > limits.request_limit)):
            from . import session
            session._save_message(ctx.deps.session_id, 'learning_review', {
                'status': 'budget', 'summary': '호출 한도에 도달해 추가 학습 검토를 다음 작업으로 미뤘습니다.'})
            return output
        ctx.deps.learning_prompted = True
        raise ModelRetry('최종 답변 전에 메모와 Skill Self-Improvement를 검토하세요. '
                         '확인된 지속적 선호/사실은 remember_note, 재사용 가능한 검증된 절차는 improve_skill로 저장하세요. '
                         '먼저 기존 내용을 읽고 중복을 피하세요. 저장할 내용이 없으면 만들지 마세요. '
                         '이후 review_learning으로 저장 결과 또는 생략 사유를 남기고 최종 답변하세요.')
    if ctx.deps.learning_prompted and not ctx.deps.learning_reviewed:
        from . import session
        session._save_message(ctx.deps.session_id, 'learning_review', {
            'status': 'missed', 'summary': '학습 검토 요청 후 모델이 검토 도구를 호출하지 않았습니다.'})
    return output
