//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// The tray is the only thing that launches the daemon on Windows, so it is
// also the thing that has to bring it back. See supervisor.go.
const supervisesDaemon = true

// daemonChildren counts daemon processes this tray launched that have not
// exited yet.
var daemonChildren atomic.Int32

// daemonLaunchPending reports whether a daemon this tray launched is still
// alive, even if it isn't answering yet (it takes a few seconds to listen).
func daemonLaunchPending() bool { return daemonChildren.Load() > 0 }

// installMarker mirrors the JSON the daemon writes to
// ~/.checkpoint/updates/.installing in updater.applyUpdate, immediately before
// it launches the installer and exits. See InstallMarker in
// src/core/daemon/src/updater.ts.
type installMarker struct {
	StartedAt   int64  `json:"startedAt"`
	FromVersion string `json:"fromVersion"`
	ToVersion   string `json:"toVersion"`
	Installer   string `json:"installer"`
}

// installMarkerMaxAge bounds how long we will hold off starting the daemon on
// a marker alone. An install that is going to happen has replaced the daemon
// files long before this; past it we assume the elevation prompt was dismissed
// or the installer died, and go back to supervising normally.
const installMarkerMaxAge = 10 * time.Minute

func installMarkerPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".checkpoint", "updates", ".installing")
	}
	return filepath.Join(home, ".checkpoint", "updates", ".installing")
}

// installedDaemonVersion reads <INSTDIR>\daemon\VERSION, which the installer
// replaces along with the rest of the daemon directory. Empty when it can't be
// read.
func installedDaemonVersion() string {
	exe, err := daemonExePath()
	if err != nil {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(filepath.Dir(exe), "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// updateInstallInProgress reports whether an installer launched by
// updater.applyUpdate is still expected to be extracting files.
//
// This is the fix for a race that made in-place updates fail silently: the
// installer's first act is to kill checkpoint-daemon.exe so it can overwrite
// it, and the tray's answer to a daemon that went away is to start it again.
// The relaunched daemon then held the file open, the silent (/S) installer's
// extraction failed with nothing on screen and nothing in any log, and the tray
// came back reporting the same update as still available.
//
// The marker is cleared as soon as either the new files land or it ages out, so
// a failed install can't leave the tray refusing to start the daemon.
func updateInstallInProgress() bool {
	p := installMarkerPath()
	data, err := os.ReadFile(p)
	if err != nil {
		return false
	}

	var m installMarker
	if err := json.Unmarshal(data, &m); err != nil {
		_ = os.Remove(p)
		return false
	}

	// VERSION is part of the daemon directory the installer replaces, so a
	// value that no longer matches what we upgraded from means the new files
	// are down and the daemon is safe to start.
	if v := installedDaemonVersion(); v != "" && v != m.FromVersion {
		logTray("update install landed (daemon %s -> %s); resuming supervision", m.FromVersion, v)
		_ = os.Remove(p)
		return false
	}

	age := time.Since(time.UnixMilli(m.StartedAt))
	if age < 0 || age > installMarkerMaxAge {
		logTray(
			"update install marker for %s is %s old with no new files; assuming it failed and resuming supervision",
			m.ToVersion, age.Round(time.Second),
		)
		_ = os.Remove(p)
		return false
	}

	return true
}

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

const (
	daemonProcessLogName = "daemon-process.log"
	// Matches the daemon's own daemon.log archive count.
	maxDaemonProcessArchives = 10
)

// daemonProcessArchiveRe matches the archives archiveDaemonProcessLog writes,
// which use the same timestamp format as the daemon's daemon.log archives.
var daemonProcessArchiveRe = regexp.MustCompile(
	`^daemon-process-\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}(\.\d{3})?\.log$`,
)

// archiveDaemonProcessLog moves the previous launch's capture aside as
// daemon-process-<timestamp>.log and keeps the newest
// maxDaemonProcessArchives, the same scheme the daemon uses for daemon.log.
// Failures are ignored: a capture still held open by an orphaned daemon is
// simply appended to, as before.
func archiveDaemonProcessLog(logPath string) {
	if st, err := os.Stat(logPath); err != nil || st.Size() == 0 {
		return
	}

	dir := filepath.Dir(logPath)
	now := time.Now()
	archived := filepath.Join(dir, "daemon-process-"+now.Format("2006.01.02-15.04.05")+".log")
	if _, err := os.Stat(archived); err == nil {
		archived = filepath.Join(dir, "daemon-process-"+now.Format("2006.01.02-15.04.05.000")+".log")
	}
	if err := os.Rename(logPath, archived); err != nil {
		logTray("could not archive %s: %v", daemonProcessLogName, err)
		return
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var archives []string
	for _, e := range entries {
		if !e.IsDir() && daemonProcessArchiveRe.MatchString(e.Name()) {
			archives = append(archives, e.Name())
		}
	}
	sort.Strings(archives)
	for len(archives) > maxDaemonProcessArchives {
		_ = os.Remove(filepath.Join(dir, archives[0]))
		archives = archives[1:]
	}
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

	// Starting the daemon now would lock the very files the installer is
	// replacing. Callers surface this as a status, not a failure.
	if updateInstallInProgress() {
		return errUpdateInstalling
	}

	exe, err := daemonExePath()
	if err != nil {
		return err
	}

	dir := logsDir()
	_ = os.MkdirAll(dir, 0o755)
	logPath := filepath.Join(dir, daemonProcessLogName)
	archiveDaemonProcessLog(logPath)
	logFile, err := os.OpenFile(
		logPath,
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
	// daemon.log already has the full log; keep this capture to problems and
	// native crash output so it stays small over a long-running session.
	cmd.Env = append(os.Environ(), "CHECKPOINT_CONSOLE_LOG_LEVEL=warn")
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
	daemonChildren.Add(1)

	// Observe the child so an immediate crash is recorded (we don't otherwise
	// wait on it; the daemon is meant to be long-running). The log file is
	// closed only after the process exits so its final output is captured.
	go func() {
		waitErr := cmd.Wait()
		daemonChildren.Add(-1)
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
