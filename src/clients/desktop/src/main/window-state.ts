import {
  app,
  screen,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Rectangle,
} from "electron";
import fs from "node:fs";
import path from "node:path";

// Single source of truth for the window's minimum dimensions. The default
// window size (used when there's no persisted state) falls back to these
// exact values, so the initial size and the minimum size can never diverge.
export const MIN_WIDTH = 940;
export const MIN_HEIGHT = 530;

const STATE_FILE = "window-state.json";

interface WindowState {
  // Bounds to restore to when the window is not maximized.
  bounds: Rectangle;
  isMaximized: boolean;
}

function stateFilePath(): string {
  return path.join(app.getPath("userData"), STATE_FILE);
}

function readState(): WindowState | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(stateFilePath(), "utf8"),
    ) as Partial<WindowState>;
    const bounds = parsed.bounds;
    if (
      !bounds ||
      typeof bounds.x !== "number" ||
      typeof bounds.y !== "number" ||
      typeof bounds.width !== "number" ||
      typeof bounds.height !== "number"
    ) {
      return null;
    }
    return { bounds, isMaximized: Boolean(parsed.isMaximized) };
  } catch {
    // No file yet, or it's unreadable/corrupt; caller falls back to defaults.
    return null;
  }
}

function writeState(state: WindowState): void {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to persist window state:", error);
  }
}

// A saved position is only usable if it still overlaps a connected display;
// otherwise a window restored onto a now-disconnected monitor would open
// off-screen and appear lost.
function isVisibleOnSomeDisplay(bounds: Rectangle): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapX =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x);
    const overlapY =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y);
    return overlapX > 0 && overlapY > 0;
  });
}

/**
 * Builds the constructor options for the main window, restoring the last
 * saved monitor/size/position when available. Falls back to the minimum size
 * (centered by the OS) when there's no usable persisted state.
 */
export function restoreWindowState(): {
  options: BrowserWindowConstructorOptions;
  isMaximized: boolean;
} {
  const state = readState();

  if (state && isVisibleOnSomeDisplay(state.bounds)) {
    return {
      options: {
        x: state.bounds.x,
        y: state.bounds.y,
        width: Math.max(state.bounds.width, MIN_WIDTH),
        height: Math.max(state.bounds.height, MIN_HEIGHT),
      },
      isMaximized: state.isMaximized,
    };
  }

  return {
    options: { width: MIN_WIDTH, height: MIN_HEIGHT },
    isMaximized: false,
  };
}

/**
 * Persists the window's size, position, and maximized state as the user
 * changes them, so the next launch reopens in the same place. Writes are
 * debounced to avoid thrashing the disk during a drag or resize.
 */
export function trackWindowState(win: BrowserWindow): void {
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const persist = (): void => {
    if (win.isDestroyed()) {
      return;
    }
    // getNormalBounds() reports the un-maximized size even while maximized,
    // which is what we want to restore to when the user un-maximizes later.
    writeState({
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
    });
  };

  const schedulePersist = (): void => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(persist, 300);
  };

  win.on("resize", schedulePersist);
  win.on("move", schedulePersist);
  win.on("maximize", schedulePersist);
  win.on("unmaximize", schedulePersist);
  win.on("close", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    persist();
  });
}
