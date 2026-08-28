# 04 — Workspace confinement, file management, agent presets and skills

2026-08-23. This document is the record of **narrowing** an early decision: "unrestricted Python".

## 1. What changed

The original decision (plan §5.1, user instruction): *"This is an app an individual uses under their own control,
so Python must have very high privileges in the sandbox environment."* That decision stands. What changed is the **scope**.

> Give it permission to run Python, but block access to folders above that workspace folder.
> The DB must not be fully open either — only bot-related edits and reads should be reachable.

So: **the capability stays, only the scope is restricted**. Inside the workspace it can do anything;
it cannot get outside.

This is not a defense against the operator. The operator owns the machine and can run Python directly.
This is a defense against **the agent messing up folders nobody asked it to touch**.

## 2. Two layers — one is not enough

### 2.1 Audit hook (`sandbox.BOOTSTRAP`)

`sys.addaudithook` is installed **before** any user code. Every `open`, `os.rename`, `os.remove` and process
creation that happens inside the interpreter passes through the hook. An audit hook **cannot be removed once
installed** — that is why this approach was chosen.

| Event | Verdict |
|---|---|
| `open` for writing | inside the workspace only |
| `open` for reading | workspace + the interpreter install path (needed for imports) |
| `os.remove` / `rename` / `rmtree` … | inside the workspace only |
| `subprocess.Popen` / `os.system` / `os.exec*` | **always denied** |

The last row is the point. A child process does not inherit the hook, so allowing process creation turns
every rule above it into decoration.

**A trap caught in practice:** the argument of an audit event is not always a path string. When importlib
writes a `.pyc` atomically it passes an already-open **fd as an int**. The first implementation ran
`os.path.realpath()` on it and died with `TypeError`, and as a result `import risuhina` itself failed.
Non-path values now pass through — an fd was obtained from an `open` that already passed the check, so by
itself it is no escape route. On top of that, `PYTHONDONTWRITEBYTECODE=1` keeps `.pyc` files from being
created at all (they are also junk in a folder that gets cleaned).

### 2.2 Scope DB (`pyexec.build_scope_db`)

The child process **never sees the real DB.** The parent exports only that character's rows into `.scratch/scope.db`,
and the `risuhina` helper reads only that.

Why this beats attaching `WHERE char_key = ?` to every helper function: **"only this bot's data" becomes true by
construction, not by the diligence of the implementation.** Other bots' rows are not filtered out — they are not
in the file. The snapshot is opened `mode=ro`, so a script cannot write to it either.

Edit proposals are written as JSONL, and the parent **re-validates them against the real DB** as it harvests
(`harvest`). So a script cannot propose an edit to a chat it cannot see.

### 2.3 Verification

`tests/test_sandbox.py` checks this by running real Python through the real runner (gate stage 3).
Writing to the parent folder fails · reading the data directory fails · reading another workspace fails ·
process creation fails · another bot's chats invisible · snapshot read-only · proposals for other chats discarded.

## 3. Folder convention

The agent instructions and the `AREAS` table in `files.py` state the same convention.

```
original/   As imported. The diff baseline. Cannot be deleted, and cleanup will not delete it.
uploads/    Reference files the user uploaded. Read-only. Not a cleanup target.
scripts/    .py files the agent wrote + generated helpers. Cleanup target.
scratch/    Work files that can be thrown away. Cleanup target.
out/        Artifacts to download. Cleanup target, but may not have been downloaded yet.
.scratch/   Scope snapshot and proposal queue. Cleanup target, recreated on the next run.
```

The policy lives **only in the backend**. Each area arrives at the UI carrying `deletable`/`cleanable`, and the
panel draws what it is given. Put the policy in the UI as well and one day the two will drift apart, and the side
that wins then is the one that touches the disk.

## 4. Agent presets — why there is no "active preset"

A preset is **a saved copy of the agent settings**, not a second live configuration.

The `agent` section of `config.json` remains the single answer to "what is the agent using right now".
A preset **stores that section away and puts it back**.

- `capture(name)` current settings → preset
- `apply(id)` preset → current settings (the settings card changes in front of your eyes)

Keep a separate "active preset" and there are two answers, and the settings panel and the agent can disagree.
`/health` and `/session` actually did disagree that way over credentials (see the docs history).

**Three new fields** — for all of them, off means "not sent". Because when a gateway is fronting a different
provider, it does not ignore parameters it does not know — it **rejects** them.

| UI | Model setting |
|---|---|
| Reasoning | `openai_reasoning_effort` (`none`…`max`) |
| 프롬프트 캐시 (prompt cache) | `openai_prompt_cache_key='risu-hina'` + `retention='24h'` |
| Flex 티어 (Flex tier) | `openai_service_tier='flex'` |

Why the cache key is one for the whole app rather than one per chat: the cached prefix is the instructions plus the
tool schemas, and that is identical regardless of the chat. Splitting it per chat only lowers the hit rate.

## 5. SKILLS

Working procedures the user writes themselves. They are not hardcoded into `agent.INSTRUCTIONS` because this is
the part that changes with the user's working habits.

**2026-08-23: changed to folder form.** One skill is a `data/skills/<id>/` folder:

```
SKILL.md          Front matter (name · description · always) + the procedure body
references/*.md   Material the procedure points at
scripts/*.py      Scripts run through run_python
```

- **Only the catalog goes into the prompt.** One line per enabled skill: `- **이름** — 설명`. The description is the
  trigger: when a matching task arrives the agent calls the `load_skill(이름)` tool and receives the body (it is a tool
  call, so the panel shows a `🧩 스킬: 말투 통일` (skill: unify tone) chip). Same shape as the Claude Code / Agent Skills spec.
- **`always: true`** is the one exception: its body rides along on every request. Only for rules that apply to every conversation (tone, and the like).
- **Enabled ≠ present.** Turn it off and it drops out of the catalog and `load_skill` refuses it too. The folder stays.
- **Limits**: 6,000 characters of catalog + 16,000 characters of always-applied bodies. Past that it truncates by line and says so in the log and in the prompt.
- **`GET /skills/preview`** shows the catalog block, and with `?name=` it shows exactly the body `load_skill` would return.
- Import: a single `.py` → a skill with it in `scripts/`, a long `.md` → `references/`, a short `.md` → the body, a `.zip` → the whole folder.
  Old DB-row skills are moved into folders once at startup (`skills.migrate_rows_once`, keeping their enabled state).

The agent cache fingerprint (`session.get_agent`) includes the skill fingerprint (SKILL.md mtime + enabled state).

`pydantic-ai` itself has no skill feature. A separate package, `pydantic-ai-skills`, implements the same spec but
runs scripts outside the sandbox, so it was not used — same SKILL.md convention, but execution through `run_python`.

## 6. Fixed along the way — a pipe deadlock in the test harness

The `Server` in `tests/test_http.py` took the backend's stdout as a `PIPE` and then **never read it until the
end.** Once the suite grew and the log exceeded the OS pipe buffer (64KB here), the server stalled inside
`write()` and cut off its responses. The symptom was "it works when run on its own, but a particular request
times out when the whole suite runs".

It surfaced because adding the preset and skill tests crossed the threshold, so it would have shown up the same
way for the next person to add tests. Now a daemon reader thread keeps draining it.

---

# Appendix A — UI restructure (2026-08-23, round 2)

## A.1 Screen structure

The tab bar holds only **the things you work on**. Settings is where you configure the tool, not a thing you
work on, so it moved up into the header (title · status · refresh · ⚙ · close, on one line).

```
[Risu Hina v0.1.0] [● 백엔드 v0.1.0 · 챗이름 · 394턴]        [↻] [⚙] [×]
챗 선택 | 챗 에딧 | 챗 로어북 | 장기기억 | 파일
[ tool line — actions for the current tab. Full width ]
┌──────────────┬──────────────────────────┬────────────────┐
│ Left: list   │ Middle: the thing itself │ Right: AI      │
└──────────────┴──────────────────────────┴────────────────┘
```

The three panes were unified into the single `threePane()` in `ui/panes.ts`. Use a different layout per tab
and **the AI feels like a different tool depending on what you are editing.**

**The AI panel is one instance that gets moved** (`ui/agentpane.ts`). Build one per tab and the conversation
history, the cost and the 새 대화 (new conversation) button come in three copies, and every time you switch
tabs the party you were talking to quietly changes. `appendChild` moves rather than copies, so the scroll
position, the sentence being typed and the run in progress all come along.

## A.2 Mobile

At `max-width: 760px` the left/right split becomes a **vertical stack**. The splitter is the same
gutter with only the axis changed — it reads the axis from the container's `flex-direction` at drag
time, not at build time. Because a rotation is a resize, not a reload.

The stack order is [explorer strip] → [transcript] → [gutter] → [AI]. On a phone the AI is the side you
write with and the transcript is the side you check, so the AI gets 55% by default.

Horizontal overflow was stopped with `.row { flex-wrap }` + `.row > * { min-width: 0 }` +
`.wrap/.pad { overflow-x: hidden }`. A fixed-width input inside a flex row was what pushed the
settings screen off to the right.

## A.3 Preset model, corrected

§4 said "there is no selected preset" — **that was reversed.** The model the user asked for is
better: one current preset on screen, the list behind a button.

The single-truth rule is kept by **making the mirror complete**. Selecting writes to config, and editing
the selected preset writes to config immediately too. `agent.py` still reads only config, so the lower
layers need not know that presets exist — config is not a second place to configure things, only a
projection of the selected row.

- There is **always at least one** preset (`ensure_default` seeds one from the existing config).
- The last one cannot be deleted. Delete it and there is nothing to show and no row for the agent to read.
- **The base instructions** are appended *after* the built-in rules. They cannot reverse "never write directly to the transcript".

## A.4 Skills are copied in as whole folders

Skills are global; workspaces are per bot. Instead of punching a hole so the sandbox can reach outside,
**the runner copies each enabled skill folder into `<ws>/skills/<id>/`.** The refusals in `sandbox.py`
stay exactly as they are, and the agent uses `skills/<id>/references/x.md` through read_file and
`skills/<id>/scripts/x.py` through `exec(open(...).read())` inside run_python.

`skills/` is emptied and rewritten on every run. If a disabled or renamed skill were left behind as a
file, the agent could still find it and run it.

## A.5 Long-term memory into the DB

> Review request: "Does long-term memory need to go into the DB the way the chat body does?"

**It does. That is what was done.** The reasons are the same as for the transcript:

1. It must be possible to fix one item alone. Telling the agent to fix it inside a JSON blob means
   telling it to rewrite a structure that is not its own.
2. The diff against the frozen original becomes a string comparison, not a JSON diff.
3. When writing back, the structure can be restored **exactly**, because the parts nobody touched were
   never taken apart in the first place.

`memories(id, chat_key, kind, seq, title, body, original, extra_json)`.
A NULL `original` means "an item that was added here".

**The shell is kept as is.** Everything other than the summary list is stored in the `meta` table under
`hypa_shell:<chat_key>` and restored on patch. Rebuilding the memory blob from only as much as we
understood is exactly how a fork's fields quietly disappear.

**Per-item extras, `chatMemos` above all, are restored as is too.** Lose them and a summary loses the
link to the turns it summarized — and that stays invisible until the next generation.

**Re-uploading does not erase edits.** The panel re-uploads the whole workspace every time it opens.
The transcript already preserved the working copy unless `force` was set, and memory follows the same
rule through the same call (`reset=summary["workingReset"]`). Behave differently and you get "the turn
edits survived but only the memory edits vanished" — the kind of inconsistency nobody can guess at.
The baseline (`original`) is refreshed even when it is not a reset. RisuAI may have re-generated the
summaries, and a stale original makes the diff lie.

**Reinforcement (0.9) — move only the baseline and the diff lies in the other direction.** Move the
baseline while leaving the working copy alone, and a row I never touched becomes `작업본 ≠ 기준선` and
shows as "edited here". With the sides swapped, at that — RisuAI's **new** text sits where `original`
should be, and the **old** text sits where the working copy should be. Hit 반영 (write back to RisuAI)
in that state and we undo the edit the user made in RisuAI. So a reopen is a **3-way merge** (`app/merge.py`):

    ours == base                  → take RisuAI's value  (there is no edit to lose)
    ours != base, theirs == base  → keep my edit         (the rule above, unchanged)
    both moved                    → conflict — keep mine and record RisuAI's

`adopt` (accept) is the only operation that can lose anything, and it happens only when the working copy
is proven equal to the baseline. So safety reduces to one sentence: **do not adopt on a pairing you
cannot be sure of.** That is why an item paired by position alone is never adopted.

**Once 반영 finishes, no working copy is left behind.** Previously the commit moved the baseline toward
the working copy (a rebase); the diff went to zero, but our copy remained and started drifting again from
that moment — the seed of the bug above was replanted on every 반영. Now the commit leaves only a snapshot,
and the plugin re-reads the bot/chat it just wrote and reloads only that range (`chatReset`/`cardReset`).
**Exception: 복사본 저장 (save as a copy) for a chat** writes the edited version into a new chat, so the
current chat's edits have not been written back yet — re-reading here would make those edits disappear.

## A.6 What the files view shows

By default it shows only **what a person put in and what they will take out** — `uploads/`, `out/`.
The frozen originals, the generated helpers, the scope snapshot and scratch all really exist, but there
is no reason to look at them before something goes wrong. They are **folded away**, not deleted:
because "cleanup" has to be able to say what it will delete.

## A.7 Colors for speech and thought

`"큰따옴표"` (double quotes) is speech (orange `#f0a04b`), `'작은따옴표'` (single quotes) is inner thought
(sky `#7dd3fc`). The card's regex did this on the chat screen, so the stored original text is one color.

It matches both straight and curly quotes but **never crosses a line break.** One unclosed quote
swallows the rest of the turn whole and paints half of it.
The quote marks themselves are not removed — the screen you read on and the screen you edit on must not differ.

## A.8 Elapsed time

One agent turn takes minutes, not seconds. Three dots answer "is it alive?" but not
"is this a 20-second one or a 4-minute one?". `0m 0s` ticks up every second and, when the turn ends,
stops and stays on screen — how long it took is worth having next to the result.

---

# Appendix B — Approval queue, skill material, updates (2026-08-23, round 3)

## B.1 Approval queue (`actions.py`)

`staged_edits` gates the transcript, and this gates **everything else** — lorebook, long-term memory,
snapshot restore, 반영 to RisuAI, 복사본 저장.

> "For anything that writes, the agent must ask the user one more time."

**Tell** the model "ask before writing" and it mostly obeys. Mostly is enough for tone and not enough for
writes — the one run in twenty that skips it quietly rewrites the lorebook.
So the tools were made **unable to write**. A tool records the intent and returns "승인이 필요합니다"
(approval required), and the real execution happens inside `decide()` when a person presses the button.

**Two executors, one queue.** Writing to a RisuAI chat and 복사본 저장 go through host APIs that exist only
inside the plugin iframe. Those two are marked `host_*` and `decide()` hands them to the plugin. Rather than
have the backend pretend it can do them, or hide them from the agent entirely, **it is better to say which
side does it**. The plugin reports back through `/actions/complete` after performing it, so a failure over
there does not stay recorded as a success.

**Scope of the instruction, corrected.** At first "always ask once more before writing" was applied to
everything, and the agent held back even on `stage_edit` and asked again (a real-model test caught it).
**Staging is itself the confirmation step** — a preview appears in the left panel and there is an approve
button. So the rule was narrowed to `propose_*` (things that are hard to undo or that touch the RisuAI original).

## B.2 New JOBs

| Tool | What it does |
|---|---|
| `propose_memory_edit` / `_delete` | long-term memory |
| `propose_lore_edit` / `_add` / `_delete` | this chat's lorebook (does not touch the bot-wide one) |
| `list_snapshots` · `propose_snapshot` · `propose_restore` | snapshots |
| `propose_writeback` | 반영 to RisuAI (performed by the plugin) |
| `propose_save_copy` | 복사본 저장 (performed by the plugin) |
| `list_proposals` | pending proposals |

`snapshots.py` was split out of `main.py` for this reason. If the HTTP handler and the action executor each
hold the same logic, one day "restore" will come to mean two different things.

## B.3 A third kind of skill — `reference`

| Kind | Body | Prompt | Files |
|---|---|---|---|
| `md` | instruction prose | whole thing | — |
| `script` | Python | one line | `<ws>/skills/*.py` |
| `reference` | Markdown material | one line | `<ws>/skills/*.md` |

The material imported from vepo-bot is 9–11KB apiece. Put it in the prompt budget (24,000 characters) and
it is the whole budget, and **putting in a shortened version is worse than not putting it in at all** — the
agent confidently uses the half that survived. So it sits on disk whole and only one line goes into the
prompt: "this is here, open it when …". Measured: 44,000 characters of material → 1,105 characters of prompt.

**Copied into the repo.** `pyserver/app/seeds/`. For the same reason as `chatfmt.py` — a runtime dependency
on a neighboring project is invisible from here and nobody updates it.

| Seed | Kind | Default |
|---|---|---|
| RisuAI CBS syntax | reference | on |
| RisuAI lorebook structure | reference | on |
| RisuAI Lua triggers | reference | off |
| charx card structure | reference | off |
| unpacking charx | script | off |
| Arcalive HTML authoring | reference | off |

The charx script **embeds** `rpack_map.bin` as base64. A skill script is copied into the workspace on its
own, so if a companion file is missing it fails at exactly the moment it is needed. The runner has no stdin,
so the original's overwrite-confirmation prompt was removed too (it becomes a hang, not a question).

For the Arcalive one, **only the sanitizer definition** was pulled out of `make-chatlog`/`make-showcase` and
abstracted into general guidance. Those two skills are procedures that each produce one artifact, and the
part that generalizes is "the constraints on HTML you paste into Arcalive" — and that is the part nobody
can guess.

`session.run` calls `install_skills` at the start of every turn. Otherwise you tell the agent to
`read_file skills/...` while the files only appear after `run_python` has run once.

## B.4 Updates — the order decides the design

> "Normally it's: update from the UI in RisuAI → open the plugin UI and update the backend.
> The GitHub or github-page build has to be set as the //@update-url!"

Correct. At first the backend served `/plugin.js` and `//@update-url` pointed there, but **that is a cycle** —
the plugin update comes first, yet it would require the backend to be alive and up to date. Now it points at
GitHub's **raw file**:

```
https://raw.githubusercontent.com/<owner>/<repo>/master/plugin/Risu.Hina.Plugin.js
```

At first it was `releases/latest/download/Risu.Hina.Plugin.js` — a stable address, and curl downloads it
fine. But **even when v0.1.0 → 0.3.0 shipped, no `+` appeared on risu.xyz.** RisuAI's check code
(`plugins.svelte.ts checkPluginUpdate`) is a browser `fetch(updateURL, {Range: bytes=0-512})`, and the release
address redirects twice, `github.com → releases/download → release-assets.githubusercontent.com`, and none of
the three responses gives `Access-Control-Allow-Origin`. CORS exception → catch → no button. raw gives
`access-control-allow-origin: *` and `Accept-Ranges`, and the example URL in the RisuAI docs is raw too. So
`tools/bundle.py` also copies the bundle to `plugin/Risu.Hina.Plugin.js` on every release and **includes that
file in the release commit** — the commit is the "new version published". The `Risu.Hina.Plugin.js` in the
release assets is a copy of the same file (it is inside the install zip as well).
If an installed copy carries the old address, that one time needs a manual reinstall (0.3.1 was that case).

Only `risuhinaRepo` in `plugin/package.json` needs filling in. **If it is empty, no `//@update-url` is
emitted at all** — a URL that 404s makes RisuAI show "업데이트 확인 실패" (update check failed) forever,
and that is worse than nothing.

Serving `/plugin.js` was kept. It is useful during development and for local reinstalls, and although it is
open without a token, what it serves is **the plugin file the user has already installed** — no key and no
token is in it (both live in the RisuAI plugin store).

**Backend update (`updater.py`)** — query the release → download the zip + `SHA256SUMS.txt` → verify the
hashes → install → **exit 75**. Why it does not restart itself: whatever is wrapping it
(PM2, NSSM, systemd, `start.bat`) is the side that knows how to start it, and a process that re-execs
itself fights all of them. The loop belongs to the launcher.

Verification was not compromised on. Without `SHA256SUMS.txt` the install itself is refused — what is
downloaded becomes the server that will run, so this endpoint without verification is remote code execution.
The zip member paths are checked before extraction too.

**Two layouts.** Both the plan's `versions/<v>/` + `current` structure and the flat structure that is
actually deployed today are supported. The flat one leaves an `app.bak-<시각>` and replaces in place —
because when there is no version directory to go back to, a rollback has to be a single rename.

## B.5 Logs and diagnostics

Once it is deployed, "check the server logs" is advice nobody can follow. The backend may be on a PC being
reached over Tailscale from a phone, and the log is a file on that PC. So the log comes to the panel
(`log.recent()`, a 4,000-line ring buffer).

There are two buttons because there are two questions. **진단 정보 (diagnostics)** is "what is this
installation" (version · settings · storage size) — short enough to paste anywhere. **서버 로그 (server log)**
is "what just happened" — long.
A report that has both needs no follow-up question.

Neither key nor token goes in. The diagnostics say only **whether** a key is set, and the log never wrote a
key in the first place. Tests check each of those two.

## B.6 Defects caught

- **The agent panel did not pick up credential changes.** The panel renders once and caches, and editing a
  preset in settings did not invalidate it, so "자격증명이 설정되지 않았습니다" (credentials are not configured)
  stayed on screen even after the fix. `onChanged` now calls `invalidate()`.
- **linkedom stores neither `option.selected` nor `select.value`.** So the kind selection always read as an
  empty string, and an empty string was judged "not md". It is now written as an attribute as well.
- **The test harness blew up on a non-JSON response.** `/plugin.js` was the first case.
- **Lorebook folders were shown as raw IDs.** A folder is itself an entry with `mode: 'folder'`, so the name
  is pulled from there. That entry has to be dropped from the list — it is a container that is never injected
  into the prompt, and sitting alongside its own children it reads as a duplicate.

---

# Appendix C — Renaming `Real-ooc` → `risu-hina` (2026-08-23, round 4)

The repo is `nilsonwhang3-spec/risu-hina`. Four spellings were substituted in order of length (so the short
one does not eat the long one):

| Before | After | Where it is used |
|---|---|---|
| `REALOOC_` | `RISUHINA_` | environment variables |
| `Real-ooc` | `Risu Hina` | display text and prose |
| `real-ooc` | `risu-hina` | package, file and service names |
| `realooc` | `risuhina` | Python identifiers, DB file, temp prefix |

## C.1 Renaming on top of a live installation

A rename is not a string substitution. There is an installation already running, and the user's chats are in it.
All four compatibility shims that were left in are there to prevent a **silent failure**.

**Environment variables.** If `_ENV()` cannot find `RISUHINA_*` it reads `REALOOC_*`. Not politeness but
necessity — the launchers, control scripts and service wrappers already on the machine are written with the old
prefix, and silently ignoring `REALOOC_PORT` looks like **binding to the wrong port for no reason**.

**Database.** `realooc.db` is moved to `risuhina.db`. It is done **before any connection is opened** —
the WAL and shm sidecars have to move with it, and renaming the file under an open connection is how a
WAL gets separated from its own database. Measured: 454 turns carried over intact.

**Sandbox helper.** A `realooc.py` shim is written into the workspace alongside `risuhina.py`.
Script skills the user wrote before the rename still say `import realooc`, and
**that script breaking at the moment it is actually needed** is not a trade worth making against three lines of re-export.

**Handshake.** The plugin accepts both `risu-hina` and `real-ooc` as `/health`'s `service`.
Because of the update order **the plugin is updated first**, so for one session a new plugin meets an old backend.
Refuse the handshake there and it looks like "the backend is dead", not "the backend is an old version".

## C.2 What the user experiences

RisuAI keys the plugin store **by plugin name**. Because `//@name` changed, the stored backend URL and token
do not come along. The file name is `risu-hina-0.1.0.js` too, so it is a **fresh install**, not an update.
That is the normal cost of a rename, and since loopback is exempt from the token there is almost nothing to
re-enter in practice.

## C.3 Not changed yet

The local checkout folder is still `C:\code\real-ooc`. The risk of pulling the cwd out from under a running
session outweighs one folder name. The paths written in the docs were left matching reality too —
**docs pointing at a path that does not exist** is worse than a name that does not match.
The deployment side was moved to `D:\code\risu-elf`.

---

# Appendix D — Bundling the interpreter (2026-08-23, round 5)

## D.1 What was wrong

> "If deployment requires the user to install Python, that's a non-starter." — decision made at the outset

The first release broke this. `setup.sh` and `manage.ps1` **looked for** a system Python and built a venv
from it, and failed when there was none. The install guide even said "Ubuntu 20.04 has 3.8, which will not
work as is — install one with pyenv". The decision was written down and the opposite was shipped.

## D.2 The current structure

Each archive ships CPython 3.11 with the dependencies already installed. The launcher uses **that first**,
and the venv became a fallback that only means anything in a source checkout.

| OS | Interpreter | Rationale |
|---|---|---|
| Windows | python.org embeddable 3.11.9 | 11 MB, official, `._pth` takes over sys.path completely |
| Linux | python-build-standalone 3.11.13 | python.org does not publish a relocatable Linux build. The one uv uses |

What "self-contained" means: **the bundled interpreter cannot accidentally pick up another Python on this
machine.** On Windows `._pth` makes it ignore PYTHONPATH, the registry and user site-packages entirely.
Linux's python-build-standalone does not look at `._pth`, so the launcher clears `PYTHONPATH` and
`PYTHONHOME`. But **`PYTHONHOME` gets through `._pth` even on Windows** —
`start.bat` and `manage.ps1` clear that too.

Dependencies are fetched by the build machine's pip with `--platform/--abi/--python-version`. Because it
**never runs** the target interpreter, both archives are built on one Windows machine. The lock is per
platform — `pydantic-core`, `tiktoken` and `regex` are compiled wheels, so the hashes differ per platform.

## D.3 Verification

It was installed with the system Python deliberately made unusable: every Python removed from PATH and
`PYTHONHOME`/`PYTHONPATH` pointed at nonexistent paths. Ubuntu 20.04 has only 3.8 as its system Python,
a machine that cannot run this app — it came up on the bundled 3.11, and `ps` confirmed the server process
was `pyserver/python/bin/python3.11`.

## D.4 What the rehearsal caught — in order

1. **The dependencies were installed outside `pyserver/`.** `--target` was `stage / site` with `pyserver/`
   missing. The zip contained 5,311 files, but not in a place the interpreter looks.
2. **The `.pyc` files were compiled for the build machine's 3.12.** 8 MB of junk inside a 3.11 bundle. `--no-compile`.
3. **The executable permission bit was thrown away.** Even with 0o755 in `external_attr`, unzip ignores it
   when `create_system` is left at the default 0 (MS-DOS). It has to be 3 (Unix).
4. **A 52 MB static binary was copied at every symlink.** `python3 → python3.11` and `python → python3`
   were assumed to be "a 10 KB copy", but the binary is statically linked, so each was 52 MB and the bundle
   came to 89 MB. They were replaced with two-line `exec` shims, and the 53 MB `libpython.so` that only
   embedding hosts use, plus tk, were dropped as well → 34 MB.
5. **The shell shims were written with CRLF.** Windows' `write_text` turned `\n` into `\r\n`, so the kernel
   went looking for `/bin/sh\r`. `newline=""`. **This is the third line-ending trap this project has stepped on**
   (`.sh` CRLF, `datadir.txt` BOM, and this one).
6. **`setup.sh` invoked the interpreter before clearing `PYTHONHOME`.** Only `start.sh` was clearing it.
   `No module named 'encodings'` is the symptom of an interpreter that cannot find its own stdlib, and it is
   what a user with a stray `PYTHONHOME` on their machine would have hit. The error message was **guessing**
   too, saying "glibc is too old" — now it shows the actual error.

## D.5 The updater

There is one archive per OS, so the updater picks **only the one for its own platform**. Installing the other
one means swapping a working server for a Python that cannot run on this machine. `python/` is replaced along
with `app/` — a new version may require a new Python — and the old one is left next to the old app so a
rollback is two renames.

`release.py` only delegates to `bundle.py`. **No code path was left that can build an archive without an
interpreter** — that was the archive that broke the rule.

# Appendix E — The asset subsystem and charx (2026-08-25, round 6, v0.3.0)

## E.1 Why there is a separate store

Up to M1 no bytes were needed — cards, scripts and lorebooks are text, so they ride along in the `/workspace`
upload. Everything after that demands bytes: charx is a zip of card + images, PIL work needs pixels, and the
asset tab has to say what those 2980 images are. RisuAI itself keys assets by content hash
(`assets/<sha256>.<ext>`), so the store follows suit:
`data/assets/<sha256>.<ext>`, global across bots, deduplicated by construction. The backend recomputes the hash —
it is the file name and an upload integrity check at once. (The header comment of `pyserver/app/assets.py` is canonical.)

## E.2 Why sync looks the way it does — M0 measurements

2026-08-24, a risu.xyz account user with 2980 images / 142.6MB: **reading** them from the host took 42.8 minutes
(862ms each, because account storage does a hub GET per image), uploading took 2.6 minutes. So the importer was
built around "read from the host as little as possible":

    hub pull      account users: the backend GETs `sv.risuai.xyz/rs/<key>` directly, in parallel (probe 200)
    fast path     PocketRisu on the same PC: `kv(key TEXT, value BLOB)` in `save/risuai.db`, read-only
    plugin push   whatever is still missing after that: readImage 4–6 at a time, 8MB batches by byte count

**Why bytes from any of those paths are the same asset**: RisuAI's key is `assets/<SHA-256(바이트)>.<ext>`
(`parser.svelte.ts hasher`). So when the key of a bot opened on risu.xyz is present in the PocketRisu DB on the
same PC, that is not "PocketRisu's data" but **a cache hit on the same bytes** — on the first real use (2026-08-25)
312 images for a web bot filled in within 0.6 seconds, which was that case, and the user suspecting it had
"read them as if connected through PocketRisu" is what prompted this paragraph. The backend does not trust this
guarantee, it **verifies**: if the key's stem is 64 hex characters, `sha256(bytes)` must equal it before storing,
and if it does not it is rejected whatever the source (`assets.store_bytes`).
The sync line on the bot card states how many images came from where on this pass.

Content addressing makes resume and incremental sync free. Keys the host could not read are marked `failed` so
they do not hold the gate, and the next sync retries them. The 반영 gate opens on the backend's `complete`
(nothing missing + no pull in progress) — a card written before the images arrive is a card the charx builder
cannot finish.

## E.3 charx — we do not build module.risum

RisuAI's charx export (characterCards.ts `createBaseV3` + `exportCharacterCard`, c0ed1026)
**copies triggers, Regex and lorebook into a module and then deletes them from card.json**. The importer
(`importCharacterProcess` → `importCharacterCardSpec`) digests inline `extensions.risuai.triggerscript` /
`customScripts` and `character_book` as they are when there is no module. So leaving them inline needs no rpack
encoder and imports to the same result (the module namespace is lost in a charx round trip anyway — `charx-cards.md`).

One difference from RisuAI: the icon entry (`ccdefault:` → `assets/icon/image/main.png`) is written **always**,
not only when there are emotion images. The importer maps `icon`+`main` to the character image, and without it
you get a bot with no portrait. The importer **throws** on an `embeded://` path that is not in the zip, so
missing assets are rejected by default (the list is returned), and with `allowMissing` that entry is removed.
The full assembly spec is the header comment of `pyserver/app/charx.py`.

## E.4 Asset add and replace are written immediately

Unlike text material, binaries have no working copy. Once approved, `host_asset_add` / `host_asset_replace` have
the plugin call `saveAsset` (the host picks the key and it is always `.png`) → append to the live card's
reference list → put it into the backend store under the same key through `/assets/adopt`. It is the only card
change that does not wait for 반영, which is why it was limited to PNG (non-PNG is only possible through a
PocketRisu bulk-write — not implemented, E.5).

## E.5 Left undone

- A plugin-side fflate assembly fallback (for environments where backend sync is impossible) — the hub pull + push
  made the backend path work on the web too, so it was deprioritized.
- PocketRisu `bulk-write` (non-PNG add and replace, self-signed with `__jwt_secret`) — only the `serverWrite` flag exists.
- Module assets (v2), the trigger V2 block GUI.

# Appendix F — Bot editing and settings, round 2 (2026-08-25 night, v0.4.0)

Some twenty pieces of user feedback. The principle is the same as before — **only what RisuAI's UI offers, in the shape RisuAI stores it.**

## F.1 Asset references are card material

Renaming, deleting and the bulk tools are not about images but about editing the card's three lists
(`emotionImages` / `additionalAssets` / `ccAssets`). So they go into `card_scripts` as `kind='assetref'`
(entry={field,name,key,ext}), live the same lifecycle as Regex and triggers (original|edited|added|deleted), and
`card.patch` turns them back into `assets{emotionImages,additionalAssets,ccAssets}` and writes them all at once
at 반영 time. It writes the whole thing, but only sends it when something changed (the same rule as lorebooks
and scripts). The file bytes are the store's business, and deleting removes only the reference (the file is
RisuAI's GC problem). The bot version (`additionalData.character_version`, the place RisuAI's UI edits) is
modeled as a `characterVersion` row and written to both places (nested + top-level) on write.
`backgroundCSS` is not in RisuAI's UI, so it was retired.

## F.2 Triggers = RisuAI's three modes

`TriggerList.svelte` decides the mode from `triggerscript[0].effect[0].type`: `triggerlua` gives a single Lua
text box (no event selector — the script registers itself), `v2Header` gives the block program, anything else is V1.
The tab follows exactly: mode buttons V2/Lua (+V1 only when the current one is V1), one box for Lua, and a
read-only summary for V2/V1. Switching modes replaces the whole list with the initial object RisuAI writes.

## F.3 Sync — only asset edits and charx wait for it

The 반영 gate was removed. Text material is written as text, so there is no reason to wait for images to arrive,
and the only things that need bytes from the store are charx assembly and asset editing. Sync progress is always
visible at the end of the tab row (`syncbadge`), the asset tab is read-only while syncing, and the charx button
(bot bar) is greyed out.

## F.4 Settings — two agents, keys in one place

- **General/search agents**: presets gained a `kind` and one is selected per kind (`agent` / `agent_search`
  sections). The general agent calls the search agent (web search tool only, no scripts) through
  `web_research(question)`. With no search preset it calls `web_search` directly, as before. The UI recommends Gemini (search grounding).
- **API keys** (`api_keys`, DB v10): a preset either borrows a key through `keyRef` or carries its own. Change a
  key and the selected presets using it are re-resolved immediately (`presets.reresolve_selected`). The agent
  still reads only the config section — `agent._model()` does not need to know.
- **Model catalog**: the backend fetches models.dev `api.json` (~200 providers, API address · models · context ·
  pricing) once a day and searches it through `GET /models/catalog?q=`. The card on the info/log tab and
  "카탈로그에서 찾기" (find in catalog) in the preset editor use the same data. Offline it uses the cache; with no
  cache either, an empty result (not a 500).
- "토큰을 보내지 않았습니다" (no token was sent) in the connection diagnostics appears **only when the connection
  failed**. That line lingering under a success line was the bug.

## F.5 Left undone

- The mobile splitter: fixed with `touch-action: none`, but not yet confirmed on a real device.

# Appendix G — Round 3 and the rename (2026-08-26, v0.5.0)

## G.1 Risu Elf → Risu Hina

It had never actually been deployed, so the name was changed without leaving a history trail (`rename_hina.py`, once).
Three things were kept: the GitHub repository path (`nilsonwhang3-spec/risu-hina`, kept because it is a URL), the
checkout and install directory names, and the **compatibility hooks** — `RISUELF_*`/`REALOOC_*` environment
variables are still read (`config._OLD_PREFIXES`), the `/health` signature is `risu-hina` but the plugin also
accepts `risu-elf`/`real-ooc`, and the DB is adopted from `risuelf.db`→`risuhina.db` on first startup. Because the
plugin name (`//@name risu-hina`) changed, it is a new plugin as far as RisuAI is concerned: taking the `+` on the
old entry installs Hina (`plugin/Risu.Elf.Plugin.js` is written once more with the same bundle), and the backend
URL and token have to be entered once again because the plugin store is keyed by name. The release assets are
`Risu.Hina.*`; an old updater that is already running picks by `Install.Package`+OS rather than by name, so an old backend receives the new zip too.

## G.2 The agent knows which screen it is on

The plugin sends `mode` (chat|bot) with every prompt and it becomes `Deps.mode`. Proposal kinds are split into two
sets (`CHAT_KINDS` / `BOT_KINDS`), and `_propose` and `stage_*` refuse material belonging to the other screen and
answer that it should propose a move with `propose_open_tab`. Reading works from anywhere.

## G.3 Why the history was being cut off, and the fix

`session.run` saved a `history` row only for turns that succeeded. Turns that ended in an error or an interruption
were not saved, so the next turn started from the history of the last *successful* turn, and the agent had never
heard the prompts in between (measured: 8 user turns, 4 history rows). Now the `BaseException` path appends the
prompt + whatever text arrived + a failure note to the history.
Context budget: pydantic-ai 2.x has no history processor hook, so `session.run` calls
`agent.compact_history()` right before running — past `agent.historyBudgetChars` (240k by default) it keeps the
last 6, has the model summarize the earlier part once and replaces it with a single pair (a summary request and an
acknowledgement), remembers it in `COMPACTED` and uses that as the stored history for that turn (the summary is
paid for once). An interruption is client AbortController → server cancel → the same partial history is saved.

## G.4 Workspaces across bot versions

`workspace.root(ck)` looks at `characters.family_key` and returns the family's directory. The family marker is the
card's `extentions.risu_hina.family` (the original's char_key) — `host.cloneBot` stamps it, charx carries
`extentions` through as is so it survives a round trip, and RisuAI preserves extension keys it does not know across
save, export and import. Rows (turns · card · lore) are keyed per bot in the DB so they do not mix; only the files
(uploads · outputs · scratch · skills) are shared.

## G.5 Left undone

- Web (risu.xyz) asset thumbnails: impossible because the iframe CSP has no `img-src` (`default-src 'none'`). PocketRisu only.
- Real-device checks: the mobile gutter, `web_research`, summary compaction actually working.

## G.6 Permission prompts (v0.5.1)

Shell commands and pip installs cannot go through the approval queue (decided after the turn ends) — the agent
needs them *now*. So `permits.py` **blocks** the tool call: it registers the request and `permits.decision()` waits
for an answer (up to 10 minutes, timeout = deny), and the panel polls `GET /permits?sessionId=` every 1.5 seconds
while the turn runs and draws the prompt (허용 / 거부 / 이번 턴 항상 허용 — allow / deny / always allow this turn).
"항상" is per session and per turn, so the `finally` in `session.run` clears it.
Execution happens outside the sandbox (in the backend process) with the workspace as cwd and the bundled
interpreter first on PATH — the user allowed it, so it does not contradict the audit hook's "no process creation".
Embedded Python has no pip, so `tools/bundle.py` downloads the pip wheel and puts it on `python311._pth` (wheels are zip-imported).

## G.7 The updater cannot move its own interpreter (v0.5.2)

On the first real-use update (0.5.0→0.5.1) `_install` did a `shutil.move` on `python/`. The `.pyd` files inside are
**loaded by the process that is running right now**, so Windows locks them → `PermissionError`, and `move`'s
fallback (copytree then rmtree) left a half-deleted tree so the next attempt got `FileNotFoundError`. The rule:
**a running process does not touch its own interpreter directory.** The new interpreter is left as `python.new`,
and the launcher that runs outside Python (`start.bat`/`start.sh`) renames `python`→`python.old` and
`python.new`→`python` right before the next startup. If `python/bundle.txt` (Python version + the
`requirements.lock` hash) matches, it does not even stage. The launcher itself is something the updater leaves as
`*.new` (overwrite its own file and cmd, which reads it by byte offset, breaks), so an installation on the old
launcher has to be replaced by hand once before the swap works — that is why 0.5.2 has to be installed manually.

Version gate: the plugin compares the major.minor of `/health`'s version with its own and, if they differ, refuses
any call outside the update path (`/health` `/update/*` `/plugin` `/logs` `/diag` `/config`) and says which side to
upgrade. Before that, a mismatched API blew up deep inside as a 404 or in some strange shape.

## H. Request parameters are data (v0.6.0)

"OpenAI-compatible" endpoints share only the name. Confirmed against the documentation (2026-08-26): OpenAI's own
GPT-5 and o series **reject** sampling parameters such as `temperature` and `top_p` (only the defaults are
allowed), and the gpt-5.6 series **rejects tool calls outright on Chat Completions** (use the Responses API, or
`reasoning_effort: none`); the compatibility layers of
Anthropic, Gemini (AI Studio) and Vertex **ignore** fields they do not know; Ollama knows only `max_tokens` and
does not list `max_completion_tokens`; on OpenCode, GPT and Grok are `/responses`, DeepSeek, GLM and Kimi are
`/chat/completions`, Claude and Qwen use the Anthropic format (not possible with our tooling), and Go is
`opencode.ai/zen/go/v1`; Vertex takes only an OAuth access token and express-mode API keys do not exist on this
endpoint. Meanwhile pydantic-ai 2.33 decides the profile from the model name alone, so it sends `temperature` to
gpt-5 as well, puts `strict:true` on tool definitions, uses `max_completion_tokens` for the limit, and always attaches `stream_options` when streaming.

Hardcode a parameter set and it will break somewhere, guaranteed. So it was moved into `providers.py`:

- **Profiles** (`PROFILES`): looked up by the Base URL's host (path included — `opencode.ai/zen/go` comes before
  `opencode.ai`). Output-limit field, whether `strict` is allowed, rejected fields, default API (chat|responses),
  model-family rules (`modelRules`: prefix · exceptions · rejected fields · endpoint), example JSON, guidance text, docs URL.
- **The preset's `params` JSON**: the keys are the actual request field names. A value sets that field, `null`
  means "do not send". Giving a number to `max_tokens` / `max_completion_tokens` fixes both the value and the
  spelling; `null` on both means no limit. `strict` and `api` are pseudo-keys. Unknown keys go out as they are
  through `extra_body`. `model`, `messages`, `stream` and `tools` are rejected.
- **The plan** (`plan_for`): in the order section number fields → the profile's reject list → the JSON, it builds
  `settings` (pydantic-ai model settings), `drop` (fields to strip right before the request), `cap_field`,
  `strict_tools` and `api`. The default for `temperature` is **None = do not send** — every provider has its own
  default and OpenAI's reasoning models accept only the default.
- **Application**: `agent._client` wraps `AsyncOpenAI.chat.completions.create` and `responses.create` and pops
  `drop` (+ the Responses spelling aliases) — even `stream_options` and `parallel_tool_calls`, which cannot be
  turned off through settings, are removed here. `agent._profile` layers
  `openai_chat_supports_max_completion_tokens` and `openai_supports_strict_tool_definition` on top of
  `openai_model_profile(모델)` (`merge_profile`; the profile is a TypedDict, so it is not
  `dataclasses.replace`). The connection test (`h_config_test`) sends the same fields to `/responses` or
  `/chat/completions` under the same plan.
- **Guidance** (`hint`): it pulls the field out of the 400 body — "Unsupported parameter: 'X'" ·
  "Unsupported value: 'X' does not support …" · "Unknown name \"X\"" · "X: Extra inputs are not permitted" ·
  "Function tools with reasoning_effort are not supported" and the like — and attaches the exact snippet to put
  into the preset JSON (`{"temperature": null}`, `{"max_completion_tokens": 32000}`, `{"api": "responses"}`).
  Words it does not recognize are ignored when they are not in the field list (`KNOWN_FIELDS`).
  It is attached to `session._explain`, the connection test and the search agent's failure message.

Measured by the user: gpt-5.6-sol works through the Responses path, tool calls included — the
same direction as the research, so the default of the official OpenAI profile was set to Responses as well.
