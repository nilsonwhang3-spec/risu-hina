# 08. Reaching the backend from outside RisuAI — an MCP surface

**2026-09-27: built (§1-75, unreleased). §0 is what exists; §1-4 are the 2026-08-29 design discussion it came
from, kept because §1's host constraints still decide everything.**

## 0. As built

**User flow.** Remote PC runs the backend (behind a domain / tunnel) → in local RisuAI, 설정 → 고급 기능 →
**MCP 설치** (once) → copy the `claude mcp add --transport http risu-hina <url>/mcp --header "Authorization: Bearer
hmcp_…"` line into Claude Code (once) → on the picker (봇/챗 첫 화면) press **MCP 활성화** beside 봇 편집 and leave
the panel open → Claude Code calls the tools. The first-half conclusion below ("a relay needs a RisuAI tab open,
so do not build a second UI") is answered by not building a second UI: the panel stays the place where proposals
are approved and 반영 happens; MCP only adds a caller.

**Codex.** Same server, measured 2026-09-27 with codex-cli 0.156.1 (`codex exec` with `-c mcp_servers.risu-hina.*`
overrides): hina_status → hina_guide → load_skill → propose_lore_add → approve_proposals, entry in the working
copy. Codex takes the bearer from an environment variable, so the card offers `codex mcp add risu-hina --url
<url>/mcp --bearer-token-env-var RISUHINA_MCP_TOKEN` plus a 토큰 복사 button, and says to set the variable first.

**The add-on (`mcpaddon.py`).** Not in the release zips. `pip install --only-binary=:all: --target
<data>/addons/mcp/py3XX.new -c constraints.txt mcp==2.2.0`, where the constraints pin every distribution the running
interpreter has (so pip cannot pick a starlette FastAPI refuses); on success the folder is swapped in, copies of
packages the bundle already has at the same version are deleted, and `site.addsitedir` loads it (runs pywin32's
`.pth`, appends - bundle packages win). Measured: 38 s, ~30 packages. It lives under `data/`, so an update that
replaces `python/` does not lose it; a new Python minor shows 재설치 필요 (the folder name is the ABI tag). Removal
while loaded writes `REMOVE_ON_START` (Windows locks loaded `.pyd`s) and startup sweeps it.

**The route (`mcpserver.py`).** One exact `Route("/mcp")` inserted ahead of the catch-all dispatcher, so every
`/mcp/...` REST route is still an ordinary dispatcher route behind the backend token. Behind it: a bearer gate
with **its own token** (`data/mcp_token.txt`, `hmcp_…`, rotate = cut off every client), **required on loopback
too** — a same-host tunnel makes every request loopback, and the backend token is exempt there. Then the SDK's
lowlevel `Server` + a stateless `StreamableHTTPSessionManager` with SSE responses (sse-starlette pings every 15 s,
which is what keeps a tunnel's ~100 s idle limit away from a long `studio_generate`).

Tools = the in-panel agent's toolset (`agent.build(model=TestModel())`, so no agent preset is needed and our
model is never called), invoked through the pydantic-ai toolset with a real `RunContext(deps=Deps(...))` — same
validation, same approval queue, same `ModelRetry` text. Left out: `review_learning read_plan update_plan
recall_work save_work_state compact_context` (the panel conversation's own bookkeeping), `propose_open_tab`
(a UI move), `run_shell pip_install` (their permit prompt only shows in a panel conversation). Added:
`hina_status` (which bot/chat, switch state, queue counts — works with the switch off) and `hina_guide` (the
agent's INSTRUCTIONS + preset + skills text). `Deps.mode = ''`: no screen gate. `Deps.session_id` is a hidden
per-chat session titled `__mcp__` (`session.latest` / `list_all` skip it) so proposals, clipped outputs and jobs
have a session to hang off.

**Approving from the client (2026-09-27, the user's follow-up: "going back and forth to the panel is a chore;
use auto mode").** `approve_proposals(ids='all', approve=True)` and `approve_staged(...)` are the panel's 승인
buttons as tools: they call `main.h_action_decide` / `main.h_approve`, so the one-dirty-scope rule, the auto
checkpoint before turn edits and the conflict check all hold. They are separate from the propose_* tools so the
client's permission rules can treat "propose" and "apply" differently (Claude Code allow lists / auto mode).
Host kinds (반영 · 사본 저장 · 복제 봇) are relayed: a `host-action` job on the long poll, the plugin runs
`decideAction(id, true, chatKey, '')` (= 승인·실행, empty mode = no screen gate) only if that bot/chat is open
in the panel, reports through `/actions/complete`, and the tool waits (15 s to start, 300 s to finish). Stops at
the first failure. The panel still shows the queue and can decide there too.

**The bridge (`mcpbridge.py`, plugin `mcp.ts`).** The switch starts a long poll (`POST /mcp/bridge/poll`, held
≤ 20 s, re-issued immediately — no timer, so a hidden tab's throttling does not drop it). It carries the panel's
context (charKey, chatKey, names, screen); a context change is also pushed at once through `/mcp/bridge/activate`.
Lease = a poll in flight or ended < 45 s ago; tool calls outside it return an error telling the client to turn the
switch on. The poll returns early when (a) a host job is queued — today `write_card_to_risu`'s card save
(`session.push_stream_event` diverts `card-writeback` for `__mcp__` sessions), which the plugin runs with the
existing `requestedCardWriteback` — or (b) the pending-proposal fingerprint changed, so the agent pane and the
bars refresh their counts. Not persisted: a plugin reload leaves the switch off.

**Tests.** `tests/test_mcp.py` (gate) speaks raw JSON-RPC; `plugin_smoke` `test_mcp_switch`; one run with real
Claude Code (docs/06 §1-75). Open: the tunnel path (Cache Bypass for `/mcp` per the risk below), the 3.11 bundle.

The question that started it: the plugin reads RisuAI and pushes to the backend, and the backend pushes back the
same way. Could the plugin instead become an **API relay**, so that a browser or an IDE talks to
`http://127.0.0.1:6020` directly and RisuAI's UI stops being the only way in?

## 1. The host constraints this all sits on

Three facts decide everything below. All three are measured, not assumed.

| Fact | Where |
|---|---|
| The autosave `$effect` snapshots the **selected character's** whole `chats` array and its non-`chats` keys. So every chat of the selected bot is writable; another bot is not. | `docs/02`, `globalApi.svelte.ts:360-366`; confirmed in real use 2026-08-29 (`docs/06 §1-15`) |
| A **new `chaId`** is always encoded, so appending a bot always persists. This is why 새 봇으로 저장 clones instead of editing another bot in place. | `host.cloneBot`, `docs/06 §1-7` |
| There is **no way to change which character is selected.** RisuAI's own 2101-line `risuai.d.ts` (`vepo-bot/RisuAI/src/ts/plugins/apiV3/risuai.d.ts`) has `getCurrentCharacterIndex` and no setter; `setDatabase`'s `DatabaseSubset` allows `characters`, `characterOrder` and `selectedPersona` but no selection key; and the DOM bridge cannot click — `SafeElement` has `focus()` and `scrollIntoView()` but no `click()` and no synthetic event dispatch. | read 2026-08-29 |

## 2. The relay idea, and why it was dropped

**Shape.** The backend cannot call into the browser — no inbound, a sandboxed iframe, and every byte going through
the one `nativeFetch` channel. So a relay has to be the plugin **polling the backend for pending host jobs**.

That pattern already exists here: `permits.py`. A tool that needs shell permission registers a request and blocks,
the panel polls `GET /permits`, the user answers `POST /permits/decide`, the tool resumes. Replace "the user
decides" with "the plugin runs a `Risuai` call and posts the result" and that is the relay — one more queue, not a
new architecture.

**What it would have bought.** Splitting exactly along §1:

- **새 봇으로 저장 — any bot, selected or not.** `cloneBot` reads the source at any index and appends a copy under a
  new `chaId`, so it persists whatever is selected. The whole "list bots → pick one → copy → save as a new bot"
  flow works from outside.
- **반영 — the selected bot only**, and nothing can change the selection, so the job can only ever land on whatever
  the user happens to have open.

**Why it was dropped (user, 2026-08-29):** a RisuAI tab still has to be open somewhere for any of it, and once that
is true the current structure — the panel being the place you do this — is more intuitive than a second UI that is
only sometimes able to act. Not worth the second surface.

Also note the entry point deliberately does no work on load (`plugin/src/index.ts`: "a plugin that does work on
load slows down every RisuAI start"), so a headless poll would have to be cheap and switchable.

## 3. The half worth keeping: an MCP server on the backend

The reason this is a different proposition: **the backend is the source of truth** (`docs/02`). Everything inside
the workspace — reading, searching, editing turns, lorebook, memory, snapshots, files, the agent — needs no RisuAI
at all. RisuAI is needed at exactly two moments: the upload in and the 반영 out.

So an MCP client gets full use of the workspace with RisuAI closed, and only the last step waits for a person.
Which the 3-way merge already models: edits sit in the working copy until someone writes them back.

### What is already in place

- **Transport support on the client**: `claude mcp add` takes `stdio` (default), `sse` and `http`, with
  `--header "Authorization: Bearer ..."` and optional OAuth (checked 2026-08-29).
- **The backend is FastAPI + uvicorn** (`pyserver/app/main.py`, `run.py`), so an MCP ASGI app can be mounted.
- **Auth exists and is not the hole it looked like.** `config.token_required_for()`: non-loopback **always**
  requires the bearer token; loopback is exempt unless `RISUHINA_REQUIRE_TOKEN=1`. The `tokenRequired:false` seen
  on zikmunt-pc's `/health` was a loopback call over ssh, not public exposure.

### stdio wrapper vs HTTP — the difference is not local vs remote

A common misreading: stdio does **not** mean "same machine as the backend". It means "same machine as the MCP
client", because the client spawns the server as a subprocess and talks over its pipes. What that subprocess does
next — an HTTP call to a backend anywhere — is not MCP's business. A stdio wrapper is just another backend client,
the same standing the plugin has.

| | stdio wrapper | HTTP MCP |
|---|---|---|
| Process | spawned by the MCP client | the backend itself, a mounted route |
| Where the backend may be | anywhere reachable over HTTP | anywhere, as long as the client can reach the URL |
| New public surface | **none** | one more route |
| Clients that can use it | only those able to spawn a local process (Claude Code, Claude Desktop) — not claude.ai web or mobile | any MCP client that can reach the URL |
| Install | once per client | none, just the address |
| Backend change | none — it calls the existing REST | `mcp` dependency + mount |
| Release bundle | unaffected | dependency added to the 22/33 MB zips (hash-pinned, wheels-only — a rebuild) |

### Routes from the dev machine to zikmunt-pc

The backend there listens on `127.0.0.1:6020`, **IPv4 loopback only** (`config.HOST` default; confirmed with
`netstat` 2026-08-29), with a **Cloudflare Tunnel** in front of it as `elf.francis.kr`.

1. The tunnel address plus the token — works today, no setup.
2. `ssh -L 6020:127.0.0.1:6020 zikmunt-pc` — straight to loopback with nothing exposed.
3. **stdio over ssh**: make the MCP server command itself `ssh zikmunt-pc <remote python> mcp_server.py`. The
   wrapper runs on zikmunt-pc against real loopback and its pipes ride the ssh connection. No new port, no new
   surface. This is the recommended way to prototype.

### Two risks specific to this deployment

- **The tunnel edge caches.** It has been measured behaving like "Cache Everything + Ignore Query String" twice:
  every asset thumbnail came back as one image (0.7.2) and `/health` served a cached error page for about a minute
  (0.8.4, `docs/06 §1-12`). That is why binary and per-item reads go over POST with `no-store`. MCP streamable HTTP
  is POST plus SSE streaming, so **the cache rule (Bypass) has to be sorted out before an HTTP MCP route** —
  the dashboard recommendation is already in `docs/06 §1-10`.
- **The token is equivalent to code execution on that machine** (`run_python`), which `run.py` prints as a warning
  on any non-loopback binding. An MCP route does not change that, but it does mean any new access path has to be
  held to that standard.

### If it is picked up

1. Prototype as a **stdio wrapper over ssh**. No backend change, so an abandoned experiment costs nothing.
2. **Design the tools for a model, not for the panel.** The REST API takes opaque `chatKey` / `charKey` because a
   panel that already has them is the caller. MCP tools want a navigable shape — `list_bots` → `list_chats(bot)` →
   `search_turns(chat, q)`. The agent-side tools in `agent.py` (`list_lore`, `read_lore_entry`, `read_turns`) are
   already close to that and are the material to reuse.
3. Only then consider promoting it to a mounted HTTP route, and only after the cache rule is fixed.

## 4. Relation to `docs/07`

This is the same question `docs/07` is holding: **who reads and writes the store, with what authority.** The agent
reads a scoped copy (`.scratch/scope.db`) whose freshness stamp misses several materials; the user's proposal there
is a live read-only connection through an authorizer with every write going to the approval queue. An MCP surface
would want exactly that answer too, rather than a second set of rules. Plan them together.
