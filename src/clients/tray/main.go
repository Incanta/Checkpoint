package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"fyne.io/systray"
)

var (
	mStatus  *systray.MenuItem
	mStart   *systray.MenuItem
	mStop    *systray.MenuItem
	mRestart *systray.MenuItem
)

func main() {
	systray.Run(onReady, onExit)
}

func onReady() {
	systray.SetIcon(generateIcon())
	systray.SetTooltip("Checkpoint VCS")

	mStatus = systray.AddMenuItem("Daemon: Checking...", "Daemon status")
	mStatus.Disable()
	systray.AddSeparator()
	mStart = systray.AddMenuItem("Start Daemon", "Start the Checkpoint daemon service")
	mStop = systray.AddMenuItem("Stop Daemon", "Stop the Checkpoint daemon service")
	mRestart = systray.AddMenuItem("Restart Daemon", "Restart the Checkpoint daemon service")
	systray.AddSeparator()
	mOpenDesktop := systray.AddMenuItem("Open Desktop App", "Open Checkpoint Desktop")
	systray.AddSeparator()
	mQuit := systray.AddMenuItem("Quit", "Quit the tray application")

	go updateDaemonStatus()

	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			updateDaemonStatus()
		}
	}()

	go func() {
		for {
			select {
			case <-mStart.ClickedCh:
				go handleStart()
			case <-mStop.ClickedCh:
				go handleStop()
			case <-mRestart.ClickedCh:
				go handleRestart()
			case <-mOpenDesktop.ClickedCh:
				go openDesktopApp()
			case <-mQuit.ClickedCh:
				systray.Quit()
			}
		}
	}()
}

func onExit() {}

func handleStart() {
	mStart.Disable()
	mStatus.SetTitle("Daemon: Starting...")
	if err := startDaemonService(); err != nil {
		mStatus.SetTitle(fmt.Sprintf("Daemon: Error (%v)", err))
		mStart.Enable()
		return
	}
	time.Sleep(2 * time.Second)
	updateDaemonStatus()
}

func handleStop() {
	mStop.Disable()
	mRestart.Disable()
	mStatus.SetTitle("Daemon: Stopping...")
	if err := stopDaemonService(); err != nil {
		mStatus.SetTitle(fmt.Sprintf("Daemon: Error (%v)", err))
		mStop.Enable()
		mRestart.Enable()
		return
	}
	time.Sleep(2 * time.Second)
	updateDaemonStatus()
}

func handleRestart() {
	mRestart.Disable()
	mStop.Disable()
	mStart.Disable()
	mStatus.SetTitle("Daemon: Restarting...")
	if err := restartDaemonService(); err != nil {
		mStatus.SetTitle(fmt.Sprintf("Daemon: Error (%v)", err))
	}
	time.Sleep(3 * time.Second)
	updateDaemonStatus()
}

func getDaemonPort() int {
	home, err := os.UserHomeDir()
	if err != nil {
		return 13010
	}
	data, err := os.ReadFile(filepath.Join(home, ".checkpoint", "daemon.json"))
	if err != nil {
		return 13010
	}
	var cfg struct {
		DaemonPort int `json:"daemonPort"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil || cfg.DaemonPort == 0 {
		return 13010
	}
	return cfg.DaemonPort
}

func isDaemonRunning() bool {
	port := getDaemonPort()
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	resp.Body.Close()
	return true
}

func updateDaemonStatus() {
	if isDaemonRunning() {
		mStatus.SetTitle("Daemon: Running")
		mStart.Disable()
		mStop.Enable()
		mRestart.Enable()
	} else {
		mStatus.SetTitle("Daemon: Stopped")
		mStart.Enable()
		mStop.Disable()
		mRestart.Disable()
	}
}

// generateIcon creates a 32x32 blue circle PNG as a placeholder tray icon.
func generateIcon() []byte {
	const size = 32
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	cx, cy, r := float64(size)/2, float64(size)/2, float64(size)/2-1
	fill := color.RGBA{R: 59, G: 130, B: 246, A: 255}

	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx, dy := float64(x)-cx+0.5, float64(y)-cy+0.5
			dist := math.Sqrt(dx*dx + dy*dy)
			if dist <= r {
				if dist > r-1 {
					alpha := uint8(255 * (r - dist))
					img.Set(x, y, color.RGBA{R: fill.R, G: fill.G, B: fill.B, A: alpha})
				} else {
					img.Set(x, y, fill)
				}
			}
		}
	}

	var buf bytes.Buffer
	_ = png.Encode(&buf, img)
	return buf.Bytes()
}
