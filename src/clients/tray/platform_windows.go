//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// runProcessCmd runs a command and folds its combined output into the returned
// error, so failures are visible to the caller instead of being discarded.
func runProcessCmd(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return fmt.Errorf("%w: %s", err, msg)
		}
		return err
	}
	return nil
}

// daemonExePath locates checkpoint-daemon.exe. The installer lays the tray out
// at <INSTDIR>\tray\checkpoint-tray.exe and the daemon at
// <INSTDIR>\daemon\checkpoint-daemon.exe, so we resolve relative to our own
// executable first, then fall back to known install locations.
func daemonExePath() (string, error) {
	if exe, err := os.Executable(); err == nil {
		candidates := []string{
			filepath.Join(filepath.Dir(exe), "..", "daemon", "checkpoint-daemon.exe"),
			filepath.Join(filepath.Dir(exe), "checkpoint-daemon.exe"),
		}
		for _, c := range candidates {
			if _, e := os.Stat(c); e == nil {
				return filepath.Clean(c), nil
			}
		}
	}
	bases := []string{
		os.Getenv("PROGRAMFILES"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs"),
	}
	for _, base := range bases {
		if base == "" {
			continue
		}
		c := filepath.Join(base, "Checkpoint", "daemon", "checkpoint-daemon.exe")
		if _, e := os.Stat(c); e == nil {
			return c, nil
		}
	}
	return "", fmt.Errorf("checkpoint-daemon.exe not found")
}

// startDaemonService launches the daemon as a detached child process. On
// Windows the daemon is a per-user process, NOT a Windows service: it is a
// portable Node.js runtime (checkpoint-daemon.exe) running daemon-bundle.cjs, a
// plain console app that cannot satisfy the Service Control Manager, which is
// what produced "error 1053: the service did not respond". Its stdout/stderr
// are captured to ~/.checkpoint/logs/daemon-process.log so even early/native
// crashes are visible (the daemon also writes its own daemon.log).
func startDaemonService() error {
	if isDaemonRunning() {
		logTray("start: daemon already responding on port %d; nothing to launch", getDaemonPort())
		return nil
	}

	exe, err := daemonExePath()
	if err != nil {
		return err
	}

	dir := logsDir()
	_ = os.MkdirAll(dir, 0o755)
	logFile, err := os.OpenFile(
		filepath.Join(dir, "daemon-process.log"),
		os.O_APPEND|os.O_CREATE|os.O_WRONLY,
		0o644,
	)
	if err != nil {
		return err
	}

	// The daemon runtime is a portable node renamed to checkpoint-daemon.exe;
	// it runs daemon-bundle.cjs, which ships alongside it in the daemon dir.
	bundle := filepath.Join(filepath.Dir(exe), "daemon-bundle.cjs")
	cmd := exec.Command(exe, bundle)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// CREATE_NO_WINDOW: the tray is a GUI app (-H windowsgui); don't pop a
	// console window for the child.
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x08000000}

	if err := cmd.Start(); err != nil {
		logFile.Close()
		return err
	}

	logTray("start: launched %s (pid %d); output -> daemon-process.log", exe, cmd.Process.Pid)

	// Observe the child so an immediate crash is recorded (we don't otherwise
	// wait on it; the daemon is meant to be long-running). The log file is
	// closed only after the process exits so its final output is captured.
	go func() {
		waitErr := cmd.Wait()
		logFile.Close()
		if waitErr != nil {
			logTray("daemon process exited: %v (see daemon-process.log)", waitErr)
		} else {
			logTray("daemon process exited cleanly")
		}
	}()

	return nil
}

// stopDaemonService terminates any running daemon process.
func stopDaemonService() error {
	return runProcessCmd("taskkill", "/f", "/im", "checkpoint-daemon.exe")
}

func restartDaemonService() error {
	_ = stopDaemonService()
	// Give the OS a moment to release the listening port before relaunching.
	time.Sleep(1 * time.Second)
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
