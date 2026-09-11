@echo off
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop is required. Install it and start Docker, then run this file again.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Enter POSTGRES_PASSWORD, NAVER_CLIENT_ID and NAVER_CLIENT_SECRET in .env, save, then run this file again.
  notepad .env
  exit /b 0
)
findstr /c:"replace_with_a_long_random_password" .env >nul
if not errorlevel 1 (
  echo Replace the example POSTGRES_PASSWORD in .env first.
  notepad .env
  exit /b 1
)
docker compose up -d --build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Started. Open http://localhost:8080 after the web service is ready.
pause
