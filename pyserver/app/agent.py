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
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider

from . import (actions, assets, codexauth, config, files, log, permits, presets, providers, pyexec, skills, snapshots, textedit,
               staging, store, websearch, workspace)
from . import nai, studio, studiojob, toolsigs
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
- **한 문장·한 줄만 고칠 때는 부분 교체 툴을 써라**: propose_lore_replace / propose_memory_replace /
  propose_card_replace (find → replace). 본문 전체를 다시 써 넣는 propose_*_edit 는 항목을
  통째로 다시 쓸 때만 — 긴 본문을 다시 치면 문장이 빠지거나 달라진다. find 는 read_* 로 읽은
  원문을 공백·따옴표까지 그대로 옮긴다.
- 규칙적인 치환은 run_python 으로 직접 훑는 편이 정확할 때가 많다.
  `import risuhina` 헬퍼가 준비돼 있다.
- **로어북을 쓰기 전에 스킬 "RisuAI 로어북 작성 규칙" 을 load_skill 로 읽어라.** 본문은 `### 제목` 으로
  시작하는 마크다운(#### 소제목 + 불릿), 우선순위는 insertorder 숫자(이웃과 같은 층), 키워드는
  영/한/일 별칭. 실리태번식 `@@position`·`@@role`·`@@priority` 헤더를 본문에 쓰지 마라.
- **외부 사실은 web_search 로 찾는다.** 원작 설정·고증·용어·최신 정보 등 네 기억 밖의 사실이
  필요하면 web_search 툴을 쓰고, 출처 URL 을 사용자에게 함께 전해라. 검색이 설정되지 않았다고
  돌아오면 그 안내를 그대로 전하고, 기억으로 사실을 지어내지 마라.
- **RisuAI 처리 순서를 알고 말해라.** 한 턴은 editinput(regex·저장됨) → start 트리거 → editprocess
  (regex, 턴마다 요청용·저장 안 됨) → 프롬프트 조립 → Lua editRequest(요청 배열 전체) → 모델 →
  editoutput(regex·저장됨) → output 트리거 → 화면마다 editdisplay(regex·저장 안 됨) 순이다.
  저장되는 건 editinput·editoutput 뿐이고, 모델이 보는 건 editprocess→editRequest 결과다. Lua
  listenEdit 훅은 같은 단계의 정규식보다 먼저 돈다. 정규식·트리거·배경 HTML 을 만들거나 고치기
  전에는 스킬 "RisuAI 처리 순서" 를 load_skill 로 불러 세부(플래그·@@명령·오진단 표)를 확인해라.
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

작업 공간 규칙 (반드시 지켜라 — 모든 봇이 하나의 전역 공간을 쓴다):
- `projects/<봇이름>/`  사용자가 직접 관리하는 참고 자료·프로젝트 폴더. **읽기는 자유,
  구조를 네가 바꾸지 마라.** 사용자가 올린 파일은 대개 여기 있다. 예외는 하나 —
  **완성 산출물(md·html·json·charx)은 `projects/<봇이름>/out/` 에 저장한다** (write_file 에
  이름만 주면 여기로 간다). out/ 에 넣으면 대화창에 열기 버튼이 뜬다 — 결과물을 만들었으면
  반드시 여기 저장하고 "저장했습니다, 파일 탭에서 여실 수 있습니다"라고 알려라.
- `studio/`  이미지 라이브러리. 재료는 `studio/config/` 아래(styles·characters·fragments·
  scenes·.studio), 생성 결과는 `studio/output/` 이다. 읽고 쓸 수 있다. **일회성 배치는
  spec.scenes 인라인으로** — 임시 프리셋 파일을 `studio/config/scenes/` 에 만들지 마라
  (반복용 임시 스펙은 `studio/config/.studio/adhoc/`).
- `hina/<봇이름>/`  네 내부 작업 공간이다 — **사용자 화면에는 기본적으로 보이지 않는다.**
  임시는 `scratch/`, 스크립트는 `scripts/`. **임시 문서·임시 스크립트는 반드시 이 폴더
  안에만 만든다** — projects/(out/ 제외) 나 studio/ 에 스크래치 파일을 남기지 마라
  (write_file 도 그런 쓰기를 거부한다). 사용자에게 보여 줄 파일을 여기 두면 사용자는 못 찾는다.
- `system/`  이 봇의 원본 스냅샷(카드·원본 전사). **읽기 전용이다.**
- **파일 위치를 모르면 find_files(이름 글롭) / search_files(내용 검색) 로 먼저 찾아라.**
  결과 끝의 "총 N개 중 M개 표시"가 전부가 아니라고 말하면, 잘렸다고 사용자에게도 말해라.
- **결과는 대화창에 직접 답한다** (별도 카드·아티팩트 없음). 보고서·비교표는 마크다운으로
  답하고, **이미지는 `![설명](studio/output/…/파일.png)` 처럼 전역 경로로 넣으면 대화창에
  바로 그림으로 뜬다** — 경로는 `studio/…`, `projects/…`, `hina/…` 로 시작하는 공간 경로만
  (드라이브 문자·URL·`..` 는 안 그려진다). 배치 결과는 studio_generate 가 완성되는 대로 대화창에
  뿌려 주니 결과 이미지를 다시 나열할 필요는 없다. 긴 문서는 write_file 로도 남겨라
  (이름만 주면 projects/<봇이름>/out/ 에 저장된다). 이 봇을 위한 이미지 배치는 기본적으로
  `studio/output/<봇이름>/` 에 들어간다 — 사용자가 검수 탭에서 그 폴더를 열어 고른다.
- 다른 봇의 폴더도 보인다. 읽는 것은 자유지만, **요청 없이 다른 봇의 폴더를 수정하지 마라.**
- **에셋(이미지)도 다룬다.** list_assets 로 목록을 보고 fetch_assets 로 scratch/ 에 꺼내
  run_python(PIL) 으로 가공한 뒤, 결과 PNG 를 propose_asset_add / propose_asset_replace 로
  제안한다. 승인되면 플러그인이 RisuAI 에 저장하고 카드에 붙인다 — 이것은 반영을 기다리지
  않고 즉시 RisuAI 에 쓰이는 유일한 카드 변경이다(바이너리라 작업본이 없다). PNG 만 된다.
  에셋의 **이름·삭제**는 카드 재료다: list_scripts("assetref") 로 행을 보고 propose_regex_edit 와
  같은 문법(propose_script_delete / entry 교체)으로 고치면 반영 때 한 번에 쓰인다.
  **여러 건은 한 제안으로**: 추가는 propose_assets_add(리스트), 삭제는 propose_scripts_delete(id 들)
  — 건마다 카드를 만들면 승인이 카드 수만큼 느리고 화면이 카드로 덮인다.
  RisuAI 규칙: **같은 이름을 가진 에셋 여러 개 = 랜덤 풀**({{asset::이름}} 호출 때 무작위 1개).
  charx 파일명의 `_1`, `_2` 는 파일명 고유화용일 뿐 이름이 아니다. 이름 끝 `.png` 같은 확장자는
  보통 실수이며(호출은 확장자 없는 이름), 일괄 제거는 카드 도구가 한다.
- 전역 공간과 system/ 밖에는 읽기도 쓰기도 할 수 없다. 다른 봇의 DB(챗·로어)도 볼 수 없다.
- 파일을 만들기 전에 find_files 로 이미 있는지 확인해라. 같은 이름을 덮어쓰지 마라.
"""


@dataclass
class Deps:
    chat_key: str
    char_key: str
    session_id: str | None
    workspace_dir: Path
    # Which screen the user is looking at: 'chat', 'bot' or 'studio' ('' =
    # unknown, older plugin). Chat material is edited from the chat tabs and
    # card material from the bot tabs; a tool for another screen refuses and
    # points at propose_open_tab, so the user is never surprised by a change
    # landing in a screen they are not looking at. The studio is a third
    # screen, not a half - adopting an image into the card is its own verb.
    mode: str = ""


# Proposal kinds by the half of the panel they belong to (see Deps.mode).
CHAT_KINDS = frozenset({"memory_edit", "memory_delete", "checkpoint_restore", "checkpoint_create",
                        "host_writeback", "host_save_copy"})
BOT_KINDS = frozenset({"card_edit", "card_greeting_add", "card_greeting_delete", "script_edit",
                       "script_add", "script_delete", "card_checkpoint_create", "card_checkpoint_restore",
                       "host_card_writeback", "host_clone_bot", "host_asset_add", "host_asset_replace"})
_MODE_TAB = {"chat": ("챗 편집", "editor"), "bot": ("봇 편집", "meta")}
_SCREEN_LABEL = {"chat": "챗 편집", "bot": "봇 편집", "studio": "에셋 스튜디오"}

# The studio's own verbs: adopting an image into the card is what the studio
# is for, so these pass the screen gate there (the approval queue still runs).
_STUDIO_KINDS = frozenset({"host_asset_add", "host_asset_replace"})

# Batches whose saved images were already shown as a strip: a job is polled
# many times, and the pictures should appear once.
_IMAGES_SENT: set[str] = set()


def _screen_refusal(mode: str, need: str) -> str | None:
    """A refusal when the tool's material belongs to a screen the user is not on."""
    if not need or not mode or mode == need:
        return None
    label, tab = _MODE_TAB[need]
    here = _SCREEN_LABEL.get(mode, mode)
    return (f"지금 화면은 {here}입니다. 이 작업은 {label} 화면의 재료를 고칩니다. "
            f"먼저 사용자에게 {label} 화면으로 이동하겠다고 알리고, propose_open_tab(\"{tab}\", 이유) 로 이동을 "
            f"제안해 승인을 받은 뒤 다시 요청해 주세요. (그 전에는 이 툴이 실행되지 않습니다)")


def screen_gate(mode: str, kind: str) -> str | None:
    """The screen rule for one proposal kind, as a pure function.

    Which screen a kind belongs to and which screens may fire it is a rule,
    not a property of the request - keeping it here means the tests state the
    rule instead of replaying a conversation.
    """
    if mode == "studio" and kind in _STUDIO_KINDS:
        return None
    need = "chat" if kind in CHAT_KINDS else ("bot" if kind in BOT_KINDS else "")
    return _screen_refusal(mode, need)


def _wrong_half(ctx: "RunContext[Deps]", need: str) -> str | None:
    """A refusal when the tool's material belongs to the other half."""
    return _screen_refusal(ctx.deps.mode, need)


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
    # Everything is addressed as an OpenAI-compatible endpoint, but which
    # fields it accepts, which API it speaks and whether tools may be strict
    # come from the plan (provider profile + the preset's parameter JSON) -
    # see providers.py. The client pops the fields the plan says not to send,
    # including the ones pydantic-ai adds on its own.
    plan = providers.plan_for(cfg)
    timeout = float(cfg.get("timeoutSeconds") or 300)
    provider = OpenAIProvider(openai_client=_client(base, key, plan.drop_all, timeout))
    profile = _profile(plan, name)
    if plan.api == "responses":
        return OpenAIResponsesModel(name, provider=provider, profile=profile)
    return OpenAIChatModel(name, provider=provider, profile=profile)


def _client(base: str, key: str, drop: set[str], timeout: float) -> Any:
    """An AsyncOpenAI for an OpenAI-compatible endpoint that drops the request
    fields the plan forbids. Wrapping `create` is the only place where
    stream_options / parallel_tool_calls / tool_choice can be removed - no
    model setting switches those off.

    The same wrapper carries Gemini's thought signatures (§1-38). Gemini 3
    thinking models return `extra_content.google.thought_signature` on every
    tool call and REQUIRE it back on that call when the history is replayed;
    pydantic-ai's OpenAI model neither keeps nor sends the field, so the
    second model call of any tool-using turn came back 400 "Function call
    is missing a thought_signature". Captured here (streamed deltas and
    plain responses), persisted by tool_call_id (`db` tool_sigs - the
    history is stored and replayed across turns), and re-attached to the
    assistant messages on the way out. Any provider that does not send the
    field is untouched.
    """
    import openai
    c = openai.AsyncOpenAI(base_url=base, api_key=key, timeout=timeout)
    for res in (c.chat.completions, c.responses):
        orig = res.create
        chat = res is c.chat.completions

        async def create(*a: Any, _orig: Any = orig, _chat: bool = chat, **kw: Any) -> Any:
            for k in drop:
                kw.pop(k, None)
            if _chat:
                toolsigs.attach(kw.get("messages"))
            out = await _orig(*a, **kw)
            return toolsigs.capture(out) if _chat else out

        res.create = create  # type: ignore[method-assign]
    return c


def _profile(plan: "providers.Plan", name: str) -> Any:
    """pydantic-ai's profile for the model name (family rules: reasoning
    support, schema transformer), with the plan's choices on top."""
    from pydantic_ai.profiles import merge_profile
    from pydantic_ai.profiles.openai import OpenAIModelProfile, openai_model_profile
    base = openai_model_profile(providers._bare_model(name))
    return merge_profile(base, OpenAIModelProfile(
        openai_chat_supports_max_completion_tokens=(plan.cap_field != "max_tokens"),
        openai_supports_strict_tool_definition=plan.strict_tools,
    ))


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


async def compact_history(session_id: str, messages: list) -> list:
    """Keep the conversation inside the model's budget.

    When the stored history grows past `agent.historyBudgetChars`, everything
    but the last KEEP_TAIL messages is summarised by the model into one
    Korean note and replaced by a (summary request, acknowledgement) pair.
    Called by session.run before each turn (pydantic-ai 2.x has no history
    processor hook). The result is remembered in COMPACTED so session.run
    stores it - the summary is paid for once, not on every later turn.
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
    if session_id:
        COMPACTED[session_id] = compacted
    log.info("history compacted session=%s %s msgs/%s chars -> %s msgs", session_id,
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
    )

    @agent.instructions
    def _current_screen(ctx: RunContext[Deps]) -> str:
        # Stated up front rather than discovered through a tool refusal, in
        # the same words the panel header shows (user request, 2026-08-30).
        if ctx.deps.mode == "bot":
            return "지금 열려 있는 화면: 봇 편집 (카드 재료 - 메타·인사말·봇 로어북·Regex·트리거·에셋)."
        if ctx.deps.mode == "chat":
            return "지금 열려 있는 화면: 챗 편집 (이 챗의 재료 - 턴·챗 로어북·장기기억·챗 변수)."
        if ctx.deps.mode == "studio":
            return ("지금 열려 있는 화면: 에셋 스튜디오 (봇과 무관한 전역 이미지 라이브러리 - "
                    "프롬프트 카드·생성·선별. 카드로의 에셋 반영 제안은 여기서도 됩니다).")
        return ""

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
        """로어북 전체 목록 (list_lore 와 같다). 본문은 read_lore_entry 로 읽는다."""
        return list_lore(ctx)

    @agent.tool
    def read_lore_entry(ctx: RunContext[Deps], lore_id: str) -> str:
        """로어북 항목 하나의 본문 전체와 설정(key·alwaysActive·folder·insertorder 등)."""
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        entry = dict(cur.get("entry") or {})
        content = str(entry.pop("content", "") or "")
        head = json.dumps({"id": cur.get("id"), "scope": cur.get("scope"), "seq": cur.get("seq"), **entry},
                          ensure_ascii=False)
        return f"{head}\n--- content ({len(content)}자) ---\n{content[:60000]}"

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
        wrong = screen_gate(ctx.deps.mode, kind)
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
    def propose_memory_replace(ctx: RunContext[Deps], memory_id: str, find: str, replace: str,
                               reason: str, replace_all: bool = False) -> str:
        """장기기억 항목의 **일부만** 고치자고 제안한다 (한 문장·한 줄을 바꿀 때).

        find 는 본문에 정확히 한 번 있는 문자열(공백·따옴표까지 그대로), replace 는 그 자리에
        들어갈 문자열. 두 곳 이상이면 문맥을 더 넣거나 replace_all=True. 본문 전체를 다시 쓰지 마라.
        """
        cur = mem.get(memory_id)
        if cur is None:
            return "없는 항목입니다"
        try:
            body, n = textedit.replace_once(str(cur.get("body") or ""), find, replace, replace_all=replace_all)
        except textedit.ReplaceError as e:
            return str(e)
        return _propose(ctx, "memory_edit",
                        f"장기기억 [{cur['kind']} #{cur['seq']}] 부분 수정({n}곳) — {reason}",
                        {"id": memory_id, "body": body})

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
        # An index, one line per entry, no bodies: with bodies attached a big
        # lorebook (hundreds of entries) was cut at 25000 chars and the agent
        # reported "only 18 entries". Bodies come from read_lore_entry.
        out = [f"로어북 {len(entries)}개 (본문은 read_lore_entry(id) 로 읽는다)"]
        for e in entries:
            entry = e["entry"] or {}
            if str(entry.get("mode") or "") == "folder":
                out.append(f"#{e['seq']} [{e['scope']}] [폴더] id={e['id']} "
                           f"key={entry.get('key')} 이름={entry.get('comment') or '(없음)'}")
                continue
            keys = entry.get("key") or entry.get("keys") or ""
            folder = str(entry.get("folder") or "")
            where = f" folder={names.get(folder, folder)}" if folder else ""
            # 상시 활성화: no keys, always inserted. Said explicitly, or an
            # empty key reads as a broken entry.
            always = " [상시활성]" if entry.get("alwaysActive") else ""
            body = str(entry.get("content") or "")
            preview = body[:80].replace("\n", " ")
            out.append(f"#{e['seq']} [{e['scope']}] id={e['id']}{always} 이름={entry.get('comment') or '(없음)'} "
                       f"order={entry.get('insertorder', 100)} key={keys}{where} ({len(body)}자) "
                       f"{preview}{'…' if len(body) > 80 else ''}")
        text = "\n".join(out)
        if len(text) > 60000:
            kept = text[:60000].count("\n")
            text = text[:60000] + f"\n… (이하 {len(entries) - kept}개 생략 — scope 를 좁혀 다시 부른다)"
        return text

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
    def propose_lore_replace(ctx: RunContext[Deps], lore_id: str, find: str, replace: str,
                             reason: str, replace_all: bool = False) -> str:
        """로어북 항목 본문의 **일부만** 고치자고 제안한다 (한 문장·한 줄을 바꿀 때 이걸 써라).

        find 는 본문(content)에 정확히 한 번 있는 문자열(공백·따옴표·줄바꿈까지 그대로), replace 는
        그 자리에 들어갈 문자열(지우려면 ""). 두 곳 이상이면 앞뒤 문맥을 더 넣거나 replace_all=True.
        본문 전체를 다시 써 넣는 propose_lore_edit 는 항목을 통째로 다시 쓸 때만 쓴다.
        """
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        entry = dict(cur["entry"] or {})
        try:
            content, n = textedit.replace_once(str(entry.get("content") or ""), find, replace, replace_all=replace_all)
        except textedit.ReplaceError as e:
            return str(e)
        entry["content"] = content
        label = entry.get("comment") or entry.get("key") or lore_id
        return _propose(ctx, "lore_edit", f"로어북 “{label}” 부분 수정({n}곳) — {reason}",
                        {"id": lore_id, "entry": entry})

    @agent.tool
    def propose_lore_edit(ctx: RunContext[Deps], lore_id: str, content: str,
                          reason: str, keys: str = "", comment: str = "",
                          insert_order: int = -1, folder: str = "") -> str:
        """로어북 항목을 **통째로** 다시 쓰자고 제안한다 (content 가 새 본문 전체).

        한 부분만 고칠 때는 propose_lore_replace 를 써라 — 전체를 다시 써 넣으면 나머지 문장이
        빠지거나 달라질 위험이 있다. keys·comment·folder 는 비우면, insert_order 는 -1 이면 그대로 둔다.
        본문만 그대로 두고 우선순위·키워드만 바꿀 때는 content 에 read_lore_entry 로 읽은 원문을 넣는다.
        """
        cur = store.lore_entry(lore_id)
        if cur is None:
            return "없는 로어북 항목입니다"
        entry = dict(cur["entry"] or {})
        entry["content"] = content
        if keys:
            entry["key"] = keys
        if comment:
            entry["comment"] = comment
        if int(insert_order) >= 0:
            entry["insertorder"] = int(insert_order)
        if folder:
            entry["folder"] = folder
        label = entry.get("comment") or entry.get("key") or lore_id
        return _propose(ctx, "lore_edit", f"로어북 “{label}” 수정 — {reason}",
                        {"id": lore_id, "entry": entry})

    @agent.tool
    def propose_lore_add(ctx: RunContext[Deps], comment: str, keys: str,
                         content: str, reason: str, scope: str = "local",
                         always_active: bool = False, insert_order: int = 100,
                         folder: str = "") -> str:
        """로어북에 항목 추가를 제안한다. 먼저 스킬 "RisuAI 로어북 작성 규칙" 을 읽어라.

        content 는 `### 제목` 으로 시작하는 마크다운(#### 소제목 + 불릿). insert_order 는
        우선순위 숫자(큰 값이 예산에서 살아남고 프롬프트에 먼저 놓임) — 이웃 항목과 같은 층으로
        반드시 정한다(주연 1000 · 조연 800~900 · 세계관 700 · 장소 600 · 몬스터 500 · 엑스트라 300,
        상시 정본 목록 2000). folder 는 소속 폴더 항목의 key.
        기본은 이 챗의 로어북(local)이다. scope="global" 은 봇 전체 로어북이라
        이 봇의 **모든 챗**에 영향을 준다 — 사용자가 봇 로어북이라고 명시했을 때만 써라.
        always_active=True 는 상시 활성화(키워드 없이 항상 삽입)다 — 그때 keys 는 비운다.
        """
        if scope not in ("local", "global"):
            return "scope 는 local 또는 global 입니다"
        where = "봇 로어북(global)" if scope == "global" else "이 챗 로어북"
        entry = {"key": "" if always_active else keys, "comment": comment, "content": content,
                 "alwaysActive": bool(always_active), "insertorder": int(insert_order)}
        if folder:
            entry["folder"] = folder
        return _propose(ctx, "lore_add", f"{where}에 “{comment}” 추가 (우선순위 {int(insert_order)}) — {reason}",
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
    def propose_card_replace(ctx: RunContext[Deps], field_id: str, find: str, replace: str,
                             reason: str, replace_all: bool = False) -> str:
        """카드 필드(설명·첫인사·인사말·제작자 노트 등)의 **일부만** 고치자고 제안한다.

        find 는 본문에 정확히 한 번 있는 문자열, replace 는 그 자리에 들어갈 문자열. 긴 desc 의
        한 문장을 바꿀 때 전체를 다시 쓰지 말고 이걸 써라. id 는 read_card 에서 얻는다.
        """
        cur = cardmod.get_field(field_id)
        if cur is None:
            return "없는 카드 필드입니다"
        try:
            body, n = textedit.replace_once(str(cur.get("body") or ""), find, replace, replace_all=replace_all)
        except textedit.ReplaceError as e:
            return str(e)
        return _propose(ctx, "card_edit",
                        f"카드 {cur['field']} 부분 수정({n}곳) — {reason}",
                        {"id": field_id, "body": body})

    @agent.tool
    def propose_card_edit(ctx: RunContext[Deps], field_id: str, new_body: str,
                          reason: str) -> str:
        """카드 필드 하나(설명·성격·첫인사·인사말 등)를 **통째로** 다시 쓰자고 제안한다.

        new_body 가 새 본문 전체다. 한 부분만 고칠 때는 propose_card_replace 를 써라.
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
    def propose_scripts_delete(ctx: RunContext[Deps], script_ids: str, reason: str) -> str:
        """Regex / 트리거 / 에셋 참조(assetref) 항목 **여러 개**를 한 번에 지우자고 제안한다 (카드 1장).

        script_ids: 쉼표로 이은 id 들. 둘 이상 지울 때는 반드시 이걸 쓴다 — 한 건씩
        propose_script_delete 를 부르면 카드가 그 수만큼 쌓인다.
        """
        ids = [s.strip() for s in (script_ids or "").split(",") if s.strip()]
        if not ids:
            return "script_ids 가 비었습니다"
        kinds: dict[str, int] = {}
        missing = []
        for i in ids:
            cur = cardmod.script_entry(i)
            if cur is None:
                missing.append(i)
                continue
            k = "Regex" if cur["kind"] == "customscript" else ("에셋 참조" if cur["kind"] == "assetref" else "트리거")
            kinds[k] = kinds.get(k, 0) + 1
        keep = [i for i in ids if i not in missing]
        if not keep:
            return "없는 스크립트 항목입니다: " + ", ".join(missing[:5])
        label = ", ".join(f"{k} {n}개" for k, n in kinds.items())
        out = _propose(ctx, "script_delete_many", f"{label} 삭제 — {reason}", {"ids": keep})
        if missing:
            out += f" (없는 id {len(missing)}개는 제외)"
        return out

    @agent.tool
    def propose_script_delete(ctx: RunContext[Deps], script_id: str, reason: str) -> str:
        """Regex 또는 트리거 항목 삭제를 제안한다 (여러 개면 propose_scripts_delete)."""
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
            info = assets.stage_file(path)
        except (assets.AssetError, files.FileError) as e:
            return str(e)
        return _propose(ctx, "host_asset_add",
                        f"에셋 추가 “{name}” ({field}, {info['size'] // 1024}KB) — {reason}",
                        {"name": name, "path": info["path"], "field": field, "ext": "png"})

    @agent.tool
    def propose_assets_add(ctx: RunContext[Deps], items_json: str, reason: str,
                           field: str = "additional") -> str:
        """여러 PNG 를 이 봇의 에셋으로 **한 번에** 추가하자고 제안한다 (제안 카드 1장).

        items_json: `[{"name": "...", "path": "..."}, …]` — 둘 이상이면 반드시 이걸 쓴다.
        (한 장씩 propose_asset_add 를 부르면 카드가 그 수만큼 쌓이고 승인도 그만큼 느리다.)
        field: additional | emotion. 승인되면 플러그인이 전부 저장하고 카드에 한 번에 붙인다.
        """
        if field not in ("additional", "emotion"):
            return "field 는 additional 또는 emotion 이어야 합니다"
        try:
            rows = json.loads(items_json)
        except ValueError as e:
            return f"items_json 을 읽지 못했습니다: {e}"
        if not isinstance(rows, list) or not rows:
            return "items_json 은 비어 있지 않은 리스트여야 합니다"
        items, bad = [], []
        for r in rows:
            name = str((r or {}).get("name") or "").strip()
            path = str((r or {}).get("path") or "")
            if not name or not path:
                bad.append(f"{r!r}: name/path 필요")
                continue
            try:
                info = assets.stage_file(path)
            except (assets.AssetError, files.FileError) as e:
                bad.append(f"{path}: {e}")
                continue
            items.append({"name": name, "path": info["path"], "field": field, "ext": "png"})
        if not items:
            return "추가할 수 있는 항목이 없습니다: " + "; ".join(bad[:5])
        out = _propose(ctx, "host_asset_add_many",
                       f"에셋 {len(items)}건 추가 ({field}) — {reason}",
                       {"items": items, "field": field})
        if bad:
            out += f" 제외 {len(bad)}건: " + "; ".join(bad[:5])
        return out

    # --- 에셋 스튜디오 --------------------------------------------------------
    #
    # The studio is bot-independent: its library is the studio/ folder of the
    # global space, and these domain verbs work with no bot selected. The one
    # that crosses back into a bot is `studio_adopt`, which proposes the image
    # by its own global path through the existing host_asset_add queue.

    # NOTE: the studio's FILES are ordinary space files (studio/…) - read and
    # write them with the general file tools. Only the domain verbs live here.

    @agent.tool
    def studio_meta(ctx: RunContext[Deps], path: str, enabled: str = "", order: int = 0) -> str:
        """스타일/캐릭터 카드의 활성화·순서를 바꾼다 (로어북처럼 카드가 자기 on/off 를 가진다).

        enabled: "true" | "false" | "" (그대로). order: 0 이면 그대로, 아니면 정수
        (작을수록 앞에 연결된다, 기본 100). 활성 카드들이 스타일/캐릭터 미지정 시의
        기본 세트다 - studio_plan 으로 확인하고 바꿔라.
        """
        changes: dict = {}
        if enabled.strip().lower() in ("true", "false"):
            changes["enabled"] = enabled.strip().lower() == "true"
        if order:
            changes["order"] = order
        if not changes:
            return "바꿀 것이 없습니다 (enabled 또는 order 를 주세요)"
        try:
            r = studio.set_meta(path, changes)
        except Exception as e:  # noqa: BLE001
            return str(e)
        return (f"{r['path']}: enabled={'true' if r['enabled'] else 'false'}, order={r['order']}")

    @agent.tool
    def studio_plan(ctx: RunContext[Deps], spec_json: str) -> str:
        """배치 생성 계획을 세워 본다 (아무것도 만들지 않는다). 먼저 이걸로 확인하고 studio_generate 한다.

        spec 필드 (전부 선택; 카드는 경로 또는 **표시 이름**으로 — "오피스 카운셀링"
        같은 이름은 정확 일치로 해석되고, 겹치면 후보를 나열하며 거절한다):
          model          기본 nai-diffusion-4-5-full
          styles         ["studio/config/styles/….md", "이름", …] — 생략하면 활성 카드,
                         명시적 [] 는 "스타일 없음"
          characters     경로/이름 리스트 (생략 = 활성 카드). dict 를 직접 넣어
                         애드혹 캐릭터도 가능({"caption","negative","position"}) —
                         단 dict 에는 카드 프리셋(레퍼런스)이 붙지 않는다
          scenes         인라인 씬 리스트 [{"name","prompt","negativePrompt",
                         "width","height"}, …] — **일회성 생성은 프리셋 파일을
                         만들지 말고 이걸 쓴다**
          scenePreset    프리셋 파일 경로/이름. `only:["angry","happy"]` 를 곁들이면
                         그 씬만 뽑는다 (scenePreset 경로에서만 동작)
          count / seed   씬당 장수, 시드(주면 씬 안에서 +1 씩 증가)
          characterName  파일명의 캐릭터 자리 (프롬프트와 무관)
          folder         저장 폴더 (기본 studio/output/<봇이름>)
          template       파일명 규칙 (기본 {character}-{emotion}-{stamp}-{n},
                         빈 필드는 구분자째 생략)
          useReference   true 면 활성 캐릭터 카드의 프리셋(캐릭터 레퍼런스 또는
                         바이브 — 카드의 refMode 가 고른다)이 실린다
          extra / negativeExtra   프롬프트/네거티브 끝에 덧붙일 문자열
          params         {"steps","scale","cfg_rescale","sampler","noise_schedule",
                         "width","height","qualityToggle","ucPreset", …} —
                         모르는 키도 그대로 전달된다

        라이브러리 파일은 일반 파일 도구(read_file / write_file)로 읽고 쓴다.
        스타일 .md 는 front matter + `## positive` / `## negative`. SD스튜디오
        프리셋(studio/config/scenes/)은 씬 프리셋 형식이고, 씬 하나가 배치의 한 장이다.
        **표정 세트는 씬마다 한 장씩 일반 생성으로 뽑는다** (디렉터 emotion 툴이
        아니다: 10배 비싸고 통제가 안 된다).
        프롬프트 안의 `{{…}}` 는 NovelAI 강조 문법이라 **절대 건드리지 않는다.**
        `<조각>` · `<폴더/조각>` · `<컬렉션.키>` 는 studio/config/fragments/ 참조이고
        (조각 카드의 front matter 이름으로도 해석된다) 생성 직전에 치환된다 —
        계획 결과의 unresolved 는 못 찾은 참조다. **여러 줄 조각은 장마다
        랜덤으로 1줄만** 실린다 (# 주석·빈 줄 제외, 고른 줄 안의 <참조> 재귀).
        """
        try:
            parsed = json.loads(spec_json)
            # An array of specs (a batch file holding several runs) plans as
            # the concatenation, one run after another (§1-39).
            specs = parsed if isinstance(parsed, list) else [parsed]
            items = []
            for spec in specs:
                items.extend(studio.plan(spec))
            spec = specs[0] if specs else {}
        except Exception as e:  # noqa: BLE001
            return f"계획을 세우지 못했습니다: {e}"
        est = studio.estimate(spec, len(items))
        lines = [(f"{len(specs)}개 사양, " if len(specs) > 1 else "") + f"{len(items)}장 · {est['note']}"]
        for i in items[:40]:
            lines.append(f"  {i['name']}  seed={i['seed']}  {i['prompt'][:70]}")
        if len(items) > 40:
            lines.append(f"  … 이하 {len(items) - 40}개 생략")
        return "\n".join(lines)

    @agent.tool
    def studio_generate(ctx: RunContext[Deps], spec_json: str, wait: bool = True) -> str:
        """배치 생성을 돌린다 (studio_plan 과 같은 spec; model 은 비우면 기본값).

        기본(wait=true)은 **끝날 때까지 기다리며 완성되는 장마다 대화창에 바로
        띄운다** — 사용자는 진행을 실시간으로 본다. 돌려주는 값은 최종 결과
        (저장/실패/Anlas). 아주 큰 배치를 걸어 두고 다른 일을 하려면 wait=false
        로 job id 만 받고 studio_job 으로 확인한다.
        **배치는 전역 직렬이다** — 여러 잡을 등록하면 순서대로 대기한다(NovelAI 는
        계정당 동시 생성을 잠근다). 캐릭터별 잡을 한꺼번에 쌓지 말고, 한 배치의
        결과를 확인한 뒤 다음을 시작해라.
        레퍼런스는 확정 비용이 든다 — 바이브 인코딩 2 Anlas/장(캐시 시 0),
        캐릭터 레퍼런스는 **생성 장당 5 Anlas** — 쓰기 전에 사용자에게 알린다.
        일회성 씬 조합은 spec.scenes 인라인으로 보내고, 반복해서 쓸 임시 스펙은
        studio/config/scenes/ 가 아니라 `studio/config/.studio/adhoc/` 에 write_file 로 남긴다.
        **spec 은 하나의 객체 또는 객체의 배열** — 배열이면 순서대로 각각 한 잡으로
        돌린다 (배치 명세 파일이 여러 사양을 담고 있어도 그대로 넘겨라).
        """
        try:
            parsed = json.loads(spec_json)
            specs = parsed if isinstance(parsed, list) else [parsed]
            if not specs or not all(isinstance(s, dict) for s in specs):
                return "spec 은 객체이거나 객체의 배열이어야 합니다."
            for spec in specs:
                if not str(spec.get("folder") or "").strip():
                    # A batch for THIS bot lands in its own output folder, so
                    # the 검수 tab has one place to look (§1-33). A spec that
                    # names a folder keeps it.
                    spec["folder"] = f"studio/output/{workspace.bot_folder(ctx.deps.char_key)}"
        except Exception as e:  # noqa: BLE001
            return f"시작하지 못했습니다: {e}"
        if len(specs) == 1:
            return _studio_generate_one(ctx, specs[0], wait)
        # Several specs: one job each, in order (the runner serialises them
        # anyway); each one's result is a paragraph of the answer (§1-39).
        outs = []
        for i, spec in enumerate(specs, 1):
            outs.append(f"[배치 {i}/{len(specs)}] " + _studio_generate_one(ctx, spec, wait))
            from . import session as session_mod
            if session_mod.stopped(ctx.deps.session_id):
                break
        return "\n\n".join(outs)

    def _studio_generate_one(ctx: RunContext[Deps], spec: dict, wait: bool) -> str:
        try:
            r = studiojob.start(spec)
        except Exception as e:  # noqa: BLE001
            return f"시작하지 못했습니다: {e}"
        job_id = r["jobId"]
        head = f"배치를 시작했습니다 (id={job_id}, {r['total']}장). {r['estimate']['note']}"
        if not wait:
            return head + " studio_job 으로 진행을 확인하세요."
        # Wait here, pushing each finished image into the chat as it lands:
        # the session loop flushes side events while a tool is still running,
        # so the strip grows in front of the user instead of after the turn.
        from . import session as session_mod
        import time as _time
        shown = 0
        deadline = _time.time() + 60 * 60
        j = None
        folder = str(spec.get("folder") or "studio/output")
        while _time.time() < deadline:
            # The user's 중단 closes the stream; this thread hears of it here.
            # The batch the tool started is the tool's to stop, too.
            if session_mod.stopped(ctx.deps.session_id):
                studiojob.cancel(job_id)
                return head + " 사용자가 중단했습니다 — 배치도 다음 장에서 멈춥니다."
            j = studiojob.get(job_id) or {}
            p = j.get("payload") or {}
            saved = list(p.get("saved") or [])
            if len(saved) > shown:
                fresh = saved[shown:]
                shown = len(saved)
                session_mod.push_stream_event(ctx.deps.session_id, {
                    "type": "images", "paths": fresh[-8:], "folder": folder,
                    "label": f"배치 {job_id} — {shown}/{p.get('total')}장",
                })
            if j.get("state") in ("done", "partial", "error", "cancelled"):
                break
            _time.sleep(1.5)
        _IMAGES_SENT.add(job_id)
        p = (j or {}).get("payload") or {}
        out = [head, f"결과: {(j or {}).get('state')}  {p.get('done')}/{p.get('total')}"]
        if (j or {}).get("error"):
            out.append("오류: " + str(j["error"]))
        if p.get("note"):
            out.append("주의: " + str(p["note"]))
        for f in (p.get("failed") or [])[:10]:
            out.append(f"  실패 {f['name']}: {f['error']}")
        if p.get("anlasAfter") is not None and p.get("anlasBefore") is not None:
            out.append(f"Anlas {p['anlasBefore']} → {p['anlasAfter']}")
        for s in (p.get("saved") or [])[-20:]:
            out.append("  " + s)
        return "\n".join(out)

    @agent.tool
    def studio_open(ctx: RunContext[Deps], folder: str) -> str:
        """패널의 에셋 스튜디오 **검수 탭**을 이 폴더로 연다 (사용자가 고르고 채택하는 화면).

        배치가 끝나고 "검수해 보세요" 라고 할 때, 또는 사용자가 특정 폴더를 보고
        싶다고 할 때 부른다. 폴더는 `studio/output/…` 전역 경로.
        """
        rel = (folder or "").replace("\\", "/").strip("/")
        if not rel.startswith("studio/"):
            return "studio/ 아래 폴더만 열 수 있습니다: " + rel
        from . import session as session_mod
        session_mod.push_stream_event(ctx.deps.session_id,
                                      {"type": "open", "screen": "inspect", "folder": rel})
        return f"검수 탭을 {rel} 로 열었습니다."

    @agent.tool
    def studio_job(ctx: RunContext[Deps], job_id: str = "") -> str:
        """배치 진행 상황. job_id 없이 부르면 최근 배치 목록."""
        if not job_id:
            jobs = studiojob.recent()
            return "\n".join(f"{j['id']}  {j['state']}  "
                             f"{(j.get('payload') or {}).get('done')}/{(j.get('payload') or {}).get('total')}"
                             for j in jobs) or "배치가 없습니다"
        j = studiojob.get(job_id)
        if not j:
            return f"그런 배치가 없습니다: {job_id}"
        p = j.get("payload") or {}
        # A finished batch shows its images in the panel once, as a strip -
        # the same poll that tells the model tells the user.
        if j.get("state") in ("done", "partial") and p.get("saved") and job_id not in _IMAGES_SENT:
            _IMAGES_SENT.add(job_id)
            from . import session as session_mod
            session_mod.push_stream_event(ctx.deps.session_id, {
                "type": "images", "paths": list(p["saved"])[-24:],
                "label": f"배치 {job_id} — {len(p['saved'])}장",
            })
        out = [f"{j['state']}  {p.get('done')}/{p.get('total')}"]
        if j.get("error"):
            out.append("오류: " + str(j["error"]))
        for f in (p.get("failed") or [])[:10]:
            out.append(f"  실패 {f['name']}: {f['error']}")
        if p.get("anlasAfter") is not None and p.get("anlasBefore") is not None:
            out.append(f"Anlas {p['anlasBefore']} → {p['anlasAfter']}")
        for s in (p.get("saved") or [])[-20:]:
            out.append("  " + s)
        return "\n".join(out)

    @agent.tool
    def studio_parse(ctx: RunContext[Deps], folder: str, pattern: str = "") -> str:
        """생성물 폴더의 파일명을 정규식으로 갈라 본다. **안 맞는 파일을 반드시 보고한다.**

        이름은 결정론적이지 않다 — 그래서 이 툴이 있다. 안 맞는 것이 있으면
        정규식을 고치거나, 사용자에게 studio_rename 일괄 이름 변경을 제안한다.
        """
        try:
            base = files._resolve(files.SPACE, studio._rel(folder))
            names = sorted(p.name for p in base.glob("*.png"))
        except Exception as e:  # noqa: BLE001
            return str(e)
        if not names:
            return f"{folder} 에 png 가 없습니다"
        r = studio.parse_names(names, pattern)
        out = [f"매치 {len(r['matched'])} / 미매치 {len(r['unmatched'])} · 필드 {r['fields']}",
               f"정규식: {r['pattern']}"]
        for m in r["matched"][:15]:
            out.append("  " + ", ".join(f"{k}={v}" for k, v in m.items() if k != "filename"))
        if r["unmatched"]:
            out.append("안 맞는 파일:")
            out += ["  " + n for n in r["unmatched"][:30]]
            if len(r["unmatched"]) > 30:
                out.append(f"  … 이하 {len(r['unmatched']) - 30}개 생략")
        return "\n".join(out)

    @agent.tool
    def studio_rename(ctx: RunContext[Deps], folder: str, rename_json: str,
                      apply: bool = False) -> str:
        """생성물 파일 이름을 **일괄로** 바꾼다. rename_json = [{"from":"a.png","to":"b.png"}, …]

        **먼저 apply=false 로 확인하고 사용자에게 보여 준 다음** apply=true 로 적용한다.
        이름이 규칙에 안 맞으면 비교 선택기가 그룹을 못 나눈다 — 이 툴이 그걸 고치는
        경로이고, studio_parse 의 "안 맞는 파일" 목록이 그 입력이다.
        충돌·원본 없음 같은 문제가 하나라도 있으면 **아무것도 바꾸지 않는다**.
        """
        try:
            pairs = json.loads(rename_json)
            if not isinstance(pairs, list):
                return "rename_json 은 [{\"from\":…,\"to\":…}] 배열이어야 합니다"
            if apply:
                r = studio.rename_apply(folder, pairs)
                return f"{r['renamed']}개의 이름을 바꿨습니다 (사이드카도 따라갔습니다)"
            plan = studio.rename_plan(folder, pairs)
        except Exception as e:  # noqa: BLE001
            return str(e)
        out = [f"바꿀 것 {len(plan['rename'])}건, 문제 {len(plan['problems'])}건"]
        for p in plan["rename"][:20]:
            out.append(f"  {p['from']} → {p['to']}")
        for p in plan["problems"][:20]:
            out.append(f"  ✕ {p['from']} → {p['to']}: {p['why']}")
        if plan["problems"]:
            out.append("문제가 있어서 apply=true 로 불러도 아무것도 바뀌지 않습니다. 먼저 고치세요.")
        return "\n".join(out)

    @agent.tool
    def studio_group(ctx: RunContext[Deps], folder: str, pattern: str = "",
                     group_by: str = "emotion") -> str:
        """생성물을 그룹으로 묶어 본다 (비교 선택기가 보는 것과 같다).

        안 맞는 파일이 있으면 그것부터 보고한다 — studio_rename 으로 고칠 대상이다.
        """
        try:
            g = studio.group(folder, pattern, group_by)
        except Exception as e:  # noqa: BLE001
            return str(e)
        out = [f"{g['total']}개 · 그룹 {len(g['groups'])} · 안 맞는 파일 {len(g['unmatched'])} · 필드 {g['fields']}"]
        for grp in g["groups"][:25]:
            chosen = sum(1 for i in grp["items"] if i["selection"].get("use"))
            out.append(f"  {grp['key']}: {len(grp['items'])}장" + (f" (선택 {chosen})" if chosen else ""))
        for u in g["unmatched"][:20]:
            out.append(f"  ✕ {u['filename']}")
        return "\n".join(out)

    @agent.tool
    def studio_export(ctx: RunContext[Deps], folder: str, character: str = "",
                      pattern: str = "") -> str:
        """선택한 것들을 `selected/` 로 내보낸다. 아무것도 안 고른 그룹은 빈 .txt 로 남는다.

        그 .txt 가 "여긴 아직 없다" 는 표시이고, 그것만 다시 생성하면 된다.
        """
        try:
            r = studio.export_selected(folder, pattern=pattern, character=character)
        except Exception as e:  # noqa: BLE001
            return str(e)
        return (f"{r['folder']} 로 내보냈습니다 — 채택 {r['used']}, 인페인트 {r['inpaint']}, "
                f"빈 슬롯 {r['empty']} (그룹 {r['groups']}, 안 맞는 파일 {r['unmatched']})")

    @agent.tool
    def studio_adopt(ctx: RunContext[Deps], paths: str, names: str,
                     field: str = "emotion", reason: str = "") -> str:
        """스튜디오 이미지를 지금 선택된 봇의 에셋으로 넣자고 제안한다.

        paths/names 는 쉼표로 구분하고 개수가 같아야 한다 (paths[i] 가 names[i] 로 들어간다).
        field: emotion(감정 이미지) | additional(추가 에셋).
        라이브러리에서 봇 워크스페이스로 **복사**한 뒤 기존 에셋 추가 경로를 탄다 —
        승인해야 RisuAI 에 쓰인다. 봇이 선택돼 있어야 한다.
        """
        ck = ctx.deps.char_key
        if not ck:
            return "봇이 선택돼 있지 않습니다. RisuAI 에서 봇을 열어 주세요."
        plist = [p.strip() for p in paths.split(",") if p.strip()]
        nlist = [n.strip() for n in names.split(",") if n.strip()]
        if len(plist) != len(nlist):
            return f"경로 {len(plist)}개와 이름 {len(nlist)}개의 수가 다릅니다"
        if field not in ("emotion", "additional"):
            return "field 는 emotion 또는 additional 이어야 합니다"
        made = []
        for path, name in zip(plist, nlist):
            try:
                # The library and the workspace are one space now: the image
                # is proposed by its own path, no copy hop.
                info = assets.stage_file(studio._rel(path))
            except Exception as e:  # noqa: BLE001
                made.append(f"✕ {path}: {e}")
                continue
            made.append(_propose(ctx, "host_asset_add",
                                 f"에셋 추가 “{name}” ({field}, {info['size'] // 1024}KB) — "
                                 + (reason or "스튜디오에서 채택"),
                                 {"name": name, "path": info["path"], "field": field, "ext": "png"}))
        return "\n".join(made)

    @agent.tool
    def studio_inpaint(ctx: RunContext[Deps], path: str, boxes_json: str, prompt: str,
                       model: str = "nai-diffusion-4-5-full", negative: str = "") -> str:
        """이미지의 일부만 다시 그린다. 원본은 두고 `-fix` 가 붙은 새 파일로 저장한다.

        boxes_json = [{"x":0.25,"y":0.15,"w":0.5,"h":0.35}] — **0~1 비율**이다.
        (x,y 는 왼쪽 위 모서리, w,h 는 너비/높이. 여러 개 줄 수 있다.)
        지정한 사각형 안만 바뀌고 **바깥은 원본 그대로** 유지된다.

        비용은 계정 등급에 따라 다르다. 실행 전후 Anlas 를 대조해 실제로 얼마나
        나갔는지 보고하므로, 여러 장을 돌리기 전에 한 장으로 확인시켜 드릴 것.
        """
        try:
            boxes = json.loads(boxes_json)
            if not isinstance(boxes, list) or not boxes:
                return 'boxes_json 은 [{"x":…,"y":…,"w":…,"h":…}] 배열이어야 합니다 (0~1 비율)'
            before = nai.anlas()
            r = studio.inpaint(path, boxes, prompt, model=model, negative=negative)
            after = nai.anlas()
        except Exception as e:  # noqa: BLE001
            return str(e)
        spent = before - after if before >= 0 and after >= 0 else None
        return (f"{r['path']} 로 저장했습니다 ({r['size'] // 1024}KB)."
                + (f" Anlas {before} → {after} ({spent} 소모)." if spent is not None else ""))

    @agent.tool
    def studio_naming(ctx: RunContext[Deps]) -> str:
        """지금 선택된 봇이 실제로 쓰는 감정 에셋 이름들. 이름 규칙은 봇마다 다르므로 여기서 읽는다."""
        if not ctx.deps.char_key:
            return "봇이 선택돼 있지 않습니다"
        r = studio.naming_from_bot(ctx.deps.char_key)
        if not r["hasConvention"]:
            return r["note"] + f" 기본 이름 규칙: {r['template']}"
        return r["note"] + "\n" + ", ".join(r["emotionNames"])

    @agent.tool
    def studio_duplicates(ctx: RunContext[Deps], folder: str) -> str:
        """폴더 안의 내용이 완전히 같은 이미지들을 찾는다 (지우지는 않는다).

        같은 시드로 다시 돌렸거나 복사해 둔 것들이다. 남길 것 하나와 나머지를
        보여 주므로, 지울지는 사용자가 정한다 — 중복이 곧 쓰레기는 아니다.
        지우려면 studio_delete 대신 사용자에게 확인을 받고 files 삭제를 제안할 것.
        """
        try:
            r = studio.duplicates(folder)
        except Exception as e:  # noqa: BLE001
            return str(e)
        if not r["groups"]:
            return f"{folder}: 중복 없음"
        out = [f"중복 {r['duplicateFiles']}개 · 낭비 {r['wastedBytes'] // 1024}KB"]
        for g in r["groups"][:25]:
            out.append(f"  남길 것: {g['keep']}")
            out += [f"    = {o}" for o in g["others"][:5]]
        return "\n".join(out)

    @agent.tool
    def studio_emotion_check(ctx: RunContext[Deps], preset: str = "") -> str:
        """이 봇의 감정 에셋이 있어야 할 것과 맞는지 대조한다.

        preset 에 SD스튜디오 프리셋 경로(scenes/…json)를 주면 **빠진 슬롯**을 알려준다 —
        그것만 다시 생성하면 된다. 카드 스크립트/본문에서 이름이 한 번도 안 나오는
        에셋은 **참조 안 됨**으로 따로 보고한다.
        """
        if not ctx.deps.char_key:
            return "봇이 선택돼 있지 않습니다"
        try:
            r = studio.emotion_check(ctx.deps.char_key, preset)
        except Exception as e:  # noqa: BLE001
            return str(e)
        out = [f"카드에 있는 감정 에셋 {len(r['have'])}개", r["note"]]
        if r["missing"]:
            out.append("빠진 것: " + ", ".join(r["missing"]))
        if r["unreferenced"]:
            out.append("어디서도 참조 안 됨: " + ", ".join(r["unreferenced"][:30]))
        if r["have"]:
            out.append("있는 것: " + ", ".join(r["have"][:40]))
        return "\n".join(out)

    @agent.tool
    def studio_recipe(ctx: RunContext[Deps], path: str) -> str:
        """NAI 가 PNG 안에 남긴 생성 파라미터를 읽는다. 밖에서 만든 이미지도 읽힌다.

        "이거랑 같은 설정으로 더" 를 할 때 쓴다.
        """
        try:
            r = nai.recipe(studio.read_bytes(path))
        except Exception as e:  # noqa: BLE001
            return str(e)
        if not r:
            return "NAI 가 만든 PNG 가 아닙니다 (메타데이터 없음)"
        p = r.get("parameters") or {}
        keep = ("prompt", "uc", "seed", "steps", "scale", "sampler", "width", "height",
                "noise_schedule", "cfg_rescale")
        lines = [f"source: {r.get('source', '?')}"]
        lines += [f"{k}: {p[k]}" for k in keep if k in p]
        if p.get("reference_strength_multiple"):
            lines.append(f"vibe strengths: {p['reference_strength_multiple']}")
        return "\n".join(lines)

    @agent.tool
    def propose_asset_replace(ctx: RunContext[Deps], name: str, path: str, reason: str) -> str:
        """이름은 그대로 두고 그 에셋의 그림만 바꾸자고 제안한다 (PNG). CBS 참조는 영향 없다."""
        try:
            info = assets.stage_file(path)
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

    # The one virtual prefix over the space: `system/…` reads this bot's own
    # SYSTEM directory (frozen originals, card.md) - read-only machinery that
    # deliberately lives outside the shared tree.
    def _fs(ctx: RunContext[Deps], path: str) -> tuple[str, str]:
        p = (path or "").replace("\\", "/").strip("/")
        if p == "system" or p.startswith("system/"):
            return ctx.deps.char_key, p[6:].lstrip("/")
        # Skill bodies say `skills/<slug>/…` - relative to the bot's home,
        # where install_skills puts them.
        if p == "skills" or p.startswith("skills/"):
            return files.SPACE, f"hina/{workspace.bot_folder(ctx.deps.char_key)}/{p}"
        return files.SPACE, p

    @agent.tool
    def write_file(ctx: RunContext[Deps], name: str, content: str) -> str:
        """파일을 쓴다. 이름만 주면 projects/<봇>/out/ 에 산출물로 저장된다.

        studio/ · hina/ 로 시작하는 전체 경로, 또는 이 봇의 projects/<봇>/out/…
        경로를 주면 그 위치에 쓴다 (덮어쓴다 — 먼저 find_files 로 확인해라).
        projects/ 의 나머지는 사용자가 직접 관리하는 영역이라 이 도구로는 쓸 수
        없다. 그 밖의 위치도 거부된다.
        """
        rel = (name or "").replace("\\", "/").strip("/")
        area = rel.split("/", 1)[0]
        own_out = workspace.out_rel(ctx.deps.char_key)
        if area == "projects" and not (rel == own_out or rel.startswith(own_out + "/")):
            # The user's own tree (the instruction says read-only; this makes
            # it true): a scratch note the agent parks there is exactly the
            # mess the hina/ areas exist to hold. The bot's own out/ is the
            # one carve-out - that is where deliverables go.
            return (f"projects/ 는 사용자가 직접 관리하는 영역이라 쓰지 않습니다. "
                    f"산출물은 {own_out}/, 임시 문서·스크립트는 hina/<봇>/scratch/ 에 저장하세요.")
        if "/" in rel and area in ("studio", "hina", "projects"):
            try:
                dest = files._resolve(files.SPACE, rel)
            except files.FileError as e:
                return str(e)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(content, encoding="utf-8")
            return f"{rel} 에 {len(content)}자를 썼습니다"
        path = workspace.write_out(ctx.deps.char_key, rel, content)
        return f"{path} 에 {len(content)}자를 썼습니다"

    @agent.tool
    def list_files(ctx: RunContext[Deps], directory: str = "") -> str:
        """전역 공간의 파일 목록. 비워 두면 최상위 (projects·studio·hina).

        `system/` 은 이 봇의 원본 스냅샷(읽기 전용)이다: system/original/<챗>.md 등.
        """
        try:
            scope, rel = _fs(ctx, directory)
            return files.agent_list(scope, rel)
        except files.FileError as e:
            return str(e)

    @agent.tool
    def read_file(ctx: RunContext[Deps], path: str) -> str:
        """전역 공간(또는 system/)의 파일을 읽는다. 참고 자료는 대개 projects/<봇>/ 에 있다."""
        try:
            scope, rel = _fs(ctx, path)
            return files.agent_read(scope, rel)
        except files.FileError as e:
            return str(e)

    IMAGE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|avif|bmp)$", re.I)

    @agent.tool
    def find_files(ctx: RunContext[Deps], pattern: str, base: str = "", limit: int = 200) -> str:
        """전역 공간에서 파일 이름을 글롭으로 찾는다 (예: "*.png", "히나*", "projects/*/메모/*.md").

        슬래시가 든 패턴은 경로 전체에, 아니면 파일 이름에 맞춘다. 위치를 모르는 파일은
        먼저 이걸로 찾아라. 결과가 잘리면 마지막 줄이 그렇다고 말한다 — 그대로 전해라.
        """
        try:
            r = files.search_names(files.SPACE, pattern, base=base, limit=max(1, min(500, limit)))
        except files.FileError as e:
            return str(e)
        if not r["total"]:
            return f"'{pattern}' 에 맞는 파일이 없습니다"
        lines = [f"{f['path']}  ({f['size']}B)" for f in r["files"]]
        lines.append(f"총 {r['total']}개 중 {len(r['files'])}개 표시")
        return "\n".join(lines)

    @agent.tool
    def search_files(ctx: RunContext[Deps], query: str, glob: str = "", limit: int = 50) -> str:
        """전역 공간의 텍스트 파일 내용을 검색한다 (부분 문자열, 대소문자 무시).

        glob 으로 경로를 좁힐 수 있다 (예: "projects/히나/*"). 파일당 최대 5줄.
        마지막 줄이 몇 개를 스캔했고 몇 개가 잘렸는지 말한다 — 그대로 전해라.
        """
        try:
            r = files.search_content(files.SPACE, query, glob=glob, limit=max(1, min(200, limit)))
        except files.FileError as e:
            return str(e)
        lines = [f"{h['path']}:{h['line']}  {h['text']}" for h in r["hits"]]
        lines.append(f"총 {r['totalHits']}개 히트 중 {len(r['hits'])}개 표시 "
                     f"(파일 {r['scanned']}개 스캔, {r['skipped']}개 건너뜀)")
        return "\n".join(lines)

    # --- outside world ------------------------------------------------------

    # --- things that must be allowed first -------------------------------------
    # A shell command or a package install is asked in the panel while the tool
    # waits (permits.py). The user may allow once, refuse, or allow this kind
    # for the rest of the turn.

    async def _permitted(ctx: RunContext[Deps], kind: str, summary: str, detail: str) -> bool:
        if not ctx.deps.session_id:
            return False
        req = permits.request(ctx.deps.session_id, kind, summary, detail)
        if req["auto"]:
            return True
        return await permits.decision(req["id"])

    def _fmt(r: dict) -> str:
        out = f"(exit {r['code']}, {r['seconds']}s)\n"
        if r.get("stdout"):
            out += r["stdout"]
        if r.get("stderr"):
            out += ("\n--- stderr ---\n" if r.get("stdout") else "") + r["stderr"]
        return out[:20000]

    @agent.tool
    async def run_shell(ctx: RunContext[Deps], command: str, reason: str) -> str:
        """워크스페이스에서 셸 명령(cmd / bash)을 실행한다. **사용자 허용이 필요하다** —
        패널에 프롬프트가 뜨고, 허용하면 실행되고 거부하면 거부됐다고 돌아온다.

        run_python 으로 안 되는 것(외부 도구 호출, 파일 변환 프로그램 등)에만 쓴다.
        reason 은 사용자에게 보이는 이유다. 워크스페이스 밖을 건드리는 명령은 제안하지 마라.
        """
        ws = workspace.hina_dir(ctx.deps.char_key)
        ok = await _permitted(ctx, "shell", permits.safe_summary(command), f"이유: {reason}\n\n{command}\n\n작업 폴더: {ws}")
        if not ok:
            return "사용자가 이 명령을 허용하지 않았습니다. 다른 방법을 찾거나 사용자에게 물어보세요."
        return _fmt(permits.run_shell(command, ws))

    @agent.tool
    async def pip_install(ctx: RunContext[Deps], packages: str, reason: str) -> str:
        """파이썬 패키지를 설치한다 (쉼표로 여러 개). **사용자 허용이 필요하다.**

        run_python 에서 import 가 실패했을 때 쓴다. 설치는 이 백엔드의 인터프리터에 된다.
        """
        pkgs = [p.strip() for p in packages.split(",") if p.strip()]
        ok = await _permitted(ctx, "pip", "pip install " + " ".join(pkgs)[:120], f"이유: {reason}\n\n패키지: {', '.join(pkgs)}")
        if not ok:
            return "사용자가 설치를 허용하지 않았습니다."
        return _fmt(permits.pip_install(pkgs))

    # One search tool, whatever does the searching (websearch.mode()): the
    # model's own search, the Gemini helper, or a provider's hit list. The
    # docstring says which kind of thing comes back. Always registered: when
    # nothing is set up the tool says so, which is a better answer than a
    # tool that silently is not there.
    async def web_search(ctx: RunContext[Deps], query: str) -> str:
        return await websearch.run(query)
    # The description is read at registration, so it is set before, not after.
    web_search.__doc__ = websearch.tool_doc()
    agent.tool(web_search)

    return agent

