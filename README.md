# Risu Hina

RisuAI 챗을 **끝난 뒤에** 고치는 도구. 플러그인 화면 안에서 대화를 통째로 펼쳐 놓고,
직접 고치거나 AI 에이전트에게 시킨다.

## 무엇을 할 수 있나

- **턴 편집** — 좌측에 전체 대화, 턴 번호·시각·수정 여부. 인라인 편집, 전-후 diff.
- **범위 작업** — 찾기·바꾸기, 구간 삭제, 표시 범위 필터. 전부 미리보기 후 승인.
- **AI 에이전트** — 대화 전체를 컨텍스트에 올리지 않는다. 목록·검색·범위 읽기 툴로 접근하고,
  수정은 **제안만** 한다. 승인해야 반영된다.
- **챗 로어북 · 장기기억** — 하이파/수파 요약을 항목별로 읽고 고친다. 원본 대비 diff.
- **워크스페이스 파일** — 참고 파일 업로드, AI가 만든 결과물 내려받기.
- **RisuAI에 반영** — 낙관적 동시성 검사 후 제자리 쓰기. 복사본 저장도 가능.

## 구조

```
RisuAI / PocketRisu (브라우저)
 └─ 플러그인 iframe  ── risu-hina.js
      │  Risuai.getChatFromIndex / setChatToIndex / ...
      └─ Risuai.nativeFetch          ← CSP connect-src 'none' 이라 유일한 통로
             ▼
      pyserver  127.0.0.1:6020   FastAPI + Pydantic AI + SQLite
             ├─ data/workspace/<char>/   원문·업로드·스크립트·산출물
             └─ data/risuhina.db          턴·로어북·장기기억·세션·승인 큐
```

**턴의 정본은 DB다.** 마크다운은 파생물이다. 목표 작업이 질의형("이 네 챗에서 인물이 신전에
있다고 한 턴 전부")이고 구조 파괴적("앞 200턴을 요약해 로어북에 넣고 지우기)이라, 둘 다
멀티메가바이트 문서 위의 문자열 수술이 아니라 한 줄의 SQL이 된다.

**워크스페이스는 챗이 아니라 캐릭터 단위다.** RisuAI의 자동저장이 선택된 캐릭터의 `chats`
배열 전체를 스냅샷하므로, 한 캐릭터 안에서는 교차 챗 편집과 `globalLore` 쓰기가 저장된다.

## 안전장치

- **에이전트는 전사에 직접 쓰지 못한다.** 스테이징 테이블에 제안하고, 사람이 승인해야 적용된다.
- **전사 밖의 쓰기도 전부 승인 큐를 지난다** (로어북·장기기억·스냅샷·RisuAI 반영·복사본 저장).
  지시가 아니라 구조다 — 툴이 물리적으로 쓸 수 없다.
- **에이전트 파이썬은 워크스페이스 밖으로 나가지 못한다.** 감사 훅(`sys.addaudithook`)이
  바깥 쓰기·읽기·프로세스 생성을 거부하고, DB는 그 캐릭터의 행만 담은 읽기 전용 스냅샷으로 준다.
  다른 봇의 데이터는 걸러지는 게 아니라 **파일에 없다**.
- **비루프백 접근은 토큰이 강제된다.** 설정으로 끌 수 없다.

## 설치

[릴리스](../../releases/latest)에서 **`Risu.Hina.<버전>.Auto.Install.Package.zip` 하나만** 받으면 된다.
플러그인도 그 안에 들어 있다.

```
risu-hina/
  pyserver/       백엔드 코드
  plugin/         RisuAI 에 설치할 플러그인
  data/           DB · 설정 · 토큰 · 워크스페이스
  setup.bat  uninstall.bat      (Windows)
  setup.sh   uninstall.sh       (Linux)
  README.md
```

원하는 폴더에 풀고 — 폴더 이름이 `risu-hina` 일 필요도 없다 —

```powershell
setup.bat                    # Windows. 파이썬을 찾아 venv 를 만들고 띄운다
setup.bat -Service           # 재부팅해도 살아 있게 (NSSM, 관리자 권한)
```

```bash
chmod +x *.sh && ./setup.sh   # Linux
./setup.sh --service          # pm2
```

그다음 `plugin/Risu.Hina.Plugin.js` 를 RisuAI 플러그인 화면에 넣고, 챗 화면의 **Risu Hina** 버튼을
열어 오른쪽 위 ⚙ → **연결**에 백엔드 URL(같은 기계면 `http://127.0.0.1:6020`),
**에이전트 → 수정**에 모델 자격증명을 넣는다.

**푸는 것보다 먼저 `SHA256SUMS-<버전>.txt` 로 해시를 확인한다.** 받은 내용이 곧 돌아갈 서버가 된다.

설치 위치·데이터 위치·포트·인터프리터를 바꾸는 법은 압축 안의 `README.md` 와
[docs/05-install.md](docs/05-install.md)에 있다.

### 업데이트 순서

**① RisuAI 플러그인 화면에서 플러그인 → ② 플러그인 ⚙ → 정보 · 로그에서 백엔드.**

이 순서여서 `//@update-url` 이 로컬 백엔드가 아니라 GitHub 릴리스를 가리킨다.
백엔드를 가리키면 순환이 된다 — 플러그인 업데이트가 먼저인데 그게 백엔드가 살아 있고
최신이어야 가능해진다.

## 개발

```
bash tests/gate.sh      # 8단계. ALL GREEN 아니면 배포하지 않는다
```

chatfmt 왕복 · HTTP 블랙박스 · 워크스페이스 격리 · 에이전트 E2E(실모델) ·
플러그인 타입체크/빌드/스모크(실제 DOM + 실제 백엔드) · 프로브 문법.

설계 결정과 그 이유는 [`docs/`](docs/)에 있다. 특히 [04](docs/04-workspace-confinement.md)가
샌드박스·승인 큐·스킬·업데이트의 정본이다.
지금 어디까지 됐는지는 [06](docs/06-status.md)에 있다 — 이어서 일할 때 먼저 읽는 한 장.
