import {
  app,
  dialog,
  shell,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { CreateDaemonClient } from "@checkpointvcs/daemon";

const isMac = process.platform === "darwin";

// Last known state of the daemon's MCP server, mirrored into the checkbox
// menu item. Refreshed at startup and after every toggle.
let mcpEnabled = false;

const DOCS_URL = "https://checkpointvcs.com/docs";
const ISSUES_URL = "https://github.com/Incanta/Checkpoint/issues";

/**
 * Builds the application menu template. The custom titlebar (see
 * `preload.ts`) renders this menu by fetching `Menu.getApplicationMenu()`
 * over IPC and dispatches clicks back here, so the menu is defined in the
 * main process even though it appears in the titlebar.
 *
 * To add an app-specific item that drives the UI, give it a `click` handler
 * and forward to the focused window's renderer, e.g.:
 *
 *   click: (_item, win) => win?.webContents.send("menu:my-action")
 *
 * then listen for that channel in the renderer.
 */
function buildTemplate(): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    // macOS shows the standard app menu natively; the titlebar menu is
    // only used on Windows/Linux.
    ...(isMac
      ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "MCP Server",
          type: "checkbox",
          checked: mcpEnabled,
          click: (): void => {
            void toggleMcpServer();
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Documentation",
          click: (): void => {
            void shell.openExternal(DOCS_URL);
          },
        },
        {
          label: "Report an Issue",
          click: (): void => {
            void shell.openExternal(ISSUES_URL);
          },
        },
        ...(isMac
          ? ([] satisfies MenuItemConstructorOptions[])
          : ([
              { type: "separator" },
              {
                label: `About ${app.name}`,
                click: (): void => {
                  void dialog.showMessageBox({
                    type: "info",
                    title: `About ${app.name}`,
                    message: app.name,
                    detail: `Version ${app.getVersion()}`,
                  });
                },
              },
            ] satisfies MenuItemConstructorOptions[])),
      ],
    },
  ];

  return template;
}

/**
 * Toggles the daemon's MCP server. The daemon starts/stops it immediately and
 * persists the choice to daemon.json, so no daemon restart is needed.
 */
async function toggleMcpServer(): Promise<void> {
  try {
    const client = await CreateDaemonClient();
    const status = await client.mcp.getStatus.query();
    const next = await client.mcp.setEnabled.mutate({
      enabled: !status.enabled,
    });
    mcpEnabled = next.enabled;
  } catch (error) {
    console.error("Failed to toggle the MCP server:", error);
  }
  installMenu();
}

/**
 * Fetches the MCP server state from the daemon so the checkbox reflects
 * reality on startup. Silent on error (e.g. the daemon isn't up yet).
 */
async function refreshMcpState(): Promise<void> {
  try {
    const client = await CreateDaemonClient();
    const status = await client.mcp.getStatus.query();
    if (status.enabled !== mcpEnabled) {
      mcpEnabled = status.enabled;
      installMenu();
    }
  } catch {
    // Daemon unreachable or too old; leave the default unchecked state.
  }
}

function installMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate());
  Menu.setApplicationMenu(menu);
}

/**
 * Builds and installs the application menu. Call once after the app is ready
 * and before the renderer loads so the titlebar can fetch it.
 */
export function setupApplicationMenu(): void {
  installMenu();
  void refreshMcpState();
}
