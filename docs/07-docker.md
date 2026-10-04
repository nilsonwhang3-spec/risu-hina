# 07. Docker 설치

기존 [Windows/Linux 설치](05-install.md) 대신 Docker Compose 로 백엔드를 운영할 수 있다.
플러그인은 여전히 RisuAI 에 따로 설치한다. 이 구성은 소스에서 이미지를 빌드하며, 공식 컨테이너 레지스트리는 사용하지 않는다.

## 시작

Docker Engine 또는 Docker Desktop 과 Docker Compose 가 필요하다. 현재 이미지는 저장소의
CPython 3.11 Linux x86_64 의존성 해시 잠금을 사용하므로 **`linux/amd64`만 지원한다.**
ARM 기기는 Docker 의 amd64 에뮬레이션이 필요하며, 네이티브 ARM 빌드는 지원하지 않는다.

```sh
git clone https://github.com/nilsonwhang3-spec/risu-hina.git
cd risu-hina
# 원하는 릴리스 태그 또는 커밋으로 checkout 한 뒤 빌드한다.
docker compose config --quiet
docker compose up -d --build
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

체크아웃의 `plugin/Risu.Hina.Plugin.js` 를 RisuAI 플러그인 화면에 추가한다.
실행 중인 백엔드의 `http://127.0.0.1:6020/plugin.js` 에서도 같은 번들을 받을 수 있다.
플러그인 연결 설정에 **백엔드 주소와 토큰을 모두 입력한다.** Docker bridge 를 통과한 요청은
백엔드에서 비루프백 클라이언트로 보이므로, 호스트에서 `127.0.0.1` 로 접속해도 토큰이 필요하다.
플러그인과 백엔드의 **major.minor 버전이 같아야** 연결된다.

## PocketRisu 와 연결

PocketRisu 가 호스트에서 직접 실행 중이면 연결 주소는 `http://127.0.0.1:6020` 이다.
PocketRisu 도 컨테이너라면 그 안의 `127.0.0.1` 은 PocketRisu 컨테이너 자신을 가리킨다.
두 서비스를 같은 Docker 네트워크에 넣고 연결 주소를 `http://risu-hina:6020` 으로 설정한다.

예를 들어 PocketRisu 가 이미 `pocketrisu_default` 네트워크에 연결되어 있다면,
리스히나 체크아웃에 `compose.override.yaml` 을 만든다. 네트워크 이름은 실제 환경에 맞춘다.

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

- `risu-hina-data` named volume 이 `/data` 에 연결된다. Compose 가 실제 볼륨 이름 앞에 프로젝트 이름을 붙인다.
- 토큰, 설정/자격증명, SQLite DB, 작업 공간, 이미지, 로그와 선택적 MCP 애드온은 `/data` 에 남는다.
  HOME 및 캐시도 `/data` 아래에 둔다. pip 는 포함되어 있으며 MCP 는 기존 설정 화면에서 선택적으로 설치한다.
- UID/GID `10001:10001` 로 실행한다. 새 named volume 은 이 소유권으로 초기화된다.
  기존 bind mount 로 바꾸려면 운영자가 해당 폴더의 쓰기 권한을 미리 준비해야 한다.
- 컨테이너에서는 `python run.py` 를 전경 실행하고 Docker 가 재시작과 종료 신호를 관리한다.
  기존 설치의 `start.sh`, PM2 또는 systemd 를 컨테이너 안에서 실행하지 않는다.
- `RISUHINA_DISABLE_SELF_UPDATE=1` 때문에 앱 내부 백엔드 업데이트 확인/설치는 이미지 재빌드를 안내한다.
  일반 설치는 이 환경변수를 설정하지 않아 기존 업데이트 동작을 유지한다.
- `/data` 밖으로 별도 저장 경로를 설정했다면 그 경로에도 볼륨을 연결하고 별도로 백업해야 한다.

`docker compose down` 은 named volume 을 유지한다. **`docker compose down -v` 는 데이터를 삭제하므로 사용하지 않는다.**
Compose 프로젝트 이름이나 디렉터리 이름을 바꾸면 다른 볼륨을 사용할 수 있으므로 업그레이드 때 유지한다.

## 백업과 업데이트

SQLite 파일과 작업 공간을 함께 백업하도록 먼저 서비스를 멈춘다. 아래 명령은 현재 디렉터리에
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

백업 후 체크아웃을 원하는 릴리스 태그/커밋으로 바꾸고 이미지를 다시 빌드한다.

```sh
git fetch --tags
# git checkout <release-tag-or-commit>
docker compose build --pull
docker compose up -d --force-recreate
docker compose ps
```

앱 내부 업데이트로 컨테이너 코드를 덮어쓰지 않는다. 필요하면 새 버전의 플러그인도 RisuAI 에 설치한다.
버전을 되돌릴 때는 이전 소스 이미지와 그 버전에 맞는 데이터 백업을 함께 사용한다.

## 빌드/기동 검증

```sh
docker compose config --quiet
python3 tests/test_updater.py
docker build --platform linux/amd64 -t risu-hina:test .
python3 tests/test_docker.py --image risu-hina:test
```

스모크 테스트는 고유 이름의 컨테이너/볼륨을 만들고 끝나면 그것만 제거한다. 비루트 기동, healthcheck,
HTTP 인증, 플러그인 번들/기본 스킬 제공, 자체 업데이트 거부, 정상 종료, 컨테이너 재생성 후
토큰·설정·챗 편집·이미지 유지 여부를 확인한다. 모델 API 호출이나 실제 RisuAI 브라우저 조작은 하지 않는다.
GitHub Actions 도 이미지 빌드와 이 검사 및 기존 HTTP 회귀 검사를 실행하며 이미지를 배포하지 않는다.
