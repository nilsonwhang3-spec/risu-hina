<!-- risuhina-preset-scope-v1 -->
RisuAI는 별도의 프롬프트 제작자가 제공하는 프롬프트 프리셋에서 로어북 삽입 순서, 서술 시점, 대필 유무를 옵션으로 지정한다. 봇카드와 로어북에는 세계관·인물·사건·상태 및 봇 고유 시스템을 작성하고, 해당 서술 옵션은 프리셋 설정을 따른다. 프리셋의 제어 옵션은 제작 지식으로만 참고하고 봇카드·로어북 본문에 별도 규칙으로 기재하지 않는다.

RisuAI 봇의 **에셋 출력식** 레퍼런스. 모델이 본문에 이미지 태그(예: `<img src="캐릭터-감정">`)를 봇의 에셋 목록에 맞게
내도록 하는 지시문, 에셋 목록과 대조해 없으면 폴백시키는 표시 정규식, SFW/NSFW 출력 구분, 그리고 태그 삽입을
보조모델(axLLM)에 위임하는 구조를 만들거나 고칠 때 읽어라.

> **이름 체계는 봇마다 다르다.** 캐릭터명과 상태 키워드를 잇는 구분자(`-`, `_` 등), 키워드 어휘, NSFW 키워드의 조립 방식,
> 태그 모양은 전부 봇이 정한다. 아래 예시는 `캐릭터명-키워드` 형태를 쓰지만 공통 규격이 아니다.
> 작업할 봇의 실제 에셋 이름(`{{assetlist}}`, 카드 에셋 목록)을 먼저 읽고 그 체계에 맞춘다.
> 변수·클래스 이름(`asset_aux`, `bot-`)도 자리표시자다.

---

# RisuAI 에셋 출력식 작성법

## 0. 전체 구조

```
[글로벌 노트 덮어쓰기 = post_history_instructions]
  {{#when::asset_aux::visnot::1}} ### Image Commands … {{/when}}   ← 메인 모델 모드에서만 지시
  {{position::PI}}                                                ← 로어북 @@position pt_PI 가 꽂히는 자리
        │
        ▼ 모델이 본문에 이미지 태그를 문자 그대로 출력
        │
  [정규식 editdisplay "에셋 출력"]    {{contains::{{assetlist}}::전체이름}} → 그대로 렌더
                                     else {{contains::{{assetlist}}::베이스이름}} → 키워드 떼고 베이스 이미지
                                     else 아무것도 그리지 않음          ← 검증·폴백은 여기서 한다
  [정규식 editdisplay "에셋 지우개"]  최근 N개 메시지 밖의 태그는 화면에서 제거
  [정규식 editprocess "에셋 리퀘 제거"] 모델에 보내는 히스토리에서 옛 태그 제거(보조 모드에선 전부)
        │
  [보조모델 모드 asset_aux=1]  onOutput → axLLM 에 줄번호 붙인 본문 → [{"line":N,"asset":"이름"}] → setChat 으로 삽입
                              + 억제 로어북(constant, @@position pt_PI)으로 메인 모델의 태그 출력 금지
```

핵심 사실 세 가지:
1. **지시문은 글로벌 노트 덮어쓰기(`post_history_instructions`)에 쓴다.** 프리셋이 이 필드를 대화 히스토리 뒤, 모델과 가장
   가까운 자리에 배치하므로 "매 턴 지켜야 하는" 출력 규칙에 적합하다. `system_prompt` 는 프리셋의 메인 프롬프트를 대체하므로
   에셋 지시를 거기에 넣지 않는다.
2. **에셋 목록 대조와 폴백은 표시 정규식의 CBS `{{contains::{{assetlist}}::…}}` 로 한다.** Lua 에는 에셋 목록 API 가 없다.
   정규화(공백↔구분자, 대소문자)도 자동으로 되지 않는다. 지시문의 이름이 에셋 이름과 글자 단위로 같아야 한다.
3. **SFW/NSFW 는 렌더 단계에서는 그저 다른 키워드다.** 표시 정규식은 둘을 구분하지 않고, 없는 조합은 베이스 이미지로 조용히
   폴백된다. 구분은 지시문 규칙과 에셋이 실제로 있는지로만 작동한다.

---

## 1. 지시문 위치와 게이트

- 카드의 `post_history_instructions` = RisuAI 카드 편집의 "글로벌 노트 덮어쓰기".
- 에셋 지시 블록 전체를 `{{#when::asset_aux::visnot::1}} … {{/when}}` 로 감싸면, 보조모델 모드에서는 지시가 사라진다.
  `vis`/`visnot` 의 첫 인자는 변수 **이름**이다(`{{getvar::…}}` 로 쓰면 틀림). 수치 비교(`>=`)만 `{{getvar::}}` 로 값을 푼다.
- `{{position::PI}}` 는 "PI 라는 삽입 지점"을 선언한다. 로어북 항목 첫 줄의 `@@position pt_PI` 가 그 본문을 이 자리로 옮긴다.
  상태창 출력 규칙, 보조모델 억제문처럼 매 턴 강제할 규칙을 같은 최말단 슬롯에 모을 수 있다.
  `{{position::PI}}` 를 블록 앞에 두면 로어북 규칙이 먼저·에셋 지시가 마지막, 뒤에 두면 그 반대다.
  모델에 가장 가까운 마지막 문단이 무엇이어야 하는지로 정한다.
- `{{asset::X}}`/`{{emotion::X}}` 같은 표시 전용 CBS 는 모델에 전송되지 않는다. 그래서 모델에게는 태그를 문자 그대로 쓰게 하고 표시 정규식에서 렌더한다.
- 모드 변수(예: `asset_aux`)는 2상태가 표준이다. `0` = 메인 모델이 태그 출력, `1` = 보조모델 후처리. `defaultVariables` 에 기본값을 두고 `onStart` 에서 미설정 백필한다.

---

## 2. 지시문 템플릿 (메인 모델 모드)

순서: **발동 규칙 → 형식 → 대상 캐릭터 목록(계층별) → SFW 키워드 → NSFW 키워드와 규칙 → 선택 규칙 → 짧은 오답 예시 → 줄바꿈 규칙**.

### 2.1 발동 규칙과 형식

```
### Image Commands
Output `<img src="Name">` or `<img src="Name-keyword">` whenever a listed character appears, speaks, or is spotlighted.
One per character per appearance, every time, even if no image was shown in previous context.
```

"이전 문맥에 이미지가 없었어도 매번" 이 없으면 모델이 몇 턴 뒤부터 태그를 생략한다. 형식 줄은 봇의 실제 이름 체계로 쓴다.

### 2.2 대상 캐릭터를 에셋 구성별로 나눈다

캐릭터마다 에셋 구성이 다르면 계층을 나누고 계층별 규칙을 명시한다. 흔한 계층:

| 계층 | 에셋 | 지시 |
|---|---|---|
| 감정 세트 보유 | 베이스 + 감정 키워드 (+ NSFW 키워드) | 키워드를 붙인다 |
| 베이스 1장 | 기본 이미지만 | 키워드를 붙이지 않는다(붙이면 폴백만 남는다) |
| 이중 외형 | 외형마다 별도 베이스 이름 | 본문이 이미 확립한 외형을 따르고, 모델이 스스로 바꾸지 않게 한다 |
| 진행 게이트 | 스토리 변수로 쓸 수 있는 에셋이 달라짐 | `{{#when::{{getvar::stage_var}}::>=::1}}…{{/when}}` 로 규칙 자체를 교체 |

```
Characters with full emotion sets: A, B, C
Characters with a single image (bare name only, never add a keyword): D, E, F
{{#when::mode_var::vis::extra}}, G{{/when}}                      ← 모드에 따라 추가되는 캐릭터
Do NOT output image tags for any other character.
```

- 목록에 없는 NPC(행인·점원 등)에 태그를 내지 말라고 명시한다. 안 쓰면 모델이 이름을 지어내고, 정규식이 전부 폴백시켜 빈 자리만 남는다.
- 진행 게이트 변수를 쓰면 보조모델 프롬프트에서도 같은 변수를 읽어 두 경로가 어긋나지 않게 한다.

### 2.3 SFW 키워드

봇의 실제 에셋 키워드를 그대로 나열한다. 표시 정규식은 정확 일치만 보므로, 지시문 목록과 에셋 이름이 **글자 단위로 같아야** 한다.
공백·구분자·철자가 하나라도 다르면 그 키워드는 항상 베이스 이미지로 폴백된다. 목록은 지시문, 보조모델 키워드 로어북,
에셋 목록 세 곳에 중복되기 쉬우므로 추가·이름 변경 때 셋을 대조한다(§6).

### 2.4 NSFW 키워드: 설계 선택지

두 가지 설계가 있다. 봇의 에셋이 어느 쪽으로 만들어졌는지에 맞춘다.
- **단일 행위 키워드**: 행위 하나당 키워드 하나. 에셋 수가 적고 선택이 쉽다.
- **조합 키워드**: 행위에 여러 축(복장 상태, 장면 요소 등)을 붙여 조립한다. 장면과 그림이 더 잘 맞지만 에셋 수가 축의 곱만큼 늘어난다.
  조합 규칙(각 축의 선택지와 붙이는 순서·구분자)과 **선택 절차**(1. 행위 판단 → 2. 축 A 판단 → …)를 지시문에 번호로 적는다.

어느 설계든 들어갈 규칙:

```
- Explicit sexual scenes: use the matching NSFW keyword instead of an emotion.
- While a sexual act is ongoing, NSFW keywords are the ONLY valid tags for participating characters.
  Never output an SFW emotion or a bare name for them during the act.
  If no listed keyword matches exactly, use the CLOSEST listed NSFW keyword — do not fall back to SFW.
- When the scene moves to afterglow or conversation, switch back to SFW emotions.
- NSFW keywords apply only to characters that have them (list them). Never use them for others.
- One keyword per tag. Do not combine an emotion and an NSFW keyword in one tag.
```

"행위 중에는 NSFW 키워드만" 과 "없으면 가장 가까운 NSFW 키워드" 가 없으면, 모델은 행위 장면에서도 SFW 감정(`lustful` 류)으로 도망간다.
조합 키워드의 모든 조합을 에셋으로 갖추지 않아도 깨지지는 않는다. 없는 조합은 베이스로 폴백된다. 다만 모델이 자주 고르는
조합이 없다면 지시문 선택지를 실제 에셋에 맞춰 줄이는 편이 낫다.

### 2.5 선택 규칙, 오답 예시, 줄바꿈

```
- Single-image characters: ALWAYS use the bare name. Never append a keyword.
- Non-sexual scenes: use the best-fitting emotion. Omit the keyword only in a genuinely blank, unreadable state (extremely rare).
WRONG: `<img src="A">` ← Missing keyword for a full-set character.
Always place one blank line before and after each image tag.
```

- 오답 예시는 효과가 있지만, 모델이 부정 예시를 그대로 따라 하는 경우도 있다. 짧게, 2~3개만, 정답 예시 뒤에 둔다.
- 줄바꿈 규칙은 태그가 문장 중간에 끼어 렌더가 깨지는 것을 막는다. 지시문 + 줄바꿈 정규식(§3.5) + 보조모델 패치의 빈 줄 삽입(§4.4), 세 겹으로 두면 안전하다.

---

## 3. 표시 정규식: 검증·폴백 체인

### 3.1 기본형 (구분자가 `-` 인 경우의 예)

```
=== 에셋 출력 ===
type: editdisplay
in: <img src="(([^"\-]+)(-[^"]*)?)"?>
out: {{#when::{{contains::{{assetlist}}::$1}}}}<div class="image-container" style="background-image: url('{{raw::$1}}');" tabindex="0"></div>{{/when}}{{#when::not::{{contains::{{assetlist}}::$1}}}}{{#when::{{contains::{{assetlist}}::$2}}}}<div class="image-container" style="background-image: url('{{raw::$2}}');" tabindex="0"></div>{{/when}}{{/when}}
ableFlag: false
```

- 캡처: `$1` = 전체 이름, `$2` = 첫 구분자 앞(베이스), `$3` = 구분자 포함 키워드. **정규식은 봇의 구분자에 맞춰 바꾼다.**
  베이스 이름 안에 그 구분자 문자가 들어가면 안 된다(첫 구분자에서 자르므로).
- 체인: 전체 이름 정확 일치 → 베이스 → 둘 다 없으면 아무것도 출력하지 않음(태그 소멸).
- `{{assetlist}}` = 카드 에셋 이름의 JSON 배열. `{{raw::name}}` 으로 경로를 얻어 `background-image` div 로 그리면 CSS 로 크기·비율을 통제하기 쉽다.
- 캐릭터 이름 캡션처럼 옵션으로 켜고 끄는 요소는 `{{#when::show_asset_label::visnot::0}}<span class="bot-asset-name">$2</span>{{/when}}` 로 넣는다.
  이 변수는 옛 메시지의 정규식도 읽으므로 토글할 때 `reloadDisplay` 가 필요하다.

### 3.2 변형 에셋을 모델에게 숨기고 정규식이 고르게 하기

의상·시대·형태 같은 변형 세트를 모델에 알리지 않고, 변수를 보고 정규식이 대체 이름을 먼저 시도하게 할 수 있다.
새 변형 세트를 추가해도 지시문은 그대로 두고 **정규식과 에셋 이름만** 손대면 된다.

```
{{#when::outfit_var::vis::1}}
  {{#when::{{contains::{{assetlist}}::$2_alt}}}}                     ← 이 캐릭터에 변형 세트가 있는가
    {{#when::{{contains::{{assetlist}}::$2_alt$3}}}} 변형+키워드 렌더 {{:else}}
    {{#when::{{contains::{{assetlist}}::$1}}}} 기본+키워드 렌더 {{:else}} 변형 베이스 렌더 {{/when}}{{/when}}
  {{:else}} (기본 체인) {{/when}}
{{:else}} (기본 체인) {{/when}}
```
`_alt` 는 자리표시자다. 변형을 나타내는 표기는 봇의 에셋 이름 체계대로 쓴다.

### 3.3 `contains` 의 한계

`{{contains::A::B}}` 는 JSON 문자열 전체에 대한 **부분 문자열** 검사다.
- 베이스 이름만 쓰인 에셋이 없어도, 그 이름으로 시작하는 키워드 에셋이 하나라도 있으면 베이스 검사를 통과한다.
- 한 이름이 다른 이름의 접두가 되면 오탐이 가능하다. 폴백이 베이스라 체감 피해는 작지만, 이름을 접두 관계가 없게 짓는 편이 낫다.
- `{{#each {{assetlist}} a}}` + `startswith` 루프로 검사하는 옛 방식도 있지만 느리고 길다. `contains` 한 줄이면 된다.

### 3.4 그룹 챗

그룹 챗에서는 `{{assetlist}}` 가 빈 문자열이라 이미지가 전부 소멸한다.

### 3.5 주변 정규식 (이 순서로)

```
=== 에셋 줄바꿈 ===        editdisplay  in: \s*(<img src="[^"]*">)\s*   out: (줄바꿈)$1(줄바꿈)
=== 에셋 지우개 ===        editdisplay  in: <img src="(.+?)">
   out: {{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}<img src="$1">{{/if}}   ← 최근 3개 메시지만 표시
=== 에셋 출력 ===          editdisplay  §3.1
=== 에셋 리퀘 제거 ===     editprocess  in: \s*<img src="[^"]*">\s*   out: {{#when::asset_aux::visnot::1}}$&{{/when}}
```

- 지우개는 출력보다 **앞**에 둔다. 남길 메시지 수는 `-2` 부분으로 조절한다.
- `editprocess` 리퀘 제거: 메인 모드에서는 최근 태그 몇 개를 히스토리에 남기면 few-shot 효과가 있다. **보조 모드에서는 전부 지운다.**
  컨텍스트를 따라 하는 경향이 강한 모델은 히스토리에 태그가 보이면 억제 지시를 무시하고 또 태그를 낸다.
- 리퀘 제거 항목의 `type` 이 `editprocess` 인지 확인한다. `editdisplay` 로 잘못 두면 화면에만 적용되고 요청에는 태그가 그대로 간다.
- `ableFlag: false` 는 비활성이 아니라 "flag 옵션 미사용(기본 g)" 이다.
- 정규식 `out` 의 CBS 는 다시 파싱된다. `{{#if}}` 는 deprecated 지만 동작한다. 새로 쓸 때는 `{{#when::…}}` 도 된다.
  `{{#when::{{greater_equal::…}}::vis::true}}` 처럼 `vis` 첫 인자에 식을 넣는 형태는 규칙 위반이라 항상 거짓일 수 있다.

---

## 4. 보조모델(axLLM) 위임

메인 모델은 서사만 쓰고, 보조모델은 완성된 본문을 보고 "몇 번 줄에 어떤 태그" 만 JSON 으로 답하는 결정적 후처리 API 로 쓴다.
메인 모델의 태그 오류(없는 이름, 누락, 중복)와 로어북 비대화를 함께 해결한다. 카드의 `lowLevelAccess` 가 켜져 있어야 한다(꺼져 있으면 `axLLM` 이 nil).

### 4.1 흐름

```lua
onOutput = async(function(id)
    if (getChatVar(id, "asset_aux") or "0") ~= "1" then return end    -- 모드 가드. 없으면 메인+보조 이중 출력
    local idx, content = get_last_char_msg(id)
    if not idx or content == "" then return end
    local snapshot = msg_data_at(id, idx)                           -- 레이스 가드용
    local new_text, changed = aux_run(id, content)                  -- 감지 → 프롬프트 → axLLM → 패치
    if changed and msg_data_at(id, idx) == snapshot then            -- 왕복 중 리롤/삭제됐으면 버린다
        setChat(id, idx, new_text)                                  -- 훅당 setChat 1회
        pcall(function() reloadDisplay(id) end)
    end
end)
```

- `onOutput` 은 반환값으로 본문을 바꾸지 못한다. 반드시 `setChat(id, idx, text)` 를 쓴다.
- 대상 메시지는 `getFullChat` 전체 파싱 대신 `getChat(id, idx)` 로 한 건만 읽는다. 긴 챗을 턴마다 통째로 파싱하면 모바일에서 메모리 부족으로 탭이 리로드된다.
- 마스터 토글 변수 이름을 잘못 적으면 가드에서 조용히 return 해, 수동 재생성 버튼만 동작하는 상태가 된다. 변수 이름을 옵션 UI 와 대조한다.

### 4.2 캐릭터 감지: 본문에 실제로 등장한 캐릭터만 후보로

- 영문 에셋 베이스 이름은 부분 문자열로 찾는다.
- 한국어 별칭은 뒤에 조사나 문장부호가 오는지 경계를 검사한다. 조사 목록에 단음절 `이`·`가`·`은`·`는`·`도`·`만`·`에`·`로` 와
  `에게`·`한테`·`처럼`·`씨`·`님` 등을 넣는다. 단음절 조사를 빠뜨리면 흔한 형태를 놓친다.
- 캐릭터 표는 Lua 인라인 테이블(`{ base, aliases, single_image, form_gate, note }`)이나 로어북 JSON 항목으로 둔다.
  로어북에 둘 때는 `keys` 를 비워 자동 활성되지 않게 하고, `getLoreBooksMain(id, 항목이름)` 으로 이름 정확 일치 조회한다.
  userdata 가 오면 `:await()` 후 decode 한다. 로어북 조회는 `id` 가 필요하므로 스크립트 최상위나 루프 안에서 하지 않는다.
- "한 명이라도 있으면 전체 목록 노출" 은 하지 않는다. 등장한 캐릭터만 프롬프트에 넣는다.

### 4.3 보조모델 프롬프트

```
# Insert image tags. Output ONLY a JSON array. No text. No explanation.
Format: [{"line":N,"asset":"Name-keyword"}]
Rules:
- Use ONLY the listed characters and listed keywords below.
- Output [] if no listed character appears in the narrative.
- NEVER tag the narrator or {{user}}.
- EVIDENCE-BASED: a character must be explicitly named (asset name or alias) in the narrative to be tagged.
- FORBIDDEN LINES: never target a line inside the status panel block. It is UI, not narrative.
  A name that appears only inside the panel is not evidence.
- MUST tag every visible listed character at least once when they appear.
- Non-sexual scenes: tag at first appearance, and again when emotion changes SIGNIFICANTLY. Do NOT tag minor variations.
- (NSFW 규칙: 메인 지시문과 같은 문구)
Characters:
- A (별칭)
- D (별칭) [SINGLE IMAGE — bare name only]
- G (별칭) [진행 게이트 변수 값에 따라 규칙을 바꿔 넣는다]
Keywords:
(키워드 로어북 본문)
Narrative:
1: …
2: …
# Reminder: Output ONLY a JSON array. If no listed character appears, output [].
```

- 줄번호를 붙여 보내고, 패치는 **해당 줄 앞에** 태그를 삽입한다. 서사 재작성은 시키지 않는다.
- "캐릭터당 최대 1개" 같은 과잉 제약보다, 적극적으로 붙이기 + 본문 등장 근거 + 미등장 금지 + 사소한 변화 무시의 균형이 결과가 좋다.
- 상태창 블록 내부 줄은 코드에서도 금지 목록으로 막는다. 여는 태그 줄 앞 삽입은 블록 밖이므로 허용한다.
- 추론 수준: 낮으면 빠르지만 지시 누락이 잦고, 중간이 기본값으로 무난하며, 다인원 NSFW 장면은 높게 둔다.

### 4.4 응답 처리

```lua
raw = strip_thinking(result.result)        -- <thinking>/<think*>/<reasoning>/<reflection>/<analysis> 제거.
                                           -- 전부 thinking 이면 마지막 닫는 태그 뒤 꼬리를 살린다
json_text = raw:match("%[%s*%{.-%}%s*%]") or raw:match("%[%s*%]")
patches = json.decode(json_text)           -- 실패하면: 응답이 이미지 태그를 포함하고 원문 길이의 60% 이상일 때만 통째 교체(약한 모델용 폴백)
new_text = apply_patches(content, patches) -- asset 값에서 태그 껍데기를 벗겨 정규화, 범위 밖 줄은 무시, 삽입 앞뒤에 빈 줄
```

`axLLM` 이 성공인데 결과가 비었거나 `[]` 이면 별도 분기로 사유를 남긴다(캐릭터 미감지, 응답 비어 있음, JSON 파싱 실패 등).

### 4.5 메인 모델 억제: 세 겹

보조 모드에서 메인 모델이 태그를 흉내 내지 않게 셋을 모두 둔다. 하나만 빠져도 새어 나온다.
1. 에셋 지시 자체를 `{{#when::asset_aux::visnot::1}}` 로 소거한다.
2. 억제 로어북 항목을 `constant` 로, `@@position pt_PI` 를 달아 지시 자리에 넣는다.
   ```
   @@position pt_PI
   {{#when::asset_aux::vis::1}}
   == ASSET DELEGATION ACTIVE ==
   A separate sub-model handles ALL image tagging for this response. Your job is ONLY narrative and dialogue.
   - Do NOT output image tags in any format, even if another instruction says to output them every turn.
   - Keep outputting the status panel normally.
   {{/when}}
   ```
3. `editprocess` 로 히스토리의 태그를 0개로 만든다(§3.5).

### 4.6 수동 재생성 버튼

옵션 패널에 `risu-btn="retag"` 버튼을 둔다. 순서:
1. 팁 메시지의 이미지 태그를 전부 떼어 `setChat` 한다.
2. 로딩 플래그를 켜고 드로어를 연 채 `reloadDisplay` 한다.
3. 같은 보조모델 흐름을 돌린다.
4. 대상 메시지를 다시 읽어 그대로일 때만 `setChat` 한다.
5. 플래그를 끄고 패널을 닫은 뒤 `reloadDisplay` 한다.

버튼을 보조 모드에서만 보일지, 메인 모드에서도(메인이 낸 태그를 보조모델로 다시 매기기) 보일지는 봇이 정한다.
어느 쪽이든 모드 값 `0` 을 "기능 꺼짐" 으로 취급하지 않는다.

### 4.7 보조모델이 에셋 대신 상태창을 맡는 구조

같은 틀로 보조모델에게 상태창 블록만 만들게 할 수도 있다(상태창 스킬 참고). 이때 옵션 UI 설명 문구가 실제로 보조모델이 맡는 범위와 같은지 확인한다.

---

## 5. 에셋 이름 설계 원칙

- 베이스 이름과 키워드 사이 구분자는 하나로 정하고, 베이스 이름 안에는 그 문자를 쓰지 않는다. 정규식이 첫 구분자에서 자른다.
- 키워드 안의 단어 구분 문자도 하나로 통일한다. 지시문·키워드 로어북·에셋 이름이 같은 표기를 쓴다.
- 변형 세트(의상·시대)는 모델에 노출하지 않는 이름 규칙으로 두고 정규식이 치환하게 할 수 있다(§3.2).
- 이중 외형은 별도 베이스 이름으로 만들고 모델에 노출한다.
- 동명 에셋을 내보낼 때 RisuAI 가 붙이는 중복 구분 접미(`이름.2` 등)는 참조하지 않는다. 있다면 정리 대상이다.
- 한 이름이 다른 이름의 접두가 되지 않게 짓는다(§3.3).
- 카드의 `prebuiltAssetCommand/Style/Exclude`, `sdData` 는 이 방식과 무관하다.

---

## 6. 새 봇에 적용하는 순서

1. 에셋 목록을 읽고 이름 체계(구분자, 키워드 어휘, NSFW 설계)를 확정한다. 캐릭터별 계층을 표로 만든다.
2. `post_history_instructions` 에 §2 지시문을 쓴다. 모드 변수 게이트로 감싸고 `{{position::PI}}` 를 둔다.
3. `defaultVariables` 에 모드 변수와 옵션 변수의 기본값을 둔다(옵션 UI 가 있을 때).
4. 정규식 4개를 §3.5 순서로 넣는다. 캡처는 봇의 구분자에 맞춘다. `image-container` CSS 를 backgroundHTML 에 넣는다.
5. 보조모델을 쓸 때: `lowLevelAccess` 켜기, 키워드 로어북(`keys` 비움) + 억제 로어북(`constant`, `@@position pt_PI`),
   Lua `onOutput` + 재생성 버튼, 옵션 패널의 모드 버튼.
6. 검사한다.
   - 지시문 목록 ⊆ 에셋 목록인지. 키워드마다 적어도 한 캐릭터의 에셋이 있는지.
   - 표기(공백·구분자·철자) 불일치가 없는지. 불일치는 에러 없이 베이스로 폴백되어 눈에 띄지 않는다.
   - 한 이름이 다른 이름의 접두가 아닌지.
   - 리퀘 제거 항목의 `type` 이 `editprocess` 인지.

---

## 7. 함정

1. **이름 불일치는 조용히 폴백된다.** 에러가 나지 않으므로 지시문·키워드 로어북·에셋 목록을 스크립트로 대조해야 발견된다.
2. **`contains` 는 부분 문자열 검사다.** 접두 관계 오탐이 가능하다.
3. **레이스**: axLLM 왕복 중 리롤/삭제되면 옛 메시지에 패치가 붙는다. 적용 직전에 한 건 다시 읽어 비교한다.
4. **UI 블록 안 삽입**: 금지 줄 목록 + 프롬프트의 FORBIDDEN LINES.
5. **억제 세 겹** 중 하나라도 빠지면 메인 모델이 태그를 흉내 낸다.
6. **thinking 뿐인 응답**: 꼬리 살리기 폴백이 없으면 빈 결과가 된다.
7. **`getLoreBooksMain` 이 userdata** 를 돌려줄 수 있다. `:await()` 후 decode 한다.
8. **존재하지 않는 마스터 토글 참조**: `onOutput` 이 조용히 종료된다.
9. **한국어 조사 경계** 목록에서 단음절 조사를 빠뜨리지 않는다.
10. **줄바꿈 세 겹**(지시문·정규식·패치)을 모두 두면 태그가 문장 중간에 끼지 않는다.
11. **`vis` 첫 인자에 식이나 `{{getvar}}` 를 넣지 않는다.** 변수 이름만 넣는다.
12. **`lowLevelAccess` 미설정**이면 `axLLM` 이 nil 이다.
13. 그룹 챗에서는 `{{assetlist}}` 가 비어 이미지가 전부 소멸한다.
