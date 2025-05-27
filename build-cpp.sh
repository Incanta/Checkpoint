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

pushd src/longtail/library/shared_lib

if [[ "$OS_NAME" == "windows" ]]; then
  ./build-and-copy.bat
else
  ./build-and-copy.sh
fi

popd

pushd src/longtail/wrapper/
./full-build.sh
popd
