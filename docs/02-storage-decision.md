# 02. Storage decision — DB as the source of truth, workspace per character

2026-08-23. This overturns plan §4 (file-based workspace). Decided before putting the Phase 2 UI on top.

## What prompted it

It was confirmed that the target jobs are not just small edits to a single chat.

- **Small** — fix one turn and write it back
- **Medium** — **edits spanning many turns** (bulk replacement across 100~300 turns within one chat, etc.). This is the core of the medium case.
  Consistency across several chats of one bot is in practice a rare scenario (user correction, 2026-08-23)
- **Large** — **summarise earlier turns into a lorebook** and **cut those turns out** ("summary chat relocation")

**Only one** of these three worked under the existing structure.

## Audit results — 3 holes

| # | Problem | Cause |
|---|---|---|
| 1 | Cross-chat work is impossible | The workspace is per `chat_key`, so each chat is an island. **The host's unit of storage is the character**, and the structure was misaligned with it |
| 2 | There is no lorebook write path | `lore.json` exists for reference only |
| 3 | Structural edits do not make it back | `patch()` only computes `removed[]`, and the write path applies body edits only |

## Host constraint, re-confirmed (`globalApi.svelte.ts:360-366`)

The autosave `$effect` snapshots the selected character's **entire `chats` array** and **every key other than `chats`**. Therefore

- editing **multiple chats** within one character at once → saved ✓
- writing `globalLore` → saved ✓ (turning things into a lorebook works)
- editing across characters → still not possible ✗

**So the workspace unit has to be the character.** That is when the shape of the job matches the host's unit of storage.

## Decision — the DB is the source of truth for turns

**The turns table (ordered by seq) is the source of truth. Markdown is a derived artefact.**

Three reasons:

1. **The target jobs are query-shaped.** "Every turn mentioning X across this bot's 4 chats" is one line of SQL; grepping several 4 MB md files is painful. FTS5 is in the stdlib.
2. **Structural edits are row operations.** Deleting, merging, splitting and reordering turns 1~200 is self-evident with a `seq` column, and doing it by surgery on a 4 MB string is where **silent corruption** lives. All the more so because an LLM uses that string too.
3. **It is actually easier for the agent's Python to use the DB.** `sqlite3` is stdlib and `run_python` is unrestricted. Common manipulations get wrapped in helpers and queries are left to raw SQL.

### We do not keep two sources of truth

Sync ambiguity ("which side is right now?") is the worst outcome. **It is nailed down one-directionally:**

- `working/messages.md` — **removed.** The DB owns turns.
- `original/<chat_key>.md` — a frozen snapshot. Not regenerated (that is the original, after all).
- `out/*.md` — generated from the DB when needed.

`chatfmt.py` did not die; it became a **boundary codec** — chat JSON → into the DB, DB → out to md/risuChat.

### There is not a second source of truth, but there are two originals (0.9)

The DB being the source of truth is a statement about *our side*. RisuAI holds the same material and the user
edits over there too — continuing the chat further, or touching up the lorebook by hand. So reopening is
not "read it again" but a **merge**: the decision is made across three values — `turns_original` (the previous baseline),
this upload (RisuAI's current state), and `turns` (the working copy). The rules and their reasons are in
the `docs/04` A.5 supplement and the header of `pyserver/app/merge.py`.

Two things follow from this:

- **The baseline must be read before it is overwritten.** The old baseline is the common ancestor, and the only
  place recording it is that table. That is why the merge runs inside a single `db.transaction()` block —
  if it is interrupted midway, the ancestor is lost.
- **Row identifiers are needed.** Turns are already targeted by `msg_id` (rule above). Lorebook entries, greetings,
  scripts and summaries have nothing like it, so they are matched in the order content match → natural key (title, regex,
  things like `chatMemos`) → position, and **anything matched by position alone is never auto-accepted.**
The existing 40-odd checks remain valid as they are.

## Resulting structure

```
data/risuhina.db
  characters(char_key, cha_id, name, char_index, card_json)
  chats(chat_key, char_key, chat_id, chat_index, meta_json, orig_count)
  turns(chat_key, seq, msg_id, role, body, time, name, extras_json, origin)   ← source of truth
  turns_original(chat_key, seq, msg_id, ...)                                  ← frozen
  lore_entries(char_key, scope, chat_key, seq, entry_json, origin)
  turns_fts (external content, trigram, 3 INSERT/UPDATE/DELETE triggers)
  + sessions / agent_messages / staged_edits / checkpoints / cost_ledger / jobs

data/workspace/<char_key>/
  card.md  lore.json
  original/<chat_key>.md  original/<chat_key>.hypa.json
  scripts/  out/
```

### 4 design rules

1. **Turns are targeted by `msg_id` (= `Message.chatId`). Not by position.**
   `seq` is renumbered on every insert and delete, and if the user edits in RisuAI the host-side array shifts too.
   `msg_id` survives both, and it is also the key the hypa `chatMemos` joins on.
2. **`seq` is a dense integer + renumbering.** Fractional indices lose precision if you subdivide far enough. Renumbering a few hundred rows is free.
   (Watch out for having to go around twice, through a negative range, because of the unique index — pushing everything at once collides midway.)
3. **A merge preserves the identity of the first turn.** Issuing a new id orphans every hypa summary that cited that turn along with our patch targeting —
   it becomes a far larger edit than the user asked for.
4. **When the structure changes, the patch carries the whole array.** Per-turn patches cannot express deletion, insertion or reordering.
   The client branches on the `structural` flag; it does not guess from whether the list is empty.

## Side effect — hypa orphan warning

Cutting turns orphans the `hypaV3Data.summaries[].chatMemos` that cited them.
**Since that job is the very reason this feature exists**, it cannot be passed over silently.
`store.patch()` counts the orphans on a structural change and raises it as a warning.

## FTS trap (already solved in active-recall)

trigram **cannot, in principle, catch queries shorter than 3 characters.** But Korean narrative vocabulary is often 2 syllables
(몰수, 포상, 약속, 폐허 — confiscation, reward, promise, ruins). `store.search()` branches **per term** — 3 characters or more goes to FTS, shorter goes to LIKE.
The `폐허` case is pinned in the tests.

Also, turns has UPDATE/DELETE, so the external-content index needs **all three triggers**.
In active-recall, blobs were insert-only so a single AFTER INSERT was enough; not here.

## Cost

Rewrite of `workspace.py`, route expansion in `main.py` (12 → 21), test updates. Gate ALL GREEN.
Being before the UI went on top, this was the cheapest possible moment.
