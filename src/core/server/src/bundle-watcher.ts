import { existsSync, promises as fs } from "fs";
import path from "path";
import { Logger } from "./logging.js";

/**
 * Restarts this process when an admin activates a different deployment bundle.
 *
 * The app writes the desired version to the shared state volume and exits; the
 * core server has no idea that happened, so it watches the same file. Exiting
 * cleanly is the restart: the runtime container's restart policy brings it back
 * and docker/runtime/bootstrap.js boots whatever is now desired.
 *
 * Only meaningful under the runtime image. A dev run, or a pinned/air-gapped
 * deployment, has no desired version to follow and this stays dormant.
 */

const POLL_INTERVAL_MS = 10_000;

// The app runs the database migrations on its way back up. Lagging behind it
// means the server usually rejoins against an already-migrated schema. It is
// only a courtesy: the SERVER_API / MIN_SERVER_API handshake is what actually
// makes the skew window safe.
const RESTART_DELAY_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;

function desiredPath(): string | null {
  const stateDir = process.env["CHECKPOINT_STATE_DIR"];
  if (!stateDir) return null;
  return path.join(stateDir, "state", "desired.json");
}

async function readDesiredVersion(file: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      version?: string;
    };
    return parsed.version ?? null;
  } catch {
    // Absent or mid-write. bootstrap.js writes it via rename, so a partial read
    // should not happen, but treating any unreadable state as "no change" keeps
    // a corrupt file from restart-looping the server.
    return null;
  }
}

export function startBundleWatcher(): void {
  if (timer) return;

  const active = process.env["CHECKPOINT_BUNDLE_VERSION_ACTIVE"];
  const mode = process.env["CHECKPOINT_BUNDLE_MODE"];
  const file = desiredPath();

  if (!active || !file) {
    Logger.debug?.("[Bundle] Not a bundle deployment; update watcher disabled");
    return;
  }

  if (mode !== "channel") {
    Logger.log(
      `[Bundle] Deployment is ${mode}; version is fixed, update watcher disabled`,
    );
    return;
  }

  Logger.log(`[Bundle] Watching for activated updates (running ${active})`);

  let restarting = false;

  timer = setInterval(() => {
    void (async () => {
      if (restarting || !existsSync(file)) return;

      const desired = await readDesiredVersion(file);
      if (!desired || desired === active) return;

      restarting = true;
      Logger.log(
        `[Bundle] ${desired} activated (running ${active}); restarting in ${
          RESTART_DELAY_MS / 1000
        }s`,
      );

      setTimeout(() => {
        Logger.log("[Bundle] Exiting to restart onto the new bundle");
        process.exit(0);
      }, RESTART_DELAY_MS);
    })();
  }, POLL_INTERVAL_MS);

  timer.unref?.();
}

export function stopBundleWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
