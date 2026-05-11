@echo off
setlocal
cd /d "%~dp0"

set "PORT=8787"
set "URL=http://127.0.0.1:%PORT%/"
set "SERVER_SCRIPT=%~dp0scripts\session-explorer-server.mjs"
set "NODE_EXE="

for /f "delims=" %%I in ('where node.exe 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%I"
)

if not defined NODE_EXE (
  echo [Session Explorer] node.exe was not found in PATH.
  echo [Session Explorer] Please install Node.js or add it to PATH.
  pause
  exit /b 1
)

where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%api/status' | Out-Null; exit 0 } catch { exit 1 }"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%URL%api/status' | Out-Null; exit 0 } catch { exit 1 }"
)

if errorlevel 1 (
  echo [Session Explorer] Starting local server on %URL% ...
  where pwsh >nul 2>nul
  if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -WindowStyle Hidden -FilePath '%NODE_EXE%' -ArgumentList @('%SERVER_SCRIPT%') -WorkingDirectory '%~dp0'"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -WindowStyle Hidden -FilePath '%NODE_EXE%' -ArgumentList @('%SERVER_SCRIPT%') -WorkingDirectory '%~dp0'"
  )
  timeout /t 2 /nobreak >nul
)

start "" "%URL%"
exit /b 0
