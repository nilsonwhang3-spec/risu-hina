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
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider

from . import (actions, assets, codexauth, config, files, log, presets, pyexec, skills, snapshots,
               staging, store, websearch, workspace)
from . import card as cardmod
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
- **봇(카드) 편집도 같은 문법이다.** read_card 로 행을 보고 propose_card_edit /
  propose_greeting_* / propose_regex_* / propose_trigger_* 로 제안한다. 카드는 이 봇의
  **모든 챗**에 영향을 준다 — 챗 하나의 문제를 카드에서 고치려 하지 마라.
  반영(propose_card_writeback)과 복제 봇 생성(propose_clone_bot)은 RisuAI 원본을
  건드리므로 반드시 먼저 동의를 받아라.
- **너는 패널의 두 화면(챗 편집 / 봇 편집) 중 어디가 열려 있는지 안다.** 챗 편집 화면에서는
  챗 재료(턴·장기기억·챗 로어북·챗 스냅샷·챗 반영)만, 봇 편집 화면에서는 카드 재료(메타·인사말·
  봇 로어북·Regex·트리거·에셋·봇 스냅샷·카드 반영)만 고칠 수 있다. 다른 화면의 재료를 고쳐야
  하면 **먼저 "○○ 화면으로 이동하겠습니다"라고 알리고 propose_open_tab 으로 이동을 제안해
  승인을 받은 뒤** 그 다음 턴에 진행해라. 읽기·검색은 어느 화면에서든 된다 — 너는 현재 탭뿐
  아니라 선택된 봇과 챗 전체를 안다.

작업 폴더 규칙 (반드시 지켜라 — 패널이 이 규칙대로 정리한다):
- `scratch/` 임시 파일. 중간 산출물, 계산 결과, 버려도 되는 것 전부 여기.
- `out/` 사용자가 내려받을 결과물(md·html·json). 완성된 것만 여기.
  여기 넣으면 대화창에 내려받기 버튼이 뜬다. 결과물을 만들었으면 반드시 여기 저장하고,
  "out/ 에 저장했습니다, 대화창에서 내려받으실 수 있습니다"라고 알려라.
- `uploads/` 사용자가 올린 참고 파일. **읽기 전용이다. 쓰지 마라.**
- **에셋(이미지)도 다룬다.** list_assets 로 목록을 보고 fetch_assets 로 scratch/ 에 꺼내
  run_python(PIL) 으로 가공한 뒤, 결과 PNG 를 propose_asset_add / propose_asset_replace 로
  제안한다. 승인되면 플러그인이 RisuAI 에 저장하고 카드에 붙인다 — 이것은 반영을 기다리지
  않고 즉시 RisuAI 에 쓰이는 유일한 카드 변경이다(바이너리라 작업본이 없다). PNG 만 된다.
  에셋의 **이름·삭제**는 카드 재료다: list_scripts("assetref") 로 행을 보고 propose_regex_edit 와
  같은 문법(propose_script_delete / entry 교체)으로 고치면 반영 때 한 번에 쓰인다.
  RisuAI 규칙: **같은 이름을 가진 에셋 여러 개 = 랜덤 풀**({{asset::이름}} 호출 때 무작위 1개).
  charx 파일명의 `_1`, `_2` 는 파일명 고유화용일 뿐 이름이 아니다. 이름 끝 `.png` 같은 확장자는
  보통 실수이며(호출은 확장자 없는 이름), 일괄 제거는 카드 도구가 한다.
- 워크스페이스 밖에는 읽기도 쓰기도 할 수 없다. 다른 봇의 데이터도 볼 수 없다.
- 파일을 만들기 전에 list_files 로 이미 있는지 확인해라. 같은 이름을 덮어쓰지 마라.
"""


@dataclass
class Deps:
    chat_key: str
    char_key: str
    session_id: str | None
    workspace_dir: Path
    # Which half of the panel the user is looking at: 'chat' or 'bot' ('' =
    # unknown, older plugin). Chat material is edited from the chat tabs and
    # card material from the bot tabs; a tool for the other half refuses and
    # points at propose_open_tab, so the user is never surprised by a change
    # landing in the half they are not looking at.
    mode: str = ""


# Proposal kinds by the half of the panel they belong to (see Deps.mode).
CHAT_KINDS = frozenset({"memory_edit", "memory_delete", "checkpoint_restore", "checkpoint_create",
                        "host_writeback", "host_save_copy"})
BOT_KINDS = frozenset({"card_edit", "card_greeting_add", "card_greeting_delete", "script_edit",
                       "script_add", "script_delete", "card_checkpoint_create", "card_checkpoint_restore",
                       "host_card_writeback", "host_clone_bot", "host_asset_add", "host_asset_replace"})
_MODE_TAB = {"chat": ("챗 편집", "editor"), "bot": ("봇 편집", "meta")}


def _wrong_half(ctx: "RunContext[Deps]", need: str) -> str | None:
    """A refusal when the tool's material belongs to the other half."""
    mode = ctx.deps.mode
    if not mode or mode == need:
        return None
    label, tab = _MODE_TAB[need]
    return (f"지금 화면은 {'봇 편집' if mode == 'bot' else '챗 편집'}입니다. 이 작업은 {label} 화면의 재료를 고칩니다. "
            f"먼저 사용자에게 {label} 화면으로 이동하겠다고 알리고, propose_open_tab(\"{tab}\", 이유) 로 이동을 "
            f"제안해 승인을 받은 뒤 다시 요청해 주세요. (그 전에는 이 툴이 실행되지 않습니다)")


def _model_for(section: str) -> "OpenAIChatModel | OpenAIResponsesModel":
    """The model a config section describes: an OpenAI-compatible endpoint,
    or the OpenAI subscription through codexauth (Responses API, streaming)."""
    cfg = config.section(section)
    name = cfg.get("model") or ""
    if (cfg.get("provider") or "") == "codex":
        if not name:
            raise RuntimeError("코덱스 프리셋에 모델 이름이 없습니다 (예: gpt-5.1-codex)")
        if not codexauth.logged_in():
            raise RuntimeError("OpenAI 구독 로그인이 필요합니다 (설정 → 에이전트 → 프리셋 수정 → 로그인)")
        return OpenAIResponsesModel(name, provider=OpenAIProvider(openai_client=codexauth.client()))
    base = (cfg.get("baseUrl") or "").rstrip("/")
    key = cfg.get("apiKey") or ""
    if not (base and key and name):
        raise RuntimeError("에이전트 자격증명이 설정되지 않았습니다 (설정 탭에서 baseUrl/apiKey/model)")
    # Everything is addressed as an OpenAI-compatible endpoint; a gateway is
    # what normalises the providers behind it. Same reasoning as active-recall's
    # llm.py - portability lives at the gateway, not in our code.
    return OpenAIChatModel(name, provider=OpenAIProvider(base_url=base, api_key=key))


def _model() -> "OpenAIChatModel | OpenAIResponsesModel":
    return _model_for("agent")


# --- history compaction --------------------------------------------------------

# session_id -> the compacted history used this turn, for session.run to store
# in place of the original (see _compact_history).
COMPACTED: dict[str, list] = {}
KEEP_TAIL = 6


def _msg_chars(m: Any) -> int:
    n = 0
    for p in getattr(m, "parts", []) or []:
        c = getattr(p, "content", None)
        if isinstance(c, str):
            n += len(c)
        elif c is not None:
            n += len(str(c))
        a = getattr(p, "args", None)
        if a is not None:
            n += len(str(a))
    return n


def _msg_text(m: Any) -> str:
    """A message flattened for the summariser: who said what, tool calls by name."""
    who = "사용자" if m.kind == "request" else "에이전트"
    bits = []
    for p in getattr(m, "parts", []) or []:
        kind = getattr(p, "part_kind", "")
        c = getattr(p, "content", None)
        if kind == "user-prompt" and isinstance(c, str):
            bits.append(f"[사용자] {c}")
        elif kind == "text" and isinstance(c, str):
            bits.append(f"[에이전트] {c}")
        elif kind == "tool-call":
            bits.append(f"[툴 호출] {getattr(p, 'tool_name', '')}({str(getattr(p, 'args', ''))[:200]})")
        elif kind == "tool-return":
            bits.append(f"[툴 결과 {getattr(p, 'tool_name', '')}] {str(c)[:300]}")
    return "\n".join(bits) if bits else f"[{who}]"


async def _compact_history(ctx: RunContext[Deps], messages: list) -> list:
    """Keep the conversation inside the model's budget.

    When the stored history grows past `agent.historyBudgetChars`, everything
    but the last KEEP_TAIL messages is summarised by the model into one
    Korean note and replaced by a (summary request, acknowledgement) pair.
    The result is remembered in COMPACTED so session.run stores it - the
    summary is paid for once, not on every later turn.
    """
    budget = int(config.section("agent").get("historyBudgetChars") or 0)
    if budget <= 0 or len(messages) <= KEEP_TAIL + 2:
        return messages
    total = sum(_msg_chars(m) for m in messages)
    if total <= budget:
        return messages
    head, tail = messages[:-KEEP_TAIL], messages[-KEEP_TAIL:]
    # Never cut between a tool call and its return: extend the tail back to a
    # user prompt boundary.
    while head and not any(getattr(p, "part_kind", "") == "user-prompt" for p in getattr(tail[0], "parts", [])):
        tail.insert(0, head.pop())
        if not head:
            return messages
    transcript = "\n\n".join(_msg_text(m) for m in head)[-120000:]
    try:
        summariser = Agent(_model(), instructions=(
            "다음은 편집 도구 안에서 사용자와 에이전트가 나눈 대화 기록이다. 이어서 작업할 수 있도록 "
            "**한국어로 1500자 이내** 요약해라: 사용자가 원한 것, 확정된 결정, 이미 제안·승인된 변경(id 포함), "
            "아직 안 끝난 일, 사용자가 싫어한 것. 인용은 최소한으로."))
        r = await summariser.run(transcript, model_settings={"temperature": 0.1, "max_tokens": 4000})  # type: ignore[arg-type]
        summary = str(r.output).strip()
    except Exception as e:  # noqa: BLE001 - a failed summary must not fail the turn
        log.warn("history compaction failed: %s", e)
        return messages
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
    compacted = [
        ModelRequest(parts=[UserPromptPart(content="[이전 대화 요약 — 앞선 대화는 이 요약으로 대체되었습니다]\n" + summary)]),
        ModelResponse(parts=[TextPart(content="요약을 확인했습니다. 이어서 진행합니다.")]),
    ] + tail
    if ctx.deps.session_id:
        COMPACTED[ctx.deps.session_id] = compacted
    log.info("history compacted session=%s %s msgs/%s chars -> %s msgs", ctx.deps.session_id,
             len(messages), total, len(compacted))
    return compacted


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
        history_processors=[_compact_history],
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
        """봇 카드를 행 단위로 훑는다. 편집 대상이다 — propose_card_edit 로 조준한다.

        본문 대신 첫 줄만 준다. 긴 필드 전체는 read_card_field(id) 로 읽어라.
        """
        data = cardmod.listing(ctx.deps.char_key)
        out = [f"카드 필드 {len(data['fields'])}개, 수정됨 {data['changed']}개"
               + ("" if data["full"] else " (구버전 업로드 — 반영 불가)")]
        for f in data["fields"]:
            mark = " *수정됨*" if f["changed"] else (" *추가됨*" if f["isNew"] else "")
            mark += " *삭제 예정*" if f["deleted"] else ""
            head = (f["body"] or "").split("\n", 1)[0][:100]
            tag = f["field"] + (f"[{f['seq']}]" if f["field"] == "alternateGreetings" else "")
            out.append(f"--- [{tag}] id={f['id']}{mark} ({len(f['body'])}자) {head}")
        return "\n".join(out)[:20000]

    @agent.tool
    def read_card_field(ctx: RunContext[Deps], field_id: str) -> str:
        """카드 필드 하나의 본문 전체."""
        cur = cardmod.get_field(field_id)
        if cur is None:
            return "없는 카드 필드입니다"
        return f"[{cur['field']}#{cur['seq']}]\n{cur['body']}"[:30000]

    @agent.tool
    def list_scripts(ctx: RunContext[Deps], kind: str = "customscript") -> str:
        """Regex(customscript) 또는 트리거(triggerscript) 목록. 요약만 준다.

        본문(치환식·HTML·트리거 정의)은 read_script(id) 로 읽어라 — background HTML
        항목은 수만 자일 수 있어 목록에 싣지 않는다.
        """
        try:
            items = cardmod.scripts(ctx.deps.char_key, kind)
        except ValueError as e:
            return str(e)
        if not items:
            return f"{kind} 항목이 없습니다"
        out = []
        for i in items:
            e = i["entry"] or {}
            size = len(json.dumps(e, ensure_ascii=False))
            mark = "" if i["origin"] == "original" else f" *{i['origin']}*"
            out.append(f"#{i['seq']} id={i['id']}{mark} “{e.get('comment') or '(설명 없음)'}”"
                       f" type={e.get('type') or ''} ({size}자)")
        return "\n".join(out)

    @agent.tool
    def read_script(ctx: RunContext[Deps], script_id: str) -> str:
        """스크립트 항목 하나의 전체 JSON."""
        row = cardmod.script_entry(script_id)
        if row is None:
            return "없는 스크립트 항목입니다"
        return json.dumps(row, ensure_ascii=False, indent=2)[:30000]

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
        need = "chat" if kind in CHAT_KINDS else ("bot" if kind in BOT_KINDS else "")
        if need:
            wrong = _wrong_half(ctx, need)
            if wrong:
                return wrong
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
        """로어북 항목 목록. scope 는 global 또는 local.

        구조가 함께 나온다: `#순번`은 배열 순서(propose_lore_move 로 조정),
        `folder=`는 소속 폴더, `[폴더]` 행은 폴더 자체(항목이 아니라 컨테이너 -
        RisuAI 는 폴더도 mode='folder' 인 로어북 항목으로 저장하고, 소속은
        멤버의 folder 값 == 폴더 항목의 key 값으로 판정한다). 폴더 정리는
        propose_lore_edit 로 멤버의 folder 값을 바꾸면 된다.
        """
        entries = store.lore(ctx.deps.char_key, scope or None)
        if not entries:
            return "로어북 항목이 없습니다"
        # Folder key -> display name, RisuAI's own membership rule.
        names = {}
        for e in entries:
            entry = e["entry"] or {}
            if str(entry.get("mode") or "") == "folder" and entry.get("key"):
                names[str(entry["key"])] = str(entry.get("comment") or "") or "(이름 없는 폴더)"
        out = []
        for e in entries:
            entry = e["entry"] or {}
            if str(entry.get("mode") or "") == "folder":
                out.append(f"--- #{e['seq']} [{e['scope']}] [폴더] id={e['id']} "
                           f"key={entry.get('key')} 이름={entry.get('comment') or '(없음)'}")
                continue
            keys = entry.get("key") or entry.get("keys") or ""
            folder = str(entry.get("folder") or "")
            where = f" folder={names.get(folder, folder)}" if folder else ""
            out.append(f"--- #{e['seq']} [{e['scope']}] id={e['id']} key={keys}{where}\n"
                       f"{str(entry.get('content') or '')[:1500]}")
        return "\n\n".join(out)[:25000]

    @agent.tool
    def propose_lore_move(ctx: RunContext[Deps], lore_id: str, to_seq: int,
                          reason: str) -> str:
        """로어북 항목의 순서 이동을 제안한다. to_seq 는 같은 scope 안 목표 순번."""
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        label = (cur["entry"] or {}).get("comment") or lore_id
        return _propose(ctx, "lore_move",
                        f"로어북 “{label}” 을 #{to_seq} 로 이동 — {reason}",
                        {"id": lore_id, "toSeq": int(to_seq)})

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
                         content: str, reason: str, scope: str = "local") -> str:
        """로어북에 항목 추가를 제안한다.

        기본은 이 챗의 로어북(local)이다. scope="global" 은 봇 전체 로어북이라
        이 봇의 **모든 챗**에 영향을 준다 — 사용자가 봇 로어북이라고 명시했을 때만 써라.
        """
        if scope not in ("local", "global"):
            return "scope 는 local 또는 global 입니다"
        where = "봇 로어북(global)" if scope == "global" else "이 챗 로어북"
        entry = {"key": keys, "comment": comment, "content": content,
                 "alwaysActive": False, "insertorder": 100}
        return _propose(ctx, "lore_add", f"{where}에 “{comment}” 추가 — {reason}",
                        {"entry": entry, "scope": scope})

    @agent.tool
    def propose_lore_delete(ctx: RunContext[Deps], lore_id: str, reason: str) -> str:
        """로어북 항목 삭제를 제안한다."""
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        label = (cur["entry"] or {}).get("comment") or lore_id
        return _propose(ctx, "lore_delete", f"로어북 “{label}” 삭제 — {reason}",
                        {"id": lore_id})

    # --- card (bot) editing --------------------------------------------------

    @agent.tool
    def propose_card_edit(ctx: RunContext[Deps], field_id: str, new_body: str,
                          reason: str) -> str:
        """카드 필드 하나(설명·성격·첫인사·인사말 등)의 수정을 제안한다.

        카드는 이 봇의 모든 챗에 영향을 준다. id 는 read_card 에서 얻는다.
        """
        cur = cardmod.get_field(field_id)
        if cur is None:
            return "없는 카드 필드입니다"
        return _propose(ctx, "card_edit",
                        f"카드 {cur['field']} 수정 — {reason}",
                        {"id": field_id, "body": new_body})

    @agent.tool
    def propose_greeting_add(ctx: RunContext[Deps], body: str, reason: str) -> str:
        """대체 인사말(alternateGreetings) 추가를 제안한다."""
        return _propose(ctx, "card_greeting_add", f"대체 인사말 추가 — {reason}",
                        {"body": body})

    @agent.tool
    def propose_greeting_delete(ctx: RunContext[Deps], field_id: str, reason: str) -> str:
        """대체 인사말 삭제를 제안한다. id 는 read_card 에서 얻는다."""
        cur = cardmod.get_field(field_id)
        if cur is None or cur["field"] != "alternateGreetings":
            return "없는 인사말입니다"
        return _propose(ctx, "card_greeting_delete",
                        f"대체 인사말 #{cur['seq'] + 1} 삭제 — {reason}", {"id": field_id})

    @agent.tool
    def propose_regex_edit(ctx: RunContext[Deps], script_id: str, reason: str,
                           in_pattern: str = "", out_text: str = "",
                           comment: str = "", flag: str = "",
                           script_type: str = "") -> str:
        """Regex(customscript) 항목 수정을 제안한다. 빈 인자는 그대로 둔다.

        여기 없는 필드는 항목에 있던 그대로 보존된다. background HTML 도
        out_text 로 통째 교체하면 된다 — 먼저 read_script 로 현재 값을 읽어라.
        """
        cur = cardmod.script_entry(script_id)
        if cur is None or cur["kind"] != "customscript":
            return "없는 Regex 항목입니다"
        entry = dict(cur["entry"] or {})
        if in_pattern:
            entry["in"] = in_pattern
        if out_text:
            entry["out"] = out_text
        if comment:
            entry["comment"] = comment
        if flag:
            entry["flag"] = flag
        if script_type:
            entry["type"] = script_type
        label = entry.get("comment") or script_id
        return _propose(ctx, "script_edit", f"Regex “{label}” 수정 — {reason}",
                        {"id": script_id, "entry": entry})

    @agent.tool
    def propose_regex_add(ctx: RunContext[Deps], comment: str, in_pattern: str,
                          out_text: str, script_type: str, reason: str,
                          flag: str = "") -> str:
        """Regex(customscript) 항목 추가를 제안한다.

        script_type: editinput | editoutput | editdisplay | editprocess 등.
        """
        entry: dict[str, Any] = {"comment": comment, "in": in_pattern,
                                 "out": out_text, "type": script_type}
        if flag:
            entry["flag"] = flag
        return _propose(ctx, "script_add", f"Regex “{comment}” 추가 — {reason}",
                        {"kind": "customscript", "entry": entry})

    @agent.tool
    def propose_trigger_edit(ctx: RunContext[Deps], script_id: str,
                             entry_json: str, reason: str) -> str:
        """트리거(triggerscript) 항목 수정을 제안한다.

        트리거는 구조가 다양해서(V1 조건/효과, Lua triggerCode, V2 블록)
        read_script 로 읽은 JSON 전체를 고쳐 entry_json 으로 넘긴다.
        """
        cur = cardmod.script_entry(script_id)
        if cur is None or cur["kind"] != "triggerscript":
            return "없는 트리거 항목입니다"
        try:
            entry = json.loads(entry_json)
        except ValueError as e:
            return f"entry_json 이 JSON 이 아닙니다: {e}"
        if not isinstance(entry, dict):
            return "entry_json 은 객체여야 합니다"
        label = entry.get("comment") or script_id
        return _propose(ctx, "script_edit", f"트리거 “{label}” 수정 — {reason}",
                        {"id": script_id, "entry": entry})

    @agent.tool
    def propose_trigger_add(ctx: RunContext[Deps], entry_json: str, reason: str) -> str:
        """트리거(triggerscript) 항목 추가를 제안한다. entry_json 은 항목 전체 JSON."""
        try:
            entry = json.loads(entry_json)
        except ValueError as e:
            return f"entry_json 이 JSON 이 아닙니다: {e}"
        if not isinstance(entry, dict):
            return "entry_json 은 객체여야 합니다"
        label = entry.get("comment") or "(설명 없음)"
        return _propose(ctx, "script_add", f"트리거 “{label}” 추가 — {reason}",
                        {"kind": "triggerscript", "entry": entry})

    @agent.tool
    def propose_script_delete(ctx: RunContext[Deps], script_id: str, reason: str) -> str:
        """Regex 또는 트리거 항목 삭제를 제안한다."""
        cur = cardmod.script_entry(script_id)
        if cur is None:
            return "없는 스크립트 항목입니다"
        label = (cur["entry"] or {}).get("comment") or script_id
        kind = "Regex" if cur["kind"] == "customscript" else "트리거"
        return _propose(ctx, "script_delete", f"{kind} “{label}” 삭제 — {reason}",
                        {"id": script_id})

    @agent.tool
    def propose_open_tab(ctx: RunContext[Deps], tab: str, reason: str) -> str:
        """패널을 다른 탭으로 옮기자고 제안한다. 승인하면 그 탭이 열린다.

        지금 보는 탭이 아니라 다른 탭의 재료를 고쳐야 할 때 쓴다 - 예:
        로어북 탭에서 대화 중 메타(설명) 수정이 필요해졌을 때
        propose_open_tab("meta", "이 항목은 메타 수정이 필요합니다").
        tab: editor(챗 에딧) lore(챗 로어북) memory(장기기억) vars(챗 변수)
             meta(메타) botlore(봇 로어북) regex(Regex) trigger(트리거) assets(에셋)
             files(워크스페이스 파일)
        """
        labels = {"editor": "챗 에딧", "lore": "챗 로어북", "memory": "장기기억",
                  "vars": "챗 변수", "meta": "메타", "botlore": "봇 로어북",
                  "regex": "Regex", "trigger": "트리거", "assets": "에셋",
                  "files": "워크스페이스 파일"}
        if tab not in labels:
            return "모르는 탭입니다: " + tab + " (가능: " + ", ".join(labels) + ")"
        return _propose(ctx, "host_open_tab",
                        f"{labels[tab]} 탭으로 이동 — {reason}", {"tab": tab})

    @agent.tool
    def list_bot_snapshots(ctx: RunContext[Deps]) -> str:
        """봇(카드) 스냅샷 목록. 챗 스냅샷과 별개다."""
        rows = snapshots.listing_card(ctx.deps.char_key)
        if not rows:
            return "봇 스냅샷이 없습니다"
        return "\n".join(f"id={r['id']} {r['label'] or '(이름 없음)'}" for r in rows)

    @agent.tool
    def propose_bot_snapshot(ctx: RunContext[Deps], label: str) -> str:
        """봇(카드·스크립트·봇 로어북) 스냅샷 저장을 제안한다."""
        return _propose(ctx, "card_checkpoint_create", f"봇 스냅샷 저장 — {label}",
                        {"label": label})

    @agent.tool
    def propose_bot_restore(ctx: RunContext[Deps], snapshot_id: str, reason: str) -> str:
        """봇 스냅샷으로 되돌리자고 제안한다. 카드 작업본을 통째로 덮어쓴다."""
        return _propose(ctx, "card_checkpoint_restore",
                        f"봇 스냅샷 {snapshot_id} 로 되돌리기 — {reason} (카드 작업본을 덮어씁니다)",
                        {"id": snapshot_id})

    @agent.tool
    def propose_card_writeback(ctx: RunContext[Deps], reason: str) -> str:
        """카드 수정(메타·인사말·봇 로어북·Regex·트리거)을 RisuAI에 실제로 쓰자고 제안한다.

        반영은 RisuAI에서 이 봇이 선택되어 있어야 한다. 승인하면 플러그인이 수행한다.
        """
        return _propose(ctx, "host_card_writeback", f"카드를 RisuAI에 반영 — {reason}", {})

    # --- assets ---------------------------------------------------------------

    @agent.tool
    def list_assets(ctx: RunContext[Deps]) -> str:
        """이 봇이 참조하는 에셋(이미지 등) 목록: 필드·이름·형식·크기·스토어 상태.

        상태 present 인 것만 fetch_assets 로 꺼낼 수 있다. missing 은 아직 동기화 전이다.
        """
        data = assets.listing(ctx.deps.char_key)
        items = data["items"]
        out = [f"에셋 {len(items)}개 · 스토어에 {data['present']}개"
               + (f" · 없음 {data['missing']}" if data["missing"] else "")
               + (f" · 읽기 실패 {data['failed']}" if data["failed"] else "")]
        for it in items:
            size = f"{it['size'] // 1024}KB" if it.get("size") else "-"
            out.append(f"--- [{it['field']}] {it['name']!r} .{it['ext']} {size} {it['state']}")
        return "\n".join(out)[:20000]

    @agent.tool
    def fetch_assets(ctx: RunContext[Deps], names: str) -> str:
        """에셋을 워크스페이스 scratch/assets/ 로 꺼낸다. 쉼표로 여러 개.

        돌려주는 경로를 run_python 에서 PIL 로 연다. 같은 이름이 여럿(랜덤 풀)이면
        _1, _2 가 붙는다. 이름 대신 'assets/…' 키도 받는다.
        """
        wanted = [n.strip() for n in names.split(",") if n.strip()]
        r = assets.fetch_to_scratch(ctx.deps.char_key, wanted)
        lines = [f"{p}" for p in r["paths"]]
        if r["missing"]:
            lines.append("없음: " + ", ".join(r["missing"]))
        return "\n".join(lines) or "꺼낸 것이 없습니다"

    @agent.tool
    def propose_asset_add(ctx: RunContext[Deps], name: str, path: str, reason: str,
                          field: str = "additional") -> str:
        """워크스페이스의 PNG 파일을 이 봇의 에셋으로 추가하자고 제안한다.

        path: 워크스페이스 상대 경로(out/… 또는 scratch/…), PNG 만.
        field: additional(추가 에셋, 기본) | emotion(감정 이미지).
        승인되면 플러그인이 RisuAI 에 저장하고 카드에 붙인다 — 반영과 무관하게 즉시 쓰인다.
        """
        if field not in ("additional", "emotion"):
            return "field 는 additional 또는 emotion 이어야 합니다"
        try:
            info = assets.stage_file(ctx.deps.char_key, path)
        except (assets.AssetError, files.FileError) as e:
            return str(e)
        return _propose(ctx, "host_asset_add",
                        f"에셋 추가 “{name}” ({field}, {info['size'] // 1024}KB) — {reason}",
                        {"name": name, "path": info["path"], "field": field, "ext": "png"})

    @agent.tool
    def propose_asset_replace(ctx: RunContext[Deps], name: str, path: str, reason: str) -> str:
        """이름은 그대로 두고 그 에셋의 그림만 바꾸자고 제안한다 (PNG). CBS 참조는 영향 없다."""
        try:
            info = assets.stage_file(ctx.deps.char_key, path)
        except (assets.AssetError, files.FileError) as e:
            return str(e)
        return _propose(ctx, "host_asset_replace",
                        f"에셋 교체 “{name}” ({info['size'] // 1024}KB) — {reason}",
                        {"name": name, "path": info["path"], "ext": "png"})

    @agent.tool
    def propose_clone_bot(ctx: RunContext[Deps], name: str, reason: str) -> str:
        """지금 편집본을 얹은 복제 봇을 RisuAI에 만들자고 제안한다.

        원본 봇은 건드리지 않는다. 에셋은 참조를 공유하므로 복제는 즉시 끝난다.
        """
        return _propose(ctx, "host_clone_bot", f"복제 봇 “{name}” 생성 — {reason}",
                        {"name": name})

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
        wrong = _wrong_half(ctx, "chat")
        if wrong:
            return wrong
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
        wrong = _wrong_half(ctx, "chat")
        if wrong:
            return wrong
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
        wrong = _wrong_half(ctx, "chat")
        if wrong:
            return wrong
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
            """웹 검색(원시 결과). 원작 설정 확인 등 외부 사실이 필요할 때만."""
            return websearch.search(query)

    if search_agent_ready():
        @agent.tool
        async def web_research(ctx: RunContext[Deps], question: str) -> str:
            """검색 에이전트에게 조사를 맡긴다 — 검색하고 읽고 정리한 답을 돌려준다.

            원작 설정·시대 고증·용어처럼 외부 사실이 여럿 얽힌 질문에 쓴다. 한 번의
            web_search 로 끝날 단순 확인은 web_search 가 싸다.
            """
            return await research(question)

    return agent


# --- the search agent ---------------------------------------------------------

def search_agent_ready() -> bool:
    cfg = config.section("agent_search")
    if (cfg.get("provider") or "") == "codex":
        return bool(cfg.get("model")) and codexauth.logged_in()
    return bool(cfg.get("baseUrl") and cfg.get("apiKey") and cfg.get("model"))


SEARCH_INSTRUCTIONS = """\
당신은 조사 담당이다. 질문을 받으면 web_search 로 찾고, 여러 출처를 대조해 사실 위주로
답한다. 모르면 모른다고 하고, 출처 URL 을 답 끝에 붙인다. 카드나 챗을 고치는 일은
당신의 몫이 아니다 — 물어본 것에만 답한다. 한국어로 답한다.
"""


def _search_model() -> "OpenAIChatModel | OpenAIResponsesModel":
    return _model_for("agent_search")


async def research(question: str) -> str:
    """Run the search agent once, with the web as its only tool."""
    if not search_agent_ready():
        return "검색 에이전트가 설정되지 않았습니다 (설정 → 에이전트 → 검색 에이전트)"
    if not websearch.configured():
        return "웹 검색 프로바이더가 설정되지 않았습니다 (설정 → 연결)"
    cfg = config.section("agent_search")
    settings: dict[str, Any] = {
        "temperature": float(cfg.get("temperature") or 0.2),
        "max_tokens": int(cfg.get("maxTokens") or 16000),
    }
    extra = str(cfg.get("instructions") or "").strip()
    sub = Agent(
        _search_model(),
        instructions=SEARCH_INSTRUCTIONS + ("\n" + extra if extra else ""),
        model_settings=settings,  # type: ignore[arg-type]
    )

    @sub.tool_plain
    def web_search(query: str) -> str:
        """웹 검색."""
        return websearch.search(query)

    try:
        r = await sub.run(question)
        return str(r.output)[:20000]
    except Exception as e:  # noqa: BLE001 - a failed research degrades the turn, never fails it
        log.warn("search agent failed: %s", e)
        return f"검색 에이전트가 실패했습니다: {type(e).__name__}: {e}"
