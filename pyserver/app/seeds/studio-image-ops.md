에셋 스튜디오에서 이미지를 손보는 방법. **크기 조절·자르기·포맷 변환·투명 배경**처럼
스튜디오 코어가 하지 않는 픽셀 작업은 전부 여기 있는 방식으로 `run_python` 에서 한다.

## 기존 프로젝트의 추가 생성·수정과 누적 검수

봇 에셋 추가/교체 전 원본 PNG/WebP 바이트를 프로젝트의 기존 보관 체계에 남기고,
원본 경로·슬롯·후보·반영용 파생 파일의 대응을 기록한다. 이미 프로젝트 안에 보관돼 있으면
그 경로를 유지한다. 검수 폴더의 파일은 이동하지 말고 필요한 보관본만 복사한다. 원본을 덮어쓰지 않는다.
**WebP 변환 여부와 품질/압축률(%)을 사용자에게 확인한 후 변환과 추가/교체 제안을 실행한다.**
현재 작업에서 이미 선택했다면 다시 묻지 않는다. quality 0~100은 높을수록 품질·용량이 커지는 값이며
파일 크기가 그 비율로 줄어든다는 뜻은 아니다. 변환본은 원본과 분리하고 등록 에셋 이름·그룹은 유지한다.

작업 시작 시 `studio_group(folder)`로 현재 채택(use)·수정(inpaint)·버림(delete)·미검수 상태와
저장된 그룹 정규식/groupBy를 읽는다. nextOffset이 있으면 뒤 페이지도 읽는다. AI 제안(suggest)은
사용자의 결정과 별개다. 이 상태는 클릭 시 저장되므로 **애셋 채택/selected 내보내기를 요구하지 않는다**.

`studio_asset_rules(operation="read")`와 봇의 `list_scripts(kind="assetref", query=...)`,
`search_bot(query=...)`로 실제 에셋 호출 커맨드·Regex·Lua·기존 이름을 조사한다. 구분자(- 또는 _)와
캐릭터·복장·표정·체위 필드의 순서는 프로젝트마다 다르다. 필드 안의 밑줄까지 무작정 나누지 않는다.
기존 화면 그룹 규칙을 우선하고, 규칙이 없을 때만 여러 기존 파일과 봇 커맨드에 맞는 명명 캡처
정규식/groupBy를 정해 `studio_group(pattern=..., group_by=..., save_rule=True)`로 검증·기록한다.
못 읽은 파일과 의도치 않게 분리된 그룹이 없는지 확인한다.

추가 후보는 **기존 검수 폴더**에 저장한다. 수정용/재생성용 하위 폴더를 임의로 만들지 않는다.
등록된 세트는 spec/entry의 `asset {project,setId,slotId,fields}`로 같은 슬롯을 지정한다.
같은 감정 그룹에서 복수 채택은 Risu의 기본 랜덤 에셋 출력을 의도한 것이다. 봇에 등록하는
에셋 이름은 같게 유지하고, 물리 파일에만 `.1/.2` 또는 기존 프로젝트의 `_1/_2` 후보 번호를 둔다.
후보 번호는 그룹 의미 필드가 아니다. 기존 `_1`이 후보 번호인지 의미의 일부인지는 봇 호출 규칙과
실제 이름을 확인하고 정한다. 임의로 숫자를 지우거나 여러 채택을 하나로 줄이지 않는다.
레거시 파일은 기존 template과 의미 필드 값을 그대로 유지하고, 충돌 번호는 저장기의 `.2`, `.3`에 맡긴다.
예컨대 슬롯 `smile`을 `smile-1`/`smile_fixed`로 바꾸면 그룹 필드가 달라질 수 있다.
인페인트는 원본 옆에 같은 의미 이름과 슬롯 정체성을 계승한다. 별도 rename/move로 그룹을 바꾸지 않는다.
기존 검수 상태를 초기화하거나 새 후보에 원본의 채택 상태를 복사하지 않는다. 새 후보는 미검수로 둔다.
작업 후 `studio_group`을 다시 읽어 원본과 후보가 같은 그룹이고 기존 결정이 보존됐는지 확인한다.

도구 결과가 길면 표시된 `read_tool_result(ref, offset)`로 같은 턴의 원문도 끝까지 읽을 수 있다.
상태가 바뀐 뒤에는 원문 재조회 대신 `studio_group` 등 현재 상태 읽기 도구를 다시 실행한다.

## 왜 코어가 안 하나

**Pillow 는 배포 번들에 없다.** 릴리스 zip 은 해시 고정 wheels 로만 만들어지고
Pillow 는 거기 들어가지 않는다. 그래서

- 스튜디오 코어(생성·인페인트 마스크·중복 탐지)는 **표준 라이브러리만** 쓴다.
  인페인트 마스크는 `zlib` 로 직접 PNG 를 쓴다 (`studio.make_mask`).
- 픽셀을 실제로 만지는 일은 **`run_python` 에서 Pillow 를 설치해서** 한다.
  설치는 pip 허용 프롬프트를 거친다 — 사용자가 승인해야 한다.
- 인터넷이 없는 설치본에서는 설치가 실패한다. 그 경우 사용자에게 그대로 알리고,
  크기 조절이 꼭 필요하면 RisuAI 쪽이나 외부 도구를 권한다.

## 설치

```python
import PIL  # 없으면 ModuleNotFoundError
```

없으면 pip 로 설치한다 (허용 프롬프트가 뜬다). 한 번 설치되면 그 설치본에 남는다.

## 스튜디오 라이브러리 경로

스튜디오는 **전역 공간의 `studio/` 폴더다** — 재료는 `studio/config/`
(styles·characters·fragments·scenes), 생성 결과는 `studio/output/`. 샌드박스
루트가 전역 공간이므로 `run_python` 에서 바로 읽고 쓴다 — 옮기는 절차는 없다.
cwd 는 `hina/<봇이름>/` 이니 라이브러리는 `../../studio/output/…` 처럼 위로
올라가거나, `find_files("*.png", base="studio/output")` 로 찾은 전역 경로를
`os.environ["RISUHINA_WORKSPACE"]` 에 이어 붙여 절대 경로로 연다.

## 캐릭터 스타일 카드와 캐릭터 레퍼런스

둘은 같은 것이 아니다. `studio/config/characters/<캐릭터>/prompt.md`에는 생성 프롬프트에
합성할 **캐릭터 스타일 태그**가 저장된다. 같은 폴더의 `preset.json`에는 별도로 레퍼런스
이미지 목록과 이미지별 설정이 저장된다.

```json
{
  "refMode": "charref",
  "charref": [{
    "file": "reference-1024x1536.png",
    "mode": "character",
    "strength": 0.6,
    "fidelity": 0.6,
    "enabled": true
  }]
}
```

- `mode`: `character`(캐릭터만) 또는 `character&style`(캐릭터와 화풍)
- `strength`: 레퍼런스 영향 강도, 0~1
- `fidelity`: 원본 캐릭터를 따르는 충실도, 0~1
- `refMode`: `charref`와 `vibe` 중 실제로 실을 한 종류. 두 목록은 함께 전송되지 않는다.
- 캐릭터 레퍼런스 PNG는 일반 세로 생성물 `832x1216`을 그대로 보내지 않는다. NAIS 1.0.25의
  `processCharRefImage`와 같이 원본 비율이 `1.2`보다 크면 **가로 `1536x1024`**, `1/1.2`보다
  작으면 **세로 `1024x1536`**, 그 사이면 **정사각 `1472x1472`**로 맞춘다. 비율을 유지한
  검정 contain/letterbox 방식이다. 여기서 “약 1.5배”는 `832x1216` 대비 총 픽셀 면적을
  뜻하며 가로·세로를 각각 1.5배 한다는 뜻이 아니다.

캐릭터를 사용하는 배치를 계획할 때 `studio_library`로 표시 이름을 찾는 데 그치지 말고
`read_file`로 그 카드의 `prompt.md`와 `preset.json`을 함께 확인한다. 스타일 태그와 활성
레퍼런스, 각 이미지의 mode/strength/fidelity를 구분해 설명하고 저장값을 임의로 바꾸지 않는다.

## 배치 스펙 — 임시 프리셋은 프리셋 목록에 만들지 않는다

`studio_plan`/`studio_generate` 의 spec 은 카드를 **표시 이름**으로 받고
("오피스 카운셀링" — 겹치면 후보를 나열하며 거절된다), 씬을 인라인으로 받는다.
"angry 와 childlike_whining 만 새로" 같은 일회성 요청은 프리셋 파일 없이:

```json
{"styles": ["오피스 카운셀링"], "characters": ["베아트리체"],
 "scenes": [{"name": "angry", "prompt": "angry, frown"},
            {"name": "childlike_whining", "prompt": "childlike, whining"}],
 "characterName": "베아트리체", "folder": "studio/output/베아트리체"}
```

기존 프리셋의 일부만 쓸 때는 `"scenePreset": "<프리셋>", "only": ["angry"]`.
반복해서 쓸 임시 스펙만 파일로 남기되, **`studio/config/scenes/` 가 아니라
`studio/config/.studio/adhoc/` 에** write_file 로 쓴다 — 라이브러리 목록에 잡히지
않는 내부 영역이라 사용자의 프리셋 목록을 어지럽히지 않는다.

## 자주 쓰는 조리법

```python
import os
from PIL import Image

SPACE = os.environ["RISUHINA_WORKSPACE"]
im = Image.open(os.path.join(SPACE, "studio", "output", "원본.png")).convert("RGBA")

# 1) 긴 변 기준 축소 — 비율 유지
im.thumbnail((1024, 1024), Image.LANCZOS)

# 2) 정사각형으로 가운데 자르기 (감정 이미지에 자주 쓴다)
w, h = im.size
s = min(w, h)
im = im.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2))

# 3) webp 로 (RisuAI는 PNG와 WebP 내용 모두 지원한다)
im.save("out/결과.webp", quality=88, method=6)

# 4) 메타데이터 제거 — NAI PNG 는 프롬프트를 그대로 담고 있다
clean = Image.new(im.mode, im.size)
clean.putdata(list(im.getdata()))
clean.save("out/깨끗한.png")
```

## 주의

- RisuAI의 `saveAsset`은 저장 키/파일명을 `.png`로 만들지만 **내용은 PNG와 WebP 모두 가능**하다.
  확장자만 보고 PNG 변환을 요구하지 않는다. 실제 포맷은 파일 바이트로 판단한다.
- **NAI PNG 는 생성 파라미터를 메타데이터로 들고 있다** (`tEXt Comment`). 남에게 줄
  카드에 넣을 때 프롬프트가 딸려 가는 게 싫으면 위 4) 로 지운다. 반대로 우리 쪽에서는
  그게 "이거랑 같은 설정으로 더" 를 가능하게 하는 자산이므로 라이브러리 원본은 지우지 않는다.
- 원본을 덮어쓰지 않는다. 비교 선택기가 후보를 나란히 놓고 고르는 화면이라,
  덮어쓰면 비교가 사라진다.
