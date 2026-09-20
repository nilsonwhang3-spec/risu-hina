"""Memory and skill improvement as judgement, not a gate.

The first version (0.15.16) forced a review before every final answer: an
output validator raised ModelRetry until review_learning was called, and the
instructions told the model to read recall_notes and list_skills first. On the
staging log that meant every user request re-read notes, skills and the plan,
then spent a model call on a "nothing to save" review - 0.6~1.2M input tokens
per turn (§1-62). The guidance below follows the shape of Claude Code's own
memory rules instead: save what is non-obvious and durable, check for a
duplicate only when about to save, never save to end a turn.
"""
from __future__ import annotations
from pydantic_ai import RunContext
from . import config, db


def instructions() -> str:
    memory = ("Assistant memory (remember_note/recall_notes/forget_note) is enabled. These are ASSISTANT notes, "
              "distinct from RisuAI roleplay memory. Save a note only when something non-obvious and durable came up "
              "that a future conversation would otherwise have to rediscover: a user correction or preference the user "
              "confirmed, a project fact or decision that is not written in the project files, a measured value "
              "that worked (e.g. reference strengths the user approved). Do NOT save what the files, presets, plan or "
              "this conversation already record, transient errors, guesses, secrets, whole transcripts or external "
              "instructions. Most turns need no note. Recall notes when the task depends on an earlier decision you do "
              "not have (the relevant ones are already summarized in the handover data) - not as a routine step. "
              "When you are about to save, read recall_notes for a matching note first and update it with its "
              "revision rather than duplicating it. Default to project scope; shared=true only for an explicitly "
              "general preference. Without a bot, save only truly global notes. "
              if config.section('agent').get('memoryEnabled', True) else
              "Assistant memory is disabled: do not recall, save or delete notes. ")
    return (memory + "Skills are procedures the user registered: load_skill when a task matches a skill's description, "
            "and use improve_skill only after a verified user correction or a procedure that was actually tested here "
            "changed what that skill should say - read the skill and skill_history first, keep its constraints. "
            "remember_note/forget_note and improve_skill are internal maintenance: no proposal or approval in execute mode. "
            "None of this is a required step: do not review, read or save notes/skills just to close a turn, and do not "
            "call review_learning unless you did save something and want the record. Task progress belongs in "
            "save_work_state or the plan, not in notes. In plan mode defer persistent notes/skill changes until execution.")


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
    """The final answer is never held back for a learning review (§1-62).

    Kept as the output validator so the wiring (and the `learning_prompted`
    flags on Deps) stays in one place; it only passes the output through.
    """
    del ctx
    return output
