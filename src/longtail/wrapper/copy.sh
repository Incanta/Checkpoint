#!/bin/bash

rm -rf ../../../core/libraries
mkdir -p ../../../core/libraries
cp -f ../longtail/win32_x64/debug/longtail.* ../../../core/libraries/
cp -f ./Debug/* ../../../core/libraries/

cp -f ./_deps/cpr-build/cpr/Debug/cpr.dll ../../../core/libraries/
cp -f ./_deps/curl-build/lib/Debug/libcurl-d.dll ../../../core/libraries/
cp -f ./_deps/zlib-build/Debug/zlib.dll ../../../core/libraries/
