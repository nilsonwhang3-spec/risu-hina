RisuAI `.charx` 캐릭터 카드의 내부 구조. 사용자가 charx 파일을 올렸을 때,
그 안의 설정·로어북·에셋을 조사하며 챗을 고치기 위한 자료다.
파일을 푸는 것은 `skills/charx_unpack.py` 가 한다.

**Risu Hina는 charx 를 다시 패킹하지 않는다.** 읽고 참조하기 위한 것이다.
카드 자체를 고치는 일은 아직 이 도구의 범위가 아니다.

---

## 폴더 구조# CharX Decode/Encode 스킬

RisuAI `.charx` 캐릭터 카드를 편집하기 위한 유틸리티.
module.risum (Lua 트리거 + Regex + 로어북) 인코딩/디코딩을 자동 처리한다.

## ⚠️ 모듈 namespace는 charx로 왕복 불가 (RisuAI 코드 제약)

RisuAI 소스(`process/modules.ts`, `interchangeability.ts`) 분석 결과:

- `namespace`는 RisuAI 내부 DB의 `RisuModule.namespace` 필드에만 저장된다 (모듈 편집 UI에서 설정). `{{module_assetlist::<namespace>}}` 등 CBS가 이 값으로 모듈을 조회한다.
- **charx 모듈 export** = `convertModuleToCharacter()` — 필드 매핑 테이블에 namespace가 없어 **export 시 소실**된다. `cjs`, `mcp`, `id`도 함께 소실.
- **charx 모듈 import** = `importCharacterProcess()` → `convertCharacterToModule()` — card.json 기반으로 모듈을 재구성하며 **charx 내부 module.risum의 namespace는 읽지 않는다**. id는 `v4()`로 재생성.
- **`.risum` (legacy) 포맷**은 `exportModuleLegacy()`/`readModule()`이 RisuModule 객체 전체를 그대로 직렬화/복원하므로 **namespace가 보존**된다.

실무 지침:
1. module.md frontmatter에 `namespace: <값>`을 기록해 두면 이 스킬의 ENCODE가 module.risum에 포함시킨다 (문서화 + 향후 RisuAI 지원 대비). 단, **현재 RisuAI의 charx 모듈 import는 이를 무시**한다.
2. 따라서 charx로 모듈을 배포/재임포트하면 **매번 RisuAI 모듈 설정에서 namespace를 수동 재입력**해야 한다. 유저에게 이를 안내할 것.
3. namespace 자동 보존이 필요하면 `.risum` 포맷으로 내보내야 한다 (RisuAI 모듈 메뉴의 legacy export).

## 판단 기준

유저 요청을 아래 두 모드 중 하나로 분류한다:

### DECODE (풀기)
키워드: 풀어, 디코드, decode, unpack, extract, 열어, 읽어
- `.charx` 파일을 편집 가능한 폴더 구조로 분해한다.
- module.risum이 있으면 자동으로 Lua/Regex/메타데이터를 추출한다.

### ENCODE (합치기)
키워드: 합쳐, 인코드, encode, pack, 만들어, 작성, 빌드
- 편집 완료된 폴더를 `.charx` 파일로 다시 패킹한다.
- triggers.lua 또는 regex.json이 있으면 자동으로 module.risum을 생성한다.

## DECODE 절차

1. 유저가 경로를 지정하지 않았으면 프로젝트 내 `.charx` 파일을 Glob으로 검색하여 후보를 보여준다.
2. 대상 `.charx` 파일과 출력 폴더를 결정한다 (기본: 같은 디렉토리에 확장자를 뺀 이름의 폴더).
3. 실행:
```bash
echo "y" | python "${CLAUDE_SKILL_DIR}/charx_decode.py" "<입력.charx>" "<출력폴더>"
```
4. 결과 폴더 구조를 보여준다.



```
폴더/
  card.json              # 카드 메타 (character_book.entries = [], triggerscript/customScripts 없음)
  lorebook/              # 로어북 항목 개별 파일 (V3 포맷)
    00_항목이름.json
    01_항목이름.json
    ...
  triggers.lua           # Lua 코드 (있으면 module.risum에 포함됨)
  regex.json             # Regex 스크립트 배열 (있으면 module.risum에 포함됨)
  module.json            # 모듈 메타데이터 (name, id 등)
  assets/                # 에셋 파일 (이미지 등) — 파일 조작이 곧 에셋 추가/삭제
    icon/image/          # 아이콘 (main.png)
    other/image/         # 캐릭터/배경 이미지
  x_meta/                # 에셋 메타데이터 (ENCODE 시 자동 재생성, 편집 불필요)
```

## 편집 시 주의사항

- 로어북: `lorebook/` 폴더의 파일을 추가/삭제/수정. 번호 접두어로 순서 제어.
- Lua 코드: `triggers.lua` 파일 직접 편집.
- Regex: `regex.json` 배열 직접 편집.
- card.json: description, first_mes, defaultVariables 등 편집. lorebook entries와 triggerscript는 건드리지 않음 (인코드 시 자동 처리).
- 에셋: `assets/` 폴더에 파일을 넣거나 빼면 ENCODE 시 자동 등록/제거된다 (아래 "에셋 관리" 참조). `x_meta/`는 손대지 않는다 (자동 생성됨).

## 에셋 관리

### 에셋 모델 (charx 내부 구조)

`card.json`의 `data.assets[]` 배열이 **권위 있는 에셋 레지스트리**다. 각 항목:

```json
{"type": "x-risu-asset", "uri": "embeded://assets/other/image/Name-emotion.webp", "name": "Name-emotion", "ext": "webp"}
```

| 필드 | 의미 |
|------|------|
| `type` | 아바타는 `"icon"`(name=`main`), 그 외는 `"x-risu-asset"` |
| `uri`  | `embeded://assets/<icon\|other>/image/<파일명>.<ext>` — zip 내부 경로. **파일명은 고유해야 함** |
| `name` | CBS/Lua가 참조하는 **논리명**. `{{raw::name}}`, 감정 표정 등에서 사용. **중복 허용** |
| `ext`  | 확장자(소문자) |

- 실제 바이너리는 `assets/other/image/<파일명>.<ext>` (아이콘은 `assets/icon/image/main.png`).
- `x_meta/<파일명stem>.json` = `{"type":"<EXT대문자>"}`. 에셋당 1개. 보조 메타이며 RisuAI는 타입 불일치에 관대하다. **ENCODE 시 배열로부터 자동 생성**되므로 직접 편집할 필요 없음.

### 랜덤 에셋 (동일 에셋명)

**여러 항목이 같은 `name`을 공유하면 랜덤 풀이 된다.** 해당 name이 호출되면 RisuAI가 풀에서 무작위로 1개를 선택한다.

- `uri` 파일명은 고유해야 하므로 RisuAI는 충돌 시 `_1`, `_2` … 접미사를 붙인다. 이 접미사는 **파일명 고유화용일 뿐 name과 무관**하다.
- 예: `name:"Beatrice-sex_spooning"` 항목 4개 → 파일은 `…spooning.webp`, `…spooning_1.webp`, `…spooning_2.webp`, `…spooning_3.webp`.

### 에셋 추가/삭제/랜덤 — 자동 동기화

ENCODE 시 `assets/` 폴더의 실제 파일을 기준으로 `data.assets[]` 배열과 `x_meta/`를 자동 재조정한다. 별도 명령 없이 **파일 조작만으로** 끝난다:

| 작업 | 방법 |
|------|------|
| **신규 에셋 추가** | `assets/other/image/MyName.webp` 파일을 넣는다 → name `MyName`으로 자동 등록 |
| **랜덤 변형 추가** | 기존 풀명에 `_N`을 붙인 파일을 넣는다. 예 `Beatrice-angry_3.webp` → name `Beatrice-angry` 풀에 합류 |
| **에셋 삭제** | 파일을 지운다 → 배열 항목·x_meta 자동 제거 |
| **논리명 변경** | `card_meta.json`의 해당 항목 `name`을 수정 (파일이 그대로면 보존됨) |

동기화 규칙(비파괴적):
- 이미 배열에 등록된 항목은 **name을 절대 변경하지 않는다** (예: 의도적으로 `_2`로 끝나는 독립 name도 라운드트립 보존).
- 신규 파일의 name은 끝의 `_<숫자>`를 떼어 도출한다 (랜덤 풀 합류용). 숫자로 끝나는 **독립** name이 필요하면 `card_meta.json`에 항목을 직접 추가할 것.

### 에셋 상태 미리보기 (dry-run)

ENCODE 전에 현재 폴더가 어떻게 등록될지 확인:

```bash
python "${CLAUDE_SKILL_DIR}/charx_assets.py" "<디코딩폴더>"
```

논리명별 풀과 멤버 수(랜덤 풀 표시), 추가될 신규 파일, 제거될 항목을 출력한다.
