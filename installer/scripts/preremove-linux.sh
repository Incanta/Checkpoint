#!/bin/bash
# preremove-linux.sh — Pre-removal script for Checkpoint on Linux
# Runs before package files are removed

set -e

BIN_DIR="/usr/local/bin"
SERVICE_FILE="/etc/systemd/system/checkpoint-daemon@.service"

echo "Removing Checkpoint services..."

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
