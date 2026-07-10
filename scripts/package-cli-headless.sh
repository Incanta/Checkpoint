#!/usr/bin/env bash
# package-cli-headless.sh: Build and package the self-contained, daemonless
# Checkpoint CLI for the CURRENT host platform (local/dev convenience).
#
# CI builds the CLI and daemon in separate jobs and assembles the package from
# those artifacts via scripts/assemble-cli-package.sh; this script does the same
# assembly but builds both halves from source first, so a developer can produce
# a working headless bundle with one command.
#
# The archive lets a user download one file, extract, and run `chk` with no
# service install. When no resident daemon is reachable, the CLI spawns the
# bundled daemon from resources/daemon in an ephemeral, workspace-scoped mode
# (see src/clients/cli/ephemeral_daemon.hpp).
#
# Requires: cmake, a C++17 compiler, libcurl + nlohmann-json (system or vcpkg),
#           plus everything scripts/build-daemon.sh needs (node, yarn, curl, tar).
#
# Usage: ./scripts/package-cli-headless.sh [<output-dir>]
# Env:   VCPKG_ROOT                use this vcpkg toolchain for the CLI build
#        CHECKPOINT_NODE_VERSION   portable node slug forwarded to build-daemon.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI_DIR="$ROOT_DIR/src/clients/cli"
OUTPUT_DIR="${1:-$ROOT_DIR/dist-cli}"

PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
esac
case "$PLATFORM" in
  darwin) PLATFORM_SLUG="darwin-${ARCH}" ;;
  linux)  PLATFORM_SLUG="linux-${ARCH}" ;;
  msys*|mingw*|cygwin*) PLATFORM_SLUG="win32-${ARCH}" ;;
  *) echo "Unsupported platform: $PLATFORM" >&2; exit 1 ;;
esac

echo "=== Packaging headless Checkpoint CLI (${PLATFORM_SLUG}) ==="

# Step 1: Build the CLI (chk + checkpoint).
echo "[1/3] Building CLI..."
CLI_BUILD="$CLI_DIR/build"
rm -rf "$CLI_BUILD"; mkdir -p "$CLI_BUILD"
CMAKE_ARGS=(-DCMAKE_BUILD_TYPE=Release)
if [ -n "${VCPKG_ROOT:-}" ]; then
  CMAKE_ARGS+=("-DCMAKE_TOOLCHAIN_FILE=${VCPKG_ROOT}/scripts/buildsystems/vcpkg.cmake")
fi
( cd "$CLI_BUILD" && cmake .. "${CMAKE_ARGS[@]}" && cmake --build . --config Release )
# Normalize binary location (some generators emit into Release/).
if [ -f "$CLI_BUILD/Release/checkpoint" ] || [ -f "$CLI_BUILD/Release/checkpoint.exe" ]; then
  cp "$CLI_BUILD"/Release/checkpoint* "$CLI_BUILD"/Release/chk* "$CLI_BUILD/" 2>/dev/null || true
fi

# Step 2: Build the bundled daemon dist.
echo "[2/3] Building bundled daemon..."
DAEMON_DIST="$ROOT_DIR/src/core/daemon/dist-daemon"
"$SCRIPT_DIR/build-daemon.sh" "$DAEMON_DIST"

# Step 3: Assemble + archive.
echo "[3/3] Assembling package..."
mkdir -p "$OUTPUT_DIR"
"$SCRIPT_DIR/assemble-cli-package.sh" "$CLI_BUILD" "$DAEMON_DIST" "$PLATFORM_SLUG" "$OUTPUT_DIR"

echo ""
echo "=== Headless CLI package complete ==="
