@echo off
setlocal
cd /d "%~dp0"
echo ===============================================
echo   Building RoyakGamesLab Installer
echo ===============================================
if not exist "node_modules" call npm install
if errorlevel 1 goto :fail
if not exist "runtime\legacy-flash\app\node_modules" call npm install --prefix runtime\legacy-flash\app
if errorlevel 1 goto :fail
call npm run dist:win
if errorlevel 1 goto :fail
echo.
echo Build complete. Check the dist folder for the custom installer and latest.yml.
pause
exit /b 0
:fail
echo Build failed.
pause
exit /b 1
