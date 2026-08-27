RisuAI 처리 파이프라인 레퍼런스 — 정규식(customscript) 네 종류와 Lua listenEdit 훅이 **어느 시점에, 어떤 순서로, 무엇에** 적용되고 그 결과가 **저장되는지 아닌지**. Regex·트리거·배경 HTML 을 만들거나 고칠 때, 또는 "왜 이 태그가 요청에 들어가/화면에 보여/저장돼 있나"를 설명해야 할 때 읽어라.
출처: RisuAI 소스 `src/ts/process/index.svelte.ts`(sendChat), `scripts.ts`(processScriptFull), `scriptings.ts`(runLuaEditTrigger), `parser/parser.svelte.ts`, `lib/ChatScreens/DefaultChatScreen.svelte` — 2026-08 기준.

---

# 1. 한 턴의 전체 순서

```
[사용자가 전송]
 1. editinput  (regex) + Lua editInput     ← 입력창 텍스트에 적용. 결과가 그대로 message.data 로 **저장된다**.
[sendChat 시작]
 2. start 트리거 (Lua onStart / V2 start)    ← 메시지 배열을 만들기 전. 변수 초기화, cutchat 등. false 반환하면 전송 중단.
 3. editprocess (regex)                     ← 퍼스트 메시지와 **모든 턴 각각**에 적용해 요청용 텍스트를 만든다. 저장 안 됨. Lua 훅 없음.
 4. 프롬프트 조립 (템플릿·로어북·요약·depth prompt)
 5. Lua editRequest                          ← 완성된 요청 배열(OpenAIChat[]) 전체에 적용. 마지막 손질. 저장 안 됨.
[모델 응답]
 6. editoutput (regex) + Lua editOutput     ← 모델 출력에 적용. 결과가 message.data 로 **저장된다**. (스트리밍 중에도 매 청크 재적용, 최종본이 저장)
 7. output 트리거 (Lua onOutput / V2 output) ← 저장 직후. 변수 갱신, 후처리.
[화면 표시 — 매 렌더링마다]
 8. editdisplay (regex) + Lua editDisplay + display 트리거 ← 보여줄 때만. **저장 안 됨**. 스크롤·재렌더 때마다 다시 돈다.
```

기억할 것:
- **저장되는 것은 1(editinput)과 6(editoutput)뿐.** 챗 로그 원문에 태그가 남아 있다면 그건 editoutput 이 안 걷어낸 것이고, 화면에서만 안 보인다면 editdisplay 가 숨긴 것이다.
- **모델에게 가는 것은 3(editprocess)→5(editRequest) 를 거친 텍스트.** 화면용 장식(HTML·상태창)을 요청에서 빼려면 editprocess 로 지운다. editdisplay 는 요청에 영향이 없다.
- editdisplay 는 렌더링마다 실행되므로 무거운 정규식은 스크롤을 느리게 한다. 캐시(같은 입력·같은 스크립트면 재사용)가 있긴 하다.
- Lua 편집 훅은 같은 단계의 **정규식보다 먼저** 돈다(processScriptFull: `runLuaEditTrigger` → 플러그인 훅 → 정규식 → 동적 에셋). editprocess 단계에는 Lua 훅이 없다(editRequest 가 그 자리).

# 2. 정규식 스크립트(customscript) 한 항목

```json
{ "comment": "이름", "type": "editdisplay", "in": "정규식", "out": "치환문", "flag": "g", "ableFlag": true }
```
- `type`: `editinput` | `editoutput` | `editprocess` | `editdisplay` (위 표 참고). 카드의 Regex 탭 = `customscript` 배열, **위→아래 순서로 적용**. 프리셋 정규식(`presetRegex`) → 카드 → 모듈 순으로 이어붙는다.
- `in` 이 비어 있으면 그 항목은 건너뛴다. `in` 은 JS `new RegExp(in, flag)` — JS 정규식 문법(lookbehind 됨, `\p{}` 는 u 플래그 필요).
- `flag`: `ableFlag` 가 true 일 때만 쓰이고 기본은 `g`. 허용 문자 `dgimsuvy` 외는 제거. `<…>` 안은 메타 명령(아래).
- `out`: `$1` `$&` `$<name>` 캡처 참조, `$n` 은 **줄바꿈으로 치환**됨(`\n` 이 아니라 리터럴 `$n`). `{{data}}` 는 매치 전체. `out` 이 `>` 로 끝나면 줄바꿈이 하나 붙는다(`<no_end_nl>` 로 끄기). 치환 결과에 CBS(`{{…}}`) 가 있으면 다시 파싱된다.
- `out` 의 특수 접두사 `@@…` (또는 flag 의 `<…>` 메타):
  - `@@emo 이름` — 매치되면 감정 이미지 `이름` 을 띄운다(치환 없음).
  - `@@inject` — 매치된 텍스트를 저장본에서 지우고(요청/표시 대상에서 제거) 메시지에 기록. chatID 있는 단계에서만.
  - `@@move_top …` / `@@move_bottom …` — 매치를 잘라내 본문 맨 위/아래로 옮긴다(캡처 참조 가능). 이때 g 플래그는 무시.
  - `@@repeat_back [end|start|end_nl|start_nl]` — 이번 턴에 매치가 **없으면** 같은 역할의 직전 턴에서 매치를 찾아 붙인다(상태창 유지용).
- flag 의 `<…>`: `<order N>` 실행 순서(클수록 먼저, 하나라도 있으면 전체를 order 로 정렬), `<cbs>` `in` 에 CBS 먼저 적용, `<move_top>` `<move_bottom>` `<inject>` `<repeat_back>` `<no_end_nl>` 은 `@@` 와 같다. 여러 개는 쉼표로.
- 동적 에셋(`dynamicAssets` 설정)은 editoutput/editdisplay 뒤에 `{{asset::…}}`/`<img>` 이름을 유사도로 맞춘다 — editinput/editprocess 에는 안 붙는다.

# 3. Lua 트리거 훅 (triggerscript, `effect[0].type == "triggerlua"`)

- 한 카드에 Lua 스크립트 **하나**. `function onStart(triggerId)`, `function onOutput(triggerId)`, `onInput(triggerId)`, `onButtonClick(triggerId, data)` 는 전역 함수로 정의하면 자동 호출.
- 편집 훅은 `listenEdit(type, fn)` 로 등록: `editInput(triggerId, text)`, `editOutput(triggerId, text)`, `editDisplay(triggerId, text)` 는 문자열을 받아 **문자열을 반환**해야 한다(안 하면 변경 없음). `editRequest(triggerId, messages, meta)` 는 `{role, content}` 배열을 받아 배열을 반환.
- 등록 순서대로 실행되고, 같은 단계의 정규식보다 먼저 돈다. onStart 가 `false` 를 반환하면 전송이 중단된다.
- `editRequest` 는 모델에게 가는 마지막 형태를 바꾸는 유일한 Lua 자리다(시스템 프롬프트 주입, 특정 턴 삭제 등). 화면과 저장본에는 영향이 없다.
- 세부 API(getVar/setVar, getChat/setChat, log 등)는 스킬 "RisuAI Lua 트리거" 를 불러 본다.

# 4. 흔한 오진단

| 증상 | 원인 | 고칠 곳 |
|---|---|---|
| 상태창 HTML 이 요청 토큰을 먹는다 | editdisplay 로만 꾸미고 editprocess 로 안 뺐다 | 같은 패턴의 `editprocess` 항목(out 비움) 추가 |
| 챗 로그를 내보내니 태그가 그대로 있다 | editdisplay 는 저장을 안 바꾼다 | 저장본까지 정리하려면 `editoutput` (앞으로) + 기존 턴은 Risu Hina 의 찾기·바꾸기 |
| 유저 입력이 저장될 때 이미 바뀌어 있다 | editinput 은 저장 전에 적용된다 | 의도가 아니면 editinput 을 editprocess 로 |
| 정규식이 첫 매치만 바꾼다 | ableFlag=true 인데 flag 에 g 가 없다 | flag 에 `g` (또는 ableFlag=false 로 기본 g) |
| `$n` 을 썼는데 줄바꿈이 된다 | `$n` 은 예약(줄바꿈) | `$1`~`$9` 만 캡처, 이름은 `$<name>` |
| Lua 훅이 값을 안 바꾼다 | 반환을 안 했거나 삼항 인자를 기대 | 문자열을 `return` 하라 (editOutput 은 인자 2개) |
