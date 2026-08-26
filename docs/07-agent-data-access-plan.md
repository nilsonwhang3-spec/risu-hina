# 07. 에이전트의 데이터 접근 — 현재 구조·이슈·다음 세션 플래닝

2026-08-27 아침, v0.6.2 릴리스 직후 작성. 사용자 지시: **단순히 해결하지 말고 다음 세션에서 플래닝해서 해결**할 것.
이 문서는 그 플래닝의 입력이다 — 지금 어떻게 돼 있고, 무엇이 문제이며, 어떤 선택지가 있는지.

## 1. 발단 (0.6.2 에서 드러난 것)

1. 에이전트가 "로어북이 18개뿐"이라고 답했다. 원인은 `list_lore` 툴이 항목마다 본문 1500자를 붙이다 25000자에서
   **아무 표시 없이** 잘린 것. (0.6.2 에서 본문 없는 전체 인덱스 + 절단 시 "이하 N개 생략" 명시 + `read_lore_entry(id)`.)
2. 그때 에이전트는 **스크립트로 전부 읽을 수 있었다.** 샌드박스에는 이미 이 봇의 행만 복사한 SQLite(`.scratch/scope.db`)와
   도우미 `risuhina.lore()` / `risuhina.conn()`(read-only SQL) 이 있고 지침(`pyexec.describe_helper`)에도 적혀 있다.
   안 쓴 것은 에이전트의 판단 문제. 다만 툴이 "더 있다"고 말하지 않았으니 시도할 이유도 없었다.
   → 규칙: **툴 출력의 절단은 반드시 명시한다.** (0.6.2 에 반영. 다른 툴들도 점검 대상 — §4.)
3. 사용자 제안: "DB 를 적절히 뚫어주면 안 되나? 이런 게 많을 것 같다" → "버저닝 문제가 생길 것 같은데, 권한으로 해소
   불가한가? 세팅·API 키 등은 원천적으로 접근 불가, 쓰기는 모두 승인 후 — 이런 규칙으로."

## 2. 지금의 구조 (docs/04 §샌드박스, `pyserver/app/sandbox.py`·`pyexec.py`)

| 층 | 무엇 | 어디 |
|---|---|---|
| 격리 | `sys.addaudithook` 부트스트랩: 워크스페이스 밖 **쓰기 거부**, 읽기는 워크스페이스+인터프리터 설치본만, 프로세스 생성 거부 | `sandbox.BOOTSTRAP` |
| 자료 | 실행 직전 부모가 **이 봇의 행만** `.scratch/scope.db` 로 복사(`SCOPE_TABLES` = characters·chats·turns·turns_original·lore_entries·card_fields·card_scripts·char_assets). 스탬프(updated_at 들·스크립트 수)가 같으면 재사용 | `pyexec.build_scope_db` |
| 도우미 | `risuhina.turns/turn/search/chats/lore/card/conn/stage/stage_many/scratch/out/uploads` | `sandbox.HELPER` |
| 쓰기 | 스크립트는 `stage()` 로 JSONL 에 **제안만** 적고, 부모가 회수해 실제 DB 와 대조·검증 → 승인 대기 | `pyexec.harvest`, `staging` |
| 툴 | `list_lore`·`read_lore_entry`·`read_turns`… 는 부모 프로세스에서 실제 DB 를 읽는다(절단 규칙 별도) | `agent.py` |

원본 DB(`data/risuhina.db`)에는 **모든 봇의 챗·로어·워크스페이스 메타**, 그리고 `api_keys`(키 원문)·설정 참조·토큰
파생물이 있다. 샌드박스가 원본을 열 수 없는 이유가 이것이다.

## 3. 이슈

### 3-1. 버저닝(스냅샷 최신성)
- `scope.db` 는 **복사본**이다. 스탬프는 `characters.updated_at`·`chats`·`turns`·`card_fields` 의 `MAX(updated_at)`
  과 `card_scripts` 의 **행 수**만 본다. 다음은 스탬프에 안 잡힌다(잠재 stale):
  - `lore_entries` 의 수정(updated_at 이 스탬프에 없음) — 방금 승인한 로어북 수정이 스크립트엔 안 보일 수 있다.
  - `card_scripts` 의 **내용** 수정(행 수 동일).
  - `char_assets`, 메모리(`memory` 테이블은 SCOPE_TABLES 에 없음).
- 한 턴 안에서: 툴로 제안 → 승인(적용) → 같은 턴의 스크립트가 옛 스냅샷을 읽는 순서가 가능하다.
- 복사 비용: 큰 봇(챗 수십·턴 수만)은 매번 수백 KB~MB 복사. 지금은 스탬프로 대부분 회피.

### 3-2. 권한 모델이 두 갈래
- 툴(부모 프로세스)은 실제 DB 를 읽고 `propose_*` 로 승인 큐에 넣는다.
- 스크립트는 복사본을 읽고 `stage()` 로 승인 큐에 넣는다.
- 같은 "읽기 = 이 봇만, 쓰기 = 승인 후" 규칙이 **두 구현**에 흩어져 있다(툴별 WHERE 절 vs 복사 시점의 SELECT).
  새 자료(메모리·에셋 메타·워크스페이스 파일 목록)를 추가할 때마다 양쪽을 맞춰야 한다.

### 3-3. 절단
- 0.6.2 전 `list_lore` 처럼 **조용히 자르는 툴**이 더 있을 수 있다: `read_lore`(옛 json 덤프, 이제 목록과 동일),
  `read_turns`/`search_turns` 의 상한, `list_files`, `read_file`(바이트 상한), `list_assets`. 전수 점검 필요.

## 4. 선택지 (다음 세션에서 결정)

**A. 지금 구조 유지 + 스탬프 보강 (최소)**
- 스탬프에 `lore_entries.MAX(updated_at)`·`card_scripts.MAX(updated_at)`·`char_assets`·`memory` 를 넣고, `memory`
  테이블을 SCOPE_TABLES 에 추가. 툴로 승인·적용된 직후 스탬프를 무효화(또는 `run_python` 마다 무조건 재빌드 — 봇 하나
  분량이라 비용은 작다).
- 장점: 안전 모델 불변, 작업 반나절. 단점: 복사본이라는 본질은 그대로(두 갈래 유지).

**B. 권한 스코프 라이브 연결 (사용자 제안 방향)**
- 자식이 원본 DB 를 **직접** 열되, SQLite 의 `authorizer`(`conn.set_authorizer`)로 (1) 허용 테이블만, (2) `char_key = ?`
  가 강제된 **뷰**만 보이게 하고, (3) 쓰기 문(INSERT/UPDATE/DELETE/PRAGMA/ATTACH)은 전부 거부. 자식은 `mode=ro` URI +
  authorizer 로 열고, 뷰는 부모가 세션마다 `CREATE TEMP VIEW`… 가 아니라 자식 쪽 연결에서 만든다(TEMP 뷰는 연결 로컬).
- 쓰기는 지금처럼 `stage()` → 승인. **세팅·API 키·토큰은 테이블 단위로 원천 차단**(authorizer 가 `api_keys`·`meta`·
  `sessions`·`agent_presets` 등을 거부).
- 장점: 버저닝 문제 소멸(항상 최신), 복사 비용 0, "이 봇만·읽기만" 이 한 곳(authorizer)에 모인다.
- 위험/검토: (a) SQLite authorizer 는 파이썬 콜백이라 우회 가능성 검토(동일 프로세스에서 `sqlite3.connect` 를 다시 부르면?
  → audit hook 이 `data/` 읽기를 막고 있으므로 원본 경로 open 자체가 막힘; 부모가 **미리 연 fd 를 상속**시키거나
  `file:` URI 를 허용 목록에 넣는 식으로 딱 한 경로만 열어야 함), (b) WAL 읽기 중 부모의 쓰기 — SQLite 는 안전하지만
  잠금 대기(`busy_timeout`) 설정 필요, (c) 자식이 장시간 트랜잭션을 잡고 있으면 체크포인트가 밀림 → 타임아웃으로 해소,
  (d) Windows 에서 fd 상속·경로 정규화(`os.path.realpath`) 검증.
- 작업: 하루. 테스트: `tests/test_sandbox.py` 에 "다른 봇 행 0건", "api_keys 접근 거부", "UPDATE 거부", "승인 전 실제 DB
  불변" 추가.

**C. 절충: 라이브 읽기 전용 "뷰 DB" 를 부모가 만들어 붙이기**
- 부모가 `ATTACH` 가능한 별도 파일 없이, 원본에 봇별 **뷰**를 두고(`v_lore_<hash>` 식은 폭발) … 실용성 낮음. 기각 후보.

권장: **B** 를 목표로, 먼저 A 의 스탬프 보강은 0.6.x 에서 즉시(값싸고 독립적), B 는 설계 검토(위험 a·d) 후 0.7 에서.

## 5. 함께 정할 것
- 툴과 스크립트의 자료 범위를 **하나의 표**로 고정: 테이블/열별 (읽기: 봇 스코프 / 금지, 쓰기: 승인 큐 / 금지).
  세팅(`config.json`)·API 키·토큰·타 봇·세션 이력은 **금지**; 이 봇의 챗·로어·카드·스크립트·에셋 메타·메모리·
  워크스페이스 파일은 **읽기**; 그 중 챗 턴·로어·카드·스크립트·에셋 참조는 **승인 후 쓰기**.
- `run_shell`/`pip_install` 의 허용 프롬프트(`permits.py`)와 쓰기 승인(`staging`)의 관계 — 한 화면에서 보이게 할지.
- 절단 규칙: 모든 목록 툴은 "총 N개 중 M개 표시" 를 반드시 붙인다(공통 헬퍼 `_clip(text, limit, what)`).
- 에이전트 지침에 "툴이 잘리면 `risuhina.conn()` 으로 SQL" 을 명시할지(지금은 도우미 설명에만 있음).

## 6. 현재 진행 상황 (2026-08-27)
- 릴리스 **v0.6.2** Latest. test-server 는 사용자가 플러그인 `+` → 백엔드 업데이트로 올린다.
- 이 문서의 결정은 아직 없음. 다음 세션 첫 할 일: §4 A/B 결정 → 계획 → 구현.
