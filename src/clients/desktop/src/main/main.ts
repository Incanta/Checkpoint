import { app, BrowserWindow, ipcMain } from "electron";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  setupTitlebar,
  attachTitlebarToWindow,
} from "@incanta/custom-electron-titlebar/main";
import DaemonHandler from "./daemon-handler";
import { setupApplicationMenu } from "./menu";
import { ipcOn } from "./channels";
import {
  MIN_WIDTH,
  MIN_HEIGHT,
  restoreWindowState,
  trackWindowState,
} from "./window-state";

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

setupTitlebar();

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, "public")
  : RENDERER_DIST;

let win: BrowserWindow | null;

const daemonHandler = new DaemonHandler(ipcMain);

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
    titleBarStyle: "hidden",
    titleBarOverlay: true,
  });

  if (isMaximized) {
    win.maximize();
  }

  // Persist size/position/maximized state as the user changes it.
  trackWindowState(win);

  attachTitlebarToWindow(win);

  // Install the menu the titlebar renders, before the renderer loads and
  // requests it over IPC.
  setupApplicationMenu();

  // Test active push message to Renderer-process.
  win.webContents.on("did-finish-load", () => {
    win?.webContents.send("main-process-message", new Date().toLocaleString());
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, "index.html"));
  }

  daemonHandler.init(win.webContents);
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
    titleBarStyle: "hidden",
    titleBarOverlay: true,
    title,
  });

  attachTitlebarToWindow(popout);

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

app.whenReady().then(createWindow);
