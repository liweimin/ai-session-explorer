@echo off
setlocal
cd /d "%~dp0"
echo [AI Session Explorer] Updating tool repository...
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -ExecutionPolicy Bypass -File "%~dp0scripts\Update-AISessionExplorer.ps1"
) else (
  powershell -ExecutionPolicy Bypass -File "%~dp0scripts\Update-AISessionExplorer.ps1"
)
if errorlevel 1 (
  echo.
  echo [AI Session Explorer] Tool update failed.
  pause
  exit /b 1
)
echo.
echo [AI Session Explorer] Tool update completed.
pause
