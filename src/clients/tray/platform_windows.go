//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const serviceName = "CheckpointDaemon"

// runServiceCmd runs a service-control command and folds its combined output
// into the returned error, so failures (e.g. SCM error 1053) are visible to
// the caller instead of being discarded.
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
	return runServiceCmd("net", "start", serviceName)
}

func stopDaemonService() error {
	return runServiceCmd("net", "stop", serviceName)
}

func restartDaemonService() error {
	_ = stopDaemonService()
	return startDaemonService()
}

func openPath(p string) {
	_ = exec.Command("cmd", "/c", "start", "", p).Start()
}

func openDesktopApp() {
	candidates := []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "Checkpoint", "Checkpoint.exe"),
		filepath.Join(os.Getenv("PROGRAMFILES"), "Checkpoint", "Checkpoint.exe"),
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			_ = exec.Command("cmd", "/c", "start", "", p).Start()
			return
		}
	}
	_ = exec.Command("cmd", "/c", "start", "", "Checkpoint").Start()
}
