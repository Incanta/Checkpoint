import { app, BrowserWindow, ipcMain } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import DaemonHandler from "./daemon-handler";
import TeamSyncHandler from "./team-sync-handler";
import { setupApplicationMenu } from "./menu";
import { ipcOn } from "./channels";
import { registerSettingsHandlers } from "./settings-handler";
import { getZoomFactor } from "./app-config";
import {
  MIN_WIDTH,
  MIN_HEIGHT,
  restoreWindowState,
  trackWindowState,
} from "./window-state";

// Height of our custom titlebar strip (the draggable top bar the renderer
// draws). The native window-controls overlay is sized to match so the OS
// min/max/close buttons line up with our bar.
export const TITLEBAR_HEIGHT = 40;

const isMac = process.platform === "darwin";

// Per-platform window-chrome options. On Windows/Linux we use the native
// Window Controls Overlay (min/max/close painted top-right over our bar);
// colors are refreshed from the renderer on theme change, so these are just
// dark-theme defaults. On macOS we keep the hidden titlebar and nudge the
// traffic lights to vertically center them in our bar.
function windowChromeOptions(): Electron.BrowserWindowConstructorOptions {
  if (isMac) {
    return {
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 12, y: (TITLEBAR_HEIGHT - 16) / 2 },
    };
  }
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#161b22",
      symbolColor: "#e6edf3",
      height: TITLEBAR_HEIGHT,
    },
  };
}

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The built directory structure
//
// ├─┬─┬ renderer
// │ │ └── index.html
// │ │
// │ ├─┬ main
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, "..", "..");

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
export const MAIN_DIST = path.join(process.env.APP_ROOT, "dist/main");
export const RENDERER_DIST = path.join(process.env.APP_ROOT, "dist/renderer");

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;

const daemonHandler = new DaemonHandler(ipcMain);
const teamSyncHandler = new TeamSyncHandler(ipcMain);

// The app deliberately has no tray icon of its own. Checkpoint's tray presence
// is the standalone Go tray (src/clients/tray), which outlives this app and
// already owns the daemon lifecycle, updates, and the Team Sync status/"Sync
// Latest" actions. A second Electron tray would just duplicate it.

// Single-instance: focus the existing window instead of launching a second
// copy (which would fight over the daemon).
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

// Settings dialog IPC (MCP toggle, versions, zoom, titlebar overlay colors).
registerSettingsHandlers(ipcMain, () => win);

function createWindow() {
  // Reopen on the same monitor/size/position as last time, defaulting to the
  // minimum size when there's no saved state yet.
  const { options, isMaximized } = restoreWindowState();

  win = new BrowserWindow({
    ...options,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    icon: path.join(process.env.VITE_PUBLIC, "icon.svg"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
    ...windowChromeOptions(),
  });

  if (isMaximized) {
    win.maximize();
  }

  // Persist size/position/maximized state as the user changes it.
  trackWindowState(win);

  // Install the application menu (a minimal native menu on macOS; removed
  // entirely on Windows/Linux, where the app has no menu bar).
  setupApplicationMenu();

  // Test active push message to Renderer-process.
  win.webContents.on("did-finish-load", () => {
    // Restore the persisted zoom level once the page is loaded.
    win?.webContents.setZoomFactor(getZoomFactor());
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  daemonHandler.init(win.webContents);
  teamSyncHandler.init(win.webContents);
  teamSyncHandler.setWindow(win);
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
    win = null;
  }
});

app.on("activate", () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function createPopoutWindow(popoutType: string, title: string) {
  const popout = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(process.env.VITE_PUBLIC!, "icon.svg"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
    ...windowChromeOptions(),
    title,
  });

  if (VITE_DEV_SERVER_URL) {
    popout.loadURL(`${VITE_DEV_SERVER_URL}?popout=${popoutType}`);
  } else {
    popout.loadFile(path.join(RENDERER_DIST, "index.html"), {
      query: { popout: popoutType },
    });
  }
}

ipcOn(ipcMain, "file:history:open-window", () => {
  createPopoutWindow("file-history", "File History");
});

ipcOn(ipcMain, "workspace:history:open-window", () => {
  createPopoutWindow("changelist-changes", "Changelist Changes");
});

app.whenReady().then(() => {
  createWindow();
});
