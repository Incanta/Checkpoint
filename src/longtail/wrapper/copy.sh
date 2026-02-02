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
  "../../../core/libraries"
  "../../../unreal/Source/ThirdParty/CheckpointLibrary"
)

if [[ "$OS_NAME" == "windows" ]]; then
  EXT_NAME=".dll"
else
  EXT_NAME=".so"
fi

if [[ "$OS_NAME" == "windows" ]]; then
  for dir in "${output_dirs[@]}"; do
    OUTPUT_DIR="$dir/$OS_NAME"
    rm -rf $OUTPUT_DIR
    mkdir -p $OUTPUT_DIR
    cp -f ../longtail/${LIB_FOLDER_LOWERCASE}/longtail.* $OUTPUT_DIR
    cp -f ./${LIB_FOLDER_PASCALCASE}/* $OUTPUT_DIR

    cp -f ../src/exposed/exposed.h $dir/checkpoint.h
  done
else
  for dir in "${output_dirs[@]}"; do
    OUTPUT_DIR="$dir/$OS_NAME"
    rm -rf $OUTPUT_DIR
    mkdir -p $OUTPUT_DIR
    cp -f ../longtail/${LIB_FOLDER_LOWERCASE}/*longtail.* $OUTPUT_DIR
    cp -f ./libLongtailWrapper* $OUTPUT_DIR

    cp -f ./_deps/cpr-build/cpr/libcpr${EXT_NAME}* $OUTPUT_DIR
    cp -f ./_deps/curl-build/lib//libcurl-d${EXT_NAME}* $OUTPUT_DIR
    cp -f ./_deps/zlib-build/libz${EXT_NAME}* $OUTPUT_DIR
    cp -f ../src/exposed/exposed.h $dir/checkpoint.h
  done
fi
