//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

const serviceName = "CheckpointDaemon"

func startDaemonService() error {
	return exec.Command("net", "start", serviceName).Run()
}

func stopDaemonService() error {
	return exec.Command("net", "stop", serviceName).Run()
}

func restartDaemonService() error {
	_ = stopDaemonService()
	return startDaemonService()
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
