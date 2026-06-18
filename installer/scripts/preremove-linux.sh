#!/bin/bash
# preremove-linux.sh — Pre-removal hook for Checkpoint on Linux.
#
# This script runs in TWO scenarios:
#   1. `dpkg -r` / `rpm -e` (full uninstall)
#   2. `dpkg -i` / `rpm -U` of a newer version (upgrade) — package managers
#      fire the OLD package's prerm before installing the new files
#
# In both cases we need to stop the daemon and kill the running desktop +
# tray processes so the new package can replace bundled binaries without
# "Text file busy" or similar EBUSY errors on overwrite.

set -e

BIN_DIR="/usr/local/bin"
SERVICE_FILE="/etc/systemd/system/checkpoint-daemon@.service"

echo "Stopping Checkpoint clients..."

# Kill running desktop + tray processes (pkill returns non-zero when no
# match — guard with || true so set -e doesn't abort the script).
pkill -f checkpoint-desktop 2>/dev/null || true
pkill -f checkpoint-tray 2>/dev/null || true

# Stop all running instances of the daemon service
for service in $(systemctl list-units --type=service --no-legend | grep "checkpoint-daemon@" | awk '{print $1}'); do
    echo "Stopping $service..."
    systemctl stop "$service" 2>/dev/null || true
    systemctl disable "$service" 2>/dev/null || true
done

# Remove the systemd service file
if [ -f "$SERVICE_FILE" ]; then
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
fi

# Remove CLI symlinks
rm -f "$BIN_DIR/checkpoint"
rm -f "$BIN_DIR/chk"

echo "Checkpoint services removed."
