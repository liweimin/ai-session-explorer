@echo off
setlocal
cd /d "%~dp0"
echo [AI Session Sync] Pulling latest AI coding sessions for %USERNAME%...
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -ExecutionPolicy Bypass -File "%~dp0scripts\Pull-CodexSessions.ps1"
) else (
  powershell -ExecutionPolicy Bypass -File "%~dp0scripts\Pull-CodexSessions.ps1"
)
if errorlevel 1 (
  echo.
  echo [AI Session Sync] Pull failed.
  pause
  exit /b 1
)
echo.
echo [AI Session Sync] Pull completed. You can open Codex or Claude Code and resume now.
pause
