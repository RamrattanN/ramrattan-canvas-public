@echo off
setlocal
cd /d "%~dp0"
set "URL=http://127.0.0.1:4173/canvas/"
where node >nul 2>&1 || (echo Node.js is not on PATH. & pause & exit /b 1)
powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "Ramrattan Canvas Server" /min cmd.exe /k node server.mjs
  timeout /t 3 /nobreak >nul
)
start "" "%URL%"
