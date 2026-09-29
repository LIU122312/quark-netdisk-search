@echo off
chcp 65001 >nul
title Update local library
cd /d "%~dp0"
call "%~dp0config.cmd"
if not exist "%~dp0app\lib\aliyunpanshare" (
  echo [skip] source folder not found: app\lib\aliyunpanshare
  echo        the shipped index.json already works; rebuilding needs that folder.
  pause >nul
  exit /b 1
)
echo [1/1] rebuild local index from app\lib ...
"%~dp0runtime\node.exe" "%~dp0app\lib\build-index.js"
echo done. (restart the app if the server is running)
pause >nul
exit /b 0
