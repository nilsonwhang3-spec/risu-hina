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
from . import nai, studio, studiojob, toolsigs, vision
from . import card as cardmod
from . import memory as mem

INSTRUCTIONS = """\
You are a tool for editing RisuAI roleplay chat logs after the fact.
**Answer in polite Korean (~합니다 / ~해 주세요).** Never use plain-declarative (~한다) or casual speech toward the user.

Principles:
- **Never try to read a whole conversation.** 400-turn chats are common. Skim with list_turns,
  narrow with search_turns, and read only the range you need with read_turns.
- **You cannot edit anything yourself.** Transcript edits go through stage_edit / stage_bulk /
  stage_delete; every other change (lorebook, long-term memory, snapshots, writing to RisuAI,
  saving a copy) is a propose_* tool - the user reviews and approves before anything runs.
  After proposing, say exactly "제안했습니다, 승인이 필요합니다". Never say "고쳤습니다".
- For transcript edits (stage_*) **the proposal itself is the confirmation step.** If the user
  asked for the fix, propose it right away instead of asking again - but always explain what
  changes and why.
- **propose_* is different.** Lorebook, memory, snapshot restore, writing to RisuAI and saving a
  copy are hard to undo or touch the RisuAI original. **Say what you will do and why, and get the
  user's agreement BEFORE proposing.** The approve button is a confirmation, not the explanation.
  When asking for agreement in chat, **do not use the word "승인"** - that is the panel's button,
  and there is no button until something has been proposed. Ask "이대로 진행할까요?" instead.
- **Approval happens in the panel and you cannot see the result in this turn.** Do not stop with
  "승인해 주시면 이어서 제안하겠습니다" - pressing the button does not wake you. Proposals that
  belong together (e.g. a lorebook addition and the deletion of those turns) go out **in one turn**,
  and you end with "패널에서 승인·거절하신 뒤 이어서 말씀해 주세요". Next turn, check what landed
  with list_proposals / list_staged / list_lore and continue.
- **For a one-sentence, one-line change use the partial-replace tools**: propose_lore_replace /
  propose_memory_replace / propose_card_replace (find -> replace). The propose_*_edit tools rewrite
  the whole body and are only for rewriting an entry as a whole - retyping a long body drops or
  alters sentences. `find` is copied verbatim (whitespace and quotes included) from what read_*
  returned.
- Systematic substitutions are often more accurate done directly with run_python.
  The `import risuhina` helper is ready.
- **Before writing lorebook text, load the skill "RisuAI 로어북 작성 규칙" with load_skill.** The body
  is markdown starting with `### 제목` (#### subheadings + bullets), priority is the insertorder
  number (same tier as its neighbours), keywords are English/Korean/Japanese aliases. Do not put
  SillyTavern-style `@@position` / `@@role` / `@@priority` headers in the body.
- **External facts come from web_search.** For source material, canon, terminology or anything
  recent that is outside your knowledge, use the web_search tool and pass the source URLs to the
  user. If it answers that search is not configured, relay that as it is and never invent facts.
- **Ask with the proposal on the table.** When you want confirmation for an edit ("이대로
  진행할까요?"), stage it first (propose_* / the studio's plan) so the approval card is in front of
  the user with the question - a question with nothing to approve leaves them guessing what
  "진행" means. For actions that only cost money (a batch), state the count and Anlas, then ask.
- **Seeing images.** You cannot see an image unless a vision tool returned it or described it
  THIS turn. Use view_image (one) / compare_images (several) before judging what is drawn, and
  image_metrics for blur, brightness, borders and duplicates without a model. If a tool says
  VISION REFUSED or vision is off, say so and report only the measured numbers - never guess
  the content. Adult content is common here: a refusal is the vision model's limit, not the
  user's fault; point at ⚙ → 에이전트 → 비전 툴 (an uncensored/local helper can be set there).
  After generating, LOOK, then REPORT AND ASK before regenerating: say what you saw, what is
  wrong (if anything), and what one thing you would change - then wait for the user's answer.
  A picture that failed your review may be exactly what the user wanted; regenerating
  discards their Anlas and their pick. Only when the user explicitly asked for an autonomous
  loop ("알아서 고쳐", "N번까지 다시") do generate → view → change ONE thing → regenerate →
  compare on your own, and even then stop after three rounds and report.
- **Know RisuAI's processing order and speak from it.** One turn runs editinput (regex, saved) ->
  start triggers -> editprocess (regex, per request, not saved) -> prompt assembly -> Lua
  editRequest (the whole request array) -> the model -> editoutput (regex, saved) -> output
  triggers -> editdisplay (regex, per render, not saved). Only editinput and editoutput are saved;
  the model sees the editprocess -> editRequest result. Lua listenEdit hooks run before the regex
  of the same stage. Before creating or fixing a regex, a trigger or background HTML, load the
  skill "RisuAI 처리 순서" for the details (flags, @@ commands, the misdiagnosis table).
- Quote the original only from what read_turns actually returned. Never quote from memory.
- Explain briefly what you are about to change and why; when in doubt, ask first.
- **Bot (card) editing follows the same grammar.** See rows with read_card and propose with
  propose_card_edit / propose_greeting_* / propose_regex_* / propose_trigger_*. The card affects
  **every chat** of this bot - never fix one chat's problem in the card. Writing to RisuAI
  (propose_card_writeback) and cloning a bot (propose_clone_bot) touch the RisuAI original:
  get agreement first.
- **You know which of the panel's screens (chat edit / bot edit) is open.** On the chat screen you
  may change chat material only (turns, long-term memory, chat lorebook, chat snapshots, chat
  write-back); on the bot screen card material only (meta, greetings, bot lorebook, Regex,
  triggers, assets, bot snapshots, card write-back). If the material lives on the other screen,
  **first say "○○ 화면으로 이동하겠습니다", propose the move with propose_open_tab, get approval**,
  then continue next turn. Reading and searching work from either screen - you see the whole
  selected bot and chat, not just the current tab.

Workspace rules (mandatory - every bot shares ONE global space):
- `projects/<bot>/`  the reference material and project folder the user manages. **Read freely,
  never reorganise what the user put there.** Uploaded files are usually here. **What you produce
  for the user goes into THIS bot's project folder, in the subfolder that fits** - a lorebook draft
  under `projects/<bot>/로어북/`, a report under `projects/<bot>/보고서/`, a charx under
  `projects/<bot>/out/`. `out/` is the fallback for things with no better home, NOT a dump for
  everything. **Always tell the user the exact path you wrote to** ("`projects/…/보고서/x.md` 에
  저장했습니다 — 파일 탭에서 여실 수 있습니다"). Other bots' project folders are read-only.
- `studio/`  the image library. Material lives under `studio/config/` (styles, characters,
  fragments, scenes, .studio); generated images under `studio/output/`. Read and write. **One-off
  batches use inline spec.scenes** - do not create temporary preset files in `studio/config/scenes/`
  (a reusable temporary spec goes to `studio/config/.studio/adhoc/`). Images for this bot land in
  `studio/output/<bot>/<topic>/` - name the folder after the job (e.g. `표정세트-1차`), and the
  user picks from it on the 검수 tab.
- `hina/<bot>/`  your internal work area - **hidden from the user's screen by default.** Temporary
  files in `scratch/`, scripts in `scripts/`. **Temporary documents and scripts go ONLY here** -
  never leave scratch in projects/ or studio/ (write_file refuses it). Anything the user is meant
  to find must not be put here - they will not see it.
- `system/`  this bot's frozen originals (card, original transcripts). **Read-only.**
- **When you do not know where a file is, find it first with find_files (name glob) /
  search_files (content).** If the result's last line says "N of M shown", tell the user it was cut.
- **Answer in the chat directly** (no separate cards or artifacts). Reports and comparisons are
  markdown; **an image written as `![caption](studio/output/…/file.png)` with a space path renders
  inline** - only paths starting with `studio/…`, `projects/…`, `hina/…` (no drive letters, URLs or
  `..`). studio_generate pushes batch results into the chat as they finish, so do not list them
  again. Keep long documents as files too (write_file) and say where.
- Other bots' folders are visible. Reading is fine; **never modify another bot's folder unasked.**
- **You handle assets (images) too.** list_assets for the list, fetch_assets to pull them into
  scratch/, run_python (PIL) to process, then propose the resulting PNG with propose_asset_add /
  propose_asset_replace. On approval the plugin saves it into RisuAI and attaches it to the card -
  the ONE card change written to RisuAI immediately, without waiting for 반영 (binary, no working
  copy). PNG only.
  An asset's **name and deletion** are card material: see the rows with list_scripts("assetref")
  and fix them with the propose_regex_edit grammar (propose_script_delete / entry replacement) -
  written together at 반영.
  **Several at once = one proposal**: additions via propose_assets_add(list), deletions via
  propose_scripts_delete(ids) - one card per item makes approval as slow as the count and buries
  the screen in cards.
  RisuAI rule: **several assets with the same name = a random pool** ({{asset::name}} picks one at
  random). `_1`, `_2` in charx filenames only make filenames unique; they are not the name. A
  trailing `.png` in a name is usually a mistake (calls use the bare name); bulk removal is the
  card tools' job.
- Nothing outside the global space and system/ can be read or written. Other bots' DBs (chats,
  lore) are not visible.
- Before creating a file, check with find_files whether it exists. Never overwrite a same-named file.
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
# Sessions whose summary the model refused: the mechanical fallback goes
# first from then on, instead of paying for the same refusal every turn.
SUMMARY_REFUSED: set[str] = set()


def _msg_chars(m: Any) -> int:
    n = 0
    for p in getattr(m, "parts", []) or []:
        c = getattr(p, "content", None)
        if isinstance(c, str):
            n += len(c)
        elif isinstance(c, list):
            # A picture attached by a vision tool counts as a short line, not
            # as the repr of its bytes (§1-42).
            for item in c:
                n += len(item) if isinstance(item, str) else 64
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
        elif kind == "user-prompt" and isinstance(c, list):
            bits.append("[사용자] " + " ".join(x if isinstance(x, str) else "[이미지]" for x in c)[:300])
        elif kind == "text" and isinstance(c, str):
            bits.append(f"[에이전트] {c}")
        elif kind == "tool-call":
            bits.append(f"[툴 호출] {getattr(p, 'tool_name', '')}({str(getattr(p, 'args', ''))[:200]})")
        elif kind == "tool-return":
            bits.append(f"[툴 결과 {getattr(p, 'tool_name', '')}] {str(c)[:300]}")
    return "\n".join(bits) if bits else f"[{who}]"


# Tool traffic older than this many user turns is clipped to PRUNE_CLIP chars
# before every turn (§1-44): a run_python transcript or a read_file body from
# ten turns ago is paid for on every later request, and the agent can always
# call the tool again. The clip is deterministic and needs no model.
PRUNE_KEEP_TURNS = 2
PRUNE_CLIP = 600
PRUNE_NOTE = "\n…[{n}자 생략 - 오래된 툴 결과는 잘립니다; 필요하면 툴을 다시 호출]"


def _is_user_turn(m: Any) -> bool:
    return any(getattr(p, "part_kind", "") == "user-prompt" for p in getattr(m, "parts", []) or [])


def _turn_starts(messages: list) -> list[int]:
    return [i for i, m in enumerate(messages) if _is_user_turn(m)]


def _int_cfg(key: str, default: int) -> int:
    try:
        v = config.section("agent").get(key)
        return int(v) if v is not None and str(v).strip() != "" else default
    except (TypeError, ValueError):
        return default


def turn_limits() -> Any:
    """The pydantic-ai UsageLimits for one turn, from the 고급 설정 numbers
    (0 = unlimited)."""
    from pydantic_ai import UsageLimits
    req = _int_cfg("maxRequestsPerTurn", 40)
    calls = _int_cfg("maxToolCallsPerTurn", 30)
    tokens = _int_cfg("maxInputTokensPerTurn", 0)
    return UsageLimits(
        request_limit=req if req > 0 else None,
        tool_calls_limit=calls if calls > 0 else None,
        input_tokens_limit=tokens if tokens > 0 else None,
    )


def prune_tool_parts(messages: list, keep_turns: int | None = None, clip: int | None = None) -> tuple[list, int]:
    """Clip tool returns and oversized tool-call args in every turn but the
    last `keep_turns`. Returns (messages, chars saved); the input is not
    mutated. Idempotent: a clipped part is under the limit already."""
    import dataclasses
    if keep_turns is None:
        keep_turns = max(1, _int_cfg("pruneKeepTurns", PRUNE_KEEP_TURNS))
    if clip is None:
        clip = max(100, _int_cfg("pruneClipChars", PRUNE_CLIP))
    starts = _turn_starts(messages)
    cut = starts[-keep_turns] if len(starts) >= keep_turns else 0
    if cut <= 0:
        return messages, 0
    saved = 0
    out = list(messages)
    for i in range(cut):
        m = out[i]
        parts = list(getattr(m, "parts", []) or [])
        changed = False
        for j, part in enumerate(parts):
            kind = getattr(part, "part_kind", "")
            if kind in ("tool-return", "retry-prompt"):
                c = getattr(part, "content", None)
                if isinstance(c, str) and len(c) > clip + 120:
                    saved += len(c) - clip
                    parts[j] = dataclasses.replace(part, content=c[:clip] + PRUNE_NOTE.format(n=len(c) - clip))
                    changed = True
            elif kind == "tool-call":
                a = getattr(part, "args", None)
                text = a if isinstance(a, str) else (json.dumps(a, ensure_ascii=False) if a is not None else "")
                if len(text) > clip + 120:
                    saved += len(text) - clip
                    # A dict stays a dict: providers re-serialise call args, and
                    # some validate them as JSON on the way back in.
                    stub = {"_clipped": text[:clip], "_note": f"{len(text) - clip}자 생략"}
                    parts[j] = dataclasses.replace(part, args=json.dumps(stub, ensure_ascii=False) if isinstance(a, str) else stub)
                    changed = True
        if changed:
            out[i] = dataclasses.replace(m, parts=parts)
    return out, saved


def _drop_turns(messages: list, budget: int, keep_tail: int) -> tuple[list, list[str]]:
    """Drop whole turns from the front until the rest fits `budget`, never
    fewer than `keep_tail` messages kept. Returns (rest, dropped user prompts)."""
    starts = _turn_starts(messages)
    dropped: list[str] = []
    rest = messages
    while sum(_msg_chars(m) for m in rest) > budget and len(starts) > 1 and len(rest) > keep_tail:
        nxt = starts[1]
        for m in rest[:nxt]:
            for p in getattr(m, "parts", []) or []:
                if getattr(p, "part_kind", "") == "user-prompt" and isinstance(getattr(p, "content", None), str):
                    dropped.append(p.content[:160])
        rest = rest[nxt:]
        starts = [i - nxt for i in starts[1:]]
    return rest, dropped


async def compact_history(session_id: str, messages: list) -> list:
    """Keep the conversation inside the model's budget.

    Three stages, cheapest first. (1) Old tool traffic is clipped every turn
    (prune_tool_parts). (2) Past `agent.historyBudgetChars`, everything but
    the last KEEP_TAIL messages is summarised by the model into one Korean
    note. (3) When the summary fails - the model refusing an adult transcript
    was the §1-44 case, and it failed on EVERY turn of a 100MB session, each
    request carrying the whole thing - whole turns are dropped from the front
    with a plain list of the dropped requests, so the budget holds without a
    model. Called by session.run before each turn (pydantic-ai 2.x has no
    history processor hook). Whatever changed is remembered in COMPACTED so
    session.run stores it - the work is paid for once, not on every later turn.
    """
    budget = int(config.section("agent").get("historyBudgetChars") or 0)
    before = sum(_msg_chars(m) for m in messages)
    messages, saved = prune_tool_parts(messages)
    if saved and session_id:
        COMPACTED[session_id] = messages
        log.info("history pruned session=%s -%s chars", session_id, saved)
    if budget <= 0 or len(messages) <= KEEP_TAIL + 2:
        return messages
    total = before - saved
    if total <= budget:
        return messages
    head, tail = messages[:-KEEP_TAIL], messages[-KEEP_TAIL:]
    # Never cut between a tool call and its return: extend the tail back to a
    # user prompt boundary.
    while head and not _is_user_turn(tail[0]):
        tail.insert(0, head.pop())
        if not head:
            return messages
    from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, UserPromptPart
    transcript = "\n\n".join(_msg_text(m) for m in head)[-120000:]
    summary = ""
    try:
        if session_id in SUMMARY_REFUSED:
            raise RuntimeError("summary skipped: refused earlier in this session")
        summariser = Agent(_model(), instructions=(
            "다음은 편집 도구 안에서 사용자와 에이전트가 나눈 대화 기록이다. 이어서 작업할 수 있도록 "
            "**한국어로 1500자 이내** 요약해라: 사용자가 원한 것, 확정된 결정, 이미 제안·승인된 변경(id 포함), "
            "아직 안 끝난 일, 사용자가 싫어한 것. 인용은 최소한으로."))
        r = await summariser.run(transcript, model_settings={"temperature": 0.1, "max_tokens": 4000})  # type: ignore[arg-type]
        summary = str(r.output).strip()
    except Exception as e:  # noqa: BLE001 - a failed summary must not fail the turn
        log.warn("history compaction failed: %s", str(e).splitlines()[0][:200])
        if session_id and ("content_filter" in str(e) or "PROHIBITED" in str(e) or "SAFETY" in str(e)):
            SUMMARY_REFUSED.add(session_id)
    if summary:
        compacted = [
            ModelRequest(parts=[UserPromptPart(content="[이전 대화 요약 - 앞선 대화는 이 요약으로 대체되었습니다]\n" + summary)]),
            ModelResponse(parts=[TextPart(content="요약을 확인했습니다. 이어서 진행합니다.")]),
        ] + tail
        how = "summary"
    else:
        # Mechanical fallback: drop turns from the front until the rest fits,
        # keeping a bare list of what was asked so the thread is not lost.
        rest, dropped = _drop_turns(messages, budget, KEEP_TAIL)
        if not dropped:
            return messages
        listing = "\n".join(f"- {d}" for d in dropped)[-3000:]
        compacted = [
            ModelRequest(parts=[UserPromptPart(content=(
                f"[이전 대화 {len(dropped)}턴 생략 - 요약 모델이 실패해 앞부분을 잘랐습니다. 생략된 사용자 요청들:]\n" + listing))]),
            ModelResponse(parts=[TextPart(content="확인했습니다. 이어서 진행합니다.")]),
        ] + rest
        how = "drop"
    if session_id:
        COMPACTED[session_id] = compacted
    log.info("history compacted(%s) session=%s %s msgs/%s chars -> %s msgs", how, session_id,
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
        """Skim the turn list. Gives the first line of each turn, not the body.

        The first gate: see the shape of the chat without loading all of it.
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
        """Read turn bodies by range (start..end, both inclusive)."""
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
        """Search this bot's chats for a string. Use it to narrow down which turns to read."""
        hits = store.search(ctx.deps.char_key, query, [ctx.deps.chat_key], limit=limit)
        if not hits:
            return f"'{query}' 로 찾은 턴이 없습니다. (찾지 못한 것이지, 없다는 뜻은 아닙니다)"
        return "\n".join(
            f"#{h['seq']} [{h['role']}] msgId={h['msgId']} … {h['excerpt']}" for h in hits
        )

    @agent.tool
    def read_card(ctx: RunContext[Deps]) -> str:
        """Skim the bot card row by row. These rows are the edit targets - aim propose_card_edit at them.

        First line only, not the body. Read a long field in full with read_card_field(id).
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
        """The full body of one card field."""
        cur = cardmod.get_field(field_id)
        if cur is None:
            return "없는 카드 필드입니다"
        return f"[{cur['field']}#{cur['seq']}]\n{cur['body']}"[:30000]

    @agent.tool
    def list_scripts(ctx: RunContext[Deps], kind: str = "customscript") -> str:
        """The Regex (customscript) or trigger (triggerscript) list, summaries only.

        Read a body (replacement, HTML, trigger definition) with read_script(id) - a background
        HTML entry can be tens of thousands of characters, so the list does not carry it.
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
        """One script entry, full JSON."""
        row = cardmod.script_entry(script_id)
        if row is None:
            return "없는 스크립트 항목입니다"
        return json.dumps(row, ensure_ascii=False, indent=2)[:30000]

    @agent.tool
    def read_lore(ctx: RunContext[Deps]) -> str:
        """The whole lorebook list (same as list_lore). Read a body with read_lore_entry."""
        return list_lore(ctx)

    @agent.tool
    def read_lore_entry(ctx: RunContext[Deps], lore_id: str) -> str:
        """One lorebook entry: full body and settings (key, alwaysActive, folder, insertorder, ...)."""
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
        """The registered skills (name and when to use each). Load a body with load_skill."""
        lines = skills.catalog_lines()
        return "\n".join(lines) if lines else "등록된 스킬이 없습니다"

    @agent.tool
    def load_skill(ctx: RunContext[Deps], name: str) -> str:
        """Load a skill's body. Call it before starting a job the skill covers.

        Follow the returned procedure as written. The skill's files live under `skills/<id>/...`:
        read them with read_file, run them with run_python.
        """
        return skills.load(name)

    @agent.tool
    def read_memory(ctx: RunContext[Deps]) -> str:
        """Long-term memory (HypaMemory / SupaMemory summaries) and the chat variables (scriptstate): list and bodies.

        Chat variables appear as `[scriptstate] key=value`. Propose a value change with
        propose_memory_edit (aimed by id). Keys starting with `$` are the ones {{getvar}} reads.
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
        """Propose editing one long-term memory entry. Applied after approval."""
        cur = mem.get(memory_id)
        if cur is None:
            return "없는 항목입니다"
        return _propose(ctx, "memory_edit",
                        f"장기기억 [{cur['kind']} #{cur['seq']}] 수정 — {reason}",
                        {"id": memory_id, "body": new_body})

    @agent.tool
    def propose_memory_replace(ctx: RunContext[Deps], memory_id: str, find: str, replace: str,
                               reason: str, replace_all: bool = False) -> str:
        """Propose changing only PART of a memory entry (one sentence, one line).

        `find` is a string that occurs exactly once in the body (whitespace and quotes verbatim),
        `replace` is what goes in its place. If it occurs more than once, add context or set
        replace_all=True. Do not rewrite the whole body.
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
        """Propose deleting a long-term memory entry."""
        cur = mem.get(memory_id)
        if cur is None:
            return "없는 항목입니다"
        return _propose(ctx, "memory_delete",
                        f"장기기억 [{cur['kind']} #{cur['seq']}] 삭제 — {reason}",
                        {"id": memory_id})

    @agent.tool
    def list_lore(ctx: RunContext[Deps], scope: str = "") -> str:
        """The lorebook entries. scope is global or local.

        The structure comes with it: `#n` is the array order (adjust with propose_lore_move),
        `folder=` is the containing folder, and a `[folder]` row is the folder itself (a container,
        not an entry - RisuAI stores a folder as a lorebook entry with mode='folder', and membership
        is member.folder == the folder entry's key). Reorganise folders by changing members'
        folder values with propose_lore_edit.
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
        """Propose moving a lorebook entry. to_seq is the target position within the same scope."""
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
        """Propose changing only PART of a lorebook entry's body (use this for one sentence or one line).

        `find` is a string that occurs exactly once in the content (whitespace, quotes and line
        breaks verbatim); `replace` is what goes in its place ("" to delete). If it occurs more than
        once, add surrounding context or set replace_all=True. propose_lore_edit, which rewrites the
        whole body, is only for rewriting the entry as a whole.
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
        """Propose rewriting a lorebook entry AS A WHOLE (content is the complete new body).

        For one part, use propose_lore_replace - rewriting everything risks dropping or altering the
        other sentences. keys, comment and folder left empty, and insert_order = -1, keep their values.
        To change only the priority or keywords, put the original body (from read_lore_entry) in content.
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
        """Propose adding a lorebook entry. Read the skill "RisuAI 로어북 작성 규칙" first.

        content is markdown starting with `### Title` (#### subheadings + bullets). insert_order is
        the priority number (higher survives the budget and lands earlier in the prompt) - ALWAYS set
        it to the same tier as its neighbours (leads 1000, supporting 800-900, world 700, places 600,
        monsters 500, extras 300, the always-on canon list 2000). folder is the key of the folder entry.
        The default scope is this chat's lorebook (local). scope="global" is the bot-wide lorebook and
        affects EVERY chat of this bot - use it only when the user explicitly says the bot lorebook.
        always_active=True means always inserted without keywords - leave keys empty then.
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
        """Propose deleting a lorebook entry."""
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
        """Propose changing only PART of a card field (description, first message, greetings, creator notes...).

        `find` is a string that occurs exactly once in the body, `replace` is what goes in its place.
        To change one sentence of a long description use this, not a full rewrite. id comes from read_card.
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
        """Propose rewriting one card field (description, personality, first message, greeting...) AS A WHOLE.

        new_body is the complete new body. For one part, use propose_card_replace. The card affects
        every chat of this bot. id comes from read_card.
        """
        cur = cardmod.get_field(field_id)
        if cur is None:
            return "없는 카드 필드입니다"
        return _propose(ctx, "card_edit",
                        f"카드 {cur['field']} 수정 — {reason}",
                        {"id": field_id, "body": new_body})

    @agent.tool
    def propose_greeting_add(ctx: RunContext[Deps], body: str, reason: str) -> str:
        """Propose adding an alternate greeting (alternateGreetings)."""
        return _propose(ctx, "card_greeting_add", f"대체 인사말 추가 — {reason}",
                        {"body": body})

    @agent.tool
    def propose_greeting_delete(ctx: RunContext[Deps], field_id: str, reason: str) -> str:
        """Propose deleting an alternate greeting. id comes from read_card."""
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
        """Propose editing a Regex (customscript) entry. Empty arguments leave the field as it is.

        Fields not listed here are preserved as they were. Background HTML is replaced whole via
        out_text - read the current value with read_script first.
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
        """Propose adding a Regex (customscript) entry.

        script_type: editinput | editoutput | editdisplay | editprocess etc.
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
        """Propose editing a trigger (triggerscript) entry.

        Triggers vary in shape (V1 conditions/effects, Lua triggerCode, V2 blocks): edit the full JSON
        read with read_script and pass it as entry_json.
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
        """Propose adding a trigger (triggerscript) entry. entry_json is the entry's full JSON."""
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
        """Propose deleting SEVERAL Regex / trigger / asset-reference (assetref) entries at once (one card).

        script_ids: comma-separated ids. Always use this for two or more - calling
        propose_script_delete per entry stacks up one card each.
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
        """Propose deleting a Regex or trigger entry (for several, propose_scripts_delete)."""
        cur = cardmod.script_entry(script_id)
        if cur is None:
            return "없는 스크립트 항목입니다"
        label = (cur["entry"] or {}).get("comment") or script_id
        kind = "Regex" if cur["kind"] == "customscript" else "트리거"
        return _propose(ctx, "script_delete", f"{kind} “{label}” 삭제 — {reason}",
                        {"id": script_id})

    @agent.tool
    def propose_open_tab(ctx: RunContext[Deps], tab: str, reason: str) -> str:
        """Propose moving the panel to another tab. Approval opens that tab.

        Use it when the material to edit lives on a tab other than the one showing - e.g. a
        description (meta) fix comes up while talking on the lorebook tab:
        propose_open_tab("meta", "이 항목은 메타 수정이 필요합니다").
        tab: editor (chat edit) lore (chat lorebook) memory (long-term memory) vars (chat variables)
             meta botlore regex trigger assets files (workspace files)
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
        """The bot (card) snapshots. Separate from chat snapshots."""
        rows = snapshots.listing_card(ctx.deps.char_key)
        if not rows:
            return "봇 스냅샷이 없습니다"
        return "\n".join(f"id={r['id']} {r['label'] or '(이름 없음)'}" for r in rows)

    @agent.tool
    def propose_bot_snapshot(ctx: RunContext[Deps], label: str) -> str:
        """Propose saving a bot snapshot (card, scripts, bot lorebook)."""
        return _propose(ctx, "card_checkpoint_create", f"봇 스냅샷 저장 — {label}",
                        {"label": label})

    @agent.tool
    def propose_bot_restore(ctx: RunContext[Deps], snapshot_id: str, reason: str) -> str:
        """Propose restoring a bot snapshot. Overwrites the card working copy wholesale."""
        return _propose(ctx, "card_checkpoint_restore",
                        f"봇 스냅샷 {snapshot_id} 로 되돌리기 — {reason} (카드 작업본을 덮어씁니다)",
                        {"id": snapshot_id})

    @agent.tool
    def propose_card_writeback(ctx: RunContext[Deps], reason: str) -> str:
        """Propose actually writing the card edits (meta, greetings, bot lorebook, Regex, triggers) to RisuAI.

        The write needs this bot selected in RisuAI. On approval the plugin performs it.
        """
        return _propose(ctx, "host_card_writeback", f"카드를 RisuAI에 반영 — {reason}", {})

    # --- assets ---------------------------------------------------------------

    @agent.tool
    def list_assets(ctx: RunContext[Deps]) -> str:
        """The assets (images etc.) this bot references: field, name, format, size, store status.

        Only status `present` can be fetched with fetch_assets; `missing` is not synced yet.
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
        """Fetch assets into the workspace scratch/assets/. Comma-separated for several.

        Open the returned paths with PIL in run_python. Several of the same name (a random pool)
        get _1, _2. An 'assets/...' key is accepted instead of a name.
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
        """Propose adding a PNG from the workspace as one of this bot's assets.

        path: a space path (studio/..., projects/<bot>/..., hina/<bot>/scratch/...), PNG only.
        field: additional (extra asset, default) | emotion (emotion image).
        On approval the plugin saves it into RisuAI and attaches it to the card - written
        immediately, independent of 반영.
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
        """Propose adding SEVERAL PNGs as this bot's assets at once (one proposal card).

        items_json: `[{"name": "...", "path": "..."}, ...]` - for two or more, always use this.
        (propose_asset_add per image stacks up one card each and makes approval that much slower.)
        field: additional | emotion. On approval the plugin saves them all and attaches them to the card in one go.
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
        """Change a style/character card's enabled flag or order (cards carry their own on/off, like lorebook entries).

        enabled: "true" | "false" | "" (unchanged). order: 0 = unchanged, else an integer (lower joins
        earlier, default 100). The enabled cards are the default set when a spec names no
        styles/characters - check with studio_plan before changing.
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
        """Plan a batch (creates nothing). Check with this first, then studio_generate.

        spec fields (all optional; cards by path or by DISPLAY NAME - a name such as "오피스 카운셀링"
        is matched exactly, and an ambiguous one is refused with the candidates listed):
          model          default nai-diffusion-4-5-full
          styles         ["studio/config/styles/....md", "name", ...] - omitted = the enabled cards,
                         an explicit [] = "no style"
          characters     paths/names (omitted = the enabled cards). A dict makes an ad-hoc
                         character ({"caption","negative","position"}) - but a dict carries no card
                         preset (reference)
          scenes         inline scene list [{"name","prompt","negativePrompt","width","height"}, ...]
                         - for a ONE-OFF run use this, not a preset file
          scenePreset    preset file path/name. With `only:["angry","happy"]` only those scenes are
                         drawn (works with a scenePreset path only)
          count / seed   images per scene, the seed (given: +1 per image within a scene)
          characterName  the character slot of the filename (unrelated to the prompt)
          folder         save folder (default studio/output/<bot>)
          template       filename rule (default {character}-{emotion}-{stamp}-{n}; an empty field
                         drops with its delimiter)
          useReference   true = the enabled character cards' presets ride along (character reference
                         or vibe - the card's refMode decides)
          extra / negativeExtra   appended to the prompt / negative
          params         {"steps","scale","cfg_rescale","sampler","noise_schedule","width","height",
                         "qualityToggle","ucPreset", ...} - unknown keys pass through as they are

        Library files are read and written with the ordinary file tools (read_file / write_file).
        A style .md is front matter + `## positive` / `## negative`. SD-studio presets
        (studio/config/scenes/) are the scene-preset format; one scene is one image of the batch.
        An EXPRESSION SET is drawn one image per scene with ordinary generation (not the director
        emotion tool: ten times the cost and no control).
        `{{...}}` inside a prompt is NovelAI emphasis syntax - NEVER touch it.
        `<fragment>`, `<folder/fragment>` and `<collection.key>` refer to studio/config/fragments/
        (a fragment card's front-matter name also resolves) and are substituted right before
        generation - `unresolved` in the plan result are references that were not found. A
        MULTI-LINE fragment contributes ONE random line per image (# comments and blank lines
        excluded; <references> inside the chosen line recurse).
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
        """Run a batch (the same spec as studio_plan; an empty model means the default).

        The default (wait=true) WAITS until the end and pushes each finished image into the chat as
        it lands - the user watches progress live. The return value is the final result
        (saved/failed/Anlas). To queue a very large batch and do other work, wait=false returns the
        job id only; check with studio_job.
        Batches are GLOBALLY SERIAL - several jobs wait in order (NovelAI locks concurrent generation
        per account). Do not stack per-character jobs at once; check one batch's result, then start
        the next.
        References have a definite cost - vibe encoding 2 Anlas per image (0 when cached), a character
        reference 5 Anlas PER GENERATED IMAGE - tell the user before using them.
        Send one-off scene sets inline as spec.scenes; a temporary spec meant for reuse goes to
        `studio/config/.studio/adhoc/` via write_file, not to studio/config/scenes/.
        The spec is ONE object OR AN ARRAY of objects - an array runs one job per element, in order
        (a batch file holding several specs is passed as it is).
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
        from . import session as session_mod
        session_mod.note_job(ctx.deps.session_id, job_id)
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
        """Open the panel's asset studio on its 검수 (review) tab at this folder - the screen where the user picks and adopts.

        Call it when a batch is done and you say "please review", or when the user wants to look at
        a folder. The folder is a space path such as `studio/output/...`.
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
        """Batch progress. Without job_id, the recent batch list."""
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
        """Split the filenames of an output folder with a regex. ALWAYS report the files that did not match.

        Names are not deterministic - that is why this tool exists. When something does not match,
        fix the regex or propose a bulk rename with studio_rename to the user.
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
        """Rename output files IN BULK. rename_json = [{"from":"a.png","to":"b.png"}, ...]

        FIRST run with apply=false, show the user, THEN apply=true. Names that break the rule keep
        the comparison selector from forming groups - this tool is the way to fix that, and
        studio_parse's "did not match" list is its input.
        If even one problem exists (a clash, a missing source) NOTHING is renamed.
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
        """Gather output images into groups (what the comparison selector shows).

        Files that did not match are reported first - they are what studio_rename fixes.
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
        """Export the chosen images into `selected/`. A group with nothing chosen leaves an empty .txt.

        That .txt marks "nothing here yet"; regenerate only those.
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
        """Propose adding studio images as assets of the currently selected bot.

        paths/names are comma-separated and equal in count (paths[i] becomes names[i]).
        field: emotion (emotion image) | additional (extra asset).
        The images are COPIED from the library into the bot workspace and then ride the ordinary
        asset-add path - written to RisuAI on approval. A bot must be selected.
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
        """Redraw only part of an image. The original stays; the result is a new file with `-fix` appended.

        boxes_json = [{"x":0.25,"y":0.15,"w":0.5,"h":0.35}] - RATIOS 0..1.
        (x,y is the top-left corner, w,h width/height. Several boxes are allowed.)
        Only the inside of the boxes changes; the OUTSIDE stays exactly as the original.

        The cost depends on the account tier. Anlas is compared before and after and the actual
        charge reported, so confirm with one image before running several.
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
        # The panel learns of the new file the way it does for a batch: the
        # strip shows it and the 검수 grid re-reads the folder (§1-48).
        from . import session as session_mod
        out_path = str(r["path"])
        session_mod.push_stream_event(ctx.deps.session_id, {
            "type": "images", "paths": [out_path], "folder": out_path.rsplit("/", 1)[0] if "/" in out_path else "",
            "label": "inpaint",
        })
        return (f"{r['path']} 로 저장했습니다 ({r['size'] // 1024}KB)."
                + (f" Anlas {before} → {after} ({spent} 소모)." if spent is not None else ""))

    @agent.tool
    def studio_naming(ctx: RunContext[Deps]) -> str:
        """The emotion-asset names this bot actually uses. Naming differs per bot, so read it here."""
        if not ctx.deps.char_key:
            return "봇이 선택돼 있지 않습니다"
        r = studio.naming_from_bot(ctx.deps.char_key)
        if not r["hasConvention"]:
            return r["note"] + f" 기본 이름 규칙: {r['template']}"
        return r["note"] + "\n" + ", ".join(r["emotionNames"])

    @agent.tool
    def studio_duplicates(ctx: RunContext[Deps], folder: str) -> str:
        """Find byte-identical images within a folder (deletes nothing).

        These are re-runs with the same seed or copies. One to keep and the rest are shown; whether to
        delete is the user's call - a duplicate is not automatically trash. To delete, ask the user
        and propose a files deletion rather than using studio_delete.
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
        """Compare this bot's emotion assets against what should exist.

        Given an SD-studio preset path (scenes/....json) it reports the MISSING SLOTS - regenerate only
        those. Assets whose name never appears in the card's scripts or body are reported separately
        as UNREFERENCED.
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
        """Read the generation parameters NAI left inside a PNG. Images made elsewhere are readable too.

        Use it for "more like this one, same settings".
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
        """Propose replacing only the picture of an asset, name unchanged (PNG). CBS references are unaffected."""
        try:
            info = assets.stage_file(path)
        except (assets.AssetError, files.FileError) as e:
            return str(e)
        return _propose(ctx, "host_asset_replace",
                        f"에셋 교체 “{name}” ({info['size'] // 1024}KB) — {reason}",
                        {"name": name, "path": info["path"], "ext": "png"})

    @agent.tool
    def propose_clone_bot(ctx: RunContext[Deps], name: str, reason: str) -> str:
        """Propose creating a clone bot in RisuAI carrying the current edits.

        The original bot is untouched. Assets share their references, so the clone is instant.
        """
        return _propose(ctx, "host_clone_bot", f"복제 봇 “{name}” 생성 — {reason}",
                        {"name": name})

    # --- the jobs the panel can do, so the agent can too ---------------------

    @agent.tool
    def list_snapshots(ctx: RunContext[Deps]) -> str:
        """The saved snapshots - to pick a point to restore."""
        rows = snapshots.listing(ctx.deps.chat_key)
        if not rows:
            return "스냅샷이 없습니다"
        return "\n".join(
            f"id={r['id']} {r['label'] or '(이름 없음)'} · {r['message_count']}턴" for r in rows)

    @agent.tool
    def propose_snapshot(ctx: RunContext[Deps], label: str) -> str:
        """Propose saving the current state as a snapshot.

        It creates a restore point and is not risky, but the user should know about it before a big job.
        """
        return _propose(ctx, "checkpoint_create", f"스냅샷 저장 — {label}", {"label": label})

    @agent.tool
    def propose_restore(ctx: RunContext[Deps], snapshot_id: str, reason: str) -> str:
        """Propose restoring a snapshot. Overwrites the current working copy wholesale."""
        return _propose(ctx, "checkpoint_restore",
                        f"스냅샷 {snapshot_id} 로 되돌리기 — {reason} (현재 작업본을 덮어씁니다)",
                        {"id": snapshot_id})

    @agent.tool
    def propose_writeback(ctx: RunContext[Deps], reason: str) -> str:
        """Propose actually writing the edits so far into the RisuAI chat.

        This is the one thing the backend cannot do - the API that writes to RisuAI exists only inside
        the plugin. On approval the plugin performs it.
        """
        return _propose(ctx, "host_writeback", f"RisuAI에 반영 — {reason}", {})

    @agent.tool
    def propose_save_copy(ctx: RunContext[Deps], name: str, reason: str) -> str:
        """Propose saving the current state as a new chat copy in RisuAI.

        A way to keep the result without touching the original - worth suggesting before a big edit.
        """
        return _propose(ctx, "host_save_copy", f"복사본 저장 “{name}” — {reason}",
                        {"name": name})

    @agent.tool
    def list_proposals(ctx: RunContext[Deps]) -> str:
        """Proposals not yet approved (transcript edits excluded)."""
        rows = actions.pending(ctx.deps.chat_key)
        if not rows:
            return "대기 중인 제안이 없습니다"
        return "\n".join(f"id={r['id']} [{r['kind']}] {r['summary']}" for r in rows)

    # --- proposing (never applied directly) ---------------------------------

    @agent.tool
    def stage_edit(ctx: RunContext[Deps], msg_id: str, new_body: str, reason: str) -> str:
        """Propose an edit to one turn. Nothing changes until approval."""
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
        """Propose edits to several turns as one bundle.

        edits: [{"msg_id": "...", "new_body": "..."}, ...]
        A bundle is approved and applied as a whole.
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
        """Propose deleting a turn. Nothing is deleted until approval."""
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
        """The proposals currently awaiting approval."""
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
        """Write a file. A bare name lands in projects/<bot>/out/; a path lands where it says.

        Writable: this bot's own project folder anywhere below it (projects/<bot>/...), studio/, and
        hina/. Put a deliverable where it belongs and NAME THE PATH in your answer - a lorebook draft
        next to the bot's reference material (projects/<bot>/로어북/...), a report in
        projects/<bot>/보고서/..., images in studio/output/<bot>/<topic>/. out/ is the fallback for
        things with no better home, not a dump. Other bots' project folders and anything else are
        refused. Overwrites - check with find_files first.
        """
        rel = (name or "").replace("\\", "/").strip("/")
        area = rel.split("/", 1)[0]
        own = f"projects/{workspace.bot_folder(ctx.deps.char_key)}"
        if area == "projects" and not (rel == own or rel.startswith(own + "/")):
            # Other bots' project trees stay read-only. This bot's own project
            # folder is writable anywhere below it (§1-41): deliverables go
            # to the subfolder that fits them, not all into out/.
            return (f"Only this bot's project folder is writable: {own}/… . "
                    "Other bots' folders are read-only; scratch belongs in hina/<bot>/scratch/.")
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
        """List files in the global space. Empty = the top level (projects, studio, hina).

        `system/` is this bot's frozen originals (read-only): system/original/<chat>.md etc.
        """
        try:
            scope, rel = _fs(ctx, directory)
            return files.agent_list(scope, rel)
        except files.FileError as e:
            return str(e)

    @agent.tool
    def read_file(ctx: RunContext[Deps], path: str) -> str:
        """Read a file from the global space (or system/). Reference material is usually under projects/<bot>/."""
        try:
            scope, rel = _fs(ctx, path)
            return files.agent_read(scope, rel)
        except files.FileError as e:
            return str(e)

    IMAGE_EXT = re.compile(r"\.(png|jpe?g|gif|webp|avif|bmp)$", re.I)

    @agent.tool
    def find_files(ctx: RunContext[Deps], pattern: str, base: str = "", limit: int = 200) -> str:
        """Find files in the global space by glob (e.g. "*.png", "히나*", "projects/*/메모/*.md").

        A pattern with a slash matches the whole path, otherwise the file name. When you do not know
        where a file is, look here first. If the result is truncated, the last line says so - relay it.
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
        """Search the contents of text files in the global space (substring, case-insensitive).

        A glob narrows the paths (e.g. "projects/히나/*"). At most 5 lines per file. The last line says
        how many files were scanned and how many were cut - relay it.
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
        """Run a shell command (cmd / bash) in the workspace. NEEDS THE USER'S PERMISSION -
        a prompt appears in the panel; allowed runs, refused returns "refused".

        Only for what run_python cannot do (external tools, conversion programs). `reason` is shown to
        the user. Never propose a command that touches anything outside the workspace.
        """
        ws = workspace.hina_dir(ctx.deps.char_key)
        ok = await _permitted(ctx, "shell", permits.safe_summary(command), f"이유: {reason}\n\n{command}\n\n작업 폴더: {ws}")
        if not ok:
            return "사용자가 이 명령을 허용하지 않았습니다. 다른 방법을 찾거나 사용자에게 물어보세요."
        return _fmt(permits.run_shell(command, ws))

    @agent.tool
    async def pip_install(ctx: RunContext[Deps], packages: str, reason: str) -> str:
        """Install Python packages (comma-separated for several). NEEDS THE USER'S PERMISSION.

        Use it when an import failed in run_python. Installs into this backend's interpreter.
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

    # --- seeing images (§1-42) -------------------------------------------------
    # Always registered, like web_search: when vision is off the tools still
    # return the measured numbers and say why the picture was not looked at.
    async def view_image(ctx: RunContext[Deps], path: str, question: str = "") -> Any:
        """Look at ONE image in the space (studio/..., projects/..., hina/...) and answer a
        question about it: what is drawn, whether it matches the intended prompt, hands/eyes/limbs,
        cropping, text or watermarks. ALWAYS call this before saying anything about an image's
        content - never describe an image you have not viewed in this turn.

        What comes back depends on the vision setting: your own model sees the picture (it is
        attached right after this result), or a helper model's description, plus measured numbers
        (size, brightness, sharpness, letterbox, near-duplicates) and, for NAI PNGs, the embedded
        prompt/seed. If the result starts with VISION REFUSED, you have NOT seen the image: report
        only the numbers and tell the user the vision model declined.
        """
        return await vision.view(ctx.deps.session_id, [path], question)

    async def compare_images(ctx: RunContext[Deps], paths: str, question: str = "") -> Any:
        """Look at 2-6 images at once (comma- or newline-separated space paths) and rank or contrast
        them: which best matches the prompt, what differs, which are near-duplicates. Cheaper
        than several view_image calls. Same rules as view_image (VISION REFUSED = not seen).
        """
        rels = [p.strip() for p in re.split(r"[,\n]", paths or "") if p.strip()]
        return await vision.view(ctx.deps.session_id, rels, question, label=f"비교 {len(rels)}장")

    @agent.tool
    def image_metrics(ctx: RunContext[Deps], path: str) -> str:
        """Numbers only, no model: size, format, brightness, contrast, sharpness (blur),
        letterbox borders, near-duplicates in the same folder (perceptual hash) and the NAI
        prompt/seed when embedded. Works when vision is off or refused. Use it to pre-filter a
        large folder before looking at candidates.
        """
        try:
            m = vision.metrics(path)
            return vision.fmt_metrics(m, vision.near_duplicates(path))
        except vision.VisionError as e:
            return f"cannot measure: {e}"
        except Exception as e:  # noqa: BLE001
            return f"metrics failed: {type(e).__name__}: {str(e)[:200]}"

    agent.tool(view_image)
    agent.tool(compare_images)

    async def review_folder(ctx: RunContext[Deps], folder: str, criteria: str = "", pattern: str = "",
                            group_by: str = "", limit: int = 24) -> Any:
        """Gather a folder's candidates for review: the groups (by the filename rule), numbers per
        file (blur, brightness, borders, duplicates) and - in helper mode - a verdict per image from
        the vision helper against `criteria`; in native mode the images are attached for you to judge
        (up to `limit`, largest groups first). Read the result, decide, then write your verdicts with
        suggest_selection. This call changes nothing. `criteria` says what a keeper looks like
        (e.g. "smiling, full face visible, hands correct"); `pattern`/`group_by` are studio_group's.
        """
        return await _review_folder(ctx, folder, criteria, pattern, group_by, limit)

    async def _review_folder(ctx: RunContext[Deps], folder: str, criteria: str, pattern: str,
                             group_by: str, limit: int) -> Any:
        from pydantic_ai.messages import ToolReturn
        try:
            g = studio.group(folder, pattern, group_by or "emotion")
        except studio.StudioError as e:
            return f"cannot read the folder: {e}"
        items = [(grp["key"], it) for grp in sorted(g["groups"], key=lambda x: -len(x["items"])) for it in grp["items"]]
        items += [("(unmatched)", it) for it in g["unmatched"]]
        if not items:
            return f"{g['folder']}: no images."
        limit = max(1, min(48, int(limit or 24)))
        lines = [f"{g['folder']} · {g['total']} images · {len(g['groups'])} groups · 못 읽음 {len(g['unmatched'])}"]
        try:
            dup = studio.duplicates(folder)
            if dup.get("groups"):
                lines.append("byte-identical duplicates: " + "; ".join(", ".join(x) for x in dup["groups"][:8]))
        except Exception:  # noqa: BLE001
            pass
        shown = items[:limit]
        for key, it in shown:
            try:
                m = vision.metrics(it["path"])
                extra = (f" · 밝기 {m.get('brightness')} · {m.get('sharpnessLabel', '')}"
                         + (" · 레터박스" if any((m.get("letterbox") or {}).values()) else "")) if "brightness" in m else ""
            except Exception:  # noqa: BLE001
                extra = ""
            flags = it.get("selection") or {}
            fl = "".join(k[0] for k in ("use", "inpaint", "delete") if flags.get(k)) or "-"
            lines.append(f"  {it['filename']}  group={key}  flags={fl}{extra}")
        if len(items) > limit:
            lines.append(f"  … {len(items) - limit} more not shown (raise limit or narrow with pattern)")
        m = vision.mode()
        if m == "off" or not vision.ready():
            lines.append(f"(vision not available - numbers only; {vision.why_not()})")
            return "\n".join(lines)
        crit = criteria.strip() or "a clean, complete image that matches its group name"
        if m == "helper":
            # One helper call per batch of images, asking for JSON verdicts.
            verdict_lines = []
            batch: list = []
            for key, it in shown:
                batch.append((key, it))
                if len(batch) == vision.max_images():
                    verdict_lines += await _helper_verdicts(ctx, batch, crit)
                    batch = []
            if batch:
                verdict_lines += await _helper_verdicts(ctx, batch, crit)
            lines.append("")
            lines.append("helper verdicts (write the ones you agree with via suggest_selection):")
            lines += verdict_lines
            return "\n".join(lines)
        # native: attach the pictures
        loaded = []
        for key, it in shown:
            try:
                loaded.append(vision.load_image(it["path"]))
            except vision.VisionError:
                continue
        if not loaded:
            return "\n".join(lines)
        session_mod = __import__("app.session", fromlist=["push_stream_event"]) if False else None  # noqa: F841
        vision._push(ctx.deps.session_id, {"type": "viewed", "paths": [x.rel for x in loaded],
                                           "label": f"폴더 검수 {len(loaded)}장", "mode": "native"})
        lines.append("")
        lines.append(f"The {len(loaded)} images are attached below, labelled [n] in the same order as the list. "
                     f"Criteria: {crit}. Decide per image, then call suggest_selection.")
        return ToolReturn(return_value="\n".join(lines), content=vision._image_content(loaded))

    async def _helper_verdicts(ctx: RunContext[Deps], batch: list, criteria: str) -> list[str]:
        loaded = []
        names = []
        for key, it in batch:
            try:
                loaded.append(vision.load_image(it["path"]))
                names.append(it["filename"])
            except vision.VisionError as e:
                names.append(it["filename"])
                loaded.append(None)
        real = [x for x in loaded if x is not None]
        if not real:
            return [f"  {n}: cannot load" for n in names]
        n = vision._take_call(ctx.deps.session_id)
        if n is None:
            return [f"  {x.rel.split('/')[-1]}: (vision budget used up)" for x in real]
        q = (f"Criteria for a keeper: {criteria}. For EACH image, answer as a JSON list only: "
             f'[{{"n": 1, "verdict": "use|delete|inpaint", "reason": "one short sentence"}}, …]. '
             "use = keep as is, inpaint = keep but a part needs fixing, delete = discard.")
        try:
            text = await vision.describe_with_helper(real, q)
        except vision.RefusalError as e:
            return [f"  {x.rel.split('/')[-1]}: VISION REFUSED ({e.code}) - numbers only" for x in real]
        except Exception as e:  # noqa: BLE001
            return [f"  {x.rel.split('/')[-1]}: helper failed - {type(e).__name__}" for x in real]
        vision._push(ctx.deps.session_id, {"type": "viewed", "paths": [x.rel for x in real],
                                           "label": "폴더 검수 (helper)", "mode": "helper"})
        raw = text.strip()
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
        out = []
        try:
            arr = json.loads(raw)
            by_n = {int(x.get("n")): x for x in arr if isinstance(x, dict) and str(x.get("n", "")).isdigit()}
            for i, x in enumerate(real, 1):
                v = by_n.get(i) or {}
                out.append(f"  {x.rel.split('/')[-1]}: {v.get('verdict', '?')} - {str(v.get('reason') or '')[:160]}")
        except Exception:  # noqa: BLE001
            out.append("  (helper did not answer in JSON) " + raw[:600].replace("\n", " "))
        return out

    @agent.tool
    def suggest_selection(ctx: RunContext[Deps], folder: str, suggestions_json: str) -> str:
        """Write SUGGESTIONS (not decisions) into a folder's 검수 tab. suggestions_json is a JSON
        list of {"file": "name.png", "verdict": "use|delete|inpaint|none", "reason": "…"}; "none"
        clears an earlier suggestion. The user sees an 'AI 제안' badge per image and applies or
        ignores it. Afterwards say exactly: 검수 탭에 제안을 적었습니다 — 확인해 주세요. Never
        delete, export or adopt on the strength of a suggestion.
        """
        try:
            items = json.loads(suggestions_json)
            if not isinstance(items, list):
                return "suggestions_json must be a JSON list."
            by = ("helper " + vision._helper()[2]) if vision.mode() == "helper" else (config.section("agent").get("model") or "agent")
            r = studio.merge_suggestions(folder, items, by=str(by)[:80])
        except (ValueError, studio.StudioError) as e:
            return f"could not write suggestions: {e}"
        vision._push(ctx.deps.session_id, {"type": "suggestions", "folder": r["folder"], "count": r["count"],
                                           "use": r["use"], "delete": r["delete"], "inpaint": r["inpaint"]})
        note = f"wrote {r['count']} suggestions to {r['folder']} (use {r['use']}, delete {r['delete']}, inpaint {r['inpaint']}"
        note += f", cleared {r['cleared']})" if r["cleared"] else ")"
        if r["unknown"]:
            note += f"; not in the folder: {', '.join(r['unknown'][:8])}"
        return note + " — the user decides in the 검수 tab."

    agent.tool(review_folder)

    return agent

