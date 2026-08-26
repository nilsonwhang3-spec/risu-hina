"""Provider profiles, the per-request parameter plan, and error hints.

Every endpoint the agent talks to is addressed as "OpenAI-compatible", but no
two of them accept the same request fields. OpenAI's own reasoning models
reject `temperature`; the subscription backend rejects `max_output_tokens`;
Gemini's shim rejects names it has never heard of; Anthropic's ignores them.
Hard-coding a parameter set therefore breaks somewhere every time.

So the parameters are data, not code:

* A **profile** per known provider (matched by the base URL's host) supplies
  defaults - which field carries the output cap, whether tool definitions may
  say `strict`, fields the endpoint is known to reject - plus the guidance the
  settings screen shows (auth format, model name shape, an example JSON).
* The preset's **parameter JSON** wins over the profile. Keys are the real
  request field names. A value sets the field; `null` means "do not send it",
  even if the code or the profile would have.
* When an endpoint still rejects a field, `hint()` turns the error into the
  exact JSON to paste, instead of leaving the user with a library message.

The plan is consumed by agent._model_for (client + model profile),
presets.model_settings (pydantic-ai settings) and the connection test.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

# --- known request fields --------------------------------------------------------

# Raw chat/completions field -> pydantic-ai model-settings key. Anything not
# here travels in `extra_body`, verbatim.
SETTING_OF: dict[str, str] = {
    "temperature": "temperature",
    "top_p": "top_p",
    "reasoning_effort": "openai_reasoning_effort",
    "store": "openai_store",
    "service_tier": "openai_service_tier",
    "prompt_cache_key": "openai_prompt_cache_key",
    "prompt_cache_retention": "openai_prompt_cache_retention",
    "user": "openai_user",
    "seed": "seed",
    "stop": "stop_sequences",
    "presence_penalty": "presence_penalty",
    "frequency_penalty": "frequency_penalty",
    "logit_bias": "logit_bias",
    "parallel_tool_calls": "parallel_tool_calls",
    "logprobs": "openai_logprobs",
    "top_logprobs": "openai_top_logprobs",
    "extra_headers": "extra_headers",
}
# The two spellings of the output cap. Which one is sent is a choice, not a
# value, so they are handled apart from SETTING_OF.
CAP_FIELDS = ("max_completion_tokens", "max_tokens")
# Fields pydantic-ai adds on its own; `null` on these is honoured by popping
# them from the request in agent._client rather than by omitting a setting.
LIBRARY_FIELDS = ("stream_options", "parallel_tool_calls", "tool_choice", "response_format", "n")
# `strict` is not a top-level field - it sits in every tool definition - but
# "strict": false is the natural way to say "do not mark tools strict".
PSEUDO_FIELDS = ("strict", "api")
# Responses-API spellings of chat fields, so one `null` covers both APIs.
RESPONSES_ALIAS = {"max_tokens": "max_output_tokens", "max_completion_tokens": "max_output_tokens",
                   "reasoning_effort": "reasoning"}

KNOWN_FIELDS = tuple(SETTING_OF) + CAP_FIELDS + LIBRARY_FIELDS + PSEUDO_FIELDS + ("tools", "extra_body")

MAX_PARAMS_CHARS = 4000


# --- profiles ---------------------------------------------------------------------

# Keys:
#   id, name           what the key page shows
#   api                the OpenAI-compatible base URL ('' = varies, see note)
#   hosts              substrings of the URL host that identify the provider
#   auth               how the key travels (shown on the key page)
#   modelExample       a model name in this provider's format
#   endpoint           "chat" | "responses" - which API the agent uses by default
#   capField           which field carries the output cap
#   strictTools        whether tool definitions may carry "strict": true
#   unsupported        fields this endpoint rejects - never sent
#   modelRules         [{prefix:[...], exceptContains:[...], unsupported:[...], endpoint?, note}]
#                      per-model-family refinements of `unsupported`
#   template           example parameter JSON for this provider
#   note               guidance shown in the settings screens (Korean)
#   docs               the page the above came from
PROFILES: list[dict[str, Any]] = [
    {
        "id": "openai",
        "name": "OpenAI 공식",
        "api": "https://api.openai.com/v1",
        "hosts": ["api.openai.com"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "gpt-5.6",
        "endpoint": "responses",
        "capField": "max_completion_tokens",
        "strictTools": True,
        "unsupported": [],
        "modelRules": [
            {
                "prefix": ["gpt-5", "o1", "o3", "o4"],
                "exceptContains": ["chat"],
                "unsupported": ["temperature", "top_p", "presence_penalty", "frequency_penalty",
                                "logprobs", "top_logprobs", "logit_bias"],
                "note": "GPT-5 · o 계열(사고 모델)은 temperature 등 샘플링 파라미터를 거부합니다(기본값 1만 허용). "
                        "세기는 reasoning_effort(none·low·medium·high·xhigh) 로 조절합니다.",
            },
        ],
        "template": {"reasoning_effort": "medium"},
        "note": "기본으로 Responses API(/responses) 를 씁니다 — gpt-5.6 계열은 Chat Completions 에서 툴 호출을 거부합니다. "
                "Chat Completions 로 돌리려면 JSON 에 {\"api\": \"chat\"} 을 넣고 reasoning_effort 를 none 으로 두세요.",
        "docs": "https://developers.openai.com/api/docs/guides/reasoning",
    },
    {
        "id": "anthropic",
        "name": "Anthropic 공식 (OpenAI 호환 계층)",
        "api": "https://api.anthropic.com/v1",
        "hosts": ["api.anthropic.com"],
        "auth": "Authorization: Bearer <API 키> (Anthropic 키 그대로)",
        "modelExample": "claude-sonnet-4-6",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": [],
        "modelRules": [],
        "template": {"max_tokens": 32000, "extra_body": {"thinking": {"type": "enabled", "budget_tokens": 4096}}},
        "note": "모르는 필드는 조용히 무시합니다(reasoning_effort·store·seed 등, 오류 아님). temperature 는 0~1. "
                "확장 사고는 extra_body.thinking 으로 켭니다. Anthropic 스스로 '실험·비교용' 이라고 밝힌 계층입니다.",
        "docs": "https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk",
    },
    {
        "id": "google",
        "name": "Google AI Studio (Gemini)",
        "api": "https://generativelanguage.googleapis.com/v1beta/openai",
        "hosts": ["generativelanguage.googleapis.com"],
        "auth": "Authorization: Bearer <Gemini API 키>",
        "modelExample": "gemini-2.5-flash",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": [],
        "modelRules": [],
        "template": {"reasoning_effort": "low"},
        "note": "목록에 없는 필드는 무시합니다(베타). 사고 예산은 reasoning_effort(none·low·medium·high; none 은 2.5 계열만) 또는 "
                "extra_body.google.thinking_config 로 — 둘을 같이 쓰면 안 됩니다. service_tier 는 flex/priority.",
        "docs": "https://ai.google.dev/gemini-api/docs/openai",
    },
    {
        "id": "vertex",
        "name": "Google Vertex AI",
        "api": "",
        "hosts": ["aiplatform.googleapis.com"],
        "auth": "Authorization: Bearer <OAuth 액세스 토큰> (gcloud auth application-default print-access-token, 약 1시간 만료) — API 키·express mode 불가",
        "modelExample": "google/gemini-2.5-flash",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": [],
        "modelRules": [],
        "template": {"reasoning_effort": "low"},
        "note": "Base URL: https://<리전>-aiplatform.googleapis.com/v1/projects/<프로젝트>/locations/<리전>/endpoints/openapi . "
                "지원하지 않는 파라미터는 무시합니다. 토큰이 1시간마다 만료돼 상시 사용에는 AI Studio 키를 권합니다.",
        "docs": "https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library",
    },
    {
        "id": "vercel",
        "name": "Vercel AI Gateway",
        "api": "https://ai-gateway.vercel.sh/v1",
        "hosts": ["ai-gateway.vercel.sh"],
        "auth": "Authorization: Bearer <AI Gateway API 키>",
        "modelExample": "anthropic/claude-sonnet-4.5",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": True,
        "unsupported": [],
        "modelRules": [
            {
                "prefix": ["openai/gpt-5", "openai/o1", "openai/o3", "openai/o4"],
                "exceptContains": ["chat"],
                "unsupported": ["temperature", "top_p", "presence_penalty", "frequency_penalty",
                                "logprobs", "top_logprobs", "logit_bias"],
                "note": "OpenAI 사고 모델은 게이트웨이를 거쳐도 temperature 를 거부합니다(업스트림 오류가 그대로 옵니다).",
            },
        ],
        "template": {"extra_body": {"reasoning": {"effort": "medium"}}},
        "note": "모델 이름은 <프로바이더>/<모델>. 게이트웨이는 파라미터를 걸러 주지 않고 업스트림 오류를 그대로 돌려줍니다. "
                "사고 세기는 extra_body.reasoning.effort, 라우팅은 extra_body.providerOptions.gateway.",
        "docs": "https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions",
    },
    {
        "id": "ollama",
        "name": "Ollama 클라우드",
        "api": "https://ollama.com/v1",
        "hosts": ["ollama.com"],
        "auth": "Authorization: Bearer <API 키> (ollama.com/settings/keys)",
        "modelExample": "gpt-oss:120b",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["max_completion_tokens", "store", "service_tier", "prompt_cache_key",
                        "prompt_cache_retention", "parallel_tool_calls"],
        "modelRules": [],
        "template": {"max_tokens": 32000, "reasoning_effort": "medium"},
        "note": "api.ollama.com 이 아니라 ollama.com/v1 입니다(앞 주소는 301 만 돌려줍니다). 모델 이름은 라이브러리 이름 그대로(-cloud 접미사 없이). "
                "무료 플랜은 동시 1개·5시간/주간 사용량 제한이 있습니다.",
        "docs": "https://docs.ollama.com/api/openai-compatibility",
    },
    {
        "id": "llmgateway",
        "name": "LLM Gateway",
        "api": "https://api.llmgateway.io/v1",
        "hosts": ["api.llmgateway.io"],
        "auth": "Authorization: Bearer llmgtwy_…",
        "modelExample": "openai/gpt-5.6",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": True,
        "unsupported": ["store", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [
            {
                "prefix": ["openai/gpt-5", "gpt-5", "openai/o1", "openai/o3", "o1", "o3", "o4"],
                "exceptContains": ["chat"],
                "unsupported": ["temperature", "top_p"],
                "note": "OpenAI 사고 모델은 temperature 를 거부합니다.",
            },
        ],
        "template": {"reasoning_effort": "medium"},
        "note": "모델은 gpt-5.6 처럼 맨이름, openai/gpt-5.6 처럼 프로바이더 고정, 또는 auto. reasoning_effort·service_tier 를 그대로 넘깁니다. "
                "코딩 플랜(DevPass)에서는 프로바이더 접두어를 쓸 수 없습니다.",
        "docs": "https://docs.llmgateway.io/v1_chat_completions",
    },
    {
        "id": "neuralwatt",
        "name": "뉴럴와트 (Neuralwatt)",
        "api": "https://api.neuralwatt.com/v1",
        "hosts": ["neuralwatt.com"],
        "auth": "Authorization: Bearer sk-…",
        "modelExample": "deepseek-v4-flash",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [],
        "template": {"max_tokens": 32000},
        "note": "모델 목록은 GET /v1/models (인증 없이). 응답마다 energy 항목이 붙습니다. 툴 호출 지원은 모델별이라 연결 테스트로 확인하세요. "
                "체험 등급은 동시 2개까지입니다.",
        "docs": "https://portal.neuralwatt.com/docs/api/overview",
    },
    {
        "id": "opencode-go",
        "name": "OpenCode Go (구독)",
        "api": "https://opencode.ai/zen/go/v1",
        "hosts": ["opencode.ai/zen/go"],
        "auth": "Authorization: Bearer <Go 전용 API 키>",
        "modelExample": "kimi-k3",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [
            {"prefix": ["gpt-", "grok-", "muse-"], "unsupported": [], "endpoint": "responses",
             "note": "GPT·Grok 모델은 /responses 로만 제공됩니다 (자동 선택)."},
        ],
        "template": {"max_tokens": 32000},
        "note": "모델마다 엔드포인트가 다릅니다: GPT·Grok 은 /responses, GLM·Kimi·DeepSeek 은 /chat/completions (자동), "
                "MiniMax·Qwen 은 Anthropic 형식이라 이 도구로는 못 씁니다. 한도는 5시간 $12 · 주 $30 · 월 $60.",
        "docs": "https://opencode.ai/docs/go/",
    },
    {
        "id": "opencode",
        "name": "OpenCode Zen (종량제)",
        "api": "https://opencode.ai/zen/v1",
        "hosts": ["opencode.ai"],
        "auth": "Authorization: Bearer <Zen API 키>",
        "modelExample": "kimi-k3",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [
            {"prefix": ["gpt-", "grok-", "muse-"], "unsupported": [], "endpoint": "responses",
             "note": "GPT·Grok 모델은 /responses 로만 제공됩니다 (자동 선택)."},
        ],
        "template": {"max_tokens": 32000},
        "note": "모델마다 엔드포인트가 다릅니다: GPT·Grok 은 /responses, DeepSeek·GLM·Kimi·MiniMax 는 /chat/completions (자동), "
                "Claude·Qwen 은 Anthropic 형식이라 이 도구로는 못 씁니다. 무료 모델(Big Pickle 등)도 있습니다.",
        "docs": "https://opencode.ai/docs/zen/",
    },
    {
        "id": "openrouter",
        "name": "OpenRouter",
        "api": "https://openrouter.ai/api/v1",
        "hosts": ["openrouter.ai"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "anthropic/claude-sonnet-4.5",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": True,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [],
        "template": {"extra_body": {"reasoning": {"effort": "medium"}}},
        "note": "사고 세기는 extra_body.reasoning 으로 넘깁니다.",
        "docs": "https://openrouter.ai/docs/api-reference/overview",
    },
    {
        "id": "groq",
        "name": "Groq",
        "api": "https://api.groq.com/openai/v1",
        "hosts": ["api.groq.com"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "llama-3.3-70b-versatile",
        "endpoint": "chat",
        "capField": "max_completion_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention",
                        "logprobs", "top_logprobs", "logit_bias"],
        "modelRules": [],
        "template": {},
        "note": "",
        "docs": "https://console.groq.com/docs/openai",
    },
    {
        "id": "deepseek",
        "name": "DeepSeek",
        "api": "https://api.deepseek.com/v1",
        "hosts": ["api.deepseek.com"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "deepseek-chat",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [],
        "template": {},
        "note": "",
        "docs": "https://api-docs.deepseek.com",
    },
    {
        "id": "xai",
        "name": "xAI",
        "api": "https://api.x.ai/v1",
        "hosts": ["api.x.ai"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "grok-4",
        "endpoint": "chat",
        "capField": "max_completion_tokens",
        "strictTools": True,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention"],
        "modelRules": [],
        "template": {},
        "note": "",
        "docs": "https://docs.x.ai/docs/api-reference",
    },
    {
        "id": "mistral",
        "name": "Mistral",
        "api": "https://api.mistral.ai/v1",
        "hosts": ["api.mistral.ai"],
        "auth": "Authorization: Bearer <API 키>",
        "modelExample": "mistral-large-latest",
        "endpoint": "chat",
        "capField": "max_tokens",
        "strictTools": False,
        "unsupported": ["store", "service_tier", "prompt_cache_key", "prompt_cache_retention",
                        "logprobs", "top_logprobs", "logit_bias", "user"],
        "modelRules": [],
        "template": {},
        "note": "",
        "docs": "https://docs.mistral.ai/api",
    },
]

_BY_ID = {p["id"]: p for p in PROFILES}
# Names people type on the key page that mean one of ours.
ALIASES = {
    "gemini": "google", "google ai studio": "google", "ai studio": "google",
    "vertex ai": "vertex", "vertexai": "vertex",
    "claude": "anthropic",
    "vercel ai gateway": "vercel", "ai gateway": "vercel", "ai-gateway": "vercel",
    "ollama.com": "ollama", "ollama cloud": "ollama",
    "llm gateway": "llmgateway", "llmgateway.io": "llmgateway",
    "neural watt": "neuralwatt", "뉴럴와트": "neuralwatt",
    "opencode zen": "opencode", "opencode go": "opencode", "zen": "opencode",
    "grok": "xai", "x.ai": "xai",
}


def by_id(provider: str) -> dict | None:
    want = (provider or "").strip().lower()
    if not want:
        return None
    want = ALIASES.get(want, want)
    return _BY_ID.get(want)


def for_url(base_url: str) -> dict | None:
    """The profile whose host the base URL points at, or None."""
    m = re.match(r"^\s*https?://(.+)$", base_url or "", re.I)
    if not m:
        return None
    where = m.group(1).lower()   # host and path: opencode.ai/zen/go vs opencode.ai
    for p in PROFILES:
        if any(h in where for h in p["hosts"]):
            return p
    return None


def public() -> list[dict]:
    """What the settings screens get: everything but the matching internals."""
    keep = ("id", "name", "api", "hosts", "auth", "modelExample", "endpoint", "capField", "strictTools",
            "unsupported", "template", "note", "docs")
    out = []
    for p in PROFILES:
        d = {k: p.get(k) for k in keep}
        d["modelNotes"] = [r.get("note", "") for r in p.get("modelRules", []) if r.get("note")]
        out.append(d)
    return out


def _bare_model(model: str) -> str:
    """'openai/gpt-5' -> 'gpt-5' for family matching; a bare name unchanged."""
    return model.split("/", 1)[1] if "/" in model else model


def unsupported_for(profile: dict | None, model: str) -> tuple[list[str], list[str], str]:
    """Fields the profile says this endpoint+model rejects, the notes why, and
    the API ('chat' | 'responses') the profile picks for this model."""
    if not profile:
        return [], [], "chat"
    fields = list(profile.get("unsupported") or [])
    notes: list[str] = []
    endpoint = str(profile.get("endpoint") or "chat")
    name = (model or "").strip().lower()
    for rule in profile.get("modelRules") or []:
        hit = any(name.startswith(pfx) or _bare_model(name).startswith(pfx) for pfx in rule.get("prefix", []))
        if hit and any(x in name for x in rule.get("exceptContains", [])):
            hit = False
        if hit:
            fields.extend(rule.get("unsupported", []))
            if rule.get("endpoint"):
                endpoint = str(rule["endpoint"])
            if rule.get("note"):
                notes.append(rule["note"])
    return fields, notes, endpoint


# --- parameter JSON --------------------------------------------------------------

class ParamsError(ValueError):
    pass


def parse_params(text: str) -> dict[str, Any]:
    """The preset's parameter JSON as a dict; '' is {}. Raises ParamsError."""
    raw = (text or "").strip()
    if not raw:
        return {}
    if len(raw) > MAX_PARAMS_CHARS:
        raise ParamsError(f"파라미터 JSON 이 너무 깁니다 ({MAX_PARAMS_CHARS}자까지)")
    try:
        data = json.loads(raw)
    except ValueError as e:
        raise ParamsError(f"파라미터 JSON 을 읽을 수 없습니다: {e}")
    if not isinstance(data, dict):
        raise ParamsError('파라미터 JSON 은 객체여야 합니다 (예: {"temperature": null})')
    for k, v in data.items():
        if not isinstance(k, str) or not k.strip():
            raise ParamsError("파라미터 이름은 비어 있지 않은 문자열이어야 합니다")
        if k in ("model", "messages", "stream", "tools"):
            raise ParamsError(f"'{k}' 는 에이전트가 직접 정하는 필드라 JSON 으로 바꿀 수 없습니다")
        if k == "extra_body" and v is not None and not isinstance(v, dict):
            raise ParamsError("extra_body 는 객체여야 합니다")
        if k == "extra_headers" and v is not None and not isinstance(v, dict):
            raise ParamsError("extra_headers 는 객체여야 합니다")
        if k == "api" and v is not None and str(v).strip().lower() not in ("chat", "responses"):
            raise ParamsError('api 는 "chat" 또는 "responses" 여야 합니다')
    return data


# --- the plan --------------------------------------------------------------------

@dataclass
class Plan:
    """Everything one request needs beyond model + messages."""
    settings: dict[str, Any] = field(default_factory=dict)   # pydantic-ai model settings
    drop: set[str] = field(default_factory=set)               # raw fields popped before sending
    cap_field: str = "max_completion_tokens"                  # '' = no output cap sent
    strict_tools: bool = True
    api: str = "chat"                                         # 'chat' | 'responses'
    profile: dict | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def drop_all(self) -> set[str]:
        """`drop` plus each field's Responses-API spelling."""
        return self.drop | {RESPONSES_ALIAS[k] for k in self.drop if k in RESPONSES_ALIAS}

    @property
    def raw(self) -> dict[str, Any]:
        """The same plan as raw request fields (for the connection test)."""
        inv = {v: k for k, v in SETTING_OF.items()}
        out: dict[str, Any] = {}
        for k, v in self.settings.items():
            if k == "max_tokens":
                if self.cap_field:
                    out["max_output_tokens" if self.api == "responses" else self.cap_field] = v
            elif k == "openai_reasoning_effort" and self.api == "responses":
                out["reasoning"] = {"effort": v}
            elif k == "extra_body" and isinstance(v, dict):
                out.update(v)
            elif k in inv:
                out[inv[k]] = v
        for k in self.drop:
            out.pop(k, None)
        return out


def plan_for(cfg: dict) -> Plan:
    """The request plan a config section (agent / agent_search) describes.

    Order of precedence, lowest first: the section's numeric fields, the
    provider profile's rejections, the parameter JSON.
    """
    plan = Plan()
    s = plan.settings
    model = str(cfg.get("model") or "")
    codex = (cfg.get("provider") or "") == "codex"
    plan.profile = None if codex else for_url(str(cfg.get("baseUrl") or ""))

    # 1. the section's own fields
    try:
        s["max_tokens"] = int(cfg.get("maxTokens") or 32000)
    except (TypeError, ValueError):
        s["max_tokens"] = 32000
    temp = cfg.get("temperature")
    if temp is not None and temp != "":
        try:
            s["temperature"] = float(temp)
        except (TypeError, ValueError):
            pass
    level = str(cfg.get("reasoning") or "").strip().lower()
    if level:
        s["openai_reasoning_effort"] = level
    if codex:
        # The subscription backend refuses stored responses and has no tiers
        # or caches to pick; codexauth.client strips the rest.
        s["openai_store"] = False
    else:
        if cfg.get("flex"):
            s["openai_service_tier"] = "flex"
        if cfg.get("cache"):
            s["openai_prompt_cache_key"] = "risu-hina"
            s["openai_prompt_cache_retention"] = "24h"
    if plan.profile:
        plan.cap_field = plan.profile.get("capField") or "max_completion_tokens"
        plan.strict_tools = bool(plan.profile.get("strictTools", True))

    # 2. what the profile says this endpoint rejects, and which API it wants
    fields, notes, endpoint = unsupported_for(plan.profile, model)
    plan.notes.extend(notes)
    plan.api = "responses" if codex else endpoint
    for k in fields:
        _null(plan, k)

    # 3. the preset's JSON - last word
    try:
        params = parse_params(str(cfg.get("params") or ""))
    except ParamsError as e:
        plan.notes.append(str(e))
        params = {}
    cap_pref: str | None = None
    for k, v in params.items():
        if v is None:
            _null(plan, k)
            continue
        if k in CAP_FIELDS:
            try:
                s["max_tokens"] = int(v)
            except (TypeError, ValueError):
                plan.notes.append(f"{k} 는 정수여야 합니다")
                continue
            cap_pref = k
            plan.drop.discard(k)
        elif k == "strict":
            plan.strict_tools = bool(v)
        elif k == "api":
            plan.api = str(v).strip().lower()
        elif k == "extra_body":
            s.setdefault("extra_body", {}).update(v)
        elif k in SETTING_OF:
            s[SETTING_OF[k]] = v
            plan.drop.discard(k)
        else:
            s.setdefault("extra_body", {})[k] = v
            plan.drop.discard(k)

    # 4. which cap field survives
    order = [cap_pref] if cap_pref else []
    order += [plan.cap_field] + [f for f in CAP_FIELDS if f != plan.cap_field]
    plan.cap_field = next((f for f in order if f and f not in plan.drop), "")
    if not plan.cap_field:
        s.pop("max_tokens", None)
    return plan


def _null(plan: Plan, k: str) -> None:
    """Honour `"<field>": null` - drop the setting, and pop the raw field."""
    plan.drop.add(k)
    if k in SETTING_OF:
        plan.settings.pop(SETTING_OF[k], None)
    elif k == "strict":
        plan.strict_tools = False
    elif k == "extra_body":
        plan.settings.pop("extra_body", None)
    else:
        eb = plan.settings.get("extra_body")
        if isinstance(eb, dict):
            eb.pop(k, None)


# --- error hints -----------------------------------------------------------------

# How the shims name a field they refuse. Each yields the field name.
_PATTERNS = [
    # OpenAI: "Unsupported parameter: 'temperature' is not supported with this model."
    r"unsupported parameter:?\s*'?([a-z_\.]+)'?",
    # OpenAI: "Unsupported value: 'temperature' does not support 0.2 with this model."
    r"unsupported value:?\s*'([a-z_\.]+)'",
    # OpenAI: "Unrecognized request argument supplied: foo"
    r"unrecognized request argument(?:s)? supplied:?\s*([a-z_\.]+)",
    # Gemini: 'Invalid JSON payload received. Unknown name "store"'
    r"unknown name \"([a-z_\.]+)\"",
    # pydantic-style shims: "store: Extra inputs are not permitted"
    r"\b([a-z_]+): extra inputs are not permitted",
    # generic: 'unknown field "x"', "invalid parameter: x", "'x' is not supported"
    r"unknown (?:field|parameter|argument)s?:?\s*\"?'?([a-z_\.]+)",
    r"invalid (?:parameter|argument|field|option)s?:?\s*\"?'?([a-z_\.]+)",
    r"'([a-z_\.]+)' is not (?:supported|allowed|permitted)",
    r"\"([a-z_\.]+)\" is not (?:supported|allowed|permitted)",
    r"parameter '?([a-z_\.]+)'? (?:is )?not supported",
]


def rejected_field(text: str) -> str:
    """The request field an error message names, or ''."""
    low = (text or "").lower()
    for pat in _PATTERNS:
        m = re.search(pat, low)
        if not m:
            continue
        name = m.group(1).strip("'\". ").split(".")[-1]
        if name in KNOWN_FIELDS or name in ("max_output_tokens", "thinking", "reasoning"):
            return name
    return ""


def hint(text: str, section_label: str = "에이전트") -> str:
    """Guidance for a provider's parameter rejection, or '' when the error is
    not one. The JSON is exactly what the preset editor takes."""
    low = (text or "").lower()
    where = f"설정 → {section_label} → 프리셋 수정 → 파라미터 JSON"
    if "function tools with reasoning_effort are not supported" in low or "use /v1/responses" in low:
        return (f"이 모델은 Chat Completions 에서 툴 호출을 거부합니다. {where} 에 "
                '{"api": "responses"} 를 넣어 Responses API 로 보내세요 (또는 {"reasoning_effort": "none"}).')
    name = rejected_field(text)
    if not name:
        return ""
    if name in ("temperature", "top_p") and "default" in low:
        return (f"이 모델은 {name} 를 기본값으로만 받습니다. {where} 에 "
                f'{{"{name}": null}} 을 넣으면 보내지 않습니다.')
    if name == "max_tokens":
        return (f"이 엔드포인트는 max_tokens 대신 max_completion_tokens 를 씁니다. {where} 에 "
                '{"max_completion_tokens": 32000} 을 넣어 주세요 (숫자는 원하는 출력 상한).')
    if name == "max_completion_tokens":
        return (f"이 엔드포인트는 max_completion_tokens 를 모릅니다. {where} 에 "
                '{"max_tokens": 32000} 을 넣어 주세요 (숫자는 원하는 출력 상한).')
    if name == "max_output_tokens":
        return (f"이 엔드포인트는 출력 상한(max_output_tokens) 을 받지 않습니다. {where} 에 "
                '{"max_tokens": null} 을 넣으면 보내지 않습니다.')
    if name == "strict":
        return (f"이 엔드포인트는 툴 정의의 strict 를 모릅니다. {where} 에 "
                '{"strict": false} 를 넣어 주세요.')
    return (f"이 엔드포인트가 요청 파라미터 '{name}' 를 거부했습니다. {where} 에 "
            f'{{"{name}": null}} 을 넣으면 보내지 않습니다.')
