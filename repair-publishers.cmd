@echo off
cd /d "%~dp0"
runtime\node.exe maintenance.mjs repairPublishers --apply --max-requests 300
pause
