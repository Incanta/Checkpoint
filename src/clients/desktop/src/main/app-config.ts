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
  /** Renderer zoom factor (1 = 100%). */
  zoomFactor?: number;
}

// Clamp zoom to a sane range so a bad persisted value can't render the UI
// unusable.
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const DEFAULT_ZOOM = 1;

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

/** Returns the persisted zoom factor (clamped), defaulting to 100%. */
export function getZoomFactor(): number {
  const value = readAppConfig().zoomFactor;
  if (typeof value !== "number" || Number.isNaN(value)) {
    return DEFAULT_ZOOM;
  }
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
}

/** Persists the zoom factor (clamped) and returns the value stored. */
export function setZoomFactor(factor: number): number {
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, factor));
  const config = readAppConfig();
  config.zoomFactor = clamped;
  writeAppConfig(config);
  return clamped;
}
