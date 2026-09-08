@echo off
setlocal
cd /d "%~dp0"
echo ===============================================
echo   RoyakGamesLab Development Setup
echo ===============================================
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js/npm was not found in PATH.
  pause
  exit /b 1
)
echo [1/2] Installing launcher dependencies...
call npm install
if errorlevel 1 goto :fail
echo [2/2] Installing isolated legacy Flash host...
call npm install --prefix runtime\legacy-flash\app
if errorlevel 1 goto :fail
echo.
echo Setup completed.
echo Flash plugins are bundled under runtime\flash for Windows, macOS and Linux.
pause
exit /b 0
:fail
echo Setup failed.
pause
exit /b 1
