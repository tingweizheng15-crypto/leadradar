@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:7788"
node console\server.mjs
