에셋 스튜디오에서 이미지를 손보는 방법. **크기 조절·자르기·포맷 변환·투명 배경**처럼
스튜디오 코어가 하지 않는 픽셀 작업은 전부 여기 있는 방식으로 `run_python` 에서 한다.

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

# 3) webp 로 (용량이 크게 준다. RisuAI 감정 이미지는 png 를 쓰므로 주의)
im.save("out/결과.webp", quality=88, method=6)

# 4) 메타데이터 제거 — NAI PNG 는 프롬프트를 그대로 담고 있다
clean = Image.new(im.mode, im.size)
clean.putdata(list(im.getdata()))
clean.save("out/깨끗한.png")
```

## 주의

- **에셋으로 넣을 것은 PNG 여야 한다.** RisuAI 의 `saveAsset` 은 무슨 바이트든 `.png`
  키를 만든다 — webp 를 넣으면 이름만 png 인 파일이 된다.
- **NAI PNG 는 생성 파라미터를 메타데이터로 들고 있다** (`tEXt Comment`). 남에게 줄
  카드에 넣을 때 프롬프트가 딸려 가는 게 싫으면 위 4) 로 지운다. 반대로 우리 쪽에서는
  그게 "이거랑 같은 설정으로 더" 를 가능하게 하는 자산이므로 라이브러리 원본은 지우지 않는다.
- 원본을 덮어쓰지 않는다. 비교 선택기가 후보를 나란히 놓고 고르는 화면이라,
  덮어쓰면 비교가 사라진다.
