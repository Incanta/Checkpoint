#!/bin/bash

USE_DEBUG_LIBS=false
if [[ "$1" == "debug" ]]; then
  USE_DEBUG_LIBS=true
fi

LIB_FOLDER_LOWERCASE=release
if [[ "$USE_DEBUG_LIBS" == "true" ]]; then
  LIB_FOLDER_LOWERCASE=debug
fi

LIB_FOLDER_PASCALCASE=Release
if [[ "$USE_DEBUG_LIBS" == "true" ]]; then
  LIB_FOLDER_PASCALCASE=Debug
fi

UNAME_RESPONSE=$(uname -s)
if [[ "$UNAME_RESPONSE" == "Linux" ]]; then
  OS_NAME="linux"
elif [[ "$UNAME_RESPONSE" == "Darwin" ]]; then
  OS_NAME="macos"
else
  OS_NAME="windows"
fi

output_dirs=(
  "../../addon/libraries"
)

# Static library extensions per platform
if [[ "$OS_NAME" == "windows" ]]; then
  STATIC_EXT=".lib"
else
  STATIC_EXT=".a"
fi

for dir in "${output_dirs[@]}"; do
  OUTPUT_DIR="$dir/$OS_NAME"
  rm -rf $OUTPUT_DIR
  mkdir -p $OUTPUT_DIR

  # Copy the static longtail C library
  cp -f ../longtail/${LIB_FOLDER_LOWERCASE}/liblongtail.a $OUTPUT_DIR/ 2>/dev/null || \
  cp -f ../longtail/${LIB_FOLDER_LOWERCASE}/longtail${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || true

  # Copy the static LongtailWrapper library
  if [[ "$OS_NAME" == "windows" ]]; then
    cp -f ./${LIB_FOLDER_PASCALCASE}/LongtailWrapper${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || \
    cp -f ./LongtailWrapper${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || true
  else
    cp -f ./libLongtailWrapper${STATIC_EXT} $OUTPUT_DIR/
  fi

  # Copy the static curl library
  cp -f ./_deps/curl-build/lib/${LIB_FOLDER_PASCALCASE}/libcurl-d${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || \
  cp -f ./_deps/curl-build/lib/libcurl-d${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || \
  cp -f ./_deps/curl-build/lib/libcurl${STATIC_EXT} $OUTPUT_DIR/ 2>/dev/null || true

  # Copy the header
  cp -f ../src/exposed/exposed.h $dir/checkpoint.h
done
