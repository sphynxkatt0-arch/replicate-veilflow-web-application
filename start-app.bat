@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo [VeilFlow] Installing dependencies...
  call npm install
)
echo [VeilFlow] Starting dev server...
call npm run dev
pause
