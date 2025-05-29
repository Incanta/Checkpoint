#!/bin/bash

SCRIPT_DIR=$(dirname "$(readlink -f "$0")")

pushd $SCRIPT_DIR

docker build -t linux-build-image:latest .
docker run --rm --mount type=bind,src="$(dirname $SCRIPT_DIR)",dst=/app linux-build-image:latest

popd
