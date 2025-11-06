import type { IpcMain } from "electron";
import { MockedData } from "../common/mock-data";
import { Account, accountsAtom, currentAccount } from "../common/state/auth";
import { store } from "../common/state/store";
import { Channels, ipcOn, ipcSend } from "./channels";
import {
  currentWorkspaceAtom,
  File,
  FileStatus,
  FileType,
  Workspace,
  workspaceDiffAtom,
  workspaceDirectoriesAtom,
  workspacesAtom,
} from "../common/state/workspace";
import { promises as fs } from "fs";
import path from "path";

export default class DaemonHandler {
  // Your implementation here
  private isMocked: boolean;
  private ipcMain: IpcMain;

  constructor(ipcMain: IpcMain) {
    this.isMocked = process.env.USE_MOCK_DATA === "true";
    this.ipcMain = ipcMain;
  }

  public async init(): Promise<void> {
    if (this.isMocked) {
      store.set(accountsAtom, []);
    }

    ipcOn(this.ipcMain, "auth:login", async (_event, data) => {
      this.handleLogin(data);
    });

    ipcOn(this.ipcMain, "workspace:get-directory", async (event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      const dirPath = data.path;

      if (this.isMocked) {
        const dirEntries = await fs.readdir(
          path.join(currentWorkspace.rootPath, dirPath),
          { withFileTypes: true },
        );
        const children = await Promise.all(
          dirEntries.map(async (entry) => {
            const entryPath = path.join(
              currentWorkspace.rootPath,
              dirPath,
              entry.name,
            );
            const stats = await fs.stat(entryPath);

            const f: File = {
              path: entry.name,
              type: entry.isDirectory() ? FileType.Directory : FileType.Text, // Simplified for this example
              size: stats.size,
              modifiedAt: stats.mtimeMs,
              status: FileStatus.Unknown,
              id: null,
              changelist: null,
            };

            return f;
          }),
        );

        // Send the directory contents back to the renderer process
        ipcSend(event.sender, "workspace:directory-contents", {
          path: dirPath,
          directory: {
            children,
            containsChanges: false,
          },
        });
      } else {
        // TODO retrieve from daemon
      }
    });

    ipcOn(this.ipcMain, "workspace:diff:file", async (event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      if (this.isMocked) {
        const filePath = path.join(currentWorkspace.rootPath, data.path);
        // const fileContent = await fs.readFile(filePath, "utf-8");

        store.set(workspaceDiffAtom, {
          left: `hello world`,
          right: `hello checkpoint`,
        });
      }
    });
  }

  private async handleLogin(data: Channels["auth:login"]): Promise<void> {
    if (this.isMocked) {
      for (const availableAccount of MockedData.availableAccounts) {
        if (MockedData.accounts[availableAccount].endpoint === data.endpoint) {
          const account = MockedData.accounts[availableAccount];
          MockedData.availableAccounts.splice(
            MockedData.availableAccounts.indexOf(availableAccount),
            1,
          );

          const nextAuthAccount: Account = {
            ...account,
            daemonId: data.daemonId,
            details: null,
            auth: { code: "1234" },
          };

          store.set(currentAccount, nextAuthAccount);

          setTimeout(() => {
            const currentAuthAccount = store.get(currentAccount);

            if (!currentAuthAccount) return;

            const nextAccount: Account = {
              ...currentAuthAccount,
              details: account.details,
              auth: undefined,
            };

            store.set(currentAccount, nextAccount);

            const currentAccounts = store.get(accountsAtom) || [];
            const nextAccounts = currentAccounts
              .filter((a) => a.daemonId !== data.daemonId)
              .concat(nextAccount);

            store.set(accountsAtom, nextAccounts);

            store.set(workspacesAtom, MockedData.workspaces);
            this.selectWorkspace(MockedData.workspaces[0]);
          }, 2000);

          break;
        }
      }
    } else {
      // TODO: real implementation to interact with the daemon
    }
  }

  private async selectWorkspace(workspace: Workspace): Promise<void> {
    store.set(workspacesAtom, MockedData.workspaces);
    store.set(currentWorkspaceAtom, workspace);
    store.set(workspaceDirectoriesAtom, {
      [workspace.rootPath]: {
        children: [],
        containsChanges: false,
      },
    });
  }
}
