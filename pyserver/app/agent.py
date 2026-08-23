"""The editing agent.

Two rules shape every tool here.

**The agent never writes to the transcript.** Mutating tools stage proposals;
a person approves them and only then are they applied. That is why `stage_*`
returns "staged, awaiting approval" rather than "done" - the model has to be
able to tell the user the truth about what happened.

**The agent does not get the chat in its context.** A real chat is 394 turns
and megabytes of prose. Tools give it structure - a list, a search, a range -
so it can work on a 400-turn chat without ever holding one. `list_turns`
returns first lines, not bodies, on purpose.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider

from . import (actions, config, files, log, presets, pyexec, skills, snapshots,
               staging, store, websearch, workspace)
from . import memory as mem

INSTRUCTIONS = """\
너는 RisuAI 롤플레이 채팅 로그를 사후 편집하는 도구다.
**한국어 존댓말(~합니다 / ~해 주세요)로 답한다.** 사용자에게 평서형 종결(~한다)이나 반말을 쓰지 마라.

원칙:
- **대화 전체를 읽으려 하지 마라.** 400턴짜리 챗이 흔하다. list_turns 로 훑고,
  search_turns 로 좁히고, read_turns 로 필요한 범위만 읽어라.
- **네가 직접 고칠 수는 없다.** 전사 수정은 stage_edit / stage_bulk / stage_delete,
  그 밖의 변경(로어북·장기기억·스냅샷·RisuAI 반영·복사본 저장)은 propose_* 툴로
  제안하면 사용자가 확인하고 승인해야 실행된다.
  제안한 뒤에는 "제안했습니다, 승인이 필요합니다"라고 정확히 말해라. "고쳤습니다"라고 하지 마라.
- 전사 수정(stage_*)은 **제안 자체가 확인 절차다.** 사용자가 고쳐 달라고 했으면
  되묻지 말고 바로 제안해라. 다만 무엇을 왜 바꾸는지는 항상 함께 설명해라.
- **propose_* 는 다르다.** 로어북·장기기억·스냅샷 되돌리기·RisuAI 반영·복사본 저장은
  되돌리기 어렵거나 RisuAI 원본을 건드린다. **제안하기 전에 무엇을 왜 하는지 말하고
  사용자 동의를 받아라.** 승인 버튼은 확인이지 설명이 아니다.
  채팅으로 동의를 구할 때는 **"승인"이라는 말을 쓰지 마라** — "승인"은 패널의 버튼이고,
  아직 제안한 게 없으면 버튼도 없다. "이대로 진행할까요?"처럼 물어라.
- **승인은 패널에서 이뤄지고 너는 그 결과를 이번 턴에 알 수 없다.** "승인해 주시면
  이어서 제안하겠습니다"라고 하고 멈추지 마라 — 사용자가 버튼을 눌러도 너는 깨어나지
  않는다. 함께 가는 제안(예: 로어북 추가와 그 턴들의 삭제)은 **한 턴에 모두 제안**하고,
  "패널에서 승인·거절하신 뒤 이어서 말씀해 주세요"라고 끝내라. 다음 턴에 list_proposals ·
  list_staged · list_lore 로 무엇이 반영됐는지 확인하고 이어가라.
- 규칙적인 치환은 run_python 으로 직접 훑는 편이 정확할 때가 많다.
  `import risuelf` 헬퍼가 준비돼 있다.
- 원문을 인용할 때는 read_turns 로 실제로 읽은 것만 인용해라. 기억으로 지어내지 마라.
- 무엇을 왜 바꾸려는지 짧게 설명하고, 애매하면 먼저 물어라.

작업 폴더 규칙 (반드시 지켜라 — 패널이 이 규칙대로 정리한다):
- `scratch/` 임시 파일. 중간 산출물, 계산 결과, 버려도 되는 것 전부 여기.
- `out/` 사용자가 내려받을 결과물(md·html·json). 완성된 것만 여기.
  여기 넣으면 대화창에 내려받기 버튼이 뜬다. 결과물을 만들었으면 반드시 여기 저장하고,
  "out/ 에 저장했습니다, 대화창에서 내려받으실 수 있습니다"라고 알려라.
- `uploads/` 사용자가 올린 참고 파일. **읽기 전용이다. 쓰지 마라.**
- 워크스페이스 밖에는 읽기도 쓰기도 할 수 없다. 다른 봇의 데이터도 볼 수 없다.
- 파일을 만들기 전에 list_files 로 이미 있는지 확인해라. 같은 이름을 덮어쓰지 마라.
"""


@dataclass
class Deps:
    chat_key: str
    char_key: str
    session_id: str | None
    workspace_dir: Path


def _model() -> OpenAIChatModel:
    cfg = config.section("agent")
    base = (cfg.get("baseUrl") or "").rstrip("/")
    key = cfg.get("apiKey") or ""
    name = cfg.get("model") or ""
    if not (base and key and name):
        raise RuntimeError("에이전트 자격증명이 설정되지 않았습니다 (설정 탭에서 baseUrl/apiKey/model)")
    # Everything is addressed as an OpenAI-compatible endpoint; a gateway is
    # what normalises the providers behind it. Same reasoning as active-recall's
    # llm.py - portability lives at the gateway, not in our code.
    return OpenAIChatModel(name, provider=OpenAIProvider(base_url=base, api_key=key))


def build() -> Agent[Deps]:
    # The user's own procedures are appended rather than mixed in, so the rules
    # above them stay the rules: a skill describes how to do a job, it does not
    # get to revoke "never write to the transcript".
    agent = Agent(
        _model(),
        deps_type=Deps,
        # Order is the point: built-in rules, then the user's base instructions,
        # then the skills. Later text can shape how the work is done; it never
        # gets to sit above "the agent never writes to the transcript".
        instructions=INSTRUCTIONS + presets.instructions() + skills.prompt(),
        model_settings=presets.model_settings(),
    )

    # --- reading ------------------------------------------------------------

    @agent.tool
    def list_turns(ctx: RunContext[Deps], start: int = 0, count: int = 60) -> str:
        """턴 목록을 훑는다. 본문 대신 첫 줄만 준다.

        전체를 컨텍스트에 올리지 않고 구조를 파악하기 위한 1차 관문이다.
        """
        data = store.turns(ctx.deps.chat_key, start=start, limit=max(1, min(400, count)))
        lines = [f"총 {data['total']}턴, {data['start']}부터 {data['count']}개"]
        for t in data["turns"]:
            head = (t["body"] or "").split("\n", 1)[0][:90]
            mark = " *수정됨*" if t["changed"] else ""
            lines.append(f"#{t['seq']} [{t['role']}] ({len(t['body'])}자){mark} {head}")
        return "\n".join(lines)

    @agent.tool
    def read_turns(ctx: RunContext[Deps], start: int, end: int) -> str:
        """턴 본문을 범위로 읽는다 (start~end, 양끝 포함)."""
        if end < start:
            return "end 가 start 보다 작습니다"
        span = min(end - start + 1, 40)
        data = store.turns(ctx.deps.chat_key, start=start, limit=span)
        out = []
        for t in data["turns"]:
            out.append(f"--- #{t['seq']} [{t['role']}] msgId={t['msgId']}\n{t['body']}")
        if end - start + 1 > span:
            out.append(f"(한 번에 {span}턴까지만 읽습니다. 나머지는 다시 호출해 주세요)")
        return "\n\n".join(out) or "해당 범위에 턴이 없습니다"

    @agent.tool
    def search_turns(ctx: RunContext[Deps], query: str, limit: int = 30) -> str:
        """이 봇의 챗에서 문자열을 찾는다. 어느 턴을 읽을지 좁히는 용도."""
        hits = store.search(ctx.deps.char_key, query, [ctx.deps.chat_key], limit=limit)
        if not hits:
            return f"'{query}' 로 찾은 턴이 없습니다. (찾지 못한 것이지, 없다는 뜻은 아닙니다)"
        return "\n".join(
            f"#{h['seq']} [{h['role']}] msgId={h['msgId']} … {h['excerpt']}" for h in hits
        )

    @agent.tool
    def read_card(ctx: RunContext[Deps]) -> str:
        """봇 카드 원본(설정·첫인사 등). 참고용이며 편집 대상이 아니다."""
        path = workspace.root(ctx.deps.char_key) / "card.md"
        try:
            return path.read_text(encoding="utf-8")[:20000]
        except OSError:
            return "카드 정보를 읽지 못했습니다"

    @agent.tool
    def read_lore(ctx: RunContext[Deps]) -> str:
        """로어북 항목들."""
        entries = store.lore(ctx.deps.char_key)
        if not entries:
            return "로어북 항목이 없습니다"
        return json.dumps(entries, ensure_ascii=False, indent=2)[:20000]

    @agent.tool
    def list_skills(ctx: RunContext[Deps]) -> str:
        """등록된 스킬 목록(이름과 언제 쓰는지). 본문은 load_skill 로 불러온다."""
        lines = skills.catalog_lines()
        return "\n".join(lines) if lines else "등록된 스킬이 없습니다"

    @agent.tool
    def load_skill(ctx: RunContext[Deps], name: str) -> str:
        """스킬 본문을 불러온다. 해당하는 작업을 시작하기 전에 부른다.

        돌아온 절차를 그대로 따른다. 스킬 폴더의 파일은 `skills/<id>/…` 에 있어
        read_file 로 읽고 run_python 으로 실행할 수 있다.
        """
        return skills.load(name)

    @agent.tool
    def read_memory(ctx: RunContext[Deps]) -> str:
        """장기기억(하이파/수파 요약)과 챗 변수(scriptstate) 목록과 본문.

        챗 변수는 `[scriptstate] key=값` 으로 나온다. 값 수정은 propose_memory_edit 로
        제안한다(id 로 조준). `$` 로 시작하는 키가 {{getvar}} 가 읽는 변수다.
        """
        data = mem.listing(ctx.deps.chat_key)
        if not data["items"]:
            return "장기기억이 없습니다"
        out = [f"총 {len(data['items'])}개, 수정됨 {data['changed']}개"]
        for i in data["items"]:
            mark = " *수정됨*" if i["changed"] else (" *추가됨*" if i["isNew"] else "")
            if i["kind"] == mem.VARS:
                out.append(f"--- [scriptstate] id={i['id']}{mark} {i['title']} = {i['body']!r} ({i.get('valueType') or 'string'})")
            else:
                out.append(f"--- [{i['kind']} #{i['seq']}] id={i['id']}{mark}\n{i['body']}")
        return "\n\n".join(out)[:30000]

    def _propose(ctx: RunContext[Deps], kind: str, summary: str, args: dict) -> str:
        try:
            out = actions.propose(
                kind, chat_key=ctx.deps.chat_key, char_key=ctx.deps.char_key,
                summary=summary, args=args, session_id=ctx.deps.session_id)
        except actions.ActionError as e:
            return str(e)
        return f"제안했습니다 (id={out['id']}): {summary}. 사용자가 승인해야 실행됩니다."

    @agent.tool
    def propose_memory_edit(ctx: RunContext[Deps], memory_id: str, new_body: str,
                            reason: str) -> str:
        """장기기억 한 항목을 고치자고 제안한다. 승인 후에 반영된다."""
        cur = mem.get(memory_id)
        if cur is None:
            return "없는 항목입니다"
        return _propose(ctx, "memory_edit",
                        f"장기기억 [{cur['kind']} #{cur['seq']}] 수정 — {reason}",
                        {"id": memory_id, "body": new_body})

    @agent.tool
    def propose_memory_delete(ctx: RunContext[Deps], memory_id: str, reason: str) -> str:
        """장기기억 항목 삭제를 제안한다."""
        cur = mem.get(memory_id)
        if cur is None:
            return "없는 항목입니다"
        return _propose(ctx, "memory_delete",
                        f"장기기억 [{cur['kind']} #{cur['seq']}] 삭제 — {reason}",
                        {"id": memory_id})

    @agent.tool
    def list_lore(ctx: RunContext[Deps], scope: str = "") -> str:
        """로어북 항목 목록. scope 는 global 또는 local."""
        entries = store.lore(ctx.deps.char_key, scope or None)
        if not entries:
            return "로어북 항목이 없습니다"
        out = []
        for e in entries:
            entry = e["entry"] or {}
            keys = entry.get("key") or entry.get("keys") or ""
            out.append(f"--- [{e['scope']}] id={e['id']} key={keys}\n"
                       f"{str(entry.get('content') or '')[:1500]}")
        return "\n\n".join(out)[:25000]

    @agent.tool
    def propose_lore_edit(ctx: RunContext[Deps], lore_id: str, content: str,
                          reason: str, keys: str = "", comment: str = "") -> str:
        """로어북 항목 수정을 제안한다. keys·comment 는 비우면 그대로 둔다."""
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        entry = dict(cur["entry"] or {})
        entry["content"] = content
        if keys:
            entry["key"] = keys
        if comment:
            entry["comment"] = comment
        label = entry.get("comment") or entry.get("key") or lore_id
        return _propose(ctx, "lore_edit", f"로어북 “{label}” 수정 — {reason}",
                        {"id": lore_id, "entry": entry})

    @agent.tool
    def propose_lore_add(ctx: RunContext[Deps], comment: str, keys: str,
                         content: str, reason: str) -> str:
        """이 챗의 로어북에 항목 추가를 제안한다.

        봇 전체 로어북(globalLore)은 건드리지 않는다. 이 챗에서 한 요약을 봇 전체에
        얹으면 그 봇의 다른 챗까지 바뀌기 때문이다.
        """
        entry = {"key": keys, "comment": comment, "content": content,
                 "alwaysActive": False, "insertorder": 100}
        return _propose(ctx, "lore_add", f"로어북 “{comment}” 추가 — {reason}",
                        {"entry": entry, "scope": "local"})

    @agent.tool
    def propose_lore_delete(ctx: RunContext[Deps], lore_id: str, reason: str) -> str:
        """로어북 항목 삭제를 제안한다."""
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        label = (cur["entry"] or {}).get("comment") or lore_id
        return _propose(ctx, "lore_delete", f"로어북 “{label}” 삭제 — {reason}",
                        {"id": lore_id})

    # --- the jobs the panel can do, so the agent can too ---------------------

    @agent.tool
    def list_snapshots(ctx: RunContext[Deps]) -> str:
        """저장된 스냅샷 목록. 되돌릴 지점을 고르기 위한 것."""
        rows = snapshots.listing(ctx.deps.chat_key)
        if not rows:
            return "스냅샷이 없습니다"
        return "\n".join(
            f"id={r['id']} {r['label'] or '(이름 없음)'} · {r['message_count']}턴" for r in rows)

    @agent.tool
    def propose_snapshot(ctx: RunContext[Deps], label: str) -> str:
        """지금 상태를 스냅샷으로 저장하자고 제안한다.

        되돌릴 수 있는 지점을 만드는 일이라 위험하지 않지만, 큰 작업 전에
        사용자가 알고 있어야 할 일이기도 하다.
        """
        return _propose(ctx, "checkpoint_create", f"스냅샷 저장 — {label}", {"label": label})

    @agent.tool
    def propose_restore(ctx: RunContext[Deps], snapshot_id: str, reason: str) -> str:
        """스냅샷으로 되돌리자고 제안한다. 지금 작업본을 통째로 덮어쓴다."""
        return _propose(ctx, "checkpoint_restore",
                        f"스냅샷 {snapshot_id} 로 되돌리기 — {reason} (현재 작업본을 덮어씁니다)",
                        {"id": snapshot_id})

    @agent.tool
    def propose_writeback(ctx: RunContext[Deps], reason: str) -> str:
        """지금까지의 수정을 RisuAI 챗에 실제로 쓰자고 제안한다.

        이것만은 백엔드가 할 수 없다 — RisuAI에 쓰는 API는 플러그인 안에만 있다.
        승인하면 플러그인이 대신 수행한다.
        """
        return _propose(ctx, "host_writeback", f"RisuAI에 반영 — {reason}", {})

    @agent.tool
    def propose_save_copy(ctx: RunContext[Deps], name: str, reason: str) -> str:
        """지금 상태를 RisuAI에 새 챗 복사본으로 저장하자고 제안한다.

        원본을 건드리지 않고 결과를 남기는 방법이라, 큰 수정 전에 권할 만하다.
        """
        return _propose(ctx, "host_save_copy", f"복사본 저장 “{name}” — {reason}",
                        {"name": name})

    @agent.tool
    def list_proposals(ctx: RunContext[Deps]) -> str:
        """아직 승인되지 않은 제안 목록(전사 수정 제외)."""
        rows = actions.pending(ctx.deps.chat_key)
        if not rows:
            return "대기 중인 제안이 없습니다"
        return "\n".join(f"id={r['id']} [{r['kind']}] {r['summary']}" for r in rows)

    # --- proposing (never applied directly) ---------------------------------

    @agent.tool
    def stage_edit(ctx: RunContext[Deps], msg_id: str, new_body: str, reason: str) -> str:
        """턴 하나의 수정을 제안한다. 승인 전까지 반영되지 않는다."""
        cur = store.turn_by_msg(ctx.deps.chat_key, msg_id)
        if cur is None:
            return f"그런 턴이 없습니다: {msg_id}"
        if str(cur["body"]) == new_body:
            return "내용이 같아서 제안하지 않았습니다"
        staging.stage(
            ctx.deps.chat_key, "edit", session_id=ctx.deps.session_id,
            msg_id=msg_id, before=str(cur["body"]), after=new_body,
            reason=reason, seq=int(cur["seq"]),
        )
        return f"#{cur['seq']} 수정을 제안했습니다. 승인하셔야 반영됩니다."

    @agent.tool
    def stage_bulk(ctx: RunContext[Deps], edits: list[dict], reason: str) -> str:
        """여러 턴의 수정을 한 묶음으로 제안한다.

        edits: [{"msg_id": "...", "new_body": "..."}, ...]
        한 묶음은 통째로 승인되고 통째로 적용된다.
        """
        items = []
        skipped = 0
        for e in edits:
            mid = str(e.get("msg_id") or e.get("msgId") or "")
            body = e.get("new_body")
            cur = store.turn_by_msg(ctx.deps.chat_key, mid) if mid else None
            if cur is None or body is None or str(cur["body"]) == body:
                skipped += 1
                continue
            items.append({"op": "edit", "msgId": mid, "before": str(cur["body"]),
                          "after": str(body), "seq": int(cur["seq"])})
        if not items:
            return "제안할 수정이 없습니다 (내용이 같거나 턴을 찾지 못했습니다)"
        out = staging.stage_many(ctx.deps.chat_key, items,
                                 session_id=ctx.deps.session_id, reason=reason)
        note = f" ({skipped}건은 건너뜀)" if skipped else ""
        return f"{out['staged']}개 턴 수정을 한 묶음으로 제안했습니다{note}. 승인하셔야 반영됩니다."

    @agent.tool
    def stage_delete(ctx: RunContext[Deps], msg_ids: list[str], reason: str) -> str:
        """턴 삭제를 제안한다. 승인 전까지 지워지지 않는다."""
        items = []
        for mid in msg_ids:
            cur = store.turn_by_msg(ctx.deps.chat_key, str(mid))
            if cur is not None:
                items.append({"op": "delete", "msgId": str(mid),
                              "before": str(cur["body"]), "seq": int(cur["seq"])})
        if not items:
            return "삭제할 턴을 찾지 못했습니다"
        out = staging.stage_many(ctx.deps.chat_key, items,
                                 session_id=ctx.deps.session_id, reason=reason)
        return f"{out['staged']}개 턴 삭제를 제안했습니다. 승인하셔야 반영됩니다."

    @agent.tool
    def list_staged(ctx: RunContext[Deps]) -> str:
        """지금 승인 대기 중인 제안 목록."""
        items = staging.pending(ctx.deps.chat_key)
        if not items:
            return "대기 중인 제안이 없습니다"
        return "\n".join(
            f"[{i['op']}] #{i['seq']} {i['reason']}" for i in items
        )

    # --- scripting ----------------------------------------------------------

    @agent.tool
    def run_python(ctx: RunContext[Deps], code: str) -> str:
        """워크스페이스에서 파이썬을 실행한다. stdout/stderr 를 돌려준다.

        규칙적인 치환이나 통계는 이쪽이 정확하다.
        """ + "\n\n" + pyexec.describe_helper()
        r = pyexec.run(code, workspace.root(ctx.deps.char_key), ctx.deps.chat_key,
                       ctx.deps.char_key, session_id=ctx.deps.session_id)
        parts = []
        if r.get("staged"):
            parts.append(f"{r['staged']}건을 제안으로 등록했습니다. 승인하셔야 반영됩니다.")
        if r.get("stdout"):
            parts.append("stdout:\n" + r["stdout"])
        if r.get("stderr"):
            parts.append("stderr:\n" + r["stderr"])
        if r.get("error"):
            parts.append("error: " + r["error"])
        if r.get("truncated"):
            parts.append("(출력이 잘렸다)")
        return "\n\n".join(parts) or f"(출력 없음, exit={r.get('exitCode')})"

    @agent.tool
    def write_file(ctx: RunContext[Deps], name: str, content: str) -> str:
        """산출물을 out/ 에 쓴다. md·html 등 사용자가 내려받을 완성품만."""
        path = workspace.write_out(ctx.deps.char_key, name, content)
        return f"{path} 에 {len(content)}자를 썼습니다"

    @agent.tool
    def list_files(ctx: RunContext[Deps], directory: str = "") -> str:
        """워크스페이스의 파일 목록. 비워 두면 최상위."""
        try:
            return files.agent_list(ctx.deps.char_key, directory)
        except files.FileError as e:
            return str(e)

    @agent.tool
    def read_file(ctx: RunContext[Deps], path: str) -> str:
        """워크스페이스 안의 파일을 읽는다. uploads/ 의 참고 자료도 여기로."""
        try:
            return files.agent_read(ctx.deps.char_key, path)
        except files.FileError as e:
            return str(e)

    # --- outside world ------------------------------------------------------

    if websearch.configured():
        @agent.tool
        def web_search(ctx: RunContext[Deps], query: str) -> str:
            """웹 검색. 원작 설정 확인 등 외부 사실이 필요할 때만."""
            return websearch.search(query)

    return agent
