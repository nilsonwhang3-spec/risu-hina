@echo off
REM Risu Elf backend launcher.
REM
REM ASCII-only and self-redirecting on purpose: the caller only ever needs
REM `cmd.exe /c <this-file> [port]` with no quotes, which is what survives both
REM cmd's outer-quote-stripping rule and the ssh -> powershell hop.
REM
REM The restart loop is the supervisor-agnostic update mechanism (plan section 8):
REM exit code 75 means "a new version was installed, re-enter it". NSSM, PM2,
REM systemd or a double-click all get the same behaviour because the loop lives
REM here rather than in the supervisor.
REM
REM Works from either place. A release unpacks this at the install root, next to
REM pyserver\ - which matters, because cmd re-reads a running batch file by byte
REM offset, so an update that overwrote the launcher mid-loop could make cmd
REM execute nonsense. Older installs have it inside pyserver\ and still work.
setlocal
set HERE=%~dp0
if exist "%HERE%app\" (
    set SERVER=%HERE%
) else (
    set SERVER=%HERE%pyserver\
)
if not exist "%SERVER%run.py" (
    echo cannot find run.py - expected "%SERVER%run.py"
    exit /b 2
)

set PORT=%~1
if "%PORT%"=="" set PORT=6020
set LOG=%SERVER%server.log
set RISUELF_PORT=%PORT%
set RISUELF_HOST=127.0.0.1
set PYTHONIOENCODING=utf-8

REM The bundled interpreter first. Its ._pth file owns sys.path outright, so
REM PYTHONPATH and the registry cannot steer it - but PYTHONHOME is honoured
REM even then, and a user who set one for some other program would have it
REM pointed at the wrong stdlib. Clear it.
set PYTHONHOME=
set PY=%SERVER%python\python.exe
if not exist "%PY%" set PY=%SERVER%.venv\Scripts\python.exe

:loop
echo === start %DATE% %TIME% port=%PORT% >> "%LOG%"
"%PY%" "%SERVER%run.py" >> "%LOG%" 2>&1
if errorlevel 75 if not errorlevel 76 (
    echo === update applied, restarting >> "%LOG%"
    goto loop
)
echo === exit %ERRORLEVEL% at %DATE% %TIME% >> "%LOG%"
