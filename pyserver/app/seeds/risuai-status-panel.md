<!-- risuhina-preset-scope-v1 -->
RisuAI는 별도의 프롬프트 제작자가 제공하는 프롬프트 프리셋에서 로어북 삽입 순서, 서술 시점, 대필 유무를 옵션으로 지정한다. 봇카드와 로어북에는 세계관·인물·사건·상태 및 봇 고유 시스템을 작성하고, 해당 서술 옵션은 프리셋 설정을 따른다. 프리셋의 제어 옵션은 제작 지식으로만 참고하고 봇카드·로어북 본문에 별도 규칙으로 기재하지 않는다.

RisuAI 봇의 **상태창** 레퍼런스. 모델이 매 응답 끝에 태그 블록(TAG OUTPUT)을 내고, 정규식이 HTML 로 바꾸고,
backgroundHTML 의 CSS 로 꾸미며, `{{position::PI}}` + `@@position pt_PI` 로 출력 지시가 무시되지 않게 하는 구조를
만들거나 고칠 때 읽어라. 데코레이터 일반론은 'RisuAI 로어북 구조', 훅 실행 순서는 'RisuAI 처리 순서' 스킬을 함께 본다.

> **태그 이름과 필드 구성은 봇마다 다르다.** 아래의 `<bot-panel>`, `<bot-scene>`, `.bot-` 클래스, 필드(시각·장소·등장인물·소지금 등)는
> 설명용 자리표시자다. 봇마다 고유 접두사와 필드를 정해 지시문·정규식·CSS 에서 일관되게 쓴다.

---

# RisuAI 상태창 작성법

## 0. 구조

```
[로어북 항목, constant]  "매 응답 끝에 <태그 블록> 출력" 지시   ── @@position pt_PI ──▶ 프롬프트 최말단(글로벌 노트 자리)
[모델 출력]              본문 + <태그 블록>
[정규식 editdisplay]     지우개(옛 턴 숨김) → 래퍼 → 컨테이너 → 필드별 변환
[정규식 editprocess]     옛 턴의 블록을 요청에서 제거(리퀘 제거). 최근 몇 턴은 남겨 "이전 값 읽고 갱신"
[backgroundHTML]         <style> 안의 .접두사-* 클래스
[Lua (선택)]             editOutput 에서 태그 파싱 → 변수·스냅샷, editDisplay 에서 CoT 방어·앵커 채우기
```

순수 정규식만으로도 상태창은 완성된다. Lua 는 값을 파싱해 다음 턴에 되먹이거나, 모델이 쓴 값을 교정하거나,
리롤에 안전한 상태 저장이 필요할 때만 더한다(§5).

---

## 1. 지시문 (TAG OUTPUT)

### 1.1 골격

로어북 항목 하나를 `constant: true` 로 두고, insertion_order 를 같은 슬롯의 다른 규칙보다 높게 잡는다.

```
@@position pt_PI
### OUTPUT FORMAT
Every response MUST end with the status panel. Never skip. Never omit any field.
Language: Korean. Tag names stay as written; only values follow the output language.

<bot-panel>
<bot-scene>{YYYY-MM-DD} {요일} {시간대} | {location}</bot-scene>
<bot-present>{characters in the scene}</bot-present>
<bot-money>{amount}</bot-money>
<bot-goal>{current objective}</bot-goal>
<bot-list>
[항목 | 현재 상황 | NEW or ONGOING or HOLD]
</bot-list>
</bot-panel>

== RULES ==
- ALL fields are MANDATORY, each on its own line. If unknown, use "-" as the value.
- <bot-scene>: 요일 = 월~일. 시간대 = 새벽 | 오전 | 오후 | 저녁 | 밤. Time advances realistically.
  The date MUST advance when the scene moves to the next day.
- <bot-money>: read the previous panel's value and apply this turn's transactions.
- <bot-list>: exactly ONE `|` between fields. The last field is exactly one of NEW ONGOING HOLD. Max 8 entries. Remove finished items silently.
- The panel is a meta-UI element, invisible to in-world characters. Characters never mention its values.

== OUTPUT ORDER ==
(narrative)

<bot-panel> … </bot-panel>

== EXAMPLES ==
(상황별 정답 예시 1~4개)
```

### 1.2 구성 요소와 이유

- **필수성 문구를 여러 번**: "MUST end with", "Never skip / Never omit", 필드별 MANDATORY. 하나만 쓰면 몇 턴 뒤 생략된다.
- **빈 값 규칙**: `-` 같은 자리표시 값. 없으면 모델이 모르는 필드를 통째로 뺀다. 첫 응답에서 초기화하는 봇이면 인사말 패널에 `?` 를 두고 "첫 응답에서 설정하고 이후엔 구체 값" 규칙을 준다.
- **값 어휘를 닫힌 집합으로**: 요일, 시간대, 진행 상태 등. 정규식 캡처와 CSS 클래스(`bot-item-$3`)가 그대로 맞물린다.
- **갱신 규칙**: "이전 패널 값을 읽고 갱신". 리퀘 제거에서 최근 턴의 패널을 남기는 이유다(§3.3).
- **OUTPUT ORDER 와 정답 예시**. 인사말(퍼스트 메시지)에도 실제 패널을 넣어 형식 앵커로 삼는다.
- **섹션 헤더는 `== SECTION ==`** 로 쓴다. 지시문 안에 `<SECTION>` 같은 꺾쇠 헤더를 쓰면 모델이 그 형식을 흉내 낸다. 꺾쇠는 출력할 태그 예시에만 쓴다.
- **오답 예시**는 짧게 두거나 쓰지 않는다. 모델이 오답 형식을 복사하는 경우가 있다. 쓰려면 정답 예시 뒤에 한두 개만.
- **은닉 규칙**: 상태창은 메타 UI 이므로 캐릭터가 그 수치를 대사로 말하지 않게 한다.
- **태그 이름은 번역하지 않는다**: 값만 출력 언어를 따르게 하면 언어를 바꿔도 정규식이 깨지지 않는다.

### 1.3 자주 쓰는 확장

- **모드 분기**: 한 항목 안에서 `{{#when::mode_var::visnot::X}}…{{/when}}` 로 모드별 형식을 바꾸거나, 보조모델이 상태창을 맡는 모드에서는
  `{{#when::status_aux::vis::1}} 상태창을 출력하지 마라 {{/when}}` 로 정반대 지시를 켠다.
- **화면 앵커와 데이터 태그 분리**: Lua 가 내용을 채울 빈 앵커(`<bot-anchor name="X"></bot-anchor>`)와 Lua 가 파싱할 데이터 태그(`[Data: …]`)를
  나누는 경우, "앵커는 비워 둔다, 데이터는 패널 밖 별도 줄" 을 CRITICAL 로 명시한다. 모델이 앵커 안에 데이터를 넣으면 파싱이 깨진다.
- **시스템만 읽는 블록**: 사용자에게 보이지 않을 내부 메모는 별도 태그(`<bot-secret>`)로 두고 Lua editOutput 에서 저장 전에 지운다.
- **조건부 태그**: 매 턴이 아니라 변화가 있을 때만 내는 값(호감도 증감 등)은 패널 **밖**의 별도 태그로, 부호가 붙은 델타로 받는다.
  "이번 장면에 영향받은 캐릭터만, 전체 목록 나열 금지" 를 명시한다. 절대값은 Lua 가 유지하고 `{{getvar::…}}` 로 프롬프트에 되돌려 준다.

### 1.4 태그 문법 선택

| 문법 | 예 | 값 제약 | 정규식 |
|---|---|---|---|
| XML 중첩 (권장) | `<bot-panel><bot-scene>…</bot-scene></bot-panel>` | 값에 `<` 만 금지 | 필드별 독립 정규식. 순서·누락에 관대 |
| XML + 파이프 | `<bot-stats>HP: 45/50 \| MP: 10/10</bot-stats>` | 값에 `\|` 금지 | 한 정규식이 여러 필드. 순서 고정 |
| `[Key: value]` 줄 | `[Date: 2004-04-09 (금, 오후)]` | 값에 `]` 금지 | `[^\]]+` 캡처 |
| 파이프 행 + 닫는 마커 | `[Row\|…]` … `[/Rows]` | `\|[]` 금지, 마커 필수 | 마커가 div 를 열고 닫는다(취약) |

XML 중첩 + 필드별 정규식이 가장 견고하다. 파이프·대괄호 문법을 쓰면 "값에 `|`, `[`, `]` 금지, 구분자는 정확히 하나" 규칙을 지시문 맨 위에 둔다.

---

## 2. 위치 지정: `{{position::PI}}` + `@@position pt_PI`

**원리**
1. 카드의 `post_history_instructions`(글로벌 노트 덮어쓰기)는 프리셋의 글로벌 노트 슬롯에 들어간다. 대부분의 프리셋에서 그 슬롯은 채팅 히스토리 뒤, 마지막 유저 메시지 근처다.
2. 그 본문에 `{{position::PI}}` 를 쓰면 그 자리에 `PI` 라는 위치 슬롯이 정의된다. 이름은 봇이 정한다.
3. 로어북 항목 본문 **첫 줄**에 `@@position pt_PI`(`pt_` + 슬롯 이름)를 쓰면, 그 항목은 일반 로어북 배치(설명 부근)에서 빠져 그 슬롯으로 간다.
   `@@position` 의 유효 인자는 `after_desc | before_desc | personality | scenario | pt_이름` 뿐이다.
4. 결과: 상태창 지시가 프롬프트 최말단에 놓여 무시되기 어렵다. 동시에 로어북 항목이므로 `{{#when}}` 게이트·insertion_order·constant 를 그대로 쓴다.
   글로벌 노트에 지시를 통째로 쓰는 것과 달리, 여러 항목으로 쪼개고 변수로 켜고 끌 수 있다.
5. 같은 슬롯 안의 순서는 insertion_order 로 정한다. 규칙 항목 < 상태창 출력 형식 < 모드별 지시처럼 층을 나누면 관리가 쉽다.

**글로벌 노트 덮어쓰기 예**
```
{{#when::asset_aux::visnot::1}}
### Image Commands
…
{{/when}}
{{position::PI}}
```
`{{position::PI}}` 를 뒤에 두면 에셋 지시 → 로어북 규칙(상태창) 순이 되고, 앞에 두면 그 반대가 된다.
모델에 가장 가까운 마지막 문단이 무엇이어야 하는지로 정한다. 상태창 형식을 맨 마지막에 두려면 뒤에 둔다.

**`@@depth 0` 과의 차이**: `@@depth 0` 은 히스토리의 마지막 메시지 직후에 꽂힌다(프리셋 구조와 무관). `pt_PI` 는 프리셋이 글로벌 노트를
어디에 두느냐를 따른다. 글로벌 노트가 히스토리 뒤에 있는 프리셋이면 거의 같은 자리다. 프리셋과 무관하게 확실히 끝에 두려면 `@@depth 0`,
프리셋의 구조를 존중하려면 `pt_PI` 를 쓴다.

**위치 이중화**: 핵심 필드 규칙을 다른 항목(`@@depth 0`, `@@role system`)이나 카드 설명의 한 줄 재언급으로 한 번 더 반복하면 누락이 줄어든다.

---

## 3. 정규식 파이프라인

### 3.1 지우개 수식

```
{{#if {{greater_equal::{{chat_index}}::{{? {{lastmessageid}}-2}}}}}}$&{{/if}}
```
- `{{chat_index}}` = 지금 처리 중인 메시지 인덱스, `{{lastmessageid}}` = 마지막 메시지 인덱스.
- `{{? 식}}` 은 **공백** 문법의 수식 평가기다(`::` 아님).
- 의미: 마지막 3개 메시지에서만 블록을 남기고 그 앞은 빈 문자열로 만든다. 남길 개수는 `-2` 로 조절한다.
  - editdisplay 에 넣으면 화면에서 옛 패널이 사라진다.
  - editprocess 에 넣으면 요청에서 옛 패널이 빠진다. 최근 1~2턴은 남아 모델이 "이전 값을 읽고 갱신" 할 수 있다.
- 마지막 1개만 남기려면 `{{equal::{{chat_index}}::{{lastmessageid}}}}`.
- `{{#if}}` 는 deprecated 지만 동작한다. `{{#when::{{greater_equal::…}}}}$&{{/when}}` 도 된다. `vis` 의 첫 인자에 식을 넣는 형태는 쓰지 않는다.

### 3.2 순서: 지우개 → 래퍼 → 컨테이너 → 필드 → 하위 항목

```
=== 패널 지우개 ===      editdisplay  in: <bot-panel>([\s\S]*?)<\/bot-panel>   out: (지우개 수식 $&)
=== 패널 래퍼 ===        editdisplay  in: 동일                                 out: <div class="bot-panel">$1</div>
=== 장면 필드 ===        editdisplay  in: <bot-scene>([\s\S]*?)<\/bot-scene>   out: <div class="bot-row"><span class="bot-label">🕐 장면</span><span class="bot-val">$1</span></div>
=== 소지금 필드 ===      editdisplay  in: <bot-money>([\s\S]*?)<\/bot-money>   out: <div class="bot-row"><span class="bot-label">💰 소지금</span><span class="bot-val bot-money">$1</span></div>
=== 목록 블록 ===        editdisplay  in: <bot-list>([\s\S]*?)<\/bot-list>     out: <details class="bot-fold"><summary class="bot-fold-sum">📌 목록</summary><div class="bot-fold-body">$1</div></details>
=== 목록 항목 ===        editdisplay  in: \[([^|\]]+)\|\s*([^|\]]+)\|\s*([A-Z]+)\]   out: <div class="bot-item bot-item-$3"><b>$1</b> $2 <span class="bot-badge">$3</span></div>
=== 패널 리퀘 제거 ===   editprocess  in: <bot-panel>([\s\S]*?)<\/bot-panel>   out: (지우개 수식 $&)
ableFlag: false (전부)
```

- 정규식은 위에서 아래로 차례로 적용된다. 지우개가 먼저 돌아 옛 턴에서 블록을 없애야 뒤의 변환이 헛돌지 않는다. 바깥 태그를 먼저 div 로 바꾸고 안쪽은 다음 스크립트가 잡는다.
- 블록 캡처는 항상 lazy `[\s\S]*?` 로 한다. greedy 면 화면에 남은 여러 턴의 패널이 하나로 합쳐진다. 한 줄 태그는 `[^<]*` 로 잡아 다른 태그를 삼키지 않게 한다.
- 속성이 붙은 특수형(`<bot-sys by="…">`)은 일반형(`<bot-sys>`)보다 **먼저** 둔다. 일반형이 먼저면 특수형을 삼킨다.
- 상태값을 클래스명(`bot-item-$3`)이나 `data-st="$3"` 속성으로 넘기면 CSS 만으로 색을 정할 수 있다.
- `ableFlag: false` = "flag 옵션 미사용(기본 g)". 비활성이 아니다.
- `out` 안의 CBS 는 다시 파싱된다(지우개가 되는 이유). `$n` 은 줄바꿈으로 치환되므로 캡처 번호로 쓰지 않는다.
- **분할 래핑을 피한다**: 한 정규식이 div 를 열고 다른 정규식(다음 필드나 닫는 마커)이 닫는 구조는, 태그 하나가 빠지면 HTML 이 안 닫혀 이후 본문까지 패널 안으로 들어간다. 필드마다 자기완결 정규식으로 쓴다.
- **블록 전체를 한 정규식으로** 잡으면 필드 순서가 다르거나 하나라도 빠질 때 매치에 실패해 원문 태그가 화면에 그대로 보인다. 그렇게 하려면 지시문의 OUTPUT ORDER 로 순서를 강제해야 한다.

### 3.3 리퀘 제거(editprocess)를 두지 말아야 할 때

editprocess 는 Lua `editRequest` 보다 **먼저** 돈다. Lua 가 히스토리 속 상태창을 읽어야 하면(예: 메시지를 날짜별로 묶어 요약하는 경우)
editprocess 로 지우면 안 된다. 화면 정리는 editdisplay 로만 한다.

### 3.4 Lua 미작동 워치독

RisuAI 는 Lua editOutput 의 오류를 조용히 삼키고 원문을 그대로 저장한다. Lua 가 상태를 관리하는 봇이면, editOutput 이 성공할 때
저장본 끝에 표식 태그(`<bot-uid>N</bot-uid>`)를 붙이고, 마지막 메시지에 그 표식이 없으면 경고를 띄운다.

```
=== 백엔드 워치독 ===   editdisplay
in:  </bot-panel>(?![\s\S]*<bot-uid>)
out: </bot-panel>{{#if {{greater_equal::{{chat_index}}::1}}}}{{#if {{equal::{{chat_index}}::{{lastmessageid}}}}}}<div class="bot-dead-warn">⚠ 시스템 스크립트 미작동 — 이 턴의 상태 변경이 기록되지 않았습니다. RisuAI 를 다시 시작하면 다음 턴에 복구됩니다.</div>{{/if}}{{/if}}
```
표식 태그는 별도 정규식으로 화면에서 숨긴다. 다음 턴에는 표식 없는 턴의 값을 거슬러 반영(backfill)한다.
이 장치는 Lua 미작동을 잡는 것이지 **모델의 출력 누락**을 잡는 것이 아니다. 모델 누락 대책은 §1 의 지시 강화와 §2 의 위치다.

---

## 4. CSS (backgroundHTML `<style>` 안)

### 4.1 최소 구성

```css
.bot-panel { margin: 20px auto; max-width: 480px; display: flex; flex-direction: column; border-radius: 12px; overflow: hidden;
  border: 1px solid #2a3a4a; background: linear-gradient(145deg, #0f1923 0%, #151e2c 100%);
  padding: 16px 20px; font-family: 'Pretendard', 'Noto Sans KR', -apple-system, sans-serif; font-size: 13px; line-height: 1.7; color: #b0bec5; }
.bot-row { display: flex; gap: 10px; margin: 5px 0; align-items: baseline; }
.bot-label { color: #6b7d8e; font-size: 12px; min-width: 110px; flex-shrink: 0; }
.bot-val { color: #cfd8dc; font-size: 12.5px; }
.bot-money { color: #66bb6a; font-weight: 600; }
@media (max-width: 600px) {
  .bot-panel { margin: 12px 0; border-radius: 8px; padding-left: 14px; padding-right: 14px; }
  .bot-label { min-width: 90px; }
  .bot-row { flex-direction: column; gap: 2px; }   /* 좁은 화면에서는 라벨/값을 세로로 */
}
```

### 4.2 접기: `<details>`

```css
.bot-fold-sum { padding: 10px 0; cursor: pointer; user-select: none; list-style: none; display: flex; align-items: center; gap: 8px; }
.bot-fold-sum::-webkit-details-marker { display: none; }
.bot-fold-sum::before { content: '▶'; font-size: 9px; transition: transform .25s ease; display: inline-block; }
.bot-fold[open] > .bot-fold-sum::before { transform: rotate(90deg); }
```
체크박스 + `<label for>` 로 접기를 만들면, 화면에 여러 턴의 패널이 남아 있을 때 같은 id 가 여러 개 생겨 토글이 엉뚱한 항목을 연다.
`<details>` 는 id 가 필요 없어 안전하다.

### 4.3 스탯 그리드

```css
.bot-sec { padding: 10px 0; border-bottom: 1px solid rgba(196,160,96,.1); }  .bot-sec:last-child { border-bottom: none; }
.bot-sec-title { color: #6b7d8e; font-size: 10px; font-weight: 700; letter-spacing: .08em; }
.bot-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 16px; }
.bot-stat { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 4px; }
.bot-stat-l { color: #6b7d8e; font-size: 11px; font-weight: 600; }  .bot-stat-v { color: #cfd8dc; text-align: right; }
.bot-dead-warn { margin: 8px 0; padding: 8px 12px; border: 1px solid rgba(224,90,70,.45); border-radius: 6px;
  background: rgba(224,90,70,.12); color: #e05a46; font-size: 11px; font-weight: 600; }
```

### 4.4 관례
- 클래스에 봇 고유 접두사를 붙인다. `all: initial` 리셋은 버튼형 독립 UI 에만 쓰고, 정보 패널은 채팅 스타일을 상속하게 둔다.
- 폰트를 명시해 테마 폰트 상속을 피한다.
- `max-width: 480px; margin: auto` 면 모바일 규칙이 거의 필요 없다. 라벨/값 2열만 좁은 화면에서 세로로 바꾼다.
- CSS 는 `</style>` 안에 둔다. 밖에 두면 적용되지 않는다.

---

## 5. Lua (선택)

1. **파싱해서 변수로**: `editOutput` 에서 태그를 읽어 chatvar 에 저장하고, 다음 턴 프롬프트에 `{{getvar::}}` 나 editRequest 삽입으로 되먹인다.
   - CoT/thinking 안에서 태그를 언급한 것을 잡지 않도록: thought 범위를 제외하고, **마지막 유효 블록**만 취하고, 내용이 너무 짧으면(언급일 뿐) 건너뛴다.
   - editDisplay 에서 thought 내부의 `<`, `>`, `[`, `]` 를 HTML 엔티티로 바꾸면 뒤이어 도는 **정규식**도 그 안의 태그를 잡지 못한다. Lua 편집 훅이 같은 단계 정규식보다 먼저 돈다.
   - 표기 변형(대소문자·공백)을 너그럽게 받는다.
2. **모델이 쓴 값 교정**: 다른 값에서 계산되는 값(레벨 등)은 Lua 가 다시 계산해 덮어쓴다. 지시문에는 "계산하지 말고 이전 값을 그대로 옮겨 적어라, 시스템이 고친다" 고 쓴다.
3. **리롤·삭제에 안전한 상태 저장**: 누적 변수는 리롤 때 chatvar 롤백으로 어긋난다. 저장 메시지 본문에 표식(`<bot-uid>N</bot-uid>`)을 박고,
   uid 별 스냅샷(`backup[uid]`)에 절대값을 둔다. 리롤로 본문이 바뀌면 그 uid 의 스냅샷은 자연히 버려진다.
   삭제 후 리롤하면 카운터가 되돌아가 이미 uid 가 붙은 본문에 editOutput 이 다시 도므로, 기존 uid 를 먼저 지우고 새로 붙인다.
   - editOutput 전체를 `pcall` 로 감싸고 실패 시 `alertError` 로 알린다.
4. **보조모델이 상태창을 만들 때**: 메인 지시문을 "출력하지 마라" 로 뒤집고, `onOutput` 에서 보조모델이 만든 블록을 `setChat` 으로 저장 메시지에 덧붙인다. 화면 정규식은 그대로 동작한다.
5. **editdisplay 캐시**: RisuAI 스크립트 캐시 키에 chatvar 값이 들어가지 않는다. 표시 정규식 `out` 에서 `{{getvar}}`/`{{#when::var}}` 를 쓰면
   변수만 바뀌었을 때 화면이 안 바뀔 수 있다. Lua editDisplay 끝에 `<!--bot:변수값-->` 주석을 붙여 캐시를 깬다.

---

## 6. 새 봇에 적용하는 순서

1. 필드 목록과 각 필드의 값 어휘를 표로 정하고, 봇 고유 태그 접두사를 정한다. 문법은 XML 중첩을 기본으로 한다(§1.4).
2. 로어북 항목 1개: `@@position pt_PI`, `constant: true`, 높은 insertion_order, §1.1 골격. 인사말에 초기 패널을 넣는다.
3. 글로벌 노트 덮어쓰기에 `{{position::PI}}` 를 넣는다. 다른 지시(에셋 등)와의 앞뒤를 정한다(§2).
4. 정규식: 지우개 → 래퍼 → 필드별 → 하위 항목 → 리퀘 제거(editprocess). 전부 lazy 캡처.
5. backgroundHTML 에 §4 CSS. 접기는 `<details>`.
6. 필요하면 Lua(§5)와 워치독(§3.4).
7. 확인한다.
   - 옛 턴에서 패널이 사라지는지, 최근 턴의 요청에는 패널이 남는지.
   - 필드 하나가 빠졌을 때 HTML 이 깨지지 않는지.
   - thinking 안에 적힌 태그가 파싱되거나 렌더되지 않는지.

---

## 7. 함정

1. 모델이 **앵커 안에 데이터**를 넣는다 → 앵커/데이터 분리 규칙을 CRITICAL 로.
2. 지시문의 **꺾쇠 섹션 헤더**를 모델이 흉내 낸다 → `== SECTION ==`.
3. **오답 예시**를 모델이 복사한다 → 짧게, 정답 뒤에만, 또는 생략.
4. **CoT 안의 태그**가 파싱·렌더된다 → thought 범위 제외 + 마지막 블록 + 엔티티 이스케이프.
5. **editdisplay 캐시**가 변수 변화를 모른다 → 캐시 버스터 주석.
6. **Lua editOutput 실패가 조용하다** → 표식 + 워치독 + backfill + `pcall`/`alertError`.
7. **editprocess 가 editRequest 보다 먼저 돈다** → Lua 가 히스토리를 읽으면 리퀘 제거 금지.
8. **리롤 시 chatvar 롤백** → 메시지 본문 표식을 키로 한 스냅샷.
9. **greedy 캡처** → 여러 턴의 패널이 합쳐진다. lazy + `[^<]*`.
10. **파이프·대괄호 값 제약**을 지시문에 명시한다.
11. **닫는 마커·분할 래핑 의존** → 필드별 자기완결 정규식.
12. **체크박스 id 충돌** → `<details>`.
13. `{{#if}}` 는 deprecated, `{{? }}` 는 공백 문법, `vis` 첫 인자는 변수 이름.
14. 태그 이름은 고정, 값만 출력 언어를 따른다.
15. `@@position` 데코레이터는 로어북 본문 **맨 위** 한 줄에 둔다. 본문 텍스트 뒤에 있으면 무시된다.
