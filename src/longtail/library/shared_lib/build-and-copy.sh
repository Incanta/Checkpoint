#!/bin/bash
set -e

./build.sh
./build.sh release

cd ..

./dist.sh

rm -rf ../wrapper/longtail
cp -r ./dist ../wrapper/longtail
