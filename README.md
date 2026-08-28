# 리스히나 (RisuHina) BETA

당신의 봇과 챗을 개변하는 진짜 OOC 플러그인.
멀티턴 에이전트를 통해 당신의 봇과 챗을 마음대로 주무르세요.

**[최신 릴리스 다운로드](../../releases/latest)**

---

## 할 수 있는 것들

**01 스토리 기획과 제작/수정** — 아이디어를 봇으로

봇의 전체 구조를 이해하고 당신을 도와줍니다.
단순 수정부터 새 캐릭터 기획, 봇의 약점 분석까지.

**02 상태창, Regex, LUA, 에셋** — 다재다능한 비서

이야기만 쓰는 게 아닙니다. 리스의 구조를 알고 있습니다.
상태창 꾸미기, 정규식, LUA 프로그래밍, 에셋 관리까지 한번에.

**03 챗 역사개변** — 너의 흑역사가 추억이 된다

상태창, 변수를 이야기 흐름에 맞춰 일관되게 찐빠를 잡아냅니다.
처음부터 진행한 것처럼 감쪽같이 바꿔줍니다.

**04 그 외**

챗요약, 이사 등등 — 봇과 챗에 관한 거라면 상상하는 대부분의 것들을 할 수 있어요.

> 멀티턴 에이전틱 워크플로우를 사용합니다.
> Ollama GLM 5.2 / Google Gemini 3.7 Flash 등 비용 부담 적은 모델을 사용하세요(책임못짐).

---

## 설치

[릴리스](../../releases/latest)에서 `Risu.Hina.<버전>.Auto.Install.Package.zip`을 받아 원하는 폴더에 푼다.

```
setup.bat          # Windows — venv 생성 후 기동
setup.sh           # Linux
```

플러그인 파일(`plugin/Risu.Hina.Plugin.js`)을 RisuAI 플러그인 화면에 넣고,
챗 화면의 **Risu Hina** 버튼 → ⚙ → **연결**에 백엔드 URL, **에이전트 → 수정**에 모델 자격증명을 입력.

### 방법 1 — 포켓리스 + 같은 PC

가장 간단한 구성. PC에서 포켓리스와 리스히나를 함께 돌린다.

```
포켓리스 (브라우저)  ←→  리스히나 백엔드 (같은 PC)
```

연결 URL: `http://127.0.0.1:6020`

### 방법 2 — 웹 리스 + 내 PC + Tailscale

RisuAI 웹(risu.pages.dev)을 폰이나 다른 기기에서 쓰고, 내 PC에 백엔드를 둔다.
Tailscale로 기기 간 네트워크를 잡는다.

> 폰이나 다른 서버에 설치한 포켓리스도 같은 방식으로 가능합니다.

```
웹 리스 / 포켓리스 (폰·다른 기기)
  └─ Tailscale 네트워크 ─→  리스히나 백엔드 (내 PC)
```

연결 URL: `http://<Tailscale IP>:6020`

비루프백 접근 시 토큰이 강제됩니다. 최초 기동 때 콘솔에 표시되는 토큰을 플러그인 연결 설정에 입력하세요.

### 영속화 (재부팅 후 자동 기동)

**Windows — NSSM:**

```powershell
setup.bat -Service       # 관리자 권한 필요
uninstall.bat            # 서비스 제거
```

**Linux — pm2:**

```bash
./setup.sh --service
./uninstall.sh           # 서비스 제거
```

---

설치 옵션 상세(포트·데이터 위치·인터프리터 변경 등)는 [docs/05-install.md](docs/05-install.md),
설계 결정은 [docs/](docs/),
문제 리포트는 [Issues](https://github.com/nilsonwhang3-spec/risu-hina/issues).
