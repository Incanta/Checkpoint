#!/bin/bash
# postinstall-linux.sh — Post-installation script for Checkpoint on Linux
# Runs after package files are installed

set -e

INSTALL_DIR="/opt/Checkpoint"
RESOURCES_DIR="$INSTALL_DIR/resources"
BIN_DIR="/usr/local/bin"
SERVICE_SRC="$RESOURCES_DIR/service/checkpoint-daemon.service"
SERVICE_DEST="/etc/systemd/system/checkpoint-daemon@.service"

echo "Configuring Checkpoint..."

# Create symlinks for CLI binaries in PATH
ln -sf "$RESOURCES_DIR/cli/checkpoint" "$BIN_DIR/checkpoint"
ln -sf "$RESOURCES_DIR/cli/chk" "$BIN_DIR/chk"

# Install the systemd service template from the packaged source of truth
if [ -f "$SERVICE_SRC" ]; then
    cp "$SERVICE_SRC" "$SERVICE_DEST"
else
    echo "WARNING: Service file not found at $SERVICE_SRC"
fi

systemctl daemon-reload

# Enable and start the service for the user who ran the installer
SUDO_USER_NAME="${SUDO_USER:-$USER}"
if [ -n "$SUDO_USER_NAME" ] && [ "$SUDO_USER_NAME" != "root" ]; then
    systemctl enable "checkpoint-daemon@${SUDO_USER_NAME}" 2>/dev/null || true
    systemctl start "checkpoint-daemon@${SUDO_USER_NAME}" 2>/dev/null || true
    echo "Daemon service enabled for user: $SUDO_USER_NAME"
fi

echo "Checkpoint installation complete."
echo "  CLI:    $BIN_DIR/chk"
echo "  Daemon: $RESOURCES_DIR/daemon/checkpoint-daemon"
