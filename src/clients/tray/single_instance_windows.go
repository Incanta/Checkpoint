//go:build windows

package main

import "golang.org/x/sys/windows"

// instanceMutex is held for the life of the process. Windows releases it when
// the process exits, however it exits, so a crashed tray never leaves a stale
// lock behind.
var instanceMutex windows.Handle

// acquireSingleInstance reports whether this process is the only tray running
// in the current session. "Local\" scopes the mutex to the login session, so
// each user on a shared machine gets their own tray.
//
// Any failure other than "already exists" fails open: a second tray icon is a
// lesser problem than no tray at all.
func acquireSingleInstance() bool {
	name, err := windows.UTF16PtrFromString(`Local\CheckpointTray`)
	if err != nil {
		logTray("single-instance: %v; continuing without a lock", err)
		return true
	}
	h, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		if h != 0 {
			_ = windows.CloseHandle(h)
		}
		return false
	}
	if err != nil {
		logTray("single-instance: CreateMutex failed: %v; continuing without a lock", err)
		return true
	}
	instanceMutex = h
	return true
}
