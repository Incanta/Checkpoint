//go:build !windows

package main

import _ "embed"

// trayIconData is the system-tray icon. macOS and Linux use PNG.
//
//go:embed assets/icon.png
var trayIconData []byte
