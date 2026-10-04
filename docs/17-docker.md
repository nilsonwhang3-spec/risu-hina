# 17. Docker 설치

기존 [Windows/Linux 설치](05-install.md) 대신 Docker Compose 로 백엔드를 운영할 수 있다. **공식 릴리스마다
멀티 아키텍처 이미지(`linux/amd64`, `linux/arm64`)를 GitHub 컨테이너 레지스트리(GHCR)에 배포한다.**

```
ghcr.io/nilsonwhang3-spec/risu-hina
```

| 태그 | 뜻 |
|---|---|
| `latest` | 최신 공식 릴리스. **기본값.** 플러그인도 늘 최신으로 자동 업데이트되므로 이 태그가 플러그인과 버전이 맞는다 |
| `0.15` | 0.15.x 의 최신 패치 |
| `0.15.34` | 정확히 그 릴리스 (고정·되돌리기용) |

플러그인은 여전히 RisuAI 에 따로 설치한다. 플러그인과 백엔드의 **major.minor 버전이 같아야** 연결된다.

## 시작

Docker Engine 또는 Docker Desktop 과 Docker Compose 가 필요하다. 이미지는 Docker 호스트의 CPU 에 맞는 것이
자동으로 받아진다(AMD64 서버, ARM64 서버, Apple Silicon 의 Linux 컨테이너 모두 네이티브).

빈 폴더에 [`compose.yaml`](../compose.yaml) 을 받아 실행한다. 저장소를 받을 필요는 없다.

```sh
mkdir risu-hina && cd risu-hina
curl -fsSLO https://raw.githubusercontent.com/nilsonwhang3-spec/risu-hina/master/compose.yaml
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:6020/health
```

`healthy` 와 `"service":"risu-hina"` 응답을 확인한다. 모델을 설정하기 전 `agentReady: false` 는 정상이다.
기본 포트 공개 범위는 **호스트의 `127.0.0.1:6020`** 이다. 컨테이너 안에서는 `0.0.0.0:6020` 에 바인딩한다.
호스트 포트가 이미 사용 중이면 `compose.yaml` 의 왼쪽 포트만 `127.0.0.1:6030:6020` 처럼 바꾼다.

토큰을 확인한다. 이 명령의 출력과 서버 기동 로그에는 실제 토큰이 있으므로 공개하지 않는다.

```sh
docker compose exec risu-hina cat /data/token.txt
```

플러그인은 [릴리스](../../../releases/latest)의 `Risu.Hina.Plugin.js` 를 RisuAI 플러그인 화면에 추가한다.
실행 중인 백엔드의 `http://127.0.0.1:6020/plugin.js` 에서도 같은 버전의 번들을 받을 수 있다.
플러그인 연결 설정에 **백엔드 주소와 토큰을 모두 입력한다.** Docker bridge 를 통과한 요청은
백엔드에서 비루프백 클라이언트로 보이므로, 호스트에서 `127.0.0.1` 로 접속해도 토큰이 필요하다.

### 버전 고정

특정 버전에 머물려면 `compose.yaml` 옆에 `.env` 를 만든다.

```sh
echo "RISUHINA_IMAGE=ghcr.io/nilsonwhang3-spec/risu-hina:0.15.34" > .env
docker compose up -d
```

고정하면 플러그인(자동 업데이트)보다 백엔드가 뒤처질 수 있다. 그때 패널 제목 줄에 "백엔드 업데이트 필요"가 뜨고,
minor 가 달라지면 연결이 막힌다.

## PocketRisu 와 연결

PocketRisu 가 호스트에서 직접 실행 중이면 연결 주소는 `http://127.0.0.1:6020` 이다.
PocketRisu 도 컨테이너라면 그 안의 `127.0.0.1` 은 PocketRisu 컨테이너 자신을 가리킨다.
두 서비스를 같은 Docker 네트워크에 넣고 연결 주소를 `http://risu-hina:6020` 으로 설정한다.

예를 들어 PocketRisu 가 이미 `pocketrisu_default` 네트워크에 연결되어 있다면,
`compose.yaml` 옆에 `compose.override.yaml` 을 만든다. 네트워크 이름은 실제 환경에 맞춘다.

```yaml
services:
  risu-hina:
    networks:
      - pocketrisu

networks:
  pocketrisu:
    external: true
    name: pocketrisu_default
```

```sh
docker compose up -d
```

이 서비스 이름은 같은 네트워크 안에서만 해석된다. PocketRisu 의 서버 프록시를 경유하는
기본 `nativeFetch` 연결에 사용하며, 브라우저에서 직접 요청하는 Plain Fetch 구성에는
브라우저가 접근할 수 있는 호스트/HTTPS 주소가 필요하다.
웹 RisuAI 및 다른 기기에서의 접속은 [기존 연결 안내](05-install.md)를 따른다.
토큰을 가진 클라이언트는 백엔드에서 코드를 실행할 수 있으므로 포트를 인터넷에 직접 공개하지 않는다.

### 선택: PocketRisu 저장 폴더 읽기

이 마운트 없이도 플러그인으로 봇과 에셋을 동기화할 수 있다. 로컬 SQLite 에셋 읽기와 저장 시각 확인을
사용하려면 PocketRisu 의 **저장 폴더 전체**를 읽기 전용으로 추가하고, 플러그인 설정의
`pocketrisu.savePath` 에 컨테이너 경로 `/pocketrisu-save` 를 지정한다.

```yaml
services:
  risu-hina:
    volumes:
      - type: bind
        source: /absolute/path/to/pocketrisu/save
        target: /pocketrisu-save
        read_only: true
        bind:
          create_host_path: false
```

기본 `/data` 볼륨은 유지한다. 저장 폴더와 `risuai.db` 및 존재하는 `-wal`/`-shm` 파일을
컨테이너의 UID/GID `10001:10001` 이 읽을 수 있어야 한다. SQLite 상태나 권한 때문에 읽지 못하면
이 최적화/저장 확인 기능을 사용할 수 없으며, 플러그인 에셋 전송 경로를 사용한다.
호스트 전체나 Docker 소켓을 마운트할 필요는 없다.

## 데이터와 실행 방식

- `risu-hina-data` named volume 이 `/data` 에 연결된다. Compose 가 실제 볼륨 이름 앞에 프로젝트(폴더) 이름을 붙인다.
- 토큰, 설정/자격증명, SQLite DB, 작업 공간, 이미지, 로그와 선택적 MCP 애드온은 `/data` 에 남는다.
  HOME 및 캐시도 `/data` 아래에 둔다. pip 는 포함되어 있으며 MCP 는 기존 설정 화면에서 선택적으로 설치한다.
- UID/GID `10001:10001` 로 실행한다. 새 named volume 은 이 소유권으로 초기화된다.
  기존 bind mount 로 바꾸려면 운영자가 해당 폴더의 쓰기 권한을 미리 준비해야 한다.
- 컨테이너에서는 `python run.py` 를 전경 실행하고 Docker 가 재시작과 종료 신호를 관리한다.
  기존 설치의 `start.sh`, PM2 또는 systemd 를 컨테이너 안에서 실행하지 않는다.
- 이미지에는 `RISUHINA_DISABLE_SELF_UPDATE=1` 이 설정되어 있다. 앱 내부 업데이트 확인(설정 → 정보 · 로그)은
  그대로 새 릴리스를 알려 주고, 설치만 막은 채 아래 업데이트 명령을 안내한다. 백엔드가 플러그인보다 오래되면
  패널 제목 줄에 "백엔드 업데이트 필요"가 뜬다.
- `/data` 밖으로 별도 저장 경로를 설정했다면 그 경로에도 볼륨을 연결하고 별도로 백업해야 한다.

`docker compose down` 은 named volume 을 유지한다. **`docker compose down -v` 는 데이터를 삭제하므로 사용하지 않는다.**
Compose 프로젝트 이름이나 폴더 이름을 바꾸면 다른 볼륨을 쓰게 되므로 업데이트 때 유지한다.

## 업데이트

```sh
docker compose pull
docker compose up -d
docker compose ps
```

데이터 볼륨은 그대로 이어진다. 버전이 바뀌면 플러그인은 RisuAI 가 자동으로 업데이트한다.
큰 업데이트 전에는 아래처럼 백업해 두기를 권한다.

## 백업과 되돌리기

SQLite 파일과 작업 공간을 함께 백업하도록 먼저 서비스를 멈춘다. 아래 명령은 현재 폴더에
`risu-hina-data.tar.gz` 를 새로 저장한다. 기존 백업이 있으면 이름을 바꾸고, 자격증명이 포함된 백업을 안전하게 보관한다.

```sh
docker compose stop risu-hina
docker compose run --rm --no-deps -T --entrypoint tar risu-hina -C /data -czf - . > risu-hina-data.tar.gz
docker compose start risu-hina
```

복원은 서비스를 멈춘 상태에서 빈 데이터 볼륨에 진행한다. 아래 명령의 입력 파일을 복원할 백업으로 바꾼다.
기존 데이터에 덮어쓰기 전 현재 볼륨을 별도로 백업한다.

```sh
docker compose stop risu-hina
docker compose run --rm --no-deps -T --entrypoint tar risu-hina -C /data -xzf - < risu-hina-data.tar.gz
docker compose start risu-hina
```

**옛 버전으로 되돌리기:** `.env` 의 `RISUHINA_IMAGE` 를 이전 버전 태그로 바꾸고, **그 버전 때 만든 백업을 복원**한 뒤
`docker compose up -d` 한다. 백업 없이 옛 이미지만 띄우면, 새 버전이 만든 데이터는 옛 형식으로 덮어쓰지 않도록
백엔드가 멈추고 패널에 이유를 보여 준다(데이터는 그대로 보존된다).

## 소스에서 직접 빌드 (선택)

개발 중이거나 직접 빌드하려면 저장소를 받아 `compose.build.yaml` 을 함께 지정한다.

```sh
git clone https://github.com/nilsonwhang3-spec/risu-hina.git
cd risu-hina
git checkout v0.15.34          # 원하는 릴리스 태그. master 는 릴리스되지 않은 코드일 수 있다
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

업데이트도 같은 방식이다: 새 태그로 `git checkout` 한 뒤 위 명령을 다시 실행한다.
다른 CPU 용으로 교차 빌드하려면 `docker build --platform linux/arm64 ...` 처럼 대상을 지정한다.
이 Dockerfile 은 대상 Python 을 실행해 패키지를 설치하므로, 교차 빌드에는 해당 CPU 의 원격 빌더나
Docker 에 설정된 에뮬레이션이 필요하다. 네이티브 빌드에는 에뮬레이션이 필요 없다.

## 이미지 배포와 검증 (관리자용)

- **배포:** GitHub 릴리스를 발행하면 `.github/workflows/release-image.yml` 이 AMD64·ARM64 네이티브 러너에서 각각
  이미지를 빌드하고, `tests/test_docker.py` 를 통과한 것만 GHCR 에 올린 뒤 두 아키텍처를 `X.Y.Z` · `X.Y` · `latest`
  태그로 묶는다(프리릴리스는 `latest` 를 옮기지 않는다). 태그와 `config.VERSION` 이 다르면 빌드하지 않는다.
- **다시 배포:** Actions → Release image → Run workflow 에 태그(`v0.15.34`)를 넣으면 같은 릴리스를 다시 빌드한다.
  실패한 배포를 다시 돌리거나, 베이스 이미지(`python:3.11-slim`)의 보안 패치를 반영할 때 쓴다.
- **상시 검사:** `.github/workflows/docker.yml` 은 백엔드가 바뀌는 푸시·PR 마다 두 아키텍처에서 이미지 빌드,
  컨테이너 스모크 테스트, 기존 HTTP 회귀 검사를 실행한다(배포는 하지 않는다).
- **로컬 검사:**

  ```sh
  docker compose config --quiet
  python3 tests/test_updater.py
  docker build -t risu-hina:test .
  python3 tests/test_docker.py --image risu-hina:test
  ```

  스모크 테스트는 고유 이름의 컨테이너/볼륨을 만들고 끝나면 그것만 제거한다. 비루트 기동, healthcheck,
  HTTP 인증, 플러그인 번들/기본 스킬 제공, 자체 업데이트 거부, 정상 종료, 컨테이너 재생성 후
  토큰·설정·챗 편집·이미지 유지 여부를 확인한다. 모델 API 호출이나 실제 RisuAI 브라우저 조작은 하지 않는다.

### ARM64 의존성 잠금 재생성

`pyserver/locks/linux-aarch64-cp311.txt` 는 기존 `linux-x86_64-cp311.txt` 의 모든 패키지 버전을
유지한 채 ARM64 wheel 을 다운로드하고, 저장소의 `genlock.py` 로 SHA-256 을 계산해 생성한다.
저장소 루트에서 다음 명령을 실행한다. wheel 은 실행하지 않으므로 AMD64 머신에서도 생성할 수 있다.

```sh
wheel_dir="$(mktemp -d)"
python3 - <<'PYLOCK' > "$wheel_dir/requirements.txt"
from pathlib import Path
for line in Path("pyserver/locks/linux-x86_64-cp311.txt").read_text().splitlines():
    if line.strip() and not line.startswith("#"):
        print(line.split()[0])
PYLOCK
python3 -m pip download --only-binary=:all: --no-deps \
  --platform manylinux2014_aarch64 --platform manylinux_2_17_aarch64 \
  --platform manylinux_2_28_aarch64 --platform linux_aarch64 \
  --python-version 3.11 --implementation cp --abi cp311 --abi abi3 --abi none \
  --dest "$wheel_dir/wheels" -r "$wheel_dir/requirements.txt"
python3 pyserver/tools/genlock.py "$wheel_dir/wheels" > pyserver/locks/linux-aarch64-cp311.txt
```

의존성 버전을 바꿀 때는 두 플랫폼 잠금을 함께 갱신한다. `tests/test_updater.py` 가 두 잠금의
`패키지==버전` 목록이 같은지 확인한다.
