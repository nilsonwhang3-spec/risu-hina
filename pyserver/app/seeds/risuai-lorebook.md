RisuAI 로어북의 구조와 데코레이터 레퍼런스. 챗 로어북 항목을 만들거나 고칠 때,
특히 발동 조건(key·데코레이터·삽입 위치)을 정할 때 읽어라.

---

# RisuAI 로어북 시스템 레퍼런스

---

## 1. 로어북 항목 스키마 (loreBook)

```typescript
interface loreBook {
    key: string             // 매칭 키 (쉼표 구분)
    secondkey: string       // 보조 키 (selective 모드용)
    insertorder: number     // 삽입 순서/우선도
    comment: string         // 항목 이름 (UI 표시용)
    content: string         // 본문 (@@데코레이터 포함 가능)
    mode: 'normal' | 'constant' | 'multiple' | 'child' | 'folder'
    alwaysActive: boolean   // true면 키 매칭 무시, 항상 활성
    selective: boolean      // true면 primary + secondary 키 모두 매칭 필요
    extentions?: {
        risu_case_sensitive: boolean
    }
    useRegex?: boolean      // 키를 정규식으로 처리
    bookVersion?: number    // 스키마 버전 (현재 2)
    id?: string             // 고유 식별자 (UUID)
    folder?: string         // 폴더 그룹 ID
    name?: string           // 항목 이름 (comment 대체)
    enabled?: boolean       // 활성화 여부
    insertion_order?: number // V2 호환 필드
    constant?: boolean      // V2 호환 (alwaysActive)
    case_sensitive?: boolean // 대소문자 구분
}
```

### mode 값 설명

| mode | 설명 |
|------|------|
| `normal` | 일반 항목 — 키 매칭으로 활성화 |
| `constant` | 항상 포함 (키 무시) |
| `multiple` | 모든 키가 동시에 매칭되어야 활성화 |
| `child` | 같은 id의 이전 항목 속성 상속 |
| `folder` | 폴더 (조직용, 프롬프트에 주입되지 않음) |

---

## 2. character_book 최상위 구조

```typescript
interface CharacterBook {
    name?: string
    description?: string
    scan_depth?: number           // 검색할 메시지 수 (기본: loreSettings 값)
    token_budget?: number         // 전체 로어북 토큰 한도
    recursive_scanning?: boolean  // 재귀 매칭 활성화
    extensions: {
        risu_fullWordMatching?: boolean  // 전역 단어 단위 매칭
    }
    entries: loreBook[]           // 항목 배열
}
```

---

## 3. 키 매칭 로직

### 매칭 흐름
```
1. 키 준비: 쉼표로 분리, 공백 trim, 빈 문자열 제거
2. 텍스트 전처리: {{//...}} 주석 제거, 소문자 변환
3. 매칭 실행 (세 가지 모드 중 하나):
   A) 정규식 매칭   — useRegex=true, 키 형식: /pattern/flags
   B) 단어 단위 매칭 — @@match_full_word 또는 전역 설정
   C) 부분 문자열 매칭 — 기본 모드 (공백 제거 후 비교)
4. selective 모드: primary 키 AND secondary 키 모두 매칭 필요
```

### 검색 범위
- `scan_depth` 만큼의 최근 메시지 검색
- `@@scan_depth N` 데코레이터로 항목별 오버라이드 가능
- `recursive_scanning` 활성 시 이미 활성화된 항목의 content도 검색 대상에 포함

### selective 모드
```
selective = true  →  primary 키 매칭 AND secondary 키 매칭
selective = false →  primary 키 매칭만으로 활성화
```

---

## 4. @@데코레이터

content 필드 안에 `@@데코레이터` 를 줄 단위로 작성한다. 본문 앞에 위치.

### 활성화 제어

| 데코레이터 | 설명 |
|-----------|------|
| `@@activate` | 강제 활성화 (키 매칭 무시) |
| `@@dont_activate` | 강제 비활성화 |
| `@@keep_activate_after_match` | 한 번 매칭되면 이후 항상 활성 (채팅 변수에 저장) |
| `@@dont_activate_after_match` | 한 번 매칭 후 비활성화 |
| `@@probability N` | N% 확률로 활성화 (0~100) |
| `@@activate_only_after N` | 채팅 길이 ≥ N일 때만 활성화 |
| `@@activate_only_every N` | 채팅 길이 % N == 0 일 때만 활성화 |
| `@@is_greeting N` | N번째 인사말일 때만 활성화 |

### 매칭 제어

| 데코레이터 | 설명 |
|-----------|------|
| `@@match_full_word` | 단어 단위 매칭 활성화 |
| `@@match_partial_word` | 부분 문자열 매칭 (기본) |
| `@@additional_keys key1 key2` | 추가 양성 매칭 조건 |
| `@@exclude_keys key1 key2` | 하나라도 매칭되면 비활성 |
| `@@exclude_keys_all key1 key2` | 모두 매칭될 때만 비활성 |
| `@@scan_depth N` | 이 항목의 검색 깊이 오버라이드 |
| `@@no_recursive_search` | 재귀 검색 시 이 항목의 content 미포함 |

### 위치 지정

| 데코레이터 | 설명 |
|-----------|------|
| `@@depth N` | 끝에서 N번째 메시지 위치에 삽입 (0 = 맨 끝) |
| `@@reverse_depth N` | 시작에서 N번째 위치에 삽입 |
| `@@end` | `@@depth 0`과 동일 |
| `@@position after_desc` | 캐릭터 description 뒤 |
| `@@position before_desc` | 캐릭터 description 앞 |
| `@@position personality` | personality 섹션에 추가 |
| `@@position scenario` | scenario 섹션에 추가 |
| `@@position pt_NAME` | 커스텀 위치 (프롬프트 템플릿의 `{{position::NAME}}`) |
| `@@role system` | 메시지 역할 지정 (system/user/assistant) |

### 주입 (다른 항목에 내용 삽입)

| 데코레이터 | 설명 |
|-----------|------|
| `@@inject_lore 대상이름` | 대상 로어 항목에 내용 추가 (뒤에) |
| `@@inject_at 대상이름` | 대상 위치에 추가 |
| `@@inject_prepend 대상 매개변수` | 대상 앞에 삽입 |
| `@@inject_replace 대상 매개변수` | 대상 내 텍스트 교체 |

### 재귀

| 데코레이터 | 설명 |
|-----------|------|
| `@@recursive` | 이 항목의 content를 재귀 검색 대상에 포함 |
| `@@unrecursive` | 재귀 검색에서 제외 |

### 기타

| 데코레이터 | 설명 |
|-----------|------|
| `@@priority N` | 우선도 오버라이드 (높을수록 먼저 처리) |
| `@@ignore_on_max_context` | 컨텍스트 초과 시 우선 제거 (priority = -1000) |
| `@@disable_ui_prompt TYPE` | UI 프롬프트 섹션 비활성화 |

---

## 5. 토큰 예산 및 우선도 알고리즘 (lorebook.svelte.ts 실측)

```
priority = insertorder, order = insertorder   ← 둘 다 같은 필드에서 시작
1. 활성화된 항목을 priority 내림차순 정렬 (b.priority - a.priority)
2. 토큰 예산 내에서 탐욕적(greedy) 충전: 높은 priority 부터, 초과분은 버림
3. 살아남은 것을 order 내림차순으로 배치 (b.order - a.order) → insertorder 가 큰 항목이 프롬프트에서 먼저
```

- **우선순위는 `insertorder` 필드다.** 새 항목을 만들 때 반드시 숫자를 정해라(작성 규칙 스킬의 표). `@@priority N` 은 예산 경쟁에서만 쓰는 오버라이드이고 배치 순서는 바꾸지 않는다 — 실제 봇은 쓰지 않는다.
- `@@ignore_on_max_context` → priority = -1000 (가장 먼저 제거)
- 데코레이터는 **본문 맨 위**, 한 줄에 하나, 본문 텍스트보다 앞에 있어야 파싱된다. `@@position` 의 인자는 `after_desc | before_desc | personality | scenario | pt_이름` 만 유효하고 그 외는 무시된다.

---

## 6. 프로그래밍적 조작

### CBS에서

```
{{lorebook}}                    — 활성 로어북 JSON 배열 반환
{{hiddenkey::값}}               — 숨김 키 (모델에 전송 안 됨, 로어 활성화 트리거)
```

### Lua에서

```lua
-- 검색
getLoreBooks(id, "검색어")          -- 이름으로 로컬 로어북 검색
loadLoreBooks(id)                   -- 활성 로어북 로드 (async)

-- CRUD (v2 API)
v2GetAllLorebooks(id)               -- 전체 목록
v2GetLorebookByName(id, "이름")     -- 이름으로 검색
v2GetLorebookByIndex(id, 0)         -- 인덱스로 접근
v2GetLorebookCountNew(id)           -- 항목 수

v2CreateLorebook(id, name, key, content, insertOrder)      -- 생성
v2ModifyLorebookByIndex(id, idx, name, key, content, insertOrder) -- 수정
v2DeleteLorebookByIndex(id, idx)                           -- 삭제
v2SetLorebookAlwaysActive(id, idx, true)                   -- 상시 활성 토글

-- Upsert (간편 API)
upsertLocalLoreBook(id, "이름", "내용", {
    alwaysActive = true,
    insertOrder = 100,
    key = "키워드1, 키워드2",
    secondKey = "보조키",
    regex = false
})
```

### 내부 상태 변수

로어북 시스템은 채팅 변수에 상태를 저장:
- `__internal_ka_ENTRYID` = `"true"` — `@@keep_activate_after_match` 트리거 기록
- `__internal_da_ENTRYID` = `"true"` — `@@dont_activate_after_match` 트리거 기록

---

## 7. V2/V3 카드 포맷 호환

외부 CharacterCard 포맷 → RisuAI 변환 매핑:

| 외부 필드 | RisuAI 필드 |
|----------|------------|
| `keys[]` | `key` (쉼표 결합) |
| `secondary_keys[]` | `secondkey` (쉼표 결합) |
| `insertion_order` | `insertorder` |
| `constant` / `forceActivation` | `alwaysActive` |
| `use_regex` | `useRegex` |
| `position` / `depth` / `role` | content 내 @@데코레이터로 변환 |

---

## 8. 실전 패턴

### 패턴 A: 단계별 스토리 진행
```
항목: "1장 설정"
  key: 1장, chapter1
  mode: normal
  content:
    @@activate_only_after 0
    @@dont_activate_after_match
    (1장 설정 내용...)

항목: "2장 설정"
  key: 2장, chapter2
  mode: normal
  content:
    @@activate_only_after 10
    (2장 설정 내용...)
```

### 패턴 B: 조건부 활성화 (변수 연동)
로어북 content에서 CBS 조건문 사용:
```
@@activate
{{#when::var::dark_mode}}
(어둠 모드 전용 설정...)
{{/when}}
```

### 패턴 C: 위치 지정 주입
```
항목: "전투 시스템"
  key: 전투, 공격, 방어
  content:
    @@depth 2
    @@role system
    [전투 시스템 규칙을 여기에...]
```

### 패턴 D: 폴더 구조로 그룹화
```
항목: "캐릭터 폴더"     mode: folder    (프롬프트에 주입 안 됨)
항목: "캐릭터 A"        folder: (폴더ID)  mode: normal
항목: "캐릭터 B"        folder: (폴더ID)  mode: normal
```

### 패턴 E: 재귀 매칭 체인
```
항목: "마법 시스템"
  key: 마법
  content:
    @@recursive
    이 세계의 마법은 원소 기반이다. 화염마법과 빙결마법이 대표적.

항목: "화염마법 상세"
  key: 화염마법
  content:
    화염마법은 공격력이 높지만 마나 소비가 크다.
```
→ "마법" 키워드 매칭 → "마법 시스템" 활성 → 재귀 검색 중 "화염마법" 발견 → "화염마법 상세"도 활성화
