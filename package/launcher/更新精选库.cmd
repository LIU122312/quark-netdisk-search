@echo off
chcp 65001 >nul
title Update local library
cd /d "%~dp0"
call "%~dp0config.cmd"
echo [1/1] rebuild local index from app\lib ...
"%~dp0runtime\node.exe" "%~dp0app\lib\build-index.js"
echo done. (restart the app if the server is running)
pause >nul
exit /b 0
