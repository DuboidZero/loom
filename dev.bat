@echo off
setlocal
set ROOT=%~dp0
set SERVER=%ROOT%server
set CLIENT=%ROOT%client

echo ============================================
echo  LOOM - Dev Mode
echo ============================================
echo.
echo Starting Python backend in a new window...
start "Loom Backend" cmd /k "cd /d "%SERVER%" && python main.py"

echo Waiting 2 seconds for backend to initialize...
timeout /t 2 /nobreak >nul

echo Starting Tauri dev app...
cd /d "%CLIENT%"
call npm run tauri dev
