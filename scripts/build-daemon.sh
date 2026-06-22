#!/usr/bin/env bash
# build-daemon.sh: Build the Checkpoint Daemon as an esbuild-bundled JS app run
# by a portable Node.js runtime (this replaces the Node Single Executable
# Application approach, which proved unreliable).
#
# The output directory contains:
#   checkpoint-daemon        a portable `node` binary, renamed
#   daemon-bundle.cjs        the esbuild-bundled daemon, executed by that node
#   lib/longtail_addon.node  the longtail native addon
#   node_modules/...         better-sqlite3 (+ its native deps)
#   VERSION                  the client version string
#
# Launchers run the daemon with: checkpoint-daemon daemon-bundle.cjs
# Keeping the runtime named `checkpoint-daemon` preserves the process name the
# tray/service managers rely on (e.g. `taskkill /im checkpoint-daemon.exe`).
#
# Requires: Node.js 22+, yarn, esbuild, curl, tar
#
# Usage: ./scripts/build-daemon.sh [<output-dir>]
# Env:   CHECKPOINT_NODE_VERSION  portable node version slug (default v24.17.0)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON_DIR="$ROOT_DIR/src/core/daemon"
OUTPUT_DIR="${1:-$DAEMON_DIR/dist-daemon}"
NODE_VERSION_SLUG="${CHECKPOINT_NODE_VERSION:-v24.17.0}"

# Source of truth for versions is versions.json (client_version is the
# user-facing desktop/daemon semver).
VERSION=$(node -e "console.log(require(process.argv[1]).client_version)" "$ROOT_DIR/versions.json")
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

# Normalize architecture names
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac

# nodejs.org archives use .tar.xz on Linux and .tar.gz on macOS.
case "$PLATFORM" in
  darwin) NODE_OS="darwin"; NODE_EXT="tar.gz" ;;
  linux)  NODE_OS="linux";  NODE_EXT="tar.xz" ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

echo "=== Building Checkpoint Daemon v${VERSION} (${PLATFORM}-${ARCH}, node ${NODE_VERSION_SLUG}) ==="

# Step 1: Build TypeScript
echo "[1/6] Building TypeScript..."
cd "$DAEMON_DIR"
yarn build

# Step 2: Bundle with esbuild
echo "[2/6] Bundling with esbuild..."
node esbuild.config.mjs

# Step 3: Download the portable Node.js runtime and rename it to checkpoint-daemon
echo "[3/6] Downloading portable Node.js ${NODE_VERSION_SLUG}..."
mkdir -p "$OUTPUT_DIR"
BINARY_NAME="checkpoint-daemon"
NODE_DIST="node-${NODE_VERSION_SLUG}-${NODE_OS}-${ARCH}"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION_SLUG}/${NODE_DIST}.${NODE_EXT}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
curl -fSL "$NODE_URL" -o "$TMP_DIR/node.${NODE_EXT}"
tar -xf "$TMP_DIR/node.${NODE_EXT}" -C "$TMP_DIR"
cp "$TMP_DIR/${NODE_DIST}/bin/node" "$OUTPUT_DIR/$BINARY_NAME"
chmod +x "$OUTPUT_DIR/$BINARY_NAME"

# Step 4: Copy the daemon bundle next to the runtime
echo "[4/6] Copying daemon bundle..."
cp "$DAEMON_DIR/daemon-bundle.cjs" "$OUTPUT_DIR/daemon-bundle.cjs"

# Step 5: Copy longtail addon
echo "[5/6] Copying longtail native addon..."
PREBUILD_PLATFORM="${PLATFORM}-${ARCH}"
ADDON_SRC=$(node -e "const p=require.resolve('@checkpointvcs/longtail-addon/package.json');console.log(require('path').join(require('path').dirname(p),'prebuilds','${PREBUILD_PLATFORM}','longtail_addon.node'))")

if [ -f "$ADDON_SRC" ]; then
  mkdir -p "$OUTPUT_DIR/lib"
  cp "$ADDON_SRC" "$OUTPUT_DIR/lib/longtail_addon.node"
  echo "Copied longtail addon from $ADDON_SRC"
else
  echo "WARNING: Longtail addon not found at $ADDON_SRC"
  echo "The daemon will not function without the native addon."
fi

# Step 6: Copy better-sqlite3 (+ its native deps) next to the runtime so the
# bundle can require it at runtime (it is external to the JS bundle; see
# esbuild.config.mjs). Then write the VERSION file consumed by updater.ts.
echo "[6/6] Copying runtime node_modules..."
node "$ROOT_DIR/scripts/copy-daemon-node-modules.mjs" "$OUTPUT_DIR"
printf '%s' "$VERSION" > "$OUTPUT_DIR/VERSION"

echo ""
echo "=== Daemon build complete ==="
echo "Output: $OUTPUT_DIR/$BINARY_NAME"
ls -lh "$OUTPUT_DIR/"
