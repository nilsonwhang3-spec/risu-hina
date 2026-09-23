Read this only when a bot must be **verified against the actual RisuAI source**: a host behavior is in doubt, a bot feature misbehaves and the other skills do not explain why, a skill marks something "unverified" and the answer matters, or the user asks to check a bot (or a claim) against the latest RisuAI / PocketRisu. Do **not** use it for ordinary authoring: the other RisuAI skills were already checked against the source (RisuAI `669b12ce`, PocketRisu `a14c911f`, 2026-09-23); read them first.

Contents
1. When to use, when not
2. Fetch the source
3. Where answers live
4. Compare a bot with the source
5. Outdated patterns to look for first
6. Report
7. Rules

---

## 1. When to use, when not

Use it when at least one is true:
- The question is about **host behavior** (what a CBS tag returns, when a Lua hook runs, what a regex flag does, how lorebook budget works) and the skills say "unverified", disagree with the bot, or do not cover it.
- A bot works in one host and not the other (mainline RisuAI vs PocketRisu).
- The user asks to verify, audit or modernize a bot against the latest source, or suspects a recent RisuAI update changed something.
- A proposed fix depends on a detail you would otherwise be guessing.

Do not use it to: write routine lorebook, regex or Lua (use the skills); answer questions the skills already answer with source evidence; browse the source for curiosity. Each fetch downloads about 40 MB and takes about 10 s.

## 2. Fetch the source

The script is in this skill's `scripts/risu_sources.py`. In run_python:

```python
exec(open('skills/<slug>/scripts/risu_sources.py', encoding='utf-8').read())
fetch_sources('risuai')        # mainline: github.com/kwaroran/RisuAI
```
and, in a **separate** run_python call if needed (keeps each call well inside the timeout):
```python
exec(open('skills/<slug>/scripts/risu_sources.py', encoding='utf-8').read())
fetch_sources('pocketrisu')    # fork: github.com/PocketRisu/PocketRisu
```

- Files land in `hina/.sources/risuai/` and `hina/.sources/pocketrisu/` (the agent's hidden area, shared by all bots). Only `src/`, `docs/`, `README.md`, `plugins.md` and `package.json` are kept.
- `SOURCE.json` in each folder records the commit (`sha`) and fetch time. A copy whose commit matches upstream is reused, so calling `fetch_sources` again costs one small API request. `force=True` re-downloads. When GitHub cannot be reached, a copy younger than `max_age_hours` (24) is reused; otherwise the call fails. Say so and continue with the skills instead.
- Which host matters: most users run mainline RisuAI; some run PocketRisu or a self-hosted build. If the difference matters and the user has not said, ask or check both.

Searching and reading:
```python
grep_source('setdefaultvar', 'risuai')                          # substring, case-insensitive
grep_source(r"name:\s*'getvar'", 'risuai', regex=True)          # regex
grep_source('listenEdit', 'pocketrisu', glob='src/ts/process/*')
show_source('src/ts/cbs.ts', 810, 'risuai', before=5, after=40) # numbered lines
key_files('risuai')                                             # the map below, with a moved-file check
```
`read_file('hina/.sources/risuai/src/ts/process/scriptings.ts', offset=…)` also works (it pages by offset). `search_files` does not look inside `hina/.sources/` (hidden folder); use `grep_source`.

## 3. Where answers live

| Question | File (under `src/`) |
|---|---|
| CBS tag exists, aliases, arguments, return value | `ts/cbs.ts` (`registerFunction({ name, alias, callback })`) |
| Block syntax (`#when`, `#each`, `#func`, `#escape`), whitespace, `:else`, asset tags, setter permission | `ts/parser/parser.svelte.ts` |
| Unset variables, `defaultVariables` | `ts/parser/chatVar.svelte.ts` |
| `{{? }}` math operators and precedence | `ts/process/infunctions.ts` |
| Lua functions, access tiers, `listenEdit` arguments, engine cache | `ts/process/scriptings.ts` |
| Triggers: V1/V2 (legacy), `triggerlua`, modes | `ts/process/triggers.ts` |
| Order of a send: onStart, lorebook, editprocess, editRequest, onOutput, CBS variable pass | `ts/process/index.svelte.ts` (`sendChat`) |
| Regex types, flag metas (`<cbs>`, `<move_top>`, `<order>`), `ableFlag` | `ts/process/scripts.ts` |
| Lorebook matching, decorators, budget, placement | `ts/process/lorebook.svelte.ts` |
| Modules, module `lowLevelAccess`, module assets | `ts/process/modules.ts` |
| Built-in slash commands | `ts/process/command.ts` |
| `risu-trigger`, `risu-btn`, button clicks | `lib/ChatScreens/Chat.svelte` |
| Input box, `onInput`, `editInput` | `lib/ChatScreens/DefaultChatScreen.svelte` |
| Alerts | `ts/alert.ts` |
| Deprecation labels, setting names | `lang/en.ts` |

Paths move between versions: when `key_files` prints `MOVED?`, find the file with `grep_source` on a function or tag name. Tests under `ts/parser/tests/` and `*.test.ts` show intended behavior and are good evidence.

History of a behavior: this script fetches a snapshot, not git history. If the question is "when did this change", say the snapshot shows the current state only.

## 4. Compare a bot with the source

1. **Write down the question** in one line and the bot items involved. Read the bot first with the bot tools (`bot_structure`, `search_bot`, `read_lore`, `read_lore_entry`, `read_script`, `read_script_text`, `read_card_field`), not from memory.
2. **List the constructs** the bot uses in those items: CBS tags and blocks, Lua functions and hooks, regex types and flags, decorators, trigger kinds (Lua vs V1/V2).
3. **Check each construct** in the source: does it exist, what does it do in this context (lorebook, greeting, regex OUT, stored message, Lua `cbs()`), is it marked deprecated. Record `file:line` and the commit.
4. **Check both hosts** only when it matters (§2), and label differences "PocketRisu only" / "mainline only".
5. **Classify** each finding: *broken* (does not work now), *deprecated* (works, marked legacy), *risky* (works, but fragile: reroll, streaming, budget), *fine*.
6. **Propose fixes** with the normal proposal tools (`propose_lore_edit`, `propose_regex_edit`, `propose_script_text_replace`, …), smallest change first. Never rewrite a whole system to fix one construct. The user approves.

For large bots, do not check everything: start from the reported symptom and the patterns in §5.

## 5. Outdated patterns to look for first

Each was confirmed in the source on 2026-09-23. Re-check in the current snapshot if the commit has moved.

| Pattern in a bot | What the source says | Fix |
|---|---|---|
| `{{setvar}}` / `{{addvar}}` / `{{setdefaultvar}}` in lorebook, description, global note, greeting, background HTML, editdisplay OUT, Lua `cbs()` | Setters run only in the variable pass over stored messages; elsewhere they stay literal text and reach the model | `defaultVariables`, or Lua `setChatVar` |
| `#func` body reading `{{arg::0}}` | `arg::0` is the function name; the first argument is `arg::1` | Renumber |
| `{{#if …}}`, `#if_pure`, `#pure` | Deprecated blocks, still parsed; `#when` is current. `#when` parses both branches | `{{#when::…}}`, keeping side effects out of false branches |
| `{{:else}}` inline inside a multi-line block | Prints literally / false branch empty | Put `{{:else}}` on its own line |
| Numeric `#when` on a possibly unset variable | Unset reads `"null"`; every numeric comparison is false | Give a default |
| `{{// note}}` comments | No handler in current CBS; printed as text | `{{blank::note}}` or remove |
| V1 or V2 (block) triggers | Deprecated (V1 warned in the editor; V2 deprecated effects hidden behind `showDeprecatedTriggerV2`) | Port to Lua ('RisuAI Lua 트리거' §0) |
| `stopChat` / `return false` in onInput, onOutput, buttons, edit hooks | Only honored in `onStart` | Move the stop to `onStart` |
| `async` listenEdit callback | Callback already runs in a coroutine; an async one returns a Promise and breaks the chain | Plain function |
| Stat deltas in editoutput or onOutput with no snapshot | No rollback of chat vars on reroll, edit or delete; editOutput also re-runs per streamed chunk | Snapshot keyed to the message ('RisuAI Lua 트리거' advanced part) |
| Regex flag metas (`<cbs>`, `<move_top>`, `<order N>`) with `ableFlag: false` | Flags are read only when `ableFlag` is on | Enable `ableFlag` |
| `{{button}}` stored in a variable and printed with `{{getvar}}` | Tag results are not re-parsed in the same pass | Store rendered HTML (`risu-trigger` / `risu-btn` attributes) |
| Alerts in `editDisplay` | Not allowed there | Move to a button or onOutput |
| `@@move_top` in a lorebook entry | It is a regex output prefix, not a lorebook decorator | Use it in a regex OUT |
| `@@@end` | Old form; migrated to `@@depth 0` | `@@depth 0` |

## 6. Report

Answer in the user's language. For each finding: the bot item (name/id and the exact text), the classification, the source evidence (`src/…:line`, repo, commit short sha), and the proposed fix. Close with the commit(s) checked and anything left unverified. Example line:

`[broken] Lorebook "Stage table" uses {{arg::0}} as the score - RisuAI 669b12ce src/ts/parser/parser.svelte.ts:1780 (argData[0] is the function name) - propose arg::1.`

If a finding contradicts one of the RisuAI skills, say which skill and section, so the skill can be corrected (`improve_skill` when the user agrees).

## 7. Rules

- Source is evidence; memory and old bots are not. Quote what you saw, with its line.
- Mainline RisuAI is the reference unless the user runs PocketRisu; label fork-only behavior.
- Never modify the fetched sources and never run them. They are for reading.
- Do not paste large source blocks into the chat; quote the few lines that decide the question.
- If the fetch fails (offline, rate limit), say so and fall back to the skills, marking the answer "not re-verified".
