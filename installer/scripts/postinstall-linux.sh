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

# Install tray auto-start for the installing user
TRAY_BIN="$RESOURCES_DIR/tray/checkpoint-tray"
TRAY_DESKTOP_SRC="$RESOURCES_DIR/tray/checkpoint-tray.desktop"
if [ -n "$SUDO_USER_NAME" ] && [ "$SUDO_USER_NAME" != "root" ]; then
    USER_HOME=$(eval echo "~$SUDO_USER_NAME")
    AUTOSTART_DIR="$USER_HOME/.config/autostart"
    mkdir -p "$AUTOSTART_DIR"
    if [ -f "$TRAY_DESKTOP_SRC" ]; then
        cp "$TRAY_DESKTOP_SRC" "$AUTOSTART_DIR/checkpoint-tray.desktop"
    else
        # Generate from installed binary path
        cat > "$AUTOSTART_DIR/checkpoint-tray.desktop" <<TRAYEOF
[Desktop Entry]
Type=Application
Name=Checkpoint Tray
Exec=$TRAY_BIN
Icon=checkpoint
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=true
TRAYEOF
    fi
    chown -R "$SUDO_USER_NAME" "$AUTOSTART_DIR/checkpoint-tray.desktop"
fi

echo "Checkpoint installation complete."
echo "  CLI:    $BIN_DIR/chk"
echo "  Daemon: $RESOURCES_DIR/daemon/checkpoint-daemon"
echo "  Tray:   $TRAY_BIN"
