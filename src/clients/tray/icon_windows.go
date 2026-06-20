//go:build windows

package main

import _ "embed"

// trayIconData is the system-tray icon. Windows requires ICO format; a PNG
// renders as no icon in the notification area.
//
//go:embed assets/icon.ico
var trayIconData []byte
