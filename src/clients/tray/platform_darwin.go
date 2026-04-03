//go:build darwin

package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

const plistLabel = "com.checkpointvcs.daemon"

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", plistLabel+".plist")
}

func startDaemonService() error {
	return exec.Command("launchctl", "load", plistPath()).Run()
}

func stopDaemonService() error {
	return exec.Command("launchctl", "unload", plistPath()).Run()
}

func restartDaemonService() error {
	_ = stopDaemonService()
	return startDaemonService()
}

func openDesktopApp() {
	_ = exec.Command("open", "-a", "Checkpoint").Start()
}
