# 01. Phase 0 실측 결과 (완료)

프로브 v0.2.0, 2026-08-23, PocketRisu(test-server 0.0.0.0:6001) + 별도 PC 브라우저.
백엔드 `127.0.0.1:6020`. 실제 챗(394턴)에서 실행.

**결론: 계획서 §1 제약 표는 전부 확증됐고, 스트리밍은 된다. 아키텍처 변경 없음.**

## 1. 확증된 것

| 검사 | 결과 |
|---|---|
| T-01 런타임 | `platform=node · saveMethod=local · api=3.0` |
| T-02 직접 fetch | **차단** — 모든 통신은 `nativeFetch` 단일 통로 |
| T-03 eval / new Function | **차단** — 번들러가 `eval`을 쓰면 안 된다 |
| T-04 data: 이미지 | **렌더됨** (PocketRisu 한정) |
| T-05a/b `/health` | 도달 · `client_ip=127.0.0.1` · `relay=none` |
| T-06 토큰 게이트 | 무토큰 401 / 유토큰 200 |
| T-08 큰 페이로드 | 512KB↑ · 1MB↓ |
| T-09 Blob 다운로드 | 성공, UTF-8 한글 무손상 |
| T-10 pluginStorage | 구조화 값 그대로 왕복 |
| T-12 챗 쓰기 | 커스텀 속성 왕복 + 메시지 무손상 + 흔적 제거 |
| T-13 없는 인덱스 쓰기 | 무시됨 — 챗 추가는 `setCharacterToIndex` |

**PocketRisu CSP 실측 전문:** `script-src 'nonce-<uuid>' 'wasm-unsafe-eval'`.
메인라인의 `https:`가 **없다** — 외부 스크립트 로드가 원천 불가라 단일 파일 번들에 유리하다.
`factory.ts`가 부팅 직후 `meta#csp-meta`를 지우는데도 정책이 살아 있음이 이걸로 확인됐다.

## 2. 스트리밍 — 된다. 단, 경로를 골라야 한다

| 경로 | headers_ms | 도착 패턴 | 판정 |
|---|---|---|---|
| `local_network` · GET · ndjson | **289** | 290·534·785·1035·1285·1536 | **채택** |
| `local_network` · GET · sse | **286** | 286·532·784·1033·1284·1535 | 동등 (이점 없음) |
| `auto` (networkRoute 없음) | **2318** | 2319·2563·… | 흐르지만 **첫 바이트까지 2.3초 낭비** |
| `local_network` · POST · `interceptor:'openai_streaming'` | 1124 | 1124·1124·1124·1124·1284·1534 | **버퍼링 — 쓰지 말 것** |

**설계 확정 3가지**

1. **모든 요청에 `networkRoute:'local_network'`를 붙인다.** 빼면 브라우저가 먼저 직접 fetch를
   시도하고 실패한 뒤에야 `/proxy2`로 폴백한다(`globalApi.svelte.ts:2108-`). 매 요청 **약 2초** 손해다.
2. **`interceptor:'openai_streaming'`을 쓰지 않는다.** 그게 WS proxy-job 경로를 태우는데
   (`globalApi.svelte.ts:2080-2097`), 그 경로가 앞 4청크를 뭉쳐서 보낸다. 평범한 `/proxy2`가 더 낫다.
3. **NDJSON으로 간다.** SSE와 성능이 같고 파싱이 단순하다.

### v0.1.0의 "버퍼링"은 프로브 서버 버그였다

원인은 RisuAI가 아니라 **우리 프로브 서버의 수동 chunked 응답 + HTTP/1.1 keep-alive**였다.
`BaseHTTPRequestHandler`는 우리가 직접 프레이밍한다는 걸 모르므로 소켓을 재사용하게 두고,
그 상태에서 상류 undici가 본문을 끝까지 모은 뒤에야 헤더를 내줬다.
`Connection: close` + `close_connection = True`를 넣자 289ms에 첫 바이트가 왔다.

**본체 함의:** uvicorn은 chunked를 제대로 처리하므로 재발하지 않을 가능성이 높지만,
NDJSON 엔드포인트를 만들면 **첫 배포에서 headers_ms를 반드시 실측**할 것. 소스 독해로는
어느 계층도 버퍼링하지 않았고 실제로는 뭉쳤다.

## 3. 실제 챗에서 나온 것 — 계획 보강 2건

T-11: `char=17 chat=0 · 턴 394개 · chatId 보유 394/394 · 메모리=hypaV3`

**Chat 객체의 실제 키 (394턴 실챗):**
```
message, note, name, localLore, fmIndex, id, useModelPreset, modelBinding,
scriptstate, bindedBotPreset, bindedPersona, supaMemory, hypaV3Data,
savedToggleValues, modules, isStreaming, arKey, activeStreamingDisplayOptimizationMode
```

**① 인터페이스에 없는 필드가 6개 이상 실려 있다.** `useModelPreset`·`modelBinding`·
`bindedBotPreset`·`savedToggleValues`·`activeStreamingDisplayOptimizationMode`는
**PocketRisu가 추가한 필드로, web RisuAI에는 없다**(사용자 확인). 그리고 `arKey`는
**active-recall이 심은 각인**이다 — 즉 이 챗 객체에는 *호스트 포크의 확장*과 *다른 플러그인의
데이터*가 함께 얹혀 있다.

→ **계약은 양방향이다.**
- **보존:** `chatfmt`는 화이트리스트를 쓰면 안 된다. `message`만 빼고 전부 그대로 보존하고
  encode 때 되돌린다. 모르는 필드를 떨구면 남의 플러그인 데이터와 호스트 설정을 조용히 파괴한다.
- **날조 금지:** web RisuAI에서 온 챗을 왕복시켰는데 PocketRisu 전용 필드가 붙어 나가면,
  그 챗을 PocketRisu에서 열 때 조용히 동작이 바뀐다. 있는 것만 보존하고 **없는 것은 만들지 않는다.**

`tests/test_roundtrip.py`의 `test_never_invents_fields`가 web RisuAI 형태의 챗으로 키 집합
동일성을 봉투·챗·메시지 세 층위에서 못 박는다. 계획 §4는 "message 외 Chat 필드 전부"라고만
적었는데, 이 실측이 그 문장을 양방향 계약으로 만든다.

**② `chatId`가 394/394 채워져 있다.** 하이파 `chatMemos` 조인과 우리 패치 조준이 모두 성립한다.

T-14: `Parma Knights · 챗 2개 / 총 394턴 · 로어 81 · 인사말 1 · **51ms** ·
desc 6439자 · firstMessage 5934자`

→ **`getCharacterFromIndex`가 51ms.** 챗 선택 탭에서 매번 불러도 되는 비용이다.
active-recall이 경계했던 "폰 킬러"는 `getDatabase(['characters'])`(전 캐릭터)이지 이쪽이 아니다.

## 4. 계획서 정정 사항

- **`getCurrentChatIndex()`는 캐릭터 미선택 시 null이 아니라 던진다**
  (`db.characters[selectedCharID].chatPage`, `v3.svelte.ts:805-809`). 본체도 반드시 감쌀 것.
- **`networkRoute:'local_network'`는 선택이 아니라 필수**(위 2번).
- Python은 **동봉(standalone)**. "서버에 3.11.9가 있으니 그걸 쓴다"는 근거는 폐기 — `docs/00` 참조.

## 5. 남은 미측정 2건 (Phase 1~2에서 자연히 해소)

- **4MB급 페이로드.** 실챗이 394턴이고 active-recall 실측상 372메시지 챗이 원문 4.1MB였다.
  T-08은 512KB↑/1MB↓까지만 쟀다. `/proxy2`는 `express.json({limit:'100mb'})`이고 브리지는
  structured clone이라 양적 차이일 뿐이라고 보지만, **Phase 2에서 실챗을 처음 올릴 때 실측**한다.
  그때 막히면 청크 업로드로 간다(지금 미리 만들지는 않는다).
- **메인라인 web RisuAI** — T-04(이미지 차단 여부)와 §7.1(토큰 누출 방지·혼합 콘텐츠).
  PocketRisu가 주 경로이므로 뒤로 미룬다.

## 6. 프로브 자신에게서 나온 함정 2건 (본체에서 반복 금지)

1. **`res.json()` 실패 후 `res.text()` 폴백은 불가능하다** — 본문이 이미 소비돼
   `Body has already been read`라는 무관한 오류가 나온다. 한 번만 읽고 파싱한다.
2. **수동 chunked 뒤 keep-alive 연결이 오염된다** — 스트림 4연발 뒤 `/big`이 잘려
   "다운로드가 이상하다"로 **오진됐다**. 증상이 원인과 전혀 다른 곳에 나타난다.
