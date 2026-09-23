> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

# RisuAI processing order (regex and Lua hooks)

Read this when you need to know **when, in what order and on what text** the regex scripts (editinput, editoutput, editprocess, editdisplay, edittrans), the Lua `listenEdit` hooks and the triggers run in one turn, and whether each result is **saved**. Use it when you build regex, triggers or background HTML, or when you have to explain "why is this tag in the request / on screen / in the saved log".
How to write the rules themselves is in 'RisuAI 정규식 작성법', and the Lua API is in 'RisuAI Lua 트리거'.
Source: RisuAI `src/ts/process/index.svelte.ts` (sendChat), `scripts.ts` (processScriptFull), `scriptings.ts` (runLuaEditTrigger, runScripted), `parser/parser.svelte.ts` (ParseMarkdown), `lib/ChatScreens/Chat.svelte` and `DefaultChatScreen.svelte`, `triggers.ts` (runTrigger), `command.ts`, as of origin/main 2026-09. PocketRisu has the same order (it has no group chats).

Contents
1. One turn, end to end
2. Inside one stage: what runs first
3. Lua trigger hooks
4. Buttons and manual triggers
5. Design consequences of the timing
6. Common misdiagnoses (pitfalls)

---

## 1. One turn, end to end

```
[user presses send]
 0. RisuAI slash commands                 ← "/name …" with a known name is consumed here and nothing is sent.
 1a. Lua onInput                          ← only for non-empty input in a 1:1 chat, BEFORE the user message exists
                                             (getChat(id,-1) is the previous message). Its stop request is ignored.
 1b. editinput (regex) + Lua editInput    ← applied to the input box text. The result is SAVED as message.data.
                                             Skipped for an empty send, reroll and continue.
[sendChat starts: also on reroll, continue, auto-continue]
 2. prompt parts built and CBS-parsed    ← main prompt, description, persona, author's note; lorebook matching (which
                                             entries activate) and CBS of ordinary and depth-0 entries.
 3. Lua onStart                           ← after 2, before the history: variables it sets reach 4-6 (and positive-depth / reverse-depth
                                             lorebook text) now, but the rest of 2 only on the next send. `return false`
                                             or stopChat stops the send (the only hook that can).
 4. editprocess (regex)                   ← applied to the greeting and to EVERY turn separately, building the request
                                             text. Not saved. There is no Lua hook at this stage.
 5. prompt assembly (template order, depth prompts, summaries)
 6. Lua editRequest                       ← the finished request array (OpenAIChat[]). The last Lua touch. Not saved.
    (V2 "request" triggers, if any, run later inside the request call)
[model reply]
 7. editoutput (regex) + Lua editOutput   ← applied to the model output. The result is SAVED as message.data.
                                             During streaming it is re-applied to every chunk (or once at the end in the
                                             strongest streaming performance mode); the final version is saved.
 8. CBS variable pass over the chat, then Lua onOutput ← after saving: update variables, post-process, aux-model calls.
[display: on every render]
 9. Lua editDisplay + editdisplay (regex) ← only for showing. NOT saved.
                                             It runs again on every scroll and re-render.
```

Remember:
- **Only stages 1b (editinput) and 7 (editoutput) are saved**, plus whatever Lua writes with `setChat`. If a tag is still in the raw chat log, editoutput did not remove it. If it is only missing on screen, editdisplay hid it.
- **The CBS variable pass** runs at the start of every sendChat (before step 2) and again in step 8. It parses every stored message with variable permission and **saves the result**: `{{setvar}}`/`{{addvar}}` left in messages run then, and any other CBS in stored text is resolved permanently (asset tags and unknown tags stay). It is the only place CBS setters run.
- **What the model receives is the text after stage 4 (editprocess) and then stage 6 (editRequest).** To keep display decorations (HTML, status cards) out of the request, remove them with editprocess. editdisplay has no effect on the request.
- editdisplay runs on every render, so heavy regexes slow scrolling. A cache exists (the same input and the same scripts reuse the result).
- **A Lua edit hook runs before the regexes of the same stage.** editprocess has no Lua hook; editRequest takes that role.

---

## 2. Inside one stage: what runs first

`processScriptFull(char, text, stage, messageIndex)` runs for editinput, editoutput, editprocess and editdisplay:
1. The Lua `listenEdit` hook for the stage (`editInput` / `editOutput` / `editDisplay`). editprocess returns immediately here.
2. For editdisplay only, V2 triggers of type `display` (Lua does not run here). New bots use Lua editDisplay.
3. Plugin hooks for the stage.
4. **The whole text is CBS-parsed once.** CBS written inside the message is resolved before any regex sees it, so a regex cannot match a literal `{{…}}` from the message.
5. **Cache lookup.** The key is the text, every script's in/out/flag/ableFlag (with `<cbs>` patterns already parsed) and the message index. **Chat variables and message count are not part of the key**, so OUT can stay stale in any stage. reloadDisplay clears this cache via ReloadGUIPointer; clicked-message refresh / reloadChat do not.
6. **The regex scripts.** The list is preset regex (`presetRegex`), then the card's `customscript`, then module regex. Scripts run top to bottom, or sorted by `<order N>` (higher first) when any script sets one. Only scripts whose `type` equals the stage run. After each ordinary replacement the whole text is CBS-parsed again, so CBS in `out` runs; that is how window guards work.
7. PocketRisu also CBS-parses move_top/move_bottom results immediately; mainline skips that parse in the move branch.
8. For editoutput and editdisplay, dynamic asset matching (the `dynamicAssets` setting) fuzzy-matches `{{asset::…}}` and `<img>` names. It is not applied at editinput or editprocess.

Field and flag semantics (`$n`, `ableFlag`, `<move_top>`, `@@repeat_back` …) are in 'RisuAI 정규식 작성법' §1.

**Where editdisplay sits in rendering** (ParseMarkdown): the message is CBS-parsed, then additional-asset tags are parsed, then editdisplay (the steps above), then asset parsing again if the text changed, then inlay images, then thinking/tool blocks, then markdown rendering and sanitizing. **Regex output therefore goes through markdown afterwards.** Loose inline HTML on one line can be wrapped in `<p>`; see the markdown pitfall in 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

**The background HTML** (`backgroundHTML` and a module's background embedding) is CBS-parsed and then passes through the **same editdisplay scripts** with message index -1, without markdown. Consequences: a theme-token regex can edit the CSS; a broad display pattern can damage it by accident; and index windows can include it in short chats. The greeting also has index -1: use a message-specific marker to distinguish it from the background.

**edittrans** uses a separate implementation (`translator/translator.ts`), ordered preset, module, card. It supports `<order>`, `<cbs>` in IN and `<move_top>`/`<move_bottom>`, but does not CBS-parse OUT, expand `{{data}}`, append a newline after `>`, or implement `@@` prefixes / inject / repeat_back like processScriptFull.

---

## 3. Lua trigger hooks (triggerscript, `effect[0].type == "triggerlua"`)

- **Lua and V2 are supported.** V1 is deprecated. V2 has a small Deprecated effects category; showDeprecatedTriggerV2 hides those effects, not V2 itself. Prefer Lua for these recipes; preserve working V2 unless conversion is requested or fixes a concrete issue. A triggerlua item runs in every mode regardless of its type, except display/request trigger modes (use editDisplay/editRequest).
- A card has **one** Lua script (a module may add its own; both run, card first, and they share one engine per mode, which resets Lua globals whenever they alternate). Define `onStart(triggerId)`, `onInput(triggerId)`, `onOutput(triggerId)` and `onButtonClick(triggerId, data)` as global functions and they are called automatically.
- Edit hooks are registered with `listenEdit(type, fn)`. Every callback receives `(triggerId, value, meta)`: editInput, editOutput and editDisplay get a string and **must return a string** (a nil return breaks the chain); `meta.index` is the message index (`-1` for editInput and the background). `editRequest` gets the array of `{role, content}`, returns an array, and its `meta` is an empty table. Do not wrap callbacks in `async` (they already run in a coroutine and can `:await()`).
- Listeners run in registration order, before the same stage's regexes.
- **Stopping**: only `onStart` can stop the send (`return false` or `stopChat`). The same call in onInput, onOutput, buttons or edit hooks is ignored.
- `editRequest` is the only Lua place that changes the final form sent to the model (injecting a system prompt, deleting a specific turn, stripping tags). It has no effect on the screen or on the saved text, and Lua's own `LLM`/`axLLM` requests do not pass through it.
- editDisplay runs with a display-only permission: only `setChatVar` (and `setState`) work there, writing the real saved variable without a re-render; alerts, chat writes and reloads are ignored. See 'RisuAI 옵션 패널 (슬라이딩 드로어)' §3.3.
- Lua edit hooks run with `lowLevelAccess` off, whatever the card setting. `LLM` and `axLLM` belong in `onStart`/`onOutput`, button handlers or manual functions.
- For the detailed API (getChatVar/setChatVar, getChat/setChat, log and so on), load the skill 'RisuAI Lua 트리거'.

| Hook | Runs on | Can stop send | lowLevelAccess | Chat writes |
|---|---|---|---|---|
| `onInput` | non-empty send, 1:1 chat, before the user message is added | no | card setting | yes |
| editInput | the typed text (index -1) | no | off | yes (Safe) |
| `onStart` | every sendChat (send, reroll, continue) | **yes** | card setting | yes |
| editRequest | final request array | no | off | yes (Safe) |
| editOutput | every streamed chunk and the final text | no | off | yes (Safe) |
| `onOutput` | after the reply is saved | no | card setting | yes |
| editDisplay | every render of every message and the background | no | off | no (vars only) |
| `onButtonClick` / manual `name` | click, `/trigger name` | no | card setting | yes; clicked message re-rendered |

---

## 4. Buttons and manual triggers

The chat screen catches a click on the nearest element with `risu-trigger` or `risu-btn`:
- `risu-trigger="name"` (and `{{button::label::name}}`, which renders `<button risu-trigger="name">`) runs a **manual trigger** called `name`: for a Lua trigger script it calls the **global Lua function `name(triggerId)`** (each name gets its own engine; the slash command `/trigger name` does the same). In legacy bots it may instead run a V1/V2 trigger (only V1 is deprecated as a whole) whose `comment` is `name`. No payload is passed, so parameterized actions need one function per value (see the handler families in 'RisuAI 옵션 패널 (슬라이딩 드로어)').
- `risu-btn="payload"` calls `onButtonClick(triggerId, payload)`.
- Afterwards the chat is updated and **the clicked message is re-rendered**. Other messages are not, unless the handler calls `reloadDisplay`.
- In group chats both are ignored.

---

## 5. Design consequences of the timing

- If Lua `editRequest` must read tags from history, do not strip them with editprocess, because editprocess runs first. Strip them inside editRequest instead.
- CBS setters (`{{setvar}}`, `{{addvar}}`) in an editoutput `out` are not run by the regex pass; the literal tag is saved into the reply and runs once when the finished reply's stored text is re-parsed with variable permission (after streaming ends, before the `output` trigger / `onOutput`), and again for every reroll. In editdisplay or editprocess `out` they never run and stay as literal text. Accumulate stats in Lua with message-keyed snapshots, not in regex CBS.
- Random in OUT re-rolls on cache misses, including successive streaming chunks; cache hits reuse the result. Final editoutput text is saved.
- A regex window over the request (`chat_index >= lastmessageid-N`) changes old request text as the chat grows, which breaks provider prompt caching from that point.
- Values the model must see come from the request (editprocess, lorebook, `{{getvar}}` in prompts). Values the user must see come from display. Anything that must survive export or a regex change belongs in saved text (editoutput or `setChat`).

---

## 6. Common misdiagnoses (pitfalls)

| Symptom | Cause | Fix |
|---|---|---|
| Status HTML eats request tokens | It is only decorated with editdisplay and never removed with editprocess | Add an `editprocess` rule with the same pattern (empty `out`, or a window guard) |
| Exported chat still contains the tags | editdisplay does not change the saved text | Clean saved text with `editoutput` (for future turns); fix existing turns with Risu Hina's find-and-replace |
| The user's input is already changed when saved | editinput is applied before saving | If that is not intended, move the rule from editinput to editprocess |
| The regex only replaces the first match | ableFlag is true but the flag has no `g` | Add `g` to the flag (or set ableFlag false for the default `g`) |
| `<move_top>` / `<order>` / `<cbs>` do nothing | ableFlag is false, so the flag string is ignored | Set ableFlag true |
| Wrote `$n` and got a line break | `$n` is reserved for a newline | Use `$1`-`$9` for captures and `$<name>` for named groups |
| A Lua hook does not change the value | No return, the callback wrapped in `async`, or an error inside it (edit hooks then keep the original text) | `return` the value from a plain `function(id, text, meta)`; all callbacks get 3 arguments |
| A Lua slash command or `stopChat` still sends the message | Stopping only works in `onStart`; editInput/onInput cannot cancel | Detect the command in `onStart`, handle it, `removeChat(id, -1)`, `return false` |
| A variable set in `onStart` is not reflected in the description or lorebook text, or does not change which entries activate | Those were matched and CBS-parsed before onStart ran (only positive-depth and reverse-depth entries are parsed after it; depth 0 is already parsed) | Set it earlier (button, onOutput of the previous turn) or inject through editRequest |
| The screen does not update after a variable changed | The display cache key has no variables | Add a comment cache-buster in Lua editDisplay, or re-render ('RisuAI 상태창' §5) |
| A theme-token regex has no effect | It is wrapped in a `chat_index` window guard, which depends on chat length even for the background | Remove the guard from background rules |
| The background CSS is broken | A broad editdisplay pattern also matched the CSS | Anchor the pattern on the bot's own tags |
