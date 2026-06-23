import {
  app,
  dialog,
  shell,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";

const isMac = process.platform === "darwin";

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
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
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
 * Builds and installs the application menu. Call once after the app is ready
 * and before the renderer loads so the titlebar can fetch it.
 */
export function setupApplicationMenu(): void {
  const menu = Menu.buildFromTemplate(buildTemplate());
  Menu.setApplicationMenu(menu);
}
