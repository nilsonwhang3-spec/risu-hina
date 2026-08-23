# 00. 배포 환경

한 대의 PC에 PocketRisu와 이 백엔드를 같이 두는 것이 기본 형태다.
개발자 개인 서버의 실제 호스트·계정은 `docs/00-environment.md` 에 있고 저장소에는 올리지 않는다.

## 형태

```
[다른 PC의 브라우저]  ──HTTP──▶  [서버] PocketRisu 0.0.0.0:6001
      플러그인 iframe                        │
      nativeFetch({networkRoute:'local_network'})
      → PocketRisu 서버의 /proxy2 가 대신 요청 ─┘
                                              ▼
                              [서버] Risu Elf 127.0.0.1:6020
```

**중요한 귀결:** 백엔드가 보는 클라이언트 IP는 언제나 **127.0.0.1** 이다 — PocketRisu 의
노드 서버가 같은 머신에서 대신 호출하기 때문이다. 그래서 이 경로에서는 **토큰이 면제**되고,
백엔드는 루프백에만 바인딩하면 되며 **외부에 열 필요가 전혀 없다.**

web RisuAI(risuai.xyz)로 붙을 때만 토큰·CORS·혼합콘텐츠 문제가 관여한다. 그 경우
비루프백이므로 **토큰이 강제**되고, 이는 설정으로 끌 수 없다 — `run_python` 이 있는 이상
토큰을 아는 사람은 그 기계에서 코드를 실행할 수 있는 사람이다.

## 요구사항

| 항목 | 값 |
|---|---|
| Python | 3.11 (배포본은 인터프리터를 동봉할 예정) |
| 포트 | 기본 `127.0.0.1:6020` (`RISUELF_PORT` 로 변경) |
| 데이터 | `<install>/data/` — DB·설정·토큰·워크스페이스. 버전 디렉터리 **바깥**에 둔다 |

## 기동

```
# Windows
setup.bat                      최초 설치 + 기동
powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action start|stop|status

# 그 외
./setup.sh
pyserver/start.sh [port]       런처를 직접
```

두 런처 모두 **재시작 루프**다. 백엔드가 exit 75 로 끝나면 "새 버전을 설치했으니 다시 들어와라"라는
뜻이고 루프가 재진입한다. NSSM·PM2·systemd 중 무엇으로 감싸도 자체 업데이트가 동일하게 동작하는
이유가 이것이다 — 루프가 수퍼바이저가 아니라 런처에 있다.

## 확인

```
curl http://127.0.0.1:6020/health
```

서버가 루프백에만 바인딩하므로 **다른 기계에서 이 curl 은 자기 자신을 가리킨다.**
확인은 반드시 그 서버 안에서 해야 한다.
