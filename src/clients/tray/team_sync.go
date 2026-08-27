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

// Team Sync affordances for the tray. Checkpoint has exactly one tray presence
// (this process); the desktop app deliberately does not create its own. Driving
// these from here rather than from Electron also means they keep working while
// the desktop app is closed, which an in-app tray never could.

// maxTeamSyncSlots caps the "Sync Latest" submenu. fyne.io/systray has no way to
// remove a menu item once it has been created, so the slots are allocated up
// front and shown/hidden/retitled as the workspace list changes.
const maxTeamSyncSlots = 16

// teamSyncInterval is how often the status line is refreshed. Faster than the
// daemon-status ticker because it tracks the progress of a running sync/build.
const teamSyncInterval = 3 * time.Second

var (
	mTeamSyncStatus *systray.MenuItem
	mSyncLatest     *systray.MenuItem
	syncSlots       []*systray.MenuItem

	// teamSyncMu guards teamSyncBound, which maps a submenu slot index to the
	// workspace currently shown in it. The slot click goroutines read it; the
	// refresh ticker writes it.
	teamSyncMu    sync.Mutex
	teamSyncBound []trayWorkspace
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

// initTeamSyncMenu builds the Team Sync menu items and starts a click-watcher
// goroutine per submenu slot. Called once from onReady, before the items that
// should sit below it in the menu.
func initTeamSyncMenu() {
	mTeamSyncStatus = systray.AddMenuItem("", "Active Checkpoint job")
	mTeamSyncStatus.Disable()
	mTeamSyncStatus.Hide()

	mSyncLatest = systray.AddMenuItem(
		"Sync Latest",
		"Sync an Unreal workspace to the latest changelist",
	)
	mSyncLatest.Hide()

	syncSlots = make([]*systray.MenuItem, maxTeamSyncSlots)
	for i := range syncSlots {
		slot := mSyncLatest.AddSubMenuItem("", "")
		slot.Hide()
		syncSlots[i] = slot

		index := i
		go func() {
			for range slot.ClickedCh {
				teamSyncMu.Lock()
				var ws trayWorkspace
				bound := index < len(teamSyncBound)
				if bound {
					ws = teamSyncBound[index]
				}
				teamSyncMu.Unlock()

				if bound {
					go syncWorkspaceLatest(ws)
				}
			}
		}()
	}
}

// startTeamSyncPoll refreshes the Team Sync menu on its own ticker, independent
// of the slower daemon-status one.
func startTeamSyncPoll() {
	go func() {
		ticker := time.NewTicker(teamSyncInterval)
		defer ticker.Stop()
		for range ticker.C {
			refreshTeamSyncMenu()
		}
	}()
}

// refreshTeamSyncMenu re-resolves the Unreal workspaces, rebinds the submenu
// slots, and updates the status line. Fails soft: when the daemon is not
// answering, the whole section simply hides.
//
// Only ever called from the poll goroutine started by startTeamSyncPoll, so it
// needs no locking beyond teamSyncMu, which exists for the slot click handlers
// reading teamSyncBound.
func refreshTeamSyncMenu() {
	workspaces := teamSyncWorkspaces()

	teamSyncMu.Lock()
	teamSyncBound = workspaces
	teamSyncMu.Unlock()

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

	updateTeamSyncStatus(workspaces)
}

// teamSyncWorkspaces returns the workspaces to offer in the tray.
//
// That is simply every workspace the daemon knows about. Team Sync is not
// engine-specific, and "Sync Latest" is a plain pull that any workspace can
// take, so there is nothing to probe for: reading daemon.json is the whole job.
func teamSyncWorkspaces() []trayWorkspace {
	all := readWorkspaces()
	sort.Slice(all, func(i, j int) bool { return all[i].Name < all[j].Name })

	if len(all) > maxTeamSyncSlots {
		logTray(
			"team sync: %d workspaces exceeds the %d tray slots; the rest are not listed",
			len(all), maxTeamSyncSlots,
		)
		all = all[:maxTeamSyncSlots]
	}

	return all
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

// updateTeamSyncStatus surfaces the first active job for one of the known
// workspaces in the menu and the tray tooltip.
func updateTeamSyncStatus(workspaces []trayWorkspace) {
	if len(workspaces) == 0 {
		clearTeamSyncStatus()
		return
	}

	jobs, err := activeJobs(getDaemonPort())
	if err != nil {
		clearTeamSyncStatus()
		return
	}

	for _, job := range jobs {
		for _, ws := range workspaces {
			if job.WorkspaceID != ws.ID {
				continue
			}
			label := describeJob(job, ws)
			mTeamSyncStatus.SetTitle(label)
			mTeamSyncStatus.Show()
			setTooltip("Checkpoint VCS - " + label)
			return
		}
	}

	clearTeamSyncStatus()
}

func clearTeamSyncStatus() {
	mTeamSyncStatus.Hide()
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
// Deliberately does not refresh the menu itself. Menu state and teamSyncCache
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
