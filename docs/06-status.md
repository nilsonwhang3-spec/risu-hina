# 06. 구현 상태 — 2026-08-27 기준 (v0.7.2, Risu Hina)

다음 세션에 이어서 할 사람(=나)을 위한 한 장. 무엇이 있고, 무엇이 바뀌었고, 어디까지 배포됐고,
무엇이 남았는지. 설계의 *이유*는 `docs/04`(에셋·charx 는 부록 E), 저장 구조는 `docs/02`, 배포 환경은 `docs/00`.
봇 편집 모드의 원계획(M0 실측·M2 명세)은 `~/.claude/plans/risu-hina-whimsical-lovelace.md`.

## 0. 다음 세션 시작점 (먼저 읽을 것)

**코드 상태**: master = **v0.7.2**(§1-7 라운드 9 · §1-6 · §1-5; docs/07 플래닝은 여전히 대기) — 게이트 ALL GREEN. 0.7.0 은 minor 가 바뀌어 **버전 게이트가 걸린다**: 백엔드를 올리면 RisuAI 쪽 플러그인도 `+` 로 올려야 한다(헤더가 안내).

**배포 상태 (2026-08-25 21:01 `deploy.ps1`, 새 SSH 세션에서 확인)**:

| 어디 | 무엇 | 비고 |
|---|---|---|
| test-server **실행 중** | **0.7.1** (2026-08-27 21:08, 같은 방법으로; `/config/test` 코덱스 `ok:true toolCalls:1`, 훅 스킬 시드 확인). 0.7.0 은 (2026-08-27 20:33 — 내가 ssh 로 루프백 `curl -X POST /update/apply` 실행 → 업데이터가 GitHub 자산을 받아 설치·NSSM 재기동, 새 세션 `/health` 0.7.0 `agentReady:true`; 사용자는 RisuAI 에서 플러그인 `+` 만 누르면 됨). 그 전 0.5.2 — 클린 설치 `D:\code\risu-hina`, **NSSM 서비스 `RisuHina`**(`cmd.exe /c start.bat 6020`, Automatic, ActiveRecall·risuai 와 같은 방식). 2026-08-26 밤 ssh 로 훼손된 `pyserver\python` 제거 → 0.5.2 zip 을 폴더 위에 풀기(`data/` 유지) → `nssm stop/start` → `/health` 0.5.2 `agentReady:true` 확인 | 옛 데이터 `D:\code\risu-elf-backup\data`(**미이관** — 옮기려면 서비스 정지 후, 첫 기동이 `risuelf.db→risuhina.db` 입양) |
| test-server config | `pocketrisu.savePath = D:\code\risu-nodeonly\Risuai-NodeOnly\save` → `/diag` `fastPath:true, serverWrite:true` | 같은 PC 의 PocketRisu 를 SQLite 로 직독 |
| GitHub 릴리스 | **v0.7.1 Latest** (2026-08-27 21:06) · v0.7.0 (2026-08-27 20:32, 자산 4개, 내가 `gh release create` 로 직접 — auto 모드에서도 통과했다; 노트는 `tools/bundle.py` 가 `release/` 를 비우므로 scratchpad 에 쓴다) · v0.6.2 · v0.6.1 · v0.6.0 · v0.5.2 · … · v0.1.0 | `gh release create` 는 auto 모드 분류기가 막는다 — 수동 권한 모드에서는 내가 직접 실행(0.3.1·0.3.2). test-server 는 0.3.2 배포·검증됨, raw 주소도 0.3.2 |
| RisuAI 설치 플러그인 | **0.3.1 을 한 번 수동 재설치해야 함** — 설치본의 `//@update-url` 이 CORS 없는 릴리스 주소라 `+` 가 영영 안 뜬다(docs/04 B.4) | 그 뒤부터는 raw 주소라 `+` 가 뜬다 |

**0.3.2 (2026-08-25 밤)** — 실사용 첫 회: PC 브라우저(risu.xyz) 봇 312장 0.6초, 아이폰(risu.xyz) `office counseling` 2980장 5.3초, 전부 `fast=N`(같은 PC 의 PocketRisu `risuai.db` 캐시 히트, 브라우저 전송 0). 사용자가 "포켓리스에서 연결한 것처럼 읽어갔다"고 의심 → 키가 SHA-256 이라 같은 바이트임을 확인하고, `assets.store_bytes` 가 **키 해시 = 바이트 해시** 를 검증하도록(출처 불문 거부), 동기화 줄이 출처(PocketRisu DB / 허브 / 이 브라우저)를 밝히도록 고침(docs/04 E.2). 고속 경로는 읽기 전용이며 쓰기는 항상 접속한 클라이언트에만 간다.

**0.3.1 (2026-08-25 밤)** — `+` 가 안 뜬 진짜 원인은 "같은 버전"이 아니라 **CORS**: RisuAI 는 브라우저 `fetch` 로 `//@update-url` 을 읽는데 릴리스 주소의 리다이렉트 응답에 CORS 헤더가 없다. `//@update-url` 을
`https://raw.githubusercontent.com/nilsonwhang3-spec/risu-hina/master/plugin/Risu.Hina.Plugin.js` 로 바꾸고, `tools/bundle.py` 가 그 파일을 저장소에 쓰도록 했다(릴리스 커밋에 포함). 백엔드 코드는 VERSION 만 바뀜.

→ **첫 할 일**: 사용자가 RisuAI 에 `plugin/Risu.Hina.Plugin.js` **수동 재설치 1회**(설치본 0.1.0 의 update-url 은 CORS 로 못 읽음) → 다음 릴리스부터 `+` 가 뜨는지 확인 → M2 실사용 검증(§5-2).

## 1-7. 2026-08-27 밤 — v0.7.2: 라운드 9 피드백 13건 (중간 캐시가 썸네일을 한 장으로 · 새 봇으로 저장)

- **에셋 미리보기가 전부 프로필** — 서버 로그에 격자 한 번당 `GET /assets/blob` 이 **한 건만** 도착(178KB). 키는 전부 맞고 present. 즉 브라우저와 백엔드 사이(터널 엣지)의 캐시가 쿼리스트링을 무시하고 첫 응답을 전 키에 돌려준 것(RisuAI sw.js 는 `/sw/*`·`/tf/*` 만 잡으므로 아님). 고침: 바이너리 읽기는 **POST**(`POST /assets/blob {key}`, `POST /files/download {charKey,path}`) + `Cache-Control: no-store`; GET 은 도구용으로 유지.
- **워크스페이스 "Cannot read properties of undefined (reading 'filter')"** — 같은 중간자가 200 으로 HTML 을 돌려주면 `readJson` 의 `{_raw}` 폴백이 정상 응답처럼 흘러 `data.areas.filter` 에서 터졌다. `transport.json()` 이 `{_raw}` 를 감지해 "백엔드 대신 다른 응답이 왔습니다 (JSON 이 아님): …" 로 던지고, 파일 탭은 실패를 `clientLog` 에 스택과 함께 남긴다.
- **플러그인 업데이트 때 URL·토큰 칸이 비어 보이던 것** — `//@arg backend_url/backend_token` 은 RisuAI 가 업데이트마다 지우는데 실제 값은 `pluginCustomStorage` 에 있었다. 헤더에서 `@arg` 두 줄 제거, `getArgument/setArgument` 경로 삭제 — ⚙ → 연결 이 유일한 입력처.
- 설정 연결 탭: "에셋 덤프 실측" 카드 삭제(`measureAssetDump` 는 코드만 남음), "에셋 스토어" → **"포켓리스 직렬연결 (포켓리스 사용시만)"**.
- **검색 에이전트 연결 테스트** — `POST /config/test {section:"agent_search"}`, 프리셋 카드 두 곳에 같은 버튼.
- 스킬: 시드 전부 기본 켜짐, "말투 통일" 시드 삭제(`RETIRED_SEEDS`), 기존 설치는 `skills.defaults_once()`(마이그레이션 `skills_defaults_v1`: 전부 켜고 은퇴 시드 삭제). 스킬 카드 설명을 "매 요청에 실리는 것은 이 목록뿐 … 본문은 load_skill 로 그때" 로.
- 메타 탭 순서: 이름 → 설명 → 퍼스트 메시지(+대체 인사말) → 글로벌 노트 덮어쓰기 → 구분선 → 봇 버전 → 제작자 노트(`FIELD_RANK`).
- AI 챗: 첨부 버튼을 보내기 버튼 **위**에 세로로(`.agentbtns`).
- **복제가 "복제 중…" 에서 멈추던 것** — RisuAI 의 db 권한 대화상자가 전체화면 플러그인 컨테이너 **뒤**에 뜬다. `host.cloneBot` 이 `getDatabase` 전에 `hideContainer`, 끝나면 `showContainer('fullscreen')`.
- **복제 봇 생성 → 새 봇으로 저장**(`state.saveAsNewBot`): 지금 RisuAI 상태(기준선)를 "<이름> (백업)" 으로 복제(챗 포함) → 편집본을 이 봇에 반영·커밋 → 계속 편집. 팝업: "현재 편집 중인 봇을 새 봇으로 저장하였습니다. 기존 봇은 “…(백업)” 이름으로 복제되었습니다." 에이전트의 `propose_clone_bot` 은 그대로.
- 스모크: `test_save_as_new_bot`(백업 이름·챗 동반·라이브 봇에 편집 반영·컨테이너 hide/show·변경 없음 복귀).

## 1-6. 2026-08-27 밤 — v0.7.1: 라운드 8 피드백 5건 (코덱스 빈 응답의 진짜 원인 · 부분 교체 툴 · 훅 레퍼런스)

- **"솔(gpt-5.6-sol, 코덱스) 연결 테스트가 tool_calls 를 안 돌려준다"** — 원격에서 `diag_codex.py`(scp → `python\python.exe`) 로 5가지 tool_choice 변형을 돌려 보니 **전부 `output=[]`, 텍스트도 없음**. 원인은 `codexauth.client()` 의 스트림 접기(fold): chatgpt 코덱스 백엔드는 `response.completed` 의 `output` 을 **비워서** 보내고 아이템은 `response.output_item.done` 으로만 온다 → 비스트리밍 호출(연결 테스트, `agent.run` 계열)은 모두 빈 응답이었고, 스트리밍인 채팅만 멀쩡했다. 고침: `output_item.done` 을 모아 최종 `output` 에 채움. 재검증: 5변형 모두 `function_call` 반환. 연결 테스트는 프롬프트를 명령형으로, `tool_choice="required"` 우선(거부하면 auto), 실패 시 모델이 대신 말한 텍스트를 인용(`_no_calls`).
- 헤더 연결 상태는 점 + "백엔드 연결 안 됨" + (재시도 중) 만 — 오류문·설정 버튼은 선택 화면 알림과 ⚙ 연결 진단으로(툴팁에는 남김).
- 스킬 카드가 연결 전 오류("토큰을 보내지 않았습니다")를 붙든 채 남던 것 → `buildSkillsCard({onMount})` 로 `refreshers` 등록(프리셋·키 카드와 같은 경로).
- **부분 교체 툴** `propose_lore_replace / propose_memory_replace / propose_card_replace(find, replace, replace_all)` — `textedit.replace_once`(정확히 1곳, 없으면 비슷한 줄 힌트, 2곳 이상이면 문맥 요구). 전체 교체 툴 docstring 은 "통째로 다시 쓸 때만". 지침에 규칙 추가. `tests/test_textedit.py` 게이트.
- **RisuAI 처리 순서 레퍼런스** `seeds/risuai-hooks.md`(소스 `index.svelte.ts`·`scripts.ts`·`scriptings.ts` 로 검증: editinput(저장) → start → editprocess(요청용) → 조립 → Lua editRequest → 모델 → editoutput(저장) → output → editdisplay(표시); Lua 훅이 같은 단계 정규식보다 먼저; `@@emo/inject/move_top/repeat_back`, `<order N>`·`<cbs>` 플래그, 오진단 표). 기본 켜짐 스킬로 시드(`SEED_KEY` v3 — 기존 설치도 다음 기동 때 받는다), 지침에 요약 6줄.

## 1-5. 2026-08-27 밤 — v0.7.0: 라운드 7 피드백 15건 (연결 오진단 · 파일 탭 재작성 · diff)

- **"Use Plain Fetch 를 켜 주세요" 는 오진단이었다.** 서버 로그(`/logs`): 19:30:04 `/health` 200 → 19:32:04 까지 요청이 **백엔드에 아예 도착하지 않음** → 19:32:04 부터 정상, 설정 변경 없음. 즉 터널/VPN 워밍업. 메인라인 소스 확인(`globalApi.svelte.ts` `fetchNative`): 웹은 `throughProxy = !db.usePlainFetch`, `networkRoute:'local_network'` 은 사설 IP 에만 걸리고 그때는 웹에서 throw. 고침: `transport.connect` 가 (a) fetch 예외 → "백엔드에 닿지 못했습니다 (원인) … 자동 재시도", (b) 서명 불일치 → **받은 응답을 인용**("HTTP n · 본문 80자") — Plain Fetch 언급은 진단 카드의 세 번째 가능성으로만. `startReconnect` 는 30초 간격으로 **무한 재시도**(옛 10회 후 포기 → 사용자가 새로고침), 헤더에 "자동 재시도 n회째", 붙는 순간 `clientLog('connect recovered', {attempts, seconds, lastError})` 로 **다음엔 실제 오류가 서버 로그에 남는다**.
- **코덱스 연결 테스트 "(config) baseUrl·apiKey·model 모두 필요"**: `h_config_test` 가 provider=codex 를 몰랐다(채팅은 `_model_for` 가 codexauth 로 감). `_config_test_codex` — 같은 `codexauth.client()` 로 PONG + 툴 호출 2단계, `instructions` 필수, 스레드풀이라 `asyncio.run`.
- **에이전트 패널**: (1) 타이머가 첫 텍스트에서 멈춰 툴 단계 "…중입니다" 옆 시계가 얼어 있던 것 → 턴 끝(`finish`)까지 돈다. (2) 툴 칩이 본문 **위** 한 줄에 고정 → 버블을 **순차 세그먼트**(칩 줄 → 본문 → 칩 줄 → 본문…, 허용 카드도 그 자리)로. (3) 승인 요청 카드에 **전체 승인·실행 / 전체 거절**(순차 실행, 실패 시 중단) + 6건 넘으면 접기. (4) 패널을 좁히면 보내기 버튼이 사라짐 → `.agentinput { flex:1; min-width:0 }` + `.sendbtn { flex-shrink:0 }`.
- **워크스페이스 파일 탭 재작성**(`tab-files.ts`): 왼쪽 = **폴더 트리만**(영역·하위 폴더, 캐럿, 폴더에 드롭 가능), 중앙 = **선택 폴더의 파일 목록**(이름·크기·수정, 체크박스, 클릭/Ctrl/Shift 다중 선택, Delete 키 삭제 — 확인 줄 + Delete 한 번 더, Enter/더블클릭 열기, Ctrl+A) 또는 **썸네일 격자**(그림 폴더, 백엔드 `/files/download` 로 6개 동시), 미리보기(텍스트·이미지·기타는 저장), **내려받기 = 여러 개·폴더면 zip 하나**(`POST /files/zip`, 공통 부모 기준 이름), **드래그 업로드**(파일·폴더 트리 `webkitGetAsEntry`, `webkitdirectory` 폴더 올리기, 진행 표시), **zip 은 풀어서/그대로** 선택(`/files/upload extract`, `..`·절대경로·`__MACOSX` 제외, 512MB/5000개 상한), out/ 도 업로드 대상, 중첩 폴더 자동 생성. "임시 문서" 는 가상 폴더. FileReader 로 base64(옛 바이트 루프는 20MB 에 수 초).
- **탭 위치**: 에셋 동기화 배지(`margin-left:auto`)가 에셋과 워크스페이스 파일 사이에 있어 파일 탭이 반대쪽 끝으로 밀렸음 → 배지를 줄 끝으로.
- **선택 화면 봇 스냅샷 삭제**(행 ✕ + 최근 5개/전부 정리), **스냅샷 삭제 즉시 피드백**(행 흐려짐 — 서버는 5ms, 느린 건 왕복; 확인 라벨 "삭제 확인").
- **집중 편집**(`dom.focusEdit/focusButton`): 메타·로어북(챗/봇)·Regex(out·배경 HTML)·Lua·장기기억 텍스트 상자에 ⤢ — 화면 전체 모달, 입력이 원래 상자에 실시간 반영(저장은 원래 버튼).
- **변경 내용 diff**(`dom.lineDiff/diffView/diffCard`): LCS 라인 diff(공통 머리·꼬리 제거, 4M 셀 상한), IDE 식 좌측 마크(−/+ 색 거터), 같은 줄 접기 "… N줄 같음". 메타·Regex·배경 HTML·Lua·장기기억(열림) + 로어북(내용 diff + 이름/키/상시 변경 요약). 백엔드가 `original` 을 함께 내려준다: `store.lore()`·`card._script_row()` (edited 행만).
- **에셋 썸네일**: 호스트 `readImage` 를 300장 동시에 부르니 웹에서 절반이 깨짐 → **백엔드 스토어 `/assets/blob` 우선**(present 인 것), 6개 동시, 호스트는 폴백.
- 생략: 모바일 찾기창 줄바꿈(사용자가 생략 지시).
- 검증: test_http +zip/extract/original 검사(482 ok), 스모크 파일 탭 재작성 + diff/집중 편집 검사(320 ok). docs/05 문제 해결 표의 Plain Fetch 행 교체.

## 1-4. 2026-08-27 아침 — v0.6.2: 서버 로그의 오류 2건

- **코덱스 무응답** = `400 Invalid 'input[29].id': 'reasoning'. Expected an ID that begins with 'rs'`. pydantic-ai 의 chat/completions 경로는 응답의 `reasoning` 필드를 `ThinkingPart(id='reasoning')` 로 남기고, Responses 경로는 이력의 ThinkingPart 를 `id` 그대로 reasoning 아이템으로 재전송한다 → 프리셋을 게이트웨이에서 코덱스로 바꾸면 터짐. 고침: `session.neutralise_thinking(history, model)` — 대상이 `OpenAIResponsesModel` 일 때 `rs_` 로 시작하고 같은 system 인 것만 id 유지, 나머지는 `id=None, signature=None`(pydantic-ai 가 보내지 않는 조건). `tests/test_history.py` 게이트 추가.
- **로어북 18개** = `list_lore` 가 본문 1500자씩 붙여 25000자에서 조용히 잘림. 고침: 목록은 본문 없이 전부(이름·key·상시·글자수·80자 미리보기, 60000자 초과 시 "이하 N개 생략" 명시), 본문은 새 툴 `read_lore_entry(id)`, `read_lore` 는 목록과 동일. **정정**: 스크립트로 우회는 가능했다 — 샌드박스에 이 봇 행만 복사한 `.scratch/scope.db` 와 `risuhina.lore()/conn()` 이 이미 있다(지침에도 있음). 에이전트가 안 쓴 것 + 툴이 절단을 안 알린 것.
- **다음 세션 플래닝 (사용자 지시: 단순 해결 금지)** → `docs/07-agent-data-access-plan.md`: 스냅샷(`scope.db`) 버저닝 이슈(스탬프가 lore/스크립트 내용/에셋/메모리 변경을 못 봄), 권한 모델 두 갈래(툴 vs 스크립트), 선택지 A(스탬프 보강) / **B(원본 DB 를 authorizer 로 봇 스코프·읽기 전용 라이브 연결, 세팅·API 키 테이블 원천 차단, 쓰기는 전부 승인 큐)**, 절단 규칙 전수 점검.

## 1-3. 2026-08-26 밤 — v0.6.1: 0.6.0 실사용 피드백 10건

- **썸네일 웹에서도**: RisuAI 메인라인 `factory.ts` CSP 가 `img-src * data: blob:` 으로 바뀜(8/25 소스, 예전 메모 "메인라인은 img-src 없음" 은 옛 사실) → `tab-assets.loadThumb` 의 `hostPlatform==='web'` 게이트 제거. 썸네일은 `readImage` → blob (백엔드 무관, 해시 키 동일).
- 마크다운 **표**(`markdown.ts` GFM 테이블, 정렬 콜론), 업데이트 노트 `renderMarkdown`.
- 스냅샷 **삭제/정리**: `snapshots.delete/clear(keep)`·`delete_card/clear_card`, 라우트 `/checkpoint/{delete,clear}`·`/card/checkpoint/{delete,clear}`, UI `snapshotCleanup`(행 ✕·최근 5개·전부). 버전 목록 맨 위 "현재" 행 + "최신 스냅샷" 배지(챗·봇·봇 선택 화면).
- 봇 선택 화면 스냅샷 목록을 카드 밖 전폭 `chatlist snaplist` 로(챗 목록과 같은 모양). **기본 모드 bot**(`shell.mode`, `state.editMode`). 프리셋 저장 후 `openPicker` 재오픈. 팝오버 `maxWidth = vw-16` + `.catalogpop` 폭 `min(520px, 100vw-32px)`. 설명문 축약.
- test_http: checkpoint delete/clear 검사.
- **모바일 단일 화면**(`panes.ts` `mobileToggle`/`showMobileAgent`, `.split.m-agent|.m-centre`, `localStorage hina.mobileView`, 기본 agent): ≤760px 에서 거터 숨김, 우하단 `.mtoggle` 버튼으로 편집 화면 ↔ AI 챗. 드래그가 inline flex-basis 를 두므로 `!important`.

## 1-2. 2026-08-26 밤 — v0.6.0: 파라미터는 코드가 아니라 데이터 (docs/04 부록 H)

- **왜**: pydantic-ai 는 gpt-5 계열에도 `temperature` 를 보내고(400 "Only the default (1) value is supported"), 툴 정의에 `strict:true`, 상한은 `max_completion_tokens` 로 보낸다. 조사(문서 기준, 2026-08-26): OpenAI 공식은 gpt-5.6 계열에서 **Chat Completions + 툴 호출 자체를 거부**(Responses 필요); Anthropic·Gemini·Vertex 호환 계층은 모르는 필드를 **무시**; Ollama 는 `max_tokens` 만; OpenCode 는 모델별로 `/responses` 와 `/chat/completions` 가 갈리고 Go 는 `opencode.ai/zen/go/v1`; 뉴럴와트 = `api.neuralwatt.com/v1`; Vertex 는 OAuth 토큰만(API 키 불가).
- **구조** (`pyserver/app/providers.py`): `PROFILES`(id·api·hosts·auth·modelExample·endpoint chat|responses·capField·strictTools·unsupported·modelRules·template·note·docs) → `plan_for(cfg)` 가 섹션 숫자칸 → 프로파일 거부 목록 → 프리셋 **`params` JSON**(실제 필드명, `null`=보내지 않음, `api`/`strict` 는 의사 키) 순으로 `Plan{settings, drop, cap_field, strict_tools, api}` 를 만든다. `agent._model_for` 는 `_client`(create 래핑으로 `drop` 필드 pop — `stream_options` 같은 라이브러리 필드도) + `_profile`(`merge_profile(openai_model_profile, {max_completion_tokens 지원, strict 허용})`) 로 `OpenAIChatModel`/`OpenAIResponsesModel` 을 고른다. `hint(text)` 가 400 본문에서 필드를 뽑아 넣을 JSON 을 말한다 — `session._explain`, 연결 테스트, 검색 에이전트에 적용. 연결 테스트도 같은 계획(API·필드)으로 보낸다.
- 프리셋: `temperature` 기본 **None(보내지 않음)** — DB NOT NULL 컬럼엔 `-1`(`TEMP_UNSET`); `params` 컬럼(스키마 v11). `/presets` 에 `providers`·`maxParams`, `GET /catalog/providers`. 플러그인: 편집기에 *파라미터 JSON* 칸 + 프로바이더 안내 상자(예시 JSON 채우기), 키 폼에 인증·주소 안내.
- 그 밖에(사용자 피드백): 히나 기본 지침 영어화 + 한국어 어투 "~해요/~할까요?"(옛 기본문 그대로인 프리셋은 `_migrate_default_text` 로 자동 갱신) · 탭 전환 시 에이전트 스크롤 유지(`mountAgent` 가 detach 전 scrollTop 저장·복원) · 승인/전체 승인/복제 봇의 진행·결과 표시(대화에 `bubble note` 로 남김) · 스냅샷 이름 지정·변경(`/checkpoint/rename`, `/card/checkpoint/rename`, `openSnapshotName`) · 로어북 `alwaysActive` 배지·체크박스(켜면 key 비움)·에이전트 `always_active` · 봇 탭별 변경 수 배지(`refreshTabBadges`) · `start.bat` 이 `RISUHINA_HOST` 존중 · **번들 README 전면 개정**(유형 1/2, NSSM·pm2, Tailscale·Cloudflare·LAN, 업데이트).
- 검증: `tests/test_providers.py`(게이트 추가), test_http 에 params·providers·rename 검사, 스모크는 지침 textarea 를 placeholder 로 찾도록 수정. 릴리스 v0.6.0. **test-server 는 사용자가 플러그인 `+` → 백엔드 업데이트로 올림(0.5.2 업데이터 첫 실사용 검증 겸)** — 실패하면 ssh 로 zip 덮어쓰기(`nssm stop` 먼저).

## 1. 2026-08-26 — 라운드 3 + 개명 (v0.5.0) (docs/04 부록 G)

| 영역 | 무엇 |
|---|---|
| 개명 | Risu Elf → **Risu Hina** 전면(플러그인 `risu-hina`, 서명, 자산 `Risu.Hina.*`, DB `risuhina.db`, 환경변수 `RISUHINA_*`). 호환: 옛 접두사·서명·DB 채택, `plugin/Risu.Elf.Plugin.js` 도 같은 번들로 유지. 저장소·디렉터리 이름은 그대로 |
| 에이전트 | `mode` 전달·교차 화면 수정 거부(`_wrong_half`) · 실패/중단 턴도 이력 저장 · 예산 초과 시 자동 요약(`compact_history`, 실행 직전 호출) · 중단(AbortController)·계속 이어서 버튼 · 환영 문구 |
| 봇/파일 | 메타 `replaceGlobalNote` · 첫 화면 봇 스냅샷 목록 · 워크스페이스 폴더(`/files/mkdir`·`/files/move`·업로드 폴더) · 봇 버전 간 공유(`family_key`, `risu_hina.family` 스탬프) · 헤더 봇 이름 · 연결 경고에 설정 바로가기 |
| 설정 | 설정 열면 탭 줄이 섹션으로 교체(`getSettingsBar`) · 카드는 연결 후 재로드(`refreshers`) · API 키/인증 탭(모달 추가/수정, 코덱스 로그인 카드) · 프리셋 `›` · 코덱스 URL 텍스트·복사·단계 안내 |
| 검증 | test_http `test_workspace_folders_and_family` 등, 스모크 갱신. 게이트 ALL GREEN |

**배포**: 사용자 요청으로 test-server 에 직접 배포하지 않음 — 플러그인 `+` → 백엔드 업데이트 경로를 사용자가 직접 검증. 옛 업데이터는 `Install.Package`+OS 로 자산을 고르므로 `Risu.Hina.*` zip 도 받고, zip 안 `*/pyserver/app` 을 찾으므로 최상위 폴더 이름 변경도 무관.

## 1-0. 2026-08-26 밤 — v0.5.2: 업데이터가 자기 인터프리터를 옮기다 죽던 것, 버전 게이트

- **실사용 첫 백엔드 업데이트(0.5.0→0.5.1)가 실패**: `_install` 이 실행 중인 `python/` 을 `shutil.move` → Windows 가 로드된 `.pyd`(jiter) 를 잠가 `PermissionError`, 두 번째 시도는 반쯤 지워진 트리에서 `FileNotFoundError`. 앞선 `Unauthorized` 는 재설치한 플러그인(새 이름)에 토큰이 비어 있던 것.
- 고침: 인터프리터는 **`python.new` 로 스테이징**, `start.bat`/`start.sh` 가 다음 기동 때 스왑(`python`→`python.old`). 같은 번들(`python/bundle.txt` 스탬프 = 파이썬 버전+락 해시)이면 건너뜀. **옛 런처를 쓰는 설치본은 런처를 한 번 손으로 바꿔야** 스왑이 된다(업데이터가 `start.bat.new` 로 놓아 둠).
- 플러그인 `selectedValue()` 가 사용자의 선택보다 `selected` 속성을 먼저 읽던 버그(키 선택 안 먹음·keyRef 누락) 수정. 연결이 늦게 올라오면 재시도·업로드(`startReconnect`, health 상승 감시).
- **버전 게이트**: major.minor 가 다르면 `/health`·`/update/*`·`/plugin`·`/logs`·`/diag`·`/config` 외 호출을 플러그인이 거부하고 헤더에 "버전이 다릅니다 → 백엔드 업데이트로 / 플러그인 업데이트" 안내. 백엔드 업데이트 카드는 **연결 탭 상단**으로.
- test-server 복구(완료, ssh 직접): `manage.ps1 stop` → 훼손된 `pyserver\python`·`python.new` 삭제 → 0.5.2 zip 을 `D:\code` 위에 `Expand-Archive -Force`(`data/` 유지) → `bundle.txt`=`3.11.9 deps=4fe2e353af438144 pip` 확인 → NSSM 서비스 재시작 → `/health` 0.5.2.
- **NSSM 운영 규칙**: `RisuHina` 서비스는 `AppExit Restart` 이므로 `manage.ps1 -Action stop`(프로세스 kill)만 하면 NSSM 이 곧 다시 띄우고 그 사이 상태가 **Paused** 로 보인다. 파일 교체·`data/` 이동은 반드시 `nssm stop RisuHina`(또는 `Stop-Service RisuHina`) → 작업 → `nssm start RisuHina`. nssm 경로: `C:\Users\<user>\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_…\win64\nssm.exe`. ssh 세션은 관리자 토큰이라 `setup.bat -Service` 가 그대로 된다(이미 등록돼 있으면 "already exists" 로 멈춤 — `uninstall.bat` 후 재등록).

## 1-1. 2026-08-26 — 라운드 4 (v0.5.1)

| 영역 | 무엇 |
|---|---|
| 에이전트 | 기본 프리셋 = '히나' 페르소나 지침(`presets.DEFAULT_INSTRUCTIONS`, 새 프리셋 프리필·빈 지침 폴백), 검색 프리셋 기본 지침, **에이전트 이름**(`agentName`, 지침에 "당신의 이름은 …") · `run_shell`/`pip_install` 툴 = **허용 프롬프트**(`permits.py`: 툴이 대기, 패널이 `GET /permits` 폴링, 허용/거부/이번 턴 항상 허용, 턴 끝나면 초기화) · 코덱스 `max_output_tokens`·`top_p` 제거(400 대응) |
| 설정 | API 키/인증 카드 = 이름·프로바이더·API 키·메모(URL 은 프로바이더→models.dev/핀 목록으로 자동, 직접 지정은 접힘) · 프리셋에서 키를 고르면 URL·키 입력 숨김 · 목록 행에 명시적 **선택** 버튼 · 빈 행도 `›` · 키/프리셋 모달은 바깥 클릭으로 안 닫힘(`modal sticky`) · 설정 줄 끝 **✕ 닫기** · 저장 알림 여백 |
| 연결 | 401 → "data/token.txt 를 ⚙→연결→토큰에" 안내, 429 → 잠시 뒤 재시도 |
| 번들 | Windows 임베디드 파이썬에 **pip 휠 동봉**(`_pth` 에 추가) → `pip_install` 이 설치본에서도 동작 |

## 1a. 2026-08-25 밤 — 라운드 2 (v0.4.0): 봇 탭·설정 피드백 20여 건 (docs/04 부록 F)

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
**0.4.2**: 설정 카드가 연결이 올라온 뒤 다시 읽는다(`tab-settings.refreshers` — 연결 전 로드된 "토큰을 보내지 않았습니다" 오류가 카드에 남던 것). OpenAI 구독 로그인은 **API 키 탭**으로, 프리셋은 "API 키" 선택에서 "OpenAI 구독" 을 고른다(인증 방식 셀렉트 제거).
**0.4.1**: OpenAI 구독(Codex) 프리셋 — 사용자 결정으로 구현(docs/04 F.5). `codexauth.py`(PKCE 로그인·1455 콜백·붙여넣기 폴백·토큰 갱신·Responses 스트리밍 강제 클라이언트), 프리셋 `provider` 필드, `/codex/*` 5 라우트, 편집기 "인증 방식" 선택 + 로그인 박스. **실호출 검증은 사용자가 로그인한 뒤** 연결 테스트로.

## 1b. 2026-08-25 에 들어간 것 — 릴리스·M2 전부

**운영**: M1.1 배포(19:51) → v0.2.0 태그·푸시 → 0.2.0 배포(20:03) → M2 ①~⑦ → v0.3.0 태그·푸시 → 0.3.0 배포(21:01).
원격 실행(`ssh test-server "powershell -File …deploy.ps1"`)은 **내가 직접 할 수 있다**(이전 "분류기가 막는다"는 틀림). 막히는 것은
`gh release create`(외부 공개)와 `del` 이 섞인 복합 원격 명령. 스크립트는 `_stage\deploy.ps1`(범용: `*.py` + 최신 `risu-hina-*.js`).

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
RisuAI(PocketRisu | 웹 risu.xyz) ── 플러그인 iframe(risu-hina.js) ──nativeFetch──▶ 백엔드 (FastAPI)
   127.0.0.1:6020 또는 공개 주소(cloudflared http://elf.example.com)   ├─ data/risuhina.db   턴·로어북·기억·변수·카드 필드/스크립트·에셋 키/매니페스트·세션·승인 큐·스냅샷
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
# (0.5.2 이후, NSSM 서비스) — 핫픽스는 zip 을 D:\code 위에 풀거나 app/*.py 만 교체:
#   ssh test-server "<nssm> stop RisuHina" → scp/Expand-Archive → ssh test-server "<nssm> start RisuHina" → 새 세션 /health
# (0.4.x 시절, D:\code\risu-elf 경로 — 지금은 없음)
scp -q pyserver/app/*.py plugin/dist/risu-hina-<ver>.js test-server:D:/code/risu-elf/_stage/
ssh test-server "powershell -ExecutionPolicy Bypass -File D:\code\risu-elf\_stage\deploy.ps1"   # stop → app.bak-<시각> → 교체 → __pycache__ 삭제 → start
ssh test-server "curl.exe -s http://127.0.0.1:6020/health"   # 반드시 새 SSH 세션
```
`deploy.ps1` 원본은 세션 scratchpad; 원격 `_stage` 에 남아 있다. seeds 가 바뀌면 `_stage\seeds\` 도 올린다(스크립트가 있으면 복사).
플러그인은 사용자가 RisuAI 에 재설치. **`data/` 는 서버를 멈추고 옮긴다**(§4).

## 4. 2026-08-23 의 사고 — DB 가 17:47 로 돌아감

dev 설치본의 `data/` 를 `-wal`·`-shm` 째 복사한 뒤 기동한 서버가 낡은 wal-index 를 믿고 커밋을 체인 밖에 썼고, 다음 재시작이 60커밋을 버렸다.
증거 `data/forensic-20260823/`. 규칙: **`data/` 는 서버를 멈추고 옮긴다.** (`docs/00`)

## 5. 이어서 할 것 (순서대로)

1. ~~**GitHub 릴리스 v0.3.1**~~ — 완료(21:20). 다음 릴리스 절차: 버전 5곳 bump → `pyserver/.venv/Scripts/python.exe tools/release.py`(저장소의 `plugin/Risu.Hina.Plugin.js` 도 갱신됨) → 게이트 → 커밋(번들 포함)·태그·푸시 → 배포 →
   `cd release && gh release create v<ver> -R nilsonwhang3-spec/risu-hina --title "Risu Hina <ver>" --notes-file notes-<ver>.md <zip 2개> Risu.Hina.Plugin.js SHA256SUMS-<ver>.txt`
   (auto 모드에선 분류기가 막으므로 수동 권한 모드에서 실행). 사용자는 RisuAI 에 `plugin/Risu.Hina.Plugin.js` 를 한 번 수동 재설치해야 이후 `+` 가 뜬다.
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
