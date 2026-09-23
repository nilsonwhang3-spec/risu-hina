> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

Read this when you read, write or review a bot's Lua trigger script (triggerscript / module.risum): the verified API
surface, hook timing, and advanced mechanisms seen in well-regarded bots (reroll-safe state, aux-model extraction, cached
HTML, calendars, button families). Risu Hina's agent does not execute Lua; this is a reference for reading and writing
bot scripts, which the user runs in RisuAI.

> **Names vary per bot.** Every function, variable, tag and marker name below (`bot_*`, `[bot:…]`, `<!--bot-seed:…-->`)
> is a placeholder. Read the target bot's actual script and names first and follow them.

Contents
- Part A: API reference (verified against RisuAI origin/main `src/ts/process/scriptings.ts`, `triggers.ts`,
  `index.svelte.ts`, `DefaultChatScreen.svelte`, `Chat.svelte`, 2026-09)
  0. Trigger kinds: V1 is deprecated; V2 and Lua are supported
  1. Delivery and engine
  2. Hooks, timing and return values
  3. Access tiers
  4. API by area
  5. Regex scripts next to Lua
  6. Minimal template
- Part B: Advanced mechanisms (patterns from well-regarded bots)
  7. The onOutput pipeline: async, per-job pcall, error var
  8. State split and write-if-changed
  9. Reroll / edit / delete safety: four schemes
  10. Aux-LLM structured extraction recipe
  11. Lua-rendered HTML cached in chat vars
  12. Calendar and world clock
  13. i18n tables
  14. listenEdit usage patterns
  15. Hidden control markers between model and Lua
  16. Button handler families and metatable dispatch
  17. Presence detection and roster swap
  18. Periodic off-screen tracker and long summaries
  19. Dice checks
  20. Self-tests, backup and restore
  21. Dynamic lorebook API vs CBS-gated constant entries
- 22. Pitfalls
- 23. Build / review checklist

Related skills: 'RisuAI 처리 순서 (정규식·Lua 훅)' (exact order of regex and Lua hooks, what is saved), 'RisuAI CBS 문법',
'RisuAI 정규식 작성법', 'RisuAI 옵션 패널 (슬라이딩 드로어)' (risu-btn panels), 'RisuAI 상태창', 'RisuAI 에셋 출력식'
(aux image tagging), 'RisuAI 로어북 구조'.

---

# Part A: API reference

## 0. Trigger kinds: V1 is deprecated; V2 and Lua are supported

The trigger editor offers three kinds: **V1** (condition/effect list; the editor shows "Trigger V1 is deprecated. It might
be removed in the future."), **V2** (visual block editor, `effect[0].type == "v2Header"`; its "Deprecated" effect category
is hidden unless `showDeprecatedTriggerV2` is on) and **Lua** (`effect[0].type == "triggerlua"`). **V2 itself is not deprecated**: that category contains only selected old effects such as v2If and old lorebook operations. Prefer Lua for these recipes; keep functioning V2 unless migration is requested or needed. Switching kinds in the editor
replaces the whole trigger list (it asks first).

**Reading and porting legacy triggers.** Old bots may carry a V1/V2 list in `triggerscript` (each item `{comment, type,
conditions, effect[]}`; `type` is `start`/`input`/`output`/`display`/`request`/`manual`; `comment` is the name that
`risu-trigger`/`{{button}}` calls). Port item by item:
| Legacy | Lua |
|---|---|
| `type: start` / `input` / `output` item | body of `onStart` / `onInput` / `onOutput` (see §2 for exact timing) |
| `type: manual`, comment `name` | global `function name(id) … end` (same name, so existing `risu-trigger` buttons keep working) |
| `type: display` / `request` item (`v2GetDisplayState`, `v2SetRequestState` …) | `listenEdit('editDisplay', …)` / `listenEdit('editRequest', …)` |
| `v2SetVar` (`=`, `+=`, `-=` …), `setvar` | `setChatVar(id, k, tostring((tonumber(getChatVar(id, k)) or 0) + n))` |
| `v2If` / `v2IfAdvanced` / `v2Else` / `v2EndIndent`, loops | plain Lua `if`/`for`; indent-scoped local vars become `local` |
| `v2ExtractRegex`, `v2RegexTest` | `string.match` / `gsub` (Lua patterns, not JS regex: port the pattern) |
| `v2GetLastMessage`, `v2GetMessageAtIndex`, `v2ModifyChat`, `v2CutChat` … | `getChat` / `setChat` / `cutChat` |
| `v2RunLLM` / `runLLM` | `LLM` (main) or `axLLM` (aux model) inside an `async` hook |
| `v2*Lorebook*` effects | `getLoreBooks` / `upsertLocalLoreBook`, or better CBS-gated constant entries (§21) |
| `v2UpdateGUI`, `v2RunTrigger` | `reloadDisplay(id)`; call the Lua function directly |
| `v2StopTrigger` | `return` |
| `v2StopPromptSending` / `stop` | `stopChat(id)` or `return false` (only effective in `onStart`, §2) |
| `v2SystemPrompt`, `v2SetAuthorNote`, `v2SetReplaceGlobalNote`, `v2SendAIprompt`, `v2Impersonate` | no Lua function: inject text with `listenEdit('editRequest')` or a chat var printed by a lorebook entry |
Keep variable names identical so CBS, regex and panels still work, remove the old list in the same edit (a card holds one
kind), and re-test every button.

## 1. Delivery and engine

- RisuAI runs Lua 5.4 in a wasmoon VM. Structure: `triggerscript = [{ comment = "", type = "start", conditions = {},
  effect = {{ type = "triggerlua", code = "<Lua source>" }} }]` (one item; what the editor's Lua button creates). A
  `triggerlua` item runs in **every** mode regardless of its `type`. Modules carry their own trigger list the same way;
  card and module Lua scripts all run, card first.
- **Packaging**: in .charx packaging, Lua triggers and regex scripts go into `module.risum`. On charx import,
  `module.risum` overwrites card.json's `triggerscript`/`customScripts`, so edit the module copy (a charx encode step
  builds it from `triggers.lua` and `regex.json`).
- **One engine per mode.** Engines are cached per mode key only (`start`, `output`, `input`, `editDisplay`, `editOutput`,
  `editInput`, `editRequest`, `onButtonClick`, and each manual trigger name). An engine is rebuilt (top-level code runs
  again, globals reset) whenever the code it last ran differs. So globals persist between calls *of the same mode* only
  while one Lua script is in play: with a card script **and** a module script (or two modules), they alternate in the same
  engine and it is rebuilt on every call. Globals are **never shared between modes**. Share data through chat vars / state,
  never through Lua globals. Calls of the same mode are serialized. (A per-script engine cache was added in 2026-05 and
  reverted on 2026-07-30; do not rely on either behavior.)
- A wrapper (~150 lines) is prepended: `json` (global), `getChat`, `getFullChat`, `getRecentChats`, `setFullChat`, `log`,
  `getLoreBooks`, `loadLoreBooks`, `LLM`, `axLLM`, `getCharacterImage`, `getPersonaImage`, `listenEdit`, `getState`,
  `setState`, `setStateChanged`, `async`, `callListenMain`. Do not redefine these names. Traceback line numbers are offset.
- **Errors are silent.** Hook errors go to the browser console only; edit hooks then return the original content; nothing
  shows in the chat. Use `log(value)` (console, JSON-encoded) while developing, and store errors in a chat var in
  production (§7).
- wasmoon opens the standard libraries (`string`, `table`, `math`, `utf8`, `coroutine`, `os.time`/`os.date`); `require`
  and `io` only reach the VM's in-memory files (the bundled `json.lua`). The host functions below are the only real I/O.

## 2. Hooks, timing and return values

| Mode / trigger | Lua entry point | When |
|---|---|---|
| `start` | `onStart(id)` | on **every send** (new message, reroll, continue, auto-continue), not once per chat and not when a chat is opened. It runs **after** the description, persona, author's note and main prompt were CBS-parsed and the lorebook was matched (ordinary and depth-0 entries parsed too), and before the history is processed (editprocess), positive-depth / reverse-depth entries are parsed, and editRequest. Depth-0 text does not see variables first set by this onStart. A var set here affects those later parts this send; the earlier ones only from the next send |
| `input` | `onInput(id)` | when the user sends non-empty text (single-character chats only), **before** the user message is appended: `getChat(id, -1)` is still the previous message. Then editInput runs on the text. Not run on reroll, continue or an empty send |
| `output` | `onOutput(id)` | after the reply is saved (after editoutput and the CBS variable pass over the chat), before the send finishes. Also after rerolls |
| button `risu-btn="data"` | `onButtonClick(id, data)` | on click (not in group chats) |
| manual trigger / `risu-trigger="name"` / `{{button::Label::name}}` / slash command `/trigger name` | global function `name(id)` | on click / command; each name gets its own engine |
| `display`, `request` | none: V2-only trigger modes; Lua does not run there. Use `listenEdit('editDisplay' / 'editRequest')` | |
| edit hooks | `listenEdit(type, fn)` callbacks | see below |

```lua
listenEdit('editInput',   function(id, text, meta) return text end)      -- user input; result is saved
listenEdit('editOutput',  function(id, text, meta) return text end)      -- model output; result is saved
listenEdit('editDisplay', function(id, text, meta) return text end)      -- every render; not saved
listenEdit('editRequest', function(id, messages, meta) return messages end) -- outgoing {role, content}[]; not saved
```

- Every callback receives `(id, value, meta)`. For editOutput/editDisplay, `meta` is `{ index = message index }`; for
  editInput the index is `-1` (the message does not exist yet); for editDisplay of the background HTML it is `-1`. For
  editRequest `meta` is an empty table, so `meta.index` is nil. Older notes said "editOutput takes 2 params; a third
  causes silent failure": that is false. Declaring the parameter is harmless; guard `meta and meta.index`.
- Callbacks of one type run in registration order; each receives the previous return value. **Always return the value**
  (a nil return breaks the chain).
- **Do not wrap listenEdit callbacks in `async(...)`**: `callListenMain` already runs them inside a coroutine, so
  `:await()` works in a plain callback, while an `async` callback returns a Promise that breaks the chain. Wrap the
  `onStart`/`onInput`/`onOutput`/`onButtonClick`/manual functions in `async(...)` when they `:await()` (they are called
  directly, outside any coroutine).
- editOutput can run many times per reply: on every streamed chunk (unless the user's streaming performance mode defers
  post-processing to the end), and again for continue. Keep it idempotent; count or add things in `onOutput`.
- Stopping the send: `return false` or `stopChat(id)` works **only in `onStart`** (checked right after it). In `onInput`,
  `onOutput`, buttons and edit hooks both are ignored. Return values of the plain hooks cannot replace text; use `setChat`.
- Lua edit hooks run before the regex scripts of the same stage; editprocess has no Lua hook (editRequest is the closest).
  Full order: 'RisuAI 처리 순서 (정규식·Lua 훅)'.
- `onStart` is optional. If defaults matter before the first send (greeting render, option panel), put them in the card's
  `defaultVariables`; backfill in `onStart` or at the top of each hook.
- Parameter name: any name works. Older bots use `triggerId`; this file uses `id`. Always pass it through to every host call.

## 3. Access tiers

| Tier | Granted | Unlocks |
|---|---|---|
| Open | always | reads: `getChat*`, `getChatLength`, `getRecentChats`, `getFullChat`, `getChatVar`, `getState`, `getGlobalVar`, `getName`, `getCharacterFirstMessage`, `getPersonaName`/`Description`, `getAuthorsNote`, `getLoreBooks`, `getCharacterImage`/`getPersonaImage`, `getCharacterLastMessage`, `getUserLastMessage`, `cbs`, `hash`, `log` |
| Safe | every mode except editDisplay | writes: `setChat`, `addChat`, `insertChat`, `removeChat`, `cutChat`, `setChatRole`, `setFullChat`, `setChatVar`, `setChatVarChanged`, `setState`, `stopChat`, `setName`, `setDescription`, `setCharacterFirstMessage`, `setBackgroundEmbedding`, `upsertLocalLoreBook`, `reloadDisplay`, `reloadChat`; also `getDescription`, `getBackgroundEmbedding`, all alerts, `getTokens`, `sleep` |
| EditDisplay | editDisplay only | only `setChatVar`/`setChatVarChanged`/`setState(Changed)` (they write the real, saved chat var); alerts and every other Safe call return nil |
| LowLevel | card `lowLevelAccess: true` (user confirms on import); a module has its own `lowLevelAccess` flag | `LLM`, `axLLM`, `simpleLLM`, `request`, `similarity`, `generateImage`, `loadLoreBooks`. Granted only in `onStart`/`onInput`/`onOutput`/`onButtonClick`/manual functions, **never in listenEdit hooks** (edit hooks always run with it off) |

Denials are silent: the call returns nil. Test each function in the mode where it will run.

## 4. API by area

`[a]` = returns a Promise: call `:await()` inside an `async` function. The wrapper already awaits `LLM`, `axLLM`,
`loadLoreBooks`, `getCharacterImage`, `getPersonaImage` (they still must run inside a coroutine, i.e. an `async` hook).

**Chat**
| Call | Notes |
|---|---|
| `getChat(id, i)` | `{role, data, time}`; `role` is `"user"`/`"char"`; negative `i` counts from the end; nil out of range |
| `getChatData(id, i)` / `getChatRole(id, i)` | just the text / role (`""` if missing) |
| `getChatLength(id)` | message count (greeting excluded; index 0 is the first message after it) |
| `getRecentChats(id, n)` | last n messages as a table; cheaper than `getFullChat` |
| `getFullChat(id)` / `setFullChat(id, t)` | whole array; heavy on long chats. `setFullChat` rebuilds every message from `role` and `data` only, dropping `time`, message ids, generation info and speaker; prefer `setChat`/`addChat`/`removeChat`. (PocketRisu keeps the other fields by index.) |
| `setChat(id, i, text)` / `setChatRole(id, i, role)` | replace text / role; negative `i` counts from the end; out of range does nothing |
| `addChat(id, role, text)` / `insertChat(id, i, role, text)` | role `"user"`; anything else becomes `"char"` |
| `removeChat(id, i)` / `cutChat(id, start, end_)` | delete one / keep a slice (JS `slice` semantics, 0-based, end exclusive) |
| `getCharacterLastMessage(id)` / `getUserLastMessage(id)` | last char text (falls back to the greeting) / last user text |

**Variables and state**
| Call | Notes |
|---|---|
| `getChatVar(id, k)` | string; unset -> the card's `defaultVariables` value (then the template default variables), else the string `"null"` |
| `setChatVar(id, k, v)` | stored as `scriptstate['$'..k]`; visible in RisuAI's variable panel and to CBS `{{getvar::k}}`. Pass strings (`tostring(n)`) |
| `setChatVarChanged(id, k, v)` | writes; returns `true` if the value changed, otherwise **nil** (not `false`, since 2026-08; nil also when denied). Test with `if setChatVarChanged(...) then` |
| `getState(id, n)` / `setState(id, n, v)` | JSON-encoded under chat var `__n`; tables allowed; unset -> nil |
| `setStateChanged(id, n, v)` | write-if-changed version (compares the JSON text; same true/nil return) |
| `getGlobalVar(id, k)` | read-only global (cross-chat) var; toggles are `toggle_<name>` |

**Character, persona, notes**
`getName`/`setName`, `getDescription`/`setDescription` (Safe tier; throw in group chats; wrap in `pcall`),
`getCharacterFirstMessage`/`setCharacterFirstMessage` (returns true/false), `getPersonaName`, `getPersonaDescription`
(CBS-parsed), `getAuthorsNote` (read-only; no setter), `getBackgroundEmbedding`/`setBackgroundEmbedding` (backgroundHTML,
Safe tier), `getCharacterImage`/`getPersonaImage` (`{{inlayed::…}}` markup, `""` on failure; need an `async` hook).
These edit the character card itself (all chats), not the current chat.

**Lorebook**
| Call | Notes |
|---|---|
| `getLoreBooks(id, name)` | synchronous; entries whose name (comment) equals `name` exactly, from the chat, character and module lorebooks, as full entry tables with `content` CBS-parsed. Errors in group chats |
| `upsertLocalLoreBook(id, name, content, {alwaysActive, insertOrder, key, secondKey, regex})` | Safe tier; create or replace a **chat-local** entry by name (`mode` normal, `selective` when `secondKey` is set). Always pass the options table (`{}` at least): omitting it throws. From `onStart`/`onInput`/`onOutput`/manual functions the host hands Lua a cloned character, so the write may be discarded; it sticks from `onButtonClick` and edit hooks (source reading, verify in the app) |
| `loadLoreBooks(id)` [low] | currently active entries `{data, role}` (CBS-parsed, empty ones skipped). The lorebook budget has already filtered entries; the wrapper passes no reserve, so no additional max-context cut applies; raw `loadLoreBooksMain(id, reserve):await()` cuts at max context minus `reserve` tokens |

**LLM and images** (LowLevel)
| Call | Notes |
|---|---|
| `LLM(id, msgs, useMultimodal?, {streaming=false}?)` | main model; `msgs` = `{ {role="system", content=…}, {role="user", content=…} }`; roles `system`/`sys`, `user`, `assistant`/`bot`/`char` (anything else becomes assistant); returns `{success, result}`, failure text starts with `"Error: "`. `useMultimodal=true` sends `{{inlay::…}}`/`{{inlayed::…}}` images in the content. streaming is off unless explicitly true; streaming=true streams internally and returns the final text |
| `axLLM(id, msgs, …)` | same, routed to the auxiliary model setting (`otherAx`). PocketRisu additionally passes the calling module ID for per-module model bindings; mainline does not |
| `simpleLLM(id, prompt)` [a] | one user string to the main model; `{success, result}` |
| `generateImage(id, prompt, neg)` [a] | `"{{inlay::…}}"` or `"Error: …"`; needs an image backend configured |

**Utility and UI**
| Call | Notes |
|---|---|
| `getTokens(id, s)` [a] | token count with the active tokenizer |
| `hash(id, s)` [a] | hex digest |
| `sleep(id, ms)` [a] | delay |
| `cbs(s)` | run the CBS parser (expands `{{user}}`, `{{getvar::…}}` …; `{{chat_index}}` is -1, and `{{setvar}}`-type setters do not run but stay as literal text) |
| `similarity(id, source, list)` [a][low] | semantic search over `list` |
| `request(id, url)` [a][low] | HTTPS GET only, URL ≤ 120 chars, about 5 per minute, risuai.net domains blocked; returns a JSON string `{status, data}` (decode it) |
| `alertError`/`alertNormal(id, msg)` | modal; Safe tier (not in editDisplay) |
| `alertInput(id, msg)` [a] / `alertSelect(id, {…})` [a] / `alertConfirm(id, msg)` [a] | typed string / the chosen **0-based index as a string** / boolean |
| `reloadDisplay(id)` / `reloadChat(id, i)` | re-render all / one message. Only reloadDisplay also clears the regex result cache; reloadChat can reuse stale OUT |
| `stopChat(id)` | cancel the pending send; effective only in `onStart` (same as returning false there) |

**Not in the Lua API** (current source): `setAuthorNote`, `getReplaceGlobalNote`, `setReplaceGlobalNote`, `setGlobalVar`,
and the `v2GetAllLorebooks` / `v2CreateLorebook` / `v2ModifyLorebookByIndex` family (those are V2 block-trigger
effects, not Lua functions; see §0). Older notes that list them as Lua calls are wrong.

## 5. Regex scripts next to Lua

Regex scripts ship beside the Lua in the module: `editinput` (saved), `editoutput` (saved), `editprocess` (request only),
`editdisplay` (screen only). Prefer `editdisplay` to hide tags (stored data unchanged) and `editprocess` to strip
display-only tags from the request. Details: 'RisuAI 정규식 작성법'.

## 6. Minimal template

```lua
local function initVar(id, key, default)
    local v = getChatVar(id, key)
    if v == nil or v == "null" or v == "" then setChatVar(id, key, default) end
end

function onStart(id)                        -- every send
    initVar(id, "bot_stage", "0")
    if getState(id, "bot_log") == nil then setState(id, "bot_log", {}) end
end

listenEdit('editOutput', function(id, text, meta)   -- parse a model tag into a var
    local v = text:match("<bot_stage>(.-)</bot_stage>")
    if v then setChatVar(id, "bot_stage", v) end
    return text
end)

listenEdit('editRequest', function(id, messages, meta)  -- inject context
    table.insert(messages, 2, { role = "system", content = "[Stage: " .. getChatVar(id, "bot_stage") .. "]" })
    return messages
end)
```

---

# Part B: Advanced mechanisms (patterns from well-regarded bots)

Most bots with serious Lua share: one async `onOutput` pipeline, authoritative state in `setState` with display copies in
chat vars, some reroll-safety scheme, and often a second LLM call. The rest are options.

## 7. The onOutput pipeline: async, per-job pcall, error var

```lua
local function job(id, name, fn)
    local ok, err = pcall(fn, id)
    if not ok then setChatVar(id, "bot_lua_error", name .. ": " .. tostring(err)) end
end

onOutput = async(function(id)
    local last = getChat(id, -1)
    if not last or last.role ~= "char" then return end   -- early exits: wrong role, already processed, feature off
    job(id, "state",  update_state)       -- parse tags, apply deltas
    job(id, "clock",  advance_clock)
    job(id, "status", run_status_aux)     -- may call axLLM
    job(id, "assets", run_asset_aux)
    job(id, "html",   render_panels)      -- cache HTML in chat vars
    pcall(reloadDisplay, id)
end)
```

- Each job in its own `pcall` so one failure does not stop the others. Show `bot_lua_error` in the options panel or a
  debug row; clear it on success if you want a "last run" indicator.
- `lowLevelAccess: true` on the card for `LLM`/`axLLM`.
- Early exits guard against paying twice when triggers fire again (reroll of nothing, regenerate of the same message).
- Keep order explicit: parse first, then derived values, then LLM jobs, then rendering.

## 8. State split and write-if-changed

- **Authoritative data in `setState`** (tables, numbers, histories, calendars). Lua-only; the model never sees it.
- **Display and prompt copies in chat vars**: score, gauge percent, icon file name, band label, prebuilt HTML. CBS and
  regex read them with `{{getvar::…}}` without Lua.
- **Write only on change**: `setChatVarChanged(id, k, v)` / `setStateChanged(id, n, v)` (both verified in source). This
  avoids needless re-renders and keeps the variable panel readable. A diff log (old -> new) helps debugging.
- Chat vars are strings; convert with `tonumber(v) or default`. `getChatVar` returns `"null"` for unset keys without a
  default.

## 9. Reroll / edit / delete safety: four schemes

Chat vars and state are **not** rolled back when the user rerolls, edits or deletes a message. Applying "+5 affection" from
every reply double-counts on reroll. Pick one scheme; teach at least one.

**(a) Snapshot + pending + processed index** (simple; handles reroll of the last reply)

```lua
local function apply_turn(id)
    local len  = getChatLength(id)
    local seen = getState(id, "bot_seen_len") or 0
    if len > seen then                                   -- new turn: freeze the values before this reply
        setState(id, "bot_base", getState(id, "bot_score") or {})
        setState(id, "bot_seen_len", len)
    end                                                  -- same length = reroll/edit: recompute from the same base
    local score = {}
    for k, v in pairs(getState(id, "bot_base") or {}) do score[k] = v end
    for name, d in pairs(parse_deltas(getChat(id, -1).data)) do
        score[name] = clamp((score[name] or 0) + d)
    end
    setState(id, "bot_score", score)
end
```
Limit: deleting several turns back is not undone.

**(b) Cursor + message signature + stored delta** (applies only the diff when the same message changes)

```lua
local function adler32(s)
    local a, b = 1, 0
    for i = 1, #s do a = (a + s:byte(i)) % 65521; b = (b + a) % 65521 end
    return b * 65536 + a
end
local function apply_diff(id)
    local idx = getChatLength(id) - 1
    local text = getChat(id, idx).data
    local sig = #text .. ":" .. adler32(text)
    local cur = getState(id, "bot_cursor") or { idx = -1 }
    if cur.idx == idx and cur.sig == sig then return end          -- already applied
    local new = parse_deltas(text)
    local old = (cur.idx == idx) and (cur.delta or {}) or {}      -- same slot changed: undo its old delta
    for k, v in pairs(new) do add_score(id, k, v - (old[k] or 0)) end
    for k, v in pairs(old) do if new[k] == nil then add_score(id, k, -v) end end
    setState(id, "bot_cursor", { idx = idx, sig = sig, delta = new })
end
```
This snippet processes only the current last message. To handle several new messages, explicitly iterate from the cursor; older edits/deletions require rollback or a full replay. A clamped add_score is not generally reversible: use snapshot recomputation if saturation matters. onOutput does not automatically run on a manual edit/delete, so reconciliation must also run before the next request or through an explicit rebuild action.

**(c) Per-message seed snapshot in a hidden comment, with GC** (rollback when the reconciliation pipeline runs)

```lua
local function save_seed(id, idx, text)
    local key = string.format("s%08x", math.random(0, 0x7fffffff))
    local seeds = getState(id, "bot_seeds") or {}
    seeds[key] = collect_state(id)                      -- every authoritative value as one table
    setState(id, "bot_seeds", seeds)
    setChat(id, idx, text .. "\n<!--bot-seed:" .. key .. "-->")
end
local function restore_latest(id)                       -- at the start of the next pipeline run
    local seeds = getState(id, "bot_seeds") or {}
    for i = getChatLength(id) - 2, 0, -1 do
        local k = (getChat(id, i).data or ""):match("<!%-%-bot%-seed:(%w+)%-%->")
        if k and seeds[k] then restore_state(id, seeds[k]); return end
    end
    restore_state(id, initial_state())
end
-- every N turns: delete seeds that no message references
```
The loop starts at length-2 because it assumes the last message is the new reply being recomputed. For a rebuild after deletion with no pending reply, include the last surviving message instead. Hook reconciliation explicitly; deletion itself does not call onOutput. Changes made by buttons between turns need a separate pending-delta record applied after restore. Strip the comment from requests with editprocess.

**(d) Event sourcing: rebuild from the whole chat** (correct by construction)

```lua
local function rebuild(id)
    local st = initial_state()
    for _, m in ipairs(getFullChat(id)) do
        for kind, a, b in (m.data or ""):gmatch("%[bot:(%w+)|([^|%]]*)|?([^%]]*)%]") do
            apply_event(st, kind, a, b)
        end
    end
    return st
end
```
Every output (and display, if needed) recomputes the state from `[bot:…]` event lines. Reroll, edit and delete are safe
with no bookkeeping. UI actions append an event line to the last message (`setChat(id, i, text .. "\n" .. line)`) so the
model also sees them. Cost grows with chat length. A cache keyed only by (length, last signature) misses edits to older messages: invalidate on any history mutation or hash the full relevant history. Avoid replay on every editDisplay; reconcile before the next request or with an explicit rebuild action, and watch memory on phones.

## 10. Aux-LLM structured extraction recipe

Main model writes prose; a cheap second call turns the recent log into structured data (status, affinity changes, tags).

```lua
local PROMPT = [[You are a data extraction bot. Output ONLY the format below. No other text.
User name: <<USER>>
Allowed names: <<NAMES>>
Format: <<FORMAT>>
Log:
<<LOG>>]]

local function fill(t, vars)          -- function replacement: '%' in values cannot break gsub
    return (t:gsub("<<(%u+)>>", function(k) return vars[k] or "" end))
end

local function build_log(id, budget)  -- newest first until the token budget is used
    local parts, used = {}, 0
    for i = getChatLength(id) - 1, math.max(0, getChatLength(id) - 12), -1 do
        local m = getChat(id, i)
        local s = (m.role == "user" and "USER: " or "NARRATION: ") .. strip_ui(m.data)
        used = used + #s / 3            -- rough estimate; getTokens(id, s):await() is exact
        if used > budget then break end
        table.insert(parts, 1, s)
    end
    return table.concat(parts, "\n\n")
end

local function extract(id)
    local idx, before = getChatLength(id) - 1, getChat(id, -1).data
    local prompt = fill(PROMPT, { USER = getPersonaName(id), NAMES = table.concat(NAMES, ", "),
                                  FORMAT = FORMAT_LINE, LOG = build_log(id, 10000) })
    local res
    for try = 1, 3 do
        res = axLLM(id, { { role = "user", content = prompt } })
        if res and res.success and res.result ~= "" then break end
    end
    if not (res and res.success) then setChatVar(id, "bot_aux_status", "failed"); return end
    local out = res.result:gsub("<think.->.-</think.->", ""):gsub("```%w*", "")
    local data = validate(out)          -- whitelist fields and names; recompute derived numbers in Lua
    local now = getChat(id, idx)        -- race guard: the user may have rerolled during the await
    if getChatLength(id) - 1 ~= idx or not now or now.data ~= before then return end
    setChat(id, idx, before .. "\n\n" .. render_block(data))
end
```

- Strict persona: "data extraction bot, output ONLY this format". Short example on the first run, compact example after.
- **Lua strings get no CBS**: substitute the user's name with `getPersonaName(id)` (or run `cbs()` on the text).
- Clean the reply: `<think>` blocks, code fences, repeated lines. Protect meaningful commas before normalizing numbers
  (placeholder swap, then restore).
- **Validate**: keep only whitelisted keys, drop unknown names and duplicate fields, clamp numbers, recompute formulas
  (for example "points needed for next level") in Lua instead of trusting the model.
- **Idempotent write**: strip any old block from the message first, then append the new one.
- **Adaptive window** (optional): if the previous structured block is not inside the log, grow the budget (for example 10k
  -> 13k -> 16k) before calling once.
- Let the user pick main model, aux model or off; in Lua mode an editoutput regex removes any block the main model wrote.

## 11. Lua-rendered HTML cached in chat vars

Heavy UI (calendar grid, timetable, roster cards) is built in Lua and stored in a chat var; the display regex is a thin
template:

```lua
setChatVar(id, "bot_cal_html", html)
setChatVar(id, "bot_cal_len", tostring(#html))
```
```
editdisplay out: {{#when::{{getvar::bot_cal_len}}::>::0}}{{getvar::bot_cal_html}}{{:else}}(fallback text){{/when}}
```
- Buttons inside the cached HTML stay live: raw `<button risu-btn="cal:prev">` / `risu-trigger="bot_cal_prev"` attributes,
  or `{{button::◀::bot_cal_prev}}` CBS (reported working when printed through `{{getvar}}`; note that a tag's result is
  not re-parsed in the same CBS pass, so a `{{button}}` stored in a variable renders only if a later pass parses the
  text again; raw `risu-trigger`/`risu-btn` attributes need no parsing and are the safer choice).
- Escape user-provided text (`&`, `<`, `>`, `"`) before putting it into HTML.
- Logic in Lua, layout in regex and backgroundHTML CSS. Rebuild only when the inputs change.

## 12. Calendar and world clock

```lua
local function is_leap(y) return (y % 4 == 0 and y % 100 ~= 0) or y % 400 == 0 end
local DIM = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }
local function days_in(y, m) return (m == 2 and is_leap(y)) and 29 or DIM[m] end
local function weekday(y, m, d)          -- 0 = Sunday (Sakamoto)
    local t = { 0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4 }
    if m < 3 then y = y - 1 end
    return (y + y // 4 - y // 100 + y // 400 + t[m] + d) % 7
end
local EVENTS = {                         -- fixed / annual / scheduled / user-added
    { m = 5, d = 10, key = "festival", kind = "scheduled", priority = 2, prep = 3, after = 2 },
}
```
- Parse the story date from the status line each turn; advance only from parsed values, never guess.
- Event tables: annual holidays, birthdays, scheduled story events with prelude/aftermath windows and priorities (override >
  scheduled > random > ambient), user-added events (`alertInput` "YYYY-MM-DD text").
- **Period overrides** (vacations, trips) switch schedule variables for a date range. A custom start date marks earlier
  events as done. Validate date ranges and leap days on input.
- Time of day can come from the status line or from turn count (e.g. every 4 turns advance morning/day/evening/night).
- **Inject what matters into the prompt**: write today's and upcoming events into a chat var printed by a constant lorebook
  entry. A calendar that only renders on screen leaves the narrator unaware of it.

## 13. i18n tables

```lua
local L10N = {
    en = { saved = "Saved.", day = "Day %d" },
    ko = { saved = "...", day = "..." },
}
local function tr(id, key, ...)
    local t = L10N[getChatVar(id, "bot_lang")] or L10N.en
    local s = t[key] or L10N.en[key] or ("[missing " .. key .. "]")
    return select("#", ...) > 0 and string.format(s, ...) or s
end
```
One language variable drives greetings (CBS branches), lorebook headings, Lua alerts, status examples and UI labels, so a
single card serves several languages. A separate UI-language variable is optional.

## 14. listenEdit usage patterns

- **editDisplay: model tags -> buttons.** Turn `[choice|Label|payload]` into `<button risu-btn="choice:payload">Label</button>`,
  only for the newest message (`meta and meta.index == getChatLength(id) - 1`); older copies render as plain text. Also
  hides markers. Display runs on every render: keep it cheap, no LLM calls, no writes (only `setChatVar` works there).
- **editRequest: scrub.** Remove image tags, old status blocks, UI glyphs and control markers from `messages[i].content`
  before sending. Only the chat request built by sendChat passes through it; Lua `LLM`/`axLLM` calls do not, so an aux
  prompt needs no skip logic here.
- **Slash commands** (`/reset`, `/set name 50`). RisuAI first tries its own commands (`/echo`, `/input`, `/send`,
  `/cut`, `/del`, `/setvar`, `/addvar`, `/getvar`, `/trigger` …); a known name is consumed and never sent, an unknown one
  continues as a normal message. Do not stop it in editInput: `stopChat` and `return false` are ignored there, and a `""`
  return still sends an empty user turn. Handle it in `onStart`, the only hook that can cancel the send:
  ```lua
  onStart = async(function(id)
      local last = getChat(id, -1)
      local cmd, arg = last and last.role == "user" and last.data:match("^/(%w+)%s*(.*)$")
      if cmd and COMMANDS[cmd] then
          COMMANDS[cmd](id, arg)            -- may :await() alerts
          removeChat(id, -1)                -- drop the command message
          return false                      -- cancel this send
      end
  end)
  ```
  A plain button action can also be reached as `/trigger bot_reset` (runs the global `bot_reset(id)`). Alternatively an
  editprocess regex expands a short command into a hidden instruction while the visible message stays short.
- **editOutput: completion tokens.** The model emits an exact token (`<bot-done:quest_key>`); editOutput sets the flag and may
  strip or keep the token. Also a good place to normalize tag mistakes before they are saved.

## 15. Hidden control markers between model and Lua

The narrator reports state changes through markers that Lua reads and the display hides:
- Model -> Lua: `[[bot:event:festival:fired]]`, `[[bot:scene:protect]]`, `[bot:aff|Name|up]`. An editdisplay regex hides
  them; they stay in stored data for Lua (and for event sourcing, §9d). editprocess keeps them only for recent messages or
  removes them.
- Lua -> model: hidden OOC lines appended to a user message (`<!-- OOC: next reply must include a skill check -->`) or text
  in a chat var printed by a lorebook entry. Use cooldowns (keyed on chat length) so one trigger does not repeat every turn.
- Choose delimiters the model will not produce by accident, and state the exact syntax in the instruction.

## 16. Button handler families and metatable dispatch

```lua
local HANDLERS = {
    opt = function(id, arg) local k, v = arg:match("^(%w+):(%w+)$"); setChatVar(id, "bot_" .. k, v) end,
    tab = function(id, arg) setChatVar(id, "bot_tab", arg) end,
}
onButtonClick = async(function(id, data)        -- risu-btn="opt:nsfw:1"
    local cmd, arg = data:match("^([%w_]+):?(.*)$")
    local h = cmd and HANDLERS[cmd]
    if h then h(id, arg); pcall(reloadDisplay, id) end
end)
```
- **One dispatcher with a payload** (`risu-btn`) scales better than one global per button. Option panels:
  'RisuAI 옵션 패널 (슬라이딩 드로어)'.
- For `risu-trigger` names, generate globals in a loop: `for _, k in ipairs(KEYS) do _G["bot_set_" .. k] = function(id) … end end`.
  Cost note: every distinct manual name gets its own engine, so the first click on each name loads and runs the whole
  script once more, and each manual run deep-clones the character and chat. Many unique names = slower first clicks and
  more memory; `risu-btn` payloads share one `onButtonClick` engine.
- After either kind of click the host applies the returned chat and re-renders **only the clicked message**; call
  `reloadDisplay(id)` when other messages or the background depend on what changed. Both are ignored in group chats.
- **Metatable `__index` on `_G`** resolves parameterized names without predeclaring them:
  ```lua
  setmetatable(_G, { __index = function(_, name)
      local kind, arg = tostring(name):match("^bot_(%a+)_(.+)$")
      if kind and HANDLERS[kind] then return function(id) return HANDLERS[kind](id, arg) end end
  end })
  ```
  Reported working in a reference bot (`risu-trigger="bot_add_<id>"`); it depends on the host's global lookup honoring the
  metatable. Test on the user's RisuAI version.
- Drafts and multi-select state: store as JSON in a chat var; decode with `pcall(json.decode, s)` and a fallback.
- Heavy multi-step flows: chain `alertSelect(...):await()` / `alertInput(...):await()` inside an async handler.

## 17. Presence detection and roster swap

```lua
local function mark_presence(id)
    local text = {}
    for _, m in ipairs(getRecentChats(id, 9)) do text[#text + 1] = m.data end
    text = table.concat(text, "\n")
    for _, c in ipairs(CAST) do                      -- { id = "a", keys = { "Name", "alias" } }
        local here = false
        for _, k in ipairs(c.keys) do if text:find(k, 1, true) then here = true; break end end
        setChatVarChanged(id, "bot_away_" .. c.id, here and "0" or "1")
    end
end
```
The constant roster entry prints `{{#when::bot_away_a::vis::1}}- Name: one-line summary{{/when}}` only for absent
characters, while the keyword-triggered detail profile covers present ones: no duplicated tokens. Plain `find` with
`plain=true` avoids pattern characters in names.

## 18. Periodic off-screen tracker and long summaries

- Every N turns (`getChatLength(id) % 8 == 0`), an `axLLM` call summarizes what off-screen characters are doing; every M
  turns, a long-term summary of relationships and events.
- Store results in chat vars; a constant lorebook entry at `@@depth 0` (or a `{{position::…}}` slot) prints them.
- Keep them short and bounded (replace, not append), and give the model a rule on how to use them (background only).

## 19. Dice checks

```lua
local function check(id, skill, dc)
    local roll = math.random(1, 20)
    local total = roll + skill_bonus(id, skill) + perk_bonus(id, skill)
    local r = roll == 20 and "critical success" or roll == 1 and "critical failure"
           or (total >= dc and "success" or "failure")
    return string.format("[Check|%s|%d+%d vs %d|%s]", skill, roll, total - roll, dc, r)
end
```
- Put the result line into the user message (`setChat`) or a new user message so the model narrates the outcome.
- Tokens / perks that reroll or modify edit the **existing** result line, then `reloadChat(id, i)`; commit consumption
  later from the text so rerolls do not double-spend.
- Pure-CBS alternative for random events: `{{#when::{{roll::500}}::<=::N}}` gates in constant entries (older bots:
  `{{#if {{? {{roll::500}}<=N}}}}`; see 'RisuAI CBS 문법').

## 20. Self-tests, backup and restore

- A hidden button runs parser tests on fixed strings (`alertNormal(id, "parser tests: 12/12 ok")`). Cheap insurance for
  pattern-heavy scripts.
- Backup: `alertNormal(id, json.encode(collect_state(id)))`; restore: `alertInput(id, "paste backup"):await()`, then
  `pcall(json.decode, s)` and validate keys before writing.

## 21. Dynamic lorebook API vs CBS-gated constant entries

The API exists (`upsertLocalLoreBook`, `getLoreBooks`, `loadLoreBooks`), but well-regarded bots mostly gate content with CBS
inside constant entries: `{{#when::bot_stage::vis::2}}…{{/when}}`, `{{#func}}` score bands, seed buckets.
- **CBS gating is better** when the texts are known in advance and states are few: visible and editable in the card,
  no Lua needed, works for users who disable scripts, and follows chat vars automatically.
- **The dynamic API is better** when content is generated at runtime (summaries, user-created entries) or unbounded in
  number. Costs: entries live in the chat's local lorebook, are invisible in the card editor, and are not rolled back by
  rerolls (combine with §9).

---

## 22. Pitfalls

1. Silent errors and silent permission denials: wrap jobs in `pcall`, log to a chat var, test in the real mode.
2. Lua globals are per mode (a flag set in `onOutput` is not visible in `onButtonClick`) and are reset whenever a card
   script and a module script share a mode. Use chat vars / state.
3. `onStart` runs on every send (also reroll/continue), not on chat open, and after the description and lorebook were
   already built; defaults for the greeting belong in `defaultVariables`.
4. Returning nil from a `listenEdit` callback breaks the chain; so does wrapping the callback in `async`.
5. Writes from editDisplay no-op (except `setChatVar`/`setState`); `setChat` and alerts there do nothing.
6. `LLM`/`axLLM` without `lowLevelAccess`, or inside any listenEdit hook, return nil; outside an `async` hook they cannot
   await.
6a. `onInput` runs before the user's message is in the chat, and `stopChat`/`return false` only work in `onStart`.
6b. `setFullChat` strips message metadata (ids, times, generation info); edit single messages instead.
7. Parsing `getFullChat` on every turn or render in a long chat freezes phones; prefer `getChat(id, -1)` / `getRecentChats`.
8. Reroll double-counting: any "add delta from the last reply" needs a §9 scheme.
9. Async race: re-read the message after every await before `setChat`.
10. `gsub` replacement strings treat `%` specially; use a function replacement or escape `%%`.
11. `json.encode` of a table not starting at index 1 becomes an object.
12. Variable-name typos in gates (a var with or without a prefix) fail silently; list all names in one table.
13. Patterns left on an old format never match after a format change; update Lua patterns, regex and instructions together.
14. Referencing assets, entries or files that do not exist (a default icon, a lorebook entry name) fails silently.
15. `getDescription` throws in group chats.

## 23. Build / review checklist

- [ ] all logic in the Lua trigger (no V1/V2 items added; legacy items ported per §0)
- [ ] `lowLevelAccess` set only if LLM/axLLM/request/generateImage are used, and those calls sit outside listenEdit hooks
- [ ] every hook's early exits and `pcall`s in place; `bot_lua_error` (or similar) visible somewhere
- [ ] authoritative state in `setState`; display copies via write-if-changed
- [ ] a reroll/edit/delete scheme chosen and tested by rerolling, editing and deleting a reply
- [ ] every await followed by a re-read before writing
- [ ] editDisplay callbacks cheap and write-free; editOutput idempotent (it reruns per streamed chunk)
- [ ] all listenEdit callbacks return the value; `meta` nil-guarded
- [ ] defaults in `defaultVariables`; names in Lua, CBS, regex and options panel identical
- [ ] prompt-relevant state (events, summaries, clock) reaches the model through a lorebook entry or instruction
- [ ] tested on a long chat on a phone
