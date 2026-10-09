"""A user-requested host action (card save, new module), executed and verified by the connected plugin.

The tool proposes the action, tells the panel over the turn stream (or the MCP
long poll) to carry it out, and waits for the recorded outcome. The user's own
request is the authorization, so the panel approves it without another click.
"""
import asyncio
import time

from . import actions, db, session

# How long the panel has to START the action. 15s was too short on a flaky
# connection: the backend cancelled the request, the panel's late approval then
# failed with "이미 처리된 작업입니다 (rejected)", and the model was told the
# plugin had a connection problem - for a card RisuAI already held (2026-10-09).
START_S = 60.0


async def run_host(session_id: str, kind: str, char_key: str, chat_key: str, summary: str,
                   args: dict | None = None, timeout: float = 300) -> dict:
    """Propose `kind`, have the panel run it, and wait for its recorded outcome."""
    action = actions.propose(kind, session_id=session_id, char_key=char_key, chat_key=chat_key,
                             summary=summary, args={**(args or {}), "userRequested": True})
    event = "card-writeback" if kind == "host_card_writeback" else "host-run"
    session.push_stream_event(session_id, {"type": event, "id": action["id"], "kind": kind,
                                          "charKey": char_key, "chatKey": chat_key})
    # The write starts after the plugin approves the action; a RisuAI save
    # before that moment says nothing about this write (§1-80).
    approved_at: float | None = None
    deadline = time.monotonic() + timeout
    start_deadline = min(deadline, time.monotonic() + START_S)
    while True:
        current = actions.get(action["id"])
        if not current or current["status"] in (actions.DONE, actions.FAILED, actions.REJECTED):
            out = {"id": action["id"], "status": current["status"] if current else "failed",
                   "result": current["result"] if current else "작업을 찾을 수 없습니다."}
            if current and current["status"] == actions.DONE and kind == "host_card_writeback":
                # "Verified" reads the RisuAI tab's memory; whether the tab's
                # save reached its server is a separate question (§1-80).
                from . import risupersist
                st = await risupersist.wait_saved(approved_at if approved_at is not None else time.time() - 5)
                note = risupersist.describe(st)
                if note:
                    out["risuServerSave"] = note
            return out
        if current["status"] == actions.APPROVED and approved_at is None:
            approved_at = time.time() - 0.5
        expired = time.monotonic() >= (start_deadline if current["status"] == actions.PENDING else deadline)
        if session.stopped(session_id) or expired:
            if current["status"] == actions.PENDING:
                try:
                    actions.decide(action["id"], False)
                except actions.ActionError:
                    continue  # the panel took it at the last moment: read the outcome next round
                return {"id": action["id"], "status": "rejected",
                        "result": f"플러그인이 {int(START_S)}초 안에 시작하지 않아 요청을 취소했습니다 (아무것도 쓰지 않음). "
                                  "패널이 열려 있고 연결됐는지 확인한 뒤 다시 시도하세요."}
            return {"id": action["id"], "status": current["status"],
                    "result": "시작은 됐지만 완료 확인 대기를 마쳤습니다. list_proposals로 결과를 확인하고 중복 실행하지 마세요."}
        await asyncio.sleep(.2)


async def save_card(session_id: str, char_key: str, chat_key: str, reason: str,
                    timeout: float = 300) -> dict:
    if not session_id or not char_key or not db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
        return {"status": "failed", "error": "연결된 봇 작업 대화에서 요청해 주세요."}
    existing = db.one("SELECT id FROM pending_actions WHERE char_key=? "
                      "AND kind='host_card_writeback' AND status='approved' ORDER BY created_at DESC LIMIT 1",
                      (char_key,))
    if existing:
        return {"id": existing["id"], "status": "approved", "message": "이미 저장 중입니다. 결과를 확인하세요."}
    # Nothing unshipped: the card is already what RisuAI holds (often the user
    # pressed 반영 themselves meanwhile). Say so instead of starting a write
    # whose failure would read as "not saved".
    from . import card
    pending = card.changes(char_key)
    if not pending.get("total"):
        return {"status": "done", "nothing": True,
                "result": "반영할 카드 변경이 없습니다 - 작업본이 이미 RisuAI 와 같습니다(이미 반영됨). 다시 저장할 필요가 없습니다."}
    return await run_host(session_id, "host_card_writeback", char_key, chat_key,
                          "사용자 요청으로 RisuAI에 반영 — " + reason, timeout=timeout)
