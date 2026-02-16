@echo off
SetLocal EnableDelayedExpansion

REM =========================================================================
REM Build longtail as a static MSVC library (.lib)
REM Must be called from a shell that has NOT yet run vcvars64
REM (we call it ourselves). Can be invoked from Git Bash via:
REM   cmd //c static_lib\\build-msvc.bat [release]
REM =========================================================================

SET SOURCEFOLDER=%~dp0
FOR %%a IN ("%SOURCEFOLDER:~0,-1%") DO SET BASE_DIR=%%~dpa

REM --- Set up MSVC environment ---
REM Try common VS install locations
set "VSINSTALL="

REM Check VS2022 Community
if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Community"
    goto :found_vs
)
REM Check VS2022 Professional
if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Professional"
    goto :found_vs
)
REM Check VS2022 Enterprise
if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
    goto :found_vs
)
REM Check VS2019 Community
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files (x86)\Microsoft Visual Studio\2019\Community"
    goto :found_vs
)
REM Try vswhere as last resort
set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if exist "!VSWHERE!" (
    for /f "usebackq delims=" %%i in (`"!VSWHERE!" -latest -property installationPath`) do set "VSINSTALL=%%i"
)

:found_vs
if "!VSINSTALL!" == "" (
    echo ERROR: Cannot find Visual Studio installation
    exit /b 1
)

if not exist "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" (
    echo ERROR: Cannot find vcvars64.bat at !VSINSTALL!
    exit /b 1
)

call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

REM Verify cl.exe is available
where cl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: cl.exe not found after running vcvars64.bat
    exit /b 1
)

echo Using MSVC compiler:
cl 2>&1 | findstr /i "version"

REM --- Source file lists ---
call !BASE_DIR!all_sources.bat

set TARGET=longtail
set PLATFORM=win32_x64

REM --- Common CFLAGS ---
REM MSVC on x64 doesn't define __SSE2__, __x86_64__, etc. like GCC/Clang.
REM Some third-party headers (e.g. blake2) check for these. We define them
REM manually since SSE2 is baseline on x64.
set COMMON_CFLAGS=/nologo /c /W3 /MT /DWINVER=0x0A00 /D_WIN32_WINNT=0x0A00 /D__SSE2__ /D__SSSE3__ /D__SSE4_1__

if "%1" == "release" (
    set RELEASE_MODE=release
    set OPT=/O2 /DNDEBUG
) else (
    set RELEASE_MODE=debug
    set OPT=/Od /Zi /DLONGTAIL_ASSERTS /DBIKESHED_ASSERTS
)

set OUTPUT_FOLDER=!BASE_DIR!build\!PLATFORM!\!TARGET!\!RELEASE_MODE!_msvc
if NOT EXIST !OUTPUT_FOLDER! (
    mkdir !OUTPUT_FOLDER!
)

set LIB_TARGET=!OUTPUT_FOLDER!\!TARGET!.lib

echo.
echo Building !LIB_TARGET!
echo.

if exist !LIB_TARGET! del !LIB_TARGET!
del /q !OUTPUT_FOLDER!\*.obj >nul 2>&1

REM --- Compile main sources + thirdparty (no special SIMD flags needed on x64) ---
pushd !OUTPUT_FOLDER!

echo [1/5] Compiling main sources...
cl !COMMON_CFLAGS! !OPT! !SRC! !THIRDPARTY_SRC!
if errorlevel 1 (
    echo ERROR: Compilation of main sources failed
    popd
    exit /b 1
)

REM --- SSE sources (SSE/SSE2 baseline on x64, no flag needed) ---
if NOT "!THIRDPARTY_SSE!" == "" (
    echo [2/5] Compiling SSE sources...
    cl !COMMON_CFLAGS! !OPT! !THIRDPARTY_SSE!
    if errorlevel 1 (
        echo ERROR: SSE compilation failed
        popd
        exit /b 1
    )
)

REM --- SSE4.2 sources (intrinsics available on x64 without flag) ---
if NOT "!THIRDPARTY_SSE42!" == "" (
    echo [3/5] Compiling SSE4.2 sources...
    cl !COMMON_CFLAGS! !OPT! !THIRDPARTY_SSE42!
    if errorlevel 1 (
        echo ERROR: SSE4.2 compilation failed
        popd
        exit /b 1
    )
)

REM --- AVX2 sources ---
if NOT "!THIRDPARTY_SRC_AVX2!" == "" (
    echo [4/5] Compiling AVX2 sources...
    cl !COMMON_CFLAGS! !OPT! /arch:AVX2 !THIRDPARTY_SRC_AVX2!
    if errorlevel 1 (
        echo ERROR: AVX2 compilation failed
        popd
        exit /b 1
    )
)

REM --- AVX512 sources ---
if NOT "!THIRDPARTY_SRC_AVX512!" == "" (
    echo [5/5] Compiling AVX512 sources...
    cl !COMMON_CFLAGS! !OPT! /arch:AVX512 !THIRDPARTY_SRC_AVX512!
    if errorlevel 1 (
        echo ERROR: AVX512 compilation failed
        popd
        exit /b 1
    )
)

REM --- NOTE: ZSTD_THIRDPARTY_GCC_SRC (.S files) are GAS syntax ---
REM --- MSVC does not support them; zstd falls back to C automatically ---

popd

REM --- Archive into .lib ---
echo.
echo Archiving into !LIB_TARGET!...
lib /nologo /OUT:!LIB_TARGET! !OUTPUT_FOLDER!\*.obj
if errorlevel 1 (
    echo ERROR: lib.exe archiving failed
    exit /b 1
)

echo.
echo Built: !LIB_TARGET!
for %%F in ("!LIB_TARGET!") do echo Size: %%~zF bytes

REM --- Validate with test ---
echo.
echo Validating...
set TEST_EXE=!OUTPUT_FOLDER!\!TARGET!_test.exe
cl /nologo /MT !OPT! /Fe:!TEST_EXE! !SOURCEFOLDER!test.c /link !LIB_TARGET!
if errorlevel 1 (
    echo ERROR: Test compilation failed
    exit /b 1
)
!TEST_EXE!
if errorlevel 1 (
    echo ERROR: Test execution failed
    exit /b 1
)
echo Validation passed!

