<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

RisuAI lorebook structure and decorator reference. Read it when you create or change bot-lorebook or chat-lorebook entries, and especially when you decide how an entry activates (keys, decorators) and where it lands in the prompt (position, depth, budget).
Writing conventions (headings, priority bands, roster vs detail) are in 'RisuAI 로어북 작성 규칙'. Whole-bot layouts are in 'RisuAI 시뮬봇 구조와 제작' and 'RisuAI 일인봇 구조와 제작'.
Entry names, folder names, variable names and tags differ from bot to bot. Read the target bot's actual entries (list_lore, read_lore_entry) before you assume any name used here.

Contents
1. Scope: bot lorebook vs chat lorebook
2. Entry schema
3. character_book top-level fields
4. Key matching
5. Decorators
6. Placement, priority and token budget (verified against the host source)
7. Programmatic control (CBS, Lua)
8. V2/V3 card compatibility
9. Patterns
10. Pitfalls
11. Checklist

---

## 1. Scope: bot lorebook vs chat lorebook

- **Bot lorebook**: `scope="global"`, the `botlore` tab. It is stored in this bot's card and reused in every chat with the bot. "Global" means "belongs to the card", not "shared by all bots".
- **Chat lorebook**: `scope="local"`, the `lore` tab. It applies only to one chat: that chat's progress, events and temporary settings.
- An explicitly requested scope wins. If none is given, use the bot lorebook while editing the bot and the current chat's lorebook while editing a chat. Do not turn a bot-lorebook request into a chat-lorebook edit, and do not send the user to the chat-lorebook screen for it.
- When you modify an existing entry, keep its scope.
- Storage scope and `alwaysActive` are unrelated. A bot-lorebook entry can be keyword-triggered, and a chat-lorebook entry can be always on.

---

## 2. Entry schema (loreBook)

```typescript
interface loreBook {
    key: string              // match keys, comma-separated
    secondkey: string        // secondary keys (selective mode)
    insertorder: number      // priority; also the placement order (see §6)
    comment: string          // entry name shown in the list
    content: string          // body; may start with @@decorator lines
    mode: 'normal' | 'constant' | 'multiple' | 'child' | 'folder'
    alwaysActive: boolean    // true: ignore keys, always active
    selective: boolean       // true: primary AND secondary keys must match
    extentions?: { risu_case_sensitive: boolean }
    useRegex?: boolean       // keys are regular expressions
    bookVersion?: number     // schema version (currently 2)
    id?: string              // unique id (UUID)
    folder?: string          // owning folder: the folder entry's key
    name?: string            // alternative to comment
    enabled?: boolean
    insertion_order?: number // V2 compatibility field
    constant?: boolean       // V2 compatibility (alwaysActive)
    case_sensitive?: boolean
}
```

| mode | Meaning |
|---|---|
| `normal` | Ordinary entry, activated by key matching |
| `constant` | Always included (keys ignored) |
| `multiple` | Every key must match at once |
| `child` | Inherits properties from the previous entry with the same id |
| `folder` | Folder; organizes the editor list and is never injected. Its key is usually `folder:<uuid>`; members set `folder` to that key |

---

## 3. character_book top-level fields

```typescript
interface CharacterBook {
    name?: string
    description?: string
    scan_depth?: number           // how many recent messages are searched
    token_budget?: number         // total lorebook token limit
    recursive_scanning?: boolean  // activated content is searched again
    extensions: { risu_fullWordMatching?: boolean }
    entries: loreBook[]
}
```

Observed settings in popular bots: scan depth 3-10, recursive scanning off, and a large budget (tens of thousands of tokens or effectively unlimited). A small scan depth (3-5) keeps keyword entries tied to the current scene. A large budget does not make order irrelevant: the preset and the model's context can still cut the prompt.

---

## 4. Key matching

```
1. Prepare keys: split on commas, trim, drop empty strings
2. Preprocess text: remove {{//...}} comments, lowercase
3. Match with one of three modes:
   A) regex         — useRegex=true, key format /pattern/flags
   B) whole word    — @@match_full_word or the global setting
   C) substring     — default (compared with spaces removed)
4. selective: primary key AND secondary key must both match
```

- The search covers the last `scan_depth` messages; `@@scan_depth N` overrides it per entry.
- With recursive scanning on, the content of already-activated entries is also searched.
- Substring matching is the default, so very short keys (one syllable, a two-letter romanization) fire by accident. Use two or more characters, or a distinctive word.
- Popular bots use none of selective, secondary or regex keys. They rely on constant vs keyed entries plus **multi-alias keys** (see §9).

---

## 5. Decorators

Write `@@decorator` lines at the **very top of content**, one per line, before any body text; the host parses only those leading lines. Names below were checked against the host's lorebook code.

### Activation

| Decorator | Effect |
|---|---|
| `@@activate` | Force-activate (ignore keys) |
| `@@dont_activate` | Force-deactivate |
| `@@keep_activate_after_match` | Once matched, stays active afterwards (recorded in a chat variable) |
| `@@dont_activate_after_match` | Once matched, never activates again |
| `@@probability N` | Active with N% probability (0-100), rolled per request |
| `@@activate_only_after N` | Only when chat length ≥ N |
| `@@activate_only_every N` | Only when chat length % N == 0 |
| `@@is_greeting N` | Only when the chat started from greeting N |

### Matching

| Decorator | Effect |
|---|---|
| `@@match_full_word` | Whole-word matching |
| `@@match_partial_word` | Substring matching (default) |
| `@@additional_keys k1 k2` | Additional positive condition |
| `@@exclude_keys k1 k2` | Inactive if any of these match |
| `@@exclude_keys_all k1 k2` | Inactive only if all of these match |
| `@@scan_depth N` | Per-entry search depth |
| `@@no_recursive_search` | This entry is not matched during recursive search |

### Position

| Decorator | Effect |
|---|---|
| `@@depth N` | Insert N messages from the end of the chat (0 = after everything) |
| `@@reverse_depth N` | Insert N messages from the start of the chat |
| `@@end` | Same as `@@depth 0` (listed as deprecated by the editor highlighter) |
| `@@position after_desc` | After the character description |
| `@@position before_desc` | Before the character description |
| `@@position personality` | Into the personality section |
| `@@position scenario` | Into the scenario section |
| `@@position pt_NAME` | Custom slot: wherever `{{position::NAME}}` appears |
| `@@role system` | Message role: `system`, `user` or `assistant` |

`@@position` accepts only `after_desc`, `before_desc`, `personality`, `scenario` and `pt_<name>`; anything else is ignored. `@@depth 00` parses as 0.

### Injection into another entry

| Decorator | Effect |
|---|---|
| `@@inject_lore TARGET` | Append this content to the target entry (by name) |
| `@@inject_at TARGET` | Insert at the target location |
| `@@inject_prepend TARGET PARAM` | Insert before the target |
| `@@inject_replace TARGET PARAM` | Replace text inside the target |

### Recursion and other

| Decorator | Effect |
|---|---|
| `@@recursive` / `@@unrecursive` | Include / exclude this entry's content in recursive search |
| `@@priority N` | Override the budget priority only (§6) |
| `@@ignore_on_max_context` | Priority becomes -1000: first to be dropped by the budget |
| `@@disable_ui_prompt TYPE` | Disable `post_history_instructions` or `system_prompt` while active |

### Not lorebook decorators

- **`@@move_top` / `@@move_bottom`** are **regex** features, not lorebook decorators. In a regex script the OUT text may start with `@@move_top ` (or the flag `<move_top>` may be set). The host removes the match and re-inserts the rendered result at the top (or bottom) of the message. Bots use this to show a status card first while the model writes it last. See 'RisuAI 정규식 작성법'.
- **Triple-@ forms** such as `@@@end`: the host's migration of old lorebooks (bookVersion < 2) rewrites `@@@end` / `@@end` to `@@depth 0`, and the editor highlights `@@@name` like `@@name`. Whether the current parser treats `@@@` as a fallback decorator in every case was **not verified**. Write the two-@ form.
- Decorator names are case-sensitive in practice; a line like `@@Depth 0` is a typo to fix, not an alias.

---

## 6. Placement, priority and token budget

Verified in the host source (`process/lorebook.svelte.ts`, `process/index.svelte.ts`):

1. Every activated entry gets a **priority** = its `insertorder`, unless `@@priority N` (or `@@ignore_on_max_context` = -1000) overrides it.
2. Entries are sorted by priority, highest first, and admitted while they fit in the token budget. **When the budget is short, the lowest priorities are cut first.** An entry that does not fit is skipped; a smaller entry further down may still fit.
3. The admitted entries are re-sorted by `insertorder` and **placed top to bottom from the lowest priority**: the highest `insertorder` ends up last, closest to the chat. `@@priority` changes only who survives the budget, not where the entry is placed.
4. **Positioned entries go to their position**, not into the ordinary block:
   - no position → the ordinary lorebook block, whose place in the prompt is set by the preset;
   - `@@depth 0` / `@@end` → after everything (the end of the prompt);
   - `@@depth N` (N > 0) / `@@reverse_depth N` → inside the chat history at that depth;
   - `after_desc` / `before_desc` / `personality` / `scenario` → next to those card fields;
   - `pt_NAME` → replaces `{{position::NAME}}` wherever that anchor appears (preset prompt items, the global note, other entry text). **With no matching anchor the entry is not injected at all.** Unused anchors are removed.
   - `@@inject_*` → merged into the target entry.

Authoring consequences:
- **Always set `insertorder`.** The default 100 puts an entry among whatever else was left at 100. Pick the band of similar entries ('RisuAI 로어북 작성 규칙').
- Do not assume every entry survives whole. Budget cuts, a preset's own limits, or a context overflow can drop entries or leave a block partly missing. That is acceptable; write so that what remains still reads correctly (each entry names its subject, and core state does not depend on a low-priority entry surviving).
- Review positioned entries (`@@depth`, `@@end`, `@@position`) separately from the ordinary order. Not every `@@` line sets a position (`@@probability`, `@@activate`, `@@exclude_keys` do not), so read what each one does.

---

## 7. Programmatic control

### CBS

```
{{lorebook}}           — all lorebook entries (character, chat, module; activated or not) as a JSON array
{{hiddenkey::value}}   — a key the model never sees; it can still trigger entries
{{position::NAME}}     — anchor for @@position pt_NAME entries
```

CBS inside entry content is evaluated when the entry is injected, so entries can branch on chat variables (`{{getvar::x}}`, `{{#when}}`, legacy `{{#if}}`, `{{#func}}`/`{{call::}}`). Setters (`{{setvar}}`, `{{setdefaultvar}}`) do **not** run in entries; they stay in the prompt as literal text. Syntax: 'RisuAI CBS 문법'.

### Lua

```lua
-- read: entries whose name (comment) equals the string exactly, from the chat, bot and module lorebooks;
-- full entry tables, content CBS-parsed; synchronous
local hits = getLoreBooks(id, "entry name")
-- active entries for the current context as { data, role } (lowLevelAccess; call inside an async hook)
local active = loadLoreBooks(id)

-- write: create or replace a CHAT-local entry by name (the options table is required)
upsertLocalLoreBook(id, "name", "content", {
    alwaysActive = true, insertOrder = 100,
    key = "key1, key2", secondKey = "secondary", regex = false
})
```

That is the whole Lua lorebook API. There is no Lua call to list, edit or delete bot/module entries by index. The
`v2GetAllLorebooks` / `v2CreateLorebook` / `v2ModifyLorebookByIndex` / `v2SetLorebookAlwaysActive` names seen in older notes
are effects of the deprecated V2 block triggers, not Lua functions; do not use or recommend them.

Popular bots almost never create or edit entries from Lua. They keep entries constant and gate their bodies with CBS on chat variables that Lua or buttons set. Prefer that: it is visible in the editor and survives rerolls. Details: 'RisuAI Lua 트리거'.

### Internal state variables

- `__internal_ka_ENTRYID = "true"` records a `@@keep_activate_after_match` hit.
- `__internal_da_ENTRYID = "true"` records a `@@dont_activate_after_match` hit.

---

## 8. V2/V3 card compatibility

| External field | RisuAI field |
|---|---|
| `keys[]` | `key` (comma-joined) |
| `secondary_keys[]` | `secondkey` (comma-joined) |
| `insertion_order` | `insertorder` |
| `constant` / `forceActivation` | `alwaysActive` |
| `use_regex` | `useRegex` |
| `position` / `depth` / `role` | converted to @@decorators in content |

---

## 9. Patterns

Patterns A-E are basic mechanics. F onward are what popular bots actually do (counts are from a study of 14 bots; "common" means most of them).

### A. Staged story settings
```
Entry "Chapter 1"   key: chapter1   content:
  @@activate_only_after 0
  @@dont_activate_after_match
  (chapter 1 settings...)
Entry "Chapter 2"   key: chapter2   content:
  @@activate_only_after 10
  (chapter 2 settings...)
```

### B. Variable-gated content
```
@@activate
{{#when::{{getvar::bot_dark_mode}}::is::1}}
(dark-mode-only settings...)
{{/when}}
```

### C. Positioned injection
```
Entry "Combat rules"   key: combat, attack, defend   content:
  @@depth 2
  @@role system
  [combat rules here...]
```

### D. Folders
```
"Characters"  mode: folder  key: folder:<uuid>   (never injected)
"Name A"      folder: folder:<uuid>   mode: normal
"Name B"      folder: folder:<uuid>   mode: normal
```

### E. Recursive chain
```
"Magic system"  key: magic   content:  @@recursive  ... fire magic and ice magic are typical.
"Fire magic"    key: fire magic   content:  Fire magic hits hard but costs much mana.
```
"magic" matches → "Magic system" activates → recursive search finds "fire magic" → "Fire magic" activates too. Most popular bots keep recursion off and use constant roster entries instead, because recursion makes activation hard to predict.

### F. Constant roster + keyword detail (common)
One always-on entry lists every character in one line each; each full sheet is keyword-triggered. The same split works for factions, places and items. Layout details: 'RisuAI 로어북 작성 규칙'.

### G. Multi-alias keys (common)
`Name Surname, Name, Surname, <native-script full name>, <native given name>, <title>, <nickname>`. For a group entry, also add the parent group's name as a key on each member if mentioning the group should load all members (costly; use deliberately).

### H. `@@depth 0` for per-turn directives (common)
Output contracts (status block, image-tag rules), score readouts, event directors and random-event rolls sit at depth 0 so they are the last thing the model reads. Keep ordinary knowledge (world, sheets) out of depth 0; too much text there dilutes the directives.

### I. `@@position pt_NAME` with an anchor (some bots)
```
Global note (post_history_instructions):
{{position::bot_rules}}
Final checklist: ...

Entry "Rules block"  alwaysActive: true  content:
@@position pt_bot_rules
### Rules
...
```
The entry lands exactly at the anchor, after the chat history, and stays editable as a lorebook entry. The status-block contract in 'RisuAI 상태창' uses the same mechanism.

### J. Module extension slots (some bots)
Put empty anchors such as `{{position::bot_ext1}}` in the global note. An add-on module can then ship entries with `@@position pt_bot_ext1` (extra characters, an optional keyword list) without editing the card. Unused anchors vanish.

### K. Feature-flag gating (common)
A constant entry whose whole body, or one clause, is wrapped in a chat-variable condition set by an option button:
```
{{#when::bot_economy::vis::1}}
### Prices
- ...
{{/when}}
```
Older bots write `{{#if {{equal::{{getvar::bot_economy}}::1}}}}…{{/if}}`; it still works but is deprecated. Options reach the prompt only through such conditions. Treat unset variables (they read as `"null"`) as "off" or give them defaults (card `defaultVariables`, or Lua).

### L. Roll-gated random events (common in sim bots)
```
@@depth 0
{{#when::{{roll::500}}::<=::6}}
### Event: unexpected visitor
- Introduce one fitting NPC at a natural pause.
- Do not trigger while {{user}} is in a private or intimate scene.
{{/when}}
```
Older bots write `{{#if {{? {{roll::500}}<=6}}}}…{{/if}}` (still works). Each constant entry rolls on every request. Rerolls roll again (harmless, not reproducible). Seeded buckets are an alternative (see 'RisuAI 시뮬봇 구조와 제작').

### M. Score → band text with `{{#func}}` (some bots)
Define the band once in a constant entry and call it for every character, so the model reads behavior text, not a bare number:
```
{{#func bot_band}}{{#when::{{arg::1}}::<::100}}Stage 1: polite distance{{:else}}Stage 2: relaxed, teasing{{/when}}{{/func}}
- Name A: {{call::bot_band::{{getvar::bot_name_a_aff}}}}
```
`{{arg::1}}` is the first argument after the function name (`{{arg::0}}` is the name itself; older examples that use `arg::0` for the value are broken). Give the score a default: an unset value reads `"null"` and makes every numeric comparison false (here: Stage 2).

### N. Keyword mode entry with a lifecycle (solo bots)
A non-constant entry keyed on a trigger word describes activation, behavior while active, the **end condition** and the **aftermath**, so the mode ends by itself and leaves consequences.

### O. Storage and user-toggle entries
- Keyless, non-constant entries never fire. Bots use them to store creator notes, image-generation tags or translation notes inside the card. Put them in a folder labelled as storage.
- An entry shipped inactive that the user switches to always-on (a language instruction, an optional realism module) is a no-code option. Say so in the creator notes.
- Empty entries with divider names (`---- Characters ----`) are sometimes used as editor separators. Folders are cleaner.

---

## 10. Pitfalls

- `insertorder` left at 100 everywhere: placement becomes arbitrary among equals and budget cuts are unpredictable.
- `@@position pt_NAME` with no `{{position::NAME}}` anchor anywhere: the entry is silently dropped.
- Decorators placed after body text, or misspelled/capitalized: not applied.
- Believing a higher `insertorder` is placed first/on top. It is the opposite: ordinary entries run from lowest priority (top) to highest (bottom, nearest the chat).
- Believing `@@priority` moves an entry. It only changes budget survival.
- Constant entries with keys: the keys are ignored (harmless, but misleading).
- One- or two-character keys, or a generic word shared by several entries: accidental activation.
- An entry referencing a file, list or asset that does not exist in this bot (copied from elsewhere).
- Hiding a status tag with a display regex and assuming the model no longer sees it: display regexes do not change the prompt (see 'RisuAI 처리 순서 (정규식·Lua 훅)').
- `::=::` in CBS conditions: not a comparison. Use `::is::`, `{{equal::A::B}}` or `::vis::`.

## 11. Checklist

- [ ] Scope is right (bot = global/botlore, chat = local/lore) and unchanged for edits.
- [ ] Every entry has `insertorder` in the band of similar entries.
- [ ] Constant only for roster, core world rules, current state, output contracts; details keyed.
- [ ] Keys are multi-alias, not too short, not shared by accident.
- [ ] Decorators at the top, spelled correctly; every `pt_NAME` has its anchor.
- [ ] Positioned entries reviewed separately from the ordinary order.
- [ ] CBS conditions use real variable names from this bot and valid operators.
- [ ] The prompt still makes sense if the lowest-priority entries are cut.
