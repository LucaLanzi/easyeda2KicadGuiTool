@echo off
rem easyeda2KicadGuiTool launcher (Windows)
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 18+ is not installed. Run: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install --no-fund --no-audit || (pause & exit /b 1)
)
node scripts\check-python.js || node scripts\install.js || (pause & exit /b 1)
node server.js %*
pause
