@echo off
REM Install Risu Elf: virtualenv, dependencies, and start it.
REM
REM   setup.bat                     set up and start on 6020
REM   setup.bat -Port 6030          a different port
REM   setup.bat -Service            keep it running across reboots (needs NSSM,
REM                                 and an elevated prompt)
REM   setup.bat -DataDir E:\elfdata put the data somewhere else
REM   setup.bat -Python C:\Python311\python.exe
REM   setup.bat -NoStart            just install
REM
REM Every argument is passed straight through to pyserver\manage.ps1, which is
REM where the actual work is - cmd is a poor place to find an interpreter, build
REM a venv and talk to a service manager.
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0pyserver\manage.ps1" -Action setup %*
