# Risu Hina

RisuAI 챗과 봇을 **끝난 뒤에** 고치는 도구. 대화를 통째로 펼쳐 놓고 직접 고치거나, AI 에이전트(히나)에게 시킨다.

두 부분으로 되어 있다.

| 부분 | 어디에 | 무엇 |
|---|---|---|
| **백엔드** (이 폴더) | 파이썬 서버. PC 나 서버에 상주 | 챗·봇·에셋 저장, 에이전트 실행, 워크스페이스 |
| **플러그인** `plugin/Risu.Hina.Plugin.js` | RisuAI(웹 risu.xyz 또는 PocketRisu) 안 | 화면. 백엔드에 HTTP 로 붙는다 |

플러그인과 백엔드는 **버전의 앞 두 자리(major.minor)가 같아야** 통신한다. 다르면 플러그인이 헤더에 알리고 업데이트 경로만 열어 둔다 — §6.

---

## 0. 어떤 설치인가

먼저 자기 경우를 고른다. 설치 명령은 같고, **연결 방식과 보안이 다르다.**

| | **유형 1 — PocketRisu 와 같은 PC** | **유형 2 — 별도 서버** (웹 RisuAI, 또는 다른 PC 의 PocketRisu) |
|---|---|---|
| 백엔드 주소 | `http://127.0.0.1:6020` | Tailscale / Cloudflare 터널 주소, 또는 LAN IP |
| 토큰 | **필요 없음** (루프백 면제) | **필수** — `data/token.txt`, 끌 수 없음 |
| HTTPS | 불필요 | 웹 RisuAI(https://risu.xyz)에서 붙으려면 **필수** (Tailscale serve · Cloudflare 가 해결) |
| RisuAI 설정 | 없음 | 웹 RisuAI 는 **Use Plain Fetch** 켜기 |
| 에셋 동기화 | **고속 경로** — PocketRisu 의 DB 를 직접 읽음 (수천 개도 수 초) | 플러그인이 올려 보냄 (느리지만 어디서나 됨) |
| 바인딩 | 127.0.0.1 그대로 | 터널이면 127.0.0.1 그대로. LAN 직결만 `RISUHINA_HOST=0.0.0.0` |

두 경우 모두 **§1 공통 설치 → 자기 유형의 절(§2 또는 §3) → §4 영속화 → §5 플러그인** 순서다.

---

## 1. 공통 — 백엔드 설치

파이썬을 따로 깔 필요가 없다. zip 안에 인터프리터(3.11)와 의존성이 들어 있고, 이 기계의 파이썬은 쳐다보지 않는다.

### Windows

zip 을 원하는 폴더에 풀고(폴더 이름은 아무거나) 그 안에서:

```
setup.bat                      설치하고 띄운다 (창을 닫으면 꺼진다 → §4)
setup.bat -Port 6030           다른 포트
setup.bat -DataDir E:\hina     데이터를 다른 곳에
setup.bat -NoStart             설치만
setup.bat -Service             Windows 서비스로 등록 (관리자 권한 + NSSM, §4)
```

### Linux (Ubuntu 20.04 / Debian 10 이상, glibc 2.28+)

```
unzip Risu.Hina.<버전>.Linux.x64.Auto.Install.Package.zip -d /opt
cd /opt/risu-hina && chmod +x *.sh
./setup.sh                     설치하고 띄운다
./setup.sh --port 6030
./setup.sh --data-dir /srv/hina
./setup.sh --no-start
./setup.sh --service           pm2 로 등록 (§4)
```

### 확인

```
curl http://127.0.0.1:6020/health
→ {"service": "risu-hina", "version": "…", "ok": true, …}
```

### 폴더

```
pyserver/   백엔드 코드와 파이썬. 업데이트가 통째로 갈아끼운다
plugin/     RisuAI 에 설치할 플러그인 파일
data/       DB · 설정(config.json) · 토큰(token.txt) · 워크스페이스 · 에셋. 업데이트가 건드리지 않는다
```

`data/` 를 옮기거나 백업할 때는 **서버를 먼저 멈춘다.** SQLite 가 `-wal` 파일에 쓰는 중이라 켜진 채 복사하면 최근 변경이 빠진다.

---

## 2. 유형 1 — PocketRisu 와 같은 PC

가장 단순하고 가장 빠른 구성.

1. §1 대로 설치한다. 주소는 `http://127.0.0.1:6020`.
2. PocketRisu 에 플러그인을 넣는다 (§5). 백엔드 URL 은 그대로 `http://127.0.0.1:6020`, **토큰은 비워 둔다** — PocketRisu 의 노드 서버가 대신 요청하므로 백엔드가 보는 클라이언트는 언제나 127.0.0.1 이고, 루프백은 토큰 면제다.
3. **고속 경로**를 켠다: 플러그인 ⚙ → **연결** → *PocketRisu save 폴더* 에 PocketRisu 의 `save` 폴더 경로를 넣는다 (예: `D:\Risuai-NodeOnly\save`). 백엔드가 그 안의 `risuai.db` 를 **읽기 전용**으로 열어 에셋을 바로 가져온다. 수천 장의 이미지도 수 초 안에 동기화된다. 켜졌는지는 ⚙ → 정보·로그 → 진단의 `fastPath: true` 로 안다.

> 이 경로는 PocketRisu 를 수정하지 않는다. 읽기만 하고, 쓰기는 늘 플러그인을 통해 RisuAI API 로 한다.

같은 PC 에서 **웹 RisuAI(risu.xyz)** 도 쓴다면 그것은 유형 2 의 브라우저 규칙(HTTPS · 토큰)을 따른다 — 브라우저는 https 페이지에서 http://127.0.0.1 로 요청하지 못한다. 이때는 §3-1 의 Tailscale serve 가 가장 간단하다.

---

## 3. 유형 2 — 별도 서버

백엔드가 다른 기계(집 PC, NAS, VPS)에 있고 웹 RisuAI 나 다른 PC 의 PocketRisu 가 붙는 경우.

**달라지는 것**

- **토큰 필수.** `data/token.txt` 의 값을 플러그인 ⚙ → 연결 → 토큰에 넣는다. 첫 기동 로그와 `manage.ps1 -Action status` 에도 찍힌다. 비루프백 요청은 토큰 없이는 무엇도 받지 않는다 — 설정으로 끌 수 없다.
- **주소.** 브라우저(웹 RisuAI)에서 붙으려면 **HTTPS** 주소여야 한다. PocketRisu 는 서버 쪽에서 요청하므로 http 도 된다.
- **웹 RisuAI** 는 설정 → *Use Plain Fetch* 를 켠다. 꺼져 있으면 요청이 risu 의 릴레이 서버를 거쳐 사설 주소에 닿지 못한다.
- **고속 경로 없음.** 에셋은 플러그인이 RisuAI 에서 읽어 올려 보낸다(진행률이 봇 카드에 뜬다). 처음 한 번만 느리고, 같은 파일은 다시 보내지 않는다.

주소를 여는 방법은 세 가지. **①이 기본값**이다.

### 3-1. Tailscale (권장 — 사설망, HTTPS 자동)

양쪽 기기에 Tailscale 을 설치해 같은 테일넷에 넣는다. 백엔드는 127.0.0.1 바인딩 그대로 두고 Tailscale 이 앞에서 받아 준다.

```
# 백엔드 기계에서 (관리 콘솔 DNS 에서 MagicDNS 와 HTTPS Certificates 를 켜 둔다)
tailscale serve --bg 6020
tailscale serve status        → https://<기기이름>.<테일넷>.ts.net
```

플러그인의 백엔드 URL 에 그 `https://…ts.net` 주소를 넣는다. 인증서가 자동이라 웹 RisuAI 에서도 붙는다. 테일넷 밖에서는 존재조차 보이지 않는다.

다른 PC 의 PocketRisu 만 붙일 거면 serve 없이 `http://100.x.y.z:6020` 도 되지만, 그러려면 백엔드를 **3-3** 처럼 바인딩을 넓혀야 한다. serve 를 쓰는 편이 낫다.

### 3-2. Cloudflare Tunnel (공개 인터넷)

도메인이 Cloudflare 에 있을 때. 백엔드는 127.0.0.1 그대로, `cloudflared` 가 바깥으로 연결한다.

```
cloudflared tunnel login
cloudflared tunnel create hina
cloudflared tunnel route dns hina hina.example.com
cloudflared tunnel run --url http://127.0.0.1:6020 hina
```

상주시키려면 `cloudflared service install` (Windows 는 관리자 PowerShell, Linux 는 sudo). 설정 파일 방식:

```yaml
# ~/.cloudflared/config.yml  (Windows: C:\Users\<이름>\.cloudflared\config.yml)
tunnel: hina
credentials-file: /home/user/.cloudflared/<터널ID>.json
ingress:
  - hostname: hina.example.com
    service: http://127.0.0.1:6020
  - service: http_status:404
```

계정 없이 잠깐 열어 보려면 `cloudflared tunnel --url http://127.0.0.1:6020` — 무작위 `*.trycloudflare.com` 주소가 나오고 프로세스를 끄면 사라진다.

> **공개 주소는 토큰 하나가 전부다.** 에이전트의 스크립트 실행이 이 기계에서 돌기 때문에 토큰이 새면 임의 코드 실행이다. Cloudflare Access(이메일 로그인)를 앞에 두는 것을 강하게 권한다. 그럴 수 없으면 3-1 로.

### 3-3. LAN 직결 (PocketRisu 만)

같은 공유기 안의 다른 PC 에서 PocketRisu 로만 붙는다면 터널 없이 바인딩을 넓힌다. 브라우저의 웹 RisuAI 는 이 방식으로는 **안 된다**(https → http 차단).

- Windows: 서비스라면 `nssm set RisuHina AppEnvironmentExtra RISUHINA_HOST=0.0.0.0` 뒤 재시작. 손으로 띄운다면 `set RISUHINA_HOST=0.0.0.0` 한 뒤 `start.bat`.
- Linux: `RISUHINA_HOST=0.0.0.0 ./start.sh` 또는 pm2 환경변수.
- 방화벽에서 6020 을 **그 PC 에만** 연다. 공유기 포트포워딩은 하지 않는다.

플러그인 URL 은 `http://<백엔드 LAN IP>:6020`, 토큰 필수.

---

## 4. 영속화 — 재부팅해도 살아 있게

### Windows — NSSM 서비스

```
winget install NSSM.NSSM        (또는 choco install nssm / https://nssm.cc)
setup.bat -Service              관리자 PowerShell 에서
```

`RisuHina` 라는 서비스가 생기고(자동 시작), `cmd.exe /c start.bat 6020` 을 돌린다. 프로세스가 죽으면 5초 뒤 다시 띄운다.

```
nssm status RisuHina
nssm stop RisuHina  /  nssm start RisuHina  /  nssm restart RisuHina
nssm edit RisuHina              GUI 로 환경변수·포트 조정
```

> 파일을 바꾸거나 `data/` 를 옮길 때는 **`nssm stop RisuHina`** 로 멈춘다. `manage.ps1 -Action stop` 은 프로세스만 죽여서 NSSM 이 곧바로 되살린다(그 사이 상태가 Paused 로 보인다).

PocketRisu 도 같은 방식으로 NSSM 에 올려 두면 PC 가 켜질 때 둘 다 올라온다.

### Ubuntu — pm2

```
sudo apt install nodejs npm && sudo npm i -g pm2
./setup.sh --service
pm2 startup                     출력되는 sudo 명령을 한 번 실행
pm2 save
```

```
pm2 status / pm2 logs risu-hina / pm2 restart risu-hina
```

`start.sh` 가 종료 코드 75(업데이트 설치됨)를 보면 스스로 다시 시작하므로 pm2 는 프로세스를 지켜보기만 하면 된다. systemd 를 직접 쓰고 싶으면 `ExecStart=/opt/risu-hina/pyserver/start.sh 6020`, `Restart=always` 로 유닛을 만들면 같다.

---

## 5. 플러그인 설치와 연결

1. RisuAI 설정 → 플러그인 → **Add Plugin** 에 `plugin/Risu.Hina.Plugin.js` 를 넣는다. 챗 화면에 **Risu Hina** 버튼이 생긴다.
2. 열고 오른쪽 위 ⚙:
   - **연결** — 백엔드 URL (유형 1: `http://127.0.0.1:6020`, 유형 2: 터널 주소) · 토큰(유형 2) · PocketRisu save 폴더(유형 1) · **연결 진단**.
   - **API 키/인증** — 모델 프로바이더의 키를 저장한다. 프로바이더 이름을 고르면 API 주소·인증 형식·주의점이 뜬다. OpenAI 구독(ChatGPT Plus/Pro)은 여기서 로그인한다.
   - **에이전트** — 일반 에이전트와 검색 에이전트 프리셋. 키 탭의 키를 고르고 모델을 적는다. 프로바이더에 따라 거부하는 파라미터가 다른데, 그 경우 오류 메시지가 **어떤 JSON 을 프리셋의 *파라미터 JSON* 에 넣을지** 알려준다(예: `{"temperature": null}`).
   - **연결 테스트** 로 일반 응답과 **툴 호출**을 따로 확인한다. 툴 호출이 안 되면 에이전트가 일할 수 없다.

---

## 6. 업데이트

순서는 **① 플러그인 → ② 백엔드**.

1. RisuAI 설정 → 플러그인 목록에서 Risu Hina 옆 **+** (새 버전이 있을 때 나타난다).
2. 플러그인 ⚙ → **연결** 탭 맨 위 **백엔드 업데이트**. 릴리스를 받아 SHA256 을 검증하고 `pyserver/` 를 교체한 뒤 스스로 재시작한다. 새 인터프리터는 `python.new` 로 받아 두고 다음 기동 때 바꿔 넣는다(실행 중인 파일을 옮기지 않는다).

버전의 앞 두 자리가 어긋나면 플러그인이 알려 주고 업데이트 호출만 통과시킨다.

**손으로 올리기** (업데이트 버튼이 없는 옛 판, 또는 오프라인): 서비스를 멈추고(`nssm stop RisuHina` / `pm2 stop risu-hina`) 새 zip 을 설치 폴더 **위에** 풀고(`data/` 는 그대로) 다시 시작한다.

---

## 7. 상태 확인 · 문제 해결

```
powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action status
pyserver/server.log                      (Linux 는 pm2 logs risu-hina)
플러그인 ⚙ → 정보·로그                    진단 정보 + 서버 로그 (키·토큰은 담기지 않는다)
```

| 증상 | 원인·조치 |
|---|---|
| 플러그인 "백엔드 연결 안 됨" | URL 오타, 백엔드 미기동, 유형 2 에서 토큰 미입력. 처음 몇 분은 자동 재시도한다 |
| 웹 RisuAI 에서만 실패 | **Use Plain Fetch** 를 켠다. http 주소면 브라우저가 막는다 → 3-1/3-2 의 https 주소 |
| `unauthorized` | 토큰이 다르다. `data/token.txt` 의 값을 ⚙ → 연결 → 토큰에 |
| 헤더에 "버전이 다릅니다" | §6 순서대로 플러그인 → 백엔드 |
| 에이전트 400 `Unsupported parameter …` | 프로바이더가 그 필드를 거부한다. 오류에 적힌 JSON 을 프리셋 파라미터 JSON 에 넣는다 |
| 에셋 동기화가 느리다 | 유형 1 인데 save 폴더가 비어 있다 → ⚙ 연결에서 지정 (`fastPath: true` 확인) |
| `WinError 10048` / `listening NO` | 포트를 다른 것이 쓴다 → `-Port` |
| `GLIBC_2.28 not found` | 너무 오래된 리눅스 (Ubuntu 20.04 / Debian 10 이상 필요) |
| 서비스 상태 Paused | NSSM 이 재기동 대기 중. `nssm restart RisuHina` |

Windows 에서 `processes 2` 는 정상이다(런처와 인터프리터). 서버는 하나다.

---

## 8. 지우기

```
uninstall.bat            멈추고 서비스 등록 해제. 아무것도 지우지 않는다
uninstall.bat -Purge     데이터까지 삭제
./uninstall.sh           /  ./uninstall.sh --purge
```

**RisuAI 쪽 원본 챗·봇은 어느 쪽이든 그대로다.** 이 도구는 승인된 수정만 되돌려 썼다.

---

소스와 설계 기록: https://github.com/nilsonwhang3-spec/risu-hina
