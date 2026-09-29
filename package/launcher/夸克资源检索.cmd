@echo off
setlocal
title Quark Resource Search
cd /d "%~dp0"
call "%~dp0config.cmd"
if not exist "%~dp0logs" mkdir "%~dp0logs"

echo [1/3] PanSou API on port %PORT% ...
tasklist /FI "IMAGENAME eq pansou.exe" 2>nul | find /i "pansou.exe" >nul
if errorlevel 1 (
  start "PanSou" /min /d "%~dp0app" "%~dp0app\pansou.exe" 1>>"%~dp0logs\pansou.log" 2>&1
  echo       started
) else (
  echo       already running
)

echo [2/3] Web UI on port %UIPORT% ...
netstat -ano | findstr /c:":%UIPORT% " | findstr /c:"LISTENING" >nul
if errorlevel 1 (
  start "QuarkUI" /min /d "%~dp0app\ui" "%~dp0runtime\node.exe" server.js 1>>"%~dp0logs\ui.log" 2>&1
  echo       started
) else (
  echo       already running
)

echo [3/3] opening http://127.0.0.1:%UIPORT%
timeout /t 3 /nobreak >nul
start "" "http://127.0.0.1:%UIPORT%"
exit /b 0
