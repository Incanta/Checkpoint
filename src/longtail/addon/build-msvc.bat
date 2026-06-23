@echo off
SetLocal EnableDelayedExpansion

REM Build the Node.js addon with MSVC (NMake Makefiles generator)
REM This calls cmake directly (bypassing cmake-js) with vcvars64 environment.
REM Usage: build-msvc.bat [debug]

set "BUILD_TYPE=Release"
if /i "%1"=="debug" set "BUILD_TYPE=Debug"

REM Find Visual Studio. Prefer vswhere (ships at a fixed location with every
REM VS 2017+ install and on all GitHub windows runners); it is agnostic to
REM edition, version, and install path, unlike hardcoded directory checks.
set "VSINSTALL="
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "!VSWHERE!" (
    for /f "usebackq tokens=*" %%i in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%i"
)

REM Fallback to well-known install paths if vswhere is unavailable or finds nothing
if not defined VSINSTALL (
    for %%E in (Community Professional Enterprise BuildTools) do (
        if exist "C:\Program Files\Microsoft Visual Studio\2022\%%E\VC\Auxiliary\Build\vcvars64.bat" (
            set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\%%E"
        )
    )
)

if not defined VSINSTALL (
    echo ERROR: Cannot find Visual Studio installation
    exit /b 1
)

if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
    echo ERROR: vcvars64.bat not found under !VSINSTALL!
    exit /b 1
)

echo Using Visual Studio at: !VSINSTALL!
call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

where cl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: cl.exe not found after vcvars64.bat
    exit /b 1
)

REM Kill stale PDB processes
taskkill /f /im mspdbsrv.exe 2>nul

REM Detect Node.js version and paths
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
REM Remove the 'v' prefix
set "NODE_VER=!NODE_VER:~1!"
echo Node.js version: !NODE_VER!

set "CMAKE_JS_DIR=%USERPROFILE%\.cmake-js\node-x64\v!NODE_VER!"
set "NODE_INC=!CMAKE_JS_DIR!\include\node"
set "NODE_LIB=!CMAKE_JS_DIR!\win-x64\node.lib"

if not exist "!NODE_INC!\node_api.h" (
    echo ERROR: Node.js headers not found at !NODE_INC!
    echo Run: npx cmake-js install
    exit /b 1
)
if not exist "!NODE_LIB!" (
    echo ERROR: node.lib not found at !NODE_LIB!
    echo Run: npx cmake-js install
    exit /b 1
)

REM Find win_delay_load_hook.cc from cmake-js
set "DELAY_LOAD_HOOK="
if exist "%~dp0node_modules\cmake-js\lib\cpp\win_delay_load_hook.cc" (
    set "DELAY_LOAD_HOOK=%~dp0node_modules\cmake-js\lib\cpp\win_delay_load_hook.cc"
)

set "SRC_DIR=%cd%"
set "BUILD_DIR=%cd%\build"

echo.

REM Support "clean" as second argument: build-msvc.bat [debug] [clean]
if /i "%2"=="clean" (
    echo === Cleaning build directory ===
    if exist "!BUILD_DIR!" rmdir /s /q "!BUILD_DIR!"
)

if not exist "!BUILD_DIR!" mkdir "!BUILD_DIR!"

REM Check if existing config uses a different generator (e.g. VS instead of NMake)
set "NEED_CONFIGURE=0"
if not exist "!BUILD_DIR!\CMakeCache.txt" (
    set "NEED_CONFIGURE=1"
) else (
    findstr /C:"CMAKE_GENERATOR:INTERNAL=NMake Makefiles" "!BUILD_DIR!\CMakeCache.txt" >nul 2>&1
    if errorlevel 1 (
        echo Detected stale build config ^(wrong generator^), reconfiguring...
        rmdir /s /q "!BUILD_DIR!"
        mkdir "!BUILD_DIR!"
        set "NEED_CONFIGURE=1"
    )
)

if "!NEED_CONFIGURE!"=="1" (
    echo === Configuring addon ^(%BUILD_TYPE%^) ===
    cmake -S "!SRC_DIR!" -B "!BUILD_DIR!" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=!BUILD_TYPE! -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_JS_INC="!NODE_INC!" -DCMAKE_JS_LIB="!NODE_LIB!" -DCMAKE_JS_SRC="!DELAY_LOAD_HOOK!" -DCMAKE_SHARED_LINKER_FLAGS="/DELAYLOAD:NODE.EXE" -DNODE_RUNTIME=node -DNODE_RUNTIMEVERSION=!NODE_VER! -DNODE_ARCH=x64

    if errorlevel 1 (
        echo.
        echo ERROR: CMake configure failed
        exit /b 1
    )
) else (
    echo === Using existing build configuration ^(%BUILD_TYPE%^) ===
    echo    To reconfigure from scratch: build-msvc.bat [debug^|release] clean
)

echo.
echo === Building ===

cmake --build "!BUILD_DIR!" --config !BUILD_TYPE!
if errorlevel 1 (
    echo.
    echo ERROR: Build failed
    exit /b 1
)

echo.
echo === Build complete ===

REM Find the output .node file
set "NODE_FILE="
if exist "!BUILD_DIR!\longtail_addon.node" (
    set "NODE_FILE=!BUILD_DIR!\longtail_addon.node"
) else (
    for /r "!BUILD_DIR!" %%F in (*.node) do (
        set "NODE_FILE=%%F"
        goto :found_node
    )
)
:found_node
if defined NODE_FILE (
    echo Output: !NODE_FILE!
    for %%F in (!NODE_FILE!) do echo Size: %%~zF bytes
) else (
    echo WARNING: .node file not found in build directory
    dir /s /b "!BUILD_DIR!\*" 2>nul
)
