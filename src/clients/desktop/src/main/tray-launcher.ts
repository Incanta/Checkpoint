import { app } from "electron";
import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

// The Go tray (src/clients/tray) is Checkpoint's always-on presence, and on
// Windows it is also what launches and supervises the daemon. If it exited or
// crashed, nothing else brings it back, so the desktop app relaunches it
// whenever it starts or finds the daemon unreachable.
//
// This never checks whether a tray is already running: the tray holds a
// single-instance lock and a duplicate exits immediately, so launching is
// always safe. The throttle only avoids spawning a process on every retry.

const TRAY_LAUNCH_THROTTLE_MS = 15_000;
const MAC_TRAY_LABEL = "com.checkpointvcs.tray";

let lastLaunchAt = 0;

// electron-builder ships the tray as extraResources/tray, next to the app's
// other resources. Unpackaged dev builds have no tray to launch.
function trayExecutablePath(): string | null {
  if (!app.isPackaged) return null;
  const name =
    process.platform === "win32" ? "checkpoint-tray.exe" : "checkpoint-tray";
  const candidate = path.join(process.resourcesPath, "tray", name);
  return existsSync(candidate) ? candidate : null;
}

function spawnDetached(trayPath: string): void {
  try {
    const child = spawn(trayPath, [], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (error) => {
      console.error("Failed to launch the Checkpoint tray:", error);
    });
    // Let the tray outlive this app.
    child.unref();
  } catch (error) {
    console.error("Failed to launch the Checkpoint tray:", error);
  }
}

/**
 * Makes sure the Checkpoint tray is running, launching it if needed.
 * Returns without waiting for the tray (or, on Windows, the daemon it starts)
 * to come up; callers keep polling the daemon as before.
 */
export function ensureTrayRunning(): void {
  const now = Date.now();
  if (now - lastLaunchAt < TRAY_LAUNCH_THROTTLE_MS) return;
  lastLaunchAt = now;

  const trayPath = trayExecutablePath();
  if (!trayPath) return;

  if (process.platform === "darwin" && typeof process.getuid === "function") {
    // Prefer launchd's own job so there is only ever the one tray it manages
    // (and restarts on a crash). kickstart is a no-op when it's already
    // running; it fails when the agent isn't loaded, so fall back to a plain
    // launch then.
    execFile(
      "launchctl",
      ["kickstart", `gui/${process.getuid()}/${MAC_TRAY_LABEL}`],
      (error) => {
        if (error) spawnDetached(trayPath);
      },
    );
    return;
  }

  spawnDetached(trayPath);
}
