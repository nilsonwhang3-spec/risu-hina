# Phase 0 — 호스트 능력 실측 프로브

계획서(`docs/`에 사본, 원본은 플랜 파일) §1의 제약 표와 §9 Phase 0 목록은 **소스 독해**로
세운 주장이다. 이 폴더는 그 주장들을 **실제 RisuAI에서** 확인한다. 여기 결과가 나오기 전에는
플러그인 본체를 짜지 않는다.

버리는 코드다. Phase 1이 시작되면 `probe/`는 지운다.

## 구성

| 파일 | 역할 |
|---|---|
| `probe_server.py` | 표준 라이브러리만 쓰는 백엔드. venv 없이 시스템 Python으로 돈다 |
| `risu-elf-probe.js` | RisuAI v3 플러그인. 14개 검사를 실행하고 결과를 화면에 띄운다 |
| `start_probe.bat` | 런처. 인용과 리디렉션을 전부 자기가 소유한다 |
| `probe_ctl.ps1` | 원격 제어 (`start`/`stop`/`status`/`restart`) |
| `../tests/probe_smoke.mjs` | 스텁 호스트로 플러그인을 실제 실행해 ReferenceError를 잡는다 |

## 현재 상태 (2026-08-23)

**test-server에 배포 완료, 가동 중.**

```
D:\code\risu-elf\probe\    127.0.0.1:6020
토큰: probe-f27f72245ef32d28
```

## 사용법

### 1. 백엔드 (이미 떠 있으면 생략)

```powershell
ssh test-server "powershell -ExecutionPolicy Bypass -NoProfile -File D:\code\risu-elf\probe\probe_ctl.ps1 -Action status"
ssh test-server "powershell -ExecutionPolicy Bypass -NoProfile -File D:\code\risu-elf\probe\probe_ctl.ps1 -Action restart -Token <토큰>"
ssh test-server "powershell -ExecutionPolicy Bypass -NoProfile -File D:\code\risu-elf\probe\probe_ctl.ps1 -Action stop"
```

로컬에서 돌릴 때는 그냥:

```
python probe_server.py --port 6020 --token <토큰>
```

### 2. 플러그인

1. PocketRisu → 설정 → 플러그인 → **플러그인 가져오기** → `probe/risu-elf-probe.js`
2. 플러그인 인자 두 개를 채운다.
   - `backend_url` = `http://127.0.0.1:6020`
     (PocketRisu 서버 입장의 127.0.0.1이다. 브라우저가 도는 이 PC가 아니다 —
     `networkRoute:'local_network'`로 PocketRisu의 `/proxy2`가 대신 요청하기 때문)
   - `backend_token` = 위 토큰
3. **F5로 새로고침** (플러그인 설치·수정 후에는 필수)
4. 설정 → 플러그인의 Risu Elf 아이콘, 또는 햄버거 메뉴 → **Risu Elf 프로브** → 자동 실행
5. **결과 복사** 버튼으로 텍스트를 받아 공유

## 검사 목록

| ID | 검사 | 확인하려는 계획서 주장 |
|---|---|---|
| T-01 | 런타임 정보 | platform이 node/web/tauri 중 무엇인가 — 라우팅 분기의 기준 |
| T-02 | 직접 fetch 차단 | §1 #3 CSP `connect-src 'none'`이 실제로 무는가 |
| T-03 | eval / new Function | 번들러가 eval을 쓰면 안 되는가 |
| T-04 | data: URI 이미지 | §1 #4 UI를 이미지 없이 짜야 하는가 |
| T-05a/b | `/health` auto·local_network | §1 #6 `/proxy2` 릴레이 경로가 서는가 |
| T-06 | 토큰 게이트 | §7.1 무토큰 401 / 유토큰 200 |
| T-07 | 스트리밍 | §1 #5 `Response.body`가 **점진적으로** 흐르는가 |
| T-08 | 큰 페이로드 | 512KB 업 / 1MB 다운이 브리지·프록시를 통과하는가 |
| T-09 | Blob 다운로드 | §1 #2 내보내기 경로 (자동 판정 불가 — 눈으로 확인) |
| T-10 | pluginStorage | 설정 보관소 왕복 |
| T-11 | 챗 읽기 | §1 #9 chatId 보유율, 하이파 유무 |
| T-12 | 챗 쓰기 (비파괴) | §5.3 쓰기 경로 |
| T-13 | 없는 인덱스 쓰기 | §1 #7 챗 추가가 정말 막히는가 |
| T-14 | 캐릭터 읽기 | 챗 목록·카드 원본과 **그 비용**(챗 선택 탭 설계 근거) |

## 안전

- **T-12는 메시지를 건드리지 않는다.** 챗 객체에 `realOocProbe` 속성을 심었다가 즉시 지운다.
  쓰기 경로와 영속성을 사용자 데이터 손상 없이 확인하기 위한 설계다.
- **T-13은 챗을 추가하지 않는다.** 없는 인덱스에 쓰면 호스트가 무시한다는 것을 확인할 뿐이고,
  만약 늘어났다면 그것 자체가 계획서 정정 사유이므로 WARN으로 보고하고 삭제를 안내한다.
- 파괴적 검사는 하나도 없다.

## 사전 검증

로컬에서 실제 백엔드를 띄우고 스텁 호스트로 플러그인을 통째로 실행한다.
`node --check`는 파싱만 증명하고 ReferenceError는 못 잡는다 — active-recall에서 그 부류의
버그가 라이브 챗까지 나간 적이 있어 하네스를 따로 둔다.

```bash
python probe_server.py --port 6021 --token testtok &
node tests/probe_smoke.mjs http://127.0.0.1:6021 testtok
```

하네스는 각 검사가 실제로 판정을 냈는지까지 확인하고, T-12가 흔적을 남기거나 메시지를
바꿨으면 실패시킨다.

## 삽질 기록 (같은 함정 반복 방지)

원격에 프로세스를 **떼어서** 띄우는 데 세 번 실패했다.

1. `Start-Process -ArgumentList '스크립트','--host',...` — 전부 argv 한 칸으로 들어가
   python이 `probe_server.py --host 127.0.0.1 ...`라는 이름의 파일을 찾았다.
   `probe.err.log`를 열기 전까지는 "성공했는데 왜 안 뜨지"로만 보였다.
2. `Win32_Process.Create`에 `cmd /c "따옴표 exe" args > "따옴표 로그"` — cmd가 바깥
   따옴표를 벗겨내는 규칙에 걸려 명령이 깨졌다.
3. `Start-Process`로 떴다 해도 **OpenSSH가 세션 종료 시 job 전체를 죽인다.**
   `Win32_Process.Create`는 WMI 서비스 밑에서 만들어져 세션 job 밖에 있다.

또 `netstat | Select-String ":6020 "`는 **TIME_WAIT 행에도 걸려서** 아무것도 바인딩돼
있지 않은데 "listening: 1"을 보고했다. `LISTENING`을 함께 매치해야 한다.

그리고 ssh → cmd → powershell 중첩 인용은 파이프와 따옴표를 매번 망가뜨린다.
**원격 실행은 `.ps1` 파일 + `-File`로 보낸다.** 그 `.ps1`은 ASCII 전용으로 쓴다
(PowerShell 5.1은 BOM 없는 UTF-8을 시스템 ANSI로 읽어 한글이 조용히 깨진다).
