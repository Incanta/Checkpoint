//go:build darwin || linux

package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

// instanceLock holds ~/.checkpoint/tray.lock open (and flock'd) for the life
// of the process. Keeping a reference stops the file from being closed by the
// garbage collector, and the kernel drops the lock when the process exits, so
// a crashed tray never leaves a stale lock behind.
var instanceLock *os.File

// acquireSingleInstance reports whether this process is the only tray running
// for the current user.
//
// Any failure other than "already locked" fails open: a second tray icon is a
// lesser problem than no tray at all.
func acquireSingleInstance() bool {
	home, err := os.UserHomeDir()
	if err != nil {
		logTray("single-instance: %v; continuing without a lock", err)
		return true
	}
	dir := filepath.Join(home, ".checkpoint")
	_ = os.MkdirAll(dir, 0o755)

	f, err := os.OpenFile(filepath.Join(dir, "tray.lock"), os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		logTray("single-instance: %v; continuing without a lock", err)
		return true
	}
	if err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		if errors.Is(err, unix.EWOULDBLOCK) {
			return false
		}
		logTray("single-instance: flock failed: %v; continuing without a lock", err)
		return true
	}
	instanceLock = f
	return true
}
