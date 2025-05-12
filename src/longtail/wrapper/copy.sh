#!/bin/bash

output_dirs=(
  "../../../core/libraries"
  "../../../unreal/Source/ThirdParty/CheckpointLibrary"
)

for dir in "${output_dirs[@]}"; do
  rm -rf $dir
  mkdir -p $dir/win64
  cp -f ../longtail/win32_x64/debug/longtail.* $dir/win64
  cp -f ./Debug/* $dir/win64

  cp -f ./_deps/cpr-build/cpr/Debug/cpr.dll $dir/win64
  cp -f ./_deps/curl-build/lib/Debug/libcurl-d.dll $dir/win64
  cp -f ./_deps/zlib-build/Debug/zlib.dll $dir/win64
  cp -f ../src/exposed/exposed.h $dir/checkpoint.h
done
