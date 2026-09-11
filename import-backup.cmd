@echo off
cd /d "%~dp0"
if "%~1"=="" (
  echo Drag a PostgreSQL SQL backup file onto this script after stopping the application.
  pause
  exit /b 1
)
runtime\node.exe desktop.mjs --import "%~f1"
pause
