# 03. 봇 카드의 REGEX/LUA/CBS 렌더링을 왼쪽 패널에 반영할 수 있는가

2026-08-23 검토. 결론부터: **완전 복제는 안 한다. 정규식+CSS 단계까지는 한다.**

## 사용자가 실제로 보는 것까지의 경로

`processScriptFull(char, data, 'editdisplay', chatID, cbsConditions)` — `PocketRisu/src/ts/process/scripts.ts:99`.
순서대로:

1. `runLuaEditTrigger(char, mode, data, {index})` — **Lua VM**(`wasmoon ^1.16.0`)
2. `runTrigger(currentChar, 'display', {...})` — 트리거 스크립트(역시 Lua/CBS)
3. 플러그인 `editdisplay` 훅
4. `risuChatParser(data, {chatID, cbsConditions})` — **CBS 엔진 전체**
5. 정규식: `db.presetRegex` + `char.customscript` + `getModuleRegexScripts()`
   - `$n`→개행, 플래그 정규화, `@@emo` / `@@inject` / `@@move_top` / `@@move_bottom` 지시자,
     `pscript.actions`(`cbs`·`inject`·`move_top`·`no_end_nl`), 스크립트 캐시
6. `ParseMarkdown(...)`

그리고 **화면의 CSS는 메시지가 아니라 배경 레이어에서 온다**:
`character.backgroundHTML` + 모듈 `backgroundEmbedding` 을 이어붙여 `risuChatParser` → `ParseMarkdown(..., 'back')`
→ `BackgroundDom.svelte`. 여기 실린 `<style>`이 장식 정규식이 뱉은 마크업에 스타일을 입힌다.
**정규식만 복제하고 이 CSS를 빼면 스타일 없는 마크업만 남는다.**

## 호스트에 맡길 수 있는가 — 없다

v3 API 전수 확인: 디스플레이 파이프라인을 실행해 주는 API가 **없다.**
`addRisuScriptHandler(mode, fn)`은 핸들러를 *등록*할 뿐 파이프라인을 *호출*하지 않는다.
`risuai.d.ts` 어디에도 `processScript`/`risuChatParser`류 노출이 없다.

읽기는 된다: `getCharacterFromIndex`가 트리밍 없는 `$state.snapshot`을 주므로
`char.customscript`, `char.backgroundHTML`, `char.triggerscript`를 전부 볼 수 있다.
**실행을 우리가 해야 한다는 뜻이다.**

(이미 렌더된 DOM을 `getRootDocument()`로 긁는 방법도 있으나, 채팅 화면에 그려진 몇 개만 존재하고
SafeElement 왕복이 느려 394턴에는 성립하지 않는다.)

## 위험 3가지 — 이게 판단을 갈랐다

1. **`@@inject`는 챗에 쓴다.** `scripts.ts:206` — `selchar.chats[selchar.chatPage].message[chatID].data = data`.
   읽기 전용 뷰어가 표시를 하려다 **원문을 고치는** 경로다. 충실히 포팅할수록 위험해진다.
   어떤 구현이든 `@@` 지시자 스크립트는 실행하지 않는다.
2. **카드 정규식은 남이 쓴 정규식이고, 대상은 수 MB다.** JS 정규식에는 타임아웃이 없다.
   플러그인 iframe에서 파국적 백트래킹이 걸리면 **패널이 통째로 얼어붙는다.**
3. **Lua는 VM을 들고 와야 한다.** CSP가 `'wasm-unsafe-eval'`을 허용하므로 wasmoon이 *원리적으로는*
   돈다(이건 의외의 발견이다). 하지만 번들 +400KB에 호스트 함수 표면
   (`LUA_LLM_REFERENCE.md`)을 전부 재구현해야 하고, 그 위에 CBS 수백 태그가 또 있다.

## 결정 — 3단계, A만 지금

### A. 정규식 + 배경 CSS (구현 예정, 비용 작음)

- `char.customscript` + 모듈 정규식에서 `type === 'editdisplay'`만 적용
- **`out`이 `@@`로 시작하거나 `actions`에 `inject`/`move_*`가 있으면 건너뛴다** (위험 1)
- **정규식 실행은 백엔드에서** 한다. 이게 위험 2의 진짜 해법이다 — 파이썬 쪽은 서브프로세스와
  시간 예산을 걸 수 있고, 얼어도 UI가 아니라 요청 하나가 죽는다.
  경계 계약(“정책은 백엔드”)과도 맞는다.
- `backgroundHTML` + 모듈 `backgroundEmbedding`에서 **`<style>` 블록만** 추출해 턴 리스트에 스코프해 주입.
  스크립트는 CSP nonce가 없어 어차피 실행되지 않으므로, 스타일만 남기는 건 필터가 아니라 확인이다.
- 이 단계로 “장식 정규식 31개”류는 대부분 살아난다. CBS가 든 `out`은 리터럴로 남는다.

### B. CBS 부분 집합 (추후)

`out`/`in`에 실제로 나타나는 태그만 골라 구현. 전체 CBS 포팅은 하지 않는다.
A를 배포한 뒤 **실제 카드에서 어떤 태그가 남는지 세어 보고** 범위를 정한다 — 추측으로 정하지 않는다.

### C. Lua 트리거 + 전체 CBS (하지 않는다)

VM과 호스트 API를 재구현하는 일이고, 그 결과도 RisuAI 버전이 바뀔 때마다 어긋난다.
이게 필요한 카드는 **raw 보기**와 RisuAI 본체에서 보는 것으로 남긴다.

## 지금 있는 것 (v0.1.0)

계약을 정직하게 적자면, 현재 “렌더링 보기”는 **RisuAI 재현이 아니라 노이즈 제거**다:
사고사슬 블록 제거, `img` 외 태그 제거, 코드블록 제거(선택), `**강조**` 렌더.
카드 정규식은 아직 반영하지 않는다. raw 보기가 저장된 원문 그대로다.

UI 문구도 이에 맞춰야 한다 — “렌더링”이 RisuAI와 같은 화면을 뜻한다고 오해되면 안 된다.
