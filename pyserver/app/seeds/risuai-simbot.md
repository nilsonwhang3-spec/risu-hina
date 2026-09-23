<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

How to design, build or review a **sim bot**: a card where many characters appear and the card itself acts as narrator/GM. Read it when you plan a new multi-character bot or audit an existing one's lorebook, progression, events and state handling.
Names, tags, variables and numbers below are placeholders (`bot_*`, `<bot-panel>`, `Name`). Every bot uses its own; read the target bot's real names first and keep them.
This is a synthesis of common practice in popular sim bots, not a copy of any of them. Review all six content areas, merging or splitting by the bot's size. A complex RPG system or Lua state restore is **not** required for a sim bot.

Contents
1. Prompt-slot roles
2. Six content areas + system
3. Lorebook structure
4. Greetings and starts
5. Progression and information reveal
6. Event mechanisms
7. Pacing and a living world
8. Who needs to know each piece of state
9. Contract: tag output → Lua → CBS → status display
10. Optional: per-response state save and restore
11. Pitfalls
12. Build and review order

---

## 1. Prompt-slot roles

Most popular sim bots divide the card like this:

| Slot | Content |
|---|---|
| description | **A GM/narrator contract, not a character.** `{{char}}` is the simulation or narrator. Genres (optionally one directive line per genre), the AI's responsibilities (NPC authenticity, organic storytelling, user agency, continuity), the premise, the user's starting role and scope of action, core world facts, the information-disclosure principle. No character sheets. |
| personality, scenario, system_prompt, mes_example | **Empty** in almost all of them. Content lives in the description, the lorebook and the global note. |
| post_history_instructions (global note) | The **output contract that must be most recent**: image-tag rules, status format, a short pre-output checklist, or `{{position::...}}` anchors for pinned lorebook blocks. Some bots gate whole rule sections by option variables here. |
| lorebook | Everything else: world, roster, sheets, places, factions, events, system rules, live readouts. |
| greetings | Scenario starts that also demonstrate the output format (§4). |
| defaultVariables | Feature flags, language, per-character scores. Alternatives: Lua fills missing values on start; some bots declare defaults with `{{setdefaultvar}}` in an always-on entry, but it writes only in run-var contexts ('RisuAI CBS 문법'), so back it with Lua or defaultVariables. |

A useful description skeleton:

```
## Simulation: <genre list>
### AI Responsibilities
- Portray every NPC from their sheet; they have their own goals, schedules and knowledge limits.
- Advance the world organically; offer opportunities without railroading.
- Never decide {{user}}'s actions or feelings for them.   (omit if the preset owns this)
- Keep time, place, injuries, money and relationships continuous.
### Scenario
- Premise / current conflict / how {{user}} got involved / start date and position.
### Objectives for {{user}}
### World Building (rules and limits of technology/magic, society, factions)
```

Keep narration options (point of view, whether the model may write the user's part, lorebook order) out of the card: the preset owns them.

## 2. Six content areas + system

| Area | Contents | Roster / detail layout |
|---|---|---|
| 0. World setting | Era, region, genre; rules and limits of technology/magic/power; institutions, economy, culture, factions; the user's powers and limits | Short world overview + detail per nation/organization/institution/power system |
| 1. Main characters | Role, affiliation, looks; speech and behavior; wants, motives, contradictions, limits; relations to the user and to each other; daily movements; conditional changes and secrets | Main entries in the roster + one sheet each, written so personality is visible as behavior and lines |
| 2. NPCs | Supporting, extras, antagonists, faction heads; where and why they appear; links to mains and factions; the information, jobs or conflict they bring | Roster/NPC pool + detail for recurring or important NPCs; minor roles can stay one-liners |
| 3. Places | Layout, travel time, access rules; mood, facilities, activities; who is usually there; changes by time of day | Area guide/map + per-place detail. Keep places distinct from background image assets, linked if needed |
| 4. Background | History, relations and events before the start; causes of the current conflict; how the user got involved; start date, position, what the user knows | Background/history summary + deeper related entries. Separate public facts, hidden causes and future possibilities |
| 5. Events | Daily events, fixed schedule, personal episodes, main arcs; triggers, people, places; choices and outcomes; completion/failure/pending/repeat rules | Event list, calendar or arc summary + detail entries that activate when their conditions hold |
| System & state | GM rules, current time/place/progress, tag output format, the roles of variables/CBS/regex/Lua, modes and initialization | System rules, output contract, current-state summary; split number, relationship, location or restore systems when they grow |

**World setting** is how the world works; **background** is how this story started and why it is in conflict. Do not repeat the same fact in several entries (contradictions follow). Background images or CSS are not the setting's background.

The card keeps only the GM role, genre and narration direction, the user's start role and scope, core premise and the disclosure principle. Greetings, the start screen, and the lorebook's initial values must agree on date, position, relations and mode.

Mains and NPCs relate to each other and act on their own goals and schedules. Give each a distinct speech, conflict response and knowledge range so they do not all react to the user the same way. Not every character appears in every scene.

## 3. Lorebook structure

### 3.1 Roster + keyword detail (all sim bots)

- **An always-on roster is the map; keyword entries are the detail at the moment it is needed.** One line per character: `- Name (age/role): look; personality keywords; affiliation; relation`. Declare the line format at the top of the roster so additions stay uniform.
- Sheets are keyword-triggered with **multi-alias keys**: romanized full name, given name, native-script full and given names, title, nickname, alternate forms.
- The same split applies to factions, places and events. Roster and sheet share one canon (role, look, affiliation). A roster frozen at a reference date says so and points to where later changes live.
- Optional: hide a roster line while that character's sheet is active (Lua sets `bot_present_<name>` when the name appears in the last N messages; the roster wraps each line in a condition), so each character appears once, as a line or as a sheet.
- Check recursive-scan settings so the roster's names do not chain-activate every sheet. Do not assume an entry keyed on a code the model prints becomes active in the same response; it applies from the next request. Plan when a detail must arrive.

### 3.2 Folders, dividers, bands

- Group entries by category folders (World, Roster & Characters, Antagonists, Places, Factions, Items, Events, System, Custom). Empty divider entries are an older alternative. Some bots ship empty "custom" entries in their own folder for users to fill.
- `insertorder` works as **category bands**: rules, output contracts and live readouts highest (latest, nearest the chat), then rosters and world, then sheets, then flavor, items and bestiary lowest. Budget cuts hit the lowest band first. Match the bot's existing bands; do not import another bot's numbers. Rules: 'RisuAI 로어북 작성 규칙'.
- `@@depth 0` is reserved for **per-turn directives**: output contract, score readout, random-event rolls, event or quest director. Optionally one big rules block goes to a global-note anchor with `@@position pt_<name>` + `{{position::<name>}}`.
- Headings: `###`/`####`/`[Section]`, never `##` (reserved for the outer prompt). Folders are not injected as headings.

### 3.3 Fixed sheet skeleton

Every sheet in one bot follows one skeleton, so the model finds the same kind of fact in the same place:

```
### Name Surname
#### Basic Information
- Name / alias / age / gender / role / affiliation / birthday
#### Appearance and Wardrobe
- Build, hair, eyes, signature item, scent
- <outfit_key>: items — when worn   (keys match the asset attire tokens, if any)
#### Background
- Past as a chain: event → consequence → current state
#### Core Identity
- Values, wound, belief, goal, flaw
- Visible side: routine, skills, habits
- Hidden side: fear, secret, conflict   (lock with CBS if it is a spoiler)
#### Behavior and Speech
- Register by audience; 2-3 sample lines with a stage direction
#### Preferences
- Likes / dislikes / hobbies (small, concrete)
#### Abilities
#### Relationships
- {{user}}: starting stance and what could change it
- Other characters: one line each
#### Extra Details
```

Optional gated sections unlock deeper text by score or date (§5.2). A "mandatory guidelines" first section is useful only for tricky characters (amnesia, hidden identity, information they must not reveal).

### 3.4 Always-on relational context

- **Relationship matrix / social graph**: pairwise lines (`#### A & B`), including user-facing seeds (`#### A & {{user}}: dislikes {{user}} at first; can improve`).
- **Who-knows-what table**: per group or character, what they know and believe about the others. It drives dramatic irony and stops secrets leaking to everyone.
- **Speech and address table** where hierarchy matters (first person, how each addresses others, honorifics, exceptions).
- **Glossary** of in-world terms, with an instruction to use them.

### 3.5 Organizations and power

- **Summary chains** for organizations: overview (always-on, high band) → group list (always-on) → unit detail (keyed, lower band). Mentioning a unit loads its detail; the overview keeps the map visible.
- **Power tiers with perception lines**: for each tier, add how ordinary people and same-tier people perceive a feat at that level. This calibrates NPC reactions without numeric stats. Put the tier value in both roster and sheet.

### 3.6 CBS in entries

- **Feature flags** gate whole entries or single clauses: `{{#if {{equal::{{getvar::bot_economy}}::1}}}}…{{/if}}` or `{{#when::{{getvar::bot_events}}::is::1}}…{{/when}}`. Typical flags: language, economy subsystem, stats mode, events on/off, images on/off, expansion content, scenario mode. Options reach the prompt only through such conditions ('RisuAI 옵션 패널 (슬라이딩 드로어)').
- **Bilingual text via one variable**: headings and glosses inside entries switch on `bot_lang`.
- **Score → band via a function**, defined once and called per character, so the model reads a behavior band, not a raw number:

```
@@depth 0
### Relationship Readout
{{#func bot_band}}{{#if {{? {{arg::0}}<=100}}}}Stage 1 — polite distance; small talk only{{/if}}{{#if {{? ({{arg::0}}>100)&({{arg::0}}<=200)}}}}Stage 2 — relaxed; teases, seeks {{user}} out{{/if}}{{#if {{? {{arg::0}}>200}}}}Stage 3 — trusts {{user}} with private matters{{/if}}{{/func}}
Review this before writing any listed character.
- Name A: {{getvar::bot_aff_a}}/300 — {{call::bot_band::{{getvar::bot_aff_a}}}}
- Name B: {{getvar::bot_aff_b}}/300 — {{call::bot_band::{{getvar::bot_aff_b}}}}
```

## 4. Greetings and starts

- **Scenario starts + one free start** (common): each greeting is a different hook into the world (a place, a faction, a featured character, a crisis) and ends at a decision point. One greeting is only the start marker: a free start that still gets the setup UI.
- **Single greeting switched by variables** (alternative): a setup panel sets `bot_start`, `bot_role`, `bot_lang`; the greeting is a CBS switch over them and re-renders (Lua `reloadChat` or the variables alone). No alternate greetings needed; costs a large first message.
- **Role selector**: buttons set `bot_role`; the greeting, description lines and small always-on "user role" entries branch on it, so one card supports several user roles.
- **Bilingual via one variable**: each greeting holds one block per language under `{{#if {{equal::{{getvar::bot_lang}}::0}}}}`. Keep narrative language and UI language as separate variables if the UI is multilingual. Handle the unset value (neither branch matches).
- **The greeting is a few-shot example**: it shows the prose style, image tags where the model should place them, the status line or tag lines at the end, filled with the start date and place. Some bots also show a sample quest board or system message.
- **Sentinel glyph**: a glyph of your choice on line 1 (e.g. `☆`) is turned into the setup screen or panel by a display regex and stripped from the prompt by an editprocess regex ('RisuAI 정규식 작성법').
- Greeting facts (date, relations, looks) must match sheets and initial variables.

## 5. Progression and information reveal

For each event, decide as needed: a stable ID, start conditions (date, place, participants, stage), the entry scene, choices and branches, **the concrete scene that counts as completion**, failure/pending conditions, state changes, follow-ups, repeatability and interval. Completion is a condition met in an actual scene, not a mention or a suspicion.

### 5.1 Progression styles (choose or combine)

- **Date / timeline**: the current date divides past, present and future; only the current period's events are injected in detail. Flashbacks do not rewind the date. Future developments are never stated as past facts. Decide in advance what wins when play diverges from the canonical timeline.
- **Secret-reveal stages**: public background vs character and story secrets. Per stage: what may be revealed, what must not leak, the transition condition, locked with CBS. An unlocked secret is not automatically known by every NPC.
- **Quest completion log**: fixed quest IDs and completion conditions; arc and character stages are computed from the set of completed IDs. The model may not invent IDs or advance stages without a scene.
- **Daily life / free play**: event candidates fit place, relations and schedule, offered at natural moments without cutting into the user's action or an emotional scene. Relationships progress even without a main event.

Event conditions, the tag values the model emits, the transitions Lua allows, and the text CBS unlocks must all describe the same rule. Do not copy broken examples from existing cards; in particular **`::=::` is not a CBS comparison**: use `::is::`, `::vis::` or `{{equal::A::B}}` ('RisuAI CBS 문법').

### 5.2 Relationship bands and unlocked depth

- **Affection bands → behavior text** (most bots): the model sees score → band → behavior guideline (§3.6). Five stages, or hostile-to-devoted phases, are typical. Scores should come from a structured signal (a delta tag or a separate classifier pass), not from prose.
- **Threshold-unlocked sheet sections**: a sheet reveals a "closer bond" section (hidden traits, private habits) at score ≥ X and a "full trust" section (inner monologue, growth) at ≥ Y: `{{#when::{{getvar::bot_aff_a}}::>=::101}}…{{/when}}`. Saves tokens early and paces depth.
- **Stage-banded story guidance**: a world stat band can change a "current target / story guideline" line.

## 6. Event mechanisms

### 6.1 Random events

- **Roll gates in CBS** (simplest): constant `@@depth 0` entries, each `{{#if {{? {{roll::500}}<=N}}}}…{{/if}}` with its own rarity (0.4-2% per request), gated by an events flag. Or one entry: `{{roll::100}}<=4` plus `{{random::event A::event B}}`. Rerolls roll again.
- **Seeded buckets**: Lua rolls a 1-100 seed per turn or per in-world day into a chat variable; one constant entry picks exactly one variant by range. Near-zero token cost, stable within the seed's period.

```
{{#when::{{getvar::bot_events}}::is::1}}{{#when::{{getvar::bot_event_seed}}::>::0}}
### Event Feed (introduce only if cast and place fit; otherwise let it pass)
{{#when::{{getvar::bot_event_seed}}::<=::15}}- A rival group posts a challenge notice.{{/when}}
{{#when::{{getvar::bot_event_seed}}::>::15}}{{#when::{{getvar::bot_event_seed}}::<=::30}}- A lost item surfaces with a clue.{{/when}}{{/when}}
{{/when}}{{/when}}
```

```lua
function onOutput(id)
  local ok, err = pcall(function()
    local turn = getChatLength(id)
    local until_turn = tonumber(getChatVar(id, "bot_event_cooldown_until")) or 0
    if getChatVar(id, "bot_scene_protected") == "1" or turn < until_turn then
      setChatVar(id, "bot_event_seed", "0")          -- suppressed
    else
      setChatVar(id, "bot_event_seed", tostring(math.random(1, 100)))
    end
  end)
  if not ok then setChatVar(id, "bot_lua_error", tostring(err)) end
end
```

- **Scene protection**: every event text says "do not trigger while {{user}} is in a private, intimate or tense one-on-one scene". Stronger: the model emits a hidden marker when such a scene starts and ends (e.g. `[[bot-private-scene:on]]` / `[[bot-private-scene:off]]`, hidden by display regex) that Lua reads to suppress events; add a cooldown after a foreground event and a "used today" flag.
- **Two-step introductions**: a new-NPC event first queues the name (profile-on-demand line, §7), and the NPC appears the next turn after the sheet has loaded.

### 6.2 Scheduled events and the calendar

- A calendar table (fixed dates, annual events, birthdays, user-added events, period overrides such as vacations or trips that suspend normal routines) with prelude and aftermath windows.
- **Priority director**: override > scheduled event due > promoted random event > prelude/aftermath traces > none. Lua computes the current mode into variables; a depth-0 entry shows the due event's block: core beats `a → b → c`, hooks (who is involved), and whether it is mandatory now or at the next natural transition.
- **Pitfall — display-only calendar**: a calendar rendered only in the UI is invisible to the narrator; it will not know about the exam tomorrow. Inject the next due event (or the next few) into the prompt.
- Time needs one source of truth. Parse the date from the status line (or keep it in Lua) but not both independently; two sources double-advance time.

### 6.3 Stat-threshold arcs and completion tokens

- Arc N unlocks when a world stat reaches a threshold and arc N-1 is complete. A constant `@@depth 0` entry injects the active arc brief: title, giver, background, goal, notes, and top priority.
- The brief tells the model to emit an **exact completion token** when the goal is achieved in a scene, e.g. `[[bot-arc:ARC_ID:completed]]`. Lua (or an editoutput regex) catches it, records completion once, and a display regex hides it. Guard against double rewards (ignore a token already seen in the last few messages).
- Quest loops: the model offers a board of 3-4 in-world jobs; progress is tracked by the model or an aux call; success tags apply rewards in Lua.

## 7. Pacing and a living world

- **Pacing directives** (all sim bots): characters follow their own schedules and not all are present; offer opportunities without railroading; travel takes time and does not complete in one response; do not freeze time; clear outcomes in conflicts (win, loss, retreat) with consequences; avoid repetitive questioning of the user; anti-cliché rules where the genre invites them.
- **NPC schedules**: a weekly schedule with time blocks and day modifiers that mark characters unavailable.
- **Rumor tiers**: who saw it → do they talk → how fast; broker characters by tier (instant, selective, silent) and distortion per retelling.
- **Profile-on-demand**: the model ends each reply with a request line such as `[bot-next-cast: Name A, Name B | none]`. The names match sheet keys, so the sheets load next turn; the rule says only characters whose profiles are loaded may be portrayed in detail. Keep the line in the prompt for a few messages, hidden in display.
- **Off-screen NPC tracker**: every N turns an aux call writes one line per absent NPC (doing now / purpose / next), re-injected at depth 0; a longer "developments" summary every M turns.
- **Endings are a summary, not a lock**: late in the timeline, gated guidance lists ending candidates (characters past a threshold) and the ending type; play may continue after it.
- Anti-verbatim: sheet text is reference material, not dialogue to recite; do not quote sheet lines.

## 8. Who needs to know each piece of state

For every item decide separately: shown to the user? kept in front of the model? stored in a variable? These overlap. Money or time that is public but used in event conditions still belongs in a variable.

| Purpose | Output and display | Storage and next-turn delivery |
|---|---|---|
| User and model must both keep knowing it | Tag output (date, place, companions, money, equipment, current goal), styled by regex into a status panel | The raw tag stays in the message as context. If it needs persistent state, Lua stores it and the latest state is re-injected |
| Hidden from the user, tracked by the model | Internal tag output hidden by an `editdisplay` regex or parsed by Lua | Keep the raw text in the model's context, or summarize stored state back through CBS/request hooks. Hiding on screen is not removing it from the request |
| Drives events, behavior or branches | Fixed tags/IDs/values, validated and parsed by Lua | Chat variables/state; CBS reflects current values and active bands. Show only what the UI needs |

**The status panel is a display; choose storage separately.** HTML made by `editdisplay` does not change the stored message, and hiding a tag on screen does not delete it from the chat. Design the regex rendering, the raw record and the Lua variables each on purpose.

A value in the raw text or a variable is unknown to the model unless it is in the next request. When `editprocess` removes old tags to save tokens, re-supply what is needed through the latest panel or a CBS state summary. Secrets not yet revealable never go in a public panel.

Common channel options (mix as needed):
- One time/place tag on the last line; the lorebook reads the date variable parsed from it to pick the current period.
- A public panel tag (`<bot-panel>…</bot-panel>`) for visible state and agenda.
- An empty display placeholder (`<bot-chart name="…"/>`) that a regex fills from stored data, separate from a data tag (`[bot-chart: …]`) that Lua saves; an `editRequest` hook re-sends the stored records. Never nest the placeholder and the data tag.
- A signed delta tag for relationships (`<bot-aff>Name A +2</bot-aff>`), a location tag, a completion log (`<bot-done>ARC_ID</bot-done>`). After parsing, some raw tags are removed and the stored values are re-provided with `getvar` in the lorebook.
- Management tags (`<bot-uid>`, `<bot-stage>`) are attached by Lua, never generated by the model.

## 9. Contract: tag output → Lua → CBS → status display

Before building, write a small state table. Per row: **tag/field, meaning, type and allowed values, initial value, absolute or delta, when emitted, where stored, who updates it, visibility, next-turn injection path** (and whether restore covers it).

- Set frequency: required state every response; deltas only when something changed. Specify delimiters, line breaks, keys, IDs and what happens when a field is missing. Never parse free prose where a number or ID is needed.
- Separate display names from internal keys with one consistent mapping. Define handling for unknown names/IDs, bad numbers or tags, and out-of-range values. Do not overwrite a missing value with 0 or an empty list.
- Absolute values replace; deltas apply once to a confirmed base. Do not let the model and Lua both add the same change. Validate change size, min/max and stage transitions in Lua. A robust option: the model reports a **categorical change** ("slight increase", "big decrease") and a fixed map turns it into numbers.
- Align the output rule, parser, CBS variable names and display regex. If public state and internal stage disagree, decide which stored value is canonical; derive computable levels from it.
- Initialize only when a value is missing. A start hook that runs every turn must not reset progress. Say whether a mode change keeps the record or starts over.
- `editOutput` changes the saved reply and can run repeatedly; `editDisplay` runs on every redraw, so display must never advance scores or events. `editprocess` is the request-side regex; Lua's final request edit is `editRequest`. Hook order and arguments: 'RisuAI 처리 순서 (정규식·Lua 훅)' and 'RisuAI Lua 트리거'. Status panel build: 'RisuAI 상태창'. Image tags: 'RisuAI 에셋 출력식'.
- Producer switch (optional): the main model writes the status block, or Lua `onOutput` asks an aux model to extract it from the last N messages and appends it. When the Lua producer is on, strip any block the main model wrote anyway.

## 10. Optional: per-response state save and restore

Use when progress, affection, companions or location are complex, or continuity after reroll/delete matters. Do not force it on a bot that needs only a simple panel. The design below does not mean every card field is restored automatically.

1. **Pick the restore unit.** A narrative scene name and a storage ID are different things. Lua attaches an ID (`<bot-uid>`) to each confirmed reply; rerolls of the same scene are different outputs. The model never issues IDs.
2. **Restore from the surviving conversation.** Read messages from the end to find the latest valid ID with a backup. The largest counter or newest backup is not necessarily the end of the current branch; never pull state from a deleted future reply.
3. **New state = base state + this reply's changes.** Compute stages from the de-duplicated completion log; apply this reply's deltas to the base snapshot only. Never add a new delta on top of the final value saved before the reroll.
4. **Store linked state under one ID**: completion log, absolute scores, companions, location (e.g. `bot_backup_done`, `bot_backup_aff`, `bot_backup_party`, `bot_backup_loc`). Then sync the CBS variables, keep one ID per message, and hide management tags in display.
5. **Cover every path**: normal input, reroll, empty input, delete then regenerate. Do not assume the input hook always runs; verify the state is applied before the request is assembled.
6. **Define exceptions and cost**: old messages without backups, a first message without tags, imported saves, going back past the retention limit. Do not describe limited restore as unlimited. Decide whether UI changes between turns (e.g. party edits) are kept or rolled back.
7. **Optional recovery**: re-collect unprocessed completion/delta tags after the base point, or import a save as a base state, both with boundaries against double application. If an aux-model result arrives late, compare the ID at request time with the current chat end and do not apply it to another branch.

Other reroll-safe schemes seen: a snapshot + pending changes + processed-turn index (reroll recomputes from the snapshot); a cursor + per-message signature + stored deltas (only the diff is applied); a hidden per-message snapshot comment whose ID keys the stored state, with orphan cleanup; or recompute everything from the full chat each time (event sourcing), which is safe by construction. Pick one.

Test: two normal turns; repeated processing of the same reply; reroll; deleting the last and several messages then regenerating; missing or malformed tags; missing old backups; UI changes; a late async response. **Progress, rewards and affection must not double, and linked state under one ID must restore together.** A reference card's implementation is not a test result for new code.

## 11. Pitfalls

- Character data in the description of a many-character bot: it is always sent and crowds the budget.
- Roster and sheet disagree (looks, affiliation), or greetings disagree with sheets and initial variables.
- Every entry at the default priority; or long knowledge at depth 0 diluting the directives.
- Option variables with a typo or a different prefix in one gate; unset variables matching no branch (e.g. language unset shows no greeting text).
- Request-side regexes left on an old tag format so they never match; tags stripped from display but still piling up in the prompt (or the reverse).
- A calendar or quest log that only the UI sees.
- Random events that fire into intimate or climactic scenes; events with no cooldown.
- Model-invented IDs, names or asset tags accepted without a whitelist.
- Stat deltas applied in `editOutput` or display without reroll protection; two time sources.
- Entries or instructions that reference a file, list or asset that does not exist in this bot.
- Copying another bot's names, variables, tags or numeric bands.

## 12. Build and review order

1. Decide the user's role, start point, genre, scope of action and the core of the six areas. Do not invent undecided facts as canon.
2. Build the maps (roster, factions, places, events) and link the needed details. Check that characters have independent goals, relations and reasons to act that can create scenes.
3. Separate public background, secrets and future possibilities; define event triggers, completion, failure and reveal conditions.
4. Use the state table to split public UI, hidden tracking and condition variables; choose the needed level of tag output, regex, Lua and CBS, and optional restore.
5. Review heading hierarchy, bands of related entries, the whole injection order and the token budget together. Check which rosters and details actually activate in representative scenes.
6. Test within the implemented scope: first turn, time/place change, event completion, before/after a secret unlock, the request and the status panel. For every added feature, verify its parse, storage, re-injection and restore paths.

Checklist
- [ ] Description is a GM contract; unused slots empty; global note holds the recency-critical output contract.
- [ ] Roster + keyword sheets with one skeleton and multi-alias keys; bands match the bot.
- [ ] Relationship matrix / who-knows-what / address table where needed.
- [ ] Every option variable is read somewhere in the prompt, and unset values behave.
- [ ] Events: gated, scene-protected, cooled down; scheduled events visible to the narrator.
- [ ] Completion tokens are exact, hidden, and applied once.
- [ ] Greetings: scenario starts + free start; format demonstrated; facts match initial values.
- [ ] State table complete; reroll behavior tested for every counter.
