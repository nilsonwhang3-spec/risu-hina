# 08. Reaching the backend from outside RisuAI — an MCP surface (future, not started)

2026-08-29. A design discussion, written down so the next session does not re-derive it. **Nothing here is built**,
and the conclusion of the first half is "do not build it". The second half is the one worth picking up.

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
  on test-server's `/health` was a loopback call over ssh, not public exposure.

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

### Routes from the dev machine to test-server

The backend there listens on `127.0.0.1:6020`, **IPv4 loopback only** (`config.HOST` default; confirmed with
`netstat` 2026-08-29), with a **Cloudflare Tunnel** in front of it as `elf.example.com`.

1. The tunnel address plus the token — works today, no setup.
2. `ssh -L 6020:127.0.0.1:6020 test-server` — straight to loopback with nothing exposed.
3. **stdio over ssh**: make the MCP server command itself `ssh test-server <remote python> mcp_server.py`. The
   wrapper runs on test-server against real loopback and its pipes ride the ssh connection. No new port, no new
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
