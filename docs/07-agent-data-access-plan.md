# 07. The agent's data access — current structure, issues, planning for the next session

Written 2026-08-27 in the morning, right after the v0.6.2 release. User instruction: **do not simply fix it; plan it in the next session and fix it then.**
This document is the input to that planning — how it stands now, what the problems are, and what the options are.

## 1. How it started (what v0.6.2 exposed)

1. The agent answered that "there are only 18 lorebook entries". The cause was that the `list_lore` tool attaches 1500 characters of body per entry and got cut off at 25000 characters
   **with no indication whatsoever**. (In 0.6.2: a full index with no bodies + an explicit "이하 N개 생략" ("N further entries omitted") on truncation + `read_lore_entry(id)`.)
2. At that moment the agent **could have read everything with a script.** The sandbox already has a SQLite copy holding only this bot's rows (`.scratch/scope.db`) and
   the helpers `risuhina.lore()` / `risuhina.conn()` (read-only SQL), and this is written in the instructions (`pyexec.describe_helper`) as well.
   Not using them was a judgement problem on the agent's part. Still, the tool never said there was more, so there was no reason to try.
   → Rule: **truncation of tool output must always be stated.** (Reflected in 0.6.2. Other tools need checking too — §4.)
3. User's suggestion: "Can't we just open up the DB appropriately? There seem to be a lot of cases like this" → "Versioning looks like it will become a problem, but can't permissions solve it?
   Settings, API keys and so on inaccessible at the source, all writes only after approval — with rules like that."

## 2. The current structure (docs/04 §sandbox, `pyserver/app/sandbox.py`, `pyexec.py`)

| Layer | What | Where |
|---|---|---|
| Isolation | `sys.addaudithook` bootstrap: **writes outside the workspace denied**, reads limited to the workspace + the interpreter installation, process creation denied | `sandbox.BOOTSTRAP` |
| Data | Right before execution the parent copies **only this bot's rows** into `.scratch/scope.db` (`SCOPE_TABLES` = characters, chats, turns, turns_original, lore_entries, card_fields, card_scripts, char_assets). Reused if the stamp (the updated_at values and the script count) is unchanged | `pyexec.build_scope_db` |
| Helpers | `risuhina.turns/turn/search/chats/lore/card/conn/stage/stage_many/scratch/out/uploads` | `sandbox.HELPER` |
| Writes | The script only records **proposals** into JSONL via `stage()`; the parent collects them and checks them against the real DB → pending approval | `pyexec.harvest`, `staging` |
| Tools | `list_lore`, `read_lore_entry`, `read_turns`… read the real DB in the parent process (truncation rules handled separately) | `agent.py` |

The original DB (`data/risuhina.db`) holds **every bot's chats, lore and workspace metadata**, plus `api_keys` (key plaintext), settings references and token
derivatives. This is why the sandbox cannot open the original.

## 3. Issues

### 3-1. Versioning (snapshot freshness)
- `scope.db` is a **copy**. The stamp only looks at `MAX(updated_at)` over `characters.updated_at`, `chats`, `turns` and `card_fields`,
  and at the **row count** of `card_scripts`. The following are not caught by the stamp (potentially stale):
  - modifications to `lore_entries` (its updated_at is not in the stamp) — a lorebook edit just approved may not be visible to the script.
  - modifications to the **content** of `card_scripts` (row count unchanged).
  - `char_assets`, memory (the `memory` table is not in SCOPE_TABLES).
- Within a single turn, this ordering is possible: propose via a tool → approve (apply) → a script in the same turn reads the old snapshot.
- Copy cost: a large bot (dozens of chats, tens of thousands of turns) means copying hundreds of KB to MB every time. Currently mostly avoided by the stamp.

### 3-2. The permission model has two branches
- Tools (parent process) read the real DB and put things in the approval queue via `propose_*`.
- Scripts read the copy and put things in the approval queue via `stage()`.
- The same "read = this bot only, write = after approval" rule is scattered across **two implementations** (per-tool WHERE clauses vs. the SELECT at copy time).
  Every time new data is added (memory, asset metadata, workspace file listings), both sides have to be kept in step.

### 3-3. Truncation
- There may be more **tools that truncate silently**, like `list_lore` before 0.6.2: `read_lore` (the old json dump, now identical to the listing),
  the caps in `read_turns`/`search_turns`, `list_files`, `read_file` (byte cap), `list_assets`. A full sweep is needed.

## 4. Options (to be decided in the next session)

**A. Keep the current structure + strengthen the stamp (minimal)**
- Add `lore_entries.MAX(updated_at)`, `card_scripts.MAX(updated_at)`, `char_assets` and `memory` to the stamp, and add the `memory`
  table to SCOPE_TABLES. Invalidate the stamp right after a tool's proposal is approved and applied (or just rebuild unconditionally on every `run_python` — it is
  one bot's worth, so the cost is small).
- Upside: the safety model is unchanged, half a day of work. Downside: the fact that it is a copy stays as it is (the two branches remain).

**B. Live connection with permission scoping (the direction the user suggested)**
- The child opens the original DB **directly**, but SQLite's `authorizer` (`conn.set_authorizer`) makes (1) only allowed tables and (2) only **views** with
  `char_key = ?` enforced visible, and (3) rejects every write statement (INSERT/UPDATE/DELETE/PRAGMA/ATTACH). The child opens with a `mode=ro` URI +
  the authorizer, and the views are created not by the parent per session via `CREATE TEMP VIEW`… but on the child's own connection (TEMP views are connection-local).
- Writes stay as they are today: `stage()` → approval. **Settings, API keys and tokens are blocked at the source, at table granularity** (the authorizer rejects `api_keys`, `meta`,
  `sessions`, `agent_presets` and so on).
- Upside: the versioning problem disappears (always current), copy cost 0, and "this bot only, read only" is gathered in one place (the authorizer).
- Risks / to review: (a) the SQLite authorizer is a Python callback, so the possibility of bypass needs review (what if `sqlite3.connect` is called again in the same process?
  → the audit hook blocks reads under `data/`, so opening the original path is itself blocked; the parent would have to **pass down an already-open fd by inheritance** or
  put the `file:` URI on an allowlist, opening exactly one path), (b) the parent writing while the child reads under WAL — SQLite is safe here but a lock wait
  (`busy_timeout`) needs configuring, (c) if the child holds a long transaction, checkpointing is pushed back → resolved by a timeout,
  (d) verifying fd inheritance and path normalisation (`os.path.realpath`) on Windows.
- Work: one day. Tests: add "0 rows from another bot", "access to api_keys denied", "UPDATE denied", "the real DB is
  unchanged before approval" to `tests/test_sandbox.py`.

**C. Compromise: the parent builds a live read-only "view DB" and attaches it**
- Without a separate `ATTACH`-able file, put per-bot **views** in the original (a `v_lore_<hash>` scheme explodes) … low practicality. A candidate for rejection.

Recommendation: aim for **B**, but do A's stamp strengthening first, immediately, in 0.6.x (cheap and independent); B after a design review (risks a and d), in 0.7.

## 5. To be settled alongside it
- Fix the data scope of tools and scripts in **a single table**: per table/column (read: bot-scoped / forbidden, write: approval queue / forbidden).
  Settings (`config.json`), API keys, tokens, other bots and session history are **forbidden**; this bot's chats, lore, card, scripts, asset metadata, memory and
  workspace files are **readable**; of those, chat turns, lore, card, scripts and asset references are **writable after approval**.
- The relationship between the permission prompts of `run_shell`/`pip_install` (`permits.py`) and write approval (`staging`) — whether to show them on one screen.
- Truncation rule: every listing tool must attach "총 N개 중 M개 표시" ("showing M of N total") (shared helper `_clip(text, limit, what)`).
- Whether to state "툴이 잘리면 `risuhina.conn()` 으로 SQL" ("if a tool truncates, fall back to SQL") in the agent instructions (right now it is only in the helper description).

## 6. Current status (2026-08-27)
- Release **v0.6.2** Latest. On the test server the user upgrades via plugin `+` → backend update.
- No decision has been made in this document yet. First task of the next session: decide §4 A/B → plan → implement.
