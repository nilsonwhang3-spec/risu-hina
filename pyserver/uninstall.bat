@echo off
REM Stop Risu Elf and undo what setup.bat did.
REM
REM   uninstall.bat            stop it, unregister the service. Deletes nothing.
REM   uninstall.bat -Purge     also delete the venv and the data
REM
REM Without -Purge the code and the data stay and start.bat still works by hand.
REM Deleting someone's chats has to be something they asked for in so many words.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0pyserver\manage.ps1" -Action uninstall %*
