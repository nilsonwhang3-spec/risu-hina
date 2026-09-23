<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

Reference for a RisuAI bot's **status panel**. The model ends each reply with a tagged block (TAG OUTPUT), regexes turn it into HTML, backgroundHTML CSS styles it, and `{{position::PI}}` + `@@position pt_PI` keep the output instruction from being ignored. Read this when you design, build or fix that system.
Related skills: 'RisuAI 정규식 작성법' (regex mechanics and recipes), 'RisuAI 처리 순서 (정규식·Lua 훅)' (hook timing), 'RisuAI 로어북 구조' (decorators in general), 'RisuAI Lua 트리거' (Lua API and reroll-safe state), 'RisuAI 에셋 출력식' (image tags).

> **Tag names and fields differ per bot.** `<bot-panel>`, `<bot-scene>`, the `.bot-` classes, `bot_*` variables and fields such as time, place, cast and money are placeholders. Read the target bot's real tags, fields and variables first; for a new bot, choose one prefix and use it consistently in the instruction, the regexes and the CSS.

Contents
0. Structure
1. Designing the block: format and fields
2. The instruction (TAG OUTPUT)
3. Placement: `{{position::PI}}` + `@@position pt_PI`
4. Regex pipeline
5. Producers, Lua and derived state
6. CSS
7. Applying it to a new bot
8. Pitfalls
9. Build/review checklist

---

## 0. Structure

```
[lorebook entry, constant]  "End every reply with <tag block>"  ── @@position pt_PI ──▶ end of the prompt (global-note slot)
[model output]              narrative + <tag block>
[regex editdisplay]         eraser (hides old turns) → wrapper → container → per-field conversion
[regex editprocess]         removes old turns' blocks from the request; keeps the last few so the model reads and updates them
[backgroundHTML]            .prefix-* classes inside <style>
[Lua (optional)]            parses tags in editOutput/onOutput → variables and snapshots; CoT defense and anchors in editDisplay
```

Regex alone completes a status panel. Add Lua only to parse values and feed them back next turn, to correct values the model wrote, to produce the block with a second model, or to store state safely across rerolls (§5).

---

## 1. Designing the block: format and fields

### 1.1 One line or a block
| Format | Example | Strengths | Weaknesses |
|---|---|---|---|
| **One delimited line** (most common) | `[Date: … \| Time: … \| Place: … \| Thought: …]`, `<bot-line>date \| time \| place</bot-line>`, or one bracket per field `[date][time][place]` | Cheap, and one capture regex renders it; the model rarely breaks a line | Values cannot contain the delimiter; a missing field breaks a whole-line regex |
| **Nested tags** (block) | `<bot-panel><bot-scene>…</bot-scene>…</bot-panel>` | Per-field regexes tolerate order changes and missing fields; values may be long | More tokens; needs strict "each on its own line" rules |
| **JSON object** | `<bot-status>{"date":"…","note":"…"}</bot-status>` | Easy for Lua to parse; a strict schema | A regex must assume key order; quotes and newlines in values break it ("no literal line breaks, all values strings") |
| **Two lines** | the status line plus a separate delta or attire line | Keeps changing data (affinity deltas) apart from the always-present status | Two formats to render and to strip |

For solo bots, date, time, place and an inner-voice field are usually enough. Simulation bots add cast, money, goals and RPG stats.

### 1.2 Field menu
- **Date, time, place, weather**: the backbone of continuity. Give a fixed grammar (`YYYY-MM-DD (Day)`, a closed set of day parts or `AM/PM HH:MM`, an icon plus °C) and continuity rules: keep the place unless the scene moves; advance the date only past midnight; a minimum time step per turn ("never freeze time"); weather follows the season.
- **Inner thought, memo or diary**: one sentence in the character's voice, which shows the gap between mask and self every turn. See §2.5 for the inner-voice channel.
- **Outfit or attire**: the field that **drives the next image**. The asset tag's outfit axis reads it, and the character sheet defines when each outfit is worn. A closed set (`uniform|casual|sleepwear|…`) that matches the asset names is required. See 'RisuAI 에셋 출력식'.
- **Mode or identity label**: a cheap state machine that lives in the output ("current mode: X") and can pick the panel's skin (§4.6).
- **Situation keyword**: a hidden field from a closed list (rest, study, date, combat…) that Lua maps to achievements or events.
- **RPG fields**: level, EXP cur/req, HP/MP cur/max, stats, class, equipment, items, skills, quests, currency. Give formulas (a maximum derived from a stat, EXP needed derived from level) but let Lua recompute them (§5.1). Put secondary fields in a fold.
- **Cast present, money, goals, task list**: simulation-bot fields that each need an update rule ("read the previous value, apply this turn's changes").

---

## 2. The instruction (TAG OUTPUT)

### 2.1 Skeleton
One lorebook entry with `constant: true` and an insertion_order above the other rules in the same slot:
```
@@position pt_PI
### OUTPUT FORMAT
Every response MUST end with the status panel. Never skip. Never omit any field.
Tag names stay exactly as written; only values follow the output language.

<bot-panel>
<bot-scene>{YYYY-MM-DD} {weekday} {day part} | {location}</bot-scene>
<bot-present>{characters in the scene}</bot-present>
<bot-money>{amount}</bot-money>
<bot-goal>{current objective}</bot-goal>
<bot-list>
[item | current state | NEW or ONGOING or HOLD]
</bot-list>
</bot-panel>

== RULES ==
- ALL fields are MANDATORY, each on its own line. If unknown, use "-" as the value.
- <bot-scene>: weekday = Mon..Sun. Day part = dawn | morning | afternoon | evening | night. Time advances realistically.
  The date MUST advance when the scene moves to the next day.
- <bot-money>: read the previous panel's value and apply this turn's transactions. Digits only, no thousands separators.
- <bot-list>: exactly ONE `|` between fields. The last field is exactly one of NEW ONGOING HOLD. Max 8 entries. Remove finished items silently.
- The panel is a meta-UI element, invisible to in-world characters. Characters never mention its values.

== OUTPUT ORDER ==
(narrative)

<bot-panel> … </bot-panel>

== EXAMPLES ==
(1-4 correct examples for different situations)
```

### 2.2 Components and why
- **Say "mandatory" several times**: "MUST end with", "Never skip / Never omit", MANDATORY per field. With only one such line, the block gets dropped after a few turns.
- **An empty-value rule**: a placeholder value such as `-`, `None` or `NA`. Without it, the model drops unknown fields entirely. If the bot initializes on the first reply, put `?` in the greeting's panel with the rule "set it on the first reply, concrete values afterwards".
- **Closed vocabularies**: weekdays, day parts, progress states. Regex captures and CSS classes (`bot-item-$3`) then line up.
- **An update rule**: "read the previous panel and update it". That is why the request keeps the latest panel (§4.3).
- **OUTPUT ORDER and correct examples.** Also put a **filled status line in the greeting**: it teaches the format from turn one and sets the starting time and place. Every alternate greeting needs its own.
- **Section headers as `== SECTION ==`.** Angle-bracket headers such as `<SECTION>` inside the instruction get imitated. Use angle brackets only for the tags to output.
- **Wrong examples**: keep them short or skip them, because the model sometimes copies the wrong format. If you use them, put one or two after the correct examples.
- **A hiding rule**: the panel is meta UI, so characters never say its numbers aloud. Diegetic panels (§6.5) are the exception; the fiction then defines who can see them.
- **Never translate tag names.** Only values follow the output language, so a language switch does not break the regexes. State it: "labels in English, values in the scenario language".
- **The number rule**: "numbers without thousands separators" whenever a regex uses `\d+` or `calc()` (§4.5).
- **"Single line, no paragraphs"** for one-line formats. If a field needs a break, use `<br>` inside the value.

### 2.3 Common extensions
- **Mode branches**: inside one entry, `{{#when::bot_mode::visnot::X}}…{{/when}}` swaps the format per mode. When another producer owns the panel (§5.2), `{{#when::bot_status_producer::vis::aux}}Do not output the status panel.{{/when}}` switches on the opposite instruction.
- **Separate screen anchors from data tags.** When Lua fills an empty anchor (`<bot-anchor name="X"></bot-anchor>`) and parses a data tag (`[Data: …]`), mark as CRITICAL: "leave anchors empty; data goes on a separate line outside the panel". If the model writes data into the anchor, parsing breaks.
- **System-only blocks**: an internal memo the user should not see goes in its own tag (`<bot-secret>`) that Lua editOutput deletes before saving, or that display hides.
- **Conditional tags**: values that appear only when they change (affinity deltas) go **outside** the panel in their own tag line, as signed deltas or phrases (§5.5). State "only characters affected in this scene; never list everyone". Lua keeps the absolute value and returns it to the prompt with `{{getvar::…}}`.

### 2.4 Anti-repetition rules for status fields
Free-text fields (memo, diary, thought) loop quickly. Write the rule into the spec:
- "Memo must never repeat the previous response's memo verbatim." "Never repeat the same sentiment two entries in a row."
- "At least one of fields A/B/C must change every turn."
- "Memo references concrete upcoming tasks; it never overlaps with the diary."
- Give each field a distinct job, so two fields do not say the same thing.

### 2.5 The inner-voice channel
A thought, diary, memo or even a list of file names lets the character's private reaction show every turn without breaking the prose. Define its voice ("deadpan observation with emotional weight underneath", "a short, ugly burst of feeling") and its fallback ("if the character is absent, `none`"). Solo bots in particular gain charm here. Some bots render it large, others keep it tiny or behind a click.

### 2.6 Tag grammar choice
| Grammar | Example | Value constraint | Regex |
|---|---|---|---|
| Nested XML | `<bot-panel><bot-scene>…</bot-scene></bot-panel>` | no `<` in values | independent per-field rules; tolerant of order and gaps |
| XML + pipes | `<bot-stats>HP: 45/50 \| MP: 10/10</bot-stats>` | no `\|` in values | one rule, several fields; fixed order |
| `[Key: value]` lines | `[Date: 2004-04-09 (Fri, afternoon)]` | no `]` in values | `[^\]]+` captures |
| Pipe rows + closing marker | `[Row\|…]` … `[/Rows]` | no `\|[]`; the marker is required | a marker opens and closes the div (fragile) |

Nested XML with per-field rules is the most robust. With pipe or bracket grammars, put "no `|`, `[`, `]` inside values; exactly one delimiter" at the top of the instruction.

---

## 3. Placement: `{{position::PI}}` + `@@position pt_PI`

**How it works**
1. The card's `post_history_instructions` (global note override) goes into the preset's global-note slot. In most presets that slot is after the chat history, near the last user message.
2. Writing `{{position::PI}}` in that text defines a position slot named `PI` at that point. The bot chooses the name.
3. An entry whose body starts with `@@position pt_PI` (`pt_` + slot name) on its **first line** leaves the normal lorebook placement and goes to that slot. Valid `@@position` arguments are only `after_desc | before_desc | personality | scenario | pt_name`.
4. Result: the status instruction sits at the very end of the prompt, where it is hard to ignore. Because it is still a lorebook entry, `{{#when}}` gates, insertion_order and constant all work. Unlike writing the whole instruction into the global note, it can be split into several entries and switched with variables.
5. Order inside the slot follows insertion_order. Layers such as rules < status format < mode-specific instructions are easy to manage.

**Global note override example**
```
{{#when::bot_image_producer::visnot::aux}}
### Image Commands
…
{{/when}}
{{position::PI}}
```
With `{{position::PI}}` after the image block, the order is image instructions → lorebook rules (status). Before it, the order is reversed. Decide by what the last paragraph closest to the model should be. To make the status format last, put the slot after.

**Difference from `@@depth 0`**: `@@depth 0` goes into postEverything after prompt-template assembly, rather than directly after the last history message. `pt_PI` follows wherever the preset puts the global note. With presets that put the global note after the history, the two are almost the same place. Use `@@depth 0` to be at the end regardless of the preset, and `pt_PI` to respect the preset's structure. Some bots let a variable choose between the two placements.

**Redundant placement**: repeating the key field rules once more (a `@@depth 0` or `@@role system` entry, or a one-line mention in the description) reduces omissions.

---

## 4. Regex pipeline

Regex mechanics (flags, `ableFlag`, ordering, CBS in OUT) are in 'RisuAI 정규식 작성법'. This section covers the status-specific pieces.

### 4.1 The eraser expression
```
{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}$&{{/when}}
```
- `{{chat_index}}` is the index of the message being processed; `{{lastmessageid}}` is the last message's index. `{{? expr}}` takes a **space**, not `::`.
- Meaning: the block survives only in the last 3 messages; older ones become empty. Adjust with `-2`.
  - In editdisplay, old panels disappear from the screen.
  - In editprocess, old panels leave the request, while the latest 1-2 turns stay so the model can read and update them.
- To keep only the last one, use `{{equal::{{chat_index}}::{{lastmessageid}}}}`. OUT guards need message-count cache invalidation: add `|(?!){{lastmessageid}}` to a grouped original IN with literal `<cbs>`, preserving the old-block match so OUT can erase it (regex skill §4.2), or include getChatLength(id) in a Lua editDisplay cache-buster.
- Older bots write `{{#if {{greater_equal::…}}}}$&{{/if}}`; it still works but is deprecated and strips each line's indentation. Do not put an expression into the first argument of `vis`.

### 4.2 Order: eraser → wrapper → container → fields → sub-items
```
=== panel eraser ===        editdisplay  in: <bot-panel>([\s\S]*?)<\/bot-panel>   out: (eraser expression around $&)
=== panel wrapper ===       editdisplay  in: same                                  out: <div class="bot-panel">$1</div>
=== scene field ===         editdisplay  in: <bot-scene>([\s\S]*?)<\/bot-scene>   out: <div class="bot-row"><span class="bot-label">🕐 Scene</span><span class="bot-val">$1</span></div>
=== money field ===         editdisplay  in: <bot-money>([\s\S]*?)<\/bot-money>   out: <div class="bot-row"><span class="bot-label">💰 Money</span><span class="bot-val bot-money">$1</span></div>
=== list block ===          editdisplay  in: <bot-list>([\s\S]*?)<\/bot-list>     out: <details class="bot-fold"><summary class="bot-fold-sum">📌 List</summary><div class="bot-fold-body">$1</div></details>
=== list item ===           editdisplay  in: \[([^|\]]+)\|\s*([^|\]]+)\|\s*([A-Z]+)\]   out: <div class="bot-item bot-item-$3"><b>$1</b> $2 <span class="bot-badge">$3</span></div>
=== panel request window === editprocess in: <bot-panel>([\s\S]*?)<\/bot-panel>   out: (eraser expression around $&)
ableFlag: false (all; default g)
```
- Scripts apply top to bottom. The eraser runs first so later conversions do not waste work on old turns. Convert the outer tag to a div first; the next scripts catch the inner tags.
- Always capture blocks lazily with `[\s\S]*?`. Greedy capture merges several turns' panels on screen. Capture one-line tags with `[^<]*` so they cannot swallow other tags.
- Put a special form with attributes (`<bot-sys by="…">`) **before** the general form (`<bot-sys>`), which would otherwise swallow it.
- Passing a state value as a class (`bot-item-$3`) or `data-st="$3"` lets CSS alone choose colors.
- **Avoid split wrapping.** When one rule opens a div and another (the next field or a closing marker) closes it, a missing tag leaves the HTML unclosed and the rest of the message ends up inside the panel. Write self-contained rules per field.
- **One regex for the whole block** fails whenever the field order differs or a field is missing, and the raw tags stay visible. If you do it (common for one-line formats), enforce the order in OUTPUT ORDER and add a fallback box (§4.7).

### 4.3 When NOT to strip in editprocess
editprocess runs **before** Lua `editRequest`. If Lua must read panels in history (for example, to group messages by date for summaries), do not remove them with editprocess; do display cleanup only in editdisplay. Many bots also deliberately keep the latest status in the request so the model sees the previous date and time.

**Partial blanking** is the middle way: keep the continuity fields of every old panel and blank the rest:
```
in:  (\[Date: [^|]*\| Time: [^|]*\| Location: [^|]*)([^\]]*)(\])
out: $1{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-5}}}}}}$2{{/when}}$3
```
The chronology stays readable while inventory and stat bulk leave the request.

### 4.4 Lua watchdog
RisuAI swallows Lua editOutput errors silently and saves the original text. If Lua manages state, append a marker tag (`<bot-uid>N</bot-uid>`) when editOutput succeeds, and warn when the last message lacks it:
```
=== backend watchdog ===   editdisplay
in:  </bot-panel>(?![\s\S]*<bot-uid>)
out: </bot-panel>{{#when::{{chat_index}}::>=::1}}{{#when::{{chat_index}}::is::{{lastmessageid}}}}<div class="bot-dead-warn">⚠ System script not running: this turn's state changes were not recorded. Restart RisuAI and it will recover next turn.</div>{{/when}}{{/when}}
```
Hide the marker with a separate rule. On the next turn, backfill the values of turns without a marker. This catches **Lua failure**, not **the model omitting the block**; for that, rely on the instruction (§2) and placement (§3).

### 4.5 Gauges and numbers
- From captured numbers: `<div class="bot-bar"><div class="bot-fill" style="width:calc($6/$7*100%)"></div></div>`. It works for EXP, HP and MP with no Lua.
- From variables: `style="width:{{calc::{{getvar::bot_exp}}/{{getvar::bot_exp_next}}*100}}%"`.
- A CSS custom property and `counter-reset` can also print the value: `style="--val:{{getvar::bot_stat}}"`.
- **No-comma rule**: `1,000` breaks `\d+` captures and `calc()`. State "digits only, no thousands separators" in the instruction, and add an editoutput fixer, for example `(?<=(?:EXP|HP|MP)\s*:[^|]*?\d),(?=\d)` → empty. Also strip parenthetical notes after numbers.
- Clamp values that can exceed the maximum in Lua or CBS, so a bar never runs past 100%.

### 4.6 Display tricks
- **Move to top while written last**: the model writes the status at the end (better generation, since it summarizes the reply), and `@@move_top` in `out` or `<move_top>` in the flag (with `ableFlag: true`) shows the card at the top of the message. It moves only the first match.
- **Mode skins**: several ordered regexes match the same format, each keyed on a word in one field (the mode, a location type). Specific skins go first and the generic skin last; the first match consumes the text, so nothing double-renders. The panel's look then signals the current mode.
- **Display tiers**: full panel on the newest message, a reduced card on the last few, nothing older (§4.1 with two guards).
- **Random portrait**: Lua `onOutput` sets `bot_portrait` to one of several assets, and the card shows `{{raw::{{getvar::bot_portrait}}}}`. Visual variety at no prompt cost.
- **Buttons inside the card** (reroll a field, open a panel): `{{button::🔧::bot_reroll_status}}` or `risu-btn`; see 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

### 4.7 Sliding windows and the fallback box
- Window display **and** prompt independently. Display: 2-6 messages for a status card. Prompt: keep the latest 1-3 panels (the model needs the previous values), strip or partially blank the rest. These numbers are options.
- **A visible fallback box on a malformed status**: after the renderers, a last rule matches any block still in raw form (`<bot-status>[\s\S]*?<\/bot-status>`) and shows "⚠ Status format error" instead of raw text. The user sees the problem, and the chat stays readable.
- Hide control tags that ride along (a delta line, a marker) with editdisplay; window them in editprocess.

---

## 5. Producers, Lua and derived state

### 5.1 Optional Lua jobs
1. **Parse into variables**: preferably in `onOutput` (runs once per reply, after saving); `editOutput` also works but re-runs on every streamed chunk, so it must only set absolute values, never add deltas. Read the tags, store chat vars, and feed them back next turn with `{{getvar::}}` or an editRequest insertion.
   - To avoid catching tags mentioned inside CoT/thinking: exclude thought ranges, take only the **last valid block**, and skip content that is too short (just a mention).
   - Replacing `<`, `>`, `[`, `]` inside thoughts with HTML entities in editDisplay stops the following **regexes** from catching tags there too. Lua edit hooks run before the same stage's regexes. The regex alternative is a lookahead strip in editoutput ('RisuAI 정규식 작성법' §5.3).
   - Accept notation variants (case, spaces).
2. **Correct values the model wrote**: values computed from others (level, EXP needed, max HP) are recomputed by Lua and overwritten. Tell the model "do not calculate; copy the previous value; the system fixes it". A header whitelist (split on `|`, map each key to a canonical key, drop unknown and duplicate keys, keep the original if nothing survives) protects against invented fields. Protect commas that carry meaning (inside lists) with a placeholder before collapsing digit grouping, then restore them.
3. **Reroll- and delete-safe storage**: cumulative variables drift because chat vars are **not** rolled back on reroll, edit or delete, so each reroll applies its deltas again. Put a marker (`<bot-uid>N</bot-uid>`) into the saved message and keep absolute values in per-uid snapshots (`backup[uid]`). When a reroll changes the body, that uid's snapshot is naturally discarded. After delete-then-reroll, the counter goes back and editOutput runs on a body that already has a uid, so remove the old uid first and attach a new one. Wrap the whole editOutput in `pcall` and report failures with `alertError`. Other schemes are in 'RisuAI Lua 트리거'.
4. **editdisplay cache**: RisuAI's script cache key does not include chat vars. If display `out` uses `{{getvar}}` or `{{#when::var}}`, a change in the variable alone may not update the screen. reloadDisplay clears the cache in both hosts. For clicked-message refresh / reloadChat, append a `<!--bot:value-->` comment in Lua editDisplay to change the key. The cache also omits message count, so sliding-window OUT needs that dependency too.

### 5.2 The two-producer switch
The panel can come from the main model or from a second LLM call. Several bots let one variable (`bot_status_producer` = main | aux | off) choose:
- **Main model**: the TAG OUTPUT entry is active. It is reliable and in the same voice as the reply, but costs output tokens and attention.
- **Aux extraction**: the instruction entry is gated off, and the opposite line "Do not output the status panel" is gated on. Lua `onOutput` builds a strict "data extraction bot; output ONLY this line" prompt with the format, the current values and the last N messages within a token budget. It calls `axLLM` (or `LLM` for main-model mode), cleans the reply (code fences, `<think>` blocks, repeated characters), validates it, and appends it to the saved message with `setChat`. The display regexes work unchanged.
- **Cleanup flipped by the same variable**: an editoutput rule deletes any block the main model writes anyway, active only in aux mode. Gate its IN with CBS and the `<cbs>` flag:
  ```
  in:   {{#when::bot_status_producer::vis::aux}}<bot-panel>[\s\S]*?<\/bot-panel>{{/when}}
  out:  (empty)
  flag: g<cbs>          ableFlag: true
  ```
- Aux-call guards: exit early if the mode is off, if the last message is not the character's, or if it already has a block (no double pay on re-triggers). Strip an old block before appending, so the call is idempotent. After the `await`, re-read the chat and abort if the last message changed (a reroll or edit during the call). Use a full example on the first generation and a compact one afterwards. If the budget cuts off the previous block, grow the context window until one previous block is inside. Details: 'RisuAI Lua 트리거'.

### 5.3 Reverse parsing and a single time source
- Lua can parse the status line back into state: date → calendar and scheduled events; location or situation keyword → achievements or event triggers; thought → a variable for a side panel.
- **Make the status line the single source of world time.** Two time sources (hidden time directives plus input-length time estimation plus the status date) caused time resets and double advances. Parse the date from the latest status and derive everything else from it.
- If a calendar or event table is kept in Lua, remember that display-only calendars never reach the narrator. Inject today's events into the prompt ('RisuAI Lua 트리거', 'RisuAI 시뮬봇 구조와 제작').

### 5.4 Outfit field → image variable
An editoutput rule can read the model's outfit field and set a variable. The image tag then only needs the emotion:
```
in:  <bot-outfit>(uniform|casual|sleepwear)<\/bot-outfit>
out: {{setvar::bot_outfit::$1}}         (plus an editdisplay rule that hides the tag)
display: <img="Name_(.*?)"> → {{raw::{{getvar::bot_outfit}}_$1.webp}}
```
There are fewer tokens and fewer naming mistakes. Set a default in `defaultVariables`. The stored `{{setvar}}` runs once the reply is finished and is then removed from the saved text, so the tag is gone from history; because the display rule reads the variable, old messages also show the *current* outfit (fill the outfit in editoutput instead if old images must stay). See 'RisuAI 에셋 출력식'.

### 5.5 A separate affinity-delta line
Relationship changes are better as their own line than as a panel field:
```
[Name: Like it][Name2: Slightly dislike it]                  (phrase form)
[[bot-aff:name_code:+small]]                                 (coded form)
```
- The model **judges direction and size**; code does the math. A fixed map translates phrases to numbers (a strong phrase is a large step, a "slight" phrase a small one). Give per-level event rubrics ("remembers a small detail she mentioned once" = small increase), including negative ones.
- Hide the line in display (editdisplay → empty, or Lua editDisplay only, so saved data keeps it for the parser). Window it in the prompt (keep 2-3 recent examples). Add an editoutput fixer that splits merged tags (`][` → `]$n[`).
- Apply deltas in Lua with reroll-safe snapshots. Deltas applied by editoutput CBS (`{{setvar::x::{{? {{getvar::x}}+2}}}}`) are re-applied on every reroll.
- The absolute score reaches the prompt as a band, not a raw number ('RisuAI 시뮬봇 구조와 제작').

---

## 6. CSS (inside backgroundHTML `<style>`)

### 6.1 Minimum
```css
.bot-panel { margin: 20px auto; max-width: 480px; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
  border: 1px solid #2a3a4a; background: linear-gradient(145deg, #0f1923 0%, #151e2c 100%);
  padding: 16px 20px; font-family: 'Pretendard', 'Noto Sans KR', -apple-system, sans-serif; font-size: 13px; line-height: 1.7; color: #b0bec5; }
.bot-row { display: flex; gap: 10px; margin: 5px 0; align-items: baseline; }
.bot-label { color: #6b7d8e; font-size: 12px; min-width: 110px; flex-shrink: 0; }
.bot-val { color: #cfd8dc; font-size: 12.5px; }
.bot-money { color: #66bb6a; font-weight: 600; }
@media (max-width: 600px) {
  .bot-panel { margin: 12px 0; border-radius: 8px; padding-left: 14px; padding-right: 14px; }
  .bot-label { min-width: 90px; }
  .bot-row { flex-direction: column; gap: 2px; }   /* narrow screens: label above value */
}
```

### 6.2 Folding with `<details>`
```css
.bot-fold-sum { padding: 10px 0; cursor: pointer; user-select: none; list-style: none; display: flex; align-items: center; gap: 8px; }
.bot-fold-sum::-webkit-details-marker { display: none; }
.bot-fold-sum::before { content: '▶'; font-size: 9px; transition: transform .25s ease; display: inline-block; }
.bot-fold[open] > .bot-fold-sum::before { transform: rotate(90deg); }
```
A fold built from a checkbox and `<label for>` creates duplicate ids when several turns' panels are on screen, so the toggle opens the wrong one. `<details>` needs no id and is safe. If you need a checkbox, include `{{chat_index}}` in the id.

### 6.3 Stat grid and warning
```css
.bot-sec { padding: 10px 0; border-bottom: 1px solid rgba(196,160,96,.1); }  .bot-sec:last-child { border-bottom: none; }
.bot-sec-title { color: #6b7d8e; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.bot-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 16px; }
.bot-stat { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 4px; }
.bot-stat-l { color: #6b7d8e; font-size: 11px; font-weight: 600; }  .bot-stat-v { color: #cfd8dc; text-align: right; }
.bot-bar { height: 6px; background: rgba(255,255,255,.08); border-radius: 3px; overflow: hidden; }
.bot-fill { height: 100%; background: #66bb6a; }
.bot-dead-warn { margin: 8px 0; padding: 8px 12px; border: 1px solid rgba(224,90,70,.45); border-radius: 6px;
  background: rgba(224,90,70,.12); color: #e05a46; font-size: 11px; font-weight: 600; }
```

### 6.4 Conventions
- Prefix every class with the bot's prefix. Use `all: initial` resets only for button-like standalone UI; let information panels inherit the chat style.
- Set fonts explicitly to avoid inheriting the theme font.
- With `max-width: 480px; margin: auto`, few mobile rules are needed; only switch label/value columns to vertical on narrow screens.
- CSS goes inside `</style>`. Outside it, it is not applied.
- Theme values can be tokens replaced by regex (`{bot_border}`), or blocks switched by CBS in the CSS ('RisuAI 정규식 작성법' §6.4).

### 6.5 Diegetic status UIs
The panel can be an object of the fiction that matches the setting: a period desktop with a notepad window for a diary field and a folder icon that opens a list of file names; a terminal with ASCII bars; a phone lock screen with the time, place and weather; a game console window for an RPG. Choose the object from the world's era and genre. Map each field to a natural part of it (the clock shows the time field, the notepad shows the memo). Keep the underlying tag format plain, so only the regex and CSS carry the skin.

---

## 7. Applying it to a new bot

1. Decide the fields and each field's vocabulary in a table, pick the bot prefix and the format (§1). Nested XML is the default for large panels; a one-line format for small ones.
2. One lorebook entry: `@@position pt_PI`, `constant: true`, high insertion_order, the §2.1 skeleton, anti-repetition rules for free-text fields. Put a filled panel into every greeting.
3. Put `{{position::PI}}` into the global note override and decide its order relative to other instructions (§3).
4. Regex: eraser → wrapper → per-field → sub-items → fallback box → request window (editprocess, or partial blanking). All lazy captures. Add output fixers for numbers and merged tags.
5. §6 CSS in backgroundHTML; fold with `<details>`.
6. If needed: Lua (§5.1), the producer switch (§5.2), reverse parsing (§5.3), a delta line (§5.5), the watchdog (§4.4).
7. Verify:
   - Old panels disappear on screen, and the latest panel stays in the request.
   - HTML does not break when a field is missing, and a malformed block shows the fallback box.
   - Tags written inside thinking are neither parsed nor rendered.
   - Switching the producer variable flips the instruction, the cleanup regex and the Lua together.

---

## 8. Pitfalls

1. The model puts **data inside an anchor** → make the anchor/data separation CRITICAL.
2. The model imitates **angle-bracket section headers** in the instruction → use `== SECTION ==`.
3. The model copies **wrong examples** → keep them short, after the correct ones, or omit them.
4. **Tags inside CoT** get parsed or rendered → exclude thought ranges, take the last block, escape entities, or lookahead-strip in editoutput.
5. The **editdisplay cache** ignores variable changes → comment cache-buster.
6. **Lua editOutput failures are silent** → marker, watchdog, backfill, `pcall`/`alertError`.
7. **editprocess runs before editRequest** → do not strip in editprocess what Lua must read from history.
8. **Chat vars roll back on reroll** → snapshots keyed by a marker in the message body.
9. **Greedy captures** merge several turns' panels → lazy captures and `[^<]*`.
10. **Pipe and bracket value constraints** must be stated in the instruction.
11. **Closing markers and split wrapping** → self-contained per-field rules.
12. **Checkbox id collisions** → `<details>` or ids containing `{{chat_index}}`.
13. `{{#if}}` is deprecated, `{{? }}` takes a space, and the first argument of `vis` is a variable name.
14. Tag names are fixed; only values follow the output language.
15. The `@@position` decorator goes on the **first line** of the entry body; after other text it is ignored.
16. **Thousands separators** break `\d+` captures and gauges.
17. **Two time sources** advance the clock twice → one source, the status line.
18. **Editprocess rules left on an old status format** match nothing, and the full history of panels stays in the request unnoticed. Update every plane when the format changes.
19. **`<move_top>` in the flag with `ableFlag: false`** is ignored; `@@move_top` in `out` works either way.
20. A panel produced by an aux model while the main-model instruction is still active gives two panels → gate both sides on the same variable.

---

## 9. Build/review checklist

- [ ] Fields have closed vocabularies where regex, CSS or Lua depend on them; free-text fields have anti-repetition rules.
- [ ] The instruction says mandatory, gives empty-value, update, no-comma and hiding rules, and has correct examples; every greeting ends with a filled panel.
- [ ] Placement: `@@position pt_PI` on line 1 plus `{{position::PI}}` in the global note (or `@@depth 0` by choice).
- [ ] Display: eraser/window first, lazy self-contained rules, specific skins before generic, fallback box last.
- [ ] Prompt: the latest panel kept, older ones stripped or partially blanked; delta and marker lines windowed.
- [ ] Output fixers for number formatting, merged tags and stray headings.
- [ ] If there are two producers: the instruction, the opposite instruction, the cleanup regex and the Lua all switch on one variable.
- [ ] If Lua parses the panel: last valid block only, thought ranges excluded, reroll-safe storage, watchdog.
- [ ] CSS is prefixed, inside `<style>`, readable at phone width.
