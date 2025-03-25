@echo off
SetLocal EnableDelayedExpansion

call arch_helper.bat

rm -rf dist

mkdir dist
mkdir dist\!PLATFORM!
mkdir dist\!PLATFORM!\debug
mkdir dist\!PLATFORM!\release

@REM copy build\artifacts\!PLATFORM!-cmd-debug\!PLATFORM!\longtail\debug\longtail.exe dist\longtail_debug.exe
@REM copy build\artifacts\!PLATFORM!-cmd-release\!PLATFORM!\longtail\release\longtail.exe dist\longtail.exe

copy build\!PLATFORM!\longtail\debug\longtail.dll dist\!PLATFORM!\debug\longtail.dll
copy build\!PLATFORM!\longtail\debug\longtail.pdb dist\!PLATFORM!\debug\longtail.pdb
copy build\!PLATFORM!\longtail\debug\longtail.lib dist\!PLATFORM!\debug\longtail.lib
copy build\!PLATFORM!\longtail\debug\longtail.exp dist\!PLATFORM!\debug\longtail.exp
copy build\!PLATFORM!\longtail\release\longtail.dll dist\!PLATFORM!\release\longtail.dll
copy build\!PLATFORM!\longtail\release\longtail.pdb dist\!PLATFORM!\release\longtail.pdb
copy build\!PLATFORM!\longtail\release\longtail.lib dist\!PLATFORM!\release\longtail.lib
copy build\!PLATFORM!\longtail\release\longtail.exp dist\!PLATFORM!\release\longtail.exp

@REM copy build\!PLATFORM!\longtail_static\debug\liblongtail_static.a dist\!PLATFORM!\debug\liblongtail.a
@REM copy build\!PLATFORM!\longtail_static\release\liblongtail_static.a dist\!PLATFORM!\release\liblongtail.a

mkdir dist\include
mkdir dist\include\src
mkdir dist\include\lib
mkdir dist\include\lib\archiveblockstore
mkdir dist\include\lib\atomiccancel
mkdir dist\include\lib\bikeshed
mkdir dist\include\lib\blake2
mkdir dist\include\lib\blake3
mkdir dist\include\lib\blockstorestorage
mkdir dist\include\lib\brotli
mkdir dist\include\lib\cacheblockstore
mkdir dist\include\lib\compressblockstore
mkdir dist\include\lib\compressionregistry
mkdir dist\include\lib\filestorage
mkdir dist\include\lib\fsblockstore
mkdir dist\include\lib\hpcdcchunker
mkdir dist\include\lib\lrublockstore
mkdir dist\include\lib\hashregistry
mkdir dist\include\lib\lz4
mkdir dist\include\lib\memstorage
mkdir dist\include\lib\memtracer
mkdir dist\include\lib\meowhash
mkdir dist\include\lib\ratelimitedprogress
mkdir dist\include\lib\shareblockstore
mkdir dist\include\lib\zstd
copy src\*.h dist\include\src
copy lib\longtail_platform.h dist\include\lib
copy lib\archiveblockstore\*.h dist\include\lib\archiveblockstore
copy lib\atomiccancel\*.h dist\include\lib\atomiccancel
copy lib\bikeshed\*.h dist\include\lib\bikeshed
copy lib\blake2\*.h dist\include\lib\blake2
copy lib\blake3\*.h dist\include\lib\blake3
copy lib\blockstorestorage\*.h dist\include\lib\blockstorestorage
copy lib\brotli\*.h dist\include\lib\brotli
copy lib\cacheblockstore\*.h dist\include\lib\cacheblockstore
copy lib\compressblockstore\*.h dist\include\lib\compressblockstore
copy lib\compressionregistry\*.h dist\include\lib\compressionregistry
copy lib\filestorage\*.h dist\include\lib\filestorage
copy lib\fsblockstore\*.h dist\include\lib\fsblockstore
copy lib\hpcdcchunker\*.h dist\include\lib\hpcdcchunker
copy lib\lrublockstore\*.h dist\include\lib\lrublockstore
copy lib\hashregistry\*.h dist\include\lib\hashregistry
copy lib\lz4\*.h dist\include\lib\lz4
copy lib\memstorage\*.h dist\include\lib\memstorage
copy lib\memtracer\*.h dist\include\lib\memtracer
copy lib\meowhash\*.h dist\include\lib\meowhash
copy lib\shareblockstore\*.h dist\include\lib\shareblockstore
copy lib\ratelimitedprogress\*.h dist\include\lib\ratelimitedprogress
copy lib\zstd\*.h dist\include\lib\zstd
