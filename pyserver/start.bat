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
setlocal
set ROOT=%~dp0
set PORT=%~1
if "%PORT%"=="" set PORT=6020
set LOG=%ROOT%server.log
set RISUELF_PORT=%PORT%
set RISUELF_HOST=127.0.0.1
set PYTHONIOENCODING=utf-8

:loop
echo === start %DATE% %TIME% port=%PORT% >> "%LOG%"
"%ROOT%.venv\Scripts\python.exe" "%ROOT%run.py" >> "%LOG%" 2>&1
if errorlevel 75 if not errorlevel 76 (
    echo === update applied, restarting >> "%LOG%"
    goto loop
)
echo === exit %ERRORLEVEL% at %DATE% %TIME% >> "%LOG%"
