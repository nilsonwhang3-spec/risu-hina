성인(NSFW) 이미지 에셋을 생성·배치할 때의 함정과 권장 설정. 사용자의 실사용
Try & Error 기록을 정리한 것이다 — **성인 씬 배치를 시작하기 전에 이 문서를 따른다.**
(UC 확인·직렬 실행·레시피 검증 절은 SFW 배치에도 그대로 유효하다.)

## 0. 캐릭터 레퍼런스 준비

- 레퍼런스 이미지는 **자르지 말고, 인물 손실 없는 여백(레터박스) 방식으로
  1024×1536(세로) / 1536×1024(가로)에 맞춘다.** 패널에서 올리면 자동으로 맞춰 주지만,
  run_python(PIL)로 직접 준비할 때는 contain 축소 + 검은 패딩으로 채운다
  (스킬 "에셋 스튜디오 이미지 가공" 참고).

## 1. UC Preset — 요청 값과 PNG 레시피를 함께 확인

`ucPreset` 숫자 매핑 (NovelAI 생태계 공통; 이 백엔드도 동일하게 처리한다):

| 값 | UC Preset |
|---:|---|
| `0` | Heavy (기본값) |
| `1` | Light |
| `2` | **None** |
| `3` | Human Focus |
| `4` | None (구 웹 UI 번호 — 2와 동일하게 처리) |

- NSFW 생성에서는 내장 UC 의 `nsfw` 가 장면을 억제하지 않도록 **spec 의
  `params.ucPreset: 2` 를 반드시 명시한다.** 화면에서 None 을 골라 두었어도
  **studio_generate spec 에 값을 싣지 않으면 기본 0(Heavy)으로 돌아간다.**
- 생성 후 `studio_recipe(이미지 경로)` 로 PNG 레시피를 읽어 `parameters.uc`(또는
  `v4_negative_prompt`)가 `nsfw, lowres, …` 로 **시작하면 None 이 적용되지 않은 것**이다 —
  spec 을 고쳐 다시 뽑는다.
- `ucPreset: 3` 은 None 이 아니라 Human Focus 다. 혼동하지 않는다.

참고: https://image.novelai.net/docs/index.html ·
https://github.com/LlmKira/novelai-python/issues/91 ·
https://github.com/koishijs/novelai-bot/blob/main/src/index.ts

## 2. 남성 누락 방지 네거티브에 `male`·`boy`를 쓰지 않기

다음 문구는 의도와 반대로 남성 자체를 억제한다:

```text
no male / male out of frame / cropped male / female only / no boy
```

이미지 모델의 네거티브는 논리 명령문이 아니다. 네거티브에 든 `male`/`boy` 는 부정
조건으로 작용해 positive 의 `1boy` 와 충돌하고 여성 단독 장면이 나온다.

권장 네거티브:

```text
solo, 2girls, multiple girls,
portrait, close-up, upper body
```

- 네거티브에서 `male`, `boy` 가 들어간 문구를 전부 피한다.
- 상대역의 존재는 **positive 에서** 강하게 고정한다.

## 3. 여성 캐릭터 레퍼런스의 단독 구도 편향

여성 캐릭터 레퍼런스만 강도 1·충실도 1로 실으면 모델이 여성 외형 재현을 우선해
① 여성 단독 장면 ② 얼굴·가슴 중심 상반신 클로즈업 ③ 남성 신체가 화면 밖으로 잘림
④ 성행위 대신 포즈 일러스트로 변형 — 으로 치우친다.

대응:

- positive 앞쪽에 `1boy`, `hetero` 를 배치한다.
- `full body, wide shot` 을 쓴다.
- 필요하면 남성을 별도 애드혹 캐릭터 조건으로 추가한다: `1boy, adult male, faceless male`
- 여성 외형이 충분히 유지되면 레퍼런스 강도·충실도를 소폭 낮춘 비교 샘플도 검토한다.

## 4. 의상 변형 규칙

**Partially Undressed**: positive `partially undressed, breasts out`
· 네거티브 `completely nude, fully clothed, bra, clothed breasts`
— `partially undressed` 만으로는 가슴이 계속 가려지므로 `breasts out` 을 함께 넣는다.

**Completely Nude**: positive `completely nude`
· 네거티브 `partially undressed, fully clothed`

- 한 변형의 positive 와 다른 변형의 네거티브가 서로 모순되지 않는지 확인한다.

## 5. 화풍 프롬프트와 구도 태그 분리

캐릭터 일러스트용 스타일에 든 `white background · cowboy shot · portrait · upper body` 는
2인 NSFW 장면과 충돌한다.

- 화풍·작가 태그는 유지하되 위 **구도 태그는 2인 NSFW 전용 스타일에서 제거**한다.
- `cowboy shot` 을 positive 와 negative 양쪽에 넣는 상쇄는 피한다.
- 스타일 네거티브에 이미 품질·해부학 태그가 있으면 중복하지 않는다.

## 6. 배치는 직렬로 — 동시 등록 금지

- 캐릭터별 잡 수십 개를 한꺼번에 등록하지 않는다. NovelAI 는 계정당 동시 생성을
  잠그므로 과도한 병렬은 `HTTP 429` / `Concurrent generation is locked` 가 난다.
  (백엔드가 잡을 전역 직렬 큐로 돌리지만, 그래도 쌓아 두지 말고 한 배치가 끝난
  결과를 **확인한 뒤** 다음을 시작한다.)
- 실패한 요청도 처리 단계에 따라 비용이 일부 나갈 수 있다 — 잡의
  anlasBefore/anlasAfter 차액을 확인한다.

권장 순서: ① 한 장 검증 → ② 한 캐릭터의 누락 씬 배치 → ③ 결과·PNG 레시피 확인 →
④ 다음 캐릭터 배치.

## 7. 대규모 생성 전 체크리스트

- [ ] 모델이 `nai-diffusion-4-5-full` 인가?
- [ ] Steps 28 인가?
- [ ] 해상도가 의도한 값인가 (예: 1024×1024)?
- [ ] `params.ucPreset: 2` 가 spec 에 명시됐는가?
- [ ] 검증 1장의 PNG 레시피 UC 에서 `nsfw` 가 사라졌는가?
- [ ] 2인 NSFW 전용 스타일을 쓰는가?
- [ ] positive 에 `1girl, 1boy, hetero` 가 있는가?
- [ ] negative 에 `male`, `boy` 가 없는가?
- [ ] `partially undressed` 에 `breasts out` 이 함께 있는가?
- [ ] `full body, wide shot` 이 있는가?
- [ ] 시점·자세 지시가 하나의 대표 구도로 단순화됐는가?
- [ ] 한 장 검증에서 여성 단독·상반신 클로즈업·몸 꼬임이 없는가?
- [ ] 배치를 한 번에 하나만 돌리는가?

## 8. 생성 후 반드시 확인

`studio_recipe` 로 레시피에서: positive 에 의도한 인원수·구도가 실제로 들어갔는지 ·
UC None 이 실제 적용됐는지 · 네거티브에 `nsfw`/`male`/`boy` 가 잘못 들어가지 않았는지 ·
Steps·크기·샘플러가 요청과 일치하는지 · 레퍼런스 비용(Anlas 차액)이 예상과 맞는지.

이미지에서: 여성과 남성이 모두 있는가 · 씬의 핵심 동작이 보이는가 · 상반신
클로즈업으로 잘리지 않았는가 · 몸·관절·팔다리가 꼬이지 않았는가 · 부분 탈의와
완전 누드 변형이 명확히 구분되는가.
