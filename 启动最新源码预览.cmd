@echo off
chcp 65001 >nul
title Linden Leaf 实时预览启动器
cd /d "%~dp0"

echo [Linden Leaf] 正在启动最新源码实时预览服务...
netstat -ano | findstr ":18420" >nul
if errorlevel 1 (
    start "" /b node scripts/preview-server.mjs
    timeout /t 1 /nobreak >nul
)

set EDGE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist %EDGE% set EDGE="C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if exist %EDGE% (
    start "" %EDGE% --app=http://127.0.0.1:18420/index.html
) else (
    start http://127.0.0.1:18420/index.html
)
