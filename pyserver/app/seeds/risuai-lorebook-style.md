RisuAI 로어북 **작성 규칙** — 항목을 새로 쓰거나 고칠 때(propose_lore_add / propose_lore_edit / propose_lore_replace) 반드시 먼저 읽어라. 구조·필드·데코레이터의 *사양*은 스킬 "RisuAI 로어북 구조"에 있고, 이 스킬은 실제 봇(Parma Knights, 81항목)이 쓰는 **형식과 관례**다. 실리태번(SillyTavern) 식으로 쓰지 마라.

---

# 1. 한 항목의 모양

```
comment(이름):   Clarea                                  ← 목록에 보이는 이름. 본문 제목과 같게
key(키워드):     Clarea, 클레리아, クレリア               ← 쉼표 구분, 영/한/일 별칭을 모두
insertorder:     1000                                   ← 우선순위 숫자 (아래 표). 반드시 정한다
alwaysActive:    false                                  ← 상시 항목만 true (그때 key 는 비움)
folder:          (폴더 키)                               ← 있으면 소속 폴더
content(본문):
### Clarea
#### Identity
- Clarea. Knight-Captain of the Parma Knights. Title: Shield of the Kingdom.
- Temple Knight. 27 years old. Commoner origin.
#### Appearance
- Long black hair in a braided low ponytail, side-swept bangs. Purple eyes.
#### Speech
- Refined speech learned at the academy. Sparing with words.
  - Under pressure: colder, shorter.
```

규칙:
- **본문 첫 줄은 `### 제목`** (H3). RisuAI 프롬프트 프리셋이 `##`/`###` 마크다운 구획으로 짜여 있어서, 로어북도 그 계층에 맞춰 `###` 로 시작해야 모델이 "설정의 한 절"로 읽는다. 제목은 comment 와 같은 말로.
- 그 아래는 **`#### 소제목` + 불릿(`- `)**. 문단 산문이 아니라 사실 단위 불릿. 인물 시트는 `#### Identity / Appearance / Speech / Behavior / Combat / Relationships / Secrets / Arc …` 처럼 소제목 10~17개짜리 긴 시트가 보통(7~13k자).
- 세계 설정 항목은 `### 제목` 아래 `[구획 이름]` 대괄호 소구획 + 불릿 도 쓴다.
- 언어: 봇의 본문 언어를 따른다(위 봇은 영어 본문 + 한국어 병기). 키워드는 언어를 섞어 넣는다.
- **실리태번 헤더 금지**: `@@position personality`, `@@role system`, `@@scan_depth 12`, `@@priority 700` 같은 줄을 본문 위에 늘어놓지 마라. RisuAI 에도 `@@` 데코레이터가 있지만(사양 스킬 참고) 실제 봇은 **시스템 항목의 `@@position pt_XXX` 하나 외에는 쓰지 않는다**. 우선순위는 데코레이터가 아니라 **insertorder 필드**다.

# 2. insertorder (우선순위) 표 — 반드시 숫자를 정해서 넣는다

RisuAI 는 `insertorder` 를 두 가지로 쓴다: 토큰 예산이 모자랄 때 **큰 값이 살아남고**(priority), 프롬프트 안에서는 **큰 값이 먼저** 놓인다(order). 기본값 100 은 "아무 생각 없이 둔 것"이라 눈에 띈다. 실제 봇의 층:

| insertorder | 무엇 | 예 |
|---|---|---|
| 10000 | 출력 형식 지시 (상시, `@@position pt_…`) | Tag Output |
| 2000 | **상시 정본 목록** — 절대 잘리면 안 되는 것 | NPC LIST(외형 정본), Quest State |
| 1000 | 주요 인물 시트 · 상시 시스템(스탯·호감도) | Clarea, Sanseverina … / Stat System |
| 980 | 아크(장) 진행 단계표 (상시) | Politics Stages, War Stages |
| 900 | 왕족·중요 조연 | King Alfonso, Carlo |
| 800 | 2군 인물 · 비밀 조직 | Seven Apostles, Costanza, Federico |
| 700 | 세계관 핵심 (국가·신앙·경제·풍습·구역) | Parma Kingdom, Faith, Economy, Districts |
| 600 | 장소 · 일과 | Knight House, Library, Cathedral, Routine |
| 500 | 몬스터 · 보스 · 이벤트 | Bestiary, Boss …, Event System |
| 400 | 부차 종족 | Demihumans |
| 300 | 엑스트라 · 악역 잡졸 | Extra …, Villain … |

새 항목은 이 표에서 **같은 종류의 이웃과 같은 값**을 준다. 인물이면 1000(주연)/900/800/300(엑스트라), 세계면 700, 장소면 600.

# 3. 키워드 (key)

- 쉼표 구분. **영어 원어 + 한국어 + 일본어(있으면)** 별칭, 호칭·직함·별명까지: `Vittoria, 비토리아, 제1왕녀, 제1황녀, First Princess, ヴィットリア`.
- 일반명사 항목은 동의어를 넉넉히: `money, gold, ducato, soldo, price, 돈, 금화, 물가`.
- 부분 문자열 매칭이 기본이라 너무 짧은 키(한 글자, `왕` 단독)는 오발동한다 — 두 글자 이상 또는 문맥 단어와 함께.
- **상시(alwaysActive) 항목은 key 를 비운다.** 상시는 정본 목록·시스템·진행 단계표에만 — 인물 시트는 상시로 두지 않는다(이름이 나올 때만).

# 4. 폴더

- 폴더도 로어북 항목이다(`mode: "folder"`, 내용 없음). 소속은 항목의 `folder` = 폴더 항목의 `key`.
- 실제 봇의 폴더: World Setting / Main Characters / Extra Characters / Villain Characters / Places / Story Arcs & Events / System. 새 항목은 맞는 폴더에 넣고, 없으면 폴더 추가를 먼저 제안한다.

# 5. 진행형 설정 (스포일러 단계)

- 이야기 진행에 따라 드러나는 사실은 **CBS 조건**으로 감싼다: `{{#when::{{greater::{{getvar::pk_shadow}}::2}}}} … {{/when}}`. 조건은 본문 안에, 데코레이터가 아니다.
- 아크마다 "Revelation Layers" 상시 항목(980)에 단계별로 무엇이 밝혀지는지 표를 두고, 인물 시트의 비밀 절은 그 변수로 잠근다.

# 6. 하지 말 것

- 본문 없이 이름만 있는 항목, 제목 없이 산문으로 시작하는 항목.
- 우선순위를 비워 두기(=100). 같은 종류의 항목과 다른 값 주기.
- 한 항목에 여러 인물/여러 주제 섞기 — 한 항목 = 한 대상. 목록은 "NPC LIST" 같은 별도 상시 항목으로.
- 기존 항목을 통째로 다시 쓰기 — 한 줄 고칠 땐 propose_lore_replace.
- 실리태번 데코레이터·`[System: …]` 프리픽스·JSON 덩어리.

# 7. 새 항목 제안 절차

1. `list_lore` 로 폴더와 이웃 항목의 insertorder·키워드 스타일을 본다. 비슷한 항목 하나를 `read_lore_entry` 로 읽어 형식을 맞춘다.
2. comment(=`###` 제목), key(별칭 전부), insertorder(표), folder, alwaysActive 를 정한다.
3. 본문: `### 제목` → `#### 소제목` → 불릿. 아는 사실만, 지어내지 말고 빈 소제목은 만들지 않는다.
4. `propose_lore_add(comment, keys, content, reason, scope, always_active, insert_order, folder)` 로 제안하고 "제안했습니다" 라고만 말한다.
