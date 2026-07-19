import { app, type BrowserWindow, type IpcMain } from "electron";
import { CreateDaemonClient } from "@checkpointvcs/daemon";
import { ipcHandle, ipcOn } from "./channels";
import { getZoomFactor, setZoomFactor } from "./app-config";

/**
 * Registers IPC handlers backing the Settings dialog: the daemon's MCP server
 * toggle, app/runtime versions, the renderer zoom level, and live updates to
 * the native window-controls overlay colors when the theme changes.
 *
 * These used to live in the application menu; the menu bar has been removed in
 * favor of the in-app Settings dialog.
 */
export function registerSettingsHandlers(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
): void {
  ipcHandle(ipcMain, "settings:mcp:get-status", async () => {
    try {
      const client = await CreateDaemonClient();
      const status = await client.mcp.getStatus.query();
      return { enabled: status.enabled, available: true };
    } catch {
      // Daemon unreachable or too old to expose MCP controls.
      return { enabled: false, available: false };
    }
  });

  ipcHandle(ipcMain, "settings:mcp:set-enabled", async (_event, data) => {
    try {
      const client = await CreateDaemonClient();
      const next = await client.mcp.setEnabled.mutate({
        enabled: data.enabled,
      });
      return { enabled: next.enabled, available: true };
    } catch (error) {
      console.error("Failed to set the MCP server state:", error);
      return { enabled: false, available: false };
    }
  });

  ipcHandle(ipcMain, "settings:get-app-info", async () => {
    return {
      appVersion: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
    };
  });

  ipcHandle(ipcMain, "settings:zoom:get", async () => {
    return { factor: getZoomFactor() };
  });

  ipcHandle(ipcMain, "settings:zoom:set", async (_event, data) => {
    const factor = setZoomFactor(data.factor);
    getWindow()?.webContents.setZoomFactor(factor);
    return { factor };
  });

  ipcOn(ipcMain, "window:set-titlebar-overlay", (_event, data) => {
    const win = getWindow();
    if (!win) return;
    // Only Windows/Linux expose a settable overlay; macOS has no overlay and
    // throws, so guard it.
    try {
      win.setTitleBarOverlay?.({
        color: data.color,
        symbolColor: data.symbolColor,
      });
    } catch {
      // No window-controls overlay on this platform; ignore.
    }
  });
}
