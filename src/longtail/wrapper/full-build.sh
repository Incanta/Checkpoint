#!/bin/bash

set -e

UNAME_RESPONSE=$(uname -s)
if [[ "$UNAME_RESPONSE" == "Linux" ]]; then
  OS_NAME="linux"
elif [[ "$UNAME_RESPONSE" == "Darwin" ]]; then
  OS_NAME="macos"
else
  OS_NAME="windows"
fi

rm -rf build
mkdir -p build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
make -j$(nproc)

if [[ "$OS_NAME" == "windows" ]]; then
  make copy
else
  ../copy.sh debug
fi
