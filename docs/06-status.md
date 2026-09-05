# 06. Implementation status — as of 2026-09-06 (v0.13.0 BETA, Risu Hina)

One page for whoever picks this up next session (= me). What exists, what changed, how far it is deployed,
and what is left. The *why* of the design is `docs/04` (assets and charx are in Appendix E), the storage layout is `docs/02`, the deployment environment is `docs/00`.
The original plan for bot edit mode (M0 measurements, M2 spec) is `~/.claude/plans/risu-hina-whimsical-lovelace.md`.

## 0. Starting point for the next session (read this first)

**Releases are manual now (2026-08-29, the user's instruction).** The plugin has users other than us, so **do not release or deploy after every fix**. Land the change, run the gate, leave it on master, and say what is waiting; `tools/release.py`, `gh release create` and the zikmunt-pc deploy happen **only when the user asks for them**. One mechanical consequence to keep in mind: `tools/bundle.py` writes `plugin/Risu.Hina.Plugin.js` (and the old-name twin) into the repository, and *that committed file is what RisuAI's `+` update check reads* — so a release is not the tag, it is that commit. An ordinary fix commit must leave those two files alone, which `node plugin/build.config.mjs` does by itself (it only writes `plugin/dist/`).

**Code state**: master = **0.11.0 (unreleased)** - §1-17 the ONE global file space (the studio-asset
branch rebased in) **+ §1-18 the tab kit · prompt cards · character reference (measured) · artifacts**
(the whole of plan risu-elf-1-distributed-magpie) **+ §1-19 the 26-item studio field report**
(names as identity · 무제 gone · PNG-embedded recipes · charref fidelity/mode measured · reference
tabs · request settings · the scoped refresh · the live queue · path copy · the documented spec)
**+ §1-20 the studio redesign, second field report** (left = 프롬프트/OUTPUT tabs with ONE style
edited in place and the character view · centre = 1장/배치/잡 히스토리 with the reservation queue
(entries jobs) · streaming previews · folder grid with drags · visible group-by and 부족분 →
reservations; plan `~/.claude/plans/zesty-dazzling-lagoon.md`) **+ §1-21 the third field report**
(tabs that read as tabs · characters picked in one place, casts gone · batch = queue only, results
as history fold-outs · no window.prompt · draggable character folders · click-select folder grid ·
token-chip grouping with 전체/그룹별 · the LRU blob cache fix · one keep-alive NAI client)
**+ §1-22 the fourth field report** (character column as list→editor · references as picture
cards with sliders, every upload a real bucketed PNG, bad references skipped not fatal · toasts ·
foldable style editor · cheap preset delete) **+ §1-23** (studio_generate waits and streams each
image into the chat · session loop flushes side events mid-tool · panel adopts agent-started jobs ·
default model, bogus model refused once · artifacts retired, inline `![](path)` with path
normalization · splitter clamp measures siblings) **+ §1-24** (검수 tab · 애셋 채택 and 봇에 반영
only in selected/ · agent → 검수 via studio_open and strip buttons · 중단 cancels the batch ·
per-panel collapse toggles · live job section in the batch tab) **+ §1-25** (log file on disk +
noise cut · bulk asset/script proposals · one card write for many assets)
**+ §1-26 the files/studio field report** (studio_v2: config/ + output/ two-tier layout with a
boot migration and path canon on every door · filebar icons + fold-out search · right-click
rename/copy/paste (`/files/copy`) · internal drag-move · the corner upload overlay with a real
progress bar · '선택' → '‹ 뒤로' + a mode chip on the tab bar · NAI prompt tints + NAI tag
autocomplete (`/studio/tag-suggest`) · markdown tints on lorebook bodies · write_file refuses
projects/ · NAI torn-connection retry + a friendly RemoteProtocolError message · the realooc
old-name note) **+ §1-27** (중단 kills the running run_python subprocess · multi-line fragments
are a random one-line pool per image (the reference tool semantics, recursive, depth 10) · the splitter
re-clamps on container resize + an actual-overflow belt, so the agent pane can no longer sit
past the right edge) **+ §1-28** (the NSFW asset-generation pitfalls SKILL seeded from the
user's try-and-error notes · ucPreset 2 = None for real · batches globally serial (429 guard) ·
agent-made files show up without a manual 새로고침) **+ §1-29 the 17-item usability batch**
(2026-09-01; plan `~/.claude/plans/risu-elf-async-melody.md`. Files: machinery default-hidden
behind ONE 숨김 파일 toggle (server filter, `hidden=1` reveals; sizes stay disk-truth) · a
document-level drop guard, so an OS file dropped on dead space no longer navigates the app away,
and the whole tree column is a drop target · count-pill inset + `scrollbar-gutter` · icon tree-head
(smoke finds them by title prefix) · tree multi-select (Ctrl/Shift) + right-click folder verbs
(two-menu delete confirm, no window.confirm) + tree keyboard Ctrl+C/X/V·Del · batched
`paths[]` move/copy/delete (one round trip, per-item failures reported, clash no longer aborts) ·
empty-space rubber-band in the centre (tree marquee ruled out: native dragstart wins). Studio:
Pillow server thumbnails (`/files/thumb`, ~360px WebP disk-cached by path+mtime+w under
`config/.studio/thumbs`, non-thumbable streams the original; **pillow joined requirements.in — 기존
설치는 재 setup**) + in-flight dedup + 45s/25s image timeouts + reserved-aspect `phbox` cells +
IntersectionObserver lazy grids · mirror tints fixed for real (scrollbar-width compensation,
`padding-block` bands + `box-decoration-break: clone`, textarea-background capture) · the 잡
히스토리 tab REPLACED by the always-visible bottom strip (newest saves, live cell with step badge;
jobSection survives as the batch live box; adoption watcher relocated to a studio-level 5s tick) ·
scene cards keep 832/1216, memoised scene→thumb map, ± patches in place · the working scene gets a
ring + step bar and the submit row a one-segment-per-image bar with a client-EMA ETA; syncLive
diff-patches instead of rebuilding every 1.5s · 검수: flag clicks patch in place (the full-redraw
lag is gone), delimiter changes only re-split the chips (reload on pick), 대표 flag (exclusive per
group, implies 채택, takes the canonical name on export — `rep` written only when set so old
selection files keep their shape) + a 대표 gallery view, 못 읽음 as a warn badge, chat auto-folds
on entering 검수 and restores on leave (manual toggle wins) · one segCtl/colPicker component for
every column row (selCols persisted for the selector). Editors: regex / regex-out (CBS · $backrefs ·
HTML comments) / lua (island scanner: cross-line strings+comments, keywords lose inside them)
tint modes on the same mirror, 집중 편집 tinted too (dom↔hilite cycle is call-time-safe) · fragment
autocomplete offers folder-qualified keys (`<폴더/조각>` already resolved server-side; the popup
dims the folder; duplicate stems get a 중복 이름 badge; `<.../이름>` NOT adopted, consistent with
the the reference tool restraint list) · neutral '선택된 … 없음' empty-hints on the three pickers. Chat: the
whole agent panel takes drops — internal rows/cells/fragment cards attach as PATH chips (no
upload; the message says read_file/list_files), card assets ride a new `DRAG_ASSETS` payload as
NAME chips (fetch_assets), OS folders now walk in via collectDrop; sources advertise `copyMove`
and targets pick the cursor.) **+ §1-30 six §1-29-use follow-ups** (2026-09-02:
studio panel toggles = VS Code-style icons on the SHELL tab row beside the 에셋 badge
(`shell.setLayoutControls`; rails + the overlay button over the agent header retired - the
overlay was most of "the right panel is hard to adjust") + an invisible 4px apron each side of
every gutter · the 검수 grouping rule folds into ONE `규칙:` button opening a popover, and its
token chips MULTI-select (1-2-3.webp groups by 1, by 2, or by 1+2 - the pattern captures each
selected position and the backend `_group_key` joins `t1+t2` composites; legacy `tokenIndex`
saves fold into `tokens[]`) · the OUTPUT tree carries the file tab's right-click folder verbs
(새 폴더 · rename · copy/cut/paste · path · zip · two-menu delete) · the files tab select-all
icon toggles to deselect and the empty-space menu gains 선택 해제.)
(gate ALL GREEN; the minor went up so the version gate trips when it ships). **Staged on zikmunt-pc
2026-08-30 night AT §1-25 (= §1-19~24 included): service stopped → backup `data-backup-20260830-s120`
(11,358 files) → app/*.py + seeds/studio-image-ops.md + tools/probe_nai.py + requirements.in scp'd,
msgpack 1.1.0 pip-installed into the bundled interpreter, the 0.11.0 dev bundle refreshed in
`data/plugin/` (712,599 B served at `/plugin.js`) → `/health` 0.11.0 · 12 workspaces ·
`/studio/status` charref:true · `?limit=` works · `/studio/job/preview` answers. **The streaming
endpoint is now MEASURED from this codebase** (two live probe jobs, tier 3, 0 Anlas): an entries-v2
job generated through `/ai/generate-image-stream` with no fallback warn, and a 28-step run showed
intermediate frames arriving per step (rev 3→27, step 2/28→26/28, preview b64 12.8→17.5 KB) through
the rev-gated poll before the final file saved. The cast label fills the filename
(프로브-probe-…), a castless entry collapses the field (probe2-…). Probe leftovers live in
`studio/images/스테이징프로브/` (2 images). The user reinstalls the dev plugin once from
`/plugin.js` (the `+` check still reads the committed 0.10.0 bundle). Still unmeasured live: a
mixed-cast multi-entry batch from the panel.** Released = **v0.10.0 BETA** (§1-16 the edit-session lifecycle: leave guard, 변경 취소, write verification, snapshot kinds - **schema 13**; the minor went up because `/workspace/dirty`, the reset payloads and the `kind` column mean the backend and the plugin go together, so **the version gate trips**: update the backend, then press `+` on the plugin in RisuAI) (§1-15 any chat opens from the picker · §1-14 the repo goes English · §1-13 3-way merge on reopen · §1-12 an intermediate cache blocking the connection (POST probe, no-store) · §1-11 one web-search tool card with three options · §1-10 built-in search measured, mobile, plugin-reload diagnosis · §1-9 search · §1-8 round 10 · §1-7 · §1-6 · §1-5; the docs/07 planning is still pending) — gate ALL GREEN. 0.7.0 changes the minor, so **the version gate trips**: raise the backend and the plugin on the RisuAI side has to be raised with `+` as well (the header says so).

**Deployment state (2026-08-25 21:01 `deploy.ps1`, verified in a new SSH session)**:

| Where | What | Notes |
|---|---|---|
| zikmunt-pc **running** | **0.11.0 (unreleased, STAGED 2026-08-30)** — scp of `app/*.py` + seeds + tools + the dev plugin bundle into `data/plugin/` (served at `/plugin.js`); service stopped, `data` backed up to `data-backup-20260830-space` (11,263 files), then the space_v1 boot migration verified: manifest 1,868 moves = the pre-inventory exactly, 0 left in the old workspaces, 34 original/ files untouched, Korean bot folders intact on disk, `/health` 0.11.0 + space path, `/diag migrated:true`, `/studio/status charref:true`. Trap found: remote `pyserver\tools` was a 20KB FILE from the 2026-08-29 staging (scp'd without the dir) — deleted, mkdir, re-sent. The user installs the 0.11.0 dev plugin once from the backend's `/plugin.js` (the `+` check reads the committed 0.10.0 bundle). Previously: **0.10.0 BETA** (2026-08-30, `/update/apply` from the release (after a staging round of the same code by scp) -> new SSH session `/health` 0.10.0 `agentReady:true` `codexEnabled:true`, 12 workspaces; schema 13 backfill verified live (chat auto 9, card auto 2 / user 1); `data-backup-20260830` was taken with the service stopped before the schema migration. The user still has to press `+` on the plugin - the minor went up, so the version gate holds the panel until then). That update overwrote the 2026-08-29 asset-studio staging (scp of `app/*.py` + seeds + a dev plugin build into `data/plugin/`, unreleased) — the studio code lives only on this branch again, while that machine’s `data/studio` (characters/ included) is still on disk. 0.9.6 was (2026-08-29, `/update/apply` → new SSH session `/health` 0.9.6 `agentReady:true` `codexEnabled:true`, 10 workspaces intact). 0.9.5 was (2026-08-29, `/update/apply` → `/health` 0.9.5 `agentReady:true`). 0.8.3 was (evening of 2026-08-28, `/update/apply` → `/health` 0.8.3 `agentReady:true`; the user's setting, which had been `provider=native`, was migrated to **mode=native** — measured remotely via `/websearch/test`: on the general agent glm-5.3-flash@ollama.com, **the Ollama cloud web_search API in 1.4 s**, a result list (including the release page body), `nativeShape=ollama` remembered). 0.8.2 was (2026-08-28, `/update/apply` → `/health` 0.8.2; confirmed `native` added to the `/websearch` provider list). 0.8.1 was (2026-08-27 23:20, `/update/apply`; `/websearch` duckduckgo and the search test OK, 9 skills seeded). 0.8.0 was (22:05). 0.7.2 was (21:45; skill default migration, POST blob verified). 0.7.1 was (21:08, the same way; `/config/test` `ok:true toolCalls:1`, hook skill seeding confirmed). 0.7.0 was (2026-08-27 20:33 — I ran `curl -X POST /update/apply` over loopback via ssh → the updater fetched the GitHub asset, installed it and restarted NSSM; new session `/health` 0.7.0 `agentReady:true`; the user only has to press `+` on the plugin in RisuAI). Before that, 0.5.2 — clean install at `D:\code\risu-hina`, **NSSM service `RisuHina`** (`cmd.exe /c start.bat 6020`, Automatic, the same way as ActiveRecall and risuai). On the night of 2026-08-26, over ssh: removed the damaged `pyserver\python` → unpacked the 0.5.2 zip over the folder (keeping `data/`) → `nssm stop/start` → confirmed `/health` 0.5.2 `agentReady:true` | Old data at `D:\code\risu-elf-backup\data` (**not migrated** — to move it, stop the service first; the first startup adopts `risuelf.db→risuhina.db`) |
| zikmunt-pc config | `pocketrisu.savePath = D:\code\risu-nodeonly\Risuai-NodeOnly\save` → `/diag` `fastPath:true, serverWrite:true` | Reads the PocketRisu on the same PC directly through SQLite |
| GitHub releases | **v0.9.6 · BETA Latest** (2026-08-29, commit `1abd018` — plugin-only change; the backend moved by its version number alone, so the patch level does not trip the gate and `+` on the plugin is enough) · v0.9.5 (2026-08-29, commit `cc7f403`) · v0.9.4 · v0.9.3 · v0.9.2 · v0.9.1 · v0.9.0 · v0.8.4 · v0.8.3 (2026-08-28, commit `32dca6e`) · v0.8.2 (commit `28a2073`) · v0.8.1 (2026-08-27 23:19) · v0.8.0 · v0.7.2 · v0.7.1 · v0.7.0 (2026-08-27 20:32, 4 assets, done by me directly with `gh release create` — it went through even in auto mode; the notes go in the scratchpad because `tools/bundle.py` empties `release/`) · v0.6.2 · v0.6.1 · v0.6.0 · v0.5.2 · … · v0.1.0 | `gh release create` is blocked by the auto-mode classifier — in manual permission mode I run it myself (0.3.1, 0.3.2). zikmunt-pc has 0.3.2 deployed and verified, and the raw URL is 0.3.2 too |
| Plugin installed in RisuAI | **0.3.1 has to be reinstalled by hand once** — the installed copy's `//@update-url` is a release URL with no CORS, so `+` never appears (docs/04 B.4) | After that it is the raw URL, so `+` appears |

**0.3.2 (night of 2026-08-25)** — first real use: 312 images for a bot in the PC browser (risu.xyz) in 0.6 s, 2980 images for `office counseling` on the iPhone (risu.xyz) in 5.3 s, all `fast=N` (cache hits in the PocketRisu `risuai.db` on the same PC, zero browser transfer). The user suspected "it read them as if connected from PocketRisu" → confirmed the bytes are identical since the key is SHA-256, then made `assets.store_bytes` verify **key hash = byte hash** (rejecting regardless of origin) and made the sync line state the origin (PocketRisu DB / hub / this browser) (docs/04 E.2). The fast path is read-only, and writes always go only to the connected client.

**0.3.1 (night of 2026-08-25)** — the real reason `+` never appeared was not "same version" but **CORS**: RisuAI reads `//@update-url` with a browser `fetch`, and the redirect response from the release URL carries no CORS header. Changed `//@update-url` to
`https://raw.githubusercontent.com/nilsonwhang3-spec/risu-hina/master/plugin/Risu.Hina.Plugin.js`, and made `tools/bundle.py` write that file into the repository (included in the release commit). In the backend code only VERSION changed.

**+ §1-38 (2026-09-06, 0.13.0)**: ① **Gemini 3 thought signatures.** A user hit `400 Function
call is missing a thought_signature in functionCall parts … default_api:list_lore, position 8`
on gemini-3.8-flash. Cause: Gemini's OpenAI-compatible endpoint returns
`extra_content.google.thought_signature` on every tool call and requires it back when the
history is replayed; pydantic-ai 2.33's OpenAI chat model has no code for the field, so the
second model call of any tool-using turn failed. Fix: `app/toolsigs.py` - `capture` reads the
field off plain responses and streamed deltas (a `_StreamProxy` that maps index→id for
signatures arriving on a later delta), `remember` keeps it by tool_call_id in the new
`tool_sigs` table (the history is persisted and replayed across turns/sessions; pruned after
30 days), `attach` puts it back on the request's assistant tool calls; wired in `agent._client`'s
existing `create` wrapper, chat/completions only. `tests/test_toolsigs.py` joins the gate. ②
**"제안 10 대기 … 이거 어케 함".** The bars counted every pending proposal of the bot; the
agent panel's approval card only ever listed the ACTIVE chat's, so proposals from other chats
or ended sessions piled up behind a number nobody could act on. `GET /actions?charKey=` lists
them all (with `chatKey`/`chatName`), `POST /actions/clear {charKey}` rejects them all, and the
chip is a button (`ui/pendingpop.ts`, `syncPendingChip` on both bars): a popover with per-row
거절 everywhere, 승인 where the proposal's chat is the open one, and 전체 거절. MINOR bump
(0.13.0): the plugin calls the new listing.

**+ §1-37 (2026-09-05, unreleased)**: multi-file delete from the row context menu - "press the
red button on the bar" pointed at a bar that had wrapped or scrolled away; the menu now opens
the tree's two-menu confirm (`정말 삭제 (N개)`) at the cursor and runs `runDelete`.

**+ §1-36 (2026-09-05, two more, unreleased)**: ① "1 in the workspace - but where?": the tab
badge no longer clears on opening the files tab; an unseen file keeps a red dot on its row and
on every folder above it in the tree (`TreeNode.dot`, `state.hasUnseenUnder`), and looking at
a folder (`selectTreeFolder` → `state.markOutputsSeenIn`) is what marks its files seen. ② the
bot's own folders are the default view: `onlyMine` defaults to true and the button offers
`전체 보기` (or `이 봇만` once everything shows); remembered in `hina.filesOnlyMine`.

**+ §1-35 (2026-09-05, three more, unreleased)**: ① `⚙ 요청 설정` is a third tool button
in the left 프롬프트 column (with 캐릭터 · 조각), gone from the 1장 and 배치 toolbars - the
request parameters belong with the material, not with whichever view is open. ② the centre
still would not shrink under a long history: `.split > .left { contain: inline-size }` -
the centre's floor is its `min-width` (260px) and nothing its content says; the strip fix
(§1-34) was one instance of the general rule. ③ Ctrl+C / Ctrl+X / Ctrl+V everywhere files
are listed: the files tab's centre list already had the keys but lost focus on the redraw
after every click (fixed like the tree: `drawCentre` refocuses the list; rows and cells
show `clipcut`/`clipcopy`); the studio gains ONE clipboard (`left-output.setClip/pasteIn/
clipClass`) used by the OUTPUT tree (`mount.onkeydown`, the selected folder; roots are not
cut) and the 정리 grid (its selection; Ctrl+V pastes into the open folder; Escape clears),
with `index.drawLeft` refocusing the selected row. Smoke: 요청 설정 is looked for in
`.explorer`.

**+ §1-34 (2026-09-05, four first-use reports on §1-33, unreleased)**: ① the bot portrait
blinked while assets synced - every settled emit rebuilt the picker and re-read the portrait
through the host bridge (initials → picture → initials); `tab-chats.loadPortrait` keeps ONE
decoded `<img>` per path and moves it into place on a rebuild. ② with 38 cells in the bottom
strip the centre went fixed-width and the agent gutter would not drag: `min-width:0` (§1-32)
did not stop the strip's 2254px intrinsic width from propagating through `.left` and
`.panel`; `.genstrip { contain: inline-size }` does (harness: centre 2254 → 950). ③ automatic
temp cleanup: `files.sweep_temp` (hina/<봇>/scratch older than 7 days, scripts older than 30,
`.part` fragments older than a day; deliverables and the studio never), `files.auto_clean`
reads `config workspace.autoClean {scratchDays, scriptsDays, everyHours}`, `main._auto_clean_loop`
runs it at boot and every 6h. ④ Ctrl+C / Ctrl+X in the tree did nothing visible: the click
that selected the row also rebuilt the tree, focus fell to `<body>`, and the key never reached
the tree; `drawTree` restores focus to the selected row, and the rows show the clipboard
(`clipcut` dims, `clipcopy` dashed) via `TreeNode.cls`. `test_files` covers the sweep.

**+ §1-33 (2026-09-05, unreleased — the file-space cleanup + a real-browser UI pass)**: the
user's two asks. (1) *Files.* The agent's `hina/<봇>/` is INTERNAL now: the files tab hides it
behind the one 숨김 toggle (`DEFAULT_AREAS` = projects·studio; `USER_AREAS` still says where
drops may land), the 임시 문서 virtual folder is gone (3,104 "documents" on the real install
= noise), and **deliverables live in `projects/<봇>/out/`** (`workspace.out_dir/out_rel`;
`write_out`, `write_artifact`, the charx build, the sandbox helper `risuhina.out()` via
`RISUHINA_OUT`, `clean_bot(["out"])`, the agent prompt + `write_file`'s one carve-out under
projects/, the panel's out/-watcher on `(projects|hina)/*/out/`). Boot migration **`out_v3`**
(`migrate_out_v3`, manifest `.hina/migration-out_v3.json`, `_move_tree` = never overwrite).
`write_out` keeps Hangul names (the ASCII `SAFE` made 보고서.md into `___.md`). `studio_generate`
without a folder lands in `studio/output/<봇폴더>/`. Files tab: **"이 봇만"** toggle
(`GET /files?bot=` answers `botFolder`; projects/·hina/ narrowed to it, persisted), the
three-line how-to paragraph folded into one line + `ⓘ 사용법`, a folder of pictures gets
**"검수 열기 (에셋 스튜디오)"** in its right-click menu (`openTabRequest='studio'` +
`requestOpenStudio`). (2) *검수 anywhere.* The studio pins folders outside OUTPUT
(`store.extraPaths` in `hina.studioExtraFolders`, `S.extraRoots` built from one prefix listing
each, `find()` searches every root); the OUTPUT tab shows them under **다른 폴더** with a
`폴더 열기…` picker (every space folder that directly holds pictures) and 목록에서 빼기; the
backend never cared (`_rel` passes projects/·hina/ through). (3) *The 검수 rule.* The summary
button says what it produced (`규칙: 자동 → 그룹 6`), the popover shows ANY file as the sample
(‹ ›), the tokens as a chip strip joined by the delimiter glyph with index badges, a 묶는 기준
segment for 자동 mode (감정 · 캐릭터 · 캐릭터+감정), and a live result line (그룹 N · 못 읽음 M,
plus "장마다 그룹 하나" when the rule is too fine); 못 읽음 is a button into the popover and the
unmatched section has 규칙 바꾸기. (4) *Layout, measured in the harness at 1254px.* The
selector toolbar is two rows (head: 정리 · path · rule · 못 읽음; tools: view · columns · bulk ·
애셋 채택), the path title no longer shouts (`.sectiontitle.path`, the uppercase turned v3 into
V3), columns default to **자동** (`auto-fill, minmax(190px,1fr)`; `selCols` 0). **The real
overflow bug**: two splitters each clamped its stored width against the OTHER's current one
(stored widths arrive async; a hidden panel measures 0), so tree 384 + agent 627 overflowed
a 1254px viewport by 37px and the agent pane sat past the edge. `splitter.ts` now keeps a
per-container registry, `applyAll` re-clamps the siblings, the belt measures overflow against
the nearest clipping ancestor / viewport (the split and its `.panel` both grow), a hidden
split (span 0) is left alone, observers watch the viewport + the split itself, and `shell.setTab`
re-clamps the shown split at 0/800ms (ResizeObservers only run while the tab is painted -
the harness in a background tab proved it). `reclamp()` is also called by the fold toggles.
Tab rows hide their scrollbar and `setTab` scrolls the lit tab into view (phone). Tests: the
smoke's files section seeds `projects/Parma Knights/out`, expects hina/ hidden and 이 봇만,
and reads chips by their `.idx` badge; `test_files` covers `out_dir`/`write_out`/`out_v3`.
Gate ALL GREEN (test_http re-run after the charx path fix). **Unreleased, not staged.**

**+ §1-32 (2026-09-03 night, 0.11.1)**: `.split` and the bottom `.genstrip`/`.striprow` carry
`min-width: 0` - a long strip of cells is a scroll container whose intrinsic width sized the
split's min-content, so the centre grew past the screen and pushed the agent pane off it · a
RUNNING asset sync emits with `state.emitReason = 'assetSync'` and the shell answers it with the
badge + an in-place swap of the picker's one `.assetsync` line (`tab-chats.refreshAssetSyncLine`)
instead of `renderActive()` - the 400ms full rebuild (portrait reload included) was the flicker
on the 선택 screen; settled syncs still emit plainly and take the full path.

**+ §1-31 the release round (2026-09-03)**: the agent's prompt and welcome follow the ACTIVE
TAB's half (`shell.activeHalf`: 봇 on a bot tab, 챗 on a chat tab; synced on every mount since
`load()` dedupes renders) · the cast list is dense rows with a slide toggle (`listRow` grew
`toggle.style: 'switch'` + `cls`; `.switch` CSS) · the fold icons are on the tab row for EVERY
three-pane tab (`panes.installFoldControls`, one remembered state `hina.panelFold`; the shell
re-installs them after a render that reused a cached split; the studio opts out and keeps its
own auto-fold) · the fragment organizer auto-folds the chat like 검수 and the list column is
220px (the "half width" was the agent pane's 50% default) · **Codex login ships ON**
(`OPENAI_CODEX` default 1; a hand-edited 0 turns it off; `codexEnabled` on /health), the card
carries the responsibility caveat with the parenthesis in `<strong>`, and the `originator` on the
authorization URL and every request is **`risu-hina`** (the OAuth client id stays Codex CLI's
public app id - OpenAI issues no other for this flow) · the name sweep: no other program or
plugin is named in code, comments, tests or tracked docs any more (the NovelAI reference tool
became "the reference tool"; the two provider profiles for the opencode.ai API endpoints stay,
they are a vendor, not a benchmark). Two OLD commit messages still name other programs and are
left as history (no rewrite of a public master). Smoke: +11 checks (placeholder per half, fold
icons outside the studio, compact rows + switch, the caveat card and its `<strong>`).

**Handoff 2026-08-31 (the studio feedback marathon, §1-19 ~ §1-25).** Where the next session picks up:

- **State (2026-09-06, later)**: **v0.13.0 BETA RELEASED** = §1-38 (Gemini thought signatures
  round-trip via `toolsigs.py` + `tool_sigs` table; the "제안 N 대기" chip opens a bot-wide
  proposal popover with reject/approve/전체 거절). MINOR: backend, then plugin `+`.
- **State (2026-09-06)**: **v0.12.0 BETA RELEASED** = §1-33 ~ §1-37 (the file-space cleanup,
  검수 anywhere, the rule popover, the two-splitter overflow, the portrait blink, strip/centre
  containment, the auto temp sweep, clipboard keys everywhere, red dots for unseen files, 이 봇만
  by default, the row-menu delete confirm). The MINOR went up: backend and plugin go together
  (`/files?bot=`, deliverables in `projects/<봇>/out/`, `out_v3`), so the version gate trips -
  update the backend, then `+` on the plugin. Release notes: the scratchpad `notes-0.12.0.md`
  (bundle.py empties `release/`). zikmunt-pc: deployed by `/update/apply` after the release.
- **State (2026-09-05, later)**: + **§1-34** (portrait blink, strip containment, auto temp
  sweep, tree clipboard focus) - restaged on zikmunt-pc the same way.
- **State (2026-09-05)**: master = 0.11.1 + **§1-33 unreleased** (files: hina/ hidden,
  deliverables in `projects/<봇>/out/` with the `out_v3` boot migration, 이 봇만, 검수 on any
  folder, the rule popover redone, the two-splitter overflow fixed). When it ships the
  backend and plugin go together (the out/ move + `?bot=`), so bump the MINOR. The live
  site at 2026-09-05 06:40 KST ran 0.11.1 on both ends (zikmunt-pc updated by the user).
- **State (2026-09-03 night)**: master = **0.11.1 RELEASED** (§1-32, two first-use fixes on 0.11.0: the split no longer grows past the screen because of the bottom strip; a running asset sync no longer rebuilds the 선택 page every 400ms). 0.11.0 (`31d7a71`) was released earlier the same evening and hand-deployed to zikmunt-pc (backup `data-backup-20260903`, six app modules + the bundle to `data/plugin/`, `/plugin.js` hash = release bundle). 0.11.1 is a PATCH: the version gate stays quiet, so zikmunt-pc updates through 설정 → 백엔드 업데이트 (release assets) and the plugin through `+`. The user's next action: update both, then the Codex originator real-use check.
  (2026-08-31 night: stop → backup `data-backup-20260831` (20,576 files) → 10 app modules + 2
  seeds + the 764,648B dev bundle → start; verified live: `/health` 0.11.0, **studio_v2 moved
  1,809 files into config/+output/** (manifest 511KB), skills seed v6 landed the NSFW skill,
  `/studio/tag-suggest` answered real NovelAI candidates in 763ms. Service `RisuHina`, dev
  bundle served at `/plugin.js`; older backups `data-backup-20260830-*` s120/r3~r7 plus
  `data-backup-20260831` can be pruned once the user is happy). The design record for
  the whole redesign is `~/.claude/plans/zesty-dazzling-lagoon.md`; each round's ledger is
  §1-20~§1-25 below.
- **The user's next actions**: reinstall the dev plugin once from the backend's `/plugin.js`
  (the `+` check still reads the committed 0.10.0 bundle), then use the studio for real.
- **Waiting to be measured live** (needs the user's bot open / real use):
  ① a BULK approval - 여러 에셋을 `propose_assets_add`/`propose_scripts_delete` 한 카드로 제안받아
  전체 승인 (§1-25's one-card-write path; watch `data/logs/risuhina.log`, which now keeps the
  whole story) · ② a multi-entry batch driven from the 배치 tab (reservations across presets)
  · ③ streaming previews and the chat narration during an agent-run batch (§1-23) · ④ 검수 tab
  round trip: 폴더 → 그룹별 검수 → 애셋 채택 → selected/ → 봇에 반영.
- **When feedback comes back**: continue the ledger at **§1-26**, same shape (one commit per
  round, gate, restage by [[risu-hina-staging-deploy]]-style scp - stop → backup → copy changed
  `app/*.py` + `plugin/dist` bundle → start → `/health`).
- **Release only when the user asks** (§5-1 has the procedure; the version gate will trip -
  minor went up - so the backend and the plugin `+` go together).
- Historical note kept below: the one-time manual reinstall advice for 0.1.0-era installs.

→ (historical) **First thing to do**: the user reinstalls `plugin/Risu.Hina.Plugin.js` into RisuAI **by hand, once** (the installed 0.1.0's update-url cannot be read because of CORS) → check that `+` appears from the next release on → verify M2 in real use (§5-2).

## 1-32. 2026-09-03 (night) - 0.11.1: the strip that widened the split, the sync that flickered the picker

Two items from the first minutes of 0.11.0 in use, one patch release.

- **The centre grew past the screen in the studio** once the bottom strip held a batch's worth of
  results. Cause: `.striprow` is `overflow-x: auto`, but a scroll container's intrinsic width is
  still its content's, and `.split` (a flex item of `.panel.active`) had `min-width: auto` - so
  the split's min-content became the strip's full width, the split refused to shrink, and the
  agent pane went off the right edge. Fix: `min-width: 0` on `.split`, `.genstrip` and
  `.striprow` (plus `max-width: 100%` on the strip). Not measurable in the smoke (no layout);
  reasoned from the flexbox min-size rules and to be confirmed in use.
- **The 선택 screen flickered while assets synced.** Every progress emit (throttled to 400ms)
  went through the shell's generic `renderActive()`, which rebuilt the whole picker - the bot
  card's portrait re-fetched as a blob each time, the snapshot list re-mounted, and the page
  moved. Now a running sync sets `state.emitReason = 'assetSync'` for the span of its emit; the
  shell refreshes the tab-row badge and, on the picker, swaps only the `.assetsync` line
  (`refreshAssetSyncLine`); other tabs ignore the tick. A settled sync (done/error/cancelled)
  emits without a reason and takes the full path, so the assets tab's keyed render still sees
  `finishedAt` move.

**Status**: tsc · build · smoke green; version 0.11.1 in the four places (package.json,
package-lock ×2, config.py); gate → release commit → tag → push → `gh release create`.

## 1-31. 2026-09-03 - 0.11.0 RELEASE: seven pre-release fixes and the name sweep

The user's "몇가지만 추가 수정하고 릴리즈" round, one commit = the release commit.

- **The agent's copy follows the half in front of the user.** The compose box said "챗에서 …"
  while a bot card was being edited. `shell.activeHalf()` answers 봇 for a bot tab and 챗 for a
  chat tab (falling back to the mode chip elsewhere), and both the placeholder and the welcome's
  three examples read it. It is re-synced on every `mountAgent` because `load()` dedupes renders
  and a tab switch is exactly what changes the half.
- **The cast list is a list, not a settings page**: `listRow` learned `cls` (the row gets
  `compact`: 3px padding, 11px hint) and `toggle.style: 'switch'` (a hidden checkbox under a
  28×16 knob; clicks stop at the label so the row's own click stays a select). Only 캐릭터 uses it
  so far; skills and presets keep their checkboxes.
- **Fold icons everywhere.** `panes.installFoldControls(root)` puts the two `.laybtn` icons on the
  shell tab row for any `threePane` split and applies one remembered state (`hina.panelFold`,
  shared across tabs). Cached splits (the kit tabs and the editor keep theirs) are covered by the
  shell re-installing after `renderActive`. The studio passes `{ controls: false }` and keeps its
  own state, because 검수 (and now the fragment organizer) auto-fold there.
- **The fragment organizer had half the screen** because the agent pane takes 50% by default;
  it now auto-folds the chat the way 검수 does (manual toggle wins, leaving restores), the list
  column is 220px, the editor takes the rest and its textarea starts at 50vh.
- **Codex login on by default.** `config.DEFAULTS["OPENAI_CODEX"] = 1`; `codex_enabled()` reads
  the flag with 1 as the fallback; the only way off is a hand-edited 0 (a settings patch still
  cannot reach a top-level key - asserted). The card says how the login works and carries the
  caveat verbatim: "오픈소스 에이전트 프로그램에서 Codex 구독 사용은 명시적으로 허용되지 않았습니다.
  개인의 책임하에 사용해 주세요." with **(특히 챗챈에서 언급은 자제하여 주십시오.)** in `<strong>`.
- **No disguise.** The module presented itself as another program (`originator: codex_cli_rs`).
  It is `risu-hina` now, on the authorization URL and on every request header. What cannot change
  is the OAuth `client_id`: it is Codex CLI's public app id, and OpenAI issues no other for this
  flow - the docstring says so instead of implying otherwise. Whether the backend accepts an
  unfamiliar originator is the one thing this session could not measure (no login here); the
  user's real-use test covers it, and the fallback is one constant.
- **The name sweep.** Every mention of another RisuAI plugin or tool in code, comments, tests,
  smoke and tracked docs is gone (40+ sites; the NovelAI reference tool is "the reference tool",
  its GitHub URL and zip path dropped, the user-facing scene error and the agent's system prompt
  no longer name it). Kept on purpose: the two `PROFILES` for the opencode.ai API endpoints -
  they are a vendor's service the user can point a preset at, not a benchmark. Two old commit
  messages (the providers commit, the docs-naming commit) still carry names; rewriting a public
  master's history for that is not worth the update-url breakage, so they stay.

**Status**: tsc · build · test_http (codex flag flipped: template ships 1, hand edit 0 verified on
its own server, originator asserted) · test_providers · smoke (600+11) green piecewise; the gate
runs once more before the release commit. Release = `tools/release.py` → gate → commit (the two
committed plugin bundles included) → tag `v0.11.0` → push → `gh release create`.

## 1-30. 2026-09-02 - 0.11.0 (unreleased, continued): panel toggles on the tab row, the compact multi-token rule, OUTPUT-tree verbs

Six follow-ups from §1-29's first real use, one commit.

- **Panel toggles are VS Code-style icons on the SHELL tab row** (beside the 에셋 sync badge;
  `shell.setLayoutControls`, the studio registers them on every render): the slim rails and the
  button floating over the agent header are gone - that overlay sat on the agent's own controls
  and was most of "the right panel is hard to adjust". Every splitter gutter also grew an
  invisible 4px apron per side (a 5px line is honest to look at and mean to grab). 검수's
  auto-fold reads back into the icons' on-state, and a manual toggle still wins.
- **The 검수 grouping rule folds into ONE compact button** (`규칙: - · 1+2번째`) opening a
  popover: delimiter, token chips, 자동, and the raw regex behind 고급. The old full-width row
  of labels + chips ate two lines above every grid.
- **Token chips MULTI-select** (the user's ask: `1-2-3.webp` must group by 1, by 2, or by 1 AND
  2): the delim pattern captures every selected position (`t1`, `t2`, …) and the backend joins
  `t1+t2` composites with '-' (`_group_key` - a display/grouping key, not a filename). Legacy
  single-`tokenIndex` saves fold into `tokens[]` on read; a chip toggle applies after a 350ms
  debounce and the popover survives the redraw.
- **The OUTPUT tree carries the file tab's right-click folder verbs** (검수 열기 · 새 폴더 ·
  rename · copy/cut/paste on a studio-side clipboard · 경로 복사 · zip · the two-menu delete
  confirm) - same shared tree component, same conventions.
- The files tab's select-all icon **toggles** (everything selected → the same button deselects)
  and the empty-space context menu gains 선택 해제.
- Smoke pins moved with the UI: the rail checks became header `.laybtn` fold/unfold clicks, the
  token chips are found inside the rule popover (multi-select asserted: a `하나-교복` composite
  card), and the rule row is asserted as one `.rulebtn`.

**Status (2026-09-03, session ended on the user's 문서화-하고-종료 - START HERE)**: all six items
are implemented and UNCOMMITTED in the working tree (last commit = §1-29's docs `9dcf825`).
Verified piecewise green: tsc, the build, every backend suite (test_studio incl. the composite-key
test) inside the one full gate run - whose ONLY failure was a smoke ASSERTION typo: the
multi-select check looked for `히나-교복` (the backend fixture's name) while the smoke fixture is
`하나-…`; the failure detail itself showed the feature working (`규칙: - · 1+2번째`, groups
`하나-happy`/`하나-교복`). After the one-character fix the smoke suite re-ran standalone to
**PASS (600 checks, the multi-select check ok)**. What did NOT happen: one continuous
`gate.sh` ALL GREEN, and the §1-30 commit. **Next session: `bash tests/gate.sh` once (expect ALL
GREEN), then commit §1-30 as one commit.** Trap reminder: a killed gate/smoke can orphan a
`node tests/plugin_smoke.mjs` process that makes the NEXT gate hang forever - none left this
time (checked), but look at `tasklist` before running.

**Closed 2026-09-03**: `gate.sh` ALL GREEN in one continuous run, §1-30 committed. The "hang"
had a cause, not just a trap: the smoke printed PASS and then never exited - the plugin leaves
timers alive (sync polling, thumbnail LRU) and the script had no `process.exit(0)` after the
verdict, so every gate since §1-29 stalled on its last line until the harness killed it. Fixed
in the same commit (explicit exit after PASS); an orphaned smoke is no longer expected.

## 1-29. 2026-09-01 - 0.11.0 (unreleased, continued): the 17-item usability batch (tree · thumbnails · bottom strip · 검수 · code tints · chat drops)

Seventeen items of real-use feedback, one working session, plan `~/.claude/plans/risu-elf-async-melody.md`
(the full §0 chain entry carries the per-item summary). The record-worthy decisions:

- **Tree clutter is a DISPLAY filter, not a move** (the user chose this over relocating
  `.studio`/skills out of the space): `files.listing(include_hidden=)` skips dot components
  (leaf included) + `hina/<bot>/skills/**` + the three regenerated helper scripts, counts them
  per area, and the one 숨김 파일 toggle sends `hidden=1`. Sizes stay disk-truth. `_hidden`
  (search) is unchanged and spares the leaf; the listing filter deliberately does not.
- **Thumbnails are server-side** (the user chose Pillow): `/files/thumb` is REGISTERED IN THE
  ROUTES TABLE like `/files/download` — the table doubles as the allow-list and an unregistered
  raw route 404s "no route" before the special-cases run (found the hard way: the markdown-image
  smoke check was the only caller that asserted an actual `<img>`). Pillow missing / non-image /
  decode failure all stream the original bytes, so the route can never break a picture.
  **pillow==11.3.0 joined requirements.in: existing installs need a re-setup** (release note).
- **`<.../이름>` recursive fragment lookup NOT adopted** (consistent with the the reference tool restraint
  list further up): the backend already resolves `<폴더/조각>`, the actual gap was the completer
  never offering folder-qualified keys. Duplicate stems now carry a 중복 이름 badge instead of a
  silent first-match.
- **No tree marquee**: every row/cell is `draggable`, and a native dragstart fires before any
  movement threshold can be judged — the centre rubber-band therefore starts from EMPTY space
  only, and the tree (nested `<button>`s in a 210px column) keeps Ctrl/Shift + the context menu.
- **`rep` is written only when set**, so three-flag-era selection files and the pinned test
  shapes stay byte-identical; on export the rep takes the canonical name via a sort key that
  degenerates to the old filename order without one.
- Smoke pins that moved with the UI: tree-head buttons are found **by title prefix**
  (`findByTitle`), the tab list is three tabs + `.genstrip`, `.selflags` is 4 buttons, the
  숨김 파일 toggle label, and the history-sections test became the bottom-strip test.

Not done here (deliberate): storage relocation of machinery (rejected), per-category danbooru
tint colours (NAI suggest-tags drops `category`; a 1-line pass-through when wanted), md/nai
집중 편집 tints (only code modes wired), marquee edge auto-scroll.

**Staged on zikmunt-pc 2026-09-02 (commit 9c22085)**: stop → backup `data-backup-20260902`
(20,590 files) → files.py/main.py/studio.py + requirements.in → **pillow 11.3.0 pip-installed
into the bundled interpreter** → dev bundle 803,875 B into `data/plugin/` → start. Verified:
`/health` 0.11.0 · a real probe image (`스테이징프로브/probe2-…png`, 1.9 MB) answers `/files/thumb`
as **16 KB image/webp** · `?hidden=1` carries the per-area `hidden` counts · the once-missing
route registration answers ("no such file", not "no route"). The user reinstalls the dev plugin
once from `/plugin.js` (the §1-29 UI ships in the bundle). Release still waits on the user —
the release note must say existing installs re-run setup for pillow.

## 1-28. 2026-08-31 - 0.11.0 (unreleased, continued): the NSFW-assets skill, ucPreset 2, serial batches, no-refresh file visibility

The user's generation try-and-error notes become a SKILL, plus one bug ("파일을 생성하면
새로고침 해야 보임"). One commit, gate ALL GREEN. Staged to zikmunt-pc 2026-08-31 night
together with §1-26·§1-27 (see §0 Handoff for the verified record).

- **New seeded skill "NSFW 에셋 생성 함정"** (`seeds/studio-nsfw-assets.md`, SEED_KEY → v6 so
  existing installs gain it on next boot; name-deduped). The user's document, adapted to this
  backend: charref letterbox rule (contain into 1024×1536, never crop) · the ucPreset table with
  the recipe-verification step (`studio_recipe` → `parameters.uc` must not start with `nsfw,`)
  · never `male`/`boy` in negatives (they suppress the man; fix the partner in positive) ·
  female-charref solo-composition bias countermeasures (1boy/hetero up front, full body wide
  shot, adhoc male, slightly lower ref strength) · partially-undressed vs nude variant prompts ·
  style/composition tag separation for two-person scenes · serial batches with Anlas
  before/after checks · the pre-flight checklist and the post-generation recipe/image checks.
  studio_generate's docstring points at the skill for NSFW runs.
- **ucPreset 2 is None for real** (`nai.UC_PRESETS[2] = ""`): the ecosystem numbering
  (novelai-python, koishi bot - 0 Heavy · 1 Light · 2 None · 3 Human Focus) said 2, our table
  only had 4; a spec saying 2 fell through `get()`'s default only by luck. Both are explicit
  now, 3 stays Human Focus, tests pin all three.
- **Batches are globally serial** (`studiojob._GEN_GATE`): NovelAI locks concurrent generation
  per account (HTTP 429 / "Concurrent generation is locked" from the user's parallel job
  registrations), so a job now waits its turn - state stays `pending` while queued (the panel
  reads 대기), 취소 still works in the queue, and the agent docstring says to check one batch's
  results before starting the next. test_studio proves two jobs never overlap a generation.
- **Files show up without 새로고침**: the agent panel's out/-watcher only saw `hina/*/out`, so
  a write_file into studio/ or a script's scratch/ product stayed invisible until the manual
  refresh. Now every `images` stream event bumps `touchFiles(paths)` mid-turn and every `done`
  bumps `touchFiles()` once - the files tab (filesRev key) and the studio (renderedRev guard)
  re-read on their own. Panel-driven batch completion already did this (gen.ts touchQuiet).

## 1-27. 2026-08-31 - 0.11.0 (unreleased, continued): abort kills scripts, fragment random lines, splitter re-clamp

Three items from the §1-26 round's use, one commit, gate ALL GREEN. Staged 2026-08-31 night
(with §1-26 and §1-28).

- **중단 now kills a running script** ("AI 스크립트 중일 때 중단 요청해도 중단이 잘 안됨"): the
  abort closed the NDJSON stream and set `_STOPPED`, but `run_python`'s tool thread sat in
  `subprocess.run` until the child finished on its own. `pyexec` now uses Popen, registers the
  process per session (`_RUNNING`), and `session.run`'s abort path calls `pyexec.abort(session_id)`
  right after `_STOPPED.add` - the child dies (the audit hook already forbids grandchildren, so
  nothing survives it), and the result comes back `aborted: true` with "사용자가 중단해서
  스크립트를 종료했습니다" instead of reading as a crash. `tests/test_sandbox.py` proves the kill
  lands well before the timeout.
- **Multi-line fragments are a random pool** ("여러 줄 조각은 그중 1줄만 적용되는 랜덤"): the reference tool's
  wildcard semantic, now in `studio.resolve_refs` - candidates are the body's lines with blanks
  and `#` comment lines dropped (`_fragment_lines` = the reference tool contentToLines), ONE line picked per
  resolution (plan() resolves per image, so each image of a batch rolls its own), and the picked
  line's own `<참조>` resolve recursively (depth 10, the reference tool's guard). A body that is all comments
  contributes ''. `rng` hook for deterministic tests; single-line fragments unchanged. The
  editors' hints and studio_plan's docstring say the rule. NOT adopted (undocumented to users,
  can come later if asked): `<*이름>` sequential, `<a|b|c>` inline, `(a/b)` wildcards.
- **The splitter can no longer push the agent pane off-screen** (studio 1장/배치 report): the
  `.right` basis is a stored PX with flex-shrink 0, and nothing re-clamped it when the CONTAINER
  narrowed (RisuAI window resize, a rail collapse) - the §1-23 clamp only ran at drag time. A
  ResizeObserver on the container re-applies the clamp when its span moves (guarded against
  basis-change refires; the stored preference is untouched so widening restores), and apply()
  grew a belt: after the basis lands, actual `scrollWidth - clientWidth` overflow is taken back
  out of the target - covering any child whose intrinsic min-content beats the 260px floor guess.
  Horizontal only; the stacked mobile column scrolls by design.

## 1-26. 2026-08-31 - 0.11.0 (unreleased, continued): the files/studio field report (14 items + 2 agent errors)

Fourteen usability items from real use plus two errors the agent itself reported, one commit,
gate ALL GREEN (real-model agent test included). Staged 2026-08-31 night (with §1-27·§1-28);
the studio_v2 boot migration moved the machine's `space/studio` into the new shape on first
start - 1,809 files, manifest recorded, verified live (§0 Handoff).

- **studio_v2 layout (item 5)**: the studio is two tiers now - `studio/config/{styles,characters,
  fragments,scenes,.studio}` for material and `studio/output/` for results (was a flat level where
  images/ sat beside the cards). One-time boot migration (`workspace.migrate_studio_v2`, manifest
  `space/.hina/migration-studio_v2.json`, move-only); `workspace.studio_canon` folds every
  flat-era path (`studio/styles/…`, `studio/images/…`, `studio/.studio/…`) at `files._resolve`,
  the listing prefix, and `studio._rel`, so old sidecars, saved specs, selection slugs
  (`_unstudio` keys on the flat form) and agent habits keep resolving. Plugin constants moved
  (`OUTPUT_ROOT='studio/output'`, `CONFIG_ROOT`, `areaOfPath`/`canonPath`; persisted gen.folder
  and reservation keys are canonicalised on load).
- **Files tab (items 1·2·14)**: 전체 선택 · 보기 토글 · 이동 · 삭제 are SVG icon buttons with
  tooltips (`FICON`, `armedIcon` keeps the two-step confirm on an icon); '이 폴더에서 찾기' is a
  fold-out search icon on the filebar (the menu-line box that ate a full row is gone - the kit
  search stays for the other list tabs).
- **Right-click menu (item 11)**: 열기 · 이름 바꾸기 · 복사/잘라내기/붙여넣기 (server-side
  `POST /files/copy`, collisions count up to `이름 (2)`) · 경로 복사 · 내려받기 · 삭제 (arms the
  bar's confirm, never a one-click delete). Ctrl+C/X/V on the list too; empty-space right-click
  pastes into the current folder. `dom.menuAt` is the shared context-menu primitive.
- **Internal drag (item 3)**: rows/cells drag as the selection (shared DRAG_PATHS); tree folders
  AND centre folder rows accept the drop as a move (`moveSelected`).
- **Upload overlay (items 6·7)**: a fixed corner card (`.uploadpanel`) with a byte-accurate
  progress bar, per-file errors collected on the card, and the zip question moved onto it. The
  old progress line was prepended into the centre pane and ANY redraw mid-upload cleared it -
  that is the "100MB 드래그했는데 아무 표시 없음" report. The overlay is outside the pane, so
  nothing eats it.
- **Mode legibility (items 12·13)**: inside an edit screen the first tab reads '‹ 뒤로' (back to
  the picker, leave-guard unchanged); a 봇 편집/챗 편집 chip sits on the tab bar naming the group.
- **Prompt editors (items 9·10, reference-tool source zip)**: `ui/hilite.ts` -
  mirror-behind-textarea background tints (glyphs stay native: selection/caret/IME untouched),
  the reference tool's weight parser verbatim ({}=×1.05, []=÷1.05, `N::…::` numeric, red=emphasis/blue=
  de-emphasis, green=<조각>, grey=#comment), attached to the style editor, fragment/scene/character
  prompt boxes. Autocomplete: `<` completes fragment names locally; other tokens hit
  `GET /studio/tag-suggest` → `nai.suggest_tags` proxying NovelAI's own
  `/ai/generate-image/suggest-tags` (no bundled tag DB; empty when no token; in-process cache).
- **Markdown tints (item 8)**: the same mirror in 'md' mode on lorebook content boxes (headings,
  **bold**, `code`, links, quotes, {{CBS}} extents).
- **Agent hygiene (item 4)**: write_file refuses `projects/` outright (산출물 → hina/<봇>/out,
  임시 → scratch/), instructions + helper docstring say temp docs/scripts live ONLY under
  hina/<봇>/.
- **Agent-reported error 1 (realooc)**: the helper's old name still works (`scripts/realooc.py`
  shim was always written); the run_python tool description now says so, so the model stops
  claiming the helper is missing and rerouting by path.
- **Agent-reported error 2 (RemoteProtocolError)**: `nai._req` retries ONCE on a torn connection
  (RemoteProtocolError/ReadError/ConnectError - the keep-alive client's known failure: the server
  closes an idle connection mid-reuse) for every non-stream NAI call; the streaming path already
  degrades to the ZIP fallback. `session._explain` maps "peer closed connection / incomplete
  chunked read" to a plain-Korean "일시적 - 같은 지시를 다시" message instead of the httpx text.
- Tests: test_studio/test_files updated to the two-tier layout + new `studio_canon`, slug-compat
  and `files.copy` checks; smoke updated for the icon bar, fold-out search and title-based
  lookups.

## 1-25. 2026-08-30 - 0.11.0 (unreleased, continued): logs on disk, bulk proposals, one card write for many assets

The user asked for the staging log after a rough session (a mass asset delete plus 37 adds became
~130 single-item approval cards; 전체 승인 crawled and the asset sync "stopped at the 20s mark").
The ring held four minutes of thumbnail fetches and nothing else, and the service kept nothing on
disk - so the first fix is the log itself. One commit (`0f8fb29`), gate green, restaged (backup
`data-backup-20260830-r7`; `data/logs/risuhina.log` verified receiving lines).

- **Logs**: every line lands in `data/logs/risuhina.log` (5 MB x 5, lazily opened) as well as the
  ring (now 8000). Fast, successful thumbnail/poll requests (`/assets/blob`, `/files/download`,
  `/workspace/dirty`, `/studio/job*`, `/health`, `/actions`, `/staged`, `/permits`) drop to debug -
  slow or failing ones still surface. Tracebacks go through the same sink (they went to stdout
  only). Every action decide/complete logs kind · summary · detail; the plugin logs each asset
  save and the whole apply with timings; sync errors name the STEP that failed.
- **Bulk proposals**: `propose_assets_add(items_json)` → ONE `host_asset_add_many` card;
  `propose_scripts_delete(ids)` → ONE `script_delete_many` card (executor loops, reports misses).
  The instructions tell the agent to use them past one item.
- **One card write for many assets**: `applyAssetActions` saves every image (saveAsset per image -
  the host names keys), then ONE host read, ONE card write, adopt per key, ONE re-read + upload.
  Per item it was 37 host round trips and 37 card uploads, each restarting the asset sync - the
  churn behind "멈췄다". The status polls inside the sync get the 180s upload budget instead of
  the 20s default.
- Not yet measured: a real bulk approval on staging (needs the user's bot open in RisuAI).

## 1-24. 2026-08-30 - 0.11.0 (unreleased, continued): the 검수 tab, per-panel collapse, a 중단 that stops the batch

Ten items from the §1-23 staging, one commit (`09e8648`), gate green, restaged the same night
(backup `data-backup-20260830-r6`, bundle 728,491 B).

- **Tabs**: `1장 · 배치 · 검수 | 잡 히스토리`. 검수 draws the selector for the OUTPUT folder picked on
  the left and holds the left column on OUTPUT; a folder click lands there; the tidy-up grid is
  one button away (정리 / 검수하기). Selector pictures show WHOLE (`.selgrid .assetpic` drops the
  square crop) - the choice is made on the picture (items 3·4·8·9).
- **애셋 채택** replaces 내보내기; **봇에 반영 appears only inside a `selected/` folder**, the one an
  adoption is made from (items 5·6).
- **The agent can send the user to 검수** (item 2 - there was no path at all): `studio_open(folder)`
  pushes an `open` event, every batch strip in the chat carries a 검수 button, and the studio
  consumes `state.openStudioRequest` (folder selected, ancestors unfolded, 검수 tab, left column
  on OUTPUT).
- **중단 stops the batch** (item 7): a cut-off turn is flagged per session (`session._STOPPED`, set
  in the run's except path where the abort lands), and studio_generate's wait loop polls it,
  cancels the job it started, and returns. Before, the abort closed the stream while the tool
  thread and NovelAI kept going.
- **Collapse toggles on the panels themselves** (item 1): a compact one at the end of the left tab
  bar, one pinned in the agent pane's top corner (`.rcollapsebtn`; the agent panel is shared with
  every tab, so the studio overlays the button rather than editing it).
- **The batch tab shows the running job** under the submit (item 10): the history's `jobSection`
  reused, streaming frame on the cell being drawn; finished jobs stay in 잡 히스토리.

## 1-23. 2026-08-30 - 0.11.0 (unreleased, continued): batches narrate themselves; artifacts retired

Three items plus one layout report from the §1-22 staging, one commit (`6046ec0`), gate green
(the real-model agent test ran through the reworked session loop), restaged the same night
(backup `data-backup-20260830-r5`, bundle 724,354 B). Probed live: a spec WITHOUT a model starts a
job; `model: nai-bogus` is refused up front with the default named.

- **"model doesn't exist" on every image**: the agent's studio_generate spec carried no model, the
  tool bypasses the HTTP handler's check, and the runner sent `""` to NovelAI. `nai.DEFAULT_MODEL`
  fills an empty model, and an id outside `nai.KNOWN_MODELS` is asked about once (`exists()`,
  free) so a typo fails the batch ONCE with its name.
- **Batches narrate themselves in the chat** (user: "진행되는대로 대화창에 뿌리게"): studio_generate
  now waits by default and pushes an `images` event per finished picture (wait=false keeps the
  old fire-and-forget). For that to show mid-turn, `session.run` flushes side events WHILE a tool
  is running - the pending model event is awaited with a 1s timeout and never cancelled
  (cancelling `__anext__` kills the generator). The panel also ADOPTS a running job it did not
  start: the history tab watches every 5s, `loadJobs` takes it over, and the ordinary poll drives
  the live section.
- **Artifacts retired** (user: "아티팩트는 없애고 전부 대화창 통해서, 이미지는 뿌려줘야"): the
  show_artifact tool and its instruction are gone; the agent answers in the chat and puts images
  inline as `![설명](space path)`. The `[이미지: …]` text in place of pictures was the model writing
  paths with a leading slash / backslashes / the install prefix - `normalizeWorkspacePath` strips
  those before the blob fetch (schemes and `..` still refused). The plugin-side artifact viewer
  stays as the image lightbox and for the file tab; nothing emits the `artifact` event now.
- **The agent pane dragged off screen**: the splitter's clamp assumed 320px for everything else;
  with the studio's 300px explorer plus the centre's 260px floor the sum overflowed, so a drag
  "did nothing" until a tab switch let the width land beyond the edge. The clamp measures the
  sibling panes now (the centre counts at its floor).

## 1-22. 2026-08-30 - 0.11.0 (unreleased, continued): the fourth field report - the character column, real PNG references, toasts

Ten items from the §1-21 staging, one commit (`8238afd`), gate green, restaged the same night
(backup `data-backup-20260830-r4`, bundle 722,928 B at `/plugin.js`).

- **Root cause of "1장 생성 계속 실패"**: the card's two character references were WebP files
  under `.png` names (the picker's `accept` is a hint, not a guarantee; the vibe path uploaded
  raw bytes), so `png_size` read 0x0 and `check_charref_png` refused EVERY generation. Now every
  picked image goes through a canvas and comes out a real PNG (charrefs letterboxed into the
  1024x1536 / 1536x1024 buckets), stored entries in the wrong shape are flagged 형식 불일치 with
  a 맞추기 button and refitted on save, and the runner SKIPS a reference it cannot take - reason
  kept in the job note - instead of failing the batch. Measured on staging: a job carrying the
  WebP reference generated (done, 1 saved, 0 failed) with the skip noted. The `[이미지: …]`
  fallback in the centre (item 3) was the same corrupt file failing to decode.
- **The character column stays a column**: an open card REPLACES the list (← 목록 returns) with
  [프롬프트 | 레퍼런스] sections; left-column textareas drop promptedit's 42vh floor (that floor,
  meant for the centre's full-page editors, was what made the column and the style prompt
  unshrinkable - items 2 and 9); the style editor folds behind 프롬프트 수정 (remembered).
- **References redone**: a picture card per entry, ✕ ON the picture (the row-end ✕ had deleted
  the wrong image), on/off, 강도/충실도 as sliders with the value beside; no filename, no price
  line; 이미지 추가 is a button over a hidden input; [캐릭터 | 바이브] as a tab strip.
- **Toasts**: notices land in the corner and never shove the centre under the pointer. Preset
  delete drops the row from memory and redraws the column instead of re-listing, rebuilding
  the centre and dry-planning (the "lag").

## 1-21. 2026-08-30 - 0.11.0 (unreleased, continued): the third field report - tabs, one place for characters, visible grouping

Seventeen items from live use of the §1-20 staging, one commit (`296bb11`), gate green, restaged
the same evening (backup `data-backup-20260830-r3`; `/health` 0.11.0, new bundle 715,775 B at
`/plugin.js`, a timed 2-image probe: 10.6s then 9.5s - the keep-alive shaves the handshake, the
rest is NovelAI's own generation time).

- **Tabs read as tabs** (`.tabstrip`: flat strip on a baseline rule, active underlined, never
  wraps into a column) - they used to look like buttons or form fields, and the centre tab strip
  could stack vertically. The two panel-collapse toggles moved to the CENTRE strip's ends: on the
  left bar they had pushed the OUTPUT tab out of the 300px column, which also made collapsing
  unreachable (items 1·2·6·7).
- **Characters are picked in ONE place** - the left column's checked cards ride the job at submit.
  The batch tab's cast (출연) concept is gone with its confusing copy (items 8, mid-round user
  call); the reservation map is plain `[preset][scene] = count` (the brief per-cast shape folds
  over on load). The 배치 tab is STRICTLY the queue: unfold a preset, `전체 +1` or the per-card
  ＋ (전체추가/부분추가, item 10), the fold-out 예약 목록, one submit. Results moved to 잡
  히스토리 as one `<details>` per job - newest open, the live section updating in place with the
  streaming frame (item 12).
- **window.prompt is gone** (it reads as a browser security dialog): `kit.namePopover` (anchored)
  and `kit.askName` (modal) everywhere - new cards, folders, reserve counts (items 4·9).
- **The character view breathes and its folders WORK**: back+title row, then search+buttons; rows
  drag onto folder headers (미분류 included) so a card actually moves (items 3·5).
- **The folder grid selects on plain click** (Shift ranges, double-click opens big), with 전체
  선택/해제 (item 13).
- **The selector's grouping is visible**: 전체/그룹별 views - 그룹별 shows one representative
  card per group with its count and choice state, click unfolds, ← 그룹 returns; the rule is a
  delimiter plus the first filename split into clickable token chips (자동 = the built-in
  stamp-anchored rule, the raw regex behind 고급). The chip-built rule is a generated
  `^(?:[^d]*d){k-1}(?P<g>[^d.]+)` named-group pattern, so the backend needed nothing (items 14·15).
- **Images stopped flickering to empty boxes**: blobimg's cache is a real LRU (hits re-insert)
  capped at 600, evictions revoke on a 30s DELAY - revoke-at-eviction was killing object URLs
  still in the DOM - and the selector rides that one pipeline instead of its own copy (item 16).
- **NAI latency, the part that was ours**: nai.py keeps ONE persistent keep-alive httpx client
  (rebuilt on token change; narrow timeouts ride per request) instead of a TCP+TLS handshake per
  image (item 17; the reference client pools connections by default).

## 1-20. 2026-08-30 - 0.11.0 (unreleased, continued): the studio redesigned - the second field report

The user kept working in the staged studio and sent a second round (items 1-4.14 plus four
amendments given during planning). This is the big one: the screen is rebuilt around the loop the
work actually runs in - generate into a folder → tidy names → classify → see what is missing →
queue exactly that. Seven commits (M1-M7) plus this ledger, each gate-green, all on master, still
0.11.0 unreleased. The design record is `~/.claude/plans/zesty-dazzling-lagoon.md`.

- **M1 shared idioms** (`7734cad`): the agent-preset dropdown (compact current row · 선택/수정/삭제/추가
  behind ›) extracted to `ui/pickers.ts`; the file tab's tree rows + drop wiring to `ui/tree.ts`,
  now also carrying internal drags (`DRAG_PATHS`). Settings and files tabs unchanged.
- **M2 the split** (`21f28f0`): tab-studio.ts (1,900 lines, thirty shared module variables) becomes
  `ui/studio/` - store.ts (the S state object + the hub the modules reach each other through),
  gen, editors, char-edit, selector, stylefile, index. No behavior change.
- **M3 the left column** (`d593c57`): [프롬프트 | OUTPUT]. ONE style rides now - a dropdown picks it
  (the pickers idiom) and its 긍정/부정 unfold in the column, saved as you type (debounced; unsaved
  edits survive a rebuild - the edit-then-generate-one loop). 캐릭터 swaps the column to a
  folder-grouped character view whose rows expand into the full editor (references included;
  the backend lists characters recursively so `studio/characters/<폴더>/<카드>` groups). 조각 opens
  the fragment organizer in the CENTRE (folders, move, editor beside the list). OUTPUT is the
  images tree on the shared component - it finally looks like the file tab's. Both rails collapse
  to a slim strip, remembered per side (the studio is the crowded tab). Styles enabled in numbers
  migrate to one, said once.
- **M4 the centre tabs** (`3069d53`): [1장 | 배치 | 잡 히스토리]. 1장 = one big preview + ⚙ 요청 설정
  (a modal now) + count beside 생성 시작 + the latest batch as a click-to-pin strip (←/→ walks it,
  라이브 releases the pin). 배치 reads results BY JOB - one section per batch, newest first, item
  grid at 2·3·4 columns. 잡 히스토리 is the index; picking a row jumps to that section. A finished
  image anywhere opens big in 1장. An OUTPUT folder opens as a browsable grid (breadcrumb,
  multi-select, drags that move files onto subfolder cells or the tree, OS drops that upload);
  the selector moved one button away (감정 사진 선택). The old queue screen and its trailing 최근
  작업 list are gone; the job poll patches the visible tab in place (hub.jobTick).
- **M5 the queue of entries** (`71f9d05`): the batch spec's v2 shape is `entries` - each names its
  scene (preset+name or inline), its own character combination, and its OWN count; plan() expands
  exactly that list in order, and the {character} filename slot is the cast label, else the first
  card's name (the 캐릭터명 form is gone). References follow the CARDS per item (encode/PNG caches
  make mixed casts cost no extra; an unsupported model skips with a note; the 레퍼런스 사용 switch
  is gone, the legacy key ignored). On screen the queue is the reservation map -
  reserves[preset][scene][cast] - piled on the scene cards, NEVER reset by switching preset or
  cast, listed in a fold-out with per-row remove, drained by 씬 생성 n장 into one job. 출연 (casts)
  live in `studio/casts.json`. Legacy specs (the agent's calls) unchanged.
- **M6 streaming** (`0b026fc`): docs/09's "no streaming" was about the slash path; the hyphen
  `/ai/generate-image-stream` + msgpack framing is real (§3 corrected - source is an external
  client, not yet re-probed here: the dev machine has no token, so the FIRST real batch is the
  probe, and the runner falls back to ZIP after one failure). The newest intermediate frame lives
  in studiojob memory, `GET /studio/job/preview` serves it rev-gated, the panel polls at 0.8s into
  the 1장 preview and the 배치 in-progress cell, and a held frame is only replaced once the
  finished file loads. msgpack==1.1.0 joins requirements.in.
- **M7 the selector closes the loop** (`93f1703`): parsing is per FOLDER - a named-capture regex
  plus a 그룹 기준 picker over the fields that regex produced (복장 today, 감정 tomorrow), export
  riding the same. Groups with nothing chosen and nothing being fixed surface as 부족분 BEFORE any
  export, and 부족분 예약에 담기 turns them into reservations (same-named scenes, current cast,
  one each).

Verified beyond the gate: the smoke suite now drives the new screens end to end (the dropdown
select→enabled front matter→typing saves `## positive`, the character view's inline editor and
refMode save, the organizer's create/rename/폴더 이동, reservation piling→ONE entries job→drained
queue, history→batch section focus→1장 open, regex re-grouping by another field, 부족분 badge);
the backend suite covers `_plan_entries` (order, casts, per-entry counts, unique names, unknown
scene refused) and the preview store (rev-gated, memory only). Staged 2026-08-30 evening and the
streaming endpoint MEASURED live from this codebase (see §0: intermediate frames per step through
the rev-gated poll, no fallback). Still unmeasured live: a mixed-cast multi-entry batch driven
from the panel itself.

## 1-19. 2026-08-30 - 0.11.0 (unreleased, continued): the first studio field report - 26 items

The user staged 0.11.0 on zikmunt-pc (see §0's table) and used the studio for real; 26 items of
feedback came back. Nine commits (P1-P9), each gate-green, all on master, still 0.11.0 unreleased:

- **P1 names are the identity**: a new card asks for its name first and the name IS the filename
  (timestamp slugs gone); renaming a card renames its file/folder via `/files/move`; the fragment
  table registers front-matter names (weakest key - path and stem always win) so `<이름>` keeps
  resolving after a rename; the fragment listing shows the name; scene presets get a structured
  editor (name + scene rows, raw JSON one click away). Creating a character writes its folder up
  front, which also fixed the blank new-character form being wiped by any refresh.
- **P2 filenames without 무제**: empty template fields are dropped with their delimiter instead of
  being padded with 무제; the outfit field is gone (user: a sim bot is not one character - the
  캐릭터명 box stays manual, never derived from cards); the default parse is a token rule anchored
  on the stamp ([character-][emotion-]stamp-n) that still reads legacy three-token names.
- **P3 the png carries its own recipe**: no more .json sidecar per image - the request record is a
  `hina-params` tEXt chunk (base64 JSON after IHDR, zlib.crc32 by hand, the reference tool's own trick);
  `nai.recipe()` reads it back as `hina`. Legacy sidecars stay on disk (user decision).
- **P4 probe**: `--fidelity` / `--charref-mode` on the charref probe, run live (5 Anlas):
  `director_reference_secondary_strength_values=[0.4]` -> 200 and the Comment echoes it (it was
  null without the field), base_caption "character" accepted. Cross-checked with the reference tool's captured
  web payloads (fidelity rides as secondary = 1 - fidelity; the 캐릭터/캐릭터&스타일 mode is the
  base_caption). docs/09 §7d updated.
- **P5 references and request settings**: charref entries are {file, strength .6, fidelity .6,
  mode 'character'} (description gone); a card's charref/vibe are TABS with a stored refMode -
  the two never ride together (an old preset keeps whichever list it has); picked images upload
  immediately; the bucket fit letterboxes on black; position folds under 고급; quality tags / UC
  preset merged as TEXT with the flags as metadata (the reference tool capture); defaults steps 28,
  cfg_rescale 0.4, quality OFF, UC Heavy; the gen card grew a folded persistent 요청 설정
  (sampler/schedule/UC/quality included) and the reference notice counts charrefs too.
- **P6 the tab stops re-reading the world**: re-reads only on tab re-entry or a filesRev change
  (one checkbox used to cost 7-9 requests and a full rebuild); a toggle is one meta write + an
  in-memory row; `GET /files?prefix=` walks one subtree; migrate_characters once per process;
  studio writes finally bump filesRev (files tab freshness); the four card sections fold
  (persisted); checkboxes get one global rule instead of text-field styling.
- **P7 a live queue in the centre**: one row per planned image (완료+thumbnail / 실패+error /
  생성 중 via the worker's new `current` marker / 대기), progress, elapsed, Anlas on finish,
  중단, and a 최근 작업 list riding the previously-unused id-less `GET /studio/job`.
- **P8 files**: 경로 복사 buttons (crumb, preview, settings 파일 공간); the grid toggle looks at
  the whole subtree and folder cells preview their first nested image.
- **P9 agent**: the panel says "챗 탭에서 챗을 고르면…" instead of surfacing `chatKey is
  required`; studio_plan/generate docstrings document every accepted spec field (inline scenes,
  scenePreset+only, styles[], template, useReference, costs); cards resolve by display name in
  specs (exact match, ambiguity refused with candidates); the temp-preset rule lands in the
  instructions and the seeded skill (key rotated to _v2): one-off batches use inline scenes,
  repeatable ad-hoc specs go to `studio/.studio/adhoc/`, never into studio/scenes/.

Verified beyond the gate: headless-Chrome CDP probe at 390px (device metrics override on the
harness `/app` page) - docW=390 with the studio tab, the unfolded list, 요청 설정 open, the queue
view, the character editor (both reference tabs present), and the files tab.

## 1-18. 2026-08-30 - 0.11.0 (unreleased, continued): the tab kit, prompt cards, artifacts

The rest of plan `risu-elf-1-distributed-magpie.md` (Phases 2-4), on top of §1-17:

- **The tab kit** (`plugin/src/ui/kit.ts`): the five things every tab hand-rolled slightly
  differently - the gate (one empty-state copy per kind), the rebuild guard (declared `keys()`),
  the auto-clearing notice (10 byte-identical copies deleted), the menu-line search box (now
  installed whenever the gate passes; memory/trigger/vars/files gained the filter they lacked),
  and `savedText` (the 반영 rule worded once). `listRow` covers the two row idioms; `armed()`
  returns a controller so the Delete key and the 삭제 button share one two-step confirm (the
  files tab's bespoke confirmBar is gone). `renderActive`'s editor special-case became an
  explicit list of tabs without a menu-line tool. What is deliberately NOT unified is named in
  kit.ts's header.
- **Space images** (`blobimg.ts`): the proven bytes→Blob→objectURL pipeline extracted once
  (POST download, six in flight, LRU); markdown gains `![alt](path)` behind an opt-in callback,
  **space-relative paths only** - a scheme, a leading slash or `..` degrades to the alt text
  (an iframe fetching model-chosen URLs is an exfiltration channel). The stale "mainline has no
  img-src" comments now state the 2026-08 reality.
- **Prompt cards** (§2 of the user's ask): a style or a character is a CARD with its own
  `enabled`/`order` in its front matter (absent = OFF - no silent concatenation on upgrade),
  toggled on the row, edited in the CENTRE pane (the character modal is gone). A character is a
  folder card `studio/characters/<이름>/{prompt.md, preset.json, *.png}` with per-reference
  강도/충실도 presets; legacy stem-pairs migrate lazily. compose/plan speak plural styles;
  unstated = the active cards, explicit [] = none; the panel sends the active sets explicitly.
  Fixed on the way: `use_coords` only with real centers, and Korean folder names no longer
  collapse to one selection slug.
- **Character reference, measured first** (`docs/09 §7d`, probed live 2026-08-30): descriptions
  are V4ConditionInput objects, the strengths request field is
  `director_reference_strength_values`, information_extracted is pinned to exactly 1.0, the
  image must sit in the 1024×1536/1536×1024 bucket (the per-model internal `/encode-director`
  does not exist for v5 → v4.5-only), and **an accepted generation costs 5 Anlas, Opus
  included**. `nai.py` speaks that shape; the editor's 캐릭터 레퍼런스 section is gated on the
  `/studio/status` charref flag and cover-crops uploads into the bucket with a canvas.
- **Artifacts and image strips** (§5·§6): the wire vocabulary grew by exactly two events -
  `artifact` and `images` - pushed by tools through `session.push_stream_event` and drained
  right after their toolResult. `show_artifact(title, content|path)` writes markdown to
  `hina/<봇>/out/artifacts/` (files first; slugged, counted duplicates) and the ONE global
  viewer (`artifact.ts`, re-parented like the agent panel) overlays the current tab's centre -
  markdown through the DOM whitelist with space images, **never raw HTML** (user decision:
  AI-authored HTML executing with the plugin's iframe privileges is the line). 닫기 leaves a
  reopen chip and the file. A finished studio batch pushes its saved paths once as a thumbnail
  strip; fresh out/ images render the same way.
- Verified: gate ALL GREEN throughout; migration rehearsal on a data copy (17 files → space,
  manifest complete, second run a no-op, rollback dry-run clean); headless-Chrome probe at 390px
  shows docW=390 on the studio and files tabs (no horizontal scroll).

## 1-17. 2026-08-30 - 0.11.0 (unreleased): the ONE global file space, and the studio rebased into it

The `studio-asset` branch (12 commits, forked at v0.9.6) was rebased onto master - the only
conflict was this file's deploy row - then fast-forwarded in. Two semantic follow-ups landed
with it: the studio is a **third screen** (`mode:'studio'` on /chat, `agent.screen_gate` as a
pure function; adopt passes there, everything else refuses naming the actual screen - and
`session.SCREEN_MODES` now includes it, because the wire filter silently dropped it at first),
and **asset adds read back like every other write** (writeCharacter verifies the three asset
lists; an unverified adopt fails the action instead of reporting success).

Then the space (plan `risu-elf-1-distributed-magpie.md`, Phase 1, C1-C4):

- **One root, `data/space/`** (`workspace.globalPath`): `projects/<봇이름>/` the user manages,
  `studio/` the library (wire paths are space-rooted; `studio._rel` keeps bare paths working),
  `hina/<봇이름>/{scripts,scratch,out}` the agent's per-bot work, `.hina/` machinery. Bot folder
  names are the bot's own name, pinned in `.hina/bots.json`; collisions take `~2`.
- **SYSTEM stays outside the space** at `data/workspace/<key>/` (card.md, original/, .scratch/
  with scope.db): everything inside the space is readable by every sandbox, and another bot's
  scope.db must not be. The wire reaches it read-only with `system:1`. The DATA axis (scope.db
  contents, docs/07) is untouched.
- **Sandbox**: root = the space, plus this bot's SYSTEM (read; only its .scratch writable - so
  original/ is now write-protected from scripts, tighter than before). cwd = the bot's hina
  home; helper scratch/out follow; uploads() reads projects/<봇>/. Skills copy to home/skills
  per run as before.
- **Agent tools**: list/read/write_file over the space (`system/` and `skills/` prefixes),
  new `find_files`/`search_files` with counted-truncation lines (docs/07 §3-3);
  studio_list/read/write absorbed into the general tools; `studio_adopt` proposes the image's
  own global path - `stage_to_bot` and the copy hop are gone. 정리 is per-bot (`clean_bot`).
- **Boot migration `space_v1`**: uploads→projects/<봇>/, out·scratch·scripts→hina/<봇>/,
  data/studio→space/studio. Move + manifest only (`.hina/migration-space_v1.json`), no deletes;
  `pyserver/tools/rollback_space.py` replays it in reverse. A studio on a configured
  libraryPath is not moved and the status line says so.
- **0.11.0** on both sides - the wire changed shape, the version gate must trip. New
  tests/test_files.py joins the gate; test_sandbox asserts both directions of the wall.

## 1-16. 2026-08-30 - v0.10.0: the edit-session lifecycle - nothing stays silently pending (schema 13)

The user rolled the three post-release commits back (`discarded/snapshot-fixes-2026-08-29` keeps them;
their commit messages are the bug-repro record) and redesigned the lifecycle in one pass. The stated
problems: a backend "임시저장" (= the working copy) that survives every exit unresolved, no visible
cancel, bot/chat edits interleaving ("saving the bot quietly re-saved the chat"), too many automatic
snapshots, and a version list the user cannot trust because nothing in it was consciously saved.
Six commits, each gate-green:

- **Rollback base**: `origin/master` (= eb1b725, v0.9.6 + release docs). The discarded branch's
  writeBackAll ("반영 writes both halves") was explicitly NOT re-adopted - the design goes the other
  way (one dirty thing at a time).
- **lifecycle 1/3 (backend)**: the three data-loss fixes re-landed clean - a restore writes the
  working copy only (`store.restore_turns`; via `ingest_chat(force=True)` it rewrote the baseline,
  so 반영 found 0건 and the next reopen adopted it away); an empty upload over held turns is a
  PocketRisu stub and is refused (`skipped`, force/🔄 still passes); `POST /reset` discards all
  three materials (turns + local lore + memory, new `store.reset_lore_local` / `memory.reset_working`)
  and every reset clears conflict marks (a surviving mark kept 반영 blocked over rows that no longer
  differed). Dead `rebase_*` family deleted. `tests/test_lifecycle.py` joins the gate.
- **lifecycle 2/3 (backend)**: schema **13** - a `kind` column ('user' | 'auto') on both checkpoint
  tables, backfilled once from the labels the code always used (a column, not a label convention:
  the user can rename a label). Auto snapshots self-prune inside create() to `limits.autoBackupKeep`
  (default 5, never zero - RisuAI has no undo for a plugin write); the restore dedup folds only the
  auto 'restore 직전'. '복사본 저장 직후' is no longer snapshotted (the copy in RisuAI is the backup).
- **lifecycle 3/3 (backend)**: `GET /workspace/dirty` (the whole bot: card + every loaded chat, each
  with pending total and conflict count) and `workspace.cross_scope_blocker` - the one-dirty-thing
  rule as a refusal. Guarded at the only two doors that write a working copy without the bars:
  `actions.decide` (via `scope_of`; a lore row answers for itself, global = card material) and
  `h_approve`. A refused approval stays pending. A card write is blocked by every dirty chat
  including the acting one - that pairing IS the reported bug.
- **plugin: write verification**: both host writes read back and compare (`WriteResult.verified`);
  unverified = no commit, no re-read, working copy kept, the reason shown (RisuAI open elsewhere is
  the usual one). This was the worst v0.9.6 hole: a failed write followed by the re-read replaced
  the working copy with the text the write had just failed to change - gone from both sides.
  `rereadCard` now carries the edited chat (chatIndex), ending the quiet activeChatKey swap after a
  card 반영.
- **plugin: 변경 취소** on both bars (two-click, visible only while dirty, names what went); the
  "기준선으로 되돌리기" rows left the 반영 popovers - one verb, one place.
- **plugin: the leave guard** (`ui/leaveguard.ts`): X, the 선택 tab, 봇 편집, chat rows, the header
  🔄 and the agent's cross-scope open-tab all funnel through `ensureResolved` → per dirty scope:
  [반영하고 계속] [버리고 계속] [계속 편집]. Exempt where the action is at home (a chat in itself,
  봇 편집 / snapshot restore in the card). A dead backend never locks the user in. The browser
  closing remains the one unguarded exit - the reopen 3-way merge (§1-13) is unchanged and covers it.
  Picker rows carry a "미반영 N" badge; opening a stub chat surfaces the refusal.
- **plugin: 버전 lists 'user' snapshots only**, autos behind "자동 백업 N개 보기" (restorable, not
  renamable, flagged as possibly behind RisuAI); `/checkpoint/clear` sweeps saved rows only.

Staging round (backend files scp'd to zikmunt-pc, schema 13 backfill verified live): the user
confirmed the intended behaviour and caught two more - (1) an empty FIRST upload also founded a
0-turn chat (the guard only protected chats already held); the rule completed with a `live` flag -
the plugin marks the chat RisuAI has open, the one chat a lazy host never stubs, and only `live` or
`force` may ingest empty; `materialize` now stops at a refusal instead of overwriting the frozen
original and merging memory/lore from the stub. (2) the 반영 popover hint predated the leave guard -
reworded. Plus, by request: a mode chip in the header (챗 편집 / 봇 편집, edit tabs only) and the
same line injected into Hina's per-run instructions (`@agent.instructions` over `Deps.mode` - it
used to learn the mode only from a tool refusal).

Verification: gate ALL GREEN throughout; the smoke walks the unverified write, the discard button,
X→stay / picker→discard / mode-switch→apply, and the version-list fold end to end. Manual checks
still owed before a release (real RisuAI): the 3-choice modal on 챗→봇 switch, a PocketRisu stub
chat from the picker, an unverified 반영 with RisuAI open in two windows, reopen-merge after closing
the browser dirty, and a schema-12 DB start (kind backfill line in the log).

## 1-15. 2026-08-29 — v0.9.6: clicking a chat loads it, and 반영 follows the chat that was clicked

Reported: selecting a chat that was not loaded flashed "open that chat in RisuAI first and press 🔄", yet
**이 봇의 모든 챗 불러오기 immediately below loaded every chat of the bot and let you edit exactly those chats.**
So the refusal was never a constraint — it was a detour around one that had already been lifted. RisuAI hands the
plugin the whole selected character, chats included, and `getChatFromIndex` reads any index of it.

- **`state.openChat(index)`** — the picker row now uploads that one chat (`upload({ chatIndex })`) and opens the
  editor on it. The row's button says 불러오는 중… while it runs: a few hundred turns is megabytes, and it is the
  one click on that screen that is not instant.
- **The write-back had to move with it, and this is the part that was a latent bug.** `writeBack` and `saveCopy`
  addressed `state.slot` — *whichever chat RisuAI has open* — so the pre-existing 모든 챗 불러오기 path could send
  chat B's material into chat A. The turn paths would have failed loudly (`beforeTurns` mismatch, or an unknown
  `msgId`), but a **lorebook or memory-only** write-back on two chats whose lorebooks were both empty passed every
  guard and landed on the wrong chat. Both paths now go through **`state.chatSlot()`**: the chat **id** is the
  identity, and the index is re-derived from a fresh `readCharacter` — an index recorded at upload time is stale as
  soon as chats are reordered, copied or deleted in RisuAI. `host.writeChat` then re-reads at that index and still
  refuses the write if the id moved again in between, so the two checks are belt and braces.
- **`rereadChat`** (the re-read that follows a successful 반영) took the live chat too, which would have left the
  edited chat holding a baseline one write behind. It now re-reads the chat that was actually written.
- The one real refusal that survives: PocketRisu loads chats lazily and hands `readCharacter` **stubs** with no
  `message` list for chats it has not opened yet (already known — `host.cloneBot` skips them). `state.chatAt`
  therefore asks `getChatFromIndex` first and falls back to the card's copy, and only when both are stubs does the
  picker say "RisuAI가 이 챗을 아직 읽어 두지 않았습니다" — the old message, now an exception rather than the rule.
- Covered by `tests/plugin_smoke.mjs` → `test_open_a_chat_risuai_does_not_have_open`: click the chat in the folder
  (RisuAI's `chatPage` stays 0 throughout), edit a turn, 반영, and assert the edit landed in `chats[1]` with its
  `chatId`s and turn count intact **and `chats[0]` byte-identical**. Gate ALL GREEN.
- **Confirmed on a real host (2026-08-29, the user)**: a chat RisuAI does not have open is written back and saved. That is the `docs/02` host constraint seen from the other side — the autosave `$effect` snapshots the **selected character's** whole `chats` array, so every chat of that bot is in scope and the only boundary is the character. Phase 0's T-12/T-13 (an existing
  index round-trips, a nonexistent one is ignored) were the grounds for expecting it; this is the measurement.
  **The character boundary does not fall with it**: a write to a character other than the selected one is still
  dropped by the host (`docs/02`), which is why 새 봇으로 저장 clones a new bot instead of editing another one in place.

## 1-14. 2026-08-29 — v0.9.5: the repo goes English

- **Every doc under `docs/` and all 27 GitHub release notes are now in English.** `README.md` and
  `pyserver/RELEASE_README.md` (shipped in the zip as `INSTALL.md`) stay Korean — they are what a Korean user
  reads. Korean that is a literal on-screen label or a printed string stays as written, with a one-time English
  gloss (`반영`, `⚙ → 연결`, `"이하 N개 생략"`); translating those would make them unfindable in a Korean UI, and in
  §1-12 below one of them is load-bearing evidence — the byte count only works with the Korean string.
- Structure was held line-for-line through the translation: every heading, table row and code fence is present
  and in the same order (`docs/04` grew 16 lines purely from paragraph re-wrapping).
- **v0.9.5 itself is a single change to the config template** (`config.DEFAULTS`), recorded in commit `cc7f403`.
  Nothing user-facing moved, and an existing `data/config.json` is left alone on upgrade.

## 1-13. Night of 2026-08-28 — v0.9.0: 3-way merge on reopen (changes on the RisuAI side were mistaken for "things I edited")

- Symptom (user): open the bot → upload → carry the chat further in RisuAI or edit the lorebook by hand → open again → old values show up as if they were new changes, and the diff is judged in the direction that **reverts to the past**.
- Cause: on reopen, **only the baseline** was moved to RisuAI's new values while the working copy was left as it was. Rows nobody had touched became `working copy ≠ baseline`, showed up as "modified", and the two sides of the diff flipped (`original` = RisuAI's new text, working copy = the old text). On top of that, the `patch` built in that state carried `{before: live value, after: stale value}`, which **passed** the `before` check in `host.writeCharacter` and approved the revert. Per material:
  - Turns: only `turns_original` was rewritten wholesale → turns added in RisuAI were classified as `removed` → `structural` → **the whole array replaced with the old one** (every message created since the last open lost).
  - Lorebook: **skipped entirely** unless it was a reset → RisuAI's edits were not even visible in the panel, and 반영 (write back to RisuAI) overwrote them with the old list.
  - Card fields, greetings, scripts, memory: only the baseline moved. Greetings, scripts and summaries are addressed **by position (index)**, so a single insertion throws all of them out of alignment.
- **`pyserver/app/merge.py` (new)**: `canon` (sort keys + ignore RisuAI's default booleans) · three-stage matching (content match → natural key → position) · a 3-way decision. The core safety logic in one line — **only `adopt` can lose anything, and it only happens when `ours == base`. So anything matched by position alone is never adopted; it becomes a conflict.** Natural keys: turn `msg_id`, lorebook `id`→folder `key`→`comment`→keyword set→first 200 characters of the body, Regex `in`, trigger `comment`, asset `assets/<sha256>`, summary `chatMemos`, chat variable name. `tests/test_merge.py` added to the gate.
- Schema **12**: `conflict_json` on five tables, `base_seq` on the three list-shaped ones (the working copy's `seq` gets renumbered by the move buttons, so the `before` list has to be ordered by this instead). Compatibility with existing DBs is **not** kept (user's decision) — the first startup after the upgrade DROPs the six working-copy tables; snapshots, sessions, presets and keys are kept. `db.transaction()` added: a merge runs "read the old baseline → decide → overwrite", so being cut off in the middle loses the ancestor (`execute` committed on every call).
- **Nothing of the working copy is left after 반영** (user's instruction): the `rebase` family removed, `POST /commit` and `/card/commit` leave only a snapshot, and the plugin re-reads what it just wrote and reloads only that scope (new `chatReset`/`cardReset` scope flags). **Exception — 복사본 저장 (save a copy) for chats**: that writes to a new chat, so the current chat's edits have not been written back yet; re-reading here would lose the edits, so it does not commit. As a bonus, `merge.decide` gets the rule "if both sides moved to the **same value** it is not a conflict" — even if the re-read right after 반영 fails, the next open converges quietly.
- **Write-back check**: `card.patch`/`store.patch` carry a `before` for every list (the baseline, in `base_seq` order) and, for structural changes, `beforeTurns` (ordered `msg_id` + FNV-1a 32-bit of the body), and `canon`/`sameList` in `host.ts` check **all of it before** writing. On a mismatch nothing is written and it says "패널을 다시 열어 병합한 뒤 반영해 주세요" (reopen the panel, merge, then write back). Before this there was **no check at all** on the lists (lorebook, greetings, scripts, the three asset kinds), so edits made outside the panel vanished silently.
- **Conflict UI**: `GET /conflicts` · `POST /conflict/resolve {kind,id,choice}` (plus a batch form), `ui/conflicts.ts` (⚠ 충돌 (conflict) badge · my version and RisuAI's side by side as a diff · two buttons · a modal that gathers them all), the conflict count on the chat and bot bars with **반영 blocked**, the tab badge in red, and one line of shell notice after reopening ("RisuAI 쪽 변경을 받았습니다 (수정 3건 · 추가 12건). 편집 중이던 1건은 충돌로 표시했습니다" — took in the changes from the RisuAI side, 3 modified and 12 added; 1 item you were editing is marked as a conflict).
- **0.9.3 (large file upload)**: the user tried to put a 138MB `.charx` into the workspace and failed. Two layers of size limit were the cause — the plugin rejects anything over 60MB (`tab-files.ts` SOLO), and the backend body cap is 64MB (`MAX_BODY_BYTES`). A character charx is normally 140–180MB, so it can never go in one request (the relay in front cannot take it either). **Chunked upload** added: `POST /files/upload-chunk` (the same binary framing as upload-many, header `{charKey,dir,name,rel,offset,total,last,extract}`); the server appends to `<name>.part` and **checks the offset against the real size on disk** (this stops retries and races from combining into a plausible-looking corrupt file), then verifies the size on the last chunk and renames. `.part` is excluded from listings. The plugin cuts files larger than a batch (16MB) with `file.slice()` — it does not read 180MB into one array. **Measured: a real 138MB charx in 9 chunks, 1.0 s, sizes matched.** Six regression tests (chunk received, incomplete not in the listing, mismatched offset rejected, completion, bytes match, size mismatch rejected).
- **0.9.2 (picker screen cleanup, zip README)**: the user's complaint was "I can't tell what any of the buttons are". On the picker screen only **봇 편집 (edit bot)** is left and `카드만 다시 읽기` (re-read the card only) is deleted (from 0.9 on, reopening merges by itself, and the header 🔄 is the only "throw away my copy"); bot snapshots have only **편집 (edit) · ✕** per row (the top "지금 편집 중인 작업본/현재/봇 편집" line and the cleanup controls at the bottom removed — there were four entry points to editing on one screen); chat rows have only **챗 편집 (edit chat)** (the `열림` and `불러옴` badges deleted); `다시 동기화` (resync) only when there was an error, an abort or a failure. **The README inside the zip = the repository root README** (`tools/bundle.py`), and the install guide goes in the same folder as `INSTALL.md` (previously the zip README was `pyserver/RELEASE_README.md`). The smoke test's assertion that "the resync button is there even after the sync finishes" was replaced with the new contract.
- **0.9.1 (same night, found right after deploying)**: because the reuse decision was based on whether a `chats` row existed, the **first open after schema 12 emptied the working copy was reported as "N added" rather than a reset** (the result was correct, only the notice was confusing). The decision now looks at **whether a `turns` or `turns_original` row exists** — right after the upgrade both are empty, so it is a reset, and when the agent has deleted every working-copy turn the baseline is still there so it does not reset (the deletion is respected). Regression test added.
- Tests: `test_reopen_merges_risu_changes` (adopt · keep · absorb · not structural · conflict · resolve · upstream delete) · `test_reopen_merges_card_and_lore` (card field adopted · lorebook adopted/kept/added · a greeting insertion does not shift the rest · the conflict list). The existing commit tests were fixed **to follow the real write-back flow** (the `write_back`/`write_back_card` helpers apply the patch to the chat/card to produce "this is what RisuAI now looks like", then re-read with `chatReset`/`cardReset`). A re-read creates new row ids, so the tests have to **look the ids up again** just like the panel does (`desc_id`).

## 1-12. Night of 2026-08-28 — v0.8.4: the culprit behind "the backend takes ages to connect" = an intermediate cache (confirmed from the log)

- Symptom: opening the panel in web RisuAI, the backend connection comes up a long while later, every time.
- **Evidence 1 — the log**: two `[plugin] connect recovered` entries in `server.log`, `attempts=5 seconds=49` / `attempts=6 seconds=79` (exactly matching the retry intervals 3, 5, 8, 12, 20 = 48 seconds).
- **Evidence 2 — the length of the error string**: at the time, `lastError=str(181)`. Working out the lengths of the two candidate strings, 181 = the "백엔드에서 Risu Hina 응답을 받지 못했습니다 (…)" string (90 characters) + `HTTP nnn · ` (11 characters) + **80 characters of body (hitting the slice cap exactly)**. So this was not a network failure: **an HTTP response arrived, and its body was non-JSON (HTML) of 80 characters or more**.
- **Evidence 3 — decisive**: during the two failure windows (21:04:30~21:06:29, 21:51:30~21:53:37) **zero requests reached the backend**, and the first request that did arrive (`GET /health -> 200 7ms`) succeeded immediately, with the recovered log written right after it. → The request never reached the origin yet a response came back = **something in the middle answered instead**.
- Checking what sits in front: zikmunt-pc runs a **Cloudflare Tunnel** (two `cloudflared` services; it is a remotely-managed token tunnel, so the ingress config lives in the dashboard), and the backend listens on `127.0.0.1:6020`, **IPv4 loopback only**. The event log has nothing but the service starting at boot — no reconnections. In 0.7.2 we already confirmed that **the same edge ignores the query string and caches** (every asset thumbnail came back as one image) → there is a cache in front behaving like "Cache Everything + Ignore Query String", and the reading is that it had latched onto an error page and kept handing it back for `GET /health` for the length of the TTL (≈1 minute).
- Fix (on our side, at the root):
  - **Added a `POST /health` route** (same handler, same AUTH_EXEMPT). The plugin's connection probe `transport.probe()` goes **POST first**, falling back to GET on 404/405 (for backends at 0.8.3 and below). A CDN cannot serve a POST out of cache — a query cache-buster is meaningless at this edge (it ignores the query), so POST is the only sure method.
  - **`Cache-Control: no-store` on every JSON response** (`_json`). This API is per-request state throughout; nothing in the middle should be replaying it.
  - On failure, `transport.probeInfo` records **who answered** (status, content-type, cache-control, age, expires, 80 characters of body), and it is written into the `connect recovered` log as `lastProbe`. Only the CORS safelisted headers are readable, but content-type and cache-control are enough to tell an intermediary from the backend.
- Caught in the log as a bonus: on every reconnect recovery, `POST /workspace`, `assets manifest`, `/turns` and `/changes` were each logged **twice** → `state.connect()` calls `emit()`, the "connected by another route" watcher starts an upload, and right after that the reconnect loop starts one more. An in-flight promise guard added to `uploadAfterConnect` (the second call joins the first).
- Recommended on the user's side (dashboard): ① set **Cache Rule = Bypass cache** on the tunnel hostname (or set Caching Level to Standard) — this API must not be cached. ② point the tunnel ingress at **`http://127.0.0.1:6020`** instead of `http://localhost:6020` (the backend listens on IPv4 loopback only, so `localhost` can try `::1` first and produce a 502, and a cached 502 is exactly the symptom above).

## 1-11. 2026-08-28 — v0.8.3: one web-search tool card, one of three search options (the user's design)

- The user's instruction: "Replace search systematically, with a web-search-tool settings card under the general agent. One of three search options; picking the option at the top changes the layout below it; a test button. ① the main agent's built-in search tool (do not block specific addresses, use the test instead) ② a Gemini helper agent (instructions, fixed to Google AI Studio, default gemini-3.7-flash, key from a preset or entered directly) ③ an external search provider (duckduckgo by default, firecrawl and so on)."
- **The "search agent" preset kind is gone from the screen** (the DB row, the `agent_search` section and `/config/test section=agent_search` are kept). The agent tool is **a single `web_search(query)`** (formerly `web_research`): the per-mode docstring is injected at registration time via `websearch.tool_doc()` (`@agent.tool` reads the description at registration, so changing `__doc__` afterwards is useless), and `websearch.mode/provider` went into `presets.fingerprint()` so changing the mode rebuilds the agent. The instructions too: "for outside facts, use web_search".
- `websearch.py` rewritten — `mode()` native | gemini | provider (the default; the old `provider=native` maps to native), `ready()/why_not()/tool_doc()/run()/test()`:
  - **native**: against the general agent's endpoint (`config.agent`), **tries the candidate shapes one after another** and remembers the first that answers in `websearch.nativeShape` (the test searches again with `force`). The host-specific certainties first — `ollama.com` (**the Ollama cloud `POST /api/web_search`**, same key; a result list) · `anthropic.com` (`web_search_20250305`) · `generativelanguage.googleapis.com` (grounding) — then, for any host at all, four OpenAI-compatible guesses: Responses `web_search` → chat `vercel:exa_search` → chat `web_search_options` → OpenRouter `plugins:[{id:web}]`. An empty response counts as a failure (Vercel's Responses returns 200 with an empty output). No address whitelist.
  - **gemini**: Google AI Studio's **native REST** (`v1beta/models/<m>:generateContent`, `tools:[{google_search:{}}]`, `x-goog-api-key`) — the OpenAI-compatible layer has no grounding. The answer plus the URLs in `groundingMetadata.groundingChunks` as sources. The key is `geminiKeyRef` (the id of an entry on the API key tab) or `geminiApiKey` (secret: KEEP, redact), the model defaults to `gemini-3.7-flash`, and a default instruction text is supplied. **Not measured** (no Google key on the remote machine) — the request format was parse-verified against a fake response.
  - **provider**: the existing five plus **Firecrawl** (`v2/search`, with `scrapeOptions.formats=[markdown]` putting part of the body into the summary column; it also reads the v1 `data[]` shape). The main agent reads the results itself (previously the search preset's model read them).
  - `POST /websearch/test` → `websearch.test()`: `{ok, mode, detail(shape, model/provider), text, error, ms}`; native can take a few minutes (60 seconds per candidate). The plugin waits 330 seconds.
- Plugin `buildWebsearchCard()` (presets.ts, `#websearch-card`): directly under the general agent card, a "검색 옵션" (search option) select → switching the per-mode panel (`.wsmode`), 저장 (save) · a test question · 테스트 (test) (saves, then runs a real search and shows the results and the time taken). The Gemini panel: model, a select over the key list (`/keys`) or direct entry, an instructions textarea plus "기본 지침으로" (back to the default instructions). The search agent card, `testButton('search')` and the unset button are removed. Smoke: card position, the order of the three options, provider as the default, panel switching, the test button (linkedom's select has no `.value` setter, so it is chosen through the `selected` attribute). test_http: the three modes, the default, native's not-ready reason, gemini with no key / a key / KEEP / redact, firecrawl.

## 1-10. Morning of 2026-08-28 — v0.8.2: the search engine moves inside the agent · built-in search measured · 3 mobile items · "no backend connection after another plugin updates"

- **"Why are the agent and the provider separate?"** — the roles: the preset model composes the query and reads and organises the results; the provider actually queries the web. A vendor's built-in search does not come through the OpenAI-compatible chat completions path (relays such as Vercel), so we have to attach a search engine ourselves. UI: the "검색 제공자" (search provider) card was folded **inside** the search agent card as a `details.fold` labelled "검색 엔진 — 기본 DuckDuckGo · 결과가 부실하면 여기서 바꿉니다" (search engine — DuckDuckGo by default, change it here if the results are poor) (for the user it is "just pick one preset"). Smoke-tested.
- **Built-in search measured** (zikmunt-pc; the probe script was deleted after running, and credentials never left that PC): Vercel AI Gateway (gemini-3.7-flash): the `google_search` and `web_search` types give 400 (allowed: function · custom · `vercel:exa_search` · `parallel_search` · `perplexity_search` · `tako_search`), and `extra_body google.tools` is silently ignored. `vercel:exa_search` 17.3 s · $0.066 · the 8/24 release (approximately), `vercel:parallel_search` 10.2 s · $0.032 · **the March release (a five-month-stale wrong answer)**; prompt tokens 38k–72k (the gateway stuffs the results into the prompt). → a **`native` provider, "모델 내장 검색"** (the model's built-in search): `websearch.native_kind()` picks the shape from the endpoint's host (`ai-gateway.vercel.sh` → vercel, '' when it recognises nothing); `agent.native_research()` calls it directly without pydantic-ai (vercel uses `exa_search`), with `research()` branching first; `POST /websearch/test` runs one real query asynchronously. **The default stays duckduckgo** (a fresh install may have neither). Three test_http cases (the list, the not-ready reason, and the test giving the same reason without making a call).
- **risu.xyz "no backend connection for a while after another plugin (cupcake) shows an update notice"** — checked the RisuAI source (`plugins.svelte.ts`, `apiV3/v3.svelte.ts`, `factory.ts`): `updatePlugin → importPlugin → loadPlugins()` → `loadV3Plugins` **unloads every running V3 plugin** (waits 1 second for the onUnload callback → `host.terminate()` = remove the message listener + **remove the iframe**) and runs them again. So whenever any plugin is updated or installed, our panel disappears and the next open is a cold start. The server ring log (06:52:56 `GET /health` → **a 2-minute gap** → 06:54:57 `/health` plus a normal 3-second load, no `connect recovered`) shows the first open sitting for 2 minutes in `readHost` (the host bridge `getCharacterFromIndex` = `$state.snapshot(the whole character)`) — the backend answered instantly, but the panel was empty and that read as "not connected" (the same symptom as round 10's "3 minutes for the first connection on web"). Fixes: (1) **boot stages** in the header status line ("백엔드에 연결하는 중… / RisuAI에서 봇을 읽는 중… / 백엔드에 올리는 중…" — connecting to the backend / reading the bot from RisuAI / uploading to the backend), (2) `clientLog('boot', {connectMs, hostMs, uploadMs, platform, hostError})` on every open — warn if hostMs > 5 seconds, (3) `clientLog('unloaded by host (plugin reload or disable)')` in `onUnload`, (4) `h_clientlog` records the strings in detail verbatim (`_client_detail`; previously the content vanished as `agent stream error {error=str(71)}`). The next report can be settled from the log.
- **Three mobile items** — measured with `tools/harness.mjs` (the plugin bundle + a stub host for the browser + a temporary backend, captured in headless Chrome). Headless Chrome **refuses a window width under 500px** (at viewport 500 only the capture was cropped to 390, which made "the buttons go off screen" look real when it was an illusion) → the plugin page is put in an iframe of the requested size (`/?w=390&h=760`) so the media queries see the iframe width; with `&probe=1` the layout numbers are written to the parent's `#probe` via `postMessage` and read out with `--dump-dom`. The real problems confirmed: ① the switch button (a floating pill) sits **on top of** the attach and send buttons in the AI chat view, and its label is the name of "the other side", which is confusing → a segment bar at the top of the split, `.mbar` (📄 편집 | 💬 AI 챗, current view lit) plus "☰ 목록 펼치기/접기" (expand/collapse the list) on the tree tab (`.m-list`: 150px ↔ 62%); ② the tree strip had `max-height:190px` + `overflow-y:hidden` (inherited from the strip rule), so everything from the fifth item on was unreachable → `.explorer:has(.tree)` is block · 150px · `overflow-y:auto`; ③ the header status pill folded into 3 lines at 80px → one line, nowrap, with the bot name hidden.
- **Stretching the input box pushed the buttons off screen** — the textarea's default `resize: both` dragged the width along and pushed things outside the column → `resize: vertical`, `max-width:100%`, `max-height:min(220px, 40vh)`.
- Using the harness: `node tools/harness.mjs --port 8765` → `http://127.0.0.1:8765/?w=390&h=760&tab=botlore&view=centre` (`tab=settings&sub=에이전트`, `mode=chat&tab=editor`). Capture: `chrome --headless=new --window-size=520,820 --virtual-time-budget=9000 --screenshot=<abs> <url>` — **a separate profile directory for every capture** (with the same `--user-data-dir` it hands off to the live instance and exits, so no file is produced), and the output path must be an absolute Windows path.

## 1-9. Night of 2026-08-27 — v0.8.1: the web search agent could not search in the first place

- Structure: the search agent = the model from the `agent_search` preset + the **search provider API** in the `websearch` section (brave, tavily, serper, searxng). But **the card for configuring the provider was not in the plugin** (only the settings section existed, and the help text pointed at "the connection tab") → `research()` always said "웹 검색 프로바이더가 설정되지 않았습니다" (no web search provider is configured).
- Fix: `websearch.PROVIDERS` + **DuckDuckGo as a key-free default provider** (parsing `html.duckduckgo.com/html`, unofficial, measured OK), `provider_id()` empty → duckduckgo, `configured()/why_not()`, `GET /websearch`, `POST /websearch/test`. Plugin: a **"검색 제공자" (search provider) card** under the search agent card on the agent tab (choice, key, address, result count, save, search test). test_http `test_websearch_card`.
- **The main agent does not search the web itself**: the `web_search` tool removed, `web_research` always registered (returning an explanatory string when there is no search agent), and a rule in the instructions. Measured remotely: the search agent (gemini-3.7-flash@vercel) test succeeded in 26 seconds — the `ReadTimeout` on the user's screen was a tool round exceeding 60 seconds per request (`reasoning: high`) → the test now allows 110 seconds per request with `reasoning_effort=low`, and the plugin waits 240 seconds.
- **Lorebook writing-rules skill** `seeds/risuai-lorebook-style.md` (on by default, SEED_KEY v4): measured against Parma Knights (81 entries) — the body runs `### heading` → `#### subheading` → bullets, character sheets are 7–13k characters over 17 subheadings, keywords carry English/Korean/Japanese aliases, insertorder is layered (10000 output format · 2000 always-on canon · 1000 leads/system · 980 arc stage · 900 royalty · 800 supporting cast · 700 worldbuilding · 600 places · 500 monsters · 300 extras), 7 folders, the only decorator is `@@position pt_PI` on system entries, and progressive state uses the CBS `{{#when}}`. **Correction of fact**: `@@position`, `@@role`, `@@scan_depth` and `@@priority` are all in the RisuAI source (`lorebook.svelte.ts`, the `CCardLib.decorator.parse` callback) and do work (one per line at the very top) — the house style simply does not use them, and priority is the `insertorder` field (it is priority and order at once: a larger value survives the budget and is placed first). §5 of the spec skill corrected. `insert_order` and `folder` arguments added to the agent's `propose_lore_add/edit`, `order=` to `list_lore`, and a rule in the instructions. A **priority field** in the plugin's lorebook editor plus a numeric tag in the list (before this there was no field, so everything was 100).
- Agent panel: after the stream's `done`, it keeps blinking "제안·변경 카드를 정리하는 중입니다…" (organising the proposal and change cards…) while the cards (proposals, approvals, out/) load, and shows "완료" (done) once they are all in (before, the clock stopped and the cards turned up late, so it looked hung).

## 1-8. Night of 2026-08-27 — v0.8.0 **BETA**: 5 items of round 10 feedback (batch upload)

- **Folder upload speed** (1003 assets were slow) — one request per file plus base64 JSON was the cause. `POST /files/upload-many`: a binary body of `[u32 header length][JSON header {charKey,dir,extract,files:[{name,rel,size}]}][bytes back to back]`, and the plugin bundles roughly 16MB at a time and sends **2 concurrently** (`transport.postBytes`, `state.uploadBatch`); if a whole batch fails, only those files are retried individually. Files over 60MB are rejected. `files.upload_many` + a test_http check.
- Added to the picker screen's notice while disconnected: "웹 RisuAI(risuai.xyz)에서는 최초 연결까지 3분 정도 걸릴 수 있습니다 (프록시 → 직접 연결 폴백)" (on web RisuAI the first connection can take about 3 minutes — proxy, then direct-connection fallback) (only on a web host).
- The AI chat pane defaults to **50%** width (`.right { flex: 0 0 50% }`, double-clicking the gutter also gives half; the storage key was changed to `panelWidth2` so old values are ignored).
- The "weird characters" in front of file names = 🖼 and 🗜 breaking in an environment with no colour emoji font → files get an extension tag (`png`, `md`) and only folders get 📁.
- The count next to a folder: a pill badge (`.filetree .treebranch .n`, blue background when selected).
- The 새 봇으로 저장 (save as a new bot) tooltip and help text now say "기준선(편집 전 상태)" (the baseline — the state before editing). A BETA line in the README.

## 1-7. Night of 2026-08-27 — v0.7.2: 13 items of round 9 feedback (an intermediate cache collapsing the thumbnails into one · save as a new bot)

- **Every asset preview was the profile image** — the server log shows **only one** `GET /assets/blob` arriving per grid render (178KB). Every key was correct and present. So a cache between the browser and the backend (the tunnel edge) ignored the query string and returned the first response for every key (RisuAI's sw.js only catches `/sw/*` and `/tf/*`, so it is not that). Fix: binary reads go over **POST** (`POST /assets/blob {key}`, `POST /files/download {charKey,path}`) with `Cache-Control: no-store`; GET is kept for tooling.
- **Workspace "Cannot read properties of undefined (reading 'filter')"** — when the same middleman returns HTML with a 200, `readJson`'s `{_raw}` fallback flowed on as if it were a normal response and blew up at `data.areas.filter`. `transport.json()` now detects `{_raw}` and throws "백엔드 대신 다른 응답이 왔습니다 (JSON 이 아님): …" (a different response arrived instead of the backend's — not JSON: …), and the files tab records the failure in `clientLog` with a stack.
- **The URL and token fields looked empty after a plugin update** — RisuAI clears `//@arg backend_url/backend_token` on every update, while the real values were in `pluginCustomStorage`. The two `@arg` lines were removed from the header and the `getArgument/setArgument` path deleted — ⚙ → 연결 is the only place to enter them.
- Settings connection tab: the "에셋 덤프 실측" (measure asset dump) card deleted (`measureAssetDump` survives only in code); "에셋 스토어" (asset store) → **"포켓리스 직렬연결 (포켓리스 사용시만)"** (direct PocketRisu connection — only if you use PocketRisu).
- **Search agent connection test** — `POST /config/test {section:"agent_search"}`, the same button on both preset cards.
- Skills: every seed on by default, the "말투 통일" (unify the tone) seed deleted (`RETIRED_SEEDS`), and existing installs get `skills.defaults_once()` (migration `skills_defaults_v1`: turn everything on and delete the retired seed). The skill card's description became "매 요청에 실리는 것은 이 목록뿐 … 본문은 load_skill 로 그때" (only this list rides on every request … the body comes then, via load_skill).
- Meta tab order: name → description → first message (+ alternate greetings) → global note override → divider → bot version → creator notes (`FIELD_RANK`).
- AI chat: the attach button goes **above** the send button, stacked vertically (`.agentbtns`).
- **Cloning hung at "복제 중…"** (cloning…) — RisuAI's db permission dialog opens **behind** the fullscreen plugin container. `host.cloneBot` now calls `hideContainer` before `getDatabase` and `showContainer('fullscreen')` when it finishes.
- **Create a cloned bot → 새 봇으로 저장** (`state.saveAsNewBot`): clone the current RisuAI state (the baseline) as "<이름> (백업)" (<name> (backup)), chats included → write the edits back into this bot and commit → carry on editing. Popup: "현재 편집 중인 봇을 새 봇으로 저장하였습니다. 기존 봇은 "…(백업)" 이름으로 복제되었습니다." (the bot you were editing has been saved as a new bot; the original was cloned under the name "…(백업)"). The agent's `propose_clone_bot` is unchanged.
- Smoke: `test_save_as_new_bot` (the backup name, chats coming along, the edits written to the live bot, container hide/show, returning with no changes).

## 1-6. Night of 2026-08-27 — v0.7.1: 4 items of round 8 feedback (partial-replace tools · a hooks reference)

- The header connection status is only a dot + "백엔드 연결 안 됨" (backend not connected) + (retrying) — the error text and the settings button moved to the picker screen notice and the ⚙ → 연결 diagnostics (they stay in the tooltip).
- The skills card was holding on to a pre-connection error ("토큰을 보내지 않았습니다" — no token was sent) → `buildSkillsCard({onMount})` registers it in `refreshers` (the same path as the preset and key cards).
- **Partial-replace tools** `propose_lore_replace / propose_memory_replace / propose_card_replace(find, replace, replace_all)` — `textedit.replace_once` (exactly one site; none, and it hints at similar lines; two or more, and it demands context). The whole-replace tools' docstring became "only when rewriting the whole thing". A rule added to the instructions. `tests/test_textedit.py` in the gate.
- **A RisuAI processing-order reference** `seeds/risuai-hooks.md` (verified against the sources `index.svelte.ts`, `scripts.ts`, `scriptings.ts`: editinput (stored) → start → editprocess (for the request) → assembly → Lua editRequest → model → editoutput (stored) → output → editdisplay (displayed); the Lua hook runs before the regexes of the same stage; `@@emo/inject/move_top/repeat_back`, the `<order N>` and `<cbs>` flags, a misdiagnosis table). Seeded as an on-by-default skill (`SEED_KEY` v3 — existing installs pick it up on the next startup), with a 6-line summary in the instructions.

## 1-5. Night of 2026-08-27 — v0.7.0: 14 items of round 7 feedback (a misdiagnosed connection · files tab rewritten · diff)

- **"Please turn on Use Plain Fetch" was a misdiagnosis.** The server log (`/logs`): 19:30:04 `/health` 200 → up to 19:32:04 the requests **never reached the backend at all** → normal from 19:32:04 on, with no config change. So it was the tunnel/VPN warming up. Checked the mainline source (`globalApi.svelte.ts` `fetchNative`): on web, `throughProxy = !db.usePlainFetch`, and `networkRoute:'local_network'` applies only to private IPs, where web throws anyway. Fix: `transport.connect` now (a) on a fetch exception → "백엔드에 닿지 못했습니다 (원인) … 자동 재시도" (could not reach the backend (reason) … retrying automatically), (b) on a signature mismatch → **quotes the response it got** ("HTTP n · 80 characters of body") — Plain Fetch is mentioned only as the third possibility on the diagnostics card. `startReconnect` now **retries forever** at 30-second intervals (it used to give up after 10 → the user reloaded), the header shows "자동 재시도 n회째" (auto-retry number n), and the moment it connects `clientLog('connect recovered', {attempts, seconds, lastError})` means **next time the actual error is in the server log**.
- **Agent panel**: (1) the timer stopped at the first text, so the clock next to the tool stage's "…중입니다" (…in progress) was frozen → it now runs to the end of the turn (`finish`). (2) tool chips were pinned to one line **above** the body → the bubble became **sequential segments** (chip line → body → chip line → body…, with permission cards in place too). (3) approval request cards get **전체 승인·실행 / 전체 거절** (approve and run all / reject all) (run in sequence, stopping on failure) plus folding past 6 items. (4) the send button vanished when the panel was narrowed → `.agentinput { flex:1; min-width:0 }` + `.sendbtn { flex-shrink:0 }`.
- **Workspace files tab rewritten** (`tab-files.ts`): left = **the folder tree only** (areas and subfolders, carets, droppable folders), centre = **the file list of the selected folder** (name, size, modified; checkboxes; click/Ctrl/Shift multi-select; Delete to delete — a confirmation line plus Delete once more; Enter/double-click to open; Ctrl+A) or a **thumbnail grid** (image folders, 6 at a time through the backend's `/files/download`), a preview (text, images; everything else saves), **download = one zip when it is several files or a folder** (`POST /files/zip`, named from the common parent), **drag upload** (file and folder trees via `webkitGetAsEntry`, folder upload via `webkitdirectory`, with progress shown), **a zip is extracted or left as-is** by choice (`/files/upload extract`, excluding `..`, absolute paths and `__MACOSX`, capped at 512MB/5000 entries), out/ is a valid upload target too, and nested folders are created automatically. "임시 문서" (scratch documents) is a virtual folder. base64 via FileReader (the old byte loop took seconds on 20MB).
- **Tab position**: the asset sync badge (`margin-left:auto`) sat between assets and workspace files, which pushed the files tab to the opposite end → the badge moved to the end of the row.
- **Deleting bot snapshots from the picker screen** (a ✕ per row plus cleanup of the last 5 / all), **immediate feedback on snapshot deletion** (the row dims — the server takes 5ms, the round trip is the slow part; the confirmation label is "삭제 확인" (confirm delete)).
- **Focused editing** (`dom.focusEdit/focusButton`): a ⤢ on the text boxes for meta, lorebook (chat/bot), Regex (out, background HTML), Lua and long-term memory — a full-screen modal whose input is mirrored into the original box in real time (saving still uses the original button).
- **Diff of the changes** (`dom.lineDiff/diffView/diffCard`): an LCS line diff (common head and tail stripped, capped at 4M cells), IDE-style marks down the left (a coloured −/+ gutter), identical runs folded as "… N줄 같음" (… N lines identical). Meta, Regex, background HTML, Lua, long-term memory (when open) plus the lorebook (a content diff + a summary of name/key/always-on changes). The backend sends `original` along: `store.lore()` and `card._script_row()` (edited rows only).
- **Asset thumbnails**: calling the host's `readImage` for 300 images at once broke half of them on web → **prefer the backend store's `/assets/blob`** (whatever is present), 6 at a time, with the host as the fallback.
- Skipped: line wrapping in the mobile search box (the user said to skip it).
- Verification: test_http plus zip/extract/original checks (482 ok), smoke rewritten for the files tab plus diff/focused-editing checks (320 ok). The Plain Fetch row of the docs/05 troubleshooting table replaced.

## 1-4. Morning of 2026-08-27 — v0.6.2: two errors in the server log

- **A Responses endpoint not answering** = `400 Invalid 'input[29].id': 'reasoning'. Expected an ID that begins with 'rs'`. pydantic-ai's chat/completions path leaves the response's `reasoning` field as `ThinkingPart(id='reasoning')`, and the Responses path resends the history's ThinkingPart as a reasoning item with that `id` intact → switch a preset from the gateway to a Responses endpoint and it blows up. Fix: `session.neutralise_thinking(history, model)` — when the target is `OpenAIResponsesModel`, keep the id only for items that start with `rs_` and come from the same system, and set the rest to `id=None, signature=None` (the condition under which pydantic-ai does not send them). `tests/test_history.py` added to the gate.
- **Only 18 lorebook entries** = `list_lore` attached 1500 characters of body each and was silently truncated at 25000 characters. Fix: the listing carries all of them with no bodies (name, key, always-on, character count, an 80-character preview, and an explicit "이하 N개 생략" (N further entries omitted) past 60000 characters), bodies come from a new tool `read_lore_entry(id)`, and `read_lore` is identical to the listing. **Correction**: a workaround through scripting did exist — the sandbox already has `.scratch/scope.db` with only this bot's rows copied into it, plus `risuhina.lore()/conn()` (it is in the instructions too). The agent did not use it, and the tool did not report the truncation.
- **Planning for the next session (user's instruction: no simple fixes)** → `docs/07-agent-data-access-plan.md`: the snapshot (`scope.db`) versioning issue (the stamp cannot see changes to lore, script content, assets or memory), the two-pronged permission model (tools vs scripts), option A (strengthen the stamp) / **B (a live, read-only, bot-scoped connection to the original DB through an authorizer, with the settings and API key tables blocked at the source and every write going through the approval queue)**, and a full audit of the truncation rules.

## 1-3. Night of 2026-08-26 — v0.6.1: 10 items of real-use feedback on 0.6.0

- **Thumbnails on web too**: the CSP in RisuAI mainline's `factory.ts` changed to `img-src * data: blob:` (8/25 source; the old note "mainline has no img-src" is stale) → the `hostPlatform==='web'` gate in `tab-assets.loadThumb` removed. Thumbnails go `readImage` → blob (nothing to do with the backend; the hash key is the same).
- Markdown **tables** (`markdown.ts` GFM tables, alignment colons), and `renderMarkdown` for update notes.
- Snapshot **delete/cleanup**: `snapshots.delete/clear(keep)` and `delete_card/clear_card`, routes `/checkpoint/{delete,clear}` and `/card/checkpoint/{delete,clear}`, UI `snapshotCleanup` (✕ per row, last 5, all). A "현재" (current) row at the top of the version list plus a "최신 스냅샷" (latest snapshot) badge (chat, bot, and the bot picker screen).
- The snapshot list on the bot picker screen became a full-width `chatlist snaplist` outside the card (the same shape as the chat list). **The default mode is bot** (`shell.mode`, `state.editMode`). `openPicker` reopens after a preset is saved. Popover `maxWidth = vw-16` plus `.catalogpop` width `min(520px, 100vw-32px)`. Help text shortened.
- test_http: checkpoint delete/clear checks.
- **Single-screen mobile** (`panes.ts` `mobileToggle`/`showMobileAgent`, `.split.m-agent|.m-centre`, `localStorage hina.mobileView`, agent by default): at ≤760px the gutter is hidden and the `.mtoggle` button at the bottom right swaps between the edit screen and the AI chat. Dragging leaves an inline flex-basis, hence `!important`.

## 1-2. Night of 2026-08-26 — v0.6.0: parameters are data, not code (docs/04 Appendix H)

- **Why**: pydantic-ai sends `temperature` even to the gpt-5 family (400 "Only the default (1) value is supported"), puts `strict:true` in tool definitions, and sends the cap as `max_completion_tokens`. Survey (from the docs, 2026-08-26): official OpenAI **refuses Chat Completions with tool calls outright** on the gpt-5.6 family (Responses required); the Anthropic, Gemini and Vertex compatibility layers **ignore** fields they do not know; Ollama takes only `max_tokens`; OpenCode splits between `/responses` and `/chat/completions` per model, and Go is `opencode.ai/zen/go/v1`; Neuralwatt = `api.neuralwatt.com/v1`; Vertex takes OAuth tokens only (no API key).
- **Structure** (`pyserver/app/providers.py`): `PROFILES` (id · api · hosts · auth · modelExample · endpoint chat|responses · capField · strictTools · unsupported · modelRules · template · note · docs) → `plan_for(cfg)` builds `Plan{settings, drop, cap_field, strict_tools, api}` in this order: the section's numeric fields → the profile's reject list → the preset's **`params` JSON** (real field names, `null` = do not send, with `api` and `strict` as pseudo keys). `agent._model_for` picks `OpenAIChatModel`/`OpenAIResponsesModel` from `_client` (a create wrapper that pops the `drop` fields — library fields such as `stream_options` too) plus `_profile` (`merge_profile(openai_model_profile, {max_completion_tokens supported, strict allowed})`). `hint(text)` pulls the field out of a 400 body and states the JSON to put in — applied in `session._explain`, the connection test and the search agent. The connection test sends with the same plan (API and fields).
- Presets: `temperature` defaults to **None (not sent)** — `-1` in the NOT NULL DB column (`TEMP_UNSET`); a `params` column (schema v11). `providers` and `maxParams` on `/presets`, plus `GET /catalog/providers`. Plugin: a *parameter JSON* field in the editor plus a provider guidance box (fills in example JSON), and auth/address guidance on the key form.
- Everything else (user feedback): Hina's default instructions moved to English with the Korean speech style "~해요/~할까요?" (presets still on the old default text are refreshed automatically by `_migrate_default_text`) · the agent's scroll position survives a tab switch (`mountAgent` saves and restores scrollTop before detaching) · progress and results shown for approve / approve all / clone bot (left in the conversation as a `bubble note`) · snapshots can be named and renamed (`/checkpoint/rename`, `/card/checkpoint/rename`, `openSnapshotName`) · a lorebook `alwaysActive` badge and checkbox (turning it on clears the key) plus the agent's `always_active` · a per-tab change-count badge on the bot tabs (`refreshTabBadges`) · `start.bat` respects `RISUHINA_HOST` · **a full revision of the bundle README** (types 1 and 2, NSSM and pm2, Tailscale, Cloudflare and LAN, updating).
- Verification: `tests/test_providers.py` (added to the gate), params/providers/rename checks in test_http, and the smoke test fixed to find the instructions textarea by placeholder. Released as v0.6.0. **zikmunt-pc gets raised by the user pressing plugin `+` → backend update (doubling as the first real-use verification of the 0.5.2 updater)** — if that fails, overwrite with the zip over ssh (`nssm stop` first).

## 1. 2026-08-26 — round 3 + the rename (v0.5.0) (docs/04 Appendix G)

| Area | What |
|---|---|
| Rename | Risu Elf → **Risu Hina** throughout (plugin `risu-hina`, the signature, assets `Risu.Hina.*`, DB `risuhina.db`, environment variables `RISUHINA_*`). Compatibility: the old prefix, signature and DB are adopted, and `plugin/Risu.Elf.Plugin.js` is kept as the same bundle. The repository and directory names stay as they were |
| Agent | passes `mode` and refuses edits made from the wrong screen (`_wrong_half`) · failed and aborted turns are stored in the history too · automatic summarisation when the budget is exceeded (`compact_history`, called right before the run) · abort (AbortController) and a continue button · a welcome message |
| Bot/files | meta `replaceGlobalNote` · a bot snapshot list on the first screen · workspace folders (`/files/mkdir`, `/files/move`, upload folders) · sharing across bot versions (`family_key`, the `risu_hina.family` stamp) · the bot name in the header · a settings shortcut in the connection warning |
| Settings | opening settings replaces the tab row with sections (`getSettingsBar`) · cards reload after connecting (`refreshers`) · an API key / auth tab (add and edit modals) · preset `›` |
| Verification | test_http `test_workspace_folders_and_family` and others, smoke updated. Gate ALL GREEN |

**Deployment**: at the user's request, not deployed to zikmunt-pc directly — the user verifies the plugin `+` → backend update path themselves. The old updater picks its asset by `Install.Package`+OS, so it takes the `Risu.Hina.*` zip too, and it looks for `*/pyserver/app` inside the zip, so the changed top-level folder name does not matter either.

## 1-0. Night of 2026-08-26 — v0.5.2: the updater died moving its own interpreter, and the version gate

- **The first real backend update (0.5.0→0.5.1) failed**: `_install` did a `shutil.move` on the running `python/` → Windows had the loaded `.pyd` (jiter) locked, giving `PermissionError`, and the second attempt hit `FileNotFoundError` on a half-deleted tree. The `Unauthorized` before that was the reinstalled plugin (under its new name) having an empty token.
- Fix: the interpreter is **staged as `python.new`**, and `start.bat`/`start.sh` swap it in on the next startup (`python`→`python.old`). The same bundle (the `python/bundle.txt` stamp = Python version + lock hash) is skipped. **An install running the old launcher needs its launcher replaced by hand once** for the swap to happen (the updater leaves it as `start.bat.new`).
- Fixed a bug where the plugin's `selectedValue()` read the `selected` attribute ahead of the user's own choice (key selection not taking, a missing keyRef). If the connection comes up late, it retries and uploads (`startReconnect`, watching for health to come up).
- **Version gate**: when major.minor differ, the plugin refuses every call except `/health`, `/update/*`, `/plugin`, `/logs`, `/diag` and `/config`, and the header says "버전이 다릅니다 → 백엔드 업데이트로 / 플러그인 업데이트" (the versions differ → go to backend update / update the plugin). The backend update card moved to the **top of the connection tab**.
- zikmunt-pc recovery (done, directly over ssh): `manage.ps1 stop` → deleted the damaged `pyserver\python` and `python.new` → `Expand-Archive -Force` of the 0.5.2 zip over `D:\code` (keeping `data/`) → confirmed `bundle.txt`=`3.11.9 deps=4fe2e353af438144 pip` → restarted the NSSM service → `/health` 0.5.2.
- **NSSM operating rule**: the `RisuHina` service is `AppExit Restart`, so `manage.ps1 -Action stop` on its own (killing the process) just has NSSM bring it back moments later, and in between the status reads **Paused**. Replacing files or moving `data/` must go `nssm stop RisuHina` (or `Stop-Service RisuHina`) → do the work → `nssm start RisuHina`. nssm path: `C:\Users\bacon\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_…\win64\nssm.exe`. An ssh session carries an administrator token, so `setup.bat -Service` works as-is (if it is already registered it stops with "already exists" — run `uninstall.bat`, then register again).

## 1-1. 2026-08-26 — round 4 (v0.5.1)

| Area | What |
|---|---|
| Agent | the default preset = the '히나' (Hina) persona instructions (`presets.DEFAULT_INSTRUCTIONS`, prefilled into new presets, a fallback for empty instructions), default instructions for the search preset, an **agent name** (`agentName`, "당신의 이름은 …" (your name is …) in the instructions) · the `run_shell`/`pip_install` tools = **a permission prompt** (`permits.py`: the tool waits, the panel polls `GET /permits`, allow / deny / always allow this turn, reset when the turn ends) |
| Settings | the API key / auth card = name, provider, API key, memo (the URL comes automatically from provider → models.dev / the pinned list, with manual entry folded away) · picking a key in a preset hides the URL and key inputs · an explicit **선택** (select) button on list rows · `›` on empty rows too · the key and preset modals do not close on an outside click (`modal sticky`) · **✕ 닫기** (close) at the end of the settings row · padding on the save notice |
| Connection | 401 → the guidance "data/token.txt 를 ⚙→연결→토큰에" (put data/token.txt into ⚙ → 연결 → 토큰), 429 → retry shortly |
| Bundle | **the pip wheel is bundled** into the Windows embedded Python (added to `_pth`) → `pip_install` works in an installed copy too |

## 1a. Night of 2026-08-25 — round 2 (v0.4.0): 20-odd items of bot tab and settings feedback (docs/04 Appendix F)

| Area | What |
|---|---|
| Meta | a bot version row added (`characterVersion` ↔ `additionalData.character_version`) · 첫 인사 → 퍼스트 메시지 (first greeting → first message) · `backgroundCSS` retired (it is not in the RisuAI UI) |
| List/search | the left tree column can be resized (`splitter side:'left'`, `treeWidth`) · every search box moved onto the toolbar row (`shell.setToolbarSearch`) |
| Triggers | the same mode buttons as RisuAI, V2/Lua (+V1) · Lua is a single text box (no event selection) · a read-only summary for V2/V1 · switching mode goes through RisuAI's initial object |
| Assets | a grid (thumbnail + name) · click the name to edit · ✕ deletes the reference · tools: strip extensions in bulk, bulk rename by regex (`POST /card/assets/rename`) · **an asset reference = `card_scripts kind='assetref'`**, and the patch turns it back into the three lists to write it back |
| Gate | 반영 no longer waits for the sync · only asset edits and charx wait · a `syncbadge` (%) at the end of the tab row · the charx button moved to the bot bar |
| Agent panel | the welcome examples differ by mode (bot/chat) · the note "현재 탭뿐 아니라 선택된 봇·챗 전반을 안다" (it knows the whole of the selected bot and chat, not just the current tab) |
| Mobile | `.gutter { touch-action: none }` (touches were being taken as scrolls and throwing pointercancel) |
| Settings | sections 연결 / API 키 / 에이전트 / 스킬 / 정보·로그 (connection / API keys / agent / skills / info · logs) · one selection each for the **general and search agents** (`kind`, the `agent_search` section, the `web_research` tool) · an **API key tab** (`api_keys`, DB v10, `keyRef`) · a **model catalogue** (models.dev, `GET /models/catalog`) · the token warning on the diagnostics card only on failure |
| Agent knowledge | the random pool (same name = one at random), the charx `_N` filename rule, and how to edit an assetref row went into the instructions and describe_helper |

Tests: test_http `test_card_assets` and `test_keys_and_agent_kinds`; in smoke, the asset grid, trigger modes, toolbar search, syncbadge, the 5 settings tabs, key selection. Gate **ALL GREEN**.
**0.4.2**: settings cards re-read once the connection is up (`tab-settings.refreshers` — the "토큰을 보내지 않았습니다" (no token was sent) error loaded before connecting used to stay on the card).
**0.4.1**: an internal follow-up to 0.4.0 — nothing user-facing of its own.

## 1b. What went in on 2026-08-25 — the release and all of M2

**Operations**: M1.1 deployed (19:51) → v0.2.0 tagged and pushed → 0.2.0 deployed (20:03) → M2 ①–⑦ → v0.3.0 tagged and pushed → 0.3.0 deployed (21:01).
Remote execution (`ssh zikmunt-pc "powershell -File …deploy.ps1"`) is **something I can run myself** (the earlier "the classifier blocks it" was wrong). What does get blocked is
`gh release create` (publishing externally) and compound remote commands with `del` mixed in. The script is `_stage\deploy.ps1` (generic: `*.py` + the newest `risu-hina-*.js`).

**M2 ① backend asset store** (`assets.py`, commit `ba015b0`) — `data/assets/<sha256>.<ext>` globally, DB **v9** `asset_blobs`/`asset_keys(state present|missing|failed)`/`char_assets` (the manifest, in card order).
`POST /assets/manifest{refs,hubPull}` → check against the store → fill immediately over the SQLite fast path → hub pull on a background thread (httpx, 6 workers) → return `missing`.
`POST /assets/upload{items[{key,data}]}` (per-item failure reporting), `POST /assets/fail`, `GET /assets/status` (`complete` = missing 0 ∧ no pull running), `GET /assets/list`, `POST /assets/gc` (unreachable + 7 days), `GET /assets/blob?key` (raw).
config `assets{maxItemBytes,gcDays,hubPull,hubWorkers,hubTimeoutSeconds}`, `pocketrisu{savePath,serverUrl}`. An `assets` summary in `/diag`. `char_assets` in the `run_python` scope.db.

**M2 ② plugin background importer** (`assets.ts syncAssets`, `a383b5b`) — automatic right after `state.upload()`. manifest → (if pulling, poll status → request the manifest again) → readImage for the missing keys only, **4 concurrent (web) / 6** → batch upload at 8MB / 50 items (up to 2 batches overlapping in flight) → `/assets/fail`. A 404 on the route means `unsupported` (the gate opens).
`state.assetSync`/`assetGateReason` → read by the bot bar's `applyBlockReason` (`setAssetGate` deleted). A progress line, a bar, and 중단/다시 동기화 (abort / resync) on the bot card.

**M2 ③ SQLite fast path** — `assets._fast_fill`: `file:…?mode=ro` + `query_only` + `busy_timeout`, with automatic detection of the key/value table (PocketRisu uses `kv(key TEXT, value BLOB)` with the original bytes as-is — measured on zikmunt-pc). If `__jwt_secret` is present, `serverWrite:true` (a flag only).

**M2 ④ assets tab** (`tab-assets.ts`, `b8642be`) — the fifth bot tab (`BOT_TABS` += assets, 11 tabs). Grouped by field, search, status badges, item detail (key, hash, size), desktop thumbnails (readImage→blob, 40 cached), and format icons on web. Settings → 연결 → an **에셋 스토어** (asset store) card (saves savePath, store size, GC).
**The header redraws only when the sync state changes** — drawing on every emit wiped the charx result (the smoke test caught it).

**M2 ⑤ charx** (`charx.py`, `d6f5919`) — a Python port of `createBaseV3` plus the working-copy overlay (`working_character`: card_fields/greetings/global lore/scripts) → `out/<name>.charx`. x_meta→asset cross-reference, assets STORED, card.json last, **no module.risum** (inline — confirmed against the importer source), and the icon entry always present. `POST /charx/build{allowMissing,name}` (409 + a list if anything is missing), `GET /charx/preview`. `GET /files/download?charKey&path` = a raw stream (Content-Disposition). Plugin: "charx 만들기" (build charx) on the assets tab (with a fallback that builds without the missing assets), and "내 PC에 저장" (save to my PC) on the files tab (`transport.getBinary` + `host.downloadBytes`).

**M2 ⑦ agent assets** (`14f14f0`) — `list_assets` / `fetch_assets(names)`→`scratch/assets/` / `propose_asset_add(name,path,field)` / `propose_asset_replace(name,path)` (PNG validation, `assets.stage_file`). HOST_KINDS += `host_asset_add` and `host_asset_replace` → the plugin's `applyAssetAction`: `/files/download` → `Risuai.saveAsset` → `host.writeCharacter{additionalAssets|emotionImages|ccAssets}` (a CardUpdate extension) → `POST /assets/adopt` → readHost + upload. assets added to `propose_open_tab`.

**⑥ the fflate in-plugin assembly fallback is on hold** (Appendix E.5). The RisuAI/PocketRisu sources are at `C:\code\vepo-bot\{RisuAI,PocketRisu}` (updated today to `c0ed1026` / v1.10.0 `98e96833`; the charx import code in both is identical). The charx skill original is `C:\code\vepo-bot\.claude\skills\charx\`.

Tests: test_http `test_assets_store` (manifest/upload/dedup/gate/failed retry/blob/GC/400 and 404) · `test_charx_build` (rejection → allowMissing → a normal build → zip structure, the working copy applied, download, adopt); smoke `test_asset_sync` (import one portrait → complete → 0 uploads the second time) and, in `test_bot_tabs`, the gate opening, the assets tab, the charx build, the files tab save button. Gate **ALL GREEN**.

## 2. What exists right now (at a glance)

```
RisuAI(PocketRisu | web risu.xyz) ── plugin iframe(risu-hina.js) ──nativeFetch──▶ backend (FastAPI)
   127.0.0.1:6020 or a public address (cloudflared http://elf.francis.kr)   ├─ data/risuhina.db   turns · lorebook · memory · variables · card fields/scripts · asset keys/manifest · sessions · approval queue · snapshots
                                                                            ├─ data/assets/<sha256>.<ext>   content-addressed store (shared across bots)
                                                                            ├─ data/workspace/<char>/  card.md · original/ · out/(charx) · scratch/assets/ · skills/
                                                                            ├─ data/skills/<id>/SKILL.md
                                                                            └─ Pydantic AI agent (OpenAI-compatible gateway)
   asset inflow: hub pull (web account) | reading risuai.db directly (PocketRisu, same PC) | plugin push (everything else)
```

**Plugin tabs**: `선택 ┃ [챗: 챗 에딧·챗 로어북·장기기억·챗 변수 | 봇: 메타·봇 로어북·Regex·트리거·에셋] ┃ 워크스페이스 파일` (+ ⚙) (picker ┃ [chat: chat edit · chat lorebook · long-term memory · chat variables | bot: meta · bot lorebook · Regex · triggers · assets] ┃ workspace files).
The asset sync is waited on by **asset editing and charx only** (반영 does not wait). Adding or replacing an asset (on approval) is the only card change written to RisuAI immediately; renaming and deleting are card material (assetref), so they happen at 반영 time.

## 3. Deployment procedure (verified, I run it myself)

```
# (from 0.5.2 on, NSSM service) — for a hotfix, unpack the zip over D:\code or replace only app/*.py:
#   ssh zikmunt-pc "<nssm> stop RisuHina" → scp/Expand-Archive → ssh zikmunt-pc "<nssm> start RisuHina" → /health in a new session
# (the 0.4.x era, path D:\code\risu-elf — gone now)
scp -q pyserver/app/*.py plugin/dist/risu-hina-<ver>.js zikmunt-pc:D:/code/risu-elf/_stage/
ssh zikmunt-pc "powershell -ExecutionPolicy Bypass -File D:\code\risu-elf\_stage\deploy.ps1"   # stop → app.bak-<time> → replace → delete __pycache__ → start
ssh zikmunt-pc "curl.exe -s http://127.0.0.1:6020/health"   # must be a new SSH session
```
The original `deploy.ps1` is in the session scratchpad; a copy is still in the remote `_stage`. If the seeds change, upload `_stage\seeds\` too (the script copies it when it is there).
The plugin is reinstalled into RisuAI by the user. **Move `data/` with the server stopped** (§4).

## 4. The 2026-08-23 incident — the DB went back to 17:47

The dev install's `data/` was copied along with its `-wal` and `-shm`, and the server started on it trusted the stale wal-index and wrote commits outside the chain; the next restart threw away 60 commits.
Evidence in `data/forensic-20260823/`. Rule: **move `data/` with the server stopped.** (`docs/00`)

## 5. What to do next (in order)

1. ~~**GitHub release v0.3.1**~~ — done (21:20). Procedure for the next release — **run it only when the user asks for a release (§0)**: bump the version in 5 places → `pyserver/.venv/Scripts/python.exe tools/release.py` (this refreshes `plugin/Risu.Hina.Plugin.js` in the repository too) → gate → commit (bundle included), tag, push → deploy →
   `cd release && gh release create v<ver> -R nilsonwhang3-spec/risu-hina --title "Risu Hina <ver>" --notes-file notes-<ver>.md <the 2 zips> Risu.Hina.Plugin.js SHA256SUMS-<ver>.txt`
   (run it in manual permission mode, since the classifier blocks it in auto mode). The user has to reinstall `plugin/Risu.Hina.Plugin.js` into RisuAI by hand once before `+` starts appearing.
2. **Real-use check (M2)** — PocketRisu (zikmunt-pc, fastPath on): open the panel → the progress line on the bot card → complete within seconds (reading SQLite directly) → thumbnails on the assets tab → build charx → save from the files tab → **import into PocketRisu** (whether the assets, lore, triggers, Regex and CBS render the same as the original — this is the core verification for charx). Web Risu (elf.francis.kr): hub pull progress, 0 items the second time, the gate.
   Agent: "turn the profile black and white and add it as an extra asset" → fetch_assets → PIL → propose_asset_add → approve → check the card in RisuAI.
3. **Security review of the public backend** — `elf.francis.kr`: token length, the rate limit on failures (present: 20 per 60 seconds), the `tokenRequired:false` exposure on `/health`, and whether `/diag/*`, `/assets/*` and `/files/download` sit behind auth (AUTH_EXEMPT is health and plugin.js only — confirmed).
4. **On hold, written up but not started**: an MCP surface on the backend so Claude Code and other clients can work
   the workspace with RisuAI closed — `docs/08`. The relay idea that came with it (the plugin as a headless job
   runner) was dropped there: a RisuAI tab has to be open either way, and then the panel is the better UI.
   `docs/08` §4 says why it should be planned together with `docs/07`.
5. On hold: the in-plugin fflate assembly fallback (⑥), PocketRisu bulk-write (non-PNG), module assets (v2), a block GUI for trigger V2, polishing the skill descriptions, recovering the 6 lost lorebook entries (drafts in `out/`).

## 6. Quick commands

```
bash tests/gate.sh                               # gate (system python is 3.6 → venv automatically)
pyserver/.venv/Scripts/python.exe tools/release.py   # release assets (the system python gives a SyntaxError)
node plugin/build.config.mjs && node tests/plugin_smoke.mjs
ssh zikmunt-pc "curl.exe -s http://127.0.0.1:6020/diag"          # assets{blobs,bytes,fastPath,serverWrite}
ssh zikmunt-pc "curl.exe -s \"http://127.0.0.1:6020/assets/status?charKey=<ck>\""
ssh zikmunt-pc "curl.exe -s \"http://127.0.0.1:6020/charx/preview?charKey=<ck>\""
```
