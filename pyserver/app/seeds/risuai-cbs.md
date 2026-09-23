Read this when you read or write RisuAI CBS `{{tag}}` syntax in a card, lorebook, regex, background HTML or prompt field:
what each tag does, how `#when` conditions and operators work, what runs in which context, and common patterns
(score bands, defaults, sliding windows, dice gates, responsive CSS, asset existence checks).

> Tags below were checked against the CBS reference derived from RisuAI source (`src/ts/cbs.ts`,
> `src/ts/parser/parser.svelte.ts`, 2026-08). The tag set is closed: an unknown `{{…}}` stays as literal text, so never
> invent tags. Variable names in examples (`bot_*`) are placeholders; use the target bot's real names.

Contents
1. Core syntax
2. Character / user tags
3. System / prompt tags
4. Chat history tags
5. Date / time
6. Model / state tags
7. Asset / media tags (display only)
8. Variables
9. Conditions: `#when`
10. Loops: `#each`
11. Functions: `#func` and `call`
12. String functions
13. Math
14. Random
15. Arrays / objects / aggregates
16. Comparison functions
17. Escapes / special tags
18. Text formatting
19. Encoding / encryption
20. Buttons and modules
21. Behavior by context
22. Patterns
23. Pitfalls
24. Review checklist

Related skills: 'RisuAI 로어북 구조' (decorators such as `@@depth`, `@@position`), 'RisuAI 정규식 작성법' (CBS inside
regex output, `<cbs>` flag), 'RisuAI Lua 트리거' (`cbs()` from Lua), 'RisuAI 에셋 출력식' (asset tags and
`{{assetlist}}` checks), 'RisuAI 상태창'.

---

## 1. Core syntax

- CBS works in almost every text field: description, first message, lorebook content, regex in/out, global note, system
  prompt, author's note, persona, background HTML, trigger scripts.
- `::` separates arguments. For a literal colon inside an argument use `{{:}}`.
- Parsing is recursive and inside-out: `{{upper::{{user}}}}` resolves `{{user}}` first.
- Everything is a string. Booleans are `"1"` / `"0"`. Arrays and objects are JSON strings.
- Whitespace inside blocks is trimmed by default; the `keep` operator preserves it.
- `{{? expr}}` uses a **space**, not `::`.

## 2. Character / user tags

| Tag | Meaning |
|---|---|
| `{{char}}` / `{{bot}}` | character name |
| `{{user}}` | user name |
| `{{persona}}` / `{{userpersona}}` | user persona description |
| `{{description}}` / `{{chardesc}}` | character description field (re-parsed, so CBS inside it runs) |
| `{{personality}}` / `{{charpersona}}` | personality field |
| `{{scenario}}` | scenario field |
| `{{exampledialogue}}` | example dialogue field |

## 3. System / prompt tags

| Tag | Meaning |
|---|---|
| `{{mainprompt}}` / `{{systemprompt}}` | main system prompt |
| `{{jb}}` / `{{jailbreak}}` | jailbreak prompt |
| `{{globalnote}}` / `{{ujb}}` | global note |
| `{{authornote}}` | author's note |
| `{{lorebook}}` / `{{worldinfo}}` | active lorebook entries as a JSON array |

## 4. Chat history tags

| Tag | Meaning |
|---|---|
| `{{previouscharchat}}` / `{{lastcharmessage}}` | last character message |
| `{{previoususerchat}}` / `{{lastusermessage}}` | last user message |
| `{{lastmessage}}` | last message (any role) |
| `{{lastmessageid}}` | index of the last message |
| `{{history}}` / `{{history::role}}` | whole chat as JSON (with `role`, entries become `"role: text"`) |
| `{{previouschatlog::INDEX}}` | message at an index (`"Out of range"` if invalid) |
| `{{userhistory}}` | user messages as a JSON array |
| `{{charhistory}}` | character messages as a JSON array |
| `{{chatindex}}` / `{{chat_index}}` | index of the message being processed; `-1` without message context |

## 5. Date / time

| Tag | Meaning |
|---|---|
| `{{time}}` | current local time (h:m:s) |
| `{{date}}` | current date |
| `{{date::FORMAT}}` | formatted (YYYY, MM, DD, HH, mm, ss, dddd …) |
| `{{date::FORMAT::timestamp}}` | format a given timestamp |
| `{{isotime}}` / `{{isodate}}` | UTC time / date |
| `{{unixtime}}` | Unix timestamp (seconds) |
| `{{messagetime}}` / `{{messagedate}}` | send time / date of the current message |
| `{{idleduration}}` | time since the last message |
| `{{messageidleduration}}` | gap between the current and previous user message |

During token counting the time tags return placeholders (`00:00:00`); do not build logic that needs them there.

## 6. Model / state tags

| Tag | Meaning |
|---|---|
| `{{model}}` | current model ID |
| `{{axmodel}}` | auxiliary model ID |
| `{{role}}` | role of the current message (user / char / system) |
| `{{isfirstmsg}}` | `"1"` when rendering the first message |
| `{{maxcontext}}` | configured max context |
| `{{jbtoggled}}` | `"1"` if the jailbreak prompt is on |
| `{{metadata::KEY}}` | system metadata |

**metadata keys**: `mobile`, `local`, `node`, `risutype`, `version`, `majorversion`, `language`, `browserlanguage`,
`modelshortname`, `modelname`, `modelinternalid`, `modelformat`, `modelprovider`, `modeltokenizer`, `maxcontext`.
An unknown key returns an `Error:` string.

## 7. Asset / media tags (display only)

Rendered when the chat is displayed; **never sent to the model**. Do not use them in prompt-shaping fields.

| Tag | Meaning |
|---|---|
| `{{img::name}}` / `{{image::name}}` | image (unstyled / styled) |
| `{{emotion::name}}` | emotion image |
| `{{asset::name}}` | auto-detects image or video |
| `{{video::name}}` | video with controls |
| `{{video-img::name}}` | video as image (autoplay, muted, loop) |
| `{{audio::name}}` | audio with controls |
| `{{bgm::name}}` | background music |
| `{{bg::name}}` | full-screen background image |
| `{{raw::name}}` / `{{path::name}}` | asset file path (use inside `url('…')` or `src`) |
| `{{source::user}}` / `{{source::char}}` | profile image path |
| `{{inlay::name}}` / `{{inlayed::name}}` | inlay (not sent to the model) |
| `{{inlayeddata::name}}` | inlay that **is** sent to the model |
| `{{assetlist}}` | JSON array of the card's additional asset names (`""` in group chats) |
| `{{emotionlist}}` | JSON array of emotion names |
| `{{chardisplayasset}}` | JSON array of prebuilt display assets |
| `{{position::name}}` | declares an insertion point used by lorebook `@@position pt_name` |

---

## 8. Variables

### Read
| Tag | Meaning |
|---|---|
| `{{getvar::name}}` | chat variable (persistent, saved with the chat) |
| `{{getglobalvar::name}}` | global variable (read-only here) |
| `{{tempvar::name}}` / `{{gettempvar::name}}` | temporary variable (current parse only) |

### Write
| Tag | Meaning |
|---|---|
| `{{setvar::name::value}}` | set chat variable |
| `{{addvar::name::number}}` | add a number |
| `{{setdefaultvar::name::default}}` | set only when empty |
| `{{settempvar::name::value}}` | set temporary variable (always works) |

> **Caution**: `setvar`, `addvar` and `setdefaultvar` run only where the parser has variable permission. In the checked
> source, chat messages are re-parsed with that permission when a send is prepared, so a `{{setvar}}` left in a stored
> message (for example written by an editoutput regex) executes on the **next** send, not immediately; on display the
> tag is removed silently. Description, lorebook token counting and previews do not execute setters. For immediate or
> guaranteed writes use Lua (`setChatVar`) or the card's `defaultVariables`.

---

## 9. Conditions: `#when`

### Basic form
```
{{#when::condition}}
  content
{{/when}}
```
Truthy values are exactly `"1"` and `"true"`; everything else is false. A space form also exists: `{{#when condition}}`.

### else
Put `{{:else}}` **on its own line** with nothing else in multi-line blocks; inline it does not parse correctly there.
Keep that line break when you compact HTML or regex output. (Single-line blocks may use an inline `{{:else}}`; the own-line
form is the safe habit.)

```
{{#when::condition}}
  when true
{{:else}}
  when false
{{/when}}
```

### Comparison operators

**`::=::` does not work as a comparison in CBS conditions. Never write `{{#when::A::=::B}}`.** For string equality use
`{{#when::A::is::B}}`, or the comparison function `{{#when::{{equal::A::B}}}}`.

```
{{#when::A::>::B}}       number greater
{{#when::A::<::B}}       number less
{{#when::A::>=::B}}      greater or equal
{{#when::A::<=::B}}      less or equal
{{#when::A::is::B}}      string equal
{{#when::A::isnot::B}}   string not equal
```
For numeric comparisons the operands are values: `{{#when::{{getvar::bot_score}}::>=::50}}`.

### Logical operators
```
{{#when::A::and::B}}     both true
{{#when::A::or::B}}      either true
{{#when::not::A}}        negation
```

### Variable operators
```
{{#when::var::name}}             chat variable is truthy
{{#when::name::vis::B}}          variable `name` == literal B
{{#when::name::visnot::B}}       variable `name` != literal B
{{#when::toggle::name}}          global toggle (toggle_name) is on
{{#when::name::tis::B}}          toggle `name` == B
{{#when::name::tisnot::B}}       toggle `name` != B
```
The first argument of `vis`/`visnot`/`var` is the variable **name**, never `{{getvar::name}}` (that resolves to a value,
which is then looked up as a name and fails silently).

### Whitespace control
```
{{#when::keep::condition}}    keep whitespace
{{#when::legacy::condition}}  legacy trimming (old #if); :else disabled
```

> Evaluation order: operators are consumed **right to left**; blocks can be nested. `{{#when::keep::not::A}}` = keep
> whitespace, NOT A.

`{{#if cond}}…{{/if}}` and `{{#if_pure}}` are deprecated but still work in older bots; write `#when` in new text.

---

## 10. Loops: `#each`

```
{{#each [1,2,3] as item}}
  {{slot::item}}
{{/each}}

{{#each {{getvar::bot_list}} as item}}
  - {{slot::item}}
{{/each}}
```
- `{{#each::keep ARR as V}}` preserves whitespace.
- JSON arrays (also 2D); nesting works; an empty array outputs nothing.
- Older bots omit `as` (`{{#each {{assetlist}} a}}`): the parser still accepts it (last word = slot name), but write `as`.

## 11. Functions: `#func` and `call`

```
{{#func band}}…{{arg::1}}…{{/func}}
{{call::band::{{getvar::bot_score}}}}
```
- In `{{call::name::x::y}}`, `{{arg::1}}` is the first argument `x`, `{{arg::2}}` is `y`; `{{arg::0}}` is the function
  name itself (checked in the parser source; older notes that said "arg 0 = first argument" are wrong).
- Define the function in the same text (same field or lorebook entry) before calling it; nesting depth is limited.
- `{{return::value}}` ends execution early.
- The CBS reference also documents named parameters (`{{#func greet name}}` + `{{tempvar::name}}`) and calling by name
  (`{{greet::Alice}}`); not verified here, so prefer `call`/`arg`.

## 12. String functions

| Function | Syntax | Result |
|---|---|---|
| `replace` | `{{replace::text::find::repl}}` | replace all |
| `split` | `{{split::text::sep}}` | JSON array |
| `join` | `{{join::array::sep}}` | string |
| `trim` | `{{trim::text}}` | strip surrounding whitespace |
| `length` | `{{length::text}}` | character count |
| `contains` | `{{contains::text::part}}` | "1"/"0" (substring) |
| `startswith` | `{{startswith::text::prefix}}` | "1"/"0" |
| `endswith` | `{{endswith::text::suffix}}` | "1"/"0" |
| `lower` / `upper` | `{{lower::text}}` | case |
| `capitalize` | `{{capitalize::text}}` | first letter upper |
| `reverse` | `{{reverse::text}}` | reversed |
| `tonumber` | `{{tonumber::text}}` | keeps only digits and `.` |

## 13. Math

| Function | Syntax | Result |
|---|---|---|
| `calc` | `{{calc::2+3*4}}` | 14 |
| `?` | `{{? 1+2}}` | expression shorthand (space, not `::`) |
| `round` / `floor` / `ceil` | `{{round::3.7}}` | 4 / … |
| `abs` | `{{abs::-5}}` | 5 |
| `remaind` | `{{remaind::10::3}}` | 1 |
| `pow` | `{{pow::2::3}}` | 8 |
| `fixnum` | `{{fixnum::3.14159::2}}` | 3.14 |

## 14. Random

| Function | Syntax | Meaning |
|---|---|---|
| `random` | `{{random}}` | float 0-1 |
| `random` | `{{random::a,b,c}}` / `{{random::a::b::c}}` | random pick (changes on every parse) |
| `pick` | `{{pick::a,b,c}}` | hash-based, stable for the same chat slot |
| `randint` | `{{randint::1::10}}` | integer, inclusive |
| `dice` / `roll` | `{{dice::2d6}}`, `{{roll::20}}` | dice sum; `roll::N` = 1dN, default 1d6 |
| `rollp` | `{{rollp::1d20}}` | deterministic dice per chat slot |
| `hash` | `{{hash::input}}` | deterministic 7-digit hash |

## 15. Arrays / objects / aggregates

### Arrays
| Function | Syntax |
|---|---|
| `makearray` / `a` | `{{makearray::a::b::c}}` -> `["a","b","c"]` |
| `arraylength` | `{{arraylength::array}}` |
| `arrayelement` | `{{arrayelement::array::index}}` |
| `arraypush` | `{{arraypush::array::item}}` |
| `arraypop` | `{{arraypop::array}}` |
| `arrayshift` | `{{arrayshift::array}}` |
| `arraysplice` | `{{arraysplice::array::start::deleteCount::newItem}}` |
| `filter` | `{{filter::array::mode}}`, mode all / nonempty / unique |
| `range` | `{{range::[5]}}` -> [0,1,2,3,4]; also `[start,end]`, `[start,end,step]` |

### Objects
| Function | Syntax |
|---|---|
| `makedict` / `d` / `o` | `{{makedict::key=value::k2=v2}}` |
| `dictelement` | `{{dictelement::object::key}}` |
| `element` / `ele` | `{{element::JSON::key1::key2}}` nested access (`"null"` on a miss) |

### Aggregates
| Function | Syntax |
|---|---|
| `min` / `max` / `sum` / `average` | `{{sum::1::2::3}}` -> 6 |
| `all` | `{{all::1::1::0}}` -> "0" |
| `any` | `{{any::0::1::0}}` -> "1" |

## 16. Comparison functions

| Function | Syntax | Returns |
|---|---|---|
| `equal` | `{{equal::a::b}}` | "1"/"0" (case-sensitive) |
| `notequal` | `{{notequal::a::b}}` | "1"/"0" |
| `greater` / `less` | `{{greater::10::5}}` | "1"/"0" |
| `greater_equal` / `less_equal` | `{{greater_equal::a::b}}` (also `greaterequal`) | "1"/"0" |
| `and` / `or` | `{{and::1::1}}` | "1"/"0" |
| `not` | `{{not::1}}` | "0" |
| `iserror` | `{{iserror::s}}` | "1" if s starts with `error:` |

## 17. Escapes / special tags

| Tag | Output |
|---|---|
| `{{bo}}` / `{{bc}}` | `{{` / `}}` (not parsed) |
| `{{decbo}}` / `{{decbc}}` | `{` / `}` |
| `{{dec}}` / `{{:}}` | `:` |
| `{{br}}` / `{{newline}}` | line break |
| `{{cbr}}` / `{{cbr::N}}` | escaped newline (`\n`) × N |
| `{{blank}}` / `{{none}}` | empty string |
| `{{// comment}}` | hidden, outputs nothing |
| `{{comment::text}}` | visible comment on display only |
| `{{hiddenkey::value}}` | lorebook activation key that is not sent to the model |
| `{{return::value}}` | end execution and return a value |

### Escape blocks
```
{{#puredisplay}}
  {{CBS in here}} is shown, not parsed
{{/puredisplay}}

{{#escape}}
  {braces} and (parentheses) are escaped
{{/escape}}

{{#escape::keep}}
  keep-whitespace mode
{{/escape}}
```

## 18. Text formatting

| Tag | Meaning |
|---|---|
| `{{tex::E=mc^2}}` | LaTeX/KaTeX |
| `{{ruby::base::reading}}` | ruby annotation (furigana) |
| `{{codeblock::code}}` / `{{codeblock::lang::code}}` | code block |
| `{{bkspc}}` | delete the last word of the output so far |
| `{{erase}}` | delete the last sentence of the output so far |

## 19. Encoding / encryption

| Tag | Meaning |
|---|---|
| `{{unicodeencode::A}}` / `{{unicodedecode::65}}` | code point <-> character |
| `{{fromhex::FF}}` / `{{tohex::255}}` | hex <-> decimal |
| `{{xor::text}}` / `{{xordecrypt::base64}}` | XOR + base64 / decrypt |
| `{{crypt::text::shift}}` | Caesar shift (default 32768, its own inverse) |

## 20. Buttons and modules

```
{{button::Label::TriggerName}}
```
- Clicking runs the manual trigger (or the Lua global function) with that name. Raw HTML alternatives:
  `risu-trigger="TriggerName"` (same) and `risu-btn="payload"` (calls Lua `onButtonClick(id, payload)`).
- `{{trigger_id}}` returns the `risu-id` attribute of the element that fired the trigger (`"null"` if none).
- `{{screen_width}}` / `{{screenwidth}}`, `{{screen_height}}`: viewport size in px.
- `{{moduleenabled::namespace}}`: `"1"` if a module with that namespace is loaded.
- `{{moduleassetlist::namespace}}` / `{{module_assetlist::…}}`: JSON array of that module's asset names.

---

## 21. Behavior by context

| Context | Setters run | Notes |
|---|---|---|
| description / personality / scenario | no | re-parsed when inserted; conditions work |
| first message / alternate greetings | no | `{{isfirstmsg}}` = "1" |
| lorebook content | no (token counting) | conditions decide what reaches the prompt |
| stored chat messages at send time | **yes** | leftover `{{setvar}}` in messages executes here |
| regex out (editoutput / editinput) | no at regex time | setters stay in the stored text and run on the next send |
| display rendering | removed | HTML, images, buttons render; setters are stripped |
| Lua `cbs()` | per call | runs in the current character's context |

Temp vars (`settempvar`) work in any context but vanish after the parse.

---

## 22. Patterns

**Score -> band label with `#func`** (one definition serves every character; the model reads a label, not a raw number):
```
{{#func band}}{{#when::{{arg::1}}::>=::80}}close{{:else}}{{#when::{{arg::1}}::>=::40}}friendly{{:else}}distant{{/when}}{{/when}}{{/func}}
- Name A: {{getvar::bot_aff_a}} ({{call::band::{{getvar::bot_aff_a}}}})
- Name B: {{getvar::bot_aff_b}} ({{call::band::{{getvar::bot_aff_b}}}})
```
Thresholds are examples; the bot defines its own bands. For long per-band behavior text, one `#when` block per band
inside a constant entry lets only the active paragraph reach the prompt.

**Declarative defaults in an always-on entry**:
```
{{setdefaultvar::bot_stage::0}}{{setdefaultvar::bot_lang::en}}
```
Readable list of defaults, but setters do not run at lorebook evaluation time (§8, §21). Bots that use it also backfill
from Lua; the reliable source of defaults is the card's `defaultVariables`.

**Sliding window** (display old UI once, trim tokens, keep only recent examples). As a regex `out` that wraps the match:
```
{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-N}}}}}}$&{{/if}}
{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-N}}}}}}$&{{/when}}     (same, non-deprecated)
```
Use it in editdisplay (render images or panels only for the last N+1 messages), in editprocess (keep format examples only
in recent history), and with `N = 0` to show a floating panel only under the newest message.

**Dice gates for random events** (constant entries, usually `@@depth 0`):
```
{{#when::{{roll::500}}::<=::4}}
### Unexpected visitor
- (2-4 bullets of event guidance)
- Do not trigger during private or intimate scenes.
{{/when}}
```
Older bots write `{{#if {{? {{roll::500}}<=4}}}}`. `roll` changes on every parse (reroll re-rolls; harmless); use `rollp`
for a stable result per chat slot. Give each event its own rarity and a safety clause. A Lua-rolled seed stored in a chat
var plus range buckets (`{{#when::{{getvar::bot_seed}}::<=::20}}`) picks exactly one variant per day or turn.

**CBS inside background HTML CSS** (responsive layout and option-driven styles):
```
<style>
.bot-panel { width: {{#when::{{screen_width}}::<::600}}96vw{{:else}}560px{{/when}}; }
{{#when::bot_asset_fold::vis::1}}.bot-asset { aspect-ratio: 1 / 1; }{{/when}}
</style>
```

**Asset existence check before rendering**:
```
{{#each {{assetlist}} as a}}{{#when::{{equal::{{slot::a}}::$1}}}}<div class="bot-asset" style="background-image:url('{{raw::$1}}')"></div>{{/when}}{{/each}}
{{#when::{{contains::{{assetlist}}::"$1"}}}}…{{/when}}     (shorter: quotes make it an exact match on the JSON array)
```
Use `{{moduleassetlist::namespace}}` for module assets. Missing names can render nothing or a small fallback note. Details:
'RisuAI 에셋 출력식'.

**Gating by omission**: wrap optional prompt lists in `{{#when::bot_opt::vis::1}}…{{/when}}` so the model is never told
about disabled content, instead of writing "do not use X".

---

## 23. Pitfalls

1. `{{#when::A::=::B}}` never works. Use `is` or `{{equal}}`.
2. `vis`/`visnot`/`var` take the variable name; `{{getvar}}` there fails silently.
3. A multi-line `{{:else}}` that shares its line with other text breaks the block.
4. `{{?::1+2}}` does not work; `{{? 1+2}}` does.
5. Setters in regex output or lorebook text do not run immediately (§8).
6. Display-only tags (`image`, `asset`, `button`, `comment`, `inlay`) never reach the model.
7. `{{random}}` and `{{roll}}` change on every parse; use `pick` / `rollp` when a stable choice is needed.
8. `contains` is a substring check: `Ann` matches `Anna`.
9. Group chats return `""` for `description`, `personality`, `scenario`, `exampledialogue`, `assetlist`.
10. To print `{{…}}` literally use `{{bo}}`/`{{bc}}` or `#puredisplay`; otherwise `{{user}}` in output is substituted.
11. `{{persona}}` is the user's persona; the character's is `{{personality}}`.
12. A literal `::` inside an argument splits it; use `{{:}}`.

## 24. Review checklist

- [ ] no `::=::`; equality uses `is` or `{{equal}}`
- [ ] every `vis`/`visnot` first argument is a bare variable name that exists (in `defaultVariables` or set somewhere)
- [ ] every multi-line `{{:else}}` on its own line
- [ ] no display-only tag in prompt-shaping text; no setter relied on in a context where it does not run
- [ ] numeric comparisons use values (`{{getvar::…}}`), string ones use `is`
- [ ] sliding windows and dice gates tested on a chat longer than N messages
