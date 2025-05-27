#!/bin/bash

set -e

rm -rf build
mkdir -p build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Debug
make -j$(nproc)
make install
