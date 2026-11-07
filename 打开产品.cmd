@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24 或更新版本，再运行本文件。
  pause
  exit /b 1
)
echo 启动后，请打开 http://127.0.0.1:4173
node scripts/serve.mjs
pause
