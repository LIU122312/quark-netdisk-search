@echo off
setlocal
title Stop Quark Resource Search
echo stopping Web UI ...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /c:":8899 " ^| findstr /c:"LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo stopping PanSou ...
taskkill /F /IM pansou.exe >nul 2>&1
echo done.
timeout /t 2 /nobreak >nul
exit /b 0
