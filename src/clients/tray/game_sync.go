package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"fyne.io/systray"
)

// Game Sync affordances for the tray. Checkpoint has exactly one tray presence
// (this process); the desktop app deliberately does not create its own. Driving
// these from here rather than from Electron also means they keep working while
// the desktop app is closed, which an in-app tray never could.

// maxGameSyncSlots caps the "Sync Latest" submenu. fyne.io/systray has no way to
// remove a menu item once it has been created, so the slots are allocated up
// front and shown/hidden/retitled as the workspace list changes.
const maxGameSyncSlots = 16

// gameSyncInterval is how often the status line is refreshed. Faster than the
// daemon-status ticker because it tracks the progress of a running sync/build.
const gameSyncInterval = 3 * time.Second

var (
	mGameSyncStatus *systray.MenuItem
	mSyncLatest     *systray.MenuItem
	syncSlots       []*systray.MenuItem

	// gameSyncMu guards gameSyncBound, which maps a submenu slot index to the
	// workspace currently shown in it. The slot click goroutines read it; the
	// refresh ticker writes it.
	gameSyncMu    sync.Mutex
	gameSyncBound []trayWorkspace
)

// trayWorkspace is the subset of the daemon's Workspace the tray needs. It is
// read straight out of ~/.checkpoint/daemon.json, which the daemon rewrites
// whenever a workspace is added or removed, so no extra endpoint is needed.
type trayWorkspace struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	DaemonID string `json:"daemonId"`
}

// daemonJob mirrors serializeJob in src/core/daemon/src/api/routers/jobs.ts,
// limited to the fields the status line reads.
type daemonJob struct {
	Type        string  `json:"type"`
	Status      string  `json:"status"`
	WorkspaceID string  `json:"workspaceId"`
	CurrentStep *string `json:"currentStep"`
	Progress    *struct {
		Done  int `json:"done"`
		Total int `json:"total"`
	} `json:"progress"`
}

// jobVerbs maps the daemon's job types to what the status line calls them.
var jobVerbs = map[string]string{
	"pull":                   "Syncing",
	"scheduled-sync":         "Syncing",
	"build":                  "Building",
	"generate-project-files": "Generating project files for",
	"submit":                 "Submitting",
	"clean":                  "Cleaning",
	"artifact-apply":         "Applying binaries to",
	"artifact-upload":        "Uploading binaries from",
}

// initGameSyncMenu builds the Game Sync menu items and starts a click-watcher
// goroutine per submenu slot. Called once from onReady, before the items that
// should sit below it in the menu.
func initGameSyncMenu() {
	mGameSyncStatus = systray.AddMenuItem("", "Active Checkpoint job")
	mGameSyncStatus.Disable()
	mGameSyncStatus.Hide()

	mSyncLatest = systray.AddMenuItem(
		"Sync Latest",
		"Sync an Unreal workspace to the latest changelist",
	)
	mSyncLatest.Hide()

	syncSlots = make([]*systray.MenuItem, maxGameSyncSlots)
	for i := range syncSlots {
		slot := mSyncLatest.AddSubMenuItem("", "")
		slot.Hide()
		syncSlots[i] = slot

		index := i
		go func() {
			for range slot.ClickedCh {
				gameSyncMu.Lock()
				var ws trayWorkspace
				bound := index < len(gameSyncBound)
				if bound {
					ws = gameSyncBound[index]
				}
				gameSyncMu.Unlock()

				if bound {
					go syncWorkspaceLatest(ws)
				}
			}
		}()
	}
}

// startGameSyncPoll refreshes the Game Sync menu on its own ticker, independent
// of the slower daemon-status one.
func startGameSyncPoll() {
	go func() {
		ticker := time.NewTicker(gameSyncInterval)
		defer ticker.Stop()
		for range ticker.C {
			refreshGameSyncMenu()
		}
	}()
}

// refreshGameSyncMenu re-resolves the Unreal workspaces, rebinds the submenu
// slots, and updates the status line. Fails soft: when the daemon is not
// answering, the whole section simply hides.
//
// Only ever called from the poll goroutine started by startGameSyncPoll, so it
// needs no locking beyond gameSyncMu, which exists for the slot click handlers
// reading gameSyncBound.
func refreshGameSyncMenu() {
	workspaces := gameSyncWorkspaces()

	gameSyncMu.Lock()
	gameSyncBound = workspaces
	gameSyncMu.Unlock()

	if len(workspaces) == 0 {
		mSyncLatest.Hide()
	} else {
		mSyncLatest.Show()
	}

	for i, slot := range syncSlots {
		if i < len(workspaces) {
			slot.SetTitle(workspaces[i].Name)
			slot.Show()
		} else {
			slot.Hide()
		}
	}

	updateGameSyncStatus(workspaces)
}

// gameSyncCache memoizes the Unreal-workspace probe. Probing costs one daemon
// round trip per workspace, and the answer only changes when a workspace is
// added or removed, so it is recomputed only when the daemon.json list changes.
// A failed probe leaves the key empty so the next tick retries.
var gameSyncCache struct {
	key   string
	value []trayWorkspace
}

// gameSyncWorkspaces returns the workspaces that hold an Unreal project, which
// are the ones Game Sync applies to.
func gameSyncWorkspaces() []trayWorkspace {
	all := readWorkspaces()
	sort.Slice(all, func(i, j int) bool { return all[i].ID < all[j].ID })

	key := ""
	for _, ws := range all {
		key += ws.DaemonID + "/" + ws.ID + ";"
	}
	if key != "" && key == gameSyncCache.key {
		return gameSyncCache.value
	}
	if len(all) == 0 {
		gameSyncCache.key = ""
		gameSyncCache.value = nil
		return nil
	}

	port := getDaemonPort()
	detected := make([]trayWorkspace, 0, len(all))
	probeFailed := false

	for _, ws := range all {
		unreal, err := hasUnrealProject(port, ws)
		if err != nil {
			probeFailed = true
			continue
		}
		if !unreal {
			continue
		}
		if len(detected) == maxGameSyncSlots {
			logTray(
				"game sync: more than %d Unreal workspaces; the rest are not listed in the tray",
				maxGameSyncSlots,
			)
			break
		}
		detected = append(detected, ws)
	}

	sort.Slice(detected, func(i, j int) bool { return detected[i].Name < detected[j].Name })

	if probeFailed {
		// Don't memoize a partial answer; retry on the next tick.
		gameSyncCache.key = ""
	} else {
		gameSyncCache.key = key
	}
	gameSyncCache.value = detected
	return detected
}

// readWorkspaces loads the workspace list from ~/.checkpoint/daemon.json.
func readWorkspaces() []trayWorkspace {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(home, ".checkpoint", "daemon.json"))
	if err != nil {
		return nil
	}
	var cfg struct {
		Workspaces []trayWorkspace `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil
	}
	return cfg.Workspaces
}

// hasUnrealProject reports whether a workspace holds a .uproject or an
// in-workspace engine. getProjectInfo returns null when it holds neither; the
// daemon caches the answer for five minutes, so this stays cheap.
func hasUnrealProject(port int, ws trayWorkspace) (bool, error) {
	input := fmt.Sprintf(
		`{"daemonId":%q,"workspaceId":%q}`, ws.DaemonID, ws.ID,
	)
	var info *struct {
		UprojectPath string `json:"uprojectPath"`
	}
	if err := daemonQuery(port, "workspaces.gameSync.getProjectInfo", input, &info); err != nil {
		return false, err
	}
	return info != nil, nil
}

// updateGameSyncStatus surfaces the first active job for one of the Game Sync
// workspaces in the menu and the tray tooltip.
func updateGameSyncStatus(workspaces []trayWorkspace) {
	if len(workspaces) == 0 {
		clearGameSyncStatus()
		return
	}

	jobs, err := activeJobs(getDaemonPort())
	if err != nil {
		clearGameSyncStatus()
		return
	}

	for _, job := range jobs {
		for _, ws := range workspaces {
			if job.WorkspaceID != ws.ID {
				continue
			}
			label := describeJob(job, ws)
			mGameSyncStatus.SetTitle(label)
			mGameSyncStatus.Show()
			setTooltip("Checkpoint VCS - " + label)
			return
		}
	}

	clearGameSyncStatus()
}

func clearGameSyncStatus() {
	mGameSyncStatus.Hide()
	setTooltip("Checkpoint VCS")
}

// lastTooltip avoids re-issuing the platform call on every idle tick.
var lastTooltip = "Checkpoint VCS"

func setTooltip(text string) {
	if text == lastTooltip {
		return
	}
	lastTooltip = text
	systray.SetTooltip(text)
}

// describeJob renders a job as a single status line, preferring a percentage
// when the job reports one and falling back to its current step.
func describeJob(job daemonJob, ws trayWorkspace) string {
	verb, ok := jobVerbs[job.Type]
	if !ok {
		verb = "Working on"
	}

	label := fmt.Sprintf("%s %s", verb, ws.Name)

	if job.Progress != nil && job.Progress.Total > 0 {
		pct := job.Progress.Done * 100 / job.Progress.Total
		return fmt.Sprintf("%s (%d%%)", label, pct)
	}
	if job.CurrentStep != nil && *job.CurrentStep != "" {
		return fmt.Sprintf("%s - %s", label, *job.CurrentStep)
	}
	return label
}

// activeJobs lists the daemon's currently running jobs.
func activeJobs(port int) ([]daemonJob, error) {
	var jobs []daemonJob
	if err := daemonQuery(port, "jobs.list", `{"activeOnly":true}`, &jobs); err != nil {
		return nil, err
	}
	return jobs, nil
}

// syncWorkspaceLatest starts a pull to the latest changelist. The daemon creates
// the job and returns its id immediately, so there is nothing to wait on: the
// next poll tick picks the job up and shows it on the status line.
//
// Deliberately does not refresh the menu itself. Menu state and gameSyncCache
// are only ever touched by the poll goroutine, which is what keeps them free of
// locking; a click handler reaching in here would race with it.
func syncWorkspaceLatest(ws trayWorkspace) {
	input := fmt.Sprintf(
		`{"daemonId":%q,"workspaceId":%q,"changelistId":null,"filePaths":null,"noProgress":false}`,
		ws.DaemonID, ws.ID,
	)
	if err := daemonMutateInput(getDaemonPort(), "workspaces.sync.pull", input); err != nil {
		logTray("sync latest for workspace %s failed: %v", ws.Name, err)
	}
}
