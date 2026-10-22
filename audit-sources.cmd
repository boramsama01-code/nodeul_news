@echo off
cd /d "%~dp0"
runtime\node.exe maintenance.mjs auditSources --output .local\source-audit.json
pause
