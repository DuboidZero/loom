@echo off
setlocal
set ROOT=%~dp0
set CLIENT=%ROOT%client
set BUNDLE=%CLIENT%\src-tauri\target\release\bundle

echo ============================================
echo  LOOM - Full Repackage
echo ============================================
echo.

cd /d "%CLIENT%"
call npm ci
if errorlevel 1 (
    echo.
    echo ERROR: npm ci failed.
    pause & exit /b 1
)

call npm run build:windows
if errorlevel 1 (
    echo.
    echo ERROR: Build failed.
    pause & exit /b 1
)

echo.
echo ============================================
echo  Build complete!
echo  Installer is in:
echo  client\src-tauri\target\release\bundle\
echo ============================================
pause
