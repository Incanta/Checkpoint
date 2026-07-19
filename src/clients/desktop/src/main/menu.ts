import { shell, Menu, type MenuItemConstructorOptions } from "electron";

const isMac = process.platform === "darwin";

const DOCS_URL = "https://checkpointvcs.com/docs";
const ISSUES_URL = "https://github.com/Incanta/Checkpoint/issues";

/**
 * The app no longer has a menu bar on Windows/Linux: window controls live in
 * the native titlebar overlay and everything the menu used to offer (MCP
 * toggle, zoom, version) now lives in the in-app Settings dialog. macOS still
 * shows a native menu by convention, so we install a minimal one there for the
 * standard roles and keyboard shortcuts.
 */
function buildMacTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
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
    { role: "windowMenu" },
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
      ],
    },
  ];
}

/**
 * Installs the application menu. macOS gets a minimal native menu; Windows and
 * Linux get no menu bar at all.
 */
export function setupApplicationMenu(): void {
  if (isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMacTemplate()));
  } else {
    Menu.setApplicationMenu(null);
  }
}
