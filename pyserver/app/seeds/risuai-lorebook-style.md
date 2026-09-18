RisuAI 로어북 **작성 규칙** — 항목을 새로 쓰거나 고칠 때(propose_lore_add / propose_lore_edit / propose_lore_replace) 반드시 먼저 읽어라. 구조·필드·데코레이터의 *사양*은 스킬 "RisuAI 로어북 구조"에 있고, 이 스킬은 실제 봇(Parma Knights, 81항목)이 쓰는 **형식과 관례**다. 실리태번(SillyTavern) 식으로 쓰지 마라.

---

## 적용 범위를 먼저 구분

- **봇 로어북**: `scope="global"`, `botlore` 탭. 이 봇에 영구 저장되어 여러 챗에서 활용할 설정.
- **챗 로어북**: `scope="local"`, `lore` 탭. 특정 챗의 진행 상황·사건·임시 설정에만 적용.
- 사용자 지정 범위가 우선이다. 범위 생략 시 봇 편집에서는 봇 로어북, 챗 편집에서는 현재 챗
  로어북을 기본으로 한다. 봇 로어북 요청 때문에 챗 로어북 화면 이동을 제안하지 않는다.
- 기존 항목 수정은 그 항목의 범위를 유지한다. 영구 저장과 상시 발동(`alwaysActive`)을 혼동하지 않는다.

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
- **로어북 내용의 제목은 `###`, `####`, `[구획 이름]` 등으로 쓴다.** `##`는 상위 프롬프트 구조에서 쓰므로 로어북 본문에는 H3 이하(`###` 이상 개수의 `#`)만 쓴다. 독립 항목은 보통 `### 제목`으로 시작하고 제목은 comment와 맞춘다. 그룹 아래에 이어지는 개별 항목은 실제 주입 구조에 맞춰 `####` 등으로 낮춘다. 위치 지정 데코레이터가 있으면 제목보다 앞에 둔다.
- 그 아래는 **`#### 소제목` + 불릿(`- `)**. 문단 산문이 아니라 사실 단위 불릿. 인물 시트는 `#### Identity / Appearance / Speech / Behavior / Combat / Relationships / Secrets / Arc …` 처럼 소제목 10~17개짜리 긴 시트가 보통(7~13k자).
- 세계 설정 항목은 `### 제목` 아래 `[구획 이름]` 대괄호 소구획 + 불릿 도 쓴다.
- 언어: 봇의 본문 언어를 따른다(위 봇은 영어 본문 + 한국어 병기). 키워드는 언어를 섞어 넣는다.
- **실리태번 헤더 금지**: `@@position personality`, `@@role system`, `@@scan_depth 12`, `@@priority 700` 같은 줄을 본문 위에 늘어놓지 마라. RisuAI 에도 `@@` 데코레이터가 있지만(사양 스킬 참고) 실제 봇은 **시스템 항목의 `@@position pt_XXX` 하나 외에는 쓰지 않는다**. 우선순위는 데코레이터가 아니라 **insertorder 필드**다.

# 2. insertorder (우선순위) 표 — 반드시 숫자를 정해서 넣는다

로어북은 **우선순위가 낮은 것부터 위에서 아래로 표시·배치**되고, 길이(토큰) 예산이 부족하면 **낮은 우선순위부터 잘린다**. `insertorder`가 클수록 높은 우선순위다. 예산 때문에 덩어리의 일부가 잘리는 것은 불가피한 경우 허용하며, 모든 항목이 통째로 보존된다고 가정하지 않는다. 아래 숫자는 실제 봇의 예시이며, 작업 중인 봇의 유사 항목과 우선순위 대역을 먼저 맞춘다:

| insertorder | 무엇 | 예 |
|---|---|---|
| 10000 | 출력 형식 지시 (상시, `@@position pt_…`) | Tag Output |
| 2000 | **상시 정본 목록** — 예산 내 우선 보존할 전체 지도 | NPC LIST(외형 정본), Quest State |
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

## 총합 로어북과 개별 로어북

- 통상 토큰 예산이 있으므로 **전체 지도가 되는 총합 로어북 + 활성화될 때 주입되는 개별 로어북**으로 구성한다.
- 예: `NPC LIST`에는 전체 인물의 이름·역할·핵심 관계를 간결하게 두고, 특정 NPC의 상세 성격·행동·설정은 해당 NPC의 개별 로어북에 둔다. 총합 항목에 모든 상세 내용을 중복하지 않는다.
- `@@`가 붙은 중요 로어북은 이 봇에서 끝부분 등 지정 위치에 들어가는 구조다. 특히 `@@position`, `@@depth`, `@@end` 등 기존 위치 지정을 보존하고, 일반 우선순위 배열과 별도로 실제 삽입 위치를 확인한다. 모든 `@@`가 위치 지정을 뜻하는 것은 아니므로 구체적인 의미는 구조 스킬을 따른다.

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
2. 총합·개별 로어북 중 역할을 정하고 comment(본문 제목), key(별칭 전부), insertorder(유사 항목의 대역), folder, alwaysActive 를 정한다.
3. 본문은 그룹·개별 항목의 제목 위계에 맞춰 `###`, `####`, `[구획 이름]`과 불릿으로 쓴다. 아는 사실만 쓰고 빈 소제목은 만들지 않는다. 아래 검토 기준으로 전체 구조와 순서를 확인한다.
4. `propose_lore_add(comment, keys, content, reason, scope, always_active, insert_order, folder)` 로 제안하고 "제안했습니다" 라고만 말한다.

# 8. 작성·수정 시 구조와 순서 검토

1. **유사 의미의 우선순위 대역**: 캐릭터, 월드 이벤트, 월드 세팅, 개인 성격 등 의미가 유사한 항목들이 같은 값 또는 가까운 우선순위에 모여 있는지 확인한다. 중요도에 따른 차이는 유지하되, 이유 없이 떨어져 있는 항목은 조정한다.
2. **그룹·개별 로어북의 제목 위계**: 실제로 함께 주입되는 본문을 기준으로 `###`, `####`, `[]`가 그룹·개별 항목·소구획 관계를 올바르게 나타내는지 확인한다. 폴더 자체는 본문 헤딩으로 주입되지 않는다. 총합 로어북이 전체 지도라는 이유만으로 모든 개별 항목을 그 제목 아래에 종속시키지 말고, 독립 활성화될 때도 제목과 대상이 분명한지 살핀다.
3. **전체 순서**: 낮은 우선순위부터 높은 우선순위로 이어지는 배열, 총합·개별 항목의 관계, `@@` 중요 항목의 지정 위치를 함께 보고 바로잡을 부분을 확인한다. 일부 항목의 비활성화나 예산 절단으로 생략이 생겨도 남은 내용의 의미·소속이 최대한 분명하도록 작성한다. 예산 때문에 덩어리 일부가 잘리는 것 자체를 오류로 취급하지 않는다.
