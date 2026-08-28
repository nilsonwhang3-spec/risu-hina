# 00. Deployment environment

The default shape is PocketRisu and this backend sitting on the same PC.
The actual host and account of the developer's personal server are in `docs/00-environment.md`, which is not committed to the repository.

## Shape

```
[browser on another PC]  ──HTTP──▶  [server] PocketRisu 0.0.0.0:6001
      plugin iframe                          │
      nativeFetch({networkRoute:'local_network'})
      → PocketRisu server's /proxy2 makes the request instead ─┘
                                              ▼
                              [server] Risu Hina 127.0.0.1:6020
```

**Important consequence:** the client IP the backend sees is always **127.0.0.1** — because PocketRisu's
node server makes the call on its behalf from the same machine. So on this path the **token is waived**,
the backend only needs to bind to loopback, and there is **no need to open it externally at all.**

Token, CORS and mixed-content problems only come into play when connecting from web RisuAI (risuai.xyz). In that case
it is non-loopback, so the **token is enforced**, and this cannot be turned off by configuration — as long as `run_python`
exists, anyone who knows the token is someone who can run code on that machine.

## Requirements

| Item | Value |
|---|---|
| Python | Bundled (3.11). No installation needed |
| Port | Default `127.0.0.1:6020` (change with `RISUHINA_PORT`) |
| Data | `<install>/data/` — DB, settings, token, workspace. Keep it **outside** the version directory |

## Startup

```
# Windows
setup.bat                      first install + start
powershell -ExecutionPolicy Bypass -File pyserver\manage.ps1 -Action start|stop|status

# Everything else
./setup.sh
pyserver/start.sh [port]       the launcher directly
```

Both launchers are **restart loops**. When the backend exits with 75 it means "a new version has been installed, come back in",
and the loop re-enters. This is why self-update works identically no matter whether you wrap it in NSSM, PM2 or systemd —
the loop lives in the launcher, not in the supervisor.

## When moving data/

**Stop the server first**, then move it. WAL is folded back into the main file on every start and stop (`wal_checkpoint(TRUNCATE)`),
so a stopped `data/` is nothing but a single `risuhina.db`. If you copy a live server's `risuhina.db-wal` and `-shm` along with it
and open that in another installation, the stale wal-index fools the new server and **that server's commits get written into an unreachable spot in the WAL.**
They are visible while reading and vanish entirely on the next restart (real incident on 2026-08-23 — two hours of edits silently disappeared).
If at startup the WAL contains commit frames under an unfamiliar salt, the log gets a `WARNING: the WAL holds … under a foreign salt`
and a copy is preserved as `data/orphaned-wal-<time>.db-wal`. Once you see that warning, recovery is manual.

## Checking

```
curl http://127.0.0.1:6020/health
```

Since the server binds to loopback only, **from another machine this curl points at itself.**
The check must be run on that server.
