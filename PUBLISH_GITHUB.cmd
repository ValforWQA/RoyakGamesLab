@echo off
setlocal
cd /d "%~dp0"
echo ===============================================
echo   RoyakGamesLab - Publish GitHub Release
echo ===============================================
if "%GH_TOKEN%"=="" (
  echo.
  echo GH_TOKEN is not set.
  echo Set a GitHub token for ValforWQA/RoyakGamesLab first:
  echo   set GH_TOKEN=YOUR_TOKEN
  echo.
  echo Or build with BUILD.cmd and upload the files from dist manually.
  pause
  exit /b 1
)
if not exist "node_modules" call npm install
if errorlevel 1 goto :fail
if not exist "runtime\legacy-flash\app\node_modules" call npm install --prefix runtime\legacy-flash\app
if errorlevel 1 goto :fail
call npm run publish:github
if errorlevel 1 goto :fail
echo.
echo GitHub release publish complete.
pause
exit /b 0
:fail
echo.
echo Publish failed.
pause
exit /b 1
