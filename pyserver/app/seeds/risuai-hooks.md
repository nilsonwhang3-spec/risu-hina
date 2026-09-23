# RisuAI processing order (regex and Lua hooks)

Read this when you need to know **when, in what order and on what text** the regex scripts (editinput, editoutput, editprocess, editdisplay, edittrans), the Lua `listenEdit` hooks and the triggers run in one turn, and whether each result is **saved**. Use it when you build regex, triggers or background HTML, or when you have to explain "why is this tag in the request / on screen / in the saved log".
How to write the rules themselves is in 'RisuAI 정규식 작성법', and the Lua API is in 'RisuAI Lua 트리거'.
Source: RisuAI `src/ts/process/index.svelte.ts` (sendChat), `scripts.ts` (processScriptFull), `scriptings.ts` (runLuaEditTrigger, runScripted), `parser/parser.svelte.ts` (ParseMarkdown), `lib/ChatScreens/Chat.svelte` and `DefaultChatScreen.svelte`, as of 2026-08/09.

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
 1. editinput (regex) + Lua editInput   ← applied to the input box text. The result is SAVED as message.data.
[sendChat starts]
 2. start trigger (Lua onStart / V2 start) ← before the message array is built: initialize variables, cutchat, etc.
                                             Returning false stops the send.
 3. editprocess (regex)                   ← applied to the greeting and to EVERY turn separately, building the request
                                             text. Not saved. There is no Lua hook at this stage.
 4. prompt assembly (template, lorebook, summaries, depth prompts)
 5. Lua editRequest                       ← the finished request array (OpenAIChat[]). The last touch. Not saved.
[model reply]
 6. editoutput (regex) + Lua editOutput   ← applied to the model output. The result is SAVED as message.data.
                                             During streaming it is re-applied to every chunk; the final version is saved.
 7. output trigger (Lua onOutput / V2 output) ← right after saving: update variables, post-process, aux-model calls.
[display: on every render]
 8. editdisplay (regex) + Lua editDisplay + display trigger ← only for showing. NOT saved.
                                             It runs again on every scroll and re-render.
```

Remember:
- **Only stages 1 (editinput) and 6 (editoutput) are saved**, plus whatever Lua writes with `setChat`. If a tag is still in the raw chat log, editoutput did not remove it. If it is only missing on screen, editdisplay hid it.
- **What the model receives is the text after stage 3 (editprocess) and then stage 5 (editRequest).** To keep display decorations (HTML, status cards) out of the request, remove them with editprocess. editdisplay has no effect on the request.
- editdisplay runs on every render, so heavy regexes slow scrolling. A cache exists (the same input and the same scripts reuse the result).
- **A Lua edit hook runs before the regexes of the same stage.** editprocess has no Lua hook; editRequest takes that role.

---

## 2. Inside one stage: what runs first

`processScriptFull(char, text, stage, messageIndex)` runs for editinput, editoutput, editprocess and editdisplay:
1. The Lua `listenEdit` hook for the stage (`editInput` / `editOutput` / `editDisplay`). editprocess returns immediately here.
2. For editdisplay only, the display trigger (V2/block triggers of type display).
3. Plugin hooks for the stage.
4. **The whole text is CBS-parsed once.** CBS written inside the message is resolved before any regex sees it, so a regex cannot match a literal `{{…}}` from the message.
5. **Cache lookup.** The key is the text, every script's in/out/flag/ableFlag (with `<cbs>` patterns already parsed) and the message index. **Chat variables are not part of the key**, so a display that depends only on a changed variable can stay stale.
6. **The regex scripts.** The list is preset regex (`presetRegex`), then the card's `customscript`, then module regex. Scripts run top to bottom, or sorted by `<order N>` (higher first) when any script sets one. Only scripts whose `type` equals the stage run. After each ordinary replacement the whole text is CBS-parsed again, so CBS in `out` runs; that is how window guards work.
7. For editoutput and editdisplay, dynamic asset matching (the `dynamicAssets` setting) fuzzy-matches `{{asset::…}}` and `<img>` names. It is not applied at editinput or editprocess.

Field and flag semantics (`$n`, `ableFlag`, `<move_top>`, `@@repeat_back` …) are in 'RisuAI 정규식 작성법' §1.

**Where editdisplay sits in rendering** (ParseMarkdown): the message is CBS-parsed, then additional-asset tags are parsed, then editdisplay (the steps above), then asset parsing again if the text changed, then inlay images, then thinking/tool blocks, then markdown rendering and sanitizing. **Regex output therefore goes through markdown afterwards.** Loose inline HTML on one line can be wrapped in `<p>`; see the markdown pitfall in 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

**The background HTML** (`backgroundHTML` and a module's background embedding) is CBS-parsed and then passes through the **same editdisplay scripts** with message index -1, without markdown. Consequences: a theme-token regex can edit the CSS; a broad display pattern can damage it by accident; and `chat_index`-based window guards are always false there.

**edittrans** runs only on text produced by the built-in translator. Its list order is preset, then module, then card, and it uses the same flag metas.

---

## 3. Lua trigger hooks (triggerscript, `effect[0].type == "triggerlua"`)

- A card has **one** Lua script. Define `onStart(triggerId)`, `onInput(triggerId)`, `onOutput(triggerId)` and `onButtonClick(triggerId, data)` as global functions and they are called automatically.
- Edit hooks are registered with `listenEdit(type, fn)`. `editInput(triggerId, text)`, `editOutput(triggerId, text)` and `editDisplay(triggerId, text, meta)` receive a string and **must return a string**; without a return nothing changes. `editRequest(triggerId, messages, meta)` receives an array of `{role, content}` and returns an array.
- Listeners run in registration order, before the same stage's regexes. When onStart returns `false`, the send is stopped.
- `editRequest` is the only Lua place that changes the final form sent to the model (injecting a system prompt, deleting a specific turn, stripping tags). It has no effect on the screen or on the saved text.
- editDisplay runs with a display-only permission: `setChatVar` and alerts work there, but chat writes and reloads are ignored. See 'RisuAI 옵션 패널 (슬라이딩 드로어)' §3.3.
- Lua edit hooks run with `lowLevelAccess` off, whatever the card setting. `LLM` and `axLLM` belong in `onOutput` or in button handlers.
- For the detailed API (getVar/setVar, getChat/setChat, log and so on), load the skill 'RisuAI Lua 트리거'.

---

## 4. Buttons and manual triggers

The chat screen catches a click on the nearest element with `risu-trigger` or `risu-btn`:
- `risu-trigger="name"` (and `{{button::label::name}}`, which renders `<button risu-trigger="name">`) runs a **manual trigger** called `name`. That runs a V2/block trigger whose name is `name`; for a Lua trigger script, it calls the **global Lua function `name(triggerId)`**. No payload is passed, so parameterized actions need one function per value (see the handler families in 'RisuAI 옵션 패널 (슬라이딩 드로어)').
- `risu-btn="payload"` calls `onButtonClick(triggerId, payload)`.
- Afterwards the chat is updated and **the clicked message is re-rendered**. Other messages are not, unless the handler calls `reloadDisplay`.
- In group chats both are ignored.

---

## 5. Design consequences of the timing

- If Lua `editRequest` must read tags from history, do not strip them with editprocess, because editprocess runs first. Strip them inside editRequest instead.
- CBS side effects (`{{setvar}}`, `{{addvar}}`) in an editoutput `out` run again on reroll, and may run while streaming. Accumulate stats in Lua with message-keyed snapshots, not in regex CBS.
- `{{random}}` in an editdisplay `out` re-rolls on every render; in editoutput it is resolved once and saved.
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
| A Lua hook does not change the value | No return, or the wrong argument count | `return` the string (editOutput receives 2 arguments, editDisplay 3) |
| The screen does not update after a variable changed | The display cache key has no variables | Add a comment cache-buster in Lua editDisplay, or re-render ('RisuAI 상태창' §5) |
| A theme-token regex has no effect | It is wrapped in a `chat_index` window guard, which is false for the background | Remove the guard from background rules |
| The background CSS is broken | A broad editdisplay pattern also matched the CSS | Anchor the pattern on the bot's own tags |
