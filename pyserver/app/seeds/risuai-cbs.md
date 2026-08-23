RisuAI CBS `{{tag}}` 문법 레퍼런스. 봇 카드·로어북·정규식·시스템 프롬프트의
텍스트 필드에서 동작하는 템플릿 문법이다. 전사에서 CBS 태그를 보거나 써야 할 때 읽어라.

---

# RisuAI CBS (Character Bot Script) 문법 레퍼런스

CBS는 `{{tag}}` 형식의 템플릿 언어로, description · first_mes · lorebook content · regex · system prompt 등 거의 모든 텍스트 필드에서 동작한다.

---

## 1. 캐릭터 / 유저 태그

| 태그 | 설명 |
|------|------|
| `{{char}}` / `{{bot}}` | 캐릭터 이름 |
| `{{user}}` | 유저 이름 |
| `{{persona}}` / `{{userpersona}}` | 유저 페르소나 설명 |
| `{{description}}` / `{{chardesc}}` | 캐릭터 description 필드 |
| `{{personality}}` / `{{charpersona}}` | 캐릭터 personality 필드 |
| `{{scenario}}` | 캐릭터 scenario 필드 |
| `{{exampledialogue}}` | 예시 대화 필드 |

## 2. 시스템 / 프롬프트 태그

| 태그 | 설명 |
|------|------|
| `{{mainprompt}}` / `{{systemprompt}}` | 메인 시스템 프롬프트 |
| `{{jb}}` / `{{jailbreak}}` | 제일브레이크 프롬프트 |
| `{{globalnote}}` / `{{ujb}}` | 글로벌 노트 |
| `{{authornote}}` | 저자 노트 |
| `{{lorebook}}` / `{{worldinfo}}` | 활성 로어북 JSON 배열 |

## 3. 채팅 히스토리 태그

| 태그 | 설명 |
|------|------|
| `{{previouscharchat}}` / `{{lastcharmessage}}` | 마지막 캐릭터 메시지 |
| `{{previoususerchat}}` / `{{lastusermessage}}` | 마지막 유저 메시지 |
| `{{lastmessage}}` | 마지막 메시지 (역할 무관) |
| `{{lastmessageid}}` | 마지막 메시지 인덱스 |
| `{{history}}` / `{{history::role}}` | 전체 채팅 히스토리 (role 접두어 선택) |
| `{{previouschatlog::INDEX}}` | 특정 인덱스 메시지 |
| `{{userhistory}}` | 유저 메시지 JSON 배열 |
| `{{charhistory}}` | 캐릭터 메시지 JSON 배열 |

## 4. 날짜 / 시간

| 태그 | 설명 |
|------|------|
| `{{time}}` | 현재 로컬 시간 (h:m:s) |
| `{{date}}` | 현재 날짜 |
| `{{date::FORMAT}}` | 포맷 지정 (YYYY, MM, DD, HH, mm, ss, dddd 등) |
| `{{date::FORMAT::timestamp}}` | 특정 타임스탬프 포맷 |
| `{{isotime}}` / `{{isodate}}` | UTC 시간/날짜 |
| `{{unixtime}}` | 유닉스 타임스탬프 (초) |
| `{{messagetime}}` | 현재 메시지 전송 시각 |
| `{{messagedate}}` | 현재 메시지 전송 날짜 |
| `{{idleduration}}` | 마지막 메시지 이후 경과 시간 |
| `{{messageidleduration}}` | 현재-이전 유저 메시지 간격 |

## 5. 모델 / 상태 태그

| 태그 | 설명 |
|------|------|
| `{{model}}` | 현재 AI 모델 ID |
| `{{axmodel}}` | 보조 모델 ID |
| `{{role}}` | 현재 메시지 역할 (user/char/system) |
| `{{chatindex}}` | 현재 메시지 인덱스 |
| `{{isfirstmsg}}` | 첫 메시지 여부 ("1"/"0") |
| `{{maxcontext}}` | 최대 컨텍스트 길이 |
| `{{jbtoggled}}` | JB 활성화 여부 ("1"/"0") |
| `{{metadata::KEY}}` | 시스템 메타데이터 |

**metadata 키**: `mobile`, `local`, `version`, `majorversion`, `language`, `browserlanguage`, `modelshortname`, `modelname`, `modelformat`, `modelprovider`, `modeltokenizer`, `maxcontext`

## 6. 에셋 / 미디어 태그

| 태그 | 설명 |
|------|------|
| `{{img::이름}}` / `{{image::이름}}` | 이미지 표시 |
| `{{emotion::이름}}` | 감정 이미지 표시 |
| `{{asset::이름}}` | 자동 감지 (이미지/비디오) |
| `{{video::이름}}` | 비디오 (컨트롤 포함) |
| `{{video-img::이름}}` | 비디오 (자동재생, 음소거, 루프) |
| `{{audio::이름}}` | 오디오 (컨트롤 포함) |
| `{{bgm::이름}}` | 배경음악 |
| `{{bg::이름}}` | 배경 이미지 (전체화면) |
| `{{raw::이름}}` / `{{path::이름}}` | 에셋 파일 경로 반환 |
| `{{source::user}}` / `{{source::char}}` | 프로필 이미지 경로 |
| `{{inlay::이름}}` | 인레이 (모델 미전송) |
| `{{assetlist}}` | 에셋 이름 JSON 배열 |
| `{{emotionlist}}` | 감정 이름 JSON 배열 |

---

## 7. 변수 조작

### 읽기
| 태그 | 설명 |
|------|------|
| `{{getvar::변수명}}` | 채팅 변수 읽기 (영구) |
| `{{getglobalvar::변수명}}` | 글로벌 변수 읽기 |
| `{{tempvar::변수명}}` / `{{gettempvar::변수명}}` | 임시 변수 읽기 (세션 한정) |

### 쓰기 (runVar=true 컨텍스트에서만 실행)
| 태그 | 설명 |
|------|------|
| `{{setvar::변수명::값}}` | 채팅 변수 설정 |
| `{{addvar::변수명::숫자}}` | 변수에 숫자 더하기 |
| `{{setdefaultvar::변수명::기본값}}` | 비어있을 때만 설정 |
| `{{settempvar::변수명::값}}` | 임시 변수 설정 |

> **주의**: setvar, addvar, setdefaultvar는 `runVar=true` 컨텍스트(트리거, 스크립트 실행 시)에서만 동작. 일반 description 렌더링 중에는 무시됨.

---

## 8. 조건문 (#when)

### 기본 구문
```
{{#when::조건}}
  내용
{{/when}}
```

### else 절
```
{{#when::조건}}
  참일 때
{{:else}}
  거짓일 때
{{/when}}
```

### 비교 연산자
```
{{#when::A::>::B}}       숫자 크다
{{#when::A::<::B}}       숫자 작다
{{#when::A::>=::B}}      크거나 같다
{{#when::A::<=::B}}      작거나 같다
{{#when::A::is::B}}      문자열 같다
{{#when::A::isnot::B}}   문자열 다르다
```

### 논리 연산자
```
{{#when::A::and::B}}     둘 다 참
{{#when::A::or::B}}      하나라도 참
{{#when::not::A}}        부정
```

### 변수 연산자
```
{{#when::var::변수명}}           변수가 truthy
{{#when::A::vis::B}}             변수 A == 리터럴 B
{{#when::A::visnot::B}}          변수 A != 리터럴 B
{{#when::toggle::이름}}          토글 활성화 여부
{{#when::A::tis::B}}             토글 A == B
```

### 공백 제어
```
{{#when::keep::조건}}    공백 보존
{{#when::legacy::조건}}  레거시 트리밍 (구 #if 방식)
```

> 연산 순서: **오른쪽→왼쪽** 평가. 중첩 가능.

---

## 9. 반복문 (#each)

```
{{#each [1,2,3] as item}}
  {{slot::item}}
{{/each}}
```

```
{{#each {{getvar::배열}} as item}}
  - {{slot::item}}
{{/each}}
```

- `{{#each::keep ...}}` — 공백 보존
- JSON 배열, 2D 배열 지원
- 중첩 가능
- 빈 배열이면 출력 없음

---

## 10. 함수 정의 및 호출

```
{{#func 함수이름 arg0 arg1}}
  본문 — {{arg::0}}, {{arg::1}} 으로 인자 접근
{{/func}}

{{call::함수이름::인자0::인자1}}
```

---

## 11. 문자열 조작

| 함수 | 문법 | 결과 |
|------|------|------|
| `replace` | `{{replace::텍스트::찾기::바꿈}}` | 전체 치환 |
| `split` | `{{split::텍스트::구분자}}` | JSON 배열 |
| `join` | `{{join::배열::구분자}}` | 문자열 결합 |
| `trim` | `{{trim::텍스트}}` | 앞뒤 공백 제거 |
| `length` | `{{length::텍스트}}` | 글자 수 |
| `contains` | `{{contains::텍스트::부분}}` | "1"/"0" |
| `startswith` | `{{startswith::텍스트::접두}}` | "1"/"0" |
| `endswith` | `{{endswith::텍스트::접미}}` | "1"/"0" |
| `lower` | `{{lower::텍스트}}` | 소문자 |
| `upper` | `{{upper::텍스트}}` | 대문자 |
| `capitalize` | `{{capitalize::텍스트}}` | 첫 글자 대문자 |
| `reverse` | `{{reverse::텍스트}}` | 문자열 뒤집기 |
| `tonumber` | `{{tonumber::텍스트}}` | 숫자만 추출 |

## 12. 수학 연산

| 함수 | 문법 | 결과 |
|------|------|------|
| `calc` | `{{calc::2+3*4}}` | 수식 평가 (14) |
| `?` | `{{? 1+2}}` | 수식 단축 |
| `round` | `{{round::3.7}}` | 반올림 (4) |
| `floor` | `{{floor::3.9}}` | 내림 (3) |
| `ceil` | `{{ceil::3.1}}` | 올림 (4) |
| `abs` | `{{abs::-5}}` | 절대값 (5) |
| `remaind` | `{{remaind::10::3}}` | 나머지 (1) |
| `pow` | `{{pow::2::3}}` | 거듭제곱 (8) |
| `fixnum` | `{{fixnum::3.14159::2}}` | 소수점 N자리 (3.14) |

## 13. 랜덤

| 함수 | 문법 | 설명 |
|------|------|------|
| `random` | `{{random}}` | 0~1 랜덤 |
| `random` | `{{random::a,b,c}}` | 목록에서 랜덤 선택 |
| `pick` | `{{pick::a,b,c}}` | 해시 기반 (채팅별 고정) |
| `randint` | `{{randint::1::10}}` | 정수 랜덤 (양끝 포함) |
| `dice` / `roll` | `{{dice::2d6}}` | 주사위 (2d6, 3d20 등) |
| `hash` | `{{hash::입력}}` | 결정론적 7자리 해시 |

---

## 14. 배열 / 객체 조작

### 배열
| 함수 | 문법 |
|------|------|
| `makearray` / `a` | `{{makearray::a::b::c}}` → `["a","b","c"]` |
| `arraylength` | `{{arraylength::배열}}` |
| `arrayelement` | `{{arrayelement::배열::인덱스}}` |
| `arraypush` | `{{arraypush::배열::항목}}` |
| `arraypop` | `{{arraypop::배열}}` |
| `arrayshift` | `{{arrayshift::배열}}` |
| `arraysplice` | `{{arraysplice::배열::시작::삭제수::새항목}}` |
| `filter` | `{{filter::배열::타입}}` — all/nonempty/unique |
| `range` | `{{range::[5]}}` → [0,1,2,3,4] |

### 객체
| 함수 | 문법 |
|------|------|
| `makedict` / `d` / `o` | `{{makedict::key=value::k2=v2}}` |
| `dictelement` | `{{dictelement::객체::키}}` |
| `element` / `ele` | `{{element::JSON::키1::키2}}` — 중첩 접근 |

### 집계
| 함수 | 문법 |
|------|------|
| `min` / `max` / `sum` / `average` | `{{sum::1::2::3}}` → 6 |
| `all` | `{{all::1::1::0}}` → "0" |
| `any` | `{{any::0::1::0}}` → "1" |

---

## 15. 비교 함수

| 함수 | 문법 | 반환 |
|------|------|------|
| `equal` | `{{equal::a::b}}` | "1"/"0" |
| `notequal` | `{{notequal::a::b}}` | "1"/"0" |
| `greater` | `{{greater::10::5}}` | "1"/"0" |
| `less` | `{{less::5::10}}` | "1"/"0" |
| `and` | `{{and::1::1}}` | "1"/"0" |
| `or` | `{{or::1::0}}` | "1"/"0" |
| `not` | `{{not::1}}` | "0" |

---

## 16. 이스케이프 / 특수 태그

| 태그 | 출력 |
|------|------|
| `{{bo}}` | `{{` |
| `{{bc}}` | `}}` |
| `{{decbo}}` | `{` |
| `{{decbc}}` | `}` |
| `{{dec}}` / `{{:}}` | `:` |
| `{{br}}` / `{{newline}}` | 줄바꿈 |
| `{{cbr}}` / `{{cbr::N}}` | 이스케이프된 줄바꿈 (\\n) × N |
| `{{blank}}` / `{{none}}` | 빈 문자열 |
| `{{//  주석}}` | 숨김 (출력 안 됨) |
| `{{comment::텍스트}}` | 표시되는 주석 |
| `{{hiddenkey::값}}` | 로어 활성화용 숨김 키 (모델 미전송) |
| `{{return::값}}` | 스크립트 종료 + 값 반환 |

### 이스케이프 블록
```
{{#puredisplay}}
  {{이 안의 CBS}}는 파싱되지 않음
{{/puredisplay}}

{{#escape}}
  {중괄호}와 (괄호)가 이스케이프됨
{{/escape}}

{{#escape::keep}}
  공백 보존 모드
{{/escape}}
```

## 17. 텍스트 포맷팅

| 태그 | 설명 |
|------|------|
| `{{tex::E=mc^2}}` | LaTeX/KaTeX 수식 렌더링 |
| `{{ruby::漢字::かんじ}}` | 후리가나 |
| `{{codeblock::코드}}` | 코드 블록 |
| `{{codeblock::언어::코드}}` | 언어 지정 코드 블록 |
| `{{bkspc}}` | 마지막 단어 삭제 |
| `{{erase}}` | 마지막 문장 삭제 |

## 18. 인코딩 / 암호화

| 태그 | 설명 |
|------|------|
| `{{unicodeencode::A}}` | 유니코드 코드포인트 |
| `{{unicodedecode::65}}` | 코드포인트→문자 |
| `{{fromhex::FF}}` | 16진수→10진수 |
| `{{tohex::255}}` | 10진수→16진수 |
| `{{xor::텍스트}}` | XOR 암호화+base64 |
| `{{xordecrypt::base64}}` | XOR 복호화 |
| `{{crypt::텍스트::시프트}}` | 시저 암호 (기본 시프트: 32768) |

## 19. 버튼

```
{{button::버튼텍스트::트리거이름}}
```
- 클릭 시 해당 이름의 manual 트리거 실행
- `{{trigger_id}}` 로 트리거된 요소의 risu-id 접근 가능

---

## 컨텍스트별 동작 차이

| 컨텍스트 | runVar | 특이사항 |
|----------|--------|---------|
| description / personality / scenario | false | setvar 등 무시됨 |
| first_mes / alternate_greetings | false | `{{isfirstmsg}}` = "1" |
| lorebook content | false | 표시 전용 |
| regex replacement | true | 변수 조작 가능 |
| trigger script (CBS) | true | 변수 조작 가능 |
| display 렌더링 | false | HTML 변환 활성 (img, button 등) |
