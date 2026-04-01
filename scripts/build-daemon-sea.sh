#!/usr/bin/env bash
# build-daemon-sea.sh — Build Checkpoint Daemon as a Node.js Single Executable Application
# Usage: ./scripts/build-daemon-sea.sh [--output <dir>]
#
# Requires: Node.js 22+, yarn, esbuild, postject

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/src/core/daemon"
OUTPUT_DIR="${1:-$DAEMON_DIR/dist-sea}"

VERSION=$(cat "$ROOT_DIR/VERSION")
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize architecture names
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

echo "=== Building Checkpoint Daemon SEA v${VERSION} (${PLATFORM}-${ARCH}) ==="

# Step 1: Build TypeScript
echo "[1/5] Building TypeScript..."
cd "$DAEMON_DIR"
yarn build

# Step 2: Bundle with esbuild
echo "[2/5] Bundling with esbuild..."
node esbuild.config.mjs

# Step 3: Generate SEA blob
echo "[3/5] Generating SEA blob..."
node --experimental-sea-config sea-config.json

# Step 4: Copy Node.js binary and inject SEA blob
echo "[4/5] Creating SEA binary..."
mkdir -p "$OUTPUT_DIR"

BINARY_NAME="checkpoint-daemon"
NODE_BIN=$(command -v node)

cp "$NODE_BIN" "$OUTPUT_DIR/$BINARY_NAME"

# Remove the code signature on macOS (required before injection)
if [ "$PLATFORM" = "darwin" ]; then
  codesign --remove-signature "$OUTPUT_DIR/$BINARY_NAME"
fi

# Inject the SEA blob
npx postject "$OUTPUT_DIR/$BINARY_NAME" NODE_SEA_BLOB daemon-sea.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# Re-sign on macOS
if [ "$PLATFORM" = "darwin" ]; then
  codesign --sign - "$OUTPUT_DIR/$BINARY_NAME"
fi

# Step 5: Copy longtail addon
echo "[5/5] Copying longtail native addon..."
ADDON_DIR="$ROOT_DIR/src/longtail/addon"
PREBUILD_DIR="$ADDON_DIR/prebuilds"

case "$PLATFORM" in
  linux)   PREBUILD_PLATFORM="linux-x64" ;;
  darwin)  PREBUILD_PLATFORM="darwin-$ARCH" ;;
esac

ADDON_SRC="$PREBUILD_DIR/$PREBUILD_PLATFORM/longtail_addon.node"
if [ -f "$ADDON_SRC" ]; then
  mkdir -p "$OUTPUT_DIR/lib"
  cp "$ADDON_SRC" "$OUTPUT_DIR/lib/longtail_addon.node"
  echo "Copied longtail addon from prebuilds/$PREBUILD_PLATFORM"
else
  echo "WARNING: Longtail addon not found at $ADDON_SRC"
  echo "The daemon will not function without the native addon."
fi

# Copy VERSION file
cp "$ROOT_DIR/VERSION" "$OUTPUT_DIR/VERSION"

echo ""
echo "=== Daemon SEA build complete ==="
echo "Output: $OUTPUT_DIR/$BINARY_NAME"
ls -lh "$OUTPUT_DIR/"
