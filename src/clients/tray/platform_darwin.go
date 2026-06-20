//go:build darwin

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const plistLabel = "com.checkpointvcs.daemon"

func plistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", plistLabel+".plist")
}

// runServiceCmd runs a service-control command and folds its combined output
// into the returned error so failures are visible to the caller.
func runServiceCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

func startDaemonService() error {
	return runServiceCmd("launchctl", "load", plistPath())
}

func stopDaemonService() error {
	return runServiceCmd("launchctl", "unload", plistPath())
}

func restartDaemonService() error {
	_ = stopDaemonService()
	return startDaemonService()
}

func openPath(p string) {
	_ = exec.Command("open", p).Start()
}

func openDesktopApp() {
	_ = exec.Command("open", "-a", "Checkpoint").Start()
}
