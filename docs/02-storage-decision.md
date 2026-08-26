# 02. 저장소 결정 — DB 정본, 캐릭터 단위 워크스페이스

2026-08-23. 계획서 §4(파일 기반 워크스페이스)를 뒤집는다. Phase 2 UI를 얹기 전에 결정했다.

## 계기

목표 잡이 단일 챗 소편집만이 아니라는 것이 확인됐다.

- **소** — 턴 하나 고쳐 되돌려쓰기
- **중** — **여러 턴에 걸친 수정**(한 챗 안에서 100~300턴 일괄 치환 등). 이것이 중규모의 본체다.
  한 봇의 여러 챗 사이 일관성은 실제로는 드문 시나리오다(사용자 정정, 2026-08-23)
- **대** — 앞 턴들을 **요약해 로어북화**하고 그 턴들을 **잘라내기**("요약 챗 이사")

이 셋 중 **하나만** 기존 구조에서 돌았다.

## 감사 결과 — 구멍 3개

| # | 문제 | 원인 |
|---|---|---|
| 1 | 교차 챗 작업이 안 된다 | 워크스페이스가 `chat_key` 단위라 챗 하나가 섬. **호스트의 저장 단위는 캐릭터**인데 구조가 어긋나 있었다 |
| 2 | 로어북 쓰기 경로가 없다 | `lore.json`이 참고용으로만 존재 |
| 3 | 구조 편집이 되돌아가지 않는다 | `patch()`가 `removed[]`를 계산만 하고, 쓰기 경로는 본문 편집만 적용 |

## 호스트 제약 재확인 (`globalApi.svelte.ts:360-366`)

자동저장 `$effect`가 선택된 캐릭터의 **`chats` 배열 전체**와 **`chats` 외 모든 키**를 스냅샷한다. 따라서

- 한 캐릭터 안 **여러 챗** 동시 편집 → 저장됨 ✓
- `globalLore` 쓰기 → 저장됨 ✓ (로어북화 성립)
- 캐릭터를 넘나드는 편집 → 여전히 안 됨 ✗

**그래서 워크스페이스 단위는 캐릭터여야 한다.** 잡의 모양과 호스트의 저장 단위가 그때 일치한다.

## 결정 — DB가 턴의 정본

**turns 테이블(seq 순서)이 정본. 마크다운은 파생 산출물.**

근거 셋:

1. **목표 잡이 질의 모양이다.** "이 봇의 4개 챗에서 X를 언급한 턴 전부"는 SQL 한 줄, 4MB짜리 md 여러 개 grep은 고통. FTS5가 stdlib에 있다.
2. **구조 편집은 행 연산이다.** 턴 1~200 삭제·병합·분할·재정렬은 `seq` 컬럼이면 자명하고, 4MB 문자열 수술로 하면 **조용한 손상**이 사는 자리가 된다. 하물며 그 문자열은 LLM도 같이 쓴다.
3. **에이전트의 Python이 DB를 쓰는 게 오히려 쉽다.** `sqlite3`는 stdlib이고 `run_python`은 무제한. 흔한 조작은 헬퍼로 감싸고 질의는 SQL을 직접 쓰게 둔다.

### 양쪽을 정본으로 두지 않는다

동기화 모호성("지금 어느 쪽이 맞나")이 최악이다. **단방향으로 못 박았다:**

- `working/messages.md` — **없앴다.** DB가 턴을 소유한다.
- `original/<chat_key>.md` — 동결 스냅샷. 재생성하지 않는다(그게 원본이니까).
- `out/*.md` — 필요할 때 DB에서 생성.

`chatfmt.py`는 죽지 않고 **경계 코덱**이 됐다 — 챗 JSON → DB 넣을 때, DB → md/risuChat 뺄 때.
기존 40여 검사가 그대로 유효하다.

## 결과 구조

```
data/risuhina.db
  characters(char_key, cha_id, name, char_index, card_json)
  chats(chat_key, char_key, chat_id, chat_index, meta_json, orig_count)
  turns(chat_key, seq, msg_id, role, body, time, name, extras_json, origin)   ← 정본
  turns_original(chat_key, seq, msg_id, ...)                                  ← 동결
  lore_entries(char_key, scope, chat_key, seq, entry_json, origin)
  turns_fts (external content, trigram, INSERT/UPDATE/DELETE 트리거 3종)
  + sessions / agent_messages / staged_edits / checkpoints / cost_ledger / jobs

data/workspace/<char_key>/
  card.md  lore.json
  original/<chat_key>.md  original/<chat_key>.hypa.json
  scripts/  out/
```

### 설계 규칙 4가지

1. **턴은 `msg_id`(=`Message.chatId`)로 조준한다. 위치로 조준하지 않는다.**
   `seq`는 삽입·삭제마다 재번호되고, 사용자가 RisuAI에서 편집하면 호스트 쪽 배열도 밀린다.
   `msg_id`는 둘 다 견디고, 하이파 `chatMemos`가 조인하는 키이기도 하다.
2. **`seq`는 조밀한 정수 + 재번호.** 분수 인덱스는 충분히 쪼개면 정밀도가 흔들린다. 수백 행 재번호는 공짜다.
   (유니크 인덱스 때문에 음수 구간을 거쳐 두 번 도는 것에 주의 — 한 번에 밀면 중간에 충돌한다.)
3. **병합은 첫 턴의 정체성을 유지한다.** 새 id를 발급하면 그 턴을 인용하던 하이파 요약과 우리 패치 조준이
   전부 고아가 된다 — 사용자가 요청한 것보다 훨씬 큰 편집이 된다.
4. **구조가 바뀌면 패치가 전체 배열을 싣는다.** 턴별 패치로는 삭제·삽입·재정렬을 표현할 수 없다.
   클라이언트는 `structural` 플래그를 보고 분기하지, 리스트가 비었는지로 추측하지 않는다.

## 부수 효과 — 하이파 고아 경고

턴을 자르면 그 턴을 인용하던 `hypaV3Data.summaries[].chatMemos`가 고아가 된다.
**이 기능이 존재하는 이유가 바로 그 잡이므로** 조용히 넘어갈 수 없다.
`store.patch()`가 구조 변경 시 고아 수를 세어 경고로 올린다.

## FTS 함정 (active-recall에서 이미 푼 것)

trigram은 **3자 미만 질의를 원리적으로 못 잡는다.** 그런데 한국어 서사 어휘는 2음절이 많다
(몰수·포상·약속·폐허). `store.search()`가 **항 단위로** 분기한다 — 3자 이상은 FTS, 미만은 LIKE.
테스트에 `폐허` 케이스가 박혀 있다.

또 turns는 UPDATE/DELETE가 있으므로 external-content 인덱스에 **트리거 3종이 전부 필요**하다.
active-recall은 blobs가 insert-only라 AFTER INSERT 하나로 끝났지만 여기는 아니다.

## 비용

`workspace.py` 재작성, `main.py` 라우트 확장(12 → 21개), 테스트 갱신. 게이트 ALL GREEN.
UI를 얹기 전이라 가장 싼 시점이었다.
