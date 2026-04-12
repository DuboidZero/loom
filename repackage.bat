@echo off
setlocal
set ROOT=%~dp0
set SERVER=%ROOT%server
set CLIENT=%ROOT%client
set BINARIES=%CLIENT%\src-tauri\binaries

echo ============================================
echo  LOOM - Full Repackage
echo ============================================
echo.

:: Step 1 - Build Python backend
echo [1/4] Building Python backend with PyInstaller...
cd /d "%SERVER%"
python -m PyInstaller loom.spec --distpath ./dist --workpath ./build --noconfirm
if errorlevel 1 (
    echo.
    echo ERROR: PyInstaller build failed. Check output above.
    pause
    exit /b 1
)
echo.

:: Step 2 - Copy binary into Tauri sidecar slot
echo [2/4] Copying backend binary to Tauri binaries...
copy /Y "%SERVER%\dist\loom-backend.exe" "%BINARIES%\loom-backend-x86_64-pc-windows-msvc.exe"
if errorlevel 1 (
    echo.
    echo ERROR: Failed to copy binary.
    pause
    exit /b 1
)
echo.

:: Step 3 - Install frontend dependencies
echo [3/4] Installing frontend dependencies...
cd /d "%CLIENT%"
call npm install
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
echo.

:: Step 4 - Tauri production build
echo [4/4] Building Tauri app (this takes a few minutes)...
call npm run tauri build
if errorlevel 1 (
    echo.
    echo ERROR: Tauri build failed. Check output above.
    pause
    exit /b 1
)

echo.
echo ============================================
echo  Build complete!
echo  Installer is in:
echo  client\src-tauri\target\release\bundle\
echo ============================================
pause
