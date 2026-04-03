//go:build linux

package main

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
)

func serviceUnit() string {
	if u, err := user.Current(); err == nil && u.Username != "root" {
		return fmt.Sprintf("checkpoint-daemon@%s", u.Username)
	}
	return "checkpoint-daemon"
}

func startDaemonService() error {
	return exec.Command("systemctl", "start", serviceUnit()).Run()
}

func stopDaemonService() error {
	return exec.Command("systemctl", "stop", serviceUnit()).Run()
}

func restartDaemonService() error {
	return exec.Command("systemctl", "restart", serviceUnit()).Run()
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
