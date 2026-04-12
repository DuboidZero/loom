@echo off
setlocal
set ROOT=%~dp0
set SERVER=%ROOT%server
set CLIENT=%ROOT%client
set BINARIES=%CLIENT%\src-tauri\binaries
set BUNDLE=%CLIENT%\src-tauri\target\release\bundle

echo.
echo ============================================================
echo   LOOM v4 - Build ^& Package
echo ============================================================
echo.

:: Step 1 — Build Python backend
echo [1/4] Building Python backend with PyInstaller...
cd /d "%SERVER%"
python -m PyInstaller loom.spec --distpath ./dist --workpath ./build --noconfirm
if errorlevel 1 (
    echo.
    echo ERROR: PyInstaller build failed.
    pause & exit /b 1
)
echo Done.
echo.

:: Step 2 — Copy binary into Tauri sidecar slot
echo [2/4] Copying backend binary to Tauri binaries...
powershell -Command "Copy-Item -Force '%SERVER%\dist\loom-backend.exe' '%BINARIES%\loom-backend-x86_64-pc-windows-msvc.exe'"
if errorlevel 1 (
    echo.
    echo ERROR: Failed to copy binary.
    pause & exit /b 1
)
echo Done.
echo.

:: Step 3 — npm install
echo [3/4] Installing frontend dependencies...
cd /d "%CLIENT%"
cmd /c "npm install"
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause & exit /b 1
)
echo Done.
echo.

:: Step 4 — Tauri build (both NSIS + MSI)
echo [4/4] Building Tauri installers (NSIS + MSI)...
echo       This takes a few minutes - please wait.
cmd /c "npm run tauri build -- --bundles nsis,msi"
if errorlevel 1 (
    echo.
    echo ERROR: Tauri build failed.
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