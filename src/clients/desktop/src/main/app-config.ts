import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = "app-config.json";

/**
 * Identifies the workspace the user last had open, so the next launch can
 * reopen straight to it. We persist only the identifying keys (not the full
 * workspace blob) and re-resolve the live workspace from the daemon's local
 * list at launch, which keeps stale data from leaking in.
 */
export interface LastOpenedWorkspace {
  daemonId: string;
  workspaceId: string;
}

interface AppConfig {
  lastOpenedWorkspace?: LastOpenedWorkspace | null;
}

function configFilePath(): string {
  return path.join(app.getPath("userData"), CONFIG_FILE);
}

function readAppConfig(): AppConfig {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(configFilePath(), "utf8"),
    ) as AppConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // No file yet, or it's unreadable/corrupt; callers fall back to defaults.
    return {};
  }
}

function writeAppConfig(config: AppConfig): void {
  try {
    fs.writeFileSync(configFilePath(), JSON.stringify(config, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to persist app config:", error);
  }
}

/**
 * Returns the last opened workspace's identifying keys, or null if none is
 * persisted or the stored value is malformed.
 */
export function getLastOpenedWorkspace(): LastOpenedWorkspace | null {
  const last = readAppConfig().lastOpenedWorkspace;
  if (
    !last ||
    typeof last.daemonId !== "string" ||
    typeof last.workspaceId !== "string"
  ) {
    return null;
  }
  return last;
}

/**
 * Persists (or clears, when passed null) the last opened workspace.
 */
export function setLastOpenedWorkspace(
  workspace: LastOpenedWorkspace | null,
): void {
  const config = readAppConfig();
  config.lastOpenedWorkspace = workspace;
  writeAppConfig(config);
}
