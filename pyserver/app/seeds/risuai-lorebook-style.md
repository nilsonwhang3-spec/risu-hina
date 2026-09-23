<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

RisuAI lorebook **authoring rules**. Read this before you write or change any entry (propose_lore_add / propose_lore_edit / propose_lore_replace). The field, decorator and placement *specification* is in 'RisuAI 로어북 구조'; this file is the **form and conventions** that work in practice. Do not write SillyTavern-style entries.
Names, folders, tags and variables vary per bot. Read the target bot's own entries first and match them; the examples here are placeholders.

Contents
1. Scope first
2. Shape of one entry
3. Headings
4. insertorder: priority bands and placement
5. Roster entries vs detail entries
6. Positioned entries (@@)
7. Keys
8. Folders and dividers
9. Progressive reveal (spoiler stages)
10. Sim-bot vs solo-bot layouts
11. Do not
12. Procedure for a new entry
13. Structure and order review (checklist)

---

## 1. Scope first

- **Bot lorebook**: `scope="global"`, `botlore` tab. Stored in this bot's card and used in every chat with it.
- **Chat lorebook**: `scope="local"`, `lore` tab. Only one chat's progress, events and temporary settings.
- The user's stated scope wins. If none is stated: bot lorebook while editing the bot, the current chat's lorebook while editing a chat. Never redirect a bot-lorebook request to the chat-lorebook screen.
- Editing an existing entry keeps its scope. Permanent storage (scope) and always-on activation (`alwaysActive`) are different things.

## 2. Shape of one entry

```
comment (name):  Name Surname                      ← list name; same as the body title
key (keywords):  Name Surname, Name, Surname, <native-script name>, <title>
insertorder:     780                               ← priority number (§4); always set it
alwaysActive:    false                             ← true only for always-on entries (then key is empty)
folder:          (folder key)                      ← owning folder, if any
content:
### Name Surname
#### Identity
- Name Surname. Deputy harbor-master, 31, raised in the dockside quarter.
#### Appearance
- Short copper hair, green eyes, ink-stained fingers.
#### Speech
- Brisk and practical; swears quietly when numbers do not add up.
  - Under pressure: very polite, which is a warning sign.
#### Relationships
- {{user}}: new clerk in her office; tests before trusting.
```

- Body = **fact-level bullets** under `####` subheadings, not paragraphs of prose.
- Character sheets are often long (10-17 subheadings: Identity, Appearance, Wardrobe, Background, Personality, Speech with sample lines, Behavior, Preferences, Abilities, Relationships, Secrets, Arc). Keep **one fixed skeleton** for every sheet in a bot; the section list is in 'RisuAI 시뮬봇 구조와 제작' / 'RisuAI 일인봇 구조와 제작'.
- World entries may use `[Bracket section]` labels with bullets under a `###` title.
- Language: follow the bot's body language. Keys mix every language users might type. Many bots write bodies in English and add native-language terms in parentheses.
- **No SillyTavern header block**: no `@@position personality`, `@@role system`, `@@scan_depth 12`, `@@priority 700` stacked above the body out of habit. RisuAI has `@@` decorators, but popular bots use very few: `@@depth 0` for per-turn directives and sometimes one `@@position pt_<name>`. Priority is the **insertorder field**, not a decorator.

## 3. Headings

- Use `###`, `####` and `[Section]` inside lorebook content. **`##` is reserved for the outer prompt** (the preset and card use it), so lorebook bodies use H3 and below.
- A standalone entry starts with `### Title`, and the title matches `comment`.
- When entries are injected together as a group and its members, lower the members' level to fit the actual injected text (`###` group → `####` member → `[sub-section]`).
- Folders are **not** injected as headings. Do not rely on a folder name to give an entry context; each entry must name its own subject.
- If a positioning decorator is present, it goes on the first line, before the heading.

## 4. insertorder: priority bands and placement

How the host uses it (verified; details in 'RisuAI 로어북 구조' §6):
- Ordinary entries are **placed top to bottom from the lowest priority**. The highest `insertorder` lands last, nearest the chat, where the model attends most.
- When the token budget is short, **the lowest priorities are cut first**. A cut that leaves part of a block missing is acceptable when unavoidable; do not assume every entry survives whole.
- Positioned entries (`@@depth`, `@@end`, `@@position`) go to their own position instead (§6).

So `insertorder` is both "how important" and "how late". Popular bots use **category bands**. A typical shape, high to low:

| Band (example numbers) | What goes there |
|---|---|
| highest (e.g. 900-1000+) | Output contracts, system rules, live state readouts, stage tables |
| high (e.g. 800-900) | Always-on rosters (character list, faction list), core world rules, relationship matrix |
| upper-middle (e.g. 700-800) | Main character sheets |
| middle (e.g. 500-700) | Important supporting cast, factions, regions, places, routines |
| low (e.g. 300-500) | Items, bestiary, events flavor, minor NPCs |
| lowest (e.g. 50-300) | Extras, glossary flavor, background texture that may be cut |

- The numbers are an example, not a standard. **Match the bands already used in the target bot**: find the neighbors of the same kind and use the same or a nearby value.
- A new entry gets **the same value as its closest same-kind neighbor** unless it is clearly more or less important.
- Some bots invert the logic for a few items (a world primer placed low so it reads first). That is fine if deliberate; keep it consistent.

## 5. Roster entries vs detail entries

- Budgets are finite, so split into **an always-on roster that maps everything** and **detail entries injected when active**.
- Example: an always-on `NPC List` with one line per character (name, age/role, look, personality keywords, affiliation, relation), while each character's full sheet is its own keyword entry. The roster never copies whole sheets.
- The same split works for factions (overview → group list → unit detail), places (area map → place detail) and events (calendar/arc summary → event detail).
- The roster's core facts (role, look, affiliation) and the sheet are one canon: they must not disagree. If the roster reflects a reference date, say so and say where later changes are recorded.
- Some bots hide a roster line while that character's full sheet is active (a variable set by Lua when the name appears recently) so a character never appears twice. Optional.

Roster entry example (always-on, high band, empty key):

```
### Character List
Format: - Name (age/gender, role): look; personality keywords; affiliation; relation to {{user}}
#### Main
- Name A (24/F, archivist): short copper hair, round glasses; dry, curious, stubborn; City Archive; {{user}}'s neighbor
- Name B (31/M, courier): tall, scarred knuckles; cheerful, reckless; Night Couriers; owes {{user}} a favor
#### Supporting
- Name C (50s/F, landlady): ...
```

Organization chain example:

```
### Factions (always-on, high band)          → one line per faction: goal, territory, stance
### Faction X — Member Houses (always-on)     → one line per house
### House Y (keyed: House Y, Y family, ...)   → detail: leaders, resources, secrets
```

## 6. Positioned entries (@@)

- Important entries pinned with `@@position`, `@@depth` or `@@end` are placed at the end of the prompt or at a preset/global-note anchor, not in the ordinary order. **Preserve existing positioning** when you edit such an entry.
- Review them apart from the general order: what sits at depth 0, what sits at each `{{position::NAME}}` anchor, and whether each `pt_NAME` still has its anchor.
- Not every `@@` sets a position (`@@probability`, `@@activate`, `@@exclude_keys` do not). Check the meaning in 'RisuAI 로어북 구조'.
- Keep depth 0 for short per-turn directives (output contract, current-stage text, event rolls). Long knowledge at depth 0 dilutes them.

## 7. Keys

- Comma-separated. **Every alias a user or the model might write**: romanized full name, given name, surname, native-script forms, titles, nicknames, transformation or code names.
- Generic-noun entries get generous synonyms: `money, cash, price, wage, debt, bill`.
- Matching is substring by default: one-syllable or two-letter keys misfire. Use two or more characters or a distinctive word.
- **Always-on entries have empty keys.** Reserve always-on for rosters, core rules, current-state and stage tables, output contracts. Character sheets are keyed (they load when the name appears).
- A parent-group key on member entries (the group name on every member) loads all members when the group is mentioned. Use only when that is wanted.

## 8. Folders and dividers

- A folder is an entry too (`mode: "folder"`, no content). Members set `folder` to the folder entry's `key`.
- Typical folders: World, Main Characters, Supporting Characters, Antagonists, Places, Arcs & Events, System. Some bots add Custom (empty slots for the user) and Storage (inactive notes).
- Put new entries in the matching folder. If none fits, propose the folder first.
- Empty divider entries (`---- Section ----`) also appear in bots; they never fire. Prefer folders for new work, but keep an existing bot's convention.

## 9. Progressive reveal (spoiler stages)

- Facts revealed by progress are wrapped in **CBS conditions inside the body**, not decorators:
  `{{#when::{{getvar::bot_arc_stage}}::>=::2}} ... {{/when}}`
- A per-arc stage table (always-on, high band) lists what becomes knowable at each stage; secret sections in sheets are locked by the same variable.

```
### Reveal Layers: <arc name>
| Stage | May be revealed | Must not leak yet | Moves on when |
|---|---|---|---|
| 0 | the missing shipment exists | who ordered it | {{user}} finds the ledger |
| 1 | the order came from inside the company | the name | a named witness talks in a scene |
| 2 | the name | — | — |
Current stage: {{getvar::bot_arc_stage}}
```

In the sheet of the character who holds the secret:

```
#### Secrets
{{#when::{{getvar::bot_arc_stage}}::>=::2}}- She signed the order herself, to protect her brother.{{/when}}
```
- Revealed does not mean everyone knows. If a secret should spread only to some characters, say who knows.
- CBS comparison syntax is in 'RisuAI CBS 문법' (`::=::` is not a comparison).

## 10. Sim-bot vs solo-bot layouts

- **Sim bot** (many characters, the card is a narrator/GM): description = GM contract; lorebook = world, roster + keyword sheets, places, factions, events, system rules, state readouts; many folders and clear bands. See 'RisuAI 시뮬봇 구조와 제작'.
- **Solo bot** (one main character): the sheet is usually in the description (or in one always-on entry when the description holds only directives); the lorebook is small: side cast with their relation to the main character, stage texts, keyword modes, a realism module, persona guide, storage. See 'RisuAI 일인봇 구조와 제작'.

## 11. Do not

- Entries with only a name and no body; bodies that start with prose and no heading.
- Leaving priority unset (=100), or giving a different value than same-kind entries without a reason.
- Mixing several characters or subjects in one entry. One entry = one subject; lists go in a separate roster entry.
- Rewriting a whole entry to change one line. Use propose_lore_replace.
- SillyTavern decorator stacks, `[System: …]` prefixes, JSON blobs as bodies.
- Copying another bot's names, variables, tags or numeric bands into this bot.

## 12. Procedure for a new entry

1. `list_lore` to see folders and neighbors' insertorder and key style. Read one similar entry with `read_lore_entry` and match its form.
2. Decide its role (roster or detail), then `comment` (= body title), `key` (all aliases), `insertorder` (the neighbors' band), `folder`, `alwaysActive`.
3. Write the body with `###` / `####` / `[Section]` and bullets that fit the group/member hierarchy. Write only known facts; no empty subheadings. Check the whole structure with §13.
4. Propose with `propose_lore_add(comment, keys, content, reason, scope, always_active, insert_order, folder)` and say only that you proposed it. For a change use `propose_lore_edit` (whole entry fields) or `propose_lore_replace` (one passage).

## 13. Structure and order review (checklist)

1. **Related meanings in nearby bands**: characters, personal traits, world settings, world events, system rules each sit at the same or nearby priorities. Keep deliberate importance gaps; move entries that drifted away for no reason.
2. **Heading hierarchy**: judged on the text actually injected together, `###` / `####` / `[]` show group → entry → sub-section correctly. Folders do not inject headings. A roster being "the map" does not mean every detail entry should sit under its heading; each detail entry must stand on its own when activated alone.
3. **Whole order**: read the full sequence from lowest to highest priority, the roster/detail relationship, and the positioned entries' actual slots. Fix what is out of place.
4. **Cut tolerance**: if some entries are inactive or cut by the budget, the remaining text still states its subject and belongs clearly. A block partly cut by the budget is not in itself an error.
5. **Consistency**: rosters, sheets, greetings and initial variables agree (names, looks, relations, start date).
6. **Positioning**: every `pt_NAME` has an anchor; depth 0 holds only short per-turn directives.
