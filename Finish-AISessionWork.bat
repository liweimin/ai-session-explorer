@echo off
setlocal
cd /d "%~dp0"
echo [AI Session Sync] Pushing latest AI coding sessions for %USERNAME%...
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -ExecutionPolicy Bypass -File "%~dp0scripts\Push-CodexSessions.ps1"
) else (
  powershell -ExecutionPolicy Bypass -File "%~dp0scripts\Push-CodexSessions.ps1"
)
if errorlevel 1 (
  echo.
  echo [AI Session Sync] Push failed.
  pause
  exit /b 1
)
echo.
echo [AI Session Sync] Push completed.
pause
