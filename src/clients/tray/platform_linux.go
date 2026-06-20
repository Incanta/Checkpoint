//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"strings"
)

func serviceUnit() string {
	if u, err := user.Current(); err == nil && u.Username != "root" {
		return fmt.Sprintf("checkpoint-daemon@%s", u.Username)
	}
	return "checkpoint-daemon"
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
	return runServiceCmd("systemctl", "start", serviceUnit())
}

func stopDaemonService() error {
	return runServiceCmd("systemctl", "stop", serviceUnit())
}

func restartDaemonService() error {
	return runServiceCmd("systemctl", "restart", serviceUnit())
}

func openPath(p string) {
	_ = exec.Command("xdg-open", p).Start()
}

func openDesktopApp() {
	candidates := []string{
		"/opt/Checkpoint/checkpoint",
		"/usr/bin/checkpoint-desktop",
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			_ = exec.Command(p).Start()
			return
		}
	}
	_ = exec.Command("xdg-open", "checkpoint").Start()
}
