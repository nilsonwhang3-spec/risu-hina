# 04 — 워크스페이스 격리, 파일 관리, 에이전트 프리셋·스킬

2026-08-23. 이 문서는 "제한 없는 Python"이라는 초기 결정을 **좁힌** 기록이다.

## 1. 무엇이 바뀌었나

원래 결정(계획 §5.1, 사용자 지시): *"개인이 자기 통제하에 쓰는 앱이므로 샌드박스 환경에서
python 권한이 매우 높아야 한다."* 그 결정은 유지된다. 바뀐 것은 **범위**다.

> Python 실행 권한을 주지만 해당 워크스페이스 폴더의 상위 폴더에 접근하는 것은 막아야 한다.
> DB도 완전히 열면 안 되고 봇 관련된 수정·읽기만 접근할 수 있어야 함.

즉 **능력(capability)은 그대로, 범위(scope)만 제한**한다. 워크스페이스 안에서는 무엇이든
할 수 있고, 밖으로는 나갈 수 없다.

이것은 운영자에 대한 방어가 아니다. 운영자는 그 기계의 주인이고 파이썬을 직접 실행할 수
있다. 이것은 **에이전트가 부탁받지 않은 폴더를 어지럽히는 것**에 대한 방어다.

## 2. 두 겹으로 막는다 — 한 겹으로는 부족하다

### 2.1 감사 훅 (`sandbox.BOOTSTRAP`)

`sys.addaudithook`을 사용자 코드보다 **먼저** 설치한다. 인터프리터 안에서 일어나는 모든
`open`·`os.rename`·`os.remove`·프로세스 생성이 훅을 지난다. 감사 훅은 **한 번 설치되면
제거할 수 없다** — 이것이 이 방식을 택한 이유다.

| 이벤트 | 판정 |
|---|---|
| 쓰기 목적 `open` | 워크스페이스 안만 허용 |
| 읽기 목적 `open` | 워크스페이스 + 인터프리터 설치 경로(import에 필요) |
| `os.remove` / `rename` / `rmtree` … | 워크스페이스 안만 |
| `subprocess.Popen` / `os.system` / `os.exec*` | **무조건 거부** |

마지막 줄이 핵심이다. 자식 프로세스는 훅을 물려받지 않으므로, 프로세스 생성을 허용하면
위의 모든 규칙이 장식이 된다.

**실측으로 잡은 함정:** 감사 이벤트의 인자가 항상 경로 문자열인 것은 아니다. importlib이
`.pyc`를 원자적으로 쓸 때 이미 열린 **fd를 int로** 넘긴다. 첫 구현은 거기에
`os.path.realpath()`를 걸어 `TypeError`로 죽었고, 그 결과 `import risuhina` 자체가
실패했다. 지금은 경로가 아닌 값은 통과시킨다 — fd는 이미 검사를 통과한 `open`으로
얻은 것이라 그 자체로는 탈출 수단이 되지 않는다. 덧붙여 `PYTHONDONTWRITEBYTECODE=1`로
`.pyc`를 아예 만들지 않는다(정리 대상 폴더의 쓰레기이기도 하다).

### 2.2 스코프 DB (`pyexec.build_scope_db`)

자식 프로세스는 **진짜 DB를 보지 못한다.** 부모가 해당 캐릭터의 행만 `.scratch/scope.db`로
내보내고, `risuhina` 헬퍼는 그것만 읽는다.

이것이 헬퍼 함수마다 `WHERE char_key = ?`를 붙이는 것보다 나은 이유: **"이 봇의 데이터만"이
구현의 성실함이 아니라 구조로 참이 된다.** 다른 봇의 행은 걸러지는 게 아니라 파일에 없다.
스냅샷은 `mode=ro`로 열리므로 스크립트가 거기에 쓸 수도 없다.

수정 제안은 JSONL로 적히고 부모가 수확(`harvest`)하면서 **진짜 DB에 대해 다시 검증**한다.
그래서 스크립트는 자기가 볼 수 없는 챗에 대한 수정을 제안할 수 없다.

### 2.3 검증

`tests/test_sandbox.py`가 진짜 러너로 진짜 파이썬을 돌려 확인한다 (게이트 3단계).
상위 폴더 쓰기 실패 · 데이터 디렉터리 읽기 실패 · 다른 워크스페이스 읽기 실패 ·
프로세스 생성 실패 · 다른 봇의 챗 비가시 · 스냅샷 읽기 전용 · 타 챗 제안 폐기.

## 3. 폴더 규약

에이전트 지시문과 `files.py`의 `AREAS` 표가 같은 규약을 말한다.

```
original/   가져온 그대로. diff 기준선. 지울 수도, 정리로 지워지지도 않는다.
uploads/    사용자가 올린 참고 파일. 읽기 전용. 정리 대상 아님.
scripts/    에이전트가 쓴 .py + 생성된 헬퍼. 정리 대상.
scratch/    버려도 되는 작업 파일. 정리 대상.
out/        내려받을 산출물. 정리 대상이지만 아직 안 받았을 수 있음.
.scratch/   스코프 스냅샷·제안 큐. 정리 대상, 다음 실행에 재생성.
```

정책은 **백엔드에만** 있다. 각 영역이 `deletable`/`cleanable`을 달고 UI로 오고, 패널은
받은 대로 그린다. 정책을 UI에도 두면 언젠가 둘이 어긋나고, 그때 이기는 쪽은 디스크를
만지는 쪽이다.

## 4. 에이전트 프리셋 — 왜 "활성 프리셋"이 아닌가

프리셋은 **에이전트 설정의 저장된 복사본**이지, 두 번째 살아 있는 설정이 아니다.

`config.json`의 `agent` 섹션이 "지금 에이전트가 무엇을 쓰는가"의 유일한 답으로 남는다.
프리셋은 그 섹션을 **저장해 두었다가 되돌려 놓는** 것이다.

- `capture(name)` 현재 설정 → 프리셋
- `apply(id)` 프리셋 → 현재 설정 (설정 카드가 눈앞에서 바뀐다)

"활성 프리셋"을 따로 두면 답이 둘이 되고, 설정 패널과 에이전트가 어긋날 수 있다.
`/health`와 `/session`이 자격증명을 두고 실제로 그렇게 어긋난 적이 있다(docs 이력 참조).

**새 필드 3개** — 모두 꺼짐이 "보내지 않음"을 뜻한다. 게이트웨이가 다른 프로바이더를
앞에 두고 있으면 모르는 파라미터를 무시하지 않고 **거부**하기 때문이다.

| UI | 모델 설정 |
|---|---|
| Reasoning | `openai_reasoning_effort` (`none`…`max`) |
| 프롬프트 캐시 | `openai_prompt_cache_key='risu-hina'` + `retention='24h'` |
| Flex 티어 | `openai_service_tier='flex'` |

캐시 키를 챗별이 아니라 앱 전체에 하나로 두는 이유: 캐시되는 접두부는 지시문 + 툴 스키마이고
이것은 챗과 무관하게 동일하다. 챗별로 쪼개면 적중률만 떨어진다.

## 5. SKILLS

사용자가 직접 쓰는 작업 절차. `agent.INSTRUCTIONS`에 하드코딩하지 않는 이유는, 이것이
사용자의 작업 습관에 따라 바뀌는 부분이기 때문이다.

**2026-08-23 폴더형으로 바뀜.** 스킬 하나는 `data/skills/<id>/` 폴더다:

```
SKILL.md          프런트매터(name · description · always) + 절차 본문
references/*.md   절차가 가리키는 자료
scripts/*.py      run_python 으로 실행하는 스크립트
```

- **프롬프트에는 카탈로그만 실린다.** 켜 둔 스킬마다 `- **이름** — 설명` 한 줄. 설명이 트리거다:
  에이전트는 맞는 작업이 오면 `load_skill(이름)` 툴을 불러 본문을 받는다(툴 호출이라 패널에
  `🧩 스킬: 말투 통일` 칩으로 보인다). Claude Code·Agent Skills 규격과 같은 모양.
- **`always: true`** 만 예외로 본문이 매 요청에 실린다. 모든 대화에 적용될 규칙(말투 등)에만.
- **켜짐 ≠ 있음.** 끄면 카탈로그에서 빠지고 `load_skill` 도 거부한다. 폴더는 남는다.
- **상한**: 카탈로그 6,000자 + 항상 적용 본문 16,000자. 넘으면 줄 단위로 자르고 로그와 프롬프트에 명시한다.
- **`GET /skills/preview`** 가 카탈로그 블록을, `?name=` 을 주면 `load_skill` 이 돌려줄 본문을 그대로 보여 준다.
- 가져오기: `.py` 한 장 → `scripts/` 에 둔 스킬, 긴 `.md` → `references/`, 짧은 `.md` → 본문, `.zip` → 폴더째.
  옛 DB 행 스킬은 기동 시 한 번 폴더로 옮긴다(`skills.migrate_rows_once`, 켜짐 여부 유지).

에이전트 캐시 지문(`session.get_agent`)이 스킬 지문(SKILL.md mtime + 켜짐)을 포함한다.

`pydantic-ai` 본체에는 스킬 기능이 없다. 별도 패키지 `pydantic-ai-skills` 가 같은 규격을 구현하지만
스크립트를 샌드박스 밖에서 실행하므로 쓰지 않았다 — 같은 SKILL.md 규약을 따르되 실행은 `run_python` 으로.

## 6. 부수적으로 고친 것 — 테스트 하네스의 파이프 교착

`tests/test_http.py`의 `Server`가 백엔드 stdout을 `PIPE`로 받아 놓고 **끝날 때까지 읽지
않았다.** 스위트가 커져 로그가 OS 파이프 버퍼(여기선 64KB)를 넘는 순간 서버가 `write()`
안에서 멈추고 응답을 끊었다. 증상은 "혼자 실행하면 되는데 전체 실행하면 특정 요청이
타임아웃"이었다.

프리셋·스킬 테스트를 추가하다 임계를 넘겨 드러난 것이므로, 다음에 테스트를 추가하는
사람에게도 똑같이 나타났을 것이다. 지금은 데몬 리더 스레드가 계속 비운다.

---

# 부록 A — UI 재구성 (2026-08-23 2차)

## A.1 화면 구조

탭 바는 **작업 대상**만 담는다. 설정은 도구를 설정하는 곳이지 대상이 아니라서
헤더로 올라갔다(제목·상태·새로고침·⚙·닫기 한 줄).

```
[Risu Hina v0.1.0] [● 백엔드 v0.1.0 · 챗이름 · 394턴]        [↻] [⚙] [×]
챗 선택 | 챗 에딧 | 챗 로어북 | 장기기억 | 파일
[ 툴 라인 — 현재 탭의 동작. 전체 폭 ]
┌──────────┬────────────────────────┬──────────────┐
│ 왼쪽: 목록 │ 가운데: 대상 자체        │ 오른쪽: AI    │
└──────────┴────────────────────────┴──────────────┘
```

세 패널은 `ui/panes.ts`의 `threePane()` 하나로 통일했다. 탭마다 다른 배치를
쓰면 **편집 대상에 따라 AI가 다른 도구처럼 느껴진다.**

**AI 패널은 인스턴스 하나를 옮겨 붙인다**(`ui/agentpane.ts`). 탭마다 만들면
대화 이력·비용·“새 대화” 버튼이 세 벌이 되고, 탭을 옮길 때마다 말 걸던 상대가
조용히 바뀐다. `appendChild`는 복사가 아니라 이동이라 스크롤 위치·입력 중인
문장·진행 중인 실행이 그대로 따라온다.

## A.2 모바일

`max-width: 760px`에서 좌우 분할이 **세로 적층**으로 바뀐다. 스플리터는 같은
거터가 축만 바꿔 잡는다 — 축을 빌드 시점이 아니라 드래그 시점에 컨테이너의
`flex-direction`에서 읽는다. 회전은 리로드가 아니라 리사이즈이기 때문이다.

적층 순서는 [익스플로러 스트립] → [전사] → [거터] → [AI]. 폰에서는 AI가 쓰는
쪽이고 전사는 확인하는 쪽이라, AI가 기본 55%를 가진다.

가로 튀어나감은 `.row { flex-wrap }` + `.row > * { min-width: 0 }` +
`.wrap/.pad { overflow-x: hidden }`로 막았다. 플렉스 행 안의 고정폭 입력이
설정 화면을 오른쪽으로 밀어내던 원인이다.

## A.3 프리셋 모델 정정

§4에서 “선택된 프리셋을 두지 않는다”고 썼는데 **뒤집었다.** 사용자가 요구한
모델이 더 낫다: 화면에 현재 프리셋 하나, 목록은 버튼 뒤.

단일 진실 규칙은 **미러를 완전하게 만들어** 지킨다. 선택하면 config에 쓰고,
선택된 프리셋을 수정해도 즉시 config에 쓴다. `agent.py`는 여전히 config만
읽으므로 하위 계층은 프리셋의 존재를 몰라도 된다 — config는 설정하는 두 번째
장소가 아니라 선택된 행의 투영일 뿐이다.

- 프리셋은 **항상 최소 하나** 존재한다(`ensure_default`가 기존 config에서 시드).
- 마지막 하나는 지울 수 없다. 지우면 보여 줄 것도, 에이전트가 읽을 행도 없다.
- **기본지침**은 내장 규칙 *뒤에* 붙는다. “전사에 직접 쓰지 않는다”를 뒤집을 수 없다.

## A.4 스킬은 폴더째 복사된다

스킬은 전역, 워크스페이스는 봇별이다. 샌드박스가 밖으로 손을 뻗게 구멍을 내는
대신 **러너가 켜진 스킬 폴더를 `<ws>/skills/<id>/` 로 복사해 넣는다.** `sandbox.py`의
거부가 그대로 유지되고, 에이전트는 `skills/<id>/references/x.md` 를 read_file 로,
`skills/<id>/scripts/x.py` 를 run_python 안에서 `exec(open(...).read())` 로 쓴다.

`skills/`는 매 실행마다 비우고 다시 쓴다. 껐거나 이름을 바꾼 스킬이 파일로
남아 있으면 에이전트가 여전히 찾아 실행할 수 있다.

## A.5 장기기억을 DB로

> 검토 요청: “Long-term 메모리도 챗 본문처럼 DB로 할 필요 없는지”

**필요하다. 그렇게 했다.** 근거는 전사와 같다:

1. 한 항목만 고칠 수 있어야 한다. JSON 블롭 안에서 고치라는 것은 에이전트에게
   자기 것이 아닌 구조를 다시 쓰라는 뜻이다.
2. 동결 원본과의 diff가 JSON diff가 아니라 문자열 비교가 된다.
3. 되돌려 쓸 때 구조를 **정확히** 복원할 수 있다. 건드리지 않은 부분은 애초에
   분해하지 않았기 때문이다.

`memories(id, chat_key, kind, seq, title, body, original, extra_json)`.
`original`이 NULL이면 “여기서 추가된 항목”이다.

**셸은 그대로 보관한다.** 요약 리스트를 뺀 나머지 전부를 `meta` 테이블에
`hypa_shell:<chat_key>`로 저장하고 patch 때 복원한다. 이해한 만큼만으로 기억
블롭을 재구성하는 것이 포크의 필드가 조용히 사라지는 경로다.

**항목별 extras, 특히 `chatMemos`도 그대로 복원한다.** 이걸 잃으면 요약이
자기가 요약한 턴과의 연결을 잃는데, 다음 생성 때까지 보이지 않는다.

**재업로드가 편집을 지우지 않는다.** 패널은 열릴 때마다 워크스페이스를 통째로
다시 올린다. 전사는 이미 `force`가 아니면 작업본을 보존했고, 기억도 같은 규칙을
같은 호출로 따라간다(`reset=summary["workingReset"]`). 다르게 동작하면 “턴 수정은
남았는데 기억 수정만 사라지는” — 아무도 짐작할 수 없는 종류의 불일치가 된다.
baseline(`original`)은 리셋이 아니어도 갱신한다. RisuAI에서 요약을 다시 뽑았을
수 있고, 낡은 원본은 diff를 거짓말하게 만든다.

**보강(0.9) — 기준선만 옮기면 diff는 반대 방향으로 거짓말한다.** 기준선을 옮기면서
작업본을 그대로 두면, 내가 손도 대지 않은 행이 `작업본 ≠ 기준선` 이 되어 "여기서
수정함"으로 뜬다. 그것도 좌우가 뒤집힌 채로 — `original` 자리에 RisuAI의 **새**
텍스트가, 작업본 자리에 **옛** 텍스트가 온다. 그 상태로 반영하면 사용자가 RisuAI에서
한 수정을 우리가 되돌린다. 그래서 재오픈은 **3-way 병합**이다(`app/merge.py`):

    ours == base                  → RisuAI 값을 받아들인다 (잃을 편집이 없다)
    ours != base, theirs == base  → 내 편집을 그대로 둔다  (위 규칙 그대로)
    둘 다 움직였다                → 충돌 — 내 것을 유지하고 RisuAI 것을 기록한다

`adopt`(수용)만이 무언가를 잃을 수 있는 유일한 동작이고, 그것은 작업본이 기준선과
같음이 증명될 때만 일어난다. 그래서 안전성은 한 문장으로 줄어든다: **확신할 수 없는
짝짓기에서는 수용하지 않는다.** 위치로만 짝지은 항목을 절대 수용하지 않는 이유다.

**반영이 끝나면 작업본을 남기지 않는다.** 예전에는 커밋이 기준선을 작업본 쪽으로
옮겼고(rebase), diff는 0이 되지만 우리 사본은 남아 그 순간부터 다시 벌어지기
시작했다 — 위 버그의 씨앗이 매 반영마다 새로 심겼다. 이제 커밋은 스냅샷만 남기고,
플러그인이 방금 쓴 봇/챗을 다시 읽어 그 범위만 재적재한다(`chatReset`/`cardReset`).
**예외: 복사본 저장(챗)** 은 편집본을 새 챗에 쓰므로 지금 챗의 편집은 아직 반영 전이다
— 여기서 다시 읽으면 그 편집이 사라진다.

## A.6 파일 뷰가 보여 주는 것

기본은 **사람이 넣은 것과 가져갈 것**뿐이다 — `uploads/`, `out/`.
동결 원본·생성된 헬퍼·스코프 스냅샷·스크래치는 전부 실재하지만 문제가 생기기
전에는 볼 이유가 없다. 지우지 않고 **접어 둔다**: “정리”가 무엇을 지울지 말할
수 있어야 하기 때문이다.

## A.7 대사·생각 색

`"큰따옴표"`는 대사(주황 `#f0a04b`), `'작은따옴표'`는 속마음(하늘 `#7dd3fc`).
카드의 정규식이 채팅 화면에서 하던 일이라 저장된 원문은 단색이다.

곧은 따옴표와 둥근 따옴표를 모두 잡되 **줄바꿈은 넘지 않는다.** 닫히지 않은
따옴표 하나가 턴의 나머지를 통째로 삼켜 절반을 칠해 버린다.
따옴표 기호는 지우지 않는다 — 읽는 화면과 고치는 화면이 달라지면 안 된다.

## A.8 경과 시간

에이전트 한 턴은 초가 아니라 분 단위다. 점 세 개는 “살아 있나”에는 답하지만
“20초짜리인가 4분짜리인가”에는 답하지 않는다. `0m 0s`가 초마다 올라가고,
끝나면 멈춘 채 화면에 남는다 — 얼마나 걸렸는지는 결과 옆에 있을 값어치가 있다.

---

# 부록 B — 승인 큐, 스킬 자료, 업데이트 (2026-08-23 3차)

## B.1 승인 큐 (`actions.py`)

`staged_edits`가 전사를 막고, 이것이 **나머지 전부**를 막는다 — 로어북·장기기억·
스냅샷 되돌리기·RisuAI 반영·복사본 저장.

> "쓰기인 경우 반드시 에이전트가 유저에게 한 번 더 물어야함"

모델에게 "쓰기 전에 물어봐"라고 **지시**하면 대체로 지킨다. 대체로는 톤에는 충분하고
쓰기에는 부족하다 — 스무 번 중 한 번 건너뛴 그 실행이 로어북을 조용히 갈아엎는다.
그래서 툴이 **쓸 수 없게** 만들었다. 툴은 의도를 기록하고 "승인이 필요합니다"를
돌려줄 뿐이고, 실제 실행은 사람이 누를 때 `decide()` 안에서 일어난다.

**실행자가 둘, 큐는 하나.** RisuAI 챗에 쓰는 것과 복사본 저장은 플러그인 iframe
안에만 있는 호스트 API를 거친다. 그 둘은 `host_*`로 표시되고 `decide()`가 플러그인에게
넘긴다. 백엔드가 할 수 있는 척하거나 에이전트에게 아예 숨기는 것보다, **어느 쪽이
하는지 말하는 편**이 낫다. 플러그인이 수행한 뒤 `/actions/complete`로 보고하므로,
그쪽에서 실패하면 성공으로 남지 않는다.

**지시문 범위 정정.** 처음엔 "쓰기 전에 반드시 한 번 더 물어라"를 전부에 걸었더니
에이전트가 `stage_edit`조차 미루고 되물었다(실모델 테스트가 잡았다). **스테이징은
그 자체가 확인 절차다** — 좌측 패널에 미리보기가 뜨고 승인 버튼이 있다. 그래서 규칙을
`propose_*`(되돌리기 어렵거나 RisuAI 원본을 건드리는 것)로 좁혔다.

## B.2 새로 생긴 JOB

| 툴 | 하는 일 |
|---|---|
| `propose_memory_edit` / `_delete` | 장기기억 |
| `propose_lore_edit` / `_add` / `_delete` | 이 챗 로어북 (봇 전체는 건드리지 않는다) |
| `list_snapshots` · `propose_snapshot` · `propose_restore` | 스냅샷 |
| `propose_writeback` | RisuAI에 반영 (플러그인이 수행) |
| `propose_save_copy` | 복사본 저장 (플러그인이 수행) |
| `list_proposals` | 대기 중인 제안 |

`snapshots.py`는 이 때문에 `main.py`에서 떨어져 나왔다. 같은 로직을 HTTP 핸들러와
액션 실행자가 각각 갖고 있으면 언젠가 "되돌리기"의 뜻이 둘로 갈린다.

## B.3 스킬 세 번째 종류 — `reference`

| 종류 | 본문 | 프롬프트 | 파일 |
|---|---|---|---|
| `md` | 지침 산문 | 통째로 | — |
| `script` | 파이썬 | 한 줄 | `<ws>/skills/*.py` |
| `reference` | 마크다운 자료 | 한 줄 | `<ws>/skills/*.md` |

vepo-bot에서 가져온 자료가 하나에 9–11KB다. 프롬프트 예산(24,000자)에 넣으면
그것만으로 끝나고, **줄여서 넣는 건 안 넣느니만 못하다** — 에이전트가 살아남은 절반을
자신 있게 쓴다. 그래서 통째로 디스크에 두고 프롬프트에는 "여기 있다, 언제 열어라" 한 줄만
간다. 실측: 자료 44,000자 → 프롬프트 1,105자.

**리포 안으로 복사했다.** `pyserver/app/seeds/`. `chatfmt.py`와 같은 이유로 — 옆
프로젝트에 대한 런타임 의존은 여기서 보이지 않고 아무도 갱신하지 않는다.

| 시드 | 종류 | 기본 |
|---|---|---|
| RisuAI CBS 문법 | reference | 켬 |
| RisuAI 로어북 구조 | reference | 켬 |
| RisuAI Lua 트리거 | reference | 끔 |
| charx 카드 구조 | reference | 끔 |
| charx 풀기 | script | 끔 |
| 아카라이브 HTML 작성 | reference | 끔 |

charx 스크립트는 `rpack_map.bin`을 base64로 **내장**했다. 스킬 스크립트는 워크스페이스에
혼자 복사되므로, 동반 파일이 빠지면 정작 필요한 순간에 실패한다. 러너에는 stdin이
없어서 원본의 덮어쓰기 확인 프롬프트도 제거했다(질문이 아니라 멈춤이 된다).

아카라이브 건은 `make-chatlog`/`make-showcase`에서 **새니타이저 정의만** 뽑아
일반 지침으로 추상화했다. 두 스킬은 각각 하나의 산출물을 만드는 절차고, 일반화되는
부분은 "아카라이브에 붙여넣는 HTML의 제약"이다 — 그리고 그건 아무도 짐작할 수 없는
부분이다.

`session.run`이 턴 시작마다 `install_skills`를 부른다. 안 그러면 에이전트에게
`read_file skills/...`를 시켜 놓고 파일은 `run_python`이 한 번 돌아야 생긴다.

## B.4 업데이트 — 순서가 설계를 정한다

> "통상 RisuAI에서 UI에서 업데이트 → 플러그인 UI 접속해서 백엔드 업데이트다.
> github 나 github-page 배포본을 //@update-url로 설정해야 한다!"

맞다. 처음엔 백엔드가 `/plugin.js`를 서빙하고 `//@update-url`이 거기를 가리키게
했는데, **그러면 순환이다** — 플러그인 업데이트가 먼저인데 그게 백엔드가 살아 있고
최신이어야 가능해진다. 지금은 GitHub 의 **raw 파일**을 가리킨다:

```
https://raw.githubusercontent.com/<owner>/<repo>/master/plugin/Risu.Hina.Plugin.js
```

처음엔 `releases/latest/download/Risu.Hina.Plugin.js` 였다 — 안정된 주소이고 curl 로는 잘
받아진다. 그런데 **v0.1.0 → 0.3.0 이 나와도 risu.xyz 에 `+` 가 안 떴다.** RisuAI 의 확인 코드
(`plugins.svelte.ts checkPluginUpdate`)는 브라우저 `fetch(updateURL, {Range: bytes=0-512})` 이고,
릴리스 주소는 `github.com → releases/download → release-assets.githubusercontent.com` 으로 두 번
리다이렉트되며 세 응답 어느 것도 `Access-Control-Allow-Origin` 을 안 준다. CORS 예외 → catch →
버튼 없음. raw 는 `access-control-allow-origin: *` 와 `Accept-Ranges` 를 주고, RisuAI 문서의
예시 URL 도 raw 다. 그래서 `tools/bundle.py` 가 릴리스마다 번들을 `plugin/Risu.Hina.Plugin.js`
로도 복사하고, **그 파일을 릴리스 커밋에 포함**한다 — 커밋이 곧 "새 버전 공개"다. 릴리스 자산의
`Risu.Hina.Plugin.js` 는 같은 파일의 사본(설치 zip 안에도 들어 있음)이다.
설치본이 옛 주소를 들고 있으면 그 한 번은 수동 재설치가 필요하다(0.3.1 이 그 경우).

`plugin/package.json`의 `risuhinaRepo` 하나만 채우면 된다. **비어 있으면
`//@update-url`을 아예 넣지 않는다** — 404 나는 URL은 RisuAI가 영영 "업데이트 확인
실패"를 띄우게 만들고, 그건 없느니만 못하다.

`/plugin.js` 서빙은 남겼다. 개발 중과 로컬 재설치에 쓸모가 있고, 토큰 없이 열려 있지만
서빙하는 것은 **사용자가 이미 설치한 플러그인 파일**이다 — 키도 토큰도 그 안에 없다
(둘 다 RisuAI 플러그인 저장소에 있다).

**백엔드 업데이트(`updater.py`)** — 릴리스 조회 → zip + `SHA256SUMS.txt` 내려받기 →
해시 검증 → 설치 → **exit 75**. 스스로 재시작하지 않는 이유: 무엇이 감싸고 있든
(PM2·NSSM·systemd·`start.bat`) 그것이 띄우는 법을 아는 쪽이고, 자기를 다시 exec하는
프로세스는 그 전부와 싸운다. 루프는 런처에 있다.

검증은 타협하지 않았다. `SHA256SUMS.txt`가 없으면 설치 자체를 거부한다 — 내려받은
내용이 곧 돌아갈 서버가 되므로, 검증 없는 이 엔드포인트는 원격 코드 실행이다.
zip 멤버 경로도 전개 전에 검사한다.

**레이아웃 두 가지.** 계획의 `versions/<v>/` + `current` 구조와, 지금 실제로 배포된
평평한 구조 둘 다 지원한다. 평평한 쪽은 `app.bak-<시각>`을 남기고 제자리 교체한다 —
되돌릴 버전 디렉터리가 없을 때 롤백이 rename 하나로 끝나야 하기 때문이다.

## B.5 로그와 진단

배포되고 나면 "서버 로그 확인해 보세요"는 따를 수 없는 안내다. 백엔드는 폰에서
Tailscale로 접속 중인 PC에 있을 수 있고, 로그는 그 PC의 파일이다. 그래서 로그가
패널로 온다(`log.recent()`, 링 버퍼 4,000줄).

버튼이 둘인 이유는 질문이 둘이라서다. **진단 정보**는 "이 설치가 뭔가"(버전·설정·저장량)
— 어디든 붙여넣을 만큼 짧다. **서버 로그**는 "방금 무슨 일이 있었나" — 길다.
둘 다 있는 신고는 되물을 필요가 없다.

키도 토큰도 들어가지 않는다. 진단은 키가 **설정됐는지만** 말하고, 로그는 애초에 키를
쓴 적이 없다. 테스트가 그 두 가지를 각각 검사한다.

## B.6 잡은 결함

- **에이전트 패널이 자격증명 변경을 못 받았다.** 패널은 한 번 렌더하고 캐시하는데
  설정에서 프리셋을 고쳐도 무효화되지 않아, 고친 뒤에도 "자격증명이 설정되지 않았습니다"가
  그대로 남았다. `onChanged`가 `invalidate()`를 부른다.
- **linkedom은 `option.selected`도 `select.value`도 저장하지 않는다.** 그래서
  종류 선택이 항상 빈 문자열로 읽혔고, 빈 문자열은 "md 아님"으로 판정됐다. 이제
  속성으로도 기록한다.
- **테스트 하네스가 JSON이 아닌 응답에서 터졌다.** `/plugin.js`가 첫 사례였다.
- **로어북 폴더가 생 ID로 표시됐다.** 폴더는 그 자체가 `mode: 'folder'`인 항목이므로
  거기서 이름을 끌어온다. 그 항목은 목록에서 빼야 한다 — 프롬프트에 주입되지 않는
  컨테이너라, 자기 자식들 옆에 나란히 있으면 중복으로 읽힌다.

---

# 부록 C — `Real-ooc` → `risu-hina` 개명 (2026-08-23 4차)

레포는 `nilsonwhang3-spec/risu-hina`. 네 가지 표기를 길이 순으로 치환했다(짧은 것이 긴 것을
먹지 않도록):

| 이전 | 이후 | 쓰이는 곳 |
|---|---|---|
| `REALOOC_` | `RISUHINA_` | 환경변수 |
| `Real-ooc` | `Risu Hina` | 표시·산문 |
| `real-ooc` | `risu-hina` | 패키지·파일·서비스 이름 |
| `realooc` | `risuhina` | 파이썬 식별자, DB 파일, 임시 접두어 |

## C.1 살아 있는 설치 위에서 이름을 바꾼다

개명은 문자열 치환이 아니다. 이미 돌고 있는 설치가 있고, 그 안에 사용자의 챗이 있다.
남긴 호환 장치 네 가지는 전부 **조용한 실패**를 막기 위한 것이다.

**환경변수.** `_ENV()` 가 `RISUHINA_*` 를 못 찾으면 `REALOOC_*` 를 읽는다. 예의가 아니라
필요다 — 기계에 이미 올라가 있는 런처·제어 스크립트·서비스 래퍼가 옛 접두어로 쓰여 있고,
`REALOOC_PORT` 를 말없이 무시하면 **이유 없이 엉뚱한 포트에 바인딩한 것처럼** 보인다.

**데이터베이스.** `realooc.db` 를 `risuhina.db` 로 옮긴다. **연결을 열기 전에** 한다 —
WAL·shm 사이드카가 같이 움직여야 하고, 열려 있는 연결 밑에서 파일 이름을 바꾸는 것이
WAL 이 자기 본체와 헤어지는 경로다. 실측: 454턴이 그대로 넘어왔다.

**샌드박스 헬퍼.** 워크스페이스에 `risuhina.py` 와 함께 `realooc.py` 심을 쓴다.
개명 전에 사용자가 쓴 스크립트 스킬은 여전히 `import realooc` 라고 적혀 있고,
**그 스크립트가 정작 필요해진 순간에 깨지는 것**과 세 줄의 재export 를 맞바꾸지 않는다.

**핸드셰이크.** 플러그인이 `/health` 의 `service` 로 `risu-hina` 와 `real-ooc` 를 둘 다 받는다.
업데이트 순서상 **플러그인이 먼저** 갱신되므로 한 세션은 새 플러그인이 옛 백엔드를 만난다.
거기서 악수를 거부하면 "백엔드가 옛 버전"이 아니라 "백엔드가 죽었다"로 보인다.

## C.2 사용자가 겪는 것

RisuAI 는 플러그인 저장소를 **플러그인 이름으로** 키잉한다. `//@name` 이 바뀌었으므로
저장해 둔 백엔드 URL·토큰이 따라오지 않는다. 파일 이름도 `risu-hina-0.1.0.js` 라
업데이트가 아니라 **새 설치**다. 개명의 정상적인 비용이고, 루프백에서는 토큰이 면제라
실제로 다시 넣을 것은 거의 없다.

## C.3 아직 안 바꾼 것

로컬 체크아웃 폴더는 `C:\code\real-ooc` 그대로다. 세션 중에 cwd 를 뽑아내는 위험이
폴더 이름 하나의 값어치보다 크다. 문서의 경로 표기도 실제와 맞춰 그대로 두었다 —
**문서가 존재하지 않는 경로를 가리키는 것**이 이름이 안 맞는 것보다 나쁘다.
배포 쪽은 `D:\code\risu-elf` 로 옮겼다.

---

# 부록 D — 인터프리터 동봉 (2026-08-23 5차)

## D.1 무엇이 틀려 있었나

> "배포시 python을 사용자가 깔아야 하는거면 안된다." — 착수 시 결정

첫 릴리스가 이걸 어겼다. `setup.sh`와 `manage.ps1`이 시스템 파이썬을 **찾아서** venv를
만들었고, 없으면 실패했다. 설치 가이드에는 심지어 "Ubuntu 20.04는 3.8이라 그대로는
안 된다, pyenv로 깔아라"까지 적혀 있었다. 결정을 기록해 두고도 그 반대를 배포한 것이다.

## D.2 지금 구조

아카이브마다 CPython 3.11이 의존성까지 깔린 채로 들어간다. 런처가 **그것을 먼저** 쓰고,
venv는 소스 체크아웃에서만 의미가 있는 폴백이 됐다.

| OS | 인터프리터 | 근거 |
|---|---|---|
| Windows | python.org embeddable 3.11.9 | 11 MB, 공식, `._pth`가 sys.path를 통째로 장악 |
| Linux | python-build-standalone 3.11.13 | python.org는 리눅스용 relocatable 빌드를 내지 않는다. uv가 쓰는 그것 |

"자기 완결"이 뜻하는 것: **번들된 인터프리터가 이 기계의 다른 파이썬을 우연히 집어 오지
못한다.** Windows는 `._pth`가 PYTHONPATH·레지스트리·user site-packages를 전부 무시하게
만든다. Linux의 python-build-standalone은 `._pth`를 보지 않으므로 런처가 `PYTHONPATH`와
`PYTHONHOME`을 지운다. 단 **`PYTHONHOME`은 Windows에서도 `._pth`를 뚫고 들어온다** —
`start.bat`과 `manage.ps1`이 그것도 지운다.

의존성은 빌드 머신의 pip이 `--platform/--abi/--python-version`으로 받는다. 대상
인터프리터를 **실행하지 않으므로** Windows 한 대에서 두 아카이브를 다 만든다. lock은
플랫폼별이다 — `pydantic-core`·`tiktoken`·`regex`가 컴파일 휠이라 해시가 플랫폼마다 다르다.

## D.3 검증

시스템 파이썬을 일부러 못 쓰게 하고 설치했다: PATH에서 파이썬을 전부 빼고
`PYTHONHOME`/`PYTHONPATH`를 없는 경로로. Ubuntu 20.04는 시스템 파이썬이 3.8뿐이라
이 앱을 돌릴 수 없는 기계다 — 동봉된 3.11로 떴고, 서버 프로세스가
`pyserver/python/bin/python3.11`인 것을 `ps`로 확인했다.

## D.4 리허설이 잡은 것 — 순서대로

1. **의존성이 `pyserver/` 밖에 깔렸다.** `--target`이 `stage / site`였고 `pyserver/`가
   빠져 있었다. zip에는 5,311개 파일이 들어 있었지만 인터프리터가 보는 자리가 아니었다.
2. **`.pyc`가 빌드 머신의 3.12용으로 컴파일됐다.** 3.11 번들 안의 8 MB 쓰레기. `--no-compile`.
3. **실행 권한 비트가 버려졌다.** `external_attr`에 0o755를 넣어도 `create_system`이
   기본값 0(MS-DOS)이면 unzip이 무시한다. 3(Unix)이어야 한다.
4. **52 MB 정적 바이너리가 심볼릭 링크 자리마다 복사됐다.** `python3 → python3.11`,
   `python → python3`를 "10 KB 복사"로 생각했는데 정적 링크라 각각 52 MB였고 번들이
   89 MB가 됐다. 두 줄짜리 `exec` 심으로 바꾸고, 임베딩 호스트만 쓰는 53 MB
   `libpython.so`와 tk도 뺐다 → 34 MB.
5. **셸 심이 CRLF로 써졌다.** Windows의 `write_text`가 `\n`을 `\r\n`으로 바꿔서 커널이
   `/bin/sh\r`을 찾았다. `newline=""`. **이 프로젝트가 세 번째로 밟은 줄바꿈 함정이다**
   (`.sh` CRLF, `datadir.txt` BOM, 그리고 이것).
6. **`setup.sh`가 `PYTHONHOME`을 지우기 전에 인터프리터를 불렀다.** `start.sh`만 지우고
   있었다. `No module named 'encodings'`는 인터프리터가 자기 stdlib을 못 찾을 때의
   증상이고, 그 기계에 stray `PYTHONHOME`이 있는 사용자가 겪었을 일이다. 오류 메시지도
   "glibc가 너무 오래됐다"고 **추측**하고 있었다 — 이제 실제 오류를 보여 준다.

## D.5 업데이터

OS당 아카이브가 하나씩이므로 업데이터가 **자기 플랫폼 것만** 고른다. 다른 쪽을 깔면
멀쩡한 서버를 이 기계에서 못 도는 파이썬으로 바꾸는 셈이다. `python/`도 `app/`과 함께
교체하고 — 새 버전이 새 파이썬을 요구할 수 있다 — 옛것을 옛 app 옆에 남겨 롤백이
rename 두 번으로 끝나게 했다.

`release.py`는 `bundle.py`로 위임만 한다. **인터프리터 없는 아카이브를 만들 수 있는 코드
경로를 남기지 않았다** — 그게 규칙을 어긴 아카이브였으니까.

# 부록 E — 에셋 서브시스템과 charx (2026-08-25 6차, v0.3.0)

## E.1 왜 스토어가 따로 있나

M1 까지는 바이트가 필요 없었다 — 카드·스크립트·로어북은 텍스트라 `/workspace` 업로드에
실려 온다. 그 다음 전부가 바이트를 요구한다: charx 는 카드+이미지의 zip 이고, PIL 작업은
픽셀이 필요하고, 에셋 탭은 2980장이 무엇인지 말해야 한다. RisuAI 자신이 에셋을 콘텐츠
해시로 키잉하므로(`assets/<sha256>.<ext>`) 스토어도 그대로 따른다:
`data/assets/<sha256>.<ext>`, 봇 간 전역, 구조상 dedup. 해시는 백엔드가 다시 계산한다 —
파일 이름이면서 업로드 무결성 검사다. (`pyserver/app/assets.py` 머리말이 정본.)

## E.2 동기화가 그 모양인 이유 — M0 실측

2026-08-24, risu.xyz 계정 사용자 2980장/142.6MB: 호스트에서 **읽는** 데 42.8분(장당 862ms,
계정 스토리지가 장마다 허브 GET), 올리는 데 2.6분. 그래서 임포터는 "호스트에서 되도록 읽지
않기"를 중심으로 짰다:

    허브 풀     계정 사용자: 백엔드가 `sv.risuai.xyz/rs/<key>` 를 직접 병렬 GET (프로브 200)
    고속 경로   PocketRisu 가 같은 PC: `save/risuai.db` 의 `kv(key TEXT, value BLOB)` 를 읽기 전용으로
    플러그인 푸시  그러고도 빠진 것: readImage 4~6 동시, 바이트 기준 8MB 배치

**어느 경로에서 온 바이트든 같은 에셋인 이유**: RisuAI 의 키는 `assets/<SHA-256(바이트)>.<ext>` 다
(`parser.svelte.ts hasher`). 그래서 risu.xyz 에서 연 봇의 키가 같은 PC 의 PocketRisu DB 에 있으면
그건 "PocketRisu 의 데이터"가 아니라 **같은 바이트의 캐시 히트**다 — 실사용 첫 회(2026-08-25)에
웹 봇 312장이 0.6초에 채워진 것이 그 경우였고, 사용자가 "포켓리스에서 연결한 것처럼 읽어갔다"고
의심한 것이 이 문단의 계기다. 백엔드는 이 보장을 믿지 않고 **검증한다**: 키의 stem 이 64자
hex 이면 `sha256(bytes)` 가 그것과 같아야 저장하고, 다르면 출처가 무엇이든 거부한다
(`assets.store_bytes`). 봇 카드의 동기화 줄은 이번 회에 어디서 몇 장이 왔는지 밝힌다.

콘텐츠 어드레싱 덕에 재개·증분이 공짜다. 호스트가 못 읽은 키는 `failed` 로 표시해 게이트를
붙들지 않게 했고, 다음 동기화가 다시 시도한다. 반영 게이트는 백엔드의 `complete`(빠진 것 없음 +
풀 진행 중 아님)로 연다 — 이미지가 도착하기 전에 쓴 카드는 charx 빌더가 완성할 수 없는 카드다.

## E.3 charx — module.risum 을 만들지 않는다

RisuAI 의 charx 내보내기(characterCards.ts `createBaseV3` + `exportCharacterCard`, c0ed1026)는
트리거·Regex·로어북을 모듈로 **복제한 뒤 card.json 에서 지운다**. 임포터(`importCharacterProcess`
→ `importCharacterCardSpec`)는 모듈이 없으면 인라인 `extensions.risuai.triggerscript` /
`customScripts` 와 `character_book` 을 그대로 소화한다. 그래서 인라인으로 두면 rpack 인코더가
필요 없고 같은 결과로 들어온다(모듈 namespace 는 charx 왕복에서 어차피 소실 — `charx-cards.md`).

RisuAI 와 다른 점 하나: 아이콘 항목(`ccdefault:` → `assets/icon/image/main.png`)을 감정
이미지가 있을 때만이 아니라 **항상** 넣는다. 임포터는 `icon`+`main` 을 캐릭터 이미지로 매핑하고,
없으면 초상이 없는 봇이 된다. 임포터는 zip 에 없는 `embeded://` 경로에서 **throw** 하므로 빠진
에셋은 기본 거절(목록 반환), `allowMissing` 이면 그 항목을 제거한다. 조립 명세 전체는
`pyserver/app/charx.py` 머리말.

## E.4 에셋 추가·교체는 즉시 쓰인다

텍스트 재료와 달리 바이너리는 작업본이 없다. 승인된 `host_asset_add` / `host_asset_replace` 는
플러그인이 `saveAsset`(키는 호스트가 정하고 항상 `.png`) → 라이브 카드의 참조 목록에 붙이고
→ `/assets/adopt` 로 백엔드 스토어에 같은 키로 넣는다. 반영을 기다리지 않는 유일한 카드
변경이며, 그래서 PNG 로 제한했다(비-PNG 는 PocketRisu bulk-write 로만 가능 — 미구현, E.5).

## E.5 남긴 것

- 플러그인 fflate 조립 폴백(백엔드 동기화가 불가능한 환경) — 허브 풀+푸시로 웹도 백엔드 경로가
  성립해 우선순위를 내렸다.
- PocketRisu `bulk-write`(비-PNG 추가·교체, `__jwt_secret` 자체 서명) — `serverWrite` 플래그만 있다.
- 모듈 에셋(v2), 트리거 V2 블록 GUI.

# 부록 F — 봇 편집·설정 2라운드 (2026-08-25 밤, v0.4.0)

사용자 피드백 20여 건. 원칙은 앞과 같다 — **RisuAI 의 UI 가 제공하는 것만, RisuAI 가 저장하는 모양대로.**

## F.1 에셋 참조는 카드 재료다

이름 변경·삭제·일괄 도구는 이미지가 아니라 카드의 세 목록(`emotionImages` / `additionalAssets` /
`ccAssets`)을 고치는 일이다. 그래서 `card_scripts` 에 `kind='assetref'`(entry={field,name,key,ext})
로 들어가 Regex·트리거와 같은 수명(original|edited|added|deleted)을 살고, `card.patch` 가
`assets{emotionImages,additionalAssets,ccAssets}` 로 되돌려 반영 때 한 번에 쓴다. 통째로 쓰지만
바뀌었을 때만 보낸다(로어북·스크립트와 같은 규칙). 파일 바이트는 스토어의 일이고, 삭제는 참조만
지운다(파일은 RisuAI GC 몫). 봇 버전(`additionalData.character_version`, RisuAI UI 가 편집하는
자리)은 `characterVersion` 행으로 모델링하고 쓸 때 두 자리(nested + top-level) 모두 쓴다.
`backgroundCSS` 는 RisuAI UI 에 없으므로 퇴역.

## F.2 트리거 = RisuAI 의 세 모드

`TriggerList.svelte` 가 `triggerscript[0].effect[0].type` 으로 모드를 정한다: `triggerlua` 면 Lua
텍스트 박스 하나(이벤트 선택 없음 — 스크립트가 스스로 등록), `v2Header` 면 블록 프로그램, 그 외 V1.
탭은 그대로 따라간다: 모드 버튼 V2/Lua(+V1 은 현재가 V1 일 때만), Lua 는 박스 하나, V2/V1 은
읽기 전용 요약. 모드 전환은 RisuAI 가 쓰는 초기 객체로 목록을 통째로 바꾼다.

## F.3 동기화는 에셋 편집과 charx 만 기다린다

반영 게이트를 뗐다. 텍스트 재료는 텍스트로 쓰이니 이미지가 도착하기를 기다릴 이유가 없고, 스토어의
바이트가 필요한 것은 charx 조립과 에셋 편집뿐이다. 동기화 진행률은 탭 줄 끝(`syncbadge`)에 늘
보이고, 에셋 탭은 동기화 중 읽기 전용, charx(봇바) 버튼은 흐려진다.

## F.4 설정 — 에이전트 둘, 키는 한 곳

- **일반/검색 에이전트**: 프리셋에 `kind` 가 생겼고 종류별로 하나씩 선택된다(`agent` / `agent_search`
  섹션). 일반 에이전트는 `web_research(question)` 로 검색 에이전트(웹 검색 툴만, 스크립트 없음)를
  부른다. 검색 프리셋이 없으면 예전처럼 직접 `web_search`. UI 는 Gemini(검색 그라운딩)를 권한다.
- **API 키**(`api_keys`, DB v10): 프리셋은 `keyRef` 로 키를 빌리거나 자기 키를 든다. 키를 바꾸면
  그 키를 쓰는 선택된 프리셋이 즉시 재해석된다(`presets.reresolve_selected`). 에이전트는 여전히
  config 섹션만 읽는다 — `agent._model()` 은 몰라도 된다.
- **모델 카탈로그**: models.dev `api.json`(~200 프로바이더, API 주소·모델·컨텍스트·가격)을 백엔드가
  하루 한 번 받아 두고 `GET /models/catalog?q=` 로 검색한다. 정보·로그 탭의 카드와 프리셋 편집기의
  "카탈로그에서 찾기"가 같은 자료를 쓴다. 오프라인이면 캐시, 캐시도 없으면 빈 결과(500 아님).
- 연결 진단의 "토큰을 보내지 않았습니다"는 **연결이 실패했을 때만** 나온다. 성공 줄 밑에 그 말이
  남아 있던 것이 버그였다.

## F.5 OpenAI 구독(Codex)으로 에이전트 돌리기 (v0.4.1, 사용자 결정으로 진행)

Codex CLI 가 어느 PC 에도 없어 그 로그인을 빌릴 수 없었다. 그래서 `codexauth.py` 가 Codex CLI 와
같은 것을 한다: `auth.openai.com/oauth/authorize` PKCE(client_id `app_EMoamEEZ73f0CkXaXp7hrann`,
scope `openid profile email offline_access`, redirect `http://localhost:1455/auth/callback`) →
`/oauth/token` 교환 → `id_token` 의 `https://api.openai.com/auth.chatgpt_account_id` → 요청은
`https://chatgpt.com/backend-api/codex/responses` 에 `Authorization: Bearer` + `chatgpt-account-id`
+ `OpenAI-Beta: responses=experimental` + `originator: codex_cli_rs`. 이 백엔드는 **스트리밍만 받고
store 를 거부**하므로 `codexauth.client()` 가 `responses.create` 를 감싸 `stream=True, store=False` 를
강제하고, 스트림을 원치 않은 호출(연결 테스트)에는 `response.completed` 이벤트의 응답을 접어 돌려준다.
우리 세션은 원래 `run_stream_events` 라 그대로 통과한다. 토큰은 `data/codex-auth.json`(0600),
만료 5분 전 refresh_token 으로 갱신, 매 호출 전 bearer 를 다시 읽는다.

콜백: 백엔드 PC 의 브라우저면 127.0.0.1:1455 일회용 리스너가 받는다. 다른 기기(폰·다른 PC)면
리다이렉트가 "연결할 수 없음" 페이지로 끝나는데 **그 주소를 플러그인에 붙여넣으면** 완료된다
(`POST /codex/login/complete`, state 검증). 프리셋의 `provider='codex'` 가 스위치이고
`agent._model_for()` 가 `OpenAIResponsesModel` 로 분기한다. 문서화되지 않은 API 라 OpenAI 가 바꾸면
깨지고, 그때는 오류를 그대로 보여 준다 — 사용자가 알고 택했다.

## F.6 남긴 것

- 모바일 스플리터: `touch-action: none` 으로 고쳤으나 실기기 확인 전.
- 코덱스 실호출 검증(로그인·툴 호출·추론 모델) — 실사용에서.

# 부록 G — 3라운드와 개명 (2026-08-26, v0.5.0)

## G.1 Risu Elf → Risu Hina

실배포된 적이 없으므로 이력을 남기지 않고 이름을 바꿨다(`rename_hina.py` 한 번). 남긴 것은 셋:
GitHub 저장소 경로(`nilsonwhang3-spec/risu-hina`, URL 이라 유지), 체크아웃·설치 디렉터리 이름, 그리고
**호환 훅** — `RISUELF_*`/`REALOOC_*` 환경변수는 계속 읽고(`config._OLD_PREFIXES`), `/health` 서명은
`risu-hina` 이되 플러그인은 `risu-elf`/`real-ooc` 도 받으며, DB 는 `risuelf.db`→`risuhina.db` 로 첫 기동 때
채택한다. 플러그인 이름(`//@name risu-hina`)이 바뀌므로 RisuAI 에는 새 플러그인이다: 옛 항목의 `+` 로
받으면 Hina 가 설치되고(`plugin/Risu.Elf.Plugin.js` 를 한 번 더 같은 번들로 써 둔다), 백엔드 URL·토큰은
플러그인 저장소가 이름별이라 한 번 다시 입력한다. 릴리스 자산은 `Risu.Hina.*`; 실행 중인 옛 업데이터는
이름이 아니라 `Install.Package`+OS 로 고르므로 옛 백엔드도 새 zip 을 받는다.

## G.2 에이전트가 화면을 안다

플러그인이 매 프롬프트에 `mode`(chat|bot)를 보내고 `Deps.mode` 가 된다. 제안 종류를 두 집합
(`CHAT_KINDS` / `BOT_KINDS`)으로 나눠 `_propose` 와 `stage_*` 가 다른 화면의 재료면 거부하고
`propose_open_tab` 으로 이동을 제안하라고 답한다. 읽기는 어디서든 된다.

## G.3 이력이 끊기던 이유와 고침

`session.run` 은 성공한 턴만 `history` 행을 저장했다. 오류·중단으로 끝난 턴은 저장되지 않아 다음 턴이
마지막 *성공* 턴의 이력에서 시작했고, 그 사이 프롬프트를 에이전트는 들은 적이 없었다(실측: 사용자 턴 8개,
history 4개). 이제 `BaseException` 경로에서 프롬프트 + 도착한 텍스트 + 실패 메모를 이력에 붙인다.
컨텍스트 예산: pydantic-ai 2.x 엔 history processor 훅이 없어 `session.run` 이 실행 직전
`agent.compact_history()` 를 부른다 — `agent.historyBudgetChars`(기본 240k) 를 넘으면 마지막 6개를 남기고
앞부분을 모델이 한 번 요약해 (요약 요청, 확인) 한 쌍으로 대체하고, `COMPACTED` 에 기억해 두었다가 그 턴의
저장 이력으로 쓴다(요약 비용은 한 번). 중단은 클라이언트 AbortController → 서버 취소 → 같은 부분 이력 저장.

## G.4 봇 버전 간 워크스페이스

`workspace.root(ck)` 가 `characters.family_key` 를 보고 가족의 디렉터리를 돌려준다. 가족 표식은 카드의
`extentions.risu_hina.family`(원본의 char_key) — `host.cloneBot` 이 찍고, charx 는 `extentions` 를 그대로
실어 왕복 뒤에도 남으며, RisuAI 는 모르는 확장 키를 저장·내보내기·가져오기 모두에서 보존한다. 행(턴·카드·
로어)은 봇별 DB 키라 섞이지 않고, 파일(업로드·결과물·스크래치·스킬)만 공유된다.

## G.5 남긴 것

- 웹(risu.xyz) 에셋 썸네일: iframe CSP 에 `img-src` 가 없어 불가(`default-src 'none'`). PocketRisu 만.
- 실기기 확인: 모바일 거터, 코덱스 실호출, `web_research`, 요약 압축 실동작.

## G.6 허용 프롬프트 (v0.5.1)

셸 명령과 pip 설치는 승인 큐(턴이 끝난 뒤 결정)로는 안 된다 — 에이전트가 *지금* 필요해서다. 그래서
`permits.py` 는 툴 호출을 **블록**한다: 요청을 등록하고 `permits.decision()` 이 답을 기다리며(최대 10분,
시간 초과 = 거부), 패널은 턴이 도는 동안 `GET /permits?sessionId=` 를 1.5초마다 폴링해 프롬프트를 그린다
(허용 / 거부 / 이번 턴 항상 허용). "항상"은 세션·턴 단위라 `session.run` 의 finally 가 지운다.
실행은 샌드박스 밖(백엔드 프로세스)에서 워크스페이스를 cwd 로, 동봉 인터프리터를 PATH 앞에 두고 한다 —
사용자가 허용한 것이므로 감사 훅의 "프로세스 생성 금지"와 모순되지 않는다. 임베디드 파이썬엔 pip 이
없어 `tools/bundle.py` 가 pip 휠을 내려받아 `python311._pth` 에 올린다(휠은 zip-import 된다).

## G.7 업데이터는 자기 인터프리터를 옮길 수 없다 (v0.5.2)

첫 실사용 업데이트(0.5.0→0.5.1)에서 `_install` 이 `python/` 을 `shutil.move` 했다. 그 안의 `.pyd` 는 **지금
돌고 있는 프로세스가 로드한 것**이라 Windows 가 잠근다 → `PermissionError`, 그리고 `move` 의 폴백
(copytree 후 rmtree)이 절반만 지운 트리를 남겨 다음 시도는 `FileNotFoundError`. 규칙: **실행 중인 프로세스는
자기 인터프리터 디렉터리를 건드리지 않는다.** 새 인터프리터는 `python.new` 로 두고, 파이썬 밖에서 도는 런처
(`start.bat`/`start.sh`)가 다음 기동 직전에 `python`→`python.old`, `python.new`→`python` 으로 바꾼다.
`python/bundle.txt`(파이썬 버전 + `requirements.lock` 해시)가 같으면 스테이징도 하지 않는다. 런처 자체는
업데이터가 `*.new` 로 놓아 두는 것이라(자기 파일을 덮어쓰면 cmd 가 바이트 오프셋으로 읽다 깨진다), 옛 런처를
쓰는 설치본은 한 번 손으로 바꿔야 스왑이 작동한다 — 0.5.2 를 수동 설치하라는 이유.

버전 게이트: 플러그인은 `/health` 의 버전과 자기 버전의 major.minor 를 비교해 다르면 업데이트 경로
(`/health` `/update/*` `/plugin` `/logs` `/diag` `/config`) 외의 호출을 거부하고 어느 쪽을 올릴지 말한다.
그 전엔 어긋난 API 가 404 나 이상한 모양으로 깊은 곳에서 터졌다.

## H. 요청 파라미터는 데이터다 (v0.6.0)

"OpenAI 호환" 엔드포인트는 이름만 같다. 문서 기준(2026-08-26)으로 확인한 것: OpenAI 공식의 GPT-5·o 계열은
`temperature`·`top_p` 등 샘플링 파라미터를 **거부**하고(기본값만 허용), gpt-5.6 계열은 **Chat Completions 에서
툴 호출 자체를 거부**한다(Responses API 를 쓰거나 `reasoning_effort: none`); 구독 백엔드는 `max_output_tokens`
를 거부; Anthropic·Gemini(AI Studio)·Vertex 의 호환 계층은 모르는 필드를 **무시**; Ollama 는 `max_tokens`
만 알고 `max_completion_tokens` 는 목록에 없음; OpenCode 는 GPT·Grok 이 `/responses`, DeepSeek·GLM·Kimi 가
`/chat/completions`, Claude·Qwen 은 Anthropic 형식(우리 도구로 불가), Go 는 `opencode.ai/zen/go/v1`;
Vertex 는 OAuth 액세스 토큰만 받고 express-mode API 키는 이 엔드포인트에 없다. 한편 pydantic-ai 2.33 은
모델 이름만 보고 프로파일을 정하므로 gpt-5 에도 `temperature` 를 그대로 보내고, 툴 정의에 `strict:true`,
상한은 `max_completion_tokens`, 스트리밍엔 `stream_options` 를 늘 붙인다.

파라미터 집합을 코드에 박으면 어딘가에서 반드시 깨진다. 그래서 `providers.py` 로 옮겼다:

- **프로파일**(`PROFILES`): Base URL 의 호스트(경로 포함 — `opencode.ai/zen/go` 가 `opencode.ai` 보다 앞)로
  찾는다. 출력 상한 필드, `strict` 허용, 거부 필드, 기본 API(chat|responses), 모델 계열 규칙(`modelRules`:
  접두어·예외·거부 필드·엔드포인트), 예시 JSON, 안내문, 문서 URL.
- **프리셋의 `params` JSON**: 키는 실제 요청 필드 이름. 값은 그 필드를, `null` 은 "보내지 않음". `max_tokens`
  / `max_completion_tokens` 에 숫자를 주면 값과 철자를 함께 정하고, 둘 다 `null` 이면 상한 없음. `strict`
  와 `api` 는 의사 키. 모르는 키는 `extra_body` 로 그대로 나간다. `model`·`messages`·`stream`·`tools` 는
  거부.
- **계획**(`plan_for`): 섹션 숫자칸 → 프로파일 거부 목록 → JSON 의 순서로 `settings`(pydantic-ai 모델 설정),
  `drop`(요청 직전에 뺄 필드), `cap_field`, `strict_tools`, `api` 를 만든다. `temperature` 기본은 **None
  = 보내지 않음** — 프로바이더마다 기본값이 있고 OpenAI 사고 모델은 기본값만 받으므로.
- **적용**: `agent._client` 가 `AsyncOpenAI.chat.completions.create` 와 `responses.create` 를 감싸 `drop`
  (+Responses 철자 별칭)을 pop 한다 — 설정으로는 끌 수 없는 `stream_options`·`parallel_tool_calls` 까지 여기서
  빠진다. `agent._profile` 은 `openai_model_profile(모델)` 위에 `openai_chat_supports_max_completion_tokens`
  와 `openai_supports_strict_tool_definition` 을 얹는다(`merge_profile`; 프로파일은 TypedDict 라
  `dataclasses.replace` 가 아니다). 연결 테스트(`h_config_test`)도 같은 계획으로 `/responses` 또는
  `/chat/completions` 에 같은 필드를 보낸다.
- **안내**(`hint`): 400 본문의 "Unsupported parameter: 'X'" · "Unsupported value: 'X' does not support …" ·
  "Unknown name \"X\"" · "X: Extra inputs are not permitted" · "Function tools with reasoning_effort are not
  supported" 등에서 필드를 뽑아, 프리셋 JSON 에 넣을 정확한 스니펫을 붙인다(`{"temperature": null}`,
  `{"max_completion_tokens": 32000}`, `{"api": "responses"}`). 모르는 단어는 필드 목록(`KNOWN_FIELDS`)에
  없으면 무시한다. `session._explain`·연결 테스트·검색 에이전트 실패 문구에 붙는다.

사용자 실측: gpt-5.6-sol 을 구독(Responses) 경로로 쓰면 툴 호출까지 문제없다 — 조사 결과와 같은 방향이라
OpenAI 공식 프로파일의 기본도 Responses 로 두었다.
