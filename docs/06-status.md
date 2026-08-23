# 06. 구현 상태 — 2026-08-23 기준

내일 이어서 할 사람(=나)을 위한 한 장. 무엇이 있고, 오늘 무엇이 바뀌었고, 어디까지 배포됐고,
무엇이 남았는지. 설계의 *이유*는 `docs/04`, 저장 구조는 `docs/02`, 배포 환경은 `docs/00`.

## 1. 지금 있는 것 (한눈에)

```
RisuAI(PocketRisu) ── 플러그인 iframe(risu-elf.js) ──nativeFetch──▶ 백엔드 127.0.0.1:6020 (FastAPI)
                                                                   ├─ data/risuelf.db   턴·로어북·기억·변수·세션·승인 큐·스냅샷
                                                                   ├─ data/workspace/<char>/  card.md · original/ · out/ · scratch/ · skills/(실행 시 복사)
                                                                   ├─ data/skills/<id>/SKILL.md  폴더형 스킬
                                                                   └─ Pydantic AI 에이전트 (OpenAI 호환 게이트웨이)
```

**플러그인 탭**: `챗 선택 | 챗 에딧 | 챗 로어북 | 장기기억 | 챗 변수 ┃ 워크스페이스 파일` (+ 헤더의 ⚙ 설정).
챗 탭 4개 위에 **공유 챗바** `반영 · 스냅샷 · 버전 · 변경 요약`.

**한 구조, 네 재료** — 턴 · 챗 로어북(local) · 장기기억 · 챗 변수(`scriptstate`)는 전부
*작업본 vs 기준선 → `GET /patch` 하나 → `host.writeChat` 의 `setChatToIndex` **한 번** → `POST /commit` 이 기준선 전부 이동*.
스냅샷(`/checkpoint`)도 넷을 한 단위로 저장·복원한다. 변경 집계는 `GET /changes`.

**에이전트**: 읽기 툴(list/read/search_turns, read_card/lore/memory, list/load_skill, read_file) + 제안 툴
(`stage_*` 전사 수정, `propose_*` 로어북·기억·스냅샷·반영·복사본) + `run_python`(워크스페이스 격리).
**쓰기는 전부 승인 큐** — 툴이 직접 쓸 수 없다.

## 2. 오늘(2026-08-23) 바뀐 것

| # | 무엇 | 어디 |
|---|---|---|
| 1 | Ollama 클라우드 baseUrl 은 `https://ollama.com/v1` (`api.ollama.com` 은 301). `/config/test` 가 3xx·비JSON 을 설명 | `main.py h_config_test` |
| 2 | 지시문: 채팅 동의엔 "승인" 단어 금지 · 함께 가는 제안은 한 턴에 · "승인해 주시면 이어서" 후 멈추기 금지 | `agent.py INSTRUCTIONS` |
| 3 | **공유 챗바**(모든 챗 탭). 에디터의 반영/버전/스냅샷, 장기기억 탭의 별도 반영 제거 | `ui/chatbar.ts`, `shell.ts` |
| 4 | **로어북 쓰기 경로 신설**(이전엔 플러그인에 없었다). `original_json`·소프트 삭제(`origin='deleted'`)·`rebase_lore`·재업로드 시 `workingReset` 규칙(중복 버그 수정) | `store.py`, `host.ts writeChat` |
| 5 | 스냅샷이 로어북·기억·변수까지(`checkpoints.lore_json/memory_json`) | `snapshots.py` |
| 6 | `GET /changes` 집계(턴·로어북·기억·변수·대기 제안) | `main.py` |
| 7 | 에이전트 패널 고정 다운로드 카드 → 로그 한 줄(클릭→파일 탭) + 파일 탭 뱃지 + 자동 갱신. `scratch/`·`scripts/` 의 문서형만 "임시 문서"로 노출, 내부 파일은 접힘 유지 | `ui/agent.ts`, `tab-files.ts` |
| 8 | **챗 변수 탭**: `scriptstate` 를 `memories` kind=`scriptstate` 로(키=제목, 값=본문, 타입 보존) | `memory.py`, `ui/tab-vars.ts` |
| 9 | **폴더형 스킬**: `data/skills/<id>/SKILL.md` + `references/`·`scripts/`. 프롬프트엔 카탈로그만, 본문은 `load_skill` 툴(패널에 `🧩 스킬: …` 칩). `always: true` 만 상시. 옛 DB 행은 기동 시 폴더로 이전 | `skills.py`, `ui/skills.ts`, `pyexec.install_skills` |
| 10 | 기동/종료 `wal_checkpoint(TRUNCATE)` + **고아 WAL 프레임 경고·사본 보존** (§4 사고) | `db.py _wal_report` |
| 11 | UI 자잘: 버튼 `white-space: nowrap`, 결과 박스 `.outbox` 여백, 파일 탭 구분선·개명, 챗 선택 탭엔 챗바 없음 | `styles.ts` 등 |

테스트: `test_unified_writeback`, `test_chat_variables`, 스킬 테스트 3개 재작성, 스모크에 챗바·챗 변수·스킬 UI·파일 탭 검사 추가.
게이트 `bash tests/gate.sh` **ALL GREEN** (실모델 E2E 포함) 상태로 커밋.

## 3. 배포 상태

- **test-server `D:\code\risu-elf`** — 2026-08-23 22:54 이 커밋과 같은 `pyserver/app` + `plugin/risu-elf.js`.
  백업 `pyserver\app.bak-20260823-22*`, `plugin\risu-elf.js.bak-*`. 기동 `powershell -File D:\code\risu-elf\pyserver\manage.ps1 -Action start|stop|status`.
- 배포 절차(검증됨): `_stage\` 에 `app/*.py`·`app/seeds`·`risu-elf.js` 를 scp → ASCII `.ps1` 이 stop → `app.bak-<시각>` → 교체 → start → **새 SSH 세션**에서 `/health`.
- **플러그인 본체는 사용자가 RisuAI 에 재설치**(`plugin/dist/risu-elf-0.1.0.js`). GitHub 릴리스 v0.1.0 에는 오늘 변경이 없다 → 다음 릴리스 필요.
- 원격 스킬 8개 전부 켜 둠(카탈로그 1,001자). Ollama 프리셋 `[Ollama] GLM` = `ollama.com/v1`, `glm-5.2:cloud`, flex/cache 끔, reasoning ''.

## 4. 오늘의 사고 — DB 가 17:47 로 돌아감

dev 설치본의 `data/` 를 `-wal`·`-shm` 째 새 설치본에 복사한 뒤 기동한 서버가, 낡은 wal-index 를 믿고
커밋을 WAL 헤더 체인 밖(낯선 salt)에 썼다. 그 프로세스는 읽을 수 있었고, 다음 재시작이 그 60커밋을 버렸다.
사라진 것: 21:13~22 프리셋 수정(복구함), 21:25 테스트 세션, 승인된 로어북 6건(본문은 `out/out_summary_lorebook_draft.md`).
증거 `data/forensic-20260823/`, `data/orphaned-wal-20260823-221737.db-wal`. 규칙: **`data/` 는 서버를 멈추고 옮긴다.** (`docs/00`)

## 5. 내일 이어서 할 것

1. **릴리스** — `python tools/release.py` 로 v0.1.1(플러그인 + 백엔드 zip + SHA256SUMS). 오늘 변경은 릴리스 자산에 없다.
2. **스킬 설명 다듬기** — 이전된 "요약 이사"·"말투 통일"의 description 이 본문 첫 문장 그대로다. 트리거 문구로 고치기(설정 → 스킬 → 수정).
3. **실사용 확인** — 새 플러그인으로: 챗바 반영(로어북·변수 포함), 챗 변수 탭 편집→반영→RisuAI `{{getvar}}` 확인, `load_skill` 칩이 보이는지.
4. **테스트 챗 복구** — 사라진 로어북 6건: 에이전트에게 `out/` 초안을 읽혀 `propose_lore_add` 로 다시 넣기.
5. 미결: 봇(카드) 단위 로어북(global) 쓰기 경로는 아직 없음(`/lore/patch` 의 `globalLore` 는 플러그인이 안 씀). 메인라인 web RisuAI 미측정.
6. 로컬 폴더 `C:\code\real-ooc` → `risu-elf` 개명(세션 시작 시).

## 6. 빠른 명령

```
bash tests/gate.sh                               # 8단계 게이트. ALL GREEN 아니면 배포 금지
node plugin/build.config.mjs                     # 플러그인 빌드 → plugin/dist/risu-elf-0.1.0.js
ssh test-server "curl.exe -s http://127.0.0.1:6020/health"     # 원격 확인(로컬 curl 은 내 PC다)
ssh test-server "curl.exe -s \"http://127.0.0.1:6020/changes?chatKey=<tk>\""
ssh test-server "curl.exe -s http://127.0.0.1:6020/skills/preview"  # 에이전트가 보는 스킬 카탈로그
```
