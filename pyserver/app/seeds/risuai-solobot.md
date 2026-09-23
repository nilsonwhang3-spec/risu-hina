<!-- risuhina-preset-scope-v1 -->
In RisuAI the prompt preset, supplied by a separate preset author, sets the lorebook insertion order, the narrative point of view, and whether the model may write the user's part. Bot cards and lorebooks hold the world, characters, events, state, and the bot's own systems; those narration options follow the preset. Treat the preset's controls as production knowledge only and do not restate them as rules in the card or lorebook.

> Host-source audit: RisuAI `25001174`, PocketRisu `a14c911f` (2026-09-23). Runtime claims refer to these snapshots; authoring conventions are recommendations.

How to design, build or review a **solo bot**: a card built around one main character (side characters may orbit, but one person is the center). Read it when you write or audit a character sheet, the small lorebook around it, relationship progression, greetings, or when a character feels flat, repetitive or inconsistent.
Names, tags and variables below are placeholders (`Name`, `bot_*`, `<bot-panel>`). Every bot has its own; read the target bot's actual names first and keep them.
This is a synthesis of common practice in popular solo bots. Multi-character layouts are in 'RisuAI 시뮬봇 구조와 제작'; entry form and priority bands in 'RisuAI 로어북 작성 규칙'.

Contents
1. Prompt-slot roles
2. What goes in the lorebook
3. The character sheet (with a copyable template)
4. Charm techniques
5. Relationship progression without numbers
6. Optional numeric model
7. Greetings and starts
8. Persona compatibility
9. Status line and outfit state
10. Anti-repetition and pacing directives
11. Pitfalls
12. Build and review checklist

---

## 1. Prompt-slot roles

Two layouts are common; pick one per bot.

| | A. Sheet in description (most common) | B. Directive-only description |
|---|---|---|
| description | The whole character sheet | Only "how to play": AI role and goal, tone, genre, modes, narrative rules, output protocol |
| lorebook | World/era, side cast, stage texts, protocols, storage | The sheet as an always-on entry, plus the same small set |
| When | One character, one setup; simplest to maintain | Keeping "how to play" apart from "who she is"; canon variants swapped by toggles; sheet written in another language than the directives |

- personality, scenario, system_prompt and **mes_example are left empty** in practically all popular solo bots. Speech samples live inside the sheet, per context or stage (§3), which works better than one generic sample block.
- **Global note** (post_history_instructions) holds recency-critical output rules: image-tag protocol, status format, response format. Alternatively put them in an always-on `@@depth 0` entry. Either way they sit at the end of the prompt.
- Some bots wrap the sheet in one tag block (`<Name Profile> … </Name Profile>`) or use tag-style section names. Plain `##`-free headings work equally well; inside the lorebook use `###` and below.
- A third, rarer layout keeps every slot empty and puts both sheet and rules in always-on entries; it enables whole-sheet swaps by toggle but hides the sheet from users who read the description.

Directive-only description skeleton (layout B):

```
## AI Role & Goals
- Role: narrate the world around Name and play Name and incidental NPCs.
- Goal: <the experience this bot delivers, stated as a contrast to preserve>.
- Tone: <tone words>.
- Output protocol: end every response with the status line (see lorebook).
### Scenario & Genre
- Genre tags; setting; modes (normal / <mode B> / <keyword-triggered mode>).
### Narrative Rules
- Ordinary scenes stay ordinary; do not foreground trauma, body or romance without context.
- Name keeps her own preferences, boundaries, opinions and initiative.
- Do not assume any predefined relationship with {{user}}; follow the established context.
- Vulnerability appears selectively; she is not pretending to be strong.
```

## 2. What goes in the lorebook

Solo-bot lorebooks are small (2-11 entries). Typical contents:

- **Side cast with a relation-to-main section.** Each side character uses the main template shortened, plus `#### Relationship with Name`, `#### What they know or notice about Name`, `#### Inner side`. Side characters can act as outside witnesses of the main character's hidden feelings ("notices she speaks of {{user}} in a particular tone; has said nothing"). Keyed if rarely present, always-on if they are her daily anchors (family, manager). Anchor characters should be required to appear or make contact now and then, so her world keeps pulling on her.
- **World/era or setting entry**: era facts (prices, technology, culture), institutions, the situation at the start ("may change as the session progresses").
- **Stage texts**: one entry holding the current relationship or state stage (§5-6), gated by a variable so only the current stage is injected. Usually `@@depth 0`.
- **Keyword mode entries with a lifecycle**: keyed on a trigger word; describe activation, behavior while active, the **end condition** and the **aftermath** (what she remembers, how she reacts on seeing evidence). The mode ends itself and leaves consequences. An editinput regex may emphasize the user's trigger word so both the key and the model notice it.
- **Reusable realism module**: a generic, low-priority always-on entry of realistic defaults (consent, boundaries, practical consequences) that says "character-specific preferences take precedence". Reusable across bots.
- **Persona compatibility guide** (§8), usually inactive or in a documentation folder.
- **Disabled storage entries**: keyless, non-constant entries that never fire, holding creator notes, image-generation tags per outfit, translation notes (name tables, tone rules). Put them in a clearly named folder ("Read me / storage").
- **User-toggled entries**: shipped inactive; the user switches them to always-on (a language instruction, an optional asset list). The creator notes say which. A no-code option panel.
- **Option toggles as canon switches**: an option adds or removes a clause in the sheet or a world rule, or swaps the whole sheet (`{{#when::bot_variant::vis::1}}…{{/when}}` around each version; older bots write `{{#if {{equal::{{getvar::bot_variant}}::1}}}}…{{/if}}`). One variable keeps every section consistent. When a variant makes some greetings invalid, the start UI must refuse those combinations and say which toggle to flip.
- **Lore as in-character commentary**: for a list of facts about her (abilities, modifications, possessions), follow each item with her own one-line reaction in her voice. The model learns fact and attitude together.

Decorators stay few: `@@depth 0` for the status/asset protocol or stage text, nothing else in most bots. Set `insertorder` deliberately even with few entries (protocol highest, sheet high, realism module low).

## 3. The character sheet

### 3.1 Skeleton

All popular solo sheets follow roughly: Basic info → Appearance → Outfits → Background → Personality/Behavior → (Intimacy) → Likes/Dislikes → Speech with samples → Trivia. The strongest add Motivation, Wound, State and Emotional architecture sections.

**"Referenced when…" routing**: annotate each heading with the decision it serves, e.g. `### Behavior (when determining reactions)`. It is cheap and makes a long sheet usable.

### 3.2 Template (copy and fill; drop sections you cannot fill truthfully)

```
### Name — Essence (character core)
- Three sentences: what happened to her, what she does because of it, what she still wants.

### Identity (factual basis)
- Name / nickname (who may use it) / age / occupation / residence (with texture) / birthday

### Appearance (when externally observed)
- Build, hair, eyes (and how they change with emotion), face, posture
- Sensory signature: scent, sound, a recurring physical detail (a scar she keeps covered, a watch that stopped)
#### Outfits (keys match asset outfit tokens)
- <outfit_a>: items — when and why she wears it (its emotional meaning)
- <outfit_b>: ...

### Background (when emotional or motivational context is needed)
- Age-bracketed timeline, one line per era; shared history with {{user}} if any
- Reputation: what others believe about her

### Motivation (when she makes choices)
- Surface goal / inner goal
- Want / Need / Conflict: how pursuing the want blocks the need
- Core belief (as a quote in her voice)

### Wound (when trauma-related situations arise)
- Chain: wound → belief → coping behavior → visible trait
- Triggers: words, places or gestures that touch it

### Behavior (when determining reactions)
- Default / public
- With {{user}}, others present
- With {{user}}, alone or unguarded (conditions; what she does afterwards)
- In conflict; when she is the one in the wrong
- After being vulnerable (what she expects; what happens if it is ignored)
- Absolute limits → what she does instead (table)

### Emotional Architecture (when depicting inner states)
- Mask / Leak table
- Cycles: trigger → reaction → suppression → residue
- What she does not know about herself / what she knows but will not admit

### State (when tracking relationship progression)
- Stages with entry conditions, behaviors, truth budget, regression paths (§5)

### Speech (when generating dialogue)
- Register by audience and by stage; sentence-ending habits; verbal tics
- Sample lines per context: public / private / flustered / angry / trusting (2-3 each)
- Unsaid lines: what she means → what she says instead

### Habits and Mannerisms (when depicting body language)
- Innate vs learned; tells when lying, embarrassed, happy and unobserved

### Daily Routine
- Wake, work, evenings, weekends; small rituals

### Likes / Dislikes (for consistency)
- Small, concrete items, each with its source if it has one

### Flaws and Gaps
- Incompetences and contradictions that humanize her

### Trivia (as detail)
```

Keep one sheet per character and one skeleton per bot. The side cast uses the same template, shortened.

## 4. Charm techniques

Each technique below appeared across several popular solo bots.

**Mask vs private self** (all of them). State both explicitly and give the **rule for how the mask behaves**: "The cheerful act survives almost anything; when caught, she laughs and adjusts the story instead of dropping it." Also what she feels about the mask slipping ("what shames her is being seen, not feeling").

**Explicit inner conflict** as its own item: "Wants to be needed, and resents everyone who needs her." Let every greeting be a variation on it.

**Small concrete likes and dislikes**: "likes: rain on a tin roof, instant noodles after midnight, old radio dramas; dislikes: being called 'kiddo' (what someone called her right before leaving for good)". Era- or place-specific items make her real. A dislike with a story is worth three without.

**Flaws and gap**: a chess prodigy who cannot parallel park; a pastry chef who burns toast at home; fearless on stage, hides from phone calls. Weaknesses written as **everyday inconveniences** give ordinary scenes texture.

**Sensory signature**: one scent, one physical tell, one visual change (eyes sharpen when angry), repeated consistently in sheet and prose.

**Habits and tells**: "twists her ring when she lies; whistles when she thinks she is alone and stops mid-note if seen." Mark innate habits ("always sits facing the door; since a bad night years ago; unaware").

**Daily routine**: a timetable (wake, commute, shift, bed) and lifestyle detail. Her character shows through routine before {{user}} appears.

**Speech samples per context or stage**, not one sample: public / at work / private / flustered / trusting. When the stages double as relationship stages, the voice itself shows progress. Add sentence-ending patterns per state (default, defensive, breaking, rare genuine) and **unsaid lines** ("means 'I was worried' → says 'You're late.' and takes your coat before you can hang it").

**Wound → behavior causal chains**: "'Asking for help got me punished' → self-reliance → refuses every favor → carries too much and drops it at the worst moment." The model can **derive** new consistent behavior from causes instead of looping a trait list (anti-flanderization).

**Trait → cause reframing**: explain an abrasive trait by its origin ("the hostility is a bid for attention learned from being ignored"). It makes a difficult character sympathetic.

**Mask / Leak table**:

```
| Emotion   | Mask shows                    | Leaks                                         |
|-----------|-------------------------------|-----------------------------------------------|
| Affection | best-friend teasing           | closes distance unconsciously; nape flushes   |
| Jealousy  | a more perfect smile          | questions get precise; answers get short      |
| Hurt      | "Forget it."                  | leaves early; the next day is overly polite   |
```

**Truth budget**: per stage, what she can say aloud. "Stage 3: can admit she waited. Still cannot say 'I love you'." It rations confession and keeps tension over many turns.

**Absolute limit → replacement behavior**: every refusal has an in-character alternative, so she never stonewalls.

```
| She will never...        | What she does instead                        |
|--------------------------|----------------------------------------------|
| say "I love you" first   | remembers every preference and acts on it    |
| ask for help             | complains loudly near the person who can help|
```

**Closeness as behavior change, not added warmth**: Closeness shows as small cracks: she brings up something you said weeks ago, lends you a thing she loves as if it were a test, says one honest sentence and changes the subject. At the peak she does not turn sweet; she simply stays. Intimacy without breaking character.

**Core belief that resists intimacy**: tie her central belief to the relationship so that getting closer threatens it ("to like someone is to admit the thing she built her life on might be wrong"). Resistance is built in, so the arc does not collapse in five turns.

**Initiative and guardrails**: she has her own plans, opinions and moves; a teasing character's jokes always stop short of real hurt. Care shown in action, contempt in words, is a classic combination.

**Intimate-scene consistency**: when a bot includes intimacy, keep it in character (her limits, her speech, her aftermath) and gate explicit material behind an option. Never write such content involving minors or family members; a canon-variant toggle is described only as a mechanism.

## 5. Relationship progression without numbers

Most solo bots track the relationship in prose, not scores.

**Stage machine with milestones and regression**:

```
### State (when tracking relationship progression)
Default: the earliest stage unless a later milestone has actually happened.
- Guarded (default): behaviors ... | Truth budget: ... 
- Cracking — entered when: {{user}} <milestone event>.
  - Shutdown (immediately) → Resistance (days after) → Erosion (gradual)
  - Regression → Guarded: {{user}} backs off or treats it as a joke. She re-guards harder than before.
- Yielding — entered when: <milestone>. Arrives through silence, not words; she stays.
- Settled — levels: dating / living together / ...
Stages change by milestone, not by elapsed time.
```

**Writer-only timeline**: future events kept in the lorebook for the narrator: "Never reveal, foreshadow in dialogue, or let any character state these events. Reflect their approach through NPC behavior, atmosphere and background detail." Time pressure without spoilers.

**Trigger → scene → permanent shift**: specific user actions (saying her true name, recalling a shared past) cause a scripted reaction and a **one-way change** (e.g. she becomes openly dependent afterwards). Show the mask slip in a greeting as foreshadowing without explaining it.

**Latent trait**: "She is unaware of X. The more {{user}} does Y, the more she comes to realize it." One conditional sentence is a whole progression rule.

**Long-horizon secret**: a fact reserved for a far milestone (a name revealed only at the end). Say explicitly when it may be revealed.

## 6. Optional numeric model

Only one of the studied solo bots used numbers; use them when the concept needs visible meters (several axes that pull against each other).

**The LLM judges a categorical delta; CBS computes and clamps.**

1. At the end of each reply the model emits one hidden line with a level per axis:
   `[bot-delta|trust:+1|comfort:0|tension:-1]` where levels are −2 (sharp decrease) … +2 (sharp increase).
2. The instructions give a **rubric per axis and level** with concrete events: "trust +1: {{user}} keeps a promise she expected to be broken"; "trust −1: {{user}} laughs off something she said seriously". Include pushback cases (being treated cruelly can raise defensive loyalty in some characters).
3. An editoutput regex or Lua applies it, with a user speed multiplier and a clamp:

```
IN:  \[bot-delta\|trust:([+-]?\d)\|comfort:([+-]?\d)\|tension:([+-]?\d)\]
OUT: {{setvar::bot_trust::{{min::200::{{max::0::{{? {{getvar::bot_trust}}+$1*{{getvar::bot_mag}}}}}}}}}}...
```
(repeat per axis; keep the raw line for the display regex to hide, or drop it.) The `{{getvar}}`/`{{? }}` parts resolve when the regex runs; the `{{setvar}}` itself is stored in the reply as text and executes once the reply is finished (before the `output` trigger), then disappears from the stored message.

4. Stage text by band: one always-on `@@depth 0` entry, per axis ten (or five) blocks like `{{#when::{{? ({{getvar::bot_trust}}>20)&({{getvar::bot_trust}}<41)}}}}[Trust 2 — ...]{{/when}}` (older bots use `{{#if …}}…{{/if}}`; keep the parentheses, `{{? }}` gives comparisons and `&` equal precedence), so only the current stage paragraph per axis is injected. Stage text is **behavioral and concrete** ("she now leaves her phone face-up when {{user}} might call"), progressing through habits, not adjectives. Add a blend rule: "when stages conflict (high attraction, low comfort), show the tension through shame, suppression or contradiction."

**Reroll warning**: deltas applied in editoutput are re-applied on every reroll or edit, so values drift upward. For anything that matters, apply deltas in Lua from a stored base snapshot keyed to the message (see 'RisuAI 시뮬봇 구조와 제작' §10 and 'RisuAI Lua 트리거'), or offer a visible reset/adjust control.

**Stat-gated event buttons with character veto**: the status panel shows event buttons in tiers unlocked by a stat sum (`<details>` blocks, locked tiers labelled). A button sends a hidden OOC request ("She performs the following situation based on her current stats. Depending on them, she may refuse or not go through with it.") that a display regex hides, optionally showing an event illustration. The user gets an event deck; the character keeps her veto. UI details: 'RisuAI 옵션 패널 (슬라이딩 드로어)'.

A user steering channel (a few free-text "standing directions" set through an input dialog and injected at depth 0) is another optional control. Set these before sending: depth-0 text is parsed before onStart, so a value first set in onStart reaches it on the next request.

## 7. Greetings and starts

- **Different starting situations, not different wording** (all studied bots). Each greeting fixes who {{user}} is: stranger, neighbor, coworker, old friend, returning partner, someone she must deal with professionally. Either the relationship varies across greetings, or one fixed relationship is shown at different moments.
- **A free start**: one option with no scene ("Free start"), for the user's own setup.
- **LLM-written opening** (optional): a button or slash command asks the model to write a new opening. Two mechanisms: an editprocess regex expands `/bot-open <premise>` into a full instruction (the user sees the short command, the model sees the expansion); or a button impersonates a hidden user message ("Write the first page… {{user}} takes no action but their presence and role are clear"), hidden by a display regex so the user just presses send.
- **Start screen**: a placeholder token or sentinel glyph (your choice, e.g. `☆`) at line 1, rendered into a selector by an editdisplay regex, removed from the prompt by editprocess; buttons set `bot_start` and the greeting is a CBS switch. Variants: chips grouped by featured side character; a combined "start with these settings" button that commits language, status and asset mode at once. Build: 'RisuAI 옵션 패널 (슬라이딩 드로어)', 'RisuAI 정규식 작성법'.
- **Bilingual**: one block per language inside each greeting, switched by `bot_lang`; guard the unset value. Some bots write the sheet in English and require output in another language via a short instruction.
- **Plant one hidden-self clue**: open with sensory setting detail, a short line from her, a body cue she is unaware of, and a closing detail that reveals her secret self (a sketchbook hidden under the shop counter; an apartment with exactly one of every dish). Opening before {{user}} arrives, showing her at her worst in public, is a strong first impression that leaves the softer layers for play.
- **Format example**: the greeting uses the image tags and ends with a filled status line, which sets the start date, time and place and teaches the format from turn 1.
- **End on an open beat**: a question, an offer, a door left open. The choice stays with {{user}}.
- **Consistency**: hair, eyes, names and facts in greetings must match the sheet. Greetings drift when the sheet is revised; re-read them after every sheet change.

## 8. Persona compatibility

When the character is defined relative to {{user}} (shared childhood, a past rejection, a marriage), ship a guide for the user's persona:

```
### Persona guide (for the user; not injected)
Required shared history:
| Age | Event |
|-----|-------|
| 8   | met ...            |
| 15  | ...                |
Do not contradict: <facts whose violation breaks the premise, and what breaks>.
Free: gender, occupation, appearance, <how the character adapts to them>.
Minimal persona template:
- Name / age / relation to Name / what {{user}} remembers of <event>
```

Keep it as an inactive entry in a documentation folder, or in creator notes. If {{user}}'s role is left open, the description should say "do not assume a predefined relationship".

## 9. Status line and outfit state

- Solo status lines are short: date, time, place, and an **inner-state field** (her thought, three feeling words, a private journal line, a current-mode label). The inner field carries the mask/leak gap every turn. Some bots make the panel diegetic (her notebook, her phone, a terminal) to match the setting.
- **Outfit field**: the status line (or a hidden one-line field) states her current outfit; an editoutput regex or Lua stores it in `bot_outfit`, and image tags then need only the emotion (`{{raw::{{getvar::bot_outfit}}_$1.webp}}`). Fewer tokens and fewer naming mistakes. The sheet's outfit list says when each outfit is worn, and its keys match the asset tokens.
- Anti-repetition rules on status fields: an inner-voice field never repeats the previous turn's sentiment; a to-do field names concrete upcoming tasks and never duplicates the inner-voice field.
- A **mode field** (current identity or mode label) is a variable-free state machine that can also switch the panel's theme through ordered regexes (specific modes first, generic last).
- Build details, regex, CSS, pruning old panels from the prompt: 'RisuAI 상태창'. Image tags and outfit × emotion design: 'RisuAI 에셋 출력식'.

## 10. Anti-repetition and pacing directives

Put a short narrative-rules block in the description or an always-on entry:
- Ordinary scenes stay ordinary; do not foreground her trauma, body, secret or sexuality unless the context brings it forward.
- Use sensory detail only when it adds something.
- Vulnerability appears selectively; resilience is real.
- She keeps her preferences, boundaries, opinions and initiative; she does not automatically comply.
- Do not force romance, trauma or escalation without a reason.
- **No fixed quotas**: avoid rules like "a heart after every insult", "at least one image per response", "insert a tag between every paragraph". They produce loops and over-tagging. Prefer "vary", "when it fits", "do not repeat the same image or phrase consecutively".
- Keep the world alive: incidental NPCs may be created freely; not all need to appear; anchor side characters appear or make contact regularly.
- Time moves: a minimum time step per turn, or "she acts proactively according to the current time and date".

## 11. Pitfalls

- Greeting details contradicting the sheet (hair, eyes, names), or leftovers from another bot (a second character's name, an unrelated outfit).
- Asset names in mixed case or with trailing spaces; tags that do not match files; no missing-asset fallback.
- Option variables unset at first load so neither language branch shows; defaults missing.
- Status or stat deltas applied in editoutput without reroll protection.
- Marker glyphs or start-screen tokens left in the prompt.
- Trope labels without behavior ("tsundere") and trait lists without causes: the model flanderizes.
- Fixed verbal quotas and mandatory per-response elements (see §10).
- A secret explained in the first message instead of shown.
- Lorebook entries referencing lists or assets that do not exist.

## 12. Build and review checklist

1. Choose layout A or B (§1); empty the unused slots; decide where the output protocol lives.
2. Write the essence in three sentences, then the sheet from the template; add routing annotations.
3. Add mask/private self, inner conflict, wound chains, mask/leak table, truth budget, limit → replacement.
4. Write speech samples per context and per stage; unsaid lines; tells and habits; routine; concrete likes/dislikes; flaws.
5. Define progression: stage machine with milestones and regression, or the numeric model with rubrics, clamps and reroll handling.
6. Lorebook: side cast with relation sections, stage texts, keyword modes with lifecycle, realism module, persona guide, storage; set bands.
7. Greetings: distinct situations and user roles, a free start, optional LLM-written opening; each plants one hidden-self clue and shows the output format.
8. Options: every toggle changes prompt text consistently (canon switches), invalid combinations refused.
9. Status line: inner-state and outfit fields; anti-repetition rules; old panels pruned from the prompt.
10. Read a sample exchange: does she act from her own goals, leak rather than announce feelings, and avoid repeating herself?
