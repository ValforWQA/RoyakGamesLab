@echo off
setlocal
cd /d "%~dp0"
echo ===============================================
echo   RoyakGamesLab Setup
echo ===============================================
where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js/npm was not found in PATH.
  pause
  exit /b 1
)
echo [1/2] Installing modern launcher dependencies...
call npm install
if errorlevel 1 goto :fail
echo [2/2] Installing isolated Electron 11 legacy Flash host...
call npm install --prefix runtime\legacy-flash\app
if errorlevel 1 goto :fail
echo.
echo Setup completed.
if not exist "runtime\legacy-flash\pepflashplayer.dll" (
  echo.
  echo Flash plugin still required:
  echo runtime\legacy-flash\pepflashplayer.dll
)
pause
exit /b 0
:fail
echo Setup failed.
pause
exit /b 1
