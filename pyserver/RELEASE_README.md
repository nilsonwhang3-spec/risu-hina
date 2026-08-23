# Risu Elf

RisuAI 챗을 **끝난 뒤에** 고치는 도구. 대화를 통째로 펼쳐 놓고 직접 고치거나 AI에게 시킨다.

이 폴더가 백엔드다. 플러그인(`Risu.Elf.Plugin.js`)은 `plugin/` 안에 같이 들어 있고,
RisuAI 쪽에 따로 설치한다.

---

## 설치

### Windows

```
setup.bat
```

파이썬이 **동봉돼 있다.** 이 기계에 파이썬이 있든 없든, 무슨 버전이든 상관없이
`pyserver/python/` 안의 것으로만 돈다. `setup.bat` 은 그것이 제대로 뜨는지 확인하고
서버를 띄운다.

```
setup.bat -Port 6030            다른 포트
setup.bat -Service              재부팅해도 살아 있게 (NSSM 필요, 관리자 권한)
setup.bat -DataDir E:\elfdata   데이터를 다른 곳에
setup.bat -NoStart              설치만
```

### Linux

```
chmod +x *.sh
./setup.sh
```

```
./setup.sh --port 6030
./setup.sh --service            재부팅해도 살아 있게 (pm2 필요)
./setup.sh --data-dir /srv/elfdata
./setup.sh --no-start
```

> 파이썬을 설치할 필요가 없다. Ubuntu 20.04 처럼 시스템 파이썬이 3.8 인 기계에서도
> 그대로 돈다 — 동봉된 3.11 을 쓴다. 필요한 것은 glibc 2.28+ 뿐이다
> (Ubuntu 20.04 / Debian 10 이상이면 된다).

### 플러그인

`plugin/Risu.Elf.Plugin.js` 를 RisuAI 설정 → 플러그인 → Add Plugin 에 넣는다.
챗 화면에 **Risu Elf** 버튼이 생긴다.

열고 나서 오른쪽 위 ⚙ 에서:

1. **연결** — 백엔드 URL. 같은 기계면 `http://127.0.0.1:6020`
2. **에이전트 → 수정** — Base URL · Model · API Key 를 넣고 **연결 테스트**

테스트는 일반 응답과 **툴 호출을 따로** 확인한다. 툴 호출이 안 되면 에이전트가
동작할 수 없으므로 여기서 걸러야 한다.

---

## 폴더

```
pyserver/   백엔드 코드. 업데이트가 통째로 갈아끼운다
plugin/     RisuAI 에 설치할 플러그인
data/       DB · 설정 · 토큰 · 워크스페이스. 업데이트가 건드리지 않는다
```

이 분리가 자체 업데이트의 전제다. 데이터가 코드 안에 있으면 버전 교체가 매번
당신의 챗을 밟고 지나가야 한다.

**설치 폴더는 어디든 된다.** 이름이 `risu-elf` 일 필요도 없다 — 모든 경로를
스크립트가 자기 위치에서 계산한다.

---

## 토큰

`data/token.txt`. **같은 기계의 PocketRisu 에서 쓸 때는 필요 없다** — PocketRisu 의
노드 서버가 대신 요청하므로 백엔드가 보는 클라이언트 IP 는 언제나 127.0.0.1 이고,
루프백은 면제다.

web RisuAI 나 다른 기계에서 직접 붙을 때만 필요하고, 그 경우 토큰은 **강제**이며
설정으로 끌 수 없다.

`RISUELF_HOST=0.0.0.0` 으로 넓히는 것은 **토큰을 아는 사람에게 이 기계의 임의 코드
실행 권한을 주는 것과 같다** — 에이전트의 `run_python` 이 여기서 돈다. 넓혀야 한다면
Tailscale 같은 사설망 안으로만 하고, 공개 인터넷에는 바인딩하지 않는다.

---

## 상태 확인 · 문제 해결

```
powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action status
powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action restart
```

리눅스에서는 `pyserver/server.log` 를 보거나, pm2 를 쓴다면 `pm2 logs risu-elf`.

> 윈도우에서 `processes 2` 는 정상이다. venv 의 `Scripts\python.exe` 는
> `venvlauncher.exe` 라서 진짜 인터프리터를 자식으로 띄우고 자기는 부모로 남는다.
> 서버는 하나다 — `listening` 과 `health` 가 그것을 말한다.

로그와 진단 정보는 플러그인 안에서도 볼 수 있다: **⚙ → 정보 · 로그**.
문제를 신고할 때 그 화면의 **진단 정보** 와 **서버 로그** 를 함께 보내면 된다.
둘 다 API 키와 토큰을 담지 않는다.

| 증상 | 원인 |
|---|---|
| `GLIBC_2.28 not found` | 너무 오래된 리눅스. Ubuntu 20.04 / Debian 10 이상이 필요하다 |
| `listening NO`, 로그에 `WinError 10048` | 그 포트를 다른 것이 쓰고 있음 → 포트 변경 |
| 플러그인이 "백엔드 연결 안 됨" | URL 오타, 백엔드 미기동, web RisuAI 에서 토큰 미입력 |
| web RisuAI 에서만 실패 | RisuAI 설정의 **Use Plain Fetch** 를 켤 것. 꺼져 있으면 요청이 `sv.risuai.xyz` 로 릴레이되어 사설 주소에 닿지 않는다 |

---

## 업데이트

**① RisuAI 플러그인 화면에서 플러그인 → ② 플러그인 ⚙ → 정보 · 로그에서 백엔드.**

이 순서라서 플러그인의 `//@update-url` 이 로컬 백엔드가 아니라 GitHub 릴리스를
가리킨다. 백엔드를 가리키면 순환이 된다 — 플러그인 업데이트가 먼저인데 그게 백엔드가
살아 있고 최신이어야 가능해진다.

백엔드 업데이트는 릴리스를 받아 **SHA256 을 검증한 뒤** 설치하고 재시작한다.
해시 파일이 없는 릴리스는 설치를 거부한다.

---

## 지우기

```
uninstall.bat            멈추고 서비스 등록 해제. 아무것도 지우지 않는다
uninstall.bat -Purge     venv 와 데이터까지 삭제

./uninstall.sh
./uninstall.sh --purge
```

**RisuAI 쪽 원본 챗은 어느 쪽이든 그대로다.** 이 도구는 승인된 수정만 되돌려 썼다.

---

소스와 설계 기록: https://github.com/nilsonwhang3-spec/risu-elf
