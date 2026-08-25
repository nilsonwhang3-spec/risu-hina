# 05. 최초 설치

test-server에서 실제로 처음부터 돌려 보고 쓴 절차다. 명령과 출력은 실행한 것이다.

**두 조각을 따로 설치한다.** 백엔드는 서버(PocketRisu가 도는 그 기계)에,
플러그인은 RisuAI에. 순서는 백엔드가 먼저다 — 플러그인이 처음 열릴 때 백엔드에 붙는다.

---

## 준비

| 필요한 것 | 확인 |
|---|---|
| 파이썬 | **필요 없다.** 동봉돼 있다 |
| 백엔드를 둘 디렉터리 | 어디든 된다. §2 참조 |
| PocketRisu 또는 web RisuAI | 이미 쓰고 있는 것 |

인터프리터는 압축 안에 있다(`pyserver/python/`). 이 기계에 무엇이 깔려 있든 그것만 쓴다 —
사용자가 파이썬을 설치해야 하는 배포는 처음부터 하지 않기로 한 것이고, 첫 릴리스가 그
규칙을 어겼던 것을 바로잡았다. 소스 체크아웃에서 돌릴 때만 `-Python <경로>` 가 의미 있다.

---

## 1. 백엔드

### 1-1. 내려받아 검증한다

릴리스에서 세 파일을 받는다.

```
Risu.Elf.<버전>.Auto.Install.Package.zip
SHA256SUMS.txt
Risu.Elf.Plugin.js        ← RisuAI 가 자동 업데이트에 쓰는 것. 3단계에서 쓴다
```

**해시를 먼저 확인한다.** 이 zip의 내용이 곧 돌아갈 서버가 되므로, 검증하지 않은
다운로드를 푸는 것은 남이 준 코드를 그냥 실행하는 것과 같다.

```powershell
$want = (Get-Content SHA256SUMS-<버전>.txt | Where-Object { $_ -like '*backend*' }).Split(' ')[0]
$got  = (Get-FileHash Risu.Elf.0.4.0.Auto.Install.Package.zip -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { throw 'hash mismatch' } else { 'hash ok' }
```

### 1-2. 푼다

**한 번 풀면 끝이다.** 압축 안에 `risu-elf/` 트리가 통째로 들어 있어서, 폴더를 미리
만들 필요도 이름을 맞출 필요도 없다.

```powershell
Expand-Archive Risu.Elf.0.4.0.Auto.Install.Package.zip -DestinationPath D:\code -Force
```

```
D:\code\risu-elf\
  pyserver\              코드 + 런처. 업데이트가 통째로 갈아끼운다
  plugin\                RisuAI 에 설치할 플러그인
  data\                  당신 것. 업데이트가 건드리지 않는다
  start.bat  start.sh
  setup.bat  uninstall.bat        (Windows)
  setup.sh   uninstall.sh         (Linux)
  README.md
```

런처가 `pyserver\` **밖에** 있는 것은 정돈이 아니라 안전 문제다. cmd.exe 는 실행 중인
배치 파일을 바이트 오프셋으로 다시 읽는다 — 재시작 루프가 `start.bat` 안에 앉아 있는
바로 그 순간 업데이트가 그 파일을 덮어쓰면 cmd 가 엉뚱한 줄을 실행할 수 있다.
업데이트가 손대는 디렉터리 밖에 두면 그 가능성 자체가 없어진다.
(그래도 런처가 바뀌면 업데이트가 `start.bat.new` 로 옆에 놓고 로그로 알린다.)


### 1-3. 설치

```powershell
D:\code\risu-elf\setup.bat
```

```
setup: using C:\Program Files\Python311\python.exe
setup: creating venv
setup: installing dependencies
setup: fastapi 0.115.6 uvicorn 0.34.0
setup: data dir D:\code\risu-elf\data
```

전용 venv를 만들고 `requirements.in`(버전 고정)을 설치한다. 시스템 파이썬은 건드리지 않는다.

### 1-4. 기동

```powershell
D:\code\risu-elf\setup.bat        REM setup 이 곧바로 띄운다
```

```
install    D:\code\risu-elf
data       D:\code\risu-elf\data
processes  2 (venv launcher + server, normal)
           pid 21404
           pid 20596
listening  yes on 6020
health     {"service": "risu-elf", "version": "0.4.0", "ok": true, "agentReady": false, ...}
```

> **`processes 2` 는 정상이다.** 윈도우 venv의 `Scripts\python.exe` 는
> `venvlauncher.exe` 라서 진짜 인터프리터를 자식으로 띄우고 자기는 부모로 남는다.
> 서버는 하나다 — `listening` 과 `health` 가 그것을 말한다.

`agentReady: false` 도 정상이다. 아직 모델 자격증명을 넣지 않았다.

**다른 수퍼바이저를 쓸 거라면** `pyserver\start.bat`(또는 `pyserver/start.sh`)을
감싸면 된다. NSSM·PM2·systemd 무엇이든, **런처를 직접 실행해야 한다** — 자체 업데이트가
exit 75로 재진입을 요청하는데 그 루프가 런처 안에 있기 때문이다.

상주시키는 것은 §2의 **서비스로 상주시키려면**에 스크립트로 준비돼 있다.

### 1-5. 토큰

```powershell
powershell -ExecutionPolicy Bypass -File D:\code\risu-elf\pyserver\manage.ps1 -Action token
```

```
token: 17sFfQSPMjg6kPH6gi_D8jLg_020Z5zJV1IEmhchbd0
```

**PocketRisu를 같은 기계에서 쓰면 토큰이 필요 없다.** PocketRisu의 노드 서버가 대신
요청하므로 백엔드가 보는 클라이언트 IP는 언제나 127.0.0.1이고, 루프백은 면제다.
web RisuAI나 다른 기계에서 직접 붙을 때만 필요하다 — 그 경우 토큰은 **강제**이며
설정으로 끌 수 없다.

---

## 2. 설치 위치를 바꾸려면

**코드 위치는 그냥 바꾸면 된다.** 하드코딩된 경로가 없다 — 스크립트가 자기가 놓인
자리에서 모든 경로를 계산하고, 프로세스도 **자기 설치의 `run.py` 경로로** 찾는다.
폴더 이름이 `risu-elf` 일 필요도 없다.

```powershell
Expand-Archive Risu.Elf.0.4.0.Auto.Install.Package.zip -DestinationPath E:\apps -Force
Rename-Item E:\apps\risu-elf myelf          # 이름도 마음대로
powershell -ExecutionPolicy Bypass -File E:\apps\myelf\setup.bat
```

압축이 `risu-elf/` 트리를 통째로 담고 있으므로 그냥 원하는 부모 폴더에 풀면 된다.
폴더 이름이 `risu-elf` 일 필요도 없다 — 풀고 나서 이름을 바꿔도 그대로 동작한다.

```
<install>\
  pyserver\   ← 코드. 업데이트가 통째로 갈아끼운다
  data\       ← DB·설정·토큰·워크스페이스. 업데이트가 절대 건드리지 않는다
```

이 구조가 자체 업데이트의 전제다. 데이터가 코드 **안에** 있으면 버전 교체가 매번
사용자의 챗을 밟고 지나가야 한다.

### 데이터만 다른 곳에 두려면

다른 드라이브나 백업되는 디스크에 두고 싶을 때.

```powershell
powershell -ExecutionPolicy Bypass -File "$install\setup.bat" -DataDir E:\backup\risu-elf-data
```

```
setup: pinned data dir in E:\apps\myelf\pyserver\datadir.txt
setup: data dir E:\backup\risu-elf-data
```

`pyserver\datadir.txt` 한 줄에 절대경로가 적힌다. **launch 때 넘기는 값이 아니라
설치에 박히는 값이다** — 그래야 NSSM이든 PM2든 손으로 띄우든 전부 같은 곳을 본다.
(제어 스크립트는 서버를 ssh 세션에서 떼어내려고 `Win32_Process.Create` 로 띄우는데,
그건 WMI 서비스 밑에서 돌아서 환경변수를 하나도 물려받지 않는다. 파일이어야 하는 이유다.)

이후 `-DataDir` 없이 불러도 `status`·`token` 이 실제 위치를 보고한다.

되돌리려면 `-DataDir` 없이 `setup` 을 다시 돌리거나 `datadir.txt` 를 지운다.
**옮기고 싶으면 서버를 멈추고 `data\` 폴더를 통째로 옮긴 뒤** 다시 `setup -DataDir` 한다.
스크립트는 데이터를 옮겨 주지 않는다 — 옮기다 만 상태가 조용히 생기는 것보다 낫다.

### 리눅스에서는

```bash
unzip Risu.Elf.0.4.0.Auto.Install.Package.zip -d /opt
cd /opt/risu-elf && chmod +x *.sh
./setup.sh                      # 동봉된 파이썬을 확인하고 띄운다
./setup.sh --service            # 또는 PM2 로 상주시키기
./uninstall.sh                  # 멈추고 등록 해제
```

`setup.sh` 는 `--data-dir <절대경로>` 와 `--port` 를 받는다(윈도우의 `-DataDir`, `-Port`).
**시스템 파이썬은 보지 않는다.** Ubuntu 20.04 처럼 3.8 만 있는 기계에서도 동봉된 3.11 로
그대로 돈다 — 실제로 그 환경에서 PATH 를 비우고 확인했다. 필요한 것은 glibc 2.28+ 뿐이다.

### 서비스로 상주시키려면

| | 등록 | 해제 |
|---|---|---|
| Windows (NSSM) | `setup.bat -Service [-Name RisuElf] [-Port 6020]` | `uninstall.bat [-Name RisuElf]` |
| Linux (PM2) | `./setup.sh --service [--port 6020]` | `./uninstall.sh` |

둘 다 **`start.bat`/`start.sh` 를 실행하지 `run.py` 를 직접 실행하지 않는다.** exit 75 가
"업데이트를 설치했으니 다시 올라와라"라는 뜻이고 그걸 아는 루프가 런처 안에 있기 때문이다.
수퍼바이저를 `run.py` 에 바로 물리면 플러그인에서 업데이트하는 날까지는 잘 돌다가 그날 멈춘다.

NSSM 등록은 **관리자 권한**이 필요하다. PM2 의 부팅 상주는 `pm2 startup` 이 출력하는
sudo 명령을 사람이 직접 실행해야 한다 — 스크립트가 읽지도 않은 sudo 명령을 몰래 실행하지는 않는다.

**해제 스크립트는 등록만 지운다.** 코드도 데이터도 그대로 남고, 런처는 손으로 계속 쓸 수 있다.


### 포트를 바꾸려면

```powershell
... -Action start -Port 6030
```

`manage.ps1` 의 `stop`·`status`·`token` 에도 같은 `-Port` 를 준다(상태 확인이 그 포트를 본다).
`start.bat 6030` / `start.sh 6030` 도 같다. 환경변수 `RISUELF_PORT` 도 읽는다.

### 요약

| 바꾸고 싶은 것 | 방법 |
|---|---|
| 코드 위치 | 그냥 원하는 부모 폴더에 풀면 된다 |
| 데이터 위치 | `setup.bat -DataDir <절대경로>` / `./setup.sh --data-dir <절대경로>` |
| 포트 | `-Port` 또는 `RISUELF_PORT` |
| 인터프리터 | `setup.bat -Python <경로>` / `./setup.sh --python <경로>` |
| 바인딩 주소 | `RISUELF_HOST` — **바꾸기 전에 §4를 읽을 것** |

---

## 3. 플러그인

1. RisuAI → 설정 → 플러그인 → **Add Plugin** 에서 `Risu.Elf.Plugin.js` 를 넣는다.
2. 챗 화면에 **Risu Elf** 버튼이 생긴다. 눌러서 연다.
3. 오른쪽 위 **⚙ → 연결** 에서 백엔드 URL을 넣는다. 같은 기계면
   `http://127.0.0.1:6020`. 다른 기계면 그 주소와 §1-5의 토큰.
4. **⚙ → 에이전트 → 수정** 에서 Base URL · Model · API Key 를 넣고 **연결 테스트**.
   테스트는 일반 응답과 **툴 호출을 따로** 확인한다 — 툴 호출이 안 되면 에이전트가
   동작할 수 없으므로, 여기서 걸러야 한다.

이후 플러그인 업데이트는 RisuAI가 `//@update-url` 로 알아서 확인한다.

---

## 4. 확인과 문제 해결

```powershell
powershell -ExecutionPolicy Bypass -File <install>\pyserver\manage.ps1 -Action status
```

> **다른 기계에서 `curl http://127.0.0.1:6020/health` 는 아무 의미가 없다.**
> 자기 자신을 가리킨다. 서버는 루프백에만 바인딩하므로 확인은 그 서버 안에서 해야 한다.

`health unreachable` 이면 `status` 가 `server.log` 꼬리 25줄을 같이 뱉는다.
로그는 플러그인 안에서도 볼 수 있다 — **⚙ → 정보 · 로그 → 서버 로그**.
문제를 신고할 때는 같은 화면의 **진단 정보** 를 함께 복사해 주면 된다.
둘 다 API 키와 토큰을 담지 않는다.

| 증상 | 원인 |
|---|---|
| `no Python found` | 3.10+ 가 없거나 못 찾음 → `-Python <경로>` |
| `venv missing - run -Action setup first` | 1-3을 건너뜀 |
| `listening NO` + 로그에 `WinError 10048` | 그 포트를 다른 것이 쓰고 있음 → `-Port` |
| 플러그인이 "백엔드 연결 안 됨" | URL 오타, 백엔드 미기동, 또는 web RisuAI에서 토큰 미입력 |
| web RisuAI에서만 실패 | RisuAI 설정의 **Use Plain Fetch** 를 켤 것. 꺼져 있으면 요청이 `sv.risuai.xyz` 로 릴레이되어 사설 주소에 닿지 않는다 |

### 바인딩을 넓히기 전에

`RISUELF_HOST=0.0.0.0` 은 **토큰을 아는 사람에게 그 기계의 임의 코드 실행 권한을 주는 것과
같다** — 에이전트의 `run_python` 이 그 기계에서 돈다. 서버가 기동할 때 그 경고를 찍는다.
넓혀야 한다면 Tailscale 같은 사설망 안으로만 하고, 공개 인터넷에는 바인딩하지 않는다.

---

## 5. 지우려면

```powershell
<install>\uninstall.bat -Purge
Remove-Item -Recurse -Force <install>
```

`data\`(또는 `datadir.txt` 가 가리키는 곳)에 챗 사본과 워크스페이스가 들어 있다.
**RisuAI 쪽 원본 챗은 그대로다** — 이 도구는 승인된 수정만 되돌려 썼다.
