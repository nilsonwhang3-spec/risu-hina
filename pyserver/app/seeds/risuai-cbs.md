> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

Read this when you read or write RisuAI CBS `{{tag}}` syntax in a card, lorebook, regex, background HTML or prompt field:
what each tag does, how `#when` conditions and operators work, what runs in which context, and common patterns
(score bands, defaults, sliding windows, dice gates, responsive CSS, asset existence checks).

> Tags below were checked against current mainline RisuAI source (`src/ts/cbs.ts` tag registry,
> `src/ts/parser/parser.svelte.ts` block parser, `src/ts/process/index.svelte.ts` and `scripts.ts` call sites, 2026-09).
> The tag set is closed: an unknown `{{…}}` stays as literal text, so never invent tags. Variable names in examples
> (`bot_*`) are placeholders; use the target bot's real names.

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
- `::` separates arguments. For a literal colon inside an argument use `{{:}}`. (If a tag contains no `::` at all, a
  single `:` also splits: older bots write `{{getvar:name}}`; it still parses, but write `::`.)
- Tag names are case-insensitive and ignore `_`, `-` and spaces: `{{chat_index}}` = `{{chatindex}}` = `{{ChatIndex}}`.
  This does not apply to block tags (`#when`, `#each`, `#func`), `call::`, `? ` or the asset tags (`img`, `raw`, …), which
  must be written exactly in lower case.
- Parsing is recursive and inside-out: `{{upper::{{user}}}}` resolves `{{user}}` first. A tag's **result is not
  re-parsed** in the same pass: `{{getvar::x}}` holding `{{user}}` prints `{{user}}` unless a later pass parses the text
  again (field tags such as `{{description}}` are the exception; they parse their field).
- `<user>`, `<char>` and `<bot>` (any case) are rewritten to `{{user}}`/`{{char}}`/`{{bot}}` before parsing in every
  parsed field, so those literal HTML-like words cannot be printed as-is.
- Everything is a string. Booleans are `"1"` / `"0"` (`#when` also accepts `"true"`). Arrays and objects are JSON strings.
  An unset chat or global variable reads as the string **`"null"`**, not `""` (unless `defaultVariables` has it).
- Whitespace: `#when` drops only blank lines at the start and end of its body; `#each` and legacy `#if` also strip every
  line's leading whitespace; `#escape` trims the body's ends; the `keep` operator preserves everything (§9, §10).
- Any `{{/…}}` closes the innermost open block; the name after `/` is not checked (`{{/}}` works). Write the matching
  name (`{{/when}}`, `{{/each}}`) for readability.
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
| `{{exampledialogue}}` / `{{examplemessage}}` | example dialogue field |

In group chats `char` returns the group name and `description`, `personality`, `scenario`, `exampledialogue` return `""`
(PocketRisu removed group chats; its character-only lookup is not group-chat support).

## 3. System / prompt tags

| Tag | Meaning |
|---|---|
| `{{mainprompt}}` / `{{systemprompt}}` | main system prompt |
| `{{jb}}` / `{{jailbreak}}` | jailbreak prompt |
| `{{globalnote}}` / `{{systemnote}}` / `{{ujb}}` | global note |
| `{{authornote}}` / `{{author_note}}` | author's note (falls back to the preset's default author's note text) |
| `{{lorebook}}` / `{{worldinfo}}` | **all** lorebook entries (character + chat + module), activated or not, as a JSON array of JSON strings |
| `{{prefillsupported}}` | `"1"` when the main model ID starts with `claude` |

## 4. Chat history tags

| Tag | Meaning |
|---|---|
| `{{previouscharchat}}` / `{{lastcharmessage}}` | last character message |
| `{{previoususerchat}}` / `{{lastusermessage}}` | last user message |
| `{{lastmessage}}` | last message (any role) |
| `{{lastmessageid}}` / `{{lastmessageindex}}` | index of the last message (0-based; the greeting is not counted) |
| `{{firstmsgindex}}` | selected greeting: `-1` = default first message, `N` = alternate greeting N |
| `{{history}}` / `{{history::role}}` | whole chat as JSON (without args: message objects, greeting included; with `role`: `"role: text"` strings, greeting excluded) |
| `{{previouschatlog::INDEX}}` | message at an index (`"Out of range"` if invalid) |
| `{{userhistory}}` | user messages as a JSON array |
| `{{charhistory}}` | character messages as a JSON array |
| `{{chatindex}}` / `{{chat_index}}` | index of the message being processed; `-1` without message context |

## 5. Date / time

| Tag | Meaning |
|---|---|
| `{{time}}` | current local time (h:m:s, not zero-padded) |
| `{{date}}` | current date (YYYY-M-D, not zero-padded) |
| `{{date::FORMAT}}` / `{{time::FORMAT}}` | formatted: `YYYY YY MMMM MMM MM DD DDDD(day of year) dddd ddd HH hh mm ss A(AM/PM) X(unix s) x(ms)` |
| `{{date::FORMAT::timestamp}}` | format a given timestamp (the source rescales this argument; test before relying on it) |
| `{{isotime}}` / `{{isodate}}` | UTC time / date |
| `{{unixtime}}` | Unix timestamp (seconds) |
| `{{messagetime}}` / `{{messagedate}}` | send time / date of the current message |
| `{{idleduration}}` | time since the last message |
| `{{messageidleduration}}` | gap between the current and previous user message |

During token counting the time tags return placeholders (`00:00:00`); do not build logic that needs them there. Format
tokens are replaced anywhere in the string, so literal letters `A`, `X`, `x` in a format also get replaced.
`{{messageunixtimearray}}` returns every message's timestamp (ms) as a JSON array.

## 6. Model / state tags

| Tag | Meaning |
|---|---|
| `{{model}}` | current model ID |
| `{{axmodel}}` | auxiliary model ID |
| `{{role}}` | role of the current message (user / char / system) |
| `{{isfirstmsg}}` / `{{isfirstmessage}}` | `"1"` when rendering the first message |
| `{{maxcontext}}` | configured max context |
| `{{jbtoggled}}` | `"1"` if the jailbreak prompt is on |
| `{{metadata::KEY}}` | system metadata |

**metadata keys**: `mobile`, `local`, `node`, `risutype` (`local`/`node`/`web`), `version`, `majorversion`, `language`,
`browserlanguage`, `modelshortname`, `modelname`, `modelinternalid`, `modelformat`, `modelprovider`, `modeltokenizer`,
`maxcontext`. An unknown key returns an `Error:` string.

## 7. Asset / media tags (display only)

Rendered only when a message or the background HTML is displayed. The CBS parser itself does not resolve them: in prompt
text they stay as the **literal tag string** (the model sees `{{img::name}}` as text, never the image). Stored messages
keep them, so old tags in history reach the model as text unless an `editprocess` regex strips them. Do not use them in
prompt-shaping fields.

Name lookup (checked in `parser.svelte.ts`): names are **case-insensitive**; the card's and enabled modules' additional
assets are both searched; when no exact name exists, the closest card asset within an edit distance of 4 (setting
`assetMaxDifference`, extension ignored) is used instead, unless the user enabled legacy media findings. A misspelled
name can therefore show a *different* similar asset. Several assets with the same name pick one per chat position.
`{{bg}}` works only in background HTML; the setting "hide all images" blanks `img`/`image`/`emotion`/`asset`/`bg`/`raw`/`path`.

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
| `{{assetlist}}` | JSON array of the card's additional asset names, exact spelling and case (`""` in mainline group context; PocketRisu has no group chats) |
| `{{emotionlist}}` | JSON array of emotion names |
| `{{chardisplayasset}}` | JSON array of prebuilt display assets (`[]` unless the card uses the prebuilt asset command) |
| `{{position::name}}` | insertion point for lorebook `@@position pt_name`; resolved textually before CBS, and only in lorebook entries, prompt-template items and the global note |

---

PocketRisu can store assets in external manifests. Regex passes preload list-tag manifests; direct synchronous Lua cbs() does not. If a manifest is not cached, an asset-list tag can remain unexpanded. Check the result before decoding it as JSON; see the asset-output skill.

## 8. Variables

### Read
| Tag | Meaning |
|---|---|
| `{{getvar::name}}` | chat variable (persistent, saved with the chat); unset → value from `defaultVariables`, else `"null"` |
| `{{getglobalvar::name}}` | global variable (read-only here); toggles are `toggle_<key>`. Since 2026-08 a chat can pin its own toggle values ("Local Toggles"); the pinned value is read first |
| `{{tempvar::name}}` / `{{gettempvar::name}}` | temporary variable (current parse only; unset → `""`) |

### Write
| Tag | Meaning |
|---|---|
| `{{setvar::name::value}}` | set chat variable |
| `{{addvar::name::number}}` | add a number |
| `{{setdefaultvar::name::default}}` | set only when the value is empty or `"null"` |
| `{{settempvar::name::value}}` | set temporary variable (always works) |

> **Caution: where setters run** (checked in `index.svelte.ts` / `Chat.svelte`). `setvar`, `addvar` and `setdefaultvar`
> run **only while stored chat messages are parsed with variable permission**, which happens (1) when a request is
> prepared and (2) right after a reply finishes, before the `output` trigger / `onOutput`. That pass also **writes the
> parsed result back into the stored message**, so all CBS left in a stored message is resolved once and saved (asset
> tags and unknown tags stay). A `{{setvar}}` written by an editoutput regex therefore runs when the reply is finished
> (again for each reroll); one written by an editinput regex runs when that request starts. On display the tags are removed silently. **Everywhere else (description,
> lorebook entries, global note, prompt items, greetings, background HTML, regex OUT in editdisplay/editprocess, Lua
> `cbs()`) setters do nothing and stay in the text as the literal `{{setvar::…}}` string**, which then reaches the model
> or the screen. Use Lua (`setChatVar`) or the card's `defaultVariables` for writes outside chat messages.

---

## 9. Conditions: `#when`

### Basic form
```
{{#when::condition}}
  content
{{/when}}
```
Truthy values are exactly `"1"` and `"true"`; everything else is false. A space form also exists: `{{#when condition}}`
(only the first word after the space counts, so use it only for a single value with no spaces).

**Both branches are parsed before one is chosen.** Tags with side effects inside a false `#when` branch still run:
`{{settempvar}}`, `{{return}}`, and in stored chat messages also `{{setvar}}`/`{{addvar}}`. Legacy `{{#if}}` and
`#when::legacy` skip a false body entirely. Put side effects in a single branch-free place, or compute the value first.

### else
In a **multi-line** block `{{:else}}` must be **on its own line** with nothing else (surrounding spaces are fine). If it
shares a line with other text, it is not recognized: the true branch prints a literal `{{:else}}` plus both halves and
the false branch prints nothing. Keep that line break when you compact HTML or regex output. In a **single-line** block
an inline `{{:else}}` works (the first one splits the block; inner blocks are already resolved).

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
For numeric comparisons the operands are values: `{{#when::{{getvar::bot_score}}::>=::50}}`. They use `parseFloat`, so
an unset variable (`"null"`) or empty string makes **every** numeric comparison false (both `>=` and `<`); give numeric
variables a default. `is`/`isnot` compare strings exactly (`"1"` is not `"1.0"`).

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
The first argument of `vis`/`visnot`/`var`/`toggle`/`tis`/`tisnot` is the **name**, never `{{getvar::name}}` (that resolves to a value,
which is then looked up as a name and fails silently). `var`/`toggle` are true only for `"1"`/`"true"`.

### Whitespace control
```
{{#when::keep::condition}}    keep whitespace
{{#when::legacy::condition}}  legacy trimming (old #if); :else disabled
```

> Evaluation order: operators are consumed **right to left** with no precedence, so `A::or::B::and::C` means
> `A or (B and C)` and `1::and::1::or::0` is true. Blocks can be nested. `{{#when::keep::not::A}}` = keep whitespace,
> NOT A. Operators are found by position, so a value that contains `::` shifts them and breaks the condition.
> Comparisons mixed with `and`/`or` also run right to left: `{{#when::X::>=::1::and::Y::is::Z}}` means
> `X >= (1 and (Y is Z))`, not what it looks like. Combine comparisons with nested `#when` blocks or with functions:
> `{{#when::{{and::{{greaterequal::X::1}}::{{equal::Y::Z}}}}}}`.

Legacy forms still parsed (deprecated in the source; write `#when` in new text):
- `{{#if cond}}…{{/if}}`: true only for exactly `1`/`true`; trims every line; no `{{:else}}`; a false body is skipped.
- `{{#if_pure cond}}…{{/if_pure}}`: same but keeps whitespace (now `#when::keep::cond`).
- `{{#pure}}…{{/pure}}`: now `#puredisplay`.

---

## 10. Loops: `#each`

```
{{#each [1,2,3] as item}}{{slot::item}}, {{/each}}          -> 1,2,3,   (see trimming below)

{{#each {{getvar::bot_list}} as item}}
- {{slot::item}}{{br}}
{{/each}}
```
- **Trimming**: the body is trimmed (every line's leading whitespace and both ends) *before* it is repeated, and the
  joined result is trimmed again. A body `\n  - {{slot::item}}\n` therefore yields `- a- b- c` on **one line**. For one
  item per line end the body with `{{br}}`, or use `{{#each::keep ARR as V}}`, which keeps the body exactly.
- The body is not parsed until expansion: `{{slot::V}}` is replaced textually by each element (objects and nested
  arrays as JSON), then the expanded text is parsed. Elements containing `{{`/`::` therefore act as CBS.
- The array must be a JSON array (2D works; nesting works; `[]` outputs nothing). A non-JSON value is split on `§`, so
  `a,b,c` is one element and an unset variable (`"null"`) loops once with `null`.
- Older bots omit `as` (`{{#each {{assetlist}} a}}`): the parser still accepts it (last word = slot name), but write `as`.

## 11. Functions: `#func` and `call`

```
{{#func band}}…{{arg::1}}…{{/func}}
{{call::band::{{getvar::bot_score}}}}
```
- In `{{call::name::x::y}}`, `{{arg::1}}` is the first argument `x`, `{{arg::2}}` is `y`; `{{arg::0}}` is the function
  name itself (checked in the parser source; older notes that said "arg 0 = first argument" are wrong).
- `{{arg::N}}` is a plain text substitution done before the body is parsed; only the exact form `{{arg::N}}` is replaced.
- Define the function in the same text (same field or lorebook entry) before calling it: definitions live only for one
  parse call, and `{{#func}}` itself prints nothing. Calls may nest up to 20 levels (`ERROR: Call stack limit reached`).
- `{{return::value}}` stops the current parse and returns only `value`: inside a `call` body it becomes the call's
  result; at top level it replaces the whole field's output.
- Named parameters (`{{#func greet name}}` + `{{tempvar::name}}`) and calling by name (`{{greet::Alice}}`) are **not
  implemented** in the parser (extra words after the name are stored but never used). Use `call` and `arg::N`.

## 12. String functions

| Function | Syntax | Result |
|---|---|---|
| `replace` | `{{replace::text::find::repl}}` | replace all |
| `split` | `{{split::text::sep}}` | JSON array |
| `join` | `{{join::array::sep}}` | string |
| `spread` | `{{spread::array}}` | elements joined with `::` (to pass an array as arguments) |
| `trim` | `{{trim::text}}` | strip surrounding whitespace |
| `length` | `{{length::text}}` | character count |
| `contains` | `{{contains::text::part}}` | "1"/"0" (substring, case-sensitive) |
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
| `?` | `{{? 1+2}}` | same evaluator as `calc` (space, not `::`) |
| `round` / `floor` / `ceil` | `{{round::3.7}}` | 4 / … |
| `abs` | `{{abs::-5}}` | 5 |
| `remaind` | `{{remaind::10::3}}` | 1 |
| `pow` | `{{pow::2::3}}` | 8 |
| `fixnum` | `{{fixnum::3.14159::2}}` | 3.14 |

**`calc` / `{{? }}` expressions** (checked in `infunctions.ts`): `+ - * / % ^`, comparisons `< > <= >= == !=` (give
`1`/`0`), `&&`/`&`, `||`/`|`, unary `!`, parentheses. `$name` reads a chat variable and `@name` a global variable as a
number (non-numeric → 0); `null` counts as 0: `{{? $bot_score + 1}}`. **All comparison and logic operators share one
precedence level and run left to right**, so `a>1&a<5` is `((a>1)&a)<5`; parenthesize every comparison:
`{{? ({{getvar::x}}>1)&({{getvar::x}}<5)}}`. A non-numeric word in the expression breaks the result.

## 14. Random

| Function | Syntax | Meaning |
|---|---|---|
| `random` | `{{random}}` | float 0-1 |
| `random` | `{{random::a,b,c}}` / `{{random::a::b::c}}` / `{{random::["a","b"]}}` | random pick, new on every parse; one argument splits on `,` or `:` (`\,` = literal comma) |
| `pick` | `{{pick::a,b,c}}` | like `random`, but seeded by chat ID + current **message count**: identical in every place and every re-parse until a message is added or removed, then changes |
| `randint` | `{{randint::1::10}}` | integer, inclusive |
| `dice` | `{{dice::2d6}}` | dice sum; needs full `XdY` |
| `roll` | `{{roll::2d6}}`, `{{roll::20}}`, `{{roll::d20}}` | dice sum; `N` alone = 1dN. **`{{roll}}` without argument returns `1`**, not 1d6 |
| `rollp` / `rollpick` | `{{rollp::1d20}}` | `roll` with the `pick` seed (stable until the message count changes; a reroll gives the same value) |
| `hash` | `{{hash::input}}` | deterministic 7-digit hash |

## 15. Arrays / objects / aggregates

### Arrays
| Function | Syntax |
|---|---|
| `makearray` / `array` / `a` | `{{makearray::a::b::c}}` -> `["a","b","c"]` |
| `arraylength` | `{{arraylength::array}}` |
| `arrayelement` | `{{arrayelement::array::index}}` |
| `arraypush` | `{{arraypush::array::item}}` |
| `arraypop` | `{{arraypop::array}}` |
| `arrayshift` | `{{arrayshift::array}}` |
| `arraysplice` | `{{arraysplice::array::start::deleteCount::newItem}}` |
| `filter` | `{{filter::array::mode}}`, mode all / nonempty / unique |
| `range` | `{{range::[5]}}` -> [0,1,2,3,4]; also `[start,end]`, `[start,end,step]` |
| `arrayassert` | `{{arrayassert::array::index::value}}` sets the index only if it is out of bounds |

Array arguments that are not valid JSON are split on `§` (`a§b§c` = three elements).

### Objects
| Function | Syntax |
|---|---|
| `makedict` / `dict` / `object` / `d` / `o` | `{{makedict::key=value::k2=v2}}` |
| `dictelement` / `objectelement` | `{{dictelement::object::key}}` |
| `objectassert` / `dictassert` | `{{objectassert::object::key::value}}` sets the key only if missing |
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
| `greaterequal` / `lessequal` | `{{greaterequal::a::b}}` (`greater_equal`, `less_equal` are the same tag) | "1"/"0" |
| `and` / `or` | `{{and::1::1}}` | "1"/"0" (only `"1"` counts as true, not `"true"`) |
| `not` | `{{not::1}}` | "0" (anything but `"1"` gives "1") |
| `iserror` | `{{iserror::s}}` | "1" if s starts with `error:` (any case) |

## 17. Escapes / special tags

| Tag | Output |
|---|---|
| `{{bo}}` / `{{bc}}` | `{{` / `}}` (not parsed) |
| `{{decbo}}` / `{{decbc}}` | `{` / `}` |
| `{{dec}}` / `{{:}}` | `:` |
| `{{(}}` `{{)}}` `{{;}}` / `{{<}}` `{{>}}` | `(` `)` `;` / `&lt;` `&gt;` (shown as `<` `>`, never HTML) |
| `{{br}}` / `{{newline}}` | line break |
| `{{cbr}}` / `{{cbr::N}}` | escaped newline (`\n`) × N |
| `{{blank}}` / `{{none}}` | empty string |
| `{{// comment}}` | documented as a hidden comment, but **current mainline has no handler for it** (removed in the 2025-07 CBS refactor, per source reading): it stays as literal text in prompts and on screen. Lorebook key scanning still ignores it. For a hidden note write `{{blank::note text}}` (arguments are ignored, output is empty) |
| `{{comment::text}}` | visible comment on display only |
| `{{hiddenkey::value}}` / `{{hidden_key::value}}` | lorebook activation key that is not sent to the model |
| `{{return::value}}` | end execution and return a value |
| `{{declare::name}}` | parser flag (internal use; no effect for bot authors) |

These escapes produce placeholder characters that display as the real symbol and are turned back into `{`, `(`, `:`,
`&lt;` … in the request sent to the model.

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
- `#puredisplay` (alias `#pure_display`; legacy `#pure`) outputs its body unparsed with `{{`/`}}` escaped, so it shows
  as text. `#escape` also leaves the body unparsed and turns `{ } ( )` into the display-safe placeholders.
- `{{#code}}…{{/code}}` removes newlines and tabs from its body and decodes `\n`, `\t`, `\uXXXX` escapes (for writing
  long one-line HTML readably).

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
| `{{u::hex}}` / `{{ue::hex}}` | character from a hex code point (`{{u::2665}}` = ♥) |

## 20. Buttons and modules

```
{{button::Label::TriggerName}}
```
- It renders `<button class="button-default" risu-trigger="TriggerName">Label</button>`. Clicking runs the manual
  trigger (or the Lua global function) with that name. Raw HTML alternatives: `risu-trigger="TriggerName"` (same) and
  `risu-btn="payload"` (calls Lua `onButtonClick(id, payload)`).
- `{{trigger_id}}` / `{{triggerid}}` returns the `risu-id` attribute of the element that fired the trigger (`"null"` if none).
- `{{screen_width}}` / `{{screenwidth}}`, `{{screen_height}}` / `{{screenheight}}`: viewport size in px at parse time.
- `{{moduleenabled::namespace}}`: `"1"` if a module with that namespace is loaded.
- `{{moduleassetlist::namespace}}` (same tag as `{{module_assetlist::…}}`): JSON array of that module's asset names
  (`""` if the module is not loaded).

---

## 21. Behavior by context

| Context | Setters (`setvar`/`addvar`/`setdefaultvar`) | Notes |
|---|---|---|
| description / personality / scenario / persona | no, **left as literal text** | parsed when the prompt is built; conditions and getters work |
| lorebook content, global note, author's note, prompt items | no, **left as literal text** | parsed when injected; `{{position::…}}` resolved first; conditions decide what reaches the prompt |
| first message / alternate greetings | no (the greeting is not a stored message); stripped on display, literal in the prompt | `{{isfirstmsg}}` = "1"; re-parsed every time, so it can react to variables |
| stored chat messages (user input, replies incl. regex-written text) | **yes**, at request start and when a reply finishes | the parsed result is written back into the message (CBS in it is resolved once) |
| regex OUT at regex time | no | editinput/editoutput: the literal tag is stored, then runs as above; editdisplay: shown literally; editprocess: sent literally to the model |
| display rendering of messages | removed silently | HTML, buttons render; asset tags resolve after CBS |
| background HTML | no, literal | `{{chat_index}}` = -1; passes through editdisplay regexes |
| Lua `cbs()` | no, literal | current character; `{{chat_index}}` = -1 |

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

**Defaults**: put them in the card's `defaultVariables` (`bot_stage=0`, one per line); `getvar` returns them while the
variable is unset. Older bots write `{{setdefaultvar::bot_stage::0}}` in an always-on lorebook entry: that does **not**
run there and sends the literal tag to the model every turn (§8, §21). Remove it or move the defaults.

**Sliding window** (display old UI once, trim tokens, keep only recent examples). As a regex `out` that wraps the match:
```
{{#when::{{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-N}}}}}}$&{{/when}}
{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-N}}}}}}$&{{/if}}          (older bots; deprecated)
```
The legacy `#if` form also strips the leading whitespace of every line of `$&`; `#when` keeps it.
Use it in editdisplay (last N+1 messages) or editprocess (recent format examples). Both stages cache results without message count: OUT-only guards can stay stale. Include the dependency in literal `<cbs>` IN or pre-regex text. Background and greeting share index -1, so short-chat windows can include background HTML.

**Dice gates for random events** (constant entries, usually `@@depth 0`):
```
{{#when::{{roll::500}}::<=::4}}
### Unexpected visitor
- (2-4 bullets of event guidance)
- Do not trigger during private or intimate scenes.
{{/when}}
```
Older bots write `{{#if {{? {{roll::500}}<=4}}}}` (still works). `roll` changes on every parse (reroll re-rolls;
but token counting and injection parse separately, so the budget estimate can use another branch). `rollp` is stable until the message count changes, but every `rollp` with the same argument in that request
returns the **same** number, so several gates on `rollp::500` are correlated (useful for exclusive buckets, wrong for
independent events). Give each event its own rarity and a safety clause. A Lua-rolled seed stored in a chat var plus
range buckets (`{{#when::{{getvar::bot_seed}}::<=::20}}`) picks exactly one variant per day or turn.

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
Use `{{moduleassetlist::namespace}}` for module assets. `{{assetlist}}` checks are exact and case-sensitive, while
`{{raw::}}` alone never fails on a near miss: it silently shows the closest similar asset (§7). The check is what makes a
missing name render nothing or a small fallback note. Details: 'RisuAI 에셋 출력식'.

**Gating by omission**: wrap optional prompt lists in `{{#when::bot_opt::vis::1}}…{{/when}}` so the model is never told
about disabled content, instead of writing "do not use X".

---

## 23. Pitfalls

1. `{{#when::A::=::B}}` never works. Use `is` or `{{equal}}`.
2. `vis`/`visnot`/`var` take the variable name; `{{getvar}}` there fails silently.
3. A multi-line `{{:else}}` that shares its line with other text breaks the block.
4. `{{?::1+2}}` does not work; `{{? 1+2}}` does.
5. Setters run only inside stored chat messages. In lorebook entries, descriptions, the global note, greetings,
   editdisplay/editprocess output and Lua `cbs()` they do nothing and the literal `{{setvar::…}}` text stays (§8, §21).
6. Asset tags (`img`, `image`, `asset`, `raw`, …) are resolved only on display; in prompt text they are literal strings.
   `comment` shows only on display; `button` becomes HTML text wherever it is parsed.
7. `{{random}}` and `{{roll}}` change on every parse; `pick` / `rollp` are stable only until a message is added.
   `{{roll}}` with no argument returns `1`.
8. `contains` is a substring check: `Ann` matches `Anna`.
9. Group chats return `""` for `description`, `personality`, `scenario`, `exampledialogue`, `assetlist`.
10. To print `{{…}}` literally use `{{bo}}`/`{{bc}}` or `#puredisplay`; otherwise `{{user}}` in output is substituted.
11. `{{persona}}` is the user's persona; the character's is `{{personality}}`.
12. A literal `::` inside an argument splits it; use `{{:}}`.
13. Unset variables read as `"null"`: numeric `#when` comparisons are then all false and `{{#each}}` loops once.
14. A false `#when` branch is still parsed: `settempvar`, `return` and (in messages) setters inside it run.
15. `#each` joins items without newlines unless the body ends in `{{br}}` or uses `::keep`.
16. In `{{? }}`, comparisons and `&`/`|` have equal precedence; parenthesize each comparison.
17. Literal `<user>`/`<char>`/`<bot>` in any parsed text become the names.
18. `#func` parameters are only `{{arg::1}}`, `{{arg::2}}` …; `{{arg::0}}` is the function name.
19. `{{// …}}` comments from older bots now print as literal text (§17); use `{{blank::…}}` for hidden notes.

## 24. Review checklist

- [ ] no `::=::`; equality uses `is` or `{{equal}}`
- [ ] every `vis`/`visnot` first argument is a bare variable name that exists (in `defaultVariables` or set somewhere)
- [ ] every multi-line `{{:else}}` on its own line
- [ ] no display-only tag in prompt-shaping text; no setter relied on in a context where it does not run
- [ ] numeric comparisons use values (`{{getvar::…}}`), string ones use `is`; numeric variables have defaults
- [ ] no `{{setvar}}`/`{{setdefaultvar}}` in lorebook, description, global note or greeting text
- [ ] `#func` bodies use `{{arg::1}}` and up, never `{{arg::0}}`
- [ ] `#each` bodies that should print lines end in `{{br}}` or use `::keep`
- [ ] sliding windows and dice gates tested on a chat longer than N messages
