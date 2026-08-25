# 06. 구현 상태 — 2026-08-25 밤 기준 (v0.4.0)

다음 세션에 이어서 할 사람(=나)을 위한 한 장. 무엇이 있고, 무엇이 바뀌었고, 어디까지 배포됐고,
무엇이 남았는지. 설계의 *이유*는 `docs/04`(에셋·charx 는 부록 E), 저장 구조는 `docs/02`, 배포 환경은 `docs/00`.
봇 편집 모드의 원계획(M0 실측·M2 명세)은 `~/.claude/plans/risu-elf-whimsical-lovelace.md`.

## 0. 다음 세션 시작점 (먼저 읽을 것)

**코드 상태**: master = **v0.4.0**(라운드 2, §1) 태그·푸시됨. 게이트 ALL GREEN.

**배포 상태 (2026-08-25 21:01 `deploy.ps1`, 새 SSH 세션에서 확인)**:

| 어디 | 무엇 | 비고 |
|---|---|---|
| test-server **실행 중** `pyserver/app` + `plugin/risu-elf.js` | **0.4.0**(DB v10) — `deploy.ps1` 로 배포, 새 세션 `/health` 확인 | 백업 `app.bak-<시각>` |
| test-server config | `pocketrisu.savePath = D:\code\risu-nodeonly\Risuai-NodeOnly\save` → `/diag` `fastPath:true, serverWrite:true` | 같은 PC 의 PocketRisu 를 SQLite 로 직독 |
| GitHub 릴리스 | **v0.4.0 Latest** · v0.3.2 · v0.3.1 · v0.3.0 · v0.1.0 | `gh release create` 는 auto 모드 분류기가 막는다 — 수동 권한 모드에서는 내가 직접 실행(0.3.1·0.3.2). test-server 는 0.3.2 배포·검증됨, raw 주소도 0.3.2 |
| RisuAI 설치 플러그인 | **0.3.1 을 한 번 수동 재설치해야 함** — 설치본의 `//@update-url` 이 CORS 없는 릴리스 주소라 `+` 가 영영 안 뜬다(docs/04 B.4) | 그 뒤부터는 raw 주소라 `+` 가 뜬다 |

**0.3.2 (2026-08-25 밤)** — 실사용 첫 회: PC 브라우저(risu.xyz) 봇 312장 0.6초, 아이폰(risu.xyz) `office counseling` 2980장 5.3초, 전부 `fast=N`(같은 PC 의 PocketRisu `risuai.db` 캐시 히트, 브라우저 전송 0). 사용자가 "포켓리스에서 연결한 것처럼 읽어갔다"고 의심 → 키가 SHA-256 이라 같은 바이트임을 확인하고, `assets.store_bytes` 가 **키 해시 = 바이트 해시** 를 검증하도록(출처 불문 거부), 동기화 줄이 출처(PocketRisu DB / 허브 / 이 브라우저)를 밝히도록 고침(docs/04 E.2). 고속 경로는 읽기 전용이며 쓰기는 항상 접속한 클라이언트에만 간다.

**0.3.1 (2026-08-25 밤)** — `+` 가 안 뜬 진짜 원인은 "같은 버전"이 아니라 **CORS**: RisuAI 는 브라우저 `fetch` 로 `//@update-url` 을 읽는데 릴리스 주소의 리다이렉트 응답에 CORS 헤더가 없다. `//@update-url` 을
`https://raw.githubusercontent.com/nilsonwhang3-spec/risu-elf/master/plugin/Risu.Elf.Plugin.js` 로 바꾸고, `tools/bundle.py` 가 그 파일을 저장소에 쓰도록 했다(릴리스 커밋에 포함). 백엔드 코드는 VERSION 만 바뀜.

→ **첫 할 일**: 사용자가 RisuAI 에 `plugin/Risu.Elf.Plugin.js` **수동 재설치 1회**(설치본 0.1.0 의 update-url 은 CORS 로 못 읽음) → 다음 릴리스부터 `+` 가 뜨는지 확인 → M2 실사용 검증(§5-2).

## 1. 2026-08-25 밤 — 라운드 2 (v0.4.0): 봇 탭·설정 피드백 20여 건 (docs/04 부록 F)

| 영역 | 무엇 |
|---|---|
| 메타 | 봇 버전(`characterVersion` ↔ `additionalData.character_version`) 행 추가 · 첫 인사 → 퍼스트 메시지 · `backgroundCSS` 퇴역(RisuAI UI 에 없음) |
| 목록/검색 | 좌측 트리 열 리사이즈(`splitter side:'left'`, `treeWidth`) · 모든 찾기 박스가 툴바 줄로(`shell.setToolbarSearch`) |
| 트리거 | RisuAI 와 같은 모드 버튼 V2/Lua(+V1) · Lua 는 텍스트 박스 하나(이벤트 선택 없음) · V2/V1 읽기 전용 요약 · 모드 전환은 RisuAI 초기 객체로 |
| 에셋 | 격자(썸네일+이름) · 이름 클릭 편집 · ✕ 참조 삭제 · 도구: 확장자 일괄 제거·정규식 일괄 변경(`POST /card/assets/rename`) · **에셋 참조 = `card_scripts kind='assetref'`**, patch 가 세 목록으로 되돌려 반영 |
| 게이트 | 반영은 더 이상 동기화를 기다리지 않음 · 에셋 편집·charx 만 기다림 · 탭 줄 끝 `syncbadge`(%) · charx 버튼은 봇바로 이동 |
| 에이전트 패널 | 환영 예시가 모드별(봇/챗) · "현재 탭뿐 아니라 선택된 봇·챗 전반을 안다" 안내 |
| 모바일 | `.gutter { touch-action: none }` (터치가 스크롤로 잡혀 pointercancel 나던 것) |
| 설정 | 섹션 연결 / API 키 / 에이전트 / 스킬 / 정보·로그 · **일반/검색 에이전트** 각 1개 선택(`kind`, `agent_search` 섹션, `web_research` 툴) · **API 키 탭**(`api_keys`, DB v10, `keyRef`) · **모델 카탈로그**(models.dev, `GET /models/catalog`) · 진단 카드의 토큰 경고는 실패 때만 |
| 에이전트 지식 | 랜덤 풀(같은 이름 = 무작위 1개)·charx `_N` 파일명 규칙·assetref 행 편집법을 지시문과 describe_helper 에 |

테스트: test_http `test_card_assets`·`test_keys_and_agent_kinds`, 스모크의 에셋 격자·트리거 모드·툴바 검색·syncbadge·설정 5탭·키 선택. 게이트 **ALL GREEN**.
**0.4.1**: OpenAI 구독(Codex) 프리셋 — 사용자 결정으로 구현(docs/04 F.5). `codexauth.py`(PKCE 로그인·1455 콜백·붙여넣기 폴백·토큰 갱신·Responses 스트리밍 강제 클라이언트), 프리셋 `provider` 필드, `/codex/*` 5 라우트, 편집기 "인증 방식" 선택 + 로그인 박스. **실호출 검증은 사용자가 로그인한 뒤** 연결 테스트로.

## 1b. 2026-08-25 에 들어간 것 — 릴리스·M2 전부

**운영**: M1.1 배포(19:51) → v0.2.0 태그·푸시 → 0.2.0 배포(20:03) → M2 ①~⑦ → v0.3.0 태그·푸시 → 0.3.0 배포(21:01).
원격 실행(`ssh test-server "powershell -File …deploy.ps1"`)은 **내가 직접 할 수 있다**(이전 "분류기가 막는다"는 틀림). 막히는 것은
`gh release create`(외부 공개)와 `del` 이 섞인 복합 원격 명령. 스크립트는 `_stage\deploy.ps1`(범용: `*.py` + 최신 `risu-elf-*.js`).

**M2 ① 백엔드 에셋 스토어** (`assets.py`, 커밋 `ba015b0`) — `data/assets/<sha256>.<ext>` 전역, DB **v9** `asset_blobs`/`asset_keys(state present|missing|failed)`/`char_assets`(매니페스트, 카드 순서).
`POST /assets/manifest{refs,hubPull}` → 스토어 대조 → SQLite 고속 경로로 즉시 채움 → 허브 풀 백그라운드 스레드(httpx, 6 워커) → `missing` 반환.
`POST /assets/upload{items[{key,data}]}`(항목별 실패 보고), `POST /assets/fail`, `GET /assets/status`(`complete` = missing 0 ∧ 풀 없음), `GET /assets/list`, `POST /assets/gc`(도달 불가+7일), `GET /assets/blob?key`(raw).
config `assets{maxItemBytes,gcDays,hubPull,hubWorkers,hubTimeoutSeconds}`, `pocketrisu{savePath,serverUrl}`. `/diag` 에 `assets` 요약. `run_python` scope.db 에 `char_assets`.

**M2 ② 플러그인 백그라운드 임포터** (`assets.ts syncAssets`, `a383b5b`) — `state.upload()` 직후 자동. manifest → (pulling 이면 status 폴링 → manifest 재요청) → 빠진 키만 readImage **동시 4(web)/6** → 8MB·50개 배치 업로드(전송 중 배치 2개까지 겹침) → `/assets/fail`. 404 route 면 `unsupported`(게이트 열림).
`state.assetSync`/`assetGateReason` → 봇바 `applyBlockReason` 이 읽음(`setAssetGate` 삭제). 봇 카드에 진행 줄+바+중단/다시 동기화.

**M2 ③ SQLite 고속 경로** — `assets._fast_fill`: `file:…?mode=ro` + `query_only` + `busy_timeout`, key/value 테이블 자동 탐지(PocketRisu 는 `kv(key TEXT, value BLOB)`, 원본 바이트 그대로 — test-server 에서 실측). `__jwt_secret` 있으면 `serverWrite:true`(플래그만).

**M2 ④ 에셋 탭** (`tab-assets.ts`, `b8642be`) — 봇 탭 5번째(`BOT_TABS` += assets, 탭 11개). 필드별 그룹·찾기·상태 배지·항목 상세(키·해시·크기)·데스크톱 썸네일(readImage→blob, 40개 캐시)·웹은 형식 아이콘. 설정 → 연결 → **에셋 스토어** 카드(savePath 저장, 스토어 크기, GC).
**헤더는 동기화 상태가 바뀔 때만 다시 그린다** — emit 마다 그리면 charx 결과가 지워졌다(스모크가 잡음).

**M2 ⑤ charx** (`charx.py`, `d6f5919`) — `createBaseV3` 파이썬 포트 + 작업본 오버레이(`working_character`: card_fields/greetings/global lore/scripts) → `out/<이름>.charx`. x_meta→asset 교차, 에셋 STORED, card.json 마지막, **module.risum 없음**(인라인 — 임포터 소스로 확인), 아이콘 항목 항상. `POST /charx/build{allowMissing,name}`(빠지면 409+목록), `GET /charx/preview`. `GET /files/download?charKey&path` = 원시 스트림(Content-Disposition). 플러그인: 에셋 탭 "charx 만들기"(빠진 에셋 빼고 만들기 폴백), 파일 탭 "내 PC에 저장"(`transport.getBinary` + `host.downloadBytes`).

**M2 ⑦ 에이전트 에셋** (`14f14f0`) — `list_assets` / `fetch_assets(names)`→`scratch/assets/` / `propose_asset_add(name,path,field)` / `propose_asset_replace(name,path)`(PNG 검증 `assets.stage_file`). HOST_KINDS += `host_asset_add`·`host_asset_replace` → 플러그인 `applyAssetAction`: `/files/download` → `Risuai.saveAsset` → `host.writeCharacter{additionalAssets|emotionImages|ccAssets}`(CardUpdate 확장) → `POST /assets/adopt` → readHost+upload. `propose_open_tab` 에 assets.

**⑥ fflate 플러그인 조립 폴백은 보류**(부록 E.5). RisuAI/PocketRisu 소스는 `C:\code\vepo-bot\{RisuAI,PocketRisu}`(오늘 `c0ed1026` / v1.10.0 `98e96833` 로 갱신, 둘의 charx 임포트 코드 동일). charx 스킬 원본 `C:\code\vepo-bot\.claude\skills\charx\`.

테스트: test_http `test_assets_store`(manifest/upload/dedup/게이트/failed 재시도/blob/GC/400·404) · `test_charx_build`(거절→allowMissing→정상 빌드→zip 구조·작업본 반영·다운로드·adopt); 스모크 `test_asset_sync`(초상 1장 임포트→complete→2회째 업로드 0)·`test_bot_tabs` 에 게이트 열림·에셋 탭·charx 빌드·파일 탭 저장 버튼. 게이트 **ALL GREEN**.

## 2. 지금 있는 것 (한눈에)

```
RisuAI(PocketRisu | 웹 risu.xyz) ── 플러그인 iframe(risu-elf.js) ──nativeFetch──▶ 백엔드 (FastAPI)
   127.0.0.1:6020 또는 공개 주소(cloudflared http://elf.example.com)   ├─ data/risuelf.db   턴·로어북·기억·변수·카드 필드/스크립트·에셋 키/매니페스트·세션·승인 큐·스냅샷
                                                                       ├─ data/assets/<sha256>.<ext>   콘텐츠 어드레스드 스토어(봇 간 공유)
                                                                       ├─ data/workspace/<char>/  card.md · original/ · out/(charx) · scratch/assets/ · skills/
                                                                       ├─ data/skills/<id>/SKILL.md
                                                                       └─ Pydantic AI 에이전트 (OpenAI 호환 게이트웨이)
   에셋 유입: 허브 풀(웹 계정) | risuai.db 직독(PocketRisu 동일 PC) | 플러그인 푸시(나머지)
```

**플러그인 탭**: `선택 ┃ [챗: 챗 에딧·챗 로어북·장기기억·챗 변수 | 봇: 메타·봇 로어북·Regex·트리거·에셋] ┃ 워크스페이스 파일` (+ ⚙).
에셋 동기화는 **에셋 편집과 charx 만** 기다린다(반영은 안 기다림). 에셋 추가/교체(승인)는 즉시 RisuAI 에 쓰이는 유일한 카드 변경; 이름·삭제는 카드 재료(assetref)라 반영 때.

## 3. 배포 절차 (검증됨, 내가 직접 실행)

```
scp -q pyserver/app/*.py plugin/dist/risu-elf-<ver>.js test-server:D:/code/risu-elf/_stage/
ssh test-server "powershell -ExecutionPolicy Bypass -File D:\code\risu-elf\_stage\deploy.ps1"   # stop → app.bak-<시각> → 교체 → __pycache__ 삭제 → start
ssh test-server "curl.exe -s http://127.0.0.1:6020/health"   # 반드시 새 SSH 세션
```
`deploy.ps1` 원본은 세션 scratchpad; 원격 `_stage` 에 남아 있다. seeds 가 바뀌면 `_stage\seeds\` 도 올린다(스크립트가 있으면 복사).
플러그인은 사용자가 RisuAI 에 재설치. **`data/` 는 서버를 멈추고 옮긴다**(§4).

## 4. 2026-08-23 의 사고 — DB 가 17:47 로 돌아감

dev 설치본의 `data/` 를 `-wal`·`-shm` 째 복사한 뒤 기동한 서버가 낡은 wal-index 를 믿고 커밋을 체인 밖에 썼고, 다음 재시작이 60커밋을 버렸다.
증거 `data/forensic-20260823/`. 규칙: **`data/` 는 서버를 멈추고 옮긴다.** (`docs/00`)

## 5. 이어서 할 것 (순서대로)

1. ~~**GitHub 릴리스 v0.3.1**~~ — 완료(21:20). 다음 릴리스 절차: 버전 5곳 bump → `pyserver/.venv/Scripts/python.exe tools/release.py`(저장소의 `plugin/Risu.Elf.Plugin.js` 도 갱신됨) → 게이트 → 커밋(번들 포함)·태그·푸시 → 배포 →
   `cd release && gh release create v<ver> -R nilsonwhang3-spec/risu-elf --title "Risu Elf <ver>" --notes-file notes-<ver>.md <zip 2개> Risu.Elf.Plugin.js SHA256SUMS-<ver>.txt`
   (auto 모드에선 분류기가 막으므로 수동 권한 모드에서 실행). 사용자는 RisuAI 에 `plugin/Risu.Elf.Plugin.js` 를 한 번 수동 재설치해야 이후 `+` 가 뜬다.
2. **실사용 확인(M2)** — PocketRisu(test-server, fastPath 켜짐): 패널 열기→봇 카드 진행 줄→수 초 내 complete(SQLite 직독)→에셋 탭 썸네일→charx 만들기→파일 탭 저장→**PocketRisu 로 import**(에셋·로어·트리거·Regex·CBS 표시가 원본과 같은지, 이것이 charx 의 핵심 검증). 웹리스(elf.example.com): 허브 풀 진행률·2회째 0건·게이트.
   에이전트: "프로필을 흑백으로 바꿔 추가 에셋으로 넣어 줘" → fetch_assets→PIL→propose_asset_add→승인→RisuAI 카드 확인.
3. **공개 백엔드 보안 점검** — `elf.example.com`: 토큰 길이·실패 rate limit(있음: 60초 20회)·`/health` 의 `tokenRequired:false` 노출·`/diag/*`·`/assets/*`·`/files/download` 가 auth 뒤인지(AUTH_EXEMPT 는 health·plugin.js 뿐 — 확인됨).
4. 보류분: 플러그인 fflate 조립 폴백(⑥), PocketRisu bulk-write(비-PNG), 모듈 에셋(v2), 트리거 V2 블록 GUI, 스킬 description 다듬기, 사라진 로어북 6건 복구(`out/` 초안).

## 6. 빠른 명령

```
bash tests/gate.sh                               # 게이트 (시스템 python 3.6 → venv 자동)
pyserver/.venv/Scripts/python.exe tools/release.py   # 릴리스 자산 (시스템 python 으로는 SyntaxError)
node plugin/build.config.mjs && node tests/plugin_smoke.mjs
ssh test-server "curl.exe -s http://127.0.0.1:6020/diag"          # assets{blobs,bytes,fastPath,serverWrite}
ssh test-server "curl.exe -s \"http://127.0.0.1:6020/assets/status?charKey=<ck>\""
ssh test-server "curl.exe -s \"http://127.0.0.1:6020/charx/preview?charKey=<ck>\""
```
