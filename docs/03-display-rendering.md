# 03. Can the bot card's REGEX/LUA/CBS rendering be reflected in the left panel?

Reviewed 2026-08-23. Conclusion first: **we do not do a full replica. We go as far as the regex + CSS stage.**

## The path to what the user actually sees

`processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)` — `PocketRisu/src/ts/process/scripts.ts:99`.
In order:

1. `runLuaEditTrigger(char, mode, data, {index})` — **Lua VM** (`wasmoon ^1.16.0`)
2. `runTrigger(currentChar, 'display', {...})` — trigger scripts (Lua/CBS again)
3. the plugin `editdisplay` hook
4. `risuChatParser(data, {chatID, cbsConditions})` — **the entire CBS engine**
5. regexes: `db.presetRegex` + `char.customscript` + `getModuleRegexScripts()`
   - `$n`→newline, flag normalisation, the `@@emo` / `@@inject` / `@@move_top` / `@@move_bottom` directives,
     `pscript.actions` (`cbs`, `inject`, `move_top`, `no_end_nl`), script cache
6. `ParseMarkdown(...)`

And **the CSS on screen comes from the background layer, not from the message**:
`character.backgroundHTML` + the module `backgroundEmbedding` are concatenated, then `risuChatParser` → `ParseMarkdown(..., 'back')`
→ `BackgroundDom.svelte`. The `<style>` carried in there is what styles the markup the decorative regexes emit.
**Replicate only the regexes and leave this CSS out and you are left with unstyled markup.**

## Can the host do it for us — no

Full sweep of the v3 API: there is **no** API that runs the display pipeline for you.
`addRisuScriptHandler(mode, fn)` only *registers* a handler; it does not *invoke* the pipeline.
Nowhere in `risuai.d.ts` is anything of the `processScript`/`risuChatParser` kind exposed.

Reading works: `getCharacterFromIndex` gives an untrimmed `$state.snapshot`, so
`char.customscript`, `char.backgroundHTML` and `char.triggerscript` are all visible.
**Which means we have to do the execution ourselves.**

(There is also the approach of scraping the already-rendered DOM via `getRootDocument()`, but only the few drawn on the chat screen exist
and the SafeElement round-trip is slow, so it does not hold up for 394 turns.)

## Three risks — these are what decided it

1. **`@@inject` writes into the chat.** `scripts.ts:206` — `selchar.chats[selchar.chatPage].message[chatID].data = data`.
   That is a path where a read-only viewer **modifies the original** while trying to display it. The more faithfully you port it, the more dangerous it gets.
   Whatever the implementation, we do not execute `@@` directive scripts.
2. **Card regexes are regexes somebody else wrote, and the target is several MB.** JS regexes have no timeout.
   If catastrophic backtracking hits inside the plugin iframe, **the whole panel freezes.**
3. **Lua means bringing in a VM.** The CSP allows `'wasm-unsafe-eval'`, so wasmoon *in principle* runs
   (that was a surprising finding). But it is +400KB of bundle plus reimplementing the entire host function surface
   (`LUA_LLM_REFERENCE.md`), and on top of that there are several hundred CBS tags.

## Decision — 3 stages, only A for now

### A. Regexes + background CSS (to be implemented, low cost)

- From `char.customscript` + module regexes, apply only those with `type === 'editdisplay'`
- **Skip if `out` starts with `@@` or `actions` contains `inject`/`move_*`** (risk 1)
- **Run the regexes on the backend.** This is the real answer to risk 2 — the Python side can use a subprocess and
  a time budget, and when it hangs it is one request that dies, not the UI.
  It also matches the boundary contract ("policy lives in the backend").
- From `backgroundHTML` + the module `backgroundEmbedding`, extract **only the `<style>` blocks** and inject them scoped to the turn list.
  Scripts would not run anyway because they lack the CSP nonce, so keeping only the styles is a confirmation, not a filter.
- This stage revives most of the "31 decorative regexes" class. An `out` containing CBS remains as a literal.

### B. A subset of CBS (later)

Implement only the tags that actually appear in `out`/`in`. We do not port all of CBS.
After shipping A, **count which tags remain in real cards** and set the scope from that — not from guesswork.

### C. Lua triggers + full CBS (not doing it)

That means reimplementing the VM and the host API, and the result would drift every time RisuAI's version changes.
Cards that need this are left to the **raw 보기** (raw view) and to viewing them in RisuAI itself.

## What exists today (v0.1.0)

Stating the contract honestly, the current "렌더링 보기" (rendered view) is **noise removal, not a reproduction of RisuAI**:
chain-of-thought blocks removed, tags other than `img` removed, code blocks removed (optional), `**emphasis**` rendered.
Card regexes are not reflected yet. The raw view is the stored original exactly as it is.

The UI wording has to match this — "렌더링" (rendering) must not be misread as meaning the same screen RisuAI shows.
