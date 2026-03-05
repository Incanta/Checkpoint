#!/usr/bin/env bash
# Build longtail static library, collect headers, and copy to wrapper/longtail.
# This is the Unix equivalent of build-and-copy-msvc.bat — no shared lib needed.
#
# Usage: ./build-and-copy.sh [x64|arm64]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_DIR="$(dirname "$SCRIPT_DIR")"

ARCH="${1:-x64}"

echo "=== Building longtail static lib (release, ${ARCH}) ==="
"$SCRIPT_DIR/build.sh" "$ARCH" release

# Determine platform string
. "$BASE_DIR/arch_helper.sh" "$ARCH"

DIST_DIR="$BASE_DIR/dist-static"
rm -rf "$DIST_DIR"

mkdir -p "$DIST_DIR/release"

# Copy the static lib
cp "$BASE_DIR/build/${PLATFORM}/longtail_static/release/liblongtail_static.a" \
   "$DIST_DIR/release/liblongtail.a"

# Copy headers (same structure as dist.sh / build-and-copy-msvc.bat)
mkdir -p "$DIST_DIR/include/src"
mkdir -p "$DIST_DIR/include/lib"

LIB_SUBDIRS=(
  archiveblockstore
  atomiccancel
  bikeshed
  blake2
  blake3
  blockstorestorage
  brotli
  cacheblockstore
  compressblockstore
  compressionregistry
  filestorage
  fsblockstore
  hpcdcchunker
  hashregistry
  lrublockstore
  lz4
  memstorage
  memtracer
  meowhash
  ratelimitedprogress
  shareblockstore
  zstd
)

for subdir in "${LIB_SUBDIRS[@]}"; do
  mkdir -p "$DIST_DIR/include/lib/$subdir"
  cp "$BASE_DIR/lib/$subdir/"*.h "$DIST_DIR/include/lib/$subdir/"
done

cp "$BASE_DIR/src/"*.h "$DIST_DIR/include/src/"
cp "$BASE_DIR/lib/longtail_platform.h" "$DIST_DIR/include/lib/"

echo "dist-static created successfully."
echo "Release lib: $DIST_DIR/release/liblongtail.a"

# Copy to wrapper/longtail
WRAPPER_LONGTAIL="$BASE_DIR/../wrapper/longtail"
rm -rf "$WRAPPER_LONGTAIL"
cp -r "$DIST_DIR" "$WRAPPER_LONGTAIL"

echo "Copied to $WRAPPER_LONGTAIL"
