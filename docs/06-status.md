# 06. 구현 상태 — 2026-08-25 기준

다음 세션에 이어서 할 사람(=나)을 위한 한 장. 무엇이 있고, 무엇이 바뀌었고, 어디까지 배포됐고,
무엇이 남았는지. 설계의 *이유*는 `docs/04`, 저장 구조는 `docs/02`, 배포 환경은 `docs/00`.
봇 편집 모드의 전체 계획(M0 실측 결과·M2 명세 포함)은 `~/.claude/plans/risu-elf-whimsical-lovelace.md`.

## 0. 다음 세션 시작점 (먼저 읽을 것)

**코드 상태**: master `9a77c62` "Bot editing: the card gets the chat pipeline, and a measured asset plan"
(29 파일, +4087/−361) = M0 + M1 + M1.1 전부. **origin 에 미푸시.** 게이트 ALL GREEN 상태로 커밋.
이 문서(06)의 갱신분만 워킹 트리에 미커밋.

**배포 상태 (2026-08-25 19:51 `deploy-m1.ps1` 실행, 새 SSH 세션 해시 대조로 확인)**:

| 어디 | 무엇 | 비고 |
|---|---|---|
| test-server **실행 중** `pyserver/app` + `plugin/risu-elf.js` | **`9a77c62` = M1.1** (app/*.py 23개 해시 일치, 플러그인 `F19948B3`) | 직전 백업 `app.bak-20260825-195105` |
| RisuAI 설치 플러그인 | 사용자가 dist 에서 수동 설치한 버전(M1 또는 M1.1 — 미확인) | v0.2.0 릴리스 후 `+` 로 갱신되는지 확인 (§5-3) |

원격 실행은 `ssh test-server "powershell -ExecutionPolicy Bypass -File ..."` 로 **내가 직접 할 수 있다**
(2026-08-25 확인 — 이전 세션의 "권한 분류기가 막는다"는 더 이상 사실이 아님). 확인은 반드시 **새 SSH 세션**에서.

## 1. 2026-08-24 에 들어간 것 — 봇(카드) 편집 M0·M1·M1.1

**M0 (에셋 덤프 실측, 웹리스 실증)** — 웹리스(risu.xyz)가 공개 백엔드(cloudflared
`elf.example.com`)로 연결·에이전트 동작 확인. 2980장/142.6MB 실측: 읽기 42.8분(장당 862ms,
계정 스토리지가 장마다 hub GET) vs 업로드 2.6분 — **병목은 readImage**. 백엔드의
`sv.risuai.xyz/rs/<key>` 직접 GET = **200 OK** → M2 는 계정 사용자용 "백엔드 직접 풀" 채택.
측정 장치: `plugin/src/assets.ts`(M2 임포터 원형), `POST /diag/asset-echo`, `GET /diag/rs-probe`,
설정→연결 탭 "에셋 덤프 실측".

**M1 (봇 텍스트 편집)** — 챗 편집과 같은 문법으로 카드를 편집한다.

| 층 | 무엇 |
|---|---|
| DB v8 | `card_fields`(memories 문법: body/original), `card_scripts`(lore 문법: entry/original_json/origin), `card_checkpoints`. 카드 셸 없음 — 반영이 fresh 재읽기+오버레이라 미모델링 필드는 원래 안 건드린다 |
| 업로드 | `cardOf` 화이트리스트 폐지 → full-character(chats 제외) + `cardFull` 플래그. **card_reset 분리**: 새 챗 first-seen 이 카드·globalLore 작업본을 더는 리셋하지 않음(기존 잠재 버그 수정) + `cardReset` 페이로드("카드만 다시 읽기") |
| HTTP | `/card` `/card/scripts` `/card/field` `/card/greeting[/delete]` `/card/script[/add|delete|move]` `/card/patch` `/card/changes` `/card/commit` `/card/reset` `/card/checkpoint[s|/restore]` `/lore/move` — 전부 `_char` 스코프 |
| global 로어 | `store.*_global` 5종(`scope='global' AND chat_key IS NULL`) + `move_lore`. `h_lore_add`/`_lore_add` 의 global 행 chat_key 오염 수정 |
| 플러그인 | `host.writeCharacter`(writeChat 규약: chaId·before 검증, **chats 강제 불변**, update 에 chats 있으면 throw), `host.cloneBot`(새 chaId + 참조 공유 에셋 + `getDatabase(['characters'])`→push→`setDatabase`→`checkCharOrder`). `botbar.ts`(챗바의 형제: 반영 팝오버=RisuAI 반영/복제 봇 생성/기준선 되돌리기 + 스냅샷·버전, `isLiveBot` 게이트, M2 에셋 게이트 훅 `setAssetGate(reason)`) |
| 에이전트 | `read_card`(행·id) `read_card_field` `list_scripts`/`read_script`(대형 HTML 은 온디맨드), propose_card_edit/greeting_*/regex_*/trigger_*/script_delete/bot_snapshot/bot_restore/card_writeback/clone_bot/lore_move/open_tab, `propose_lore_add(scope=)`. actions: `HOST_KINDS` += host_card_writeback·host_clone_bot·host_open_tab, EXECUTORS += 9종 |
| 함정 반영 | 메인라인 비선택 캐릭터 쓰기 미저장 → 반영은 `isLiveBot` 만, 복제는 setDatabase(신규 chaId)라 안전. `db.py close()` 중복 정의로 종료 체크포인트가 무효였던 버그 수정 |

**M1.1 (UI 피드백 라운드, 사용자 지시 10건 전부 반영)**

| # | 무엇 | 어디 |
|---|---|---|
| 1 | 챗/봇 선택 **한 화면**. 탭 바 중앙이 모드로 교체 — `봇 편집` → `메타·봇 로어북·Regex·트리거`, 챗 행의 `챗 편집` → `챗 에딧·챗 로어북·장기기억·챗 변수`. 탭 10개(선택 ┃모드 4┃ 워크스페이스 파일 ⚙). **단일 봇 대전제**(RisuAI 에서 봇 선택 후 진입) — `tab-bots.ts` 삭제, `botKey`=`activeCharKey` | `shell.ts setEditMode/syncModeTabs`, `tab-chats.ts` |
| 2 | 사장 필드 5종(personality/scenario/exampleMessage/systemPrompt/PHI) 행 제거, `ingest` 가 기존 행 청소 | `card.py _RETIRED` |
| 3 | `backgroundHTML`/`backgroundCSS` 를 SCALARS 에 추가 — **Regex 탭 상단 섹션에서 편집**(메타 탭엔 `NOT_HERE`) | `tab-regex.ts BG_LABEL` |
| 4 | 로어북 폴더 규칙을 RisuAI 실제 규칙으로: **소속 = `member.folder === folderEntry.key`, 표시명 = 폴더 항목의 `comment`**(LoreBookData.svelte:142,154 — id 가 아니다). 접기 기본 + 열림 기억(`openFolders`), 편집기에 폴더 `<select>` 로 폴더 간 이동 | `lore-view.ts`(챗/봇 공용, `makeLoreTab`) |
| 5 | 미리보기 전부 제거 | 메타/로어/Regex |
| 6 | 순서 이동은 왼쪽 목록 카드(`.lorecard`+`.movebtn` ↑↓) — 로어북은 `/lore/move`, 스크립트는 `moveScript` | `lore-view.ts`, `tab-regex.ts` |
| 7 | 트리거는 **JSON 금지** — `effect[0]={type:'triggerlua'|'triggercode',code}` 의 `code` 만 코드 영역으로(comment + 이벤트 select + textarea). 블록형(V2) 은 읽기 전용 안내. "새 Lua 트리거" 추가 | `tab-trigger.ts codeOf` |
| 8 | 찾기 박스 공용화 — 로어북/메타/Regex/트리거/챗 목록(6개 초과 시) | `dom.ts searchBox/refocusSearch` |
| 9 | 첫 화면 챗 목록: max-width 640·행 구분선·현재 챗 강조 | `styles.ts` |
| 10 | 에이전트 탭 이동 툴 `propose_open_tab(tab, reason)` → `host_open_tab` 승인 시 `state.openTabRequest` → shell 이 모드까지 맞춰 전환 | `agent.py`, `state.ts decideAction`, `shell.ts` |
| 11 | 에이전트가 로어북 생성/삭제/폴더 정리/CBS·Lua 추론을 툴+스크립트로: `list_lore` 가 `#seq`·`folder=`·`[폴더]` 행 노출, `run_python` 의 scope.db 에 `card_fields`/`card_scripts` 포함 + `describe_helper` 가 전 테이블 구조·폴더 규칙·`effect[0].code` 를 문서화, 샌드박스 `lore()` 가 id 포함 | `pyexec.py SCOPE_TABLES`, `sandbox.py` |

테스트: test_http 에 card 4종(test_card_rows/edit_patch_commit/scripts_lifecycle/**global_lore_decoupled_reset**(+/lore/move)),
`test_asset_probe`; 스모크에 test_bot_tabs(모드 전환·사장 필드 부재·인사말 위치·bg 섹션·movebtn·트리거 코드 편집)/
card_write_back(chats 불변·forkExtra·lowLevelAccess 보존 단언)/clone_bot. 게이트 **ALL GREEN**.

## 2. 지금 있는 것 (한눈에)

```
RisuAI(PocketRisu | 웹 risu.xyz) ── 플러그인 iframe(risu-elf.js) ──nativeFetch──▶ 백엔드 (FastAPI)
   127.0.0.1:6020 또는 공개 주소(cloudflared http://elf.example.com)   ├─ data/risuelf.db   턴·로어북(local/global)·기억·변수·카드 필드/스크립트·세션·승인 큐·스냅샷(챗/봇)
                                                                       ├─ data/workspace/<char>/  card.md · original/ · out/ · scratch/ · skills/(실행 시 복사)
                                                                       ├─ data/skills/<id>/SKILL.md  폴더형 스킬
                                                                       └─ Pydantic AI 에이전트 (OpenAI 호환 게이트웨이)
```

**플러그인 탭**: `선택 ┃ [챗 편집: 챗 에딧·챗 로어북·장기기억·챗 변수 | 봇 편집: 메타·봇 로어북·Regex·트리거] ┃ 워크스페이스 파일` (+ ⚙ 설정).
챗 탭 위엔 **챗바**(반영·스냅샷·버전·변경 요약), 봇 탭 위엔 **봇바**(반영▾ RisuAI 반영/복제 봇/되돌리기 · 스냅샷 · 버전).

**한 구조** — 턴·챗 로어북·기억·변수(챗) / 카드 필드·인사말·global 로어·Regex·트리거(봇) 모두
*작업본 vs 기준선 → `GET /patch`|`/card/patch` → `host.writeChat`|`writeCharacter` **한 번** → `POST /commit`|`/card/commit` 이 기준선 이동*.
스냅샷은 챗(`checkpoints`)·봇(`card_checkpoints`) 각각 한 단위. **에이전트의 쓰기는 전부 승인 큐**.

## 3. 배포 절차 (검증됨)

- test-server `D:\code\risu-elf`. 기동 `powershell -File D:\code\risu-elf\pyserver\manage.ps1 -Action start|stop|status`.
- `_stage\` 에 `app/*.py`·`app/seeds`·`risu-elf-0.1.0.js`·`deploy-m1.ps1` 을 scp(내가 함) → **사용자가** `.ps1` 실행
  (stop → `app.bak-<시각>` → 교체 → `__pycache__` 삭제 → start) → **새 SSH 세션**에서 `/health`.
  스크립트 원본은 세션 scratchpad `deploy-m1.ps1`(ASCII, 위 §0 명령).
- 플러그인 본체는 사용자가 RisuAI 에 재설치(`plugin/dist/risu-elf-0.1.0.js`). GitHub 릴리스는 아직 v0.1.0.
- 원격 스킬 8개 켜 둠. Ollama 프리셋 `ollama.com/v1`, flex/cache 끔, reasoning ''.

## 4. 2026-08-23 의 사고 — DB 가 17:47 로 돌아감

dev 설치본의 `data/` 를 `-wal`·`-shm` 째 새 설치본에 복사한 뒤 기동한 서버가, 낡은 wal-index 를 믿고
커밋을 WAL 헤더 체인 밖(낯선 salt)에 썼다. 그 프로세스는 읽을 수 있었고, 다음 재시작이 그 60커밋을 버렸다.
사라진 것: 21:13~22 프리셋 수정(복구함), 21:25 테스트 세션, 승인된 로어북 6건(본문은 `out/out_summary_lorebook_draft.md`).
증거 `data/forensic-20260823/`, `data/orphaned-wal-20260823-221737.db-wal`. 규칙: **`data/` 는 서버를 멈추고 옮긴다.** (`docs/00`)

## 5. 이어서 할 것 (순서대로)

1. ~~**M1.1 배포**~~ — 2026-08-25 완료(§0). `git push origin master` 도 완료.
2. **실사용 확인(M1.1 새 UI)** — 봇 편집 진입→메타 수정→봇바 반영(RisuAI 카드가 바뀌고 chats 그대로인지)→복제 봇 생성('db' 권한 프롬프트 1회)→
   로어북 폴더명·접기·폴더 이동→Regex 탭 bg HTML 편집→트리거 코드 편집→에이전트에게 "로어북 정리해줘"로 `propose_open_tab`/`propose_lore_move` 확인.
3. **릴리스 v0.2.0** — `python tools/release.py`. 플러그인 `+` 업데이트 버튼이 안 뜬 유력 원인: 설치본과 최신 릴리스가 둘 다 `0.1.0` 이라
   RisuAI 가 새 버전으로 안 봄(`//@update-url` 은 dist 에 정상 — `releases/latest/download/Risu.Elf.Plugin.js`). v0.2.0 이 나오면 확인되는 가설.
   릴리스 노트엔 06 §1 을 압축.
4. **M2 착수** (계획서 "마일스톤 2" 그대로) — 순서: ① `assets.py` 스토어(`data/assets/<sha256>.<ext>` 전역, DB v9 `asset_blobs/asset_keys/char_assets`)
   + `/assets/manifest|upload|status|gc` (M0 의 `/diag/asset-echo`·`assets.ts` 배치 업로더 승격) → ② 플러그인 백그라운드 임포터 + `botbar.setAssetGate` 로 반영 게이트
   (경로 3갈래: 웹리스 계정=백엔드 `/rs/` 병렬 풀, 로컬 저장=readImage 4~8 동시 푸시, PocketRisu 동일 머신=SQLite 직읽기 — **순차 readImage 금지**, 실측 근거)
   → ③ SQLite 고속 경로(config `pocketrisu.savePath`) → ④ 에셋 탭 → ⑤ `charx.py`(module.risum 생략·인라인 확장, 누락 에셋은 assets 엔트리 제거) + PocketRisu 실 import 검증
   → ⑥ 플러그인 fflate 조립 폴백 → ⑦ 이름변경/삭제/추가/교체 + PIL 액션 → ⑧ 릴리스 v0.3.0.
5. **공개 백엔드 보안 점검** — `elf.example.com` 노출 상태. 토큰 길이·실패 rate limit·`/health` 정보(`tokenRequired:false` 가 보인다)·`/diag/*` 가 auth 뒤에 있는지.
6. 이월: 스킬 description 다듬기("요약 이사"·"말투 통일"), 사라진 로어북 6건 복구(`out/` 초안 → `propose_lore_add`), 모듈 에셋(v2), 트리거 V2 블록 GUI.

## 6. 빠른 명령

```
bash tests/gate.sh                               # 게이트. ALL GREEN 아니면 배포 금지 (시스템 python 은 3.6 — venv 를 쓴다)
node plugin/build.config.mjs                     # 플러그인 빌드 → plugin/dist/risu-elf-0.1.0.js
node tests/plugin_smoke.mjs                      # linkedom 스모크 (select.value 는 getter 전용 → option selected 속성)
ssh test-server "curl.exe -s http://127.0.0.1:6020/health"     # 원격 확인(로컬 curl 은 내 PC다)
ssh test-server "powershell -ExecutionPolicy Bypass -File D:\code\risu-elf\_stage\deploy-m1.ps1"   # 배포(사용자가 ! 로 실행)
ssh test-server "curl.exe -s \"http://127.0.0.1:6020/card/changes?charKey=<ck>\""
ssh test-server "curl.exe -s http://127.0.0.1:6020/skills/preview"  # 에이전트가 보는 스킬 카탈로그
```
