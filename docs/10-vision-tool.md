# 10. The vision tool — the agent looking at images (§1-42, 0.14.0)

The agent generates images through the studio but could never look at them: every judgement
about a picture was the user's or a hallucination. This adds a vision capability shaped like
the web-search tool — one tool surface, one settings card, a mode that decides who looks — and
the three things the user asked for: look-and-judge, a look → adjust → regenerate loop, and
review suggestions written into the 검수 tab for the user to confirm. Adult content is the
common case, so refusals by external vision APIs are detected and degrade to numbers.

## Modes (`config.vision.mode`, card: ⚙ → 에이전트 → 비전 툴)

| mode | who looks | how |
|---|---|---|
| `native` | the main agent's own model | the tool returns a pydantic-ai `ToolReturn` whose `content` carries a `BinaryImage`; the library sends it as the user message after the tool result (chat/completions) or inline (Responses). Gated on a **probe**: the card's 테스트 sends a 64×64 two-colour PNG through the real agent model and remembers `nativeProbe {model, ok, at, error}`; a changed preset makes it stale. |
| `helper` | a separate OpenAI-compatible vision endpoint | `POST {base}/chat/completions` with the picture as an `image_url` data URI (`detail` from config). Any vendor: Gemini `/v1beta/openai`, OpenAI, OpenRouter, a local Ollama `/v1` (`llava`, `qwen2.5-vl`) for uncensored use. Key via `keys.resolve` (a saved key or a typed one; a loopback address needs none). |
| `off` | nobody | numbers only, always available. |

Config keys: `mode, nativeProbe, helperBaseUrl, helperModel, helperKeyRef, helperApiKey (secret),
helperInstructions, maxWidth (768), detail (auto|low|high), maxImagesPerCall (6),
maxCallsPerTurn (12), timeoutSeconds (60)`.

## Tools (`agent.py`, bodies in `vision.py`)

- `view_image(path, question)` — one image; the answer (helper) or the picture itself (native),
  plus the measured numbers and the NAI recipe when the PNG carries one.
- `compare_images(paths, question)` — 2..maxImagesPerCall images in one call, labelled `[n]`,
  with pairwise near-duplicate distances.
- `image_metrics(path)` — no model: size, brightness, contrast, sharpness bucket (FIND_EDGES
  variance, border-cropped), letterbox bands (flat lines sharing the edge tone), dhash and the
  folder's near-duplicates (Hamming ≤ 6), transparency, frames, NAI prompt/seed.
- `review_folder(folder, criteria, pattern, group_by, limit)` — groups + numbers + duplicates;
  helper mode asks for JSON verdicts per batch; native mode attaches the pictures. Changes nothing.
- `suggest_selection(folder, suggestions_json)` — writes `{verdict, reason, by, at}` per file into
  the selection file (`studio.merge_suggestions`: read-merge-write under a lock, never touches the
  user's flags, `none` clears) and pushes a `suggestions` stream event.

Every path goes through `files._resolve(files.SPACE, rel)`; only `files._IMAGE_SUFFIXES` are
accepted; the picture sent is `files.thumb_bytes(target, maxWidth)` (WebP, disk-cached), or the
original bytes when it cannot be thumbed and is ≤ 4 MB.

## Refusals

`vision.is_refusal(text, status, body, finish_reason)` returns a code for: HTTP 400/403/422
bodies that mention safety/blocked/content policy; `finish_reason` content_filter / SAFETY /
PROHIBITED_CONTENT; a Gemini `blockReason`; an empty successful answer; refusal sentences in
English and Korean (short texts only — a long description that merely contains "can't" is not a
refusal). Any other HTTP error is a failure, not a refusal. On refusal the tool returns
`VISION REFUSED … You have NOT seen this image` plus the numbers, and the instructions tell the
agent to relay that and point at the card. Native-mode refusals cannot be detected by code; the
instructions cover them, and the probe gate prevents a model that rejects images entirely.

## History hygiene

`vision.scrub_history` replaces every `BinaryContent` inside a `UserPromptPart` with
`[image omitted from stored history: <id>; call view_image again if you need to see it]` before
`session.py` persists a turn (both the normal and the partial path). The model saw the picture in
the turn it asked for it; later turns carry a line, not 100 KB of base64. `agent._msg_chars`
counts a binary part as 64 characters; `_msg_text` renders `[이미지]`; `session._short` shows
`[image/webp 61KB]` in the agent log. `vision.reset_turn` clears the per-turn call counter.

## Panel

- `presets.ts buildVisionCard()` (id `vision-card`, after the web-search card): mode, native
  probe line (아직 확인 안 됨 / 확인됨 / 모델이 바뀜), helper address/model/key/instructions,
  common width/detail/calls, 저장 · test-path · 테스트 (empty path = the built-in sample).
- Stream events: `viewed {paths, label, mode}` → a small strip of what the agent looked at;
  `suggestions {folder, count, use, delete, inpaint}` → a chip that opens 검수 on that folder.
- 검수 tab (`selector.ts`): a `.sugline` under a candidate's flags (`AI 제안: 채택|버림|수정`,
  reason, 적용, ×), a `제안 N` badge on group cards, `제안 N건 모두 적용` / `제안 지우기` on the
  tools row; a manual flag matching the suggestion clears it.
- `TOOL_GLYPH`: 👁 이미지 보기/비교, 📐 이미지 수치, 🔎 폴더 검수, 🏷 검수 제안.

## Skill

`seeds/vision-loop.md` ("보고 조정하기"): one-image loop (intent → 1–2 images → view with a
checklist → change ONE variable → regenerate → compare → stop after three rounds), folder review
(metrics pre-filter → review_folder → suggest_selection → studio_open → "검수 탭에 제안을
적었습니다"), and the refusal branch. `SEED_KEY` v7 seeds it into existing installs.

## Verification

- `tests/test_vision.py` (gate): metrics on synthetic PNGs, the Pillow-absent branch, the
  refusal table, the history scrub round-trip, modes/ready/why_not, the per-turn cap, off mode,
  native `ToolReturn`, the helper wire against a fake OpenAI server (answer, text refusal, HTTP
  safety, 500), the card test, KEEP/redaction, selection `suggest` + `merge_suggestions`.
- `tests/test_http.py`: `/vision` status, key redaction, `/vision/test` in helper (dead) and off.
- `tests/plugin_smoke.mjs`: the card follows the web-search card, three modes, helper pane fields;
  a seeded `suggest` shows `AI 제안: 채택` on the candidate and 적용 turns it into the flag.
- Manual, real models (not run here): native + GPT-5.x Responses; native + Gemini `/v1beta/openai`
  (the §1-38 signature path still passes); native + codex; helper = Gemini Flash on an NSFW image
  → VISION REFUSED relayed; helper = Ollama qwen2.5-vl on the same → description; the loop and a
  20-image review end to end.
