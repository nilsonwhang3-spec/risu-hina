"""A user-requested card save, executed and verified by the connected plugin."""
import asyncio
import time

from . import actions, db, session


async def save_card(session_id: str, char_key: str, chat_key: str, reason: str,
                    timeout: float = 300) -> dict:
    if not session_id or not char_key or not db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
        return {"status": "failed", "error": "연결된 봇 작업 대화에서 요청해 주세요."}
    existing = db.one("SELECT id FROM pending_actions WHERE char_key=? "
                      "AND kind='host_card_writeback' AND status='approved' ORDER BY created_at DESC LIMIT 1",
                      (char_key,))
    if existing:
        return {"id": existing["id"], "status": "approved", "message": "이미 저장 중입니다. 결과를 확인하세요."}
    action = actions.propose("host_card_writeback", session_id=session_id, char_key=char_key,
                             chat_key=chat_key, summary="사용자 요청으로 RisuAI에 반영 — " + reason,
                             args={"userRequested": True})
    session.push_stream_event(session_id, {"type": "card-writeback", "id": action["id"],
                                          "charKey": char_key, "chatKey": chat_key})
    deadline = time.monotonic() + timeout
    start_deadline = min(deadline, time.monotonic() + 15)
    while True:
        current = actions.get(action["id"])
        if not current or current["status"] in (actions.DONE, actions.FAILED, actions.REJECTED):
            return {"id": action["id"], "status": current["status"] if current else "failed",
                    "result": current["result"] if current else "작업을 찾을 수 없습니다."}
        expired = time.monotonic() >= (start_deadline if current["status"] == actions.PENDING else deadline)
        if session.stopped(session_id) or expired:
            if current["status"] == actions.PENDING:
                actions.decide(action["id"], False)
                return {"id": action["id"], "status": "rejected", "result": "플러그인에서 저장이 시작되지 않아 요청을 취소했습니다. 연결 상태를 확인하세요."}
            return {"id": action["id"], "status": current["status"],
                    "result": "저장은 시작됐지만 완료 확인 대기를 마쳤습니다. list_proposals로 결과를 확인하고 중복 실행하지 마세요."}
        await asyncio.sleep(.2)
