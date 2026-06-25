@echo off
setlocal
set ROOT=%~dp0
set CLIENT=%ROOT%client
set BUNDLE=%CLIENT%\src-tauri\target\release\bundle

echo.
echo ============================================================
echo   LOOM v4 - Build ^& Package
echo ============================================================
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
echo ============================================================
echo   Build complete! Installers:
echo.
echo   NSIS: %BUNDLE%\nsis\Loom_4.0.0_x64-setup.exe
echo   MSI:  %BUNDLE%\msi\Loom_4.0.0_x64_en-US.msi
echo ============================================================
echo.
pause