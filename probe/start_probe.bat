@echo off
REM Phase 0 probe launcher for test-server.
REM
REM ASCII-only and self-redirecting on purpose. Two earlier attempts failed:
REM   1. Start-Process -ArgumentList passed script+flags as ONE argv entry, so
REM      python looked for a file literally named "probe_server.py --host ...".
REM   2. Win32_Process.Create with `cmd /c "quoted exe" args > "quoted log"`
REM      hit cmd's rule that strips the outer quotes, mangling the line.
REM Keeping the whole command inside this file removes both hazards: the
REM caller only ever needs `cmd.exe /c <this-file> <token>`, no quotes at all.
setlocal
set PY=C:\Program Files\Python311\python.exe
set SCRIPT=D:\code\risu-elf\probe\probe_server.py
set LOG=D:\code\risu-elf\probe\out.log
set TOKEN=%~1
if "%TOKEN%"=="" set TOKEN=probe-local
set PORT=%~2
if "%PORT%"=="" set PORT=6020
echo === start %DATE% %TIME% port=%PORT% >> "%LOG%"
"%PY%" "%SCRIPT%" --host 127.0.0.1 --port %PORT% --token %TOKEN% >> "%LOG%" 2>&1
echo === exit %ERRORLEVEL% at %DATE% %TIME% >> "%LOG%"
