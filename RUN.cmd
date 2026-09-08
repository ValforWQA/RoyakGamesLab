@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" call SETUP.cmd
call npm start
