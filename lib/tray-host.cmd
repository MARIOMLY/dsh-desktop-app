@echo off
rem tray-host.cmd -- start the DSH tray host with a correctly quoted command line.
rem
rem Why a wrapper: the host needs parameters that contain spaces and parentheses
rem ("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"). Passing those
rem through Start-Process -ArgumentList from PowerShell 5.1 re-splits them and the
rem script dies with "A positional parameter cannot be found" (observed). cmd.exe
rem forwards the original command line verbatim, so the quoting survives.
rem
rem ASCII-only on purpose (same ANSI-code-page trap as the .ps1 files).

setlocal
set "SCRIPT=%~dp0tray-host.ps1"
if not exist "%SCRIPT%" exit /b 2

powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT%" %*
exit /b %ERRORLEVEL%
