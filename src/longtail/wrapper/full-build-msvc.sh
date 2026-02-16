#!/bin/bash
# Build the LongtailWrapper (and libcurl) with MSVC from Git Bash.
#
# This builds the wrapper as a static library using the Ninja CMake
# generator with MSVC tools (via vcvars64), producing MSVC-compatible
# .lib files. It also rebuilds libcurl via FetchContent.
#
# Prerequisites:
#   - Visual Studio 2022 (or 2019) with C++ workload installed
#   - CMake and Ninja in PATH
#   - The longtail C library must already be built as MSVC .lib:
#     Run: cd ../library/static_lib && ./build-and-copy-msvc.sh
#
# Usage: ./full-build-msvc.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# if

# Clean and create build directory
BUILD_DIR="build-msvc"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# We need to call vcvars64.bat in a cmd.exe context, then run cmake + build.
# Create a temporary .bat script that does all of this.
TEMP_BAT="$BUILD_DIR/_build.bat"
cat > "$TEMP_BAT" << 'BATEOF'
@echo off
SetLocal EnableDelayedExpansion

REM Find Visual Studio
set "VSINSTALL="
if exist "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Community"
    goto :found_vs
)
if exist "C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Professional"
    goto :found_vs
)
if exist "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files\Microsoft Visual Studio\2022\Enterprise"
    goto :found_vs
)
if exist "C:\Program Files (x86)\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat" (
    set "VSINSTALL=C:\Program Files (x86)\Microsoft Visual Studio\2019\Community"
    goto :found_vs
)
echo ERROR: Cannot find Visual Studio installation
exit /b 1

:found_vs
echo Using Visual Studio at: !VSINSTALL!
call "!VSINSTALL!\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1

where cl.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: cl.exe not found after vcvars64.bat
    exit /b 1
)

cd /d %1

echo.
echo === Killing stale mspdbsrv processes ===
taskkill /f /im mspdbsrv.exe 2>nul

REM Use VS-bundled CMake to avoid PDB manager mismatch (C1902)
set "VS_CMAKE=!VSINSTALL!\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
if not exist "!VS_CMAKE!" (
    echo WARNING: VS-bundled cmake not found, falling back to PATH cmake
    set "VS_CMAKE=cmake"
)
echo Using CMake: !VS_CMAKE!

set "SHORT_BUILD=C:\tmp\lt-msvc-build"
if exist "!SHORT_BUILD!" rmdir /s /q "!SHORT_BUILD!"
mkdir "!SHORT_BUILD!"

echo.
echo === Configuring with NMake + MSVC ===
REM Use /Z7 (Embedded) debug info to avoid PDB manager (C1902 workaround)
"!VS_CMAKE!" -S %1\.. -B "!SHORT_BUILD!" -G "NMake Makefiles" -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl -DCMAKE_POLICY_DEFAULT_CMP0141=NEW -DCMAKE_MSVC_DEBUG_INFORMATION_FORMAT=Embedded
if errorlevel 1 exit /b 1

echo.
echo === Building ===
"!VS_CMAKE!" --build "!SHORT_BUILD!"
if errorlevel 1 exit /b 1

REM Copy outputs back
xcopy /E /I /Q "!SHORT_BUILD!" %1 >nul 2>&1

echo.
echo === Build complete ===

echo.
echo === Build complete ===
BATEOF

echo "=== Building wrapper with MSVC (via Ninja) ==="
# Convert to Windows path for cmd
WIN_BUILD_DIR="$(cygpath -w "$SCRIPT_DIR/$BUILD_DIR")"
cmd //c "$(cygpath -w "$TEMP_BAT")" "$WIN_BUILD_DIR"

if [ $? -ne 0 ]; then
  echo "ERROR: Build failed"
  exit 1
fi

echo ""
echo "=== Copying outputs ==="

OS_NAME="windows"
OUTPUT_DIRS=("../addon/libraries")

for dir in "${OUTPUT_DIRS[@]}"; do
  OUTPUT_DIR="$dir/$OS_NAME"
  rm -rf "$OUTPUT_DIR"
  mkdir -p "$OUTPUT_DIR"

  # Copy the MSVC-built longtail.lib from wrapper/longtail/
  if [ -f "longtail/release/longtail.lib" ]; then
    cp -f "longtail/release/longtail.lib" "$OUTPUT_DIR/"
    echo "Copied longtail.lib"
  elif [ -f "longtail/debug/longtail.lib" ]; then
    cp -f "longtail/debug/longtail.lib" "$OUTPUT_DIR/"
    echo "Copied longtail.lib (debug)"
  else
    echo "WARNING: longtail.lib not found in wrapper/longtail/"
    echo "  Run: cd ../library/static_lib && ./build-and-copy-msvc.sh"
  fi

  # Copy the static curl library from the CMake build
  if [ -f "$BUILD_DIR/libcurl-d.lib" ]; then
    cp -f "$BUILD_DIR/libcurl-d.lib" "$OUTPUT_DIR/"
    echo "Copied libcurl-d.lib (Ninja root)"
  elif [ -f "$BUILD_DIR/_deps/curl-build/lib/libcurl-d.lib" ]; then
    cp -f "$BUILD_DIR/_deps/curl-build/lib/libcurl-d.lib" "$OUTPUT_DIR/"
    echo "Copied libcurl-d.lib"
  else
    echo "Looking for curl lib..."
    CURL_LIB=$(find "$BUILD_DIR/_deps/curl-build" -name "*.lib" -print -quit 2>/dev/null)
    if [ -n "$CURL_LIB" ]; then
      cp -f "$CURL_LIB" "$OUTPUT_DIR/"
      echo "Copied $(basename "$CURL_LIB")"
    else
      echo "WARNING: libcurl .lib not found"
      find "$BUILD_DIR" -name "libcurl*" 2>/dev/null || true
    fi
  fi

  # Copy the exposed header
  cp -f src/exposed/exposed.h "$dir/checkpoint.h"
  echo "Copied checkpoint.h"
done

echo ""
echo "=== Done ==="
echo "MSVC libraries copied to addon/libraries/$OS_NAME/"
ls -la "${OUTPUT_DIRS[0]}/$OS_NAME/"
