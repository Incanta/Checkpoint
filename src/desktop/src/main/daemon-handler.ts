import type { IpcMain } from "electron";
import { CreateDaemonClient } from "@checkpointvcs/daemon";
import { MockedData } from "../common/mock-data";
import { User, usersAtom, currentUser } from "../common/state/auth";
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
      store.set(usersAtom, []);
    }

    ipcOn(this.ipcMain, "auth:login", async (_event, data) => {
      this.handleLogin(data);
    });

    ipcOn(this.ipcMain, "workspace:get-directory", async (event, data) => {
      this.workspaceGetDirectory(data, event.sender);
    });

    ipcOn(this.ipcMain, "workspace:diff:file", async (event, data) => {
      this.workspaceDiffFile(data);
    });
  }

  private async handleLogin(data: Channels["auth:login"]): Promise<void> {
    if (this.isMocked) {
      for (const availableUser of MockedData.availableUsers) {
        if (MockedData.users[availableUser].endpoint === data.endpoint) {
          const user = MockedData.users[availableUser];
          MockedData.availableUsers.splice(
            MockedData.availableUsers.indexOf(availableUser),
            1,
          );

          const nextAuthUser: User = {
            ...user,
            daemonId: data.daemonId,
            details: null,
            auth: { code: "1234" },
          };

          store.set(currentUser, nextAuthUser);

          setTimeout(() => {
            const currentAuthUser = store.get(currentUser);

            if (!currentAuthUser) return;

            const nextUser: User = {
              ...currentAuthUser,
              details: user.details,
              auth: undefined,
            };

            store.set(currentUser, nextUser);

            const currentUsers = store.get(usersAtom) || [];
            const nextUsers = currentUsers
              .filter((a) => a.daemonId !== data.daemonId)
              .concat(nextUser);

            store.set(usersAtom, nextUsers);

            store.set(workspacesAtom, MockedData.workspaces);
            this.selectWorkspace(MockedData.workspaces[0]);
          }, 2000);

          break;
        }
      }
    } else {
      const client = await CreateDaemonClient();
      const loginResponse = await client.auth.login.query({
        endpoint: data.endpoint,
        daemonId: data.daemonId,
      });

      const nextAuthUser: User = {
        daemonId: data.daemonId,
        endpoint: data.endpoint,
        details: null,
        auth: { code: loginResponse.code },
      };

      store.set(currentUser, nextAuthUser);

      // wait for daemon to give us the user details
      for (let i = 0; i < 5 * 60; i++) {
        try {
          const { user } = await client.auth.getUser.query({
            daemonId: data.daemonId,
          });

          const currentAuthUser = store.get(currentUser);

          if (!currentAuthUser) return;

          const nextUser: User = {
            ...currentAuthUser,
            details: {
              id: user.id,
              email: user.email,
              name: user.name,
              username: user.username,
            },
            auth: undefined,
          };

          store.set(currentUser, nextUser);

          const currentUsers = store.get(usersAtom) || [];
          const nextUsers = currentUsers
            .filter((a) => a.daemonId !== data.daemonId)
            .concat(nextUser);

          store.set(usersAtom, nextUsers);
        } catch (e) {
          //
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }

      throw new Error("Timed out waiting for device authorization");
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

  private async workspaceGetDirectory(
    data: Channels["workspace:get-directory"],
    sender: Electron.WebContents,
  ): Promise<void> {
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
      ipcSend(sender, "workspace:directory-contents", {
        path: dirPath,
        directory: {
          children,
          containsChanges: false,
        },
      });
    } else {
      // TODO retrieve from daemon
    }
  }

  private async workspaceDiffFile(
    data: Channels["workspace:diff:file"],
  ): Promise<void> {
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
  }
}
