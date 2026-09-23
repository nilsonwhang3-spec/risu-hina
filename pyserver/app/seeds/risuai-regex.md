> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

# RisuAI regex scripts: writing and debugging

Read this before you write or fix any regex script (the card's Regex tab, `customscript`). It covers choosing the type, ordering, flags, captures, CBS in OUT and IN, the standard recipes (sliding window, sentinel UI, newest-message panel, output repair, macros, theme tokens) and debugging.
When each type runs in a turn and what gets saved is in 'RisuAI 처리 순서 (정규식·Lua 훅)'. Status blocks are covered in 'RisuAI 상태창', image tags in 'RisuAI 에셋 출력식', CBS tags in 'RisuAI CBS 문법', and panels and buttons in 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

> **Names vary per bot.** The tags (`<bot-panel>`, `<img="…">`), the sentinel glyph (`☆`), the variables (`bot_*`) and the CSS classes below are placeholders. Before you write a rule, read the target bot's actual regex list, its tag grammar and its variable names, and keep its prefix.

Contents
1. The script entry (field semantics, verified against RisuAI source)
2. Choosing the type by purpose
3. Ordering
4. Captures, and CBS in OUT and IN
5. Recipes: windows, sentinels, anchored panels, chains
6. Recipes: output repair, normalization, macros, theming
7. Organizing the list
8. Debugging a rule that does not match
9. Pitfalls
10. Build/review checklist

---

## 1. The script entry

The replacement details below describe processScriptFull (editinput/output/process/display). edittrans has a separate implementation: it does not CBS-parse OUT, expand {{data}}, add trailing HTML newlines or execute @@ prefixes/inject/repeat_back. See the processing-order skill.

```json
{ "comment": "Status panel render", "type": "editdisplay",
  "in": "<bot-panel>([\\s\\S]*?)<\\/bot-panel>", "out": "<div class=\"bot-panel\">$1</div>",
  "flag": "g<move_top>", "ableFlag": true }
```
Decoded card folders often show the same entry as text:
```
=== Status panel render ===
type: editdisplay
in: <bot-panel>([\s\S]*?)<\/bot-panel>
out: <div class="bot-panel">$1</div>
flag: g<move_top>
```

| Field | Meaning |
|---|---|
| `comment` | Display name only. It is used for grouping and for search. |
| `type` | `editinput`, `editoutput`, `editprocess`, `editdisplay`, `edittrans`, or `disabled`. A script runs only in the stage whose name equals its type, so `disabled` (the editor's off switch) never runs. |
| `in` | JavaScript `new RegExp(in, flag)`. Lookbehind works. `\p{…}` needs the `u` flag. An **empty `in` is skipped**. |
| `out` | The replacement. `$1`…`$9`, `$&` and `$<name>` are capture references, and `{{data}}` means `$&`. **A literal `$n` becomes a newline**, so never write `$n` to mean "capture n". If `out` ends with `>`, a newline is appended (turn that off with `<no_end_nl>`). After the replacement the **whole text is CBS-parsed again** (without variable permission, so `{{setvar}}` stays literal; §2). |
| `flag` | It is used **only when `ableFlag` is true**. Otherwise the flag is `g`; an empty or missing flag also defaults to `g` even with ableFlag true. Characters outside `dgimsuvy` are removed, as are duplicates, and an empty result becomes `u`. For first-match-only behavior, set `ableFlag: true` and write `u` or `i` without `g`. |
| `ableFlag` | true means "use my `flag` string". false does **not** disable the script; it means "ignore `flag` and use `g`". |

**Meta commands in `flag`** use angle brackets. You can write several brackets or comma-separate them: `g<move_top><order -1>` or `g<move_top, order -1>`. **They are parsed only when `ableFlag` is true.** An entry with `flag: g<move_top>` and `ableFlag: false` silently runs as a plain `g` replace.

| Meta | Effect |
|---|---|
| `<order N>` | Sets the run order: a higher N runs first (§3). |
| `<cbs>` | CBS-parses `in` before compiling it (§4.3). |
| `<move_top>` / `<move_bottom>` | Cuts the match out and puts the rendered `out` at the top or bottom of the message. |
| `<inject>` | Same as `@@inject`. |
| `<repeat_back>` | Same as `@@repeat_back`. |
| `<no_end_nl>` | Stops the automatic newline after an `out` that ends with `>`. |

**`@@` prefixes in `out`** do the same jobs without `ableFlag`:
- `@@emo name` shows the character's emotion image `name` when the pattern matches. No text is replaced.
- `@@move_top <out>` / `@@move_bottom <out>`: `g` is stripped for these, so **only the first match** is moved, and later matches stay where they are. `$1` and `$&` are substituted (named `$<name>` does not resolve in this branch, per the source). **Host difference:** mainline does not CBS-parse the moved result in this branch; a later ordinary rule can parse it. PocketRisu explicitly CBS-parses the full text immediately after moving it. A panel relying on that extra pass can work in PocketRisu but leave raw CBS in mainline; add an ordinary parsing pass for portability.
- `@@inject` writes the current text (still containing the match) into the stored message and removes the match from this stage's output. It works only in stages that know the message index. It is rarely needed.
- `@@repeat_back end|start|end_nl|start_nl`: when this message has **no** match, the script copies the match from the previous message of the same role (or from the greeting) and appends or prepends it. It keeps a block visible when the model forgets it.

---

## 2. Choosing the type by purpose

| Goal | Type | Why |
|---|---|---|
| Render tags as HTML, hide markers on screen, show UI | `editdisplay` | It runs at every render. Nothing is saved and the request is untouched. |
| Control what the model sees (strip UI glyphs and HTML, trim old blocks, expand hidden macros) | `editprocess` | It builds the request copy of every message. Nothing is saved. |
| Fix the model's output before it is stored (tag repair, term normalization, deleting invalid tags, stripping reserved blocks) | `editoutput` | The result **is saved**, so a fix made here also cleans history and stops errors from compounding. |
| Rewrite what the user typed (visible slash commands, emphasis of trigger words, typo fixes) | `editinput` | The result **is saved** as the user message. |
| Adjust text after the built-in translator | `edittrans` | It runs on translated text only (for example, stripping parenthesized glosses). |

Rules of thumb:
- **Everything you render in `editdisplay` needs a matching `editprocess` decision**: either strip it, window it, or leave it on purpose (for example, the last status block, so the model can update it). HTML left in history costs tokens and teaches the model to write HTML.
- Prefer `editoutput` for **repair** and `editdisplay` for **presentation**. Repairing only in display leaves broken text in history, and the model imitates it.
- Do not put state-changing CBS (`{{setvar}}`, `{{addvar}}`) in `editdisplay` or `editprocess` OUT. Regex output is parsed without variable permission, so there the setter never runs and its literal text shows on screen (editdisplay) or reaches the model (editprocess). Only in `editinput`/`editoutput` is the literal tag saved into the message and executed when that message is finalized. See 'RisuAI 처리 순서 (정규식·Lua 훅)' for how often each stage runs.

---

## 3. Ordering

- The full list is preset regex, then the card's scripts, then module scripts. Within that list, scripts run **top to bottom**.
- If **any** script carries `<order N>`, the whole list is sorted by N, higher first. Scripts without it count as 0, and ties keep their list order. `<order -1>` pushes a script after all the unmarked ones.
- Each script sees the output of the previous one. Put rules in this sequence:
  1. **Erasers and window guards** (empty out stale blocks and sentinels);
  2. **specific before generic** (a variant with attributes before the plain tag; a mode-specific skin before the default skin; a named-character image rule before the catch-all image rule);
  3. **outer before inner** (the wrapper div, then the per-field rules that match inside it);
  4. **chains** in order (marker → intermediate text → HTML, §5.5);
  5. cleanup of leftovers last (a sentinel that was not consumed, stray literals).
- A generic rule placed before the specific one swallows its matches. A renderer placed before the window guard renders stale copies.

---

## 4. Captures, and CBS in OUT and IN

### 4.1 Captures
- Capture blocks lazily: use `([\s\S]*?)`. Greedy `[\s\S]*` merges every block on screen into one.
- For single-line fields, capture `([^<]*)`, `([^|\]]*)` or `([^\]]+)` so the capture cannot cross into the next field or tag.
- Named groups (`(?<date>…)`, `$<date>`) make long field lists readable.
- When the model may write variants, accept them: `(?:Time|Clock)\s*:\s*`, `\s*` around separators, and the `i` flag only if the target names are case-insensitive too (asset file names often are not).

### 4.2 CBS in OUT
After the replacement the text is CBS-parsed, so OUT can compute:
```
{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}$&{{/when}}  (window guard)
<img src="{{raw::$1_$2.webp}}">                                                    (asset URL from captures)
<div class="bot-gauge" style="width:calc($3/$4*100%)"></div>                        (gauge from captured numbers)
{{#when::bot_show_names::vis::1}}<span>$1</span>{{/when}}                           (option-gated display)
```
- **Capture-built CBS lets one rule cover every character.** `{{getvar::bot_$1_aff}}` reads a per-character variable named after the captured name. `{{raw::$1_$2.webp}}` builds the asset name. `{{button::+::bot_cheat_$1}}` builds a per-character button name. This needs a closed, predictable naming scheme.
- A capture that contains `::`, `{{` or `}}` breaks the CBS around it. Restrict such captures with a class such as `([A-Za-z0-9_ -]+)`.
- `{{#if}}` still works but is deprecated (it also strips the leading whitespace of every line it wraps). `{{#when::…}}` is preferred; see 'RisuAI CBS 문법'. Older recipes below that still show `{{#if X}}…{{/if}}` convert to `{{#when::X}}…{{/when}}`, except where noted. `{{? expr}}` takes a **space**, not `::`.
- Random in OUT re-rolls when the regex pass executes; cache hits reuse the result. Streaming editoutput can re-roll on successive chunks; the final result is saved. `pick` is seeded by chat and message count, not message index; cached OUT can retain an earlier pick.
- Asset tags in OUT (`{{raw::…}}`, `{{img::…}}`) are resolved after the regex pass, case-insensitively and with a closest-name fallback (edit distance ≤ 4 by default), so a wrong name can show a similar asset instead of nothing. Check existence with `{{assetlist}}` when that matters ('RisuAI 에셋 출력식').
- **Regex result cache**: the key contains text, scripts and message index, but not chat variables or message count. This applies to editinput/editoutput/editprocess too. OUT reading getvar or lastmessageid can stay stale. reloadDisplay clears the cache in both hosts; reloadChat and clicked-message refresh do not. For targeted refresh, change pre-regex text in Lua editDisplay, or use literal `<cbs>` with an IN whose parsed text includes the dependency.

For an OUT-only sliding window, keep matching old blocks so OUT can remove them. Include the message-count dependency in a never-matching alternative, without adding captures:
```
in:   (?:<bot-panel>[\s\S]*?<\/bot-panel>)|(?!){{lastmessageid}}
out:  {{#when::{{chat_index}}::>=::{{? {{lastmessageid}}-2}}}}$&{{/when}}
flag: g<cbs>
ableFlag: true
```
The first branch still matches every block; the second never matches but changes the cache key. Replacing the entire old-message IN with (?!) would leave the raw block untouched, so use that approach only with a separate cleanup rule.

### 4.3 CBS in IN (`<cbs>`)
With `ableFlag: true` and `<cbs>` in the flag, `in` is CBS-parsed before it is compiled. The pattern itself can then depend on variables or on the message position:
```
in:   {{#when::bot_status_mode::vis::aux}}<bot-panel>[\s\S]*?<\/bot-panel>{{:else}}(?!){{/when}}
flag: g<cbs>
```
When false, return `(?!)` (never matches). **Do not return an empty pattern:** only original IN is checked for emptiness, before CBS expansion. An empty expanded pattern matches empty positions and inserts OUT at every position with `g`. §5.2 uses the same mechanism to anchor a panel. Escape regex metacharacters that come out of CBS (a variable value containing `(` or `|` changes the pattern).

---

## 5. Recipes: windows, sentinels, anchored panels, chains

### 5.1 The sliding-window guard (three planes)
```
out: {{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-N}}}}}}$&{{/when}}
```
(Older bots: `{{#if {{greater_equal::…}}}}$&{{/if}}`, same result except that `#if` strips each line's indentation.)
`chat_index` is the index of the message being processed, and `lastmessageid` is the index of the last message. The block survives only in the last N+1 messages. The same guard serves three purposes:

| Plane | Type | Purpose | Typical N (options, not a standard) |
|---|---|---|---|
| Display | `editdisplay`, before the renderer | Old UI disappears, and rendering and scrolling stay light | 2-6 for status and HUD; 4-6 for images; 0-1 for a fixed-position panel |
| Prompt | `editprocess` | Saves tokens while keeping recent examples of the format, so the model keeps producing it | 2-5 for status, affinity tags and image tags; 3-4 for OOC comments |
| Sentinels | both | Only one copy of a fixed-position panel exists, and the glyph never reaches the model | 0-1 |

- For the newest message only, use `{{equal::{{chat_index}}::{{lastmessageid}}}}`. OUT-only guards need message-count cache invalidation, or old display/request results can survive a new message.
- **Partial blanking** keeps the chronology and drops the bulk. Capture the fields that give continuity and window only the rest:
  ```
  in:  (\[Date: [^|]*\| Time: [^|]*\| Location: [^|]*)([^\]]*)(\])
  out: $1{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-5}}}}}}$2{{/when}}$3
  ```
- **Tiered display**: full UI when `chat_index == lastmessageid`, a reduced card for the last few messages, nothing older. Write two ordered rules, or `{{#when}}…{{:else}}…{{/when}}` branches inside one OUT.
- Changing a prompt-side window changes old messages' request text, which breaks provider prompt caching from that point. Prefer windows that move by whole turns, and do not window data that Lua `editRequest` must read (editprocess runs first).
- Background HTML also passes through editdisplay with index -1, just like the greeting. A window can include it in a short chat (`-1 >= lastmessageid-N`); newest-only equality is true in a greeting-only chat. An index guard cannot distinguish the two: use a message-specific marker and separate background-theme rules.

### 5.2 A panel anchored to the newest message (greeting sentinel fallback)
The goal is a floating app, HUD or settings button that always sits under the newest message, and already exists when only the greeting is present.
```
=== Floating panel ===
type: editdisplay
in:   {{#when::{{chat_index}}::is::{{lastmessageid}}}}{{#when::{{lastmessageid}}::is::-1}}☆{{:else}}${{/when}}{{:else}}(?!){{/when}}
out:  {{#when::{{chat_index}}::is::{{lastmessageid}}}}<div class="bot-float">…</div>{{/when}}
flag: gu<cbs>
```
- With stored messages, IN becomes `$` only for the newest message and `(?!)` for older messages. This condition in IN with literal `<cbs>` also changes the cache key when a message stops being newest. When only the greeting exists (`lastmessageid` = -1), IN becomes the sentinel, which the greeting carries on its first or last line.
- Add a cleanup rule that erases the sentinel wherever it was not consumed (`in: ☆`, `out:` empty, `editdisplay`), and an `editprocess` rule that removes it from the request.
- When the panel HTML is large, build it in Lua and inject it into the newest message only. That is cheaper than a regex, which re-parses CBS for every message. See 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

### 5.3 Sentinel glyph → UI, stripped from the prompt
A sentinel is a short string the model will never write by accident (a glyph pair of your choice, or `###BOT_PANEL###`). Put it in the greeting, or add it with Lua (`addChat(id, "char", "☆")`) to open a panel on demand. Three rules go with it:
```
=== ☆ window ===   editdisplay  in: ☆        out: {{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-1}}}}}}$&{{/when}}
=== ☆ render ===   editdisplay  in: ☆        out: <div class="bot-start">…buttons…</div>
=== ☆ strip ===    editprocess  in: ☆        out: (empty)
```
- **Sentinels inside reasoning.** If the model mentions the glyph inside a thinking block, the UI renders inside the reasoning. Strip it in `editoutput` with a lookahead that only matches before a closing reasoning tag:
  ```
  in:  ☆(?=[\s\S]*?<\/(?:thinking|think)>)
  out: (empty)
  ```
  Use the reasoning tag names that the target preset and model actually produce.

### 5.4 Status and HUD rendering
One capture-group rule turns a delimited line into a card. Details (fields, gauges, move-to-top, several skins, partial blanking, fallback box) are in 'RisuAI 상태창'. Two regex-level points belong here:
- **Several ordered rules on the same format** can key on one field (a mode or location keyword) to pick a skin. The first matching rule consumes the text, so the generic rule last never double-renders.
- **A visible fallback**: a final rule that matches a malformed block (`<bot-panel>[\s\S]*?<\/bot-panel>` left unrendered) and shows a small warning box is better than raw tags on screen.

### 5.5 Regex chains
The output of one script is the input of the next. A marker becomes intermediate text, and the text becomes HTML:
```
=== start menu (1) ===  editdisplay  in: ☆   out: 《Choose a start|{{button::Opening A::bot_start_1}}|{{button::Opening B::bot_start_2}}》
=== start menu (2) ===  editdisplay  in: 《([^|》]*)\|([^|》]*)\|([^|》]*)》   out: <div class="bot-menu"><b>$1</b><div>$2</div><div>$3</div></div>
```
The intermediate format keeps a list on one line of text and lets one renderer serve several markers. Order matters (§3).

---

## 6. Recipes: output repair, normalization, macros, theming

### 6.1 Output repair (`editoutput`)
Common model slips are fixed before storage, so they do not compound in history:
```
`(<img[^>]*>)`                     → $1                       (backticks around tags)
<img src="([^"]+)">                → <img="$1">               (wrong tag form; use the bot's canonical form)
[“”]                               → "                        (curly quotes; scope it to tags if prose uses curly quotes)
\s+"> or "\s+>                     → ">                       (stray spaces)
(?<=HP:\s*[^|]*?\d),(?=\d)         → (empty)                  (thousands separators inside numeric fields)
^#+\s*Status.*$                    → (empty)  flag gm         (a stray heading; gm needs ableFlag true)
\]\[(?=[a-z_]+:)                   → ]$n[                     (merged tags split apart; $n = newline)
```
- **Stripping reserved blocks.** When Lua or an aux model owns a block (status, quest results, system notices), remove any copy the main model invents: `<bot-quest-result>[\s\S]*?<\/bot-quest-result>` → empty. Gate the rule with `<cbs>` (§4.3) when ownership depends on a mode variable.
- **The existence check** keeps an image tag only if the asset exists. It works in `editoutput`, where a hallucinated tag is deleted from the saved text, or in `editdisplay`, where it shows a fallback box instead:
  ```
  out: {{settempvar::ok::}}{{#each {{assetlist}} as a}}{{#if {{equal::{{lower::{{slot::a}}}}::{{lower::$1_$2}}}}}}{{settempvar::ok::1}}{{/if}}{{/each}}{{#if {{gettempvar::ok}}}}$&{{/if}}
  ```
  Keep the legacy `{{#if}}` inside the loop here: a false `#if` skips its body, while a false `#when` still parses it, so `{{settempvar::ok::1}}` inside a `#when` would run for every asset and always pass. A shorter exact check without the flag: `{{#when::{{contains::{{assetlist}}::"$1_$2"}}}}$&{{/when}}` (case-sensitive). `#each` needs the `as` keyword. Check whether the bot's asset names carry extensions and compare accordingly (`{{startswith::…}}` accepts a name plus any extension). Use `{{module_assetlist::namespace}}` for assets that ship in a module. A whitelist alternation (`<img="(?:Name1|Name2) (?:happy|sad|…)">`) also works, but it must be kept in sync by hand. The full recipe is in 'RisuAI 에셋 출력식'.
- **Prompt-side hygiene** (`editprocess`): keep only valid, recent image tags in the request, so the model does not copy broken ones from history.

### 6.2 Term normalization and anti-repetition (`editoutput`)
- Canon terms: `(?:variant A|variant B|variant C)` → `canon term`. Fix romanization drift of names in the same way. Keep a parallel rule per output language if the bot is multilingual.
- Period or setting accuracy: `(?:anachronism A|anachronism B)` → a setting-appropriate term.
- **Anti-repetition with `{{random}}`**: rewriting an overused choice as `{{random::a::b::c}}` spreads the variety. For example `_happy` → `{{random::_smile::_happy::_laughing}}` inside image tags, as long as every result exists as an asset. The final editoutput result is saved, but the choice can change during streaming.
- Normalize a system-message style: `\*\*?-?\s*(?:System|Notice)\s*:\s*(.+?)\*?\*?$` → `- System: $1` (flag `gm`), then render one canonical form in display.

### 6.3 Slash-command macros
The user types a short command, and a regex expands it into a long OOC instruction.

| Where | What the user sees in the log | What the model gets | Use for |
|---|---|---|---|
| `editprocess` | the short command | the expansion | opening-writer or world-generator prompts where the stored chat should stay clean |
| `editinput` | the expansion (saved) | the expansion | summary requests or anything the user should see and edit |

```
=== /opening ===  editprocess
in:  ^\/opening\s+([\s\S]*)$
out: (OOC: Pause the roleplay. Write a novel-like opening scene based on this premise: "$1". At least three lines of dialogue, no actions for {{user}}, end with the status block.)
flag: g   (with ableFlag true add m if the command can sit on any line)
```
- Pair every `editprocess` macro with an `editdisplay` rule that shows a short notice instead of the raw command, if the raw command would look odd.
- Emphasis macros (`editinput`): wrap the user's trigger word in `*…*` so a keyword lorebook entry and the model both react to it.
- A command handled by Lua is the alternative for commands that change variables: `onStart` detects `/cmd …` in the last user message, applies it, removes that message and returns `false` (only `onStart` can cancel a send; `stopChat` or a `""` return in editInput does not). Names of RisuAI's own slash commands (`/send`, `/setvar`, `/trigger` …) are consumed before any script sees them. See 'RisuAI Lua 트리거' §14.

### 6.4 Theme tokens in the background HTML
The background HTML is CBS-parsed and then passes through the same `editdisplay` scripts (with `chat_index` = -1). Placeholders in the CSS can therefore be replaced by tiny regexes. Users retheme from the regex list without touching the CSS:
```
backgroundHTML:  .bot-card { border: 2px solid {bot_border}; max-width: {bot_width}; font-size: <<bot_font>>px; }
=== theme: border ===  editdisplay  in: \{bot_border\}   out: rgba(140,130,190,0.4)
=== theme: width ===   editdisplay  in: \{bot_width\}    out: 480px
=== theme: font ===    editdisplay  in: <<bot_font>>      out: 15
```
- Escape braces in `in`. Pick tokens that cannot occur in chat text.
- Do not window these rules: that makes background styling depend on chat length.
- The alternative is CBS directly in the CSS (`{{#when::bot_fold::vis::1}}…{{/when}}`, `{{screen_width}}`), which lets options switch CSS blocks.
- Conversely, **every `editdisplay` rule also sees the background HTML**. A broad pattern (`\[(.*?)\]`, `\{([^}]*)\}`) can mangle the CSS. Anchor patterns on the bot's own tag grammar.

---

## 7. Organizing the list

- **Separators**: add disabled dummy scripts named `---- Status ----`, `---- Images ----` and so on (type `disabled`, `in` empty). They cost nothing and make a long list navigable. Name real scripts by purpose and plane, for example "status: render", "status: request window", "status: output fix".
- **Profiles shipped disabled**: offer alternatives, such as a high-spec and a low-spec image renderer, or an optional lag-mitigation window, as scripts of type `disabled`. Tell users in the creator notes to switch by enabling one of them. This needs no option UI.
- **Legacy formats**: when the tag format changes, keep one conversion rule (`editprocess` and/or `editoutput`, old → new). Otherwise delete rules that target the old format; they silently match nothing.
- Keep one bot prefix for tags, classes and variables so that rules from different bots or modules cannot collide.

---

## 8. Debugging a rule that does not match

Work through this list in order:
1. **Wrong type or stage.** Is it `editdisplay` but you are checking the request, or `editprocess` but you are looking at the screen? See 'RisuAI 처리 순서 (정규식·Lua 훅)'.
2. **Old-format pattern.** The model's current output differs from what the rule expects (a renamed field, a changed bracket style, a field added later). Copy a real current message and test against it.
3. **Quoted vs unquoted.** `<img src="x">` vs `<img src=x>` vs `<img src='x'>`. Match all three with `<img src=["']?([^"'>]+)["']?>`, or repair them to one form in `editoutput`.
4. **Curly quotes and full-width punctuation** (`“ ” ‘ ’ ｜ ：`) in the model's output or in your own examples. Normalize them in `editoutput`.
5. **Greedy vs lazy.** `.*` or `[\s\S]*` swallows several blocks, and the first block's start pairs with the last block's end.
6. **Multiline.** `.` does not cross newlines (use `[\s\S]` or the `s` flag). `^` and `$` need `m` to match per line, and `m` needs `ableFlag: true`.
7. **Case.** Field names written `time:` vs `Time:`. Use the `i` flag or `(?:[Tt]ime)`, but keep asset names case-exact.
8. **ableFlag off.** `flag` and `<…>` metas are ignored when `ableFlag` is false.
9. **Swallowed by an earlier rule.** A generic rule placed above consumed the text, or an eraser emptied it (§3).
10. **Escaping.** `|`, `[`, `]`, `(`, `)`, `?`, `*`, `+`, `.`, `{`, `}` and `/` in literal text. In the JSON form, backslashes are doubled.
11. **CBS in the text resolved first.** The message is CBS-parsed before any regex runs, so a rule cannot match `{{…}}` written in the message; it sees the result.
12. **The cache.** The OUT reads a variable that changed, but the text did not (§4.2).

---

## 9. Pitfalls

1. `ableFlag: false` looks like "disabled" but means "flag = g". Custom `<order>`, `<move_top>` and `<cbs>` metas are then ignored.
2. `$n` in OUT is a newline, not a capture.
3. An OUT ending with `>` gets an extra newline, which can break a markdown table or an inline element. Use `<no_end_nl>`.
4. `move_top` and `move_bottom` move only the first match.
5. Split wrapping, where one rule opens a `<div>` and a later rule or closing marker closes it, breaks the whole message when one tag is missing. Write self-contained rules.
6. One rule for a whole multi-field block fails whenever a field is missing or reordered, and raw tags show. Either enforce the order in the instruction or use per-field rules plus a fallback box.
7. Rendering without an `editprocess` counterpart leaves HTML or glyphs in the prompt. The model then copies them.
8. Background and greeting share index -1; an index window is not a reliable background filter.
9. `{{random}}` in editdisplay can change on cache misses; `{{setvar}}` in `editdisplay` never runs and prints as literal text. Stat math done in `editoutput` CBS is re-applied on reroll and is not reroll-safe. Do accumulation in Lua with snapshots ('RisuAI Lua 트리거').
10. The display cache ignores variables.
11. A broad `editdisplay` pattern also edits the background CSS.
12. Checkbox ids repeated across several rendered messages make `<label for>` toggle the wrong one. Put the message index into the id (`bot-fold-{{chat_index}}`), or use `<details>`.
13. A gate variable spelled differently in two places (`bot_lang` vs `botLang`) fails silently. Grep the card for every variable a rule reads.
14. Asset tags resolve names case-insensitively (with a closest-name fallback), but `{{assetlist}}` existence checks are case-sensitive. A case-insensitive capture can pass the render and fail the check; compare with `{{lower::…}}` on both sides or keep names case-exact.

---

## 10. Build/review checklist

- [ ] Every custom tag the model emits has a display rule, a prompt decision (strip, window or keep) and, if it is often malformed, an output repair rule.
- [ ] Every sentinel has a render rule, a cleanup rule for unconsumed copies, an `editprocess` strip and, if the model can mention it, a reasoning-block strip.
- [ ] Erasers and window guards run before renderers; specific rules run before generic ones; chains run in sequence.
- [ ] Captures are lazy and field-bounded, and names built from captures cannot contain `::` or braces.
- [ ] Every script that uses `flag` metas has `ableFlag: true`.
- [ ] Prompt windows keep enough recent examples for the model to continue the format.
- [ ] No `editdisplay` pattern can match the background CSS by accident, and theme-token rules are not windowed.
- [ ] Tested against a real current message: missing field, extra spaces, curly quotes, two blocks in one message, a block inside a reasoning section, and the greeting-only state.
- [ ] Separators and disabled profiles are named, and legacy-format rules are removed or converted.
