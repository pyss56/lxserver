@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在关闭标题含 lx-server-dev 的窗口(cmd / powershell 都要关，否则旧窗口仍占着 9527 端口)...
powershell -NoProfile -Command "Get-Process cmd,powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'lx-?server-dev' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }"

echo 正在停止旧的 lx-server 开发进程(node / tsx / nodemon / index.ts)...
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'index\.ts|tsx|nodemon' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo 强制释放 9527 端口(防止旧进程残留导致新进程起不来)...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :9527 ^| findstr LISTENING') do taskkill /f /pid %%a >nul 2>nul

echo 等待进程退出...
timeout /t 2 >nul

if exist dev.log del /q dev.log 2>nul

echo 正在启动新的 lx-server 开发进程(新窗口，实时显示日志并写入 dev.log)...
start "lx-server-dev" cmd /k "chcp 65001 >nul & npm run dev 2>&1 | node dev-tee.js"

echo.
echo 已完成：新进程在新窗口「lx-server-dev」中运行。
echo 窗口会实时显示运行日志（UTF-8，中文不乱码），同时完整写入 dev.log。
