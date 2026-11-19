@echo off
rem easyeda2KicadGuiTool launcher (Windows)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
node scripts\check-python.js || (
  echo Installing Python dependency easyeda2kicad...
  call npm run setup || (pause & exit /b 1)
)
node server.js
pause
