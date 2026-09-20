"""Session handoff derived from durable evidence, appended after cached history."""
from __future__ import annotations

import json
from . import agentnotes, db

STATE_MARKER = "[작업 인계 데이터 — 현재 사용자 지시가 우선]"
RECOVERY_MARKER = "[이전 사용자 지시 복원 — 원문, 뒤의 최신 지시가 우선]"
_ACKS = {"계속", "계속해", "계속해줘", "계속해 줘", "ㅇㅇ", "네", "응", "진행해줘"}


def recall(session_id: str, query: str = "", offset: int = 0, count: int = 8, text_offset: int = 0) -> dict:
    count = max(1, min(20, count)); offset = max(0, offset)
    text_offset = max(0, text_offset)
    rows = db.query("SELECT seq,role,content_json,ts FROM agent_messages WHERE session_id=? "
                    "AND role IN ('user','assistant','work_state','checkpoint') ORDER BY seq DESC", (session_id,))
    found = [r for r in rows if query.casefold() in str(db.unjs(r['content_json'], '')).casefold()]
    page = found[offset:offset + count]
    return {"total": len(found), "nextOffset": offset + len(page) if offset + len(page) < len(found) else None,
            "records": [{"seq": r['seq'], "role": r['role'], "at": r['ts'],
                         "text": str(db.unjs(r['content_json'], ''))[text_offset:text_offset + 4000],
                         "nextTextOffset": text_offset + 4000 if len(str(db.unjs(r['content_json'], ''))) > text_offset + 4000 else None} for r in page]}


def save(session_id: str, goal: str, completed: list[str], pending: list[str], next_step: str, evidence: str) -> dict:
    from . import session
    if not session_id or not db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
        raise ValueError("작업 중인 대화가 없습니다")
    state = {"goal": goal, "completedReported": completed, "pending": pending,
             "nextStep": next_step, "evidence": evidence}
    if not evidence.strip() or len(json.dumps(state, ensure_ascii=False)) > 10000:
        raise ValueError("확인 근거가 필요하며 작업 상태는 10000자 이하여야 합니다")
    session._save_message(session_id, "work_state", state)
    return state


def build(session_id: str, char_key: str, history: list) -> list[str]:
    """Recover omitted user directives; never infer completion from prose.

    Old history is never rewritten here. Snapshots live in the new request,
    keeping previous request prefixes reusable. No clock is added to prompts.
    """
    visible_parts = [p.content for m in history for p in m.parts
                     if isinstance(getattr(p, 'content', None), str)]
    # JSON escapes newlines/quotes. Decode recovery records before deduping.
    for text in list(visible_parts):
        if text.startswith(RECOVERY_MARKER):
            try:
                records, _ = json.JSONDecoder().raw_decode(text[len(RECOVERY_MARKER):].lstrip())
                visible_parts.extend(r['user'] for r in records)
            except (ValueError, TypeError, KeyError):
                pass
    visible = '\n'.join(visible_parts)
    users = db.query("SELECT seq,content_json FROM agent_messages WHERE session_id=? AND role='user' ORDER BY seq DESC", (session_id,))
    missing, used = [], 0
    # The newest user message is passed separately by session.run.
    for r in users[1:]:
        text = db.unjs(r['content_json'], '')
        if not isinstance(text, str) or text.strip() in _ACKS or text in visible:
            continue
        if used + len(text) > 24000:
            continue
        missing.append({"seq": r['seq'], "user": text}); used += len(text)
    parts = []
    if missing:
        parts.append(RECOVERY_MARKER + '\n' + json.dumps(list(reversed(missing)), ensure_ascii=False)
                     + '\n더 오래된 지시는 recall_work로 검색할 수 있습니다.')
    state_row = db.one("SELECT content_json FROM agent_messages WHERE session_id=? AND role='work_state' ORDER BY seq DESC LIMIT 1", (session_id,))
    last_answer = db.one("SELECT seq,content_json FROM agent_messages WHERE session_id=? AND role='assistant' ORDER BY seq DESC LIMIT 1", (session_id,))
    jobs = []
    for r in db.query("SELECT id,state,payload_json,result_json FROM jobs WHERE kind='studio_generate' "
                      "AND json_extract(payload_json,'$.spec.sessionId')=? ORDER BY created_at DESC LIMIT 8", (session_id,)):
        payload = db.unjs(r['payload_json'], {})
        jobs.append({"id": r['id'], "state": r['state'], "done": payload.get('done'),
                     "total": payload.get('total'), "result": db.unjs(r['result_json'], None),
                     "saved": (payload.get('saved') or [])[-2:]})
    checkpoints = db.query("SELECT content_json FROM agent_messages WHERE session_id=? AND role='checkpoint' ORDER BY seq DESC LIMIT 8", (session_id,))
    events = [db.unjs(r['content_json'], {}) for r in reversed(checkpoints)]
    # The notes block (up to 10K chars) rides every handover; when it is the
    # same text as the previous handover still in the history, a pointer is
    # enough (§1-62). A compaction drops the old handover, so the full block
    # comes back after one.
    notes = agentnotes.prompt(char_key)
    previous = next((p for p in reversed(visible_parts) if p.startswith(STATE_MARKER)), None)
    if previous and json.dumps(notes, ensure_ascii=False) in previous:
        notes = "unchanged since the previous handover above (recall_notes for details)"
    snapshot = {
        "recordedWork": db.unjs(state_row['content_json'], None) if state_row else None,
        "previousAssistantReport": str(db.unjs(last_answer['content_json'], ''))[-3500:] if last_answer else None,
        "actualJobs": jobs,
        "recentToolEvents": [{k: (str(v)[:300] if k == 'result' else v) for k, v in e.items()} for e in events],
        "notes": notes,
    }
    text = (STATE_MARKER + '\n이전 답변/작업 메모는 모델의 보고이고 완료 증명이 아닙니다. '
            'actualJobs는 서버 상태입니다. 파일·채택 상태는 실제 프로젝트에서 확인하세요. '
            '중단된 작업을 무작정 반복하지 말고, 현재 사용자 수정과 남은 작업에서 이어가세요. '
            '필요하면 recall_work로 원문을 확인하고 save_work_state로 목표·완료 보고·미완료·다음 행동을 남기세요.\n'
            + json.dumps(snapshot, ensure_ascii=False, sort_keys=True))
    parts.append(text)
    return parts
