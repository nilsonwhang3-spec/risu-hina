# 05. First-time install

This is the procedure written after actually running it from scratch on zikmunt-pc. The commands and output are what was run.

**Two pieces, installed separately.** The backend goes on the server (the machine PocketRisu runs on),
the plugin goes into RisuAI. The backend comes first — the plugin connects to the backend the first time it opens.

---

## Prerequisites

| What you need | Check |
|---|---|
| Python | **Not needed.** It ships bundled |
| A directory for the backend | Anywhere works. See §2 |
| PocketRisu or web RisuAI | Whichever you already use |

The interpreter is inside the archive (`pyserver/python/`). Whatever is installed on this machine, only that one is used —
a distribution that makes the user install Python was ruled out from the start, and the first release breaking that
rule has been fixed. `-Python <path>` only means something when running from a source checkout.

---

## 1. The backend

### 1-1. Download and verify

Get three files from the release.

```
Risu.Hina.<version>.Auto.Install.Package.zip
SHA256SUMS.txt
Risu.Hina.Plugin.js        ← what RisuAI uses for auto-update. Used in step 3
```

**Check the hash first.** The contents of this zip become the server that runs, so unpacking an
unverified download is the same as just running code someone handed you.

```powershell
$want = (Get-Content SHA256SUMS-<version>.txt | Where-Object { $_ -like '*backend*' }).Split(' ')[0]
$got  = (Get-FileHash Risu.Hina.0.6.0.Auto.Install.Package.zip -Algorithm SHA256).Hash.ToLower()
if ($want -ne $got) { throw 'hash mismatch' } else { 'hash ok' }
```

### 1-2. Unpack

**One unpack and you are done.** The archive contains the whole `risu-hina/` tree, so there is no folder to
create beforehand and no name to match.

```powershell
Expand-Archive Risu.Hina.0.6.0.Auto.Install.Package.zip -DestinationPath D:\code -Force
```

```
D:\code\risu-hina\
  pyserver\              code + launcher. An update swaps this wholesale
  plugin\                the plugin to install into RisuAI
  data\                  yours. An update does not touch it
  start.bat  start.sh
  setup.bat  uninstall.bat        (Windows)
  setup.sh   uninstall.sh         (Linux)
  README.md
```

The launcher sitting **outside** `pyserver\` is a safety matter, not tidiness. cmd.exe re-reads a running
batch file by byte offset — if an update overwrites that file at the exact moment the restart loop is sitting
inside `start.bat`, cmd can execute the wrong line.
Keeping it outside the directory an update touches removes that possibility entirely.
(Even so, if the launcher changes, the update drops it alongside as `start.bat.new` and says so in the log.)


### 1-3. Install

```powershell
D:\code\risu-hina\setup.bat
```

```
setup: using C:\Program Files\Python311\python.exe
setup: creating venv
setup: installing dependencies
setup: fastapi 0.115.6 uvicorn 0.34.0
setup: data dir D:\code\risu-hina\data
```

It creates a dedicated venv and installs `requirements.in` (pinned versions). The system Python is left alone.

### 1-4. Start

```powershell
D:\code\risu-hina\setup.bat        REM setup starts it right away
```

```
install    D:\code\risu-hina
data       D:\code\risu-hina\data
processes  2 (venv launcher + server, normal)
           pid 21404
           pid 20596
listening  yes on 6020
health     {"service": "risu-hina", "version": "0.6.0", "ok": true, "agentReady": false, ...}
```

> **`processes 2` is normal.** A Windows venv's `Scripts\python.exe` is
> `venvlauncher.exe`, so it spawns the real interpreter as a child and stays around as the parent.
> There is one server — `listening` and `health` say so.

`agentReady: false` is normal too. You have not entered model credentials yet.

**If you use a different supervisor**, wrap `pyserver\start.bat` (or `pyserver/start.sh`).
NSSM, PM2, systemd, whatever it is, **it has to run the launcher itself** — the self-update asks for
re-entry with exit 75, and that loop lives inside the launcher.

Keeping it resident is scripted in §2, under **Running it as a service**.

### 1-5. Token

```powershell
powershell -ExecutionPolicy Bypass -File D:\code\risu-hina\pyserver\manage.ps1 -Action token
```

```
token: 17sFfQSPMjg6kPH6gi_D8jLg_020Z5zJV1IEmhchbd0
```

**No token is needed if you use PocketRisu on the same machine.** PocketRisu's node server makes the
request on your behalf, so the client IP the backend sees is always 127.0.0.1, and loopback is exempt.
It is only needed when connecting directly from web RisuAI or another machine — and there the token is
**mandatory** and cannot be turned off in settings.

---

## 2. Changing the install location

**Just move the code wherever you want.** There are no hardcoded paths — the scripts compute every path
from where they sit, and processes are found **by the `run.py` path of their own install**.
The folder does not have to be named `risu-hina`.

```powershell
Expand-Archive Risu.Hina.0.6.0.Auto.Install.Package.zip -DestinationPath E:\apps -Force
Rename-Item E:\apps\risu-hina myelf          # name it whatever you like
powershell -ExecutionPolicy Bypass -File E:\apps\myelf\setup.bat
```

The archive holds the whole `risu-hina/` tree, so just unpack it into whatever parent folder you want.
The folder does not have to be named `risu-hina` — rename it after unpacking and it still works.

```
<install>\
  pyserver\   ← code. An update swaps this wholesale
  data\       ← DB, settings, token, workspace. An update never touches it
```

This layout is the premise of the self-update. If the data lived **inside** the code, every version swap
would have to trample the user's chats.

### Putting just the data somewhere else

For when you want it on another drive, or on a disk that gets backed up.

```powershell
powershell -ExecutionPolicy Bypass -File "$install\setup.bat" -DataDir E:\backup\risu-hina-data
```

```
setup: pinned data dir in E:\apps\myelf\pyserver\datadir.txt
setup: data dir E:\backup\risu-hina-data
```

One line with an absolute path is written into `pyserver\datadir.txt`. **It is not a value passed at launch,
it is baked into the install** — that way NSSM, PM2 and a hand-started process all look at the same place.
(The control script launches the server with `Win32_Process.Create` to detach it from the ssh session,
and that runs under the WMI service and inherits no environment variables at all. That is why it has to be a file.)

From then on, `status` and `token` report the real location even when called without `-DataDir`.

To undo it, run `setup` again without `-DataDir`, or delete `datadir.txt`.
**To move it, stop the server, move the whole `data\` folder**, then run `setup -DataDir` again.
The script does not move the data for you — better that than a half-moved state appearing silently.

### On Linux

```bash
unzip Risu.Hina.0.6.0.Auto.Install.Package.zip -d /opt
cd /opt/risu-hina && chmod +x *.sh
./setup.sh                      # checks the bundled Python and starts it
./setup.sh --service            # or keep it resident with PM2
./uninstall.sh                  # stop and deregister
```

`setup.sh` takes `--data-dir <absolute path>` and `--port` (Windows' `-DataDir`, `-Port`).
**It does not look at the system Python.** On a machine that only has 3.8, like Ubuntu 20.04, it runs on the
bundled 3.11 as-is — actually verified in that environment with PATH emptied. All it needs is glibc 2.28+.

### Running it as a service

| | Register | Deregister |
|---|---|---|
| Windows (NSSM) | `setup.bat -Service [-Name RisuHina] [-Port 6020]` | `uninstall.bat [-Name RisuHina]` |
| Linux (PM2) | `./setup.sh --service [--port 6020]` | `./uninstall.sh` |

Both run **`start.bat`/`start.sh`, not `run.py` directly.** exit 75 means "an update was installed, come
back up", and the loop that knows this lives inside the launcher.
Point the supervisor straight at `run.py` and it runs fine right up to the day you update from the plugin, and stops that day.

Registering with NSSM needs **administrator privileges**. Making PM2 survive a boot requires a person to run
the sudo command `pm2 startup` prints — the script does not quietly run a sudo command you have not read.

**The deregister script only removes the registration.** Code and data both stay, and you can go on using the launcher by hand.


### Changing the port

```powershell
... -Action start -Port 6030
```

Give the same `-Port` to `manage.ps1`'s `stop`, `status` and `token` (the status check looks at that port).
`start.bat 6030` / `start.sh 6030` are the same. The environment variable `RISUHINA_PORT` is read too.

### Summary

| What you want to change | How |
|---|---|
| Code location | Just unpack into whatever parent folder you want |
| Data location | `setup.bat -DataDir <absolute path>` / `./setup.sh --data-dir <absolute path>` |
| Port | `-Port` or `RISUHINA_PORT` |
| Interpreter | `setup.bat -Python <path>` / `./setup.sh --python <path>` |
| Bind address | `RISUHINA_HOST` — **read §4 before changing it** |

---

## 3. The plugin

1. RisuAI → Settings → Plugins → **Add Plugin**, and put in `Risu.Hina.Plugin.js`.
2. A **Risu Hina** button appears on the chat screen. Press it to open the panel.
3. Enter the backend URL under **⚙ → 연결** (Connection) at the top right. Same machine:
   `http://127.0.0.1:6020`. Another machine: that address plus the token from §1-5.
4. Under **⚙ → 에이전트 → 수정** (Agent → Edit), enter Base URL, Model and API Key, then **연결 테스트**
   (test connection). The test checks an ordinary response and **a tool call separately** — an agent
   cannot work if tool calls fail, so it has to be caught here.

From then on RisuAI checks for plugin updates itself via `//@update-url`.

---

## 4. Checking and troubleshooting

```powershell
powershell -ExecutionPolicy Bypass -File <install>\pyserver\manage.ps1 -Action status
```

> **`curl http://127.0.0.1:6020/health` from another machine means nothing.**
> It points at itself. The server binds to loopback only, so the check has to be done on that server.

On `health unreachable`, `status` also dumps the last 25 lines of `server.log`.
The log can be seen inside the plugin too — **⚙ → 정보 · 로그 → 서버 로그** (Info · Logs → Server log).
When reporting a problem, copy the **진단 정보** (diagnostics) from the same screen along with it.
Neither one contains API keys or tokens.

| Symptom | Cause |
|---|---|
| `no Python found` | 3.10+ missing or not found → `-Python <path>` |
| `venv missing - run -Action setup first` | Skipped 1-3 |
| `listening NO` + `WinError 10048` in the log | Something else is using that port → `-Port` |
| The plugin says "백엔드 연결 안 됨" (backend not connected) | Typo in the URL, backend not started, or no token entered in web RisuAI |
| "Risu Hina 응답을 받지 못했습니다" (no response received from Risu Hina) right after opening in web RisuAI | Usually the tunnel or VPN in front of the backend has not come up yet — the panel keeps retrying every 30 seconds, and the moment it connects `[plugin] connect recovered` is left in the server log (measured: 2026-08-27 19:30~19:32, the requests never reached the backend at all and it connected two minutes later with no config change). If the response quoted in the message is HTML or an answer from a different server, the URL has a typo. If it is an error from `sv.risuai.xyz`, **Use Plain Fetch** is off in RisuAI settings and the request was relayed |

### Before widening the binding

`RISUHINA_HOST=0.0.0.0` is **the same as handing arbitrary code execution on that machine to anyone who
knows the token** — the agent's `run_python` runs on that machine. The server prints that warning at startup.
If you must widen it, do it only inside a private network such as Tailscale, and never bind to the public internet.

---

## 5. Removing it

```powershell
<install>\uninstall.bat -Purge
Remove-Item -Recurse -Force <install>
```

`data\` (or wherever `datadir.txt` points) holds the chat copies and the workspace.
**The original chats on the RisuAI side are untouched** — this tool only ever wrote back approved edits.
