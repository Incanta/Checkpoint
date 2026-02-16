@echo off
SetLocal EnableDelayedExpansion

REM =========================================================================
REM Build longtail static lib with MSVC, dist it, and copy to wrapper/longtail
REM Run from Git Bash: cmd //c static_lib\\build-and-copy-msvc.bat
REM =========================================================================

SET SOURCEFOLDER=%~dp0

REM Build release only (that's what the addon links)
call "%SOURCEFOLDER%build-msvc.bat" release
if errorlevel 1 (
    echo Build failed!
    exit /b 1
)

REM Determine base directory
FOR %%a IN ("%SOURCEFOLDER:~0,-1%") DO SET BASE_DIR=%%~dpa

REM --- Create dist-msvc directory ---
set DIST_DIR=!BASE_DIR!dist-msvc
if exist !DIST_DIR! rmdir /s /q !DIST_DIR!

mkdir !DIST_DIR!
mkdir !DIST_DIR!\release

copy !BASE_DIR!build\win32_x64\longtail\release_msvc\longtail.lib !DIST_DIR!\release\longtail.lib

REM --- Copy include headers (reuse structure from dist.bat) ---
mkdir !DIST_DIR!\include
mkdir !DIST_DIR!\include\src
mkdir !DIST_DIR!\include\lib
mkdir !DIST_DIR!\include\lib\archiveblockstore
mkdir !DIST_DIR!\include\lib\atomiccancel
mkdir !DIST_DIR!\include\lib\bikeshed
mkdir !DIST_DIR!\include\lib\blake2
mkdir !DIST_DIR!\include\lib\blake3
mkdir !DIST_DIR!\include\lib\blockstorestorage
mkdir !DIST_DIR!\include\lib\brotli
mkdir !DIST_DIR!\include\lib\cacheblockstore
mkdir !DIST_DIR!\include\lib\compressblockstore
mkdir !DIST_DIR!\include\lib\compressionregistry
mkdir !DIST_DIR!\include\lib\filestorage
mkdir !DIST_DIR!\include\lib\fsblockstore
mkdir !DIST_DIR!\include\lib\hpcdcchunker
mkdir !DIST_DIR!\include\lib\hashregistry
mkdir !DIST_DIR!\include\lib\lrublockstore
mkdir !DIST_DIR!\include\lib\memstorage
mkdir !DIST_DIR!\include\lib\memtracer
mkdir !DIST_DIR!\include\lib\meowhash
mkdir !DIST_DIR!\include\lib\ratelimitedprogress
mkdir !DIST_DIR!\include\lib\lz4
mkdir !DIST_DIR!\include\lib\zstd
mkdir !DIST_DIR!\include\lib\shareblockstore

copy !BASE_DIR!src\longtail.h !DIST_DIR!\include\src\ >nul
copy !BASE_DIR!lib\longtail_platform.h !DIST_DIR!\include\lib\ >nul
copy !BASE_DIR!lib\filestorage\*.h !DIST_DIR!\include\lib\filestorage\ >nul
copy !BASE_DIR!lib\archiveblockstore\*.h !DIST_DIR!\include\lib\archiveblockstore\ >nul
copy !BASE_DIR!lib\atomiccancel\*.h !DIST_DIR!\include\lib\atomiccancel\ >nul
copy !BASE_DIR!lib\bikeshed\*.h !DIST_DIR!\include\lib\bikeshed\ >nul
copy !BASE_DIR!lib\blake2\*.h !DIST_DIR!\include\lib\blake2\ >nul
copy !BASE_DIR!lib\blake3\*.h !DIST_DIR!\include\lib\blake3\ >nul
copy !BASE_DIR!lib\blockstorestorage\*.h !DIST_DIR!\include\lib\blockstorestorage\ >nul
copy !BASE_DIR!lib\brotli\*.h !DIST_DIR!\include\lib\brotli\ >nul
copy !BASE_DIR!lib\cacheblockstore\*.h !DIST_DIR!\include\lib\cacheblockstore\ >nul
copy !BASE_DIR!lib\compressblockstore\*.h !DIST_DIR!\include\lib\compressblockstore\ >nul
copy !BASE_DIR!lib\compressionregistry\*.h !DIST_DIR!\include\lib\compressionregistry\ >nul
copy !BASE_DIR!lib\fsblockstore\*.h !DIST_DIR!\include\lib\fsblockstore\ >nul
copy !BASE_DIR!lib\hpcdcchunker\*.h !DIST_DIR!\include\lib\hpcdcchunker\ >nul
copy !BASE_DIR!lib\hashregistry\*.h !DIST_DIR!\include\lib\hashregistry\ >nul
copy !BASE_DIR!lib\lrublockstore\*.h !DIST_DIR!\include\lib\lrublockstore\ >nul
copy !BASE_DIR!lib\memstorage\*.h !DIST_DIR!\include\lib\memstorage\ >nul
copy !BASE_DIR!lib\memtracer\*.h !DIST_DIR!\include\lib\memtracer\ >nul
copy !BASE_DIR!lib\meowhash\*.h !DIST_DIR!\include\lib\meowhash\ >nul
copy !BASE_DIR!lib\ratelimitedprogress\*.h !DIST_DIR!\include\lib\ratelimitedprogress\ >nul
copy !BASE_DIR!lib\lz4\*.h !DIST_DIR!\include\lib\lz4\ >nul
copy !BASE_DIR!lib\zstd\*.h !DIST_DIR!\include\lib\zstd\ >nul
copy !BASE_DIR!lib\shareblockstore\*.h !DIST_DIR!\include\lib\shareblockstore\ >nul

echo.
echo dist-msvc created successfully.
echo Release lib: !DIST_DIR!\release\longtail.lib

REM --- Copy to wrapper/longtail (same as build-and-copy.bat) ---
set WRAPPER_LONGTAIL=!BASE_DIR!..\wrapper\longtail
if exist !WRAPPER_LONGTAIL! rmdir /s /q !WRAPPER_LONGTAIL!

xcopy /E /I /Q !DIST_DIR! !WRAPPER_LONGTAIL!

echo Copied to !WRAPPER_LONGTAIL!

