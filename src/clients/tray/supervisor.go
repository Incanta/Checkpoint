package main

import (
	"errors"
	"fmt"
	"net"
	"sync"
	"time"
)

// Daemon supervision: restart a daemon that went away without being asked to.
//
// Only Windows needs this (supervisesDaemon), because there the tray is the
// daemon's only launcher. On macOS and Linux launchd/systemd already restart a
// crashed daemon, and calling systemctl from here would prompt for polkit
// authentication on every attempt.
//
// Launching a second daemon is worse than a short outage: it doesn't fail, it
// walks to the next free port and rewrites daemonPort in daemon.json, leaving
// clients split between two daemons. So a restart happens only when nothing
// suggests a daemon is still on its way up or wedged on the port.

const (
	minRestartBackoff = 10 * time.Second
	maxRestartBackoff = 5 * time.Minute
	// A daemon that stays up this long after an automatic restart counts as
	// recovered, and the next crash starts the backoff over.
	healthyResetAfter = 2 * time.Minute
)

var (
	supervisorMu sync.Mutex
	// daemonStopRequested is set by "Stop Daemon", so a daemon the user stopped
	// on purpose stays stopped until they start it again.
	daemonStopRequested bool
	restartBackoff      time.Duration
	nextRestartAt       time.Time
	lastAutoRestartAt   time.Time
)

func setDaemonStopRequested(stopped bool) {
	supervisorMu.Lock()
	defer supervisorMu.Unlock()
	daemonStopRequested = stopped
	if !stopped {
		restartBackoff = 0
		nextRestartAt = time.Time{}
	}
}

// daemonPortBound reports whether anything accepts TCP connections on the
// daemon port. A daemon that is alive but not answering HTTP still holds it.
func daemonPortBound() bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", getDaemonPort()), time.Second)
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// superviseDaemon runs on every status tick. It reports whether it launched a
// daemon, so the caller can show that instead of a momentary "Stopped".
func superviseDaemon() bool {
	if !supervisesDaemon {
		return false
	}

	running := isDaemonRunning()

	supervisorMu.Lock()
	defer supervisorMu.Unlock()

	now := time.Now()
	if running {
		if restartBackoff > 0 && now.Sub(lastAutoRestartAt) > healthyResetAfter {
			restartBackoff = 0
			nextRestartAt = time.Time{}
		}
		return false
	}

	if daemonStopRequested || now.Before(nextRestartAt) || updateInstallInProgress() {
		return false
	}
	// A daemon we launched that hasn't exited is still starting up (or hung,
	// which a second copy wouldn't fix).
	if daemonLaunchPending() || daemonPortBound() {
		return false
	}

	if restartBackoff == 0 {
		restartBackoff = minRestartBackoff
	} else {
		restartBackoff = min(restartBackoff*2, maxRestartBackoff)
	}
	nextRestartAt = now.Add(restartBackoff)
	lastAutoRestartAt = now

	logTray("supervisor: daemon is not running; restarting it (next attempt no sooner than %s)", restartBackoff)
	if err := startDaemonService(); err != nil {
		if !errors.Is(err, errUpdateInstalling) {
			logTray("supervisor: restart failed: %v", err)
		}
		return false
	}
	return true
}
