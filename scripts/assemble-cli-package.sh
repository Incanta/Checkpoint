#!/usr/bin/env bash
# assemble-cli-package.sh: Stage the self-contained, daemonless CLI package from
# already-built CLI binaries and a built daemon dist, then archive it.
#
# It only moves/archives files, so it can run on any OS regardless of the target
# platform (CI assembles all targets on one Linux runner from cross-built
# artifacts).
#
# Produced layout (matches src/clients/cli/ephemeral_daemon.hpp::findDaemonPaths,
# which looks for the daemon in <exeDir>/resources/daemon):
#
#   checkpoint-cli-<platform>/
#     chk[.exe]
#     checkpoint[.exe]
#     resources/daemon/{checkpoint-daemon, daemon-bundle.cjs, lib/, node_modules/, VERSION}
#
# Usage:
#   scripts/assemble-cli-package.sh <cli-bin-dir> <daemon-dist-dir> <platform> <output-dir>
#
#   <platform> is e.g. linux-x64, darwin-arm64, win32-x64. A win32 platform
#   produces a .zip and .exe binaries; everything else produces a .tar.gz.
#
# Output: <output-dir>/checkpoint-cli-<platform>/  (staged tree)
#         <output-dir>/checkpoint-cli-<platform>.(tar.gz|zip)

set -euo pipefail

CLI_BIN_DIR="${1:?usage: assemble-cli-package.sh <cli-bin-dir> <daemon-dist-dir> <platform> <output-dir>}"
DAEMON_DIST_DIR="${2:?missing daemon-dist-dir}"
PLATFORM="${3:?missing platform}"
OUTPUT_DIR="${4:?missing output-dir}"

case "$PLATFORM" in
  win32-*) IS_WIN=1; EXE=".exe" ;;
  *)       IS_WIN=0; EXE="" ;;
esac

PKG_NAME="checkpoint-cli-${PLATFORM}"
STAGE_DIR="$OUTPUT_DIR/$PKG_NAME"

echo "=== Assembling ${PKG_NAME} ==="
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR/resources"

# CLI binaries.
cp "$CLI_BIN_DIR/checkpoint${EXE}" "$STAGE_DIR/checkpoint${EXE}"
cp "$CLI_BIN_DIR/chk${EXE}" "$STAGE_DIR/chk${EXE}"

# Daemon dist -> resources/daemon.
cp -R "$DAEMON_DIST_DIR" "$STAGE_DIR/resources/daemon"

# Restore executable bits (GitHub artifact download drops them).
if [ "$IS_WIN" -eq 0 ]; then
  chmod +x "$STAGE_DIR/checkpoint" "$STAGE_DIR/chk" || true
  chmod +x "$STAGE_DIR/resources/daemon/checkpoint-daemon" || true
fi

# Archive.
if [ "$IS_WIN" -eq 1 ]; then
  ARCHIVE="$OUTPUT_DIR/${PKG_NAME}.zip"
  rm -f "$ARCHIVE"
  ( cd "$OUTPUT_DIR" && zip -qry "${PKG_NAME}.zip" "$PKG_NAME" )
else
  ARCHIVE="$OUTPUT_DIR/${PKG_NAME}.tar.gz"
  ( cd "$OUTPUT_DIR" && tar -czf "${PKG_NAME}.tar.gz" "$PKG_NAME" )
fi

echo "Staged:  $STAGE_DIR"
echo "Archive: $ARCHIVE"
