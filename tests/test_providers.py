"""providers.py: the request plan and the error hints, without a network.

Each case is a provider quirk that once (or would have) broken a real
request; the plan has to encode it, and the hint has to name the fix.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pyserver"))

from app import providers as P  # noqa: E402

fails = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global fails
    print(("  ok   " if ok else "  FAIL ") + label + (f" - {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1


def cfg(**kw):
    base = {"baseUrl": "https://gw.example.com/v1", "apiKey": "k", "model": "m",
            "maxTokens": 32000, "temperature": None, "params": "", "reasoning": "",
            "cache": False, "flex": False, "provider": ""}
    base.update(kw)
    return base


# --- matching -------------------------------------------------------------------
check("openai by host", (P.for_url("https://api.openai.com/v1") or {}).get("id") == "openai")
check("opencode go before zen (path matters)",
      (P.for_url("https://opencode.ai/zen/go/v1") or {}).get("id") == "opencode-go")
check("opencode zen", (P.for_url("https://opencode.ai/zen/v1") or {}).get("id") == "opencode")
check("vertex by host suffix", (P.for_url("https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/endpoints/openapi") or {}).get("id") == "vertex")
check("neuralwatt", (P.for_url("https://api.neuralwatt.com/v1") or {}).get("id") == "neuralwatt")
check("unknown gateway is None", P.for_url("https://gw.example.com/v1") is None)
check("alias 뉴럴와트", (P.by_id("뉴럴와트") or {}).get("id") == "neuralwatt")
check("public profiles carry guidance", all(p["auth"] and "hosts" in p for p in P.public()))

# --- defaults ---------------------------------------------------------------------
pl = P.plan_for(cfg())
check("unknown gateway: chat API", pl.api == "chat")
check("unknown gateway: max_completion_tokens", pl.cap_field == "max_completion_tokens")
check("temperature None is not sent", "temperature" not in pl.settings)
check("output cap is sent", pl.settings.get("max_tokens") == 32000)
pl = P.plan_for(cfg(temperature=0.3, reasoning="high", flex=True, cache=True))
check("numbers become settings", pl.settings.get("temperature") == 0.3
      and pl.settings.get("openai_reasoning_effort") == "high"
      and pl.settings.get("openai_service_tier") == "flex"
      and pl.settings.get("openai_prompt_cache_key") == "risu-hina")

# --- OpenAI official ---------------------------------------------------------------
pl = P.plan_for(cfg(baseUrl="https://api.openai.com/v1", model="gpt-5.6", temperature=0.2))
check("openai: responses API by default", pl.api == "responses")
check("openai gpt-5: temperature dropped by the family rule", "temperature" not in pl.settings
      and "temperature" in pl.drop, str(pl.settings))
check("openai gpt-5: the raw request caps with max_output_tokens", pl.raw.get("max_output_tokens") == 32000, str(pl.raw))
check("openai gpt-5: the note explains", any("temperature" in n for n in pl.notes))
pl = P.plan_for(cfg(baseUrl="https://api.openai.com/v1", model="gpt-5-chat-latest", temperature=0.2))
check("openai chat model keeps temperature", pl.settings.get("temperature") == 0.2)
pl = P.plan_for(cfg(baseUrl="https://api.openai.com/v1", model="gpt-4.1", temperature=0.2,
                    params='{"api": "chat"}'))
check("openai: JSON can force chat", pl.api == "chat" and pl.cap_field == "max_completion_tokens")
check("openai gpt-4.1 keeps temperature", pl.settings.get("temperature") == 0.2)

# --- Ollama / Anthropic / Gemini --------------------------------------------------
pl = P.plan_for(cfg(baseUrl="https://ollama.com/v1", model="gpt-oss:120b"))
check("ollama: max_tokens, no strict tools", pl.cap_field == "max_tokens" and pl.strict_tools is False)
check("ollama: max_completion_tokens never sent", "max_completion_tokens" in pl.drop)
pl = P.plan_for(cfg(baseUrl="https://api.anthropic.com/v1", model="claude-sonnet-4-6"))
check("anthropic: max_tokens", pl.cap_field == "max_tokens" and pl.api == "chat")
pl = P.plan_for(cfg(baseUrl="https://generativelanguage.googleapis.com/v1beta/openai", model="gemini-2.5-flash",
                    params='{"reasoning_effort": "low"}'))
check("gemini: reasoning_effort from JSON", pl.settings.get("openai_reasoning_effort") == "low")

# --- the JSON's precedence --------------------------------------------------------
pl = P.plan_for(cfg(temperature=0.5, params='{"temperature": null}'))
check("null removes a numeric field", "temperature" not in pl.settings and "temperature" in pl.drop)
pl = P.plan_for(cfg(params='{"max_completion_tokens": null}'))
check("null on the cap field switches to the other spelling", pl.cap_field == "max_tokens"
      and pl.settings.get("max_tokens") == 32000, pl.cap_field)
pl = P.plan_for(cfg(params='{"max_tokens": null, "max_completion_tokens": null}'))
check("both caps null = no cap", pl.cap_field == "" and "max_tokens" not in pl.settings)
pl = P.plan_for(cfg(params='{"max_tokens": 4000}'))
check("a number on max_tokens sets the cap and the spelling", pl.cap_field == "max_tokens"
      and pl.settings.get("max_tokens") == 4000)
pl = P.plan_for(cfg(params='{"top_k": 40, "extra_body": {"thinking": {"type": "enabled"}}, "strict": false, "stream_options": null}'))
check("unknown keys go to extra_body", pl.settings.get("extra_body", {}).get("top_k") == 40
      and pl.settings["extra_body"]["thinking"]["type"] == "enabled", str(pl.settings))
check("strict false", pl.strict_tools is False)
check("library fields can be dropped", "stream_options" in pl.drop)
pl = P.plan_for(cfg(baseUrl="https://api.openai.com/v1", model="gpt-5.6", params='{"temperature": 1}'))
check("JSON overrides the family rule", pl.settings.get("temperature") == 1 and "temperature" not in pl.drop)
pl = P.plan_for(cfg(params='{"max_tokens": null}'))
check("responses alias covers the drop", "max_output_tokens" in pl.drop_all)
pl = P.plan_for(cfg(provider="codex", model="gpt-5.1-codex", baseUrl=""))
check("codex: responses, store off", pl.api == "responses" and pl.settings.get("openai_store") is False)

# --- validation -------------------------------------------------------------------
for bad in ["{not json", "[1]", '{"model": "x"}', '{"extra_body": 3}', '{"api": "grpc"}']:
    try:
        P.parse_params(bad)
        check(f"rejects {bad!r}", False)
    except P.ParamsError:
        check(f"rejects {bad!r}", True)
check("empty is empty", P.parse_params("  ") == {})

# --- hints ------------------------------------------------------------------------
H = P.hint
check("openai unsupported value", '{"temperature": null}' in H(
    "status_code: 400, body: {'error': {'message': \"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.\"}}"))
check("openai max_tokens -> max_completion_tokens", "max_completion_tokens" in H(
    "Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead."))
check("openai unsupported parameter quoted", '{"store": null}' in H("Unsupported parameter: 'store'"))
check("gemini unknown name", '{"user": null}' in H('Invalid JSON payload received. Unknown name "user": Cannot find field.'))
check("tools + reasoning on chat completions", '"api": "responses"' in H(
    "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions."))
check("max_output_tokens", '{"max_tokens": null}' in H("body: {'detail': 'Unsupported parameter: max_output_tokens'}"))
check("strict", '{"strict": false}' in H("unknown field \"strict\" in tools[0].function"))
check("unrelated errors get no hint", H("Internal server error") == "" and H("401 unauthorized") == "")
check("random words are not fields", H("unknown field \"banana\"") == "")

print()
if fails:
    print(f"FAIL - {fails} check(s)")
    sys.exit(1)
print("PASS - provider plan and hints")
