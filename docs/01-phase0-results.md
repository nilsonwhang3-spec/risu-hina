# 01. Phase 0 measurement results (complete)

Probe v0.2.0, 2026-08-23, PocketRisu (the test server 0.0.0.0:6001) + browser on a separate PC.
Backend `127.0.0.1:6020`. Run against a real chat (394 turns).

**Conclusion: the constraint table in plan §1 is confirmed in full, and streaming works. No architectural change.**

## 1. What was confirmed

| Check | Result |
|---|---|
| T-01 runtime | `platform=node · saveMethod=local · api=3.0` |
| T-02 direct fetch | **blocked** — all communication goes through the single `nativeFetch` channel |
| T-03 eval / new Function | **blocked** — the bundler must not use `eval` |
| T-04 data: images | **renders** (PocketRisu only) |
| T-05a/b `/health` | reachable · `client_ip=127.0.0.1` · `relay=none` |
| T-06 token gate | 401 without token / 200 with token |
| T-08 large payload | 512KB↑ · 1MB↓ |
| T-09 Blob download | success, UTF-8 Korean intact |
| T-10 pluginStorage | structured values round-trip unchanged |
| T-12 chat write | custom attribute round-trips + message intact + traces removed |
| T-13 write to a nonexistent index | ignored — adding a chat goes through `setCharacterToIndex` |

**PocketRisu CSP, measured in full:** `script-src 'nonce-<uuid>' 'wasm-unsafe-eval'`.
Mainline's `https:` is **absent** — loading external scripts is impossible at the source, which favours a single-file bundle.
This is what confirmed the policy stays alive even though `factory.ts` deletes `meta#csp-meta` right after boot.

## 2. Streaming — it works. But you have to pick the path

| Path | headers_ms | Arrival pattern | Verdict |
|---|---|---|---|
| `local_network` · GET · ndjson | **289** | 290·534·785·1035·1285·1536 | **adopted** |
| `local_network` · GET · sse | **286** | 286·532·784·1033·1284·1535 | equivalent (no advantage) |
| `auto` (no networkRoute) | **2318** | 2319·2563·… | flows, but **wastes 2.3 s before the first byte** |
| `local_network` · POST · `interceptor:'openai_streaming'` | 1124 | 1124·1124·1124·1124·1284·1534 | **buffered — do not use** |

**Three design decisions fixed**

1. **Attach `networkRoute:'local_network'` to every request.** Leave it out and the browser first tries a direct fetch
   and only falls back to `/proxy2` after it fails (`globalApi.svelte.ts:2108-`). That costs **about 2 seconds** per request.
2. **Do not use `interceptor:'openai_streaming'`.** It routes through the WS proxy-job path
   (`globalApi.svelte.ts:2080-2097`), and that path lumps the first 4 chunks together. Plain `/proxy2` is better.
3. **Go with NDJSON.** Same performance as SSE and simpler to parse.

### The "buffering" in v0.1.0 was a bug in the probe server

The cause was not RisuAI but **our probe server's hand-rolled chunked response + HTTP/1.1 keep-alive**.
`BaseHTTPRequestHandler` does not know we are framing it ourselves, so it left the socket to be reused,
and in that state the upstream undici only released the headers after collecting the whole body.
Adding `Connection: close` + `close_connection = True` got the first byte at 289 ms.

**Implication for the main body:** uvicorn handles chunked properly, so this most likely will not recur, but
when the NDJSON endpoint is built, **measure headers_ms on the very first deployment**. Reading the source said
no layer was buffering, and in reality it lumped.

## 3. What came out of the real chat — 2 additions to the plan

T-11: `char=17 chat=0 · 394 turns · chatId present 394/394 · memory=hypaV3`

**Actual keys of the Chat object (real 394-turn chat):**
```
message, note, name, localLore, fmIndex, id, useModelPreset, modelBinding,
scriptstate, bindedBotPreset, bindedPersona, supaMemory, hypaV3Data,
savedToggleValues, modules, isStreaming, arKey, activeStreamingDisplayOptimizationMode
```

**① At least 6 fields not in the interface are riding along.** `useModelPreset`, `modelBinding`,
`bindedBotPreset`, `savedToggleValues` and `activeStreamingDisplayOptimizationMode` are
**fields PocketRisu added; web RisuAI does not have them** (confirmed by the user). And `arKey` is
**a mark planted by active-recall** — that is, this chat object carries both *the host fork's extensions* and
*another plugin's data* on top of it.

→ **The contract runs both ways.**
- **Preservation:** `chatfmt` must not use a whitelist. Preserve everything except `message` exactly as is and
  restore it on encode. Dropping unknown fields silently destroys another plugin's data and the host's settings.
- **No fabrication:** if a chat that came from web RisuAI round-trips and comes out with PocketRisu-only fields attached,
  opening that chat in PocketRisu silently changes behaviour. Preserve only what is there and **do not create what is not.**

`test_never_invents_fields` in `tests/test_roundtrip.py` nails down key-set identity at three levels — envelope, chat and message —
using a web RisuAI-shaped chat. Plan §4 only said "every Chat field except message",
and this measurement turns that sentence into a two-way contract.

**② `chatId` is filled in 394/394.** Both the hypa `chatMemos` join and our patch targeting hold up.

T-14: `Parma Knights · 2 chats / 394 turns total · lore 81 · greeting 1 · **51 ms** ·
desc 6439 chars · firstMessage 5934 chars`

→ **`getCharacterFromIndex` takes 51 ms.** That is a cost you can pay on every load in the chat-selection tab.
The "phone killer" active-recall was wary of is `getDatabase(['characters'])` (all characters), not this one.

## 4. Corrections to the plan

- **`getCurrentChatIndex()` throws rather than returning null when no character is selected**
  (`db.characters[selectedCharID].chatPage`, `v3.svelte.ts:805-809`). The main body must wrap it too.
- **`networkRoute:'local_network'` is mandatory, not optional** (item 2 above).
- Python is **bundled (standalone)**. The rationale "the server has 3.11.9, so use that" is discarded — see `docs/00`.

## 5. Two things still unmeasured (they resolve naturally in Phase 1~2)

- **4 MB-class payloads.** The real chat is 394 turns, and by active-recall's measurements a 372-message chat was 4.1 MB of raw text.
  T-08 only measured up to 512KB↑/1MB↓. `/proxy2` is `express.json({limit:'100mb'})` and the bridge is a
  structured clone, so we consider this a quantitative difference only, but **it gets measured in Phase 2 the first time a real chat is uploaded**.
  If it blocks then, we go to chunked upload (we are not building that in advance).
- **Mainline web RisuAI** — T-04 (whether images are blocked) and §7.1 (token leak prevention, mixed content).
  PocketRisu is the main path, so this is deferred.

## 6. Two traps that came from the probe itself (do not repeat them in the main body)

1. **Falling back to `res.text()` after `res.json()` fails is impossible** — the body has already been consumed and
   you get an unrelated `Body has already been read` error. Read once and parse.
2. **A keep-alive connection is contaminated after manual chunking** — after 4 streams in a row, `/big` was truncated
   and it got **misdiagnosed** as "the download is behaving strangely". The symptom shows up somewhere entirely different from the cause.
