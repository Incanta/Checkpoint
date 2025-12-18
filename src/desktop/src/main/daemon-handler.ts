import { dialog, type IpcMain } from "electron";
import {
  CreateDaemonClient,
  FileStatus,
  FileType,
} from "@checkpointvcs/daemon";
import { MockedData } from "../common/mock-data";
import { User, usersAtom, currentUserAtom } from "../common/state/auth";
import { store } from "../common/state/store";
import { Channels, ipcOn, ipcSend } from "./channels";
import {
  currentWorkspaceAtom,
  workspaceDiffAtom,
  workspaceDirectoriesAtom,
  workspacePendingChangesAtom,
  workspacesAtom,
} from "../common/state/workspace";
import { promises as fs } from "fs";
import path from "path";
import {
  dashboardNewWorkspaceFolderAtom,
  dashboardNewWorkspaceProgressAtom,
  dashboardOrgsAtom,
  dashboardReposAtom,
} from "../common/state/dashboard";
import type { File, Workspace } from "@checkpointvcs/daemon";

export default class DaemonHandler {
  private isMocked: boolean;
  private ipcMain: IpcMain;
  private webContents: Electron.WebContents | null = null;

  constructor(ipcMain: IpcMain) {
    this.isMocked = process.env.USE_MOCK_DATA === "true";
    this.ipcMain = ipcMain;
  }

  public async init(webContents: Electron.WebContents): Promise<void> {
    this.webContents = webContents;

    if (this.isMocked) {
      store.set(usersAtom, []);
    } else {
      const client = await CreateDaemonClient();

      const users = await client.auth.getUsers.query();
      const usersValue = users.users.map((user) => ({
        daemonId: user.daemonId,
        endpoint: user.endpoint,
        details: {
          id: user.id,
          email: user.email,
          name: user.name,
          username: user.username,
        },
        auth: undefined,
      }));

      store.set(usersAtom, usersValue);

      // TODO remember the last active user
      if (usersValue.length > 0) {
        store.set(currentUserAtom, usersValue[0]);
      }
    }

    ipcOn(this.ipcMain, "auth:login", async (_event, data) => {
      this.handleLogin(data);
    });

    ipcOn(this.ipcMain, "workspace:create", async (event, data) => {
      this.workspaceCreate(data);
    });

    ipcOn(this.ipcMain, "workspace:select", async (_event, data) => {
      const workspaces = store.get(workspacesAtom) || [];
      const workspace = workspaces.find((ws) => ws.id === data.id);
      if (workspace) {
        this.selectWorkspace(workspace);
      }
    });

    ipcOn(this.ipcMain, "workspace:refresh", async (event, data) => {
      this.workspaceRefresh();
    });

    ipcOn(this.ipcMain, "workspace:get-directory", async (event, data) => {
      this.workspaceGetDirectory(data);
    });

    ipcOn(this.ipcMain, "workspace:diff:file", async (event, data) => {
      this.workspaceDiffFile(data);
    });

    ipcOn(this.ipcMain, "workspace:pull", async (event, data) => {
      this.workspacePull(data);
    });

    ipcOn(this.ipcMain, "workspace:submit", async (event, data) => {
      this.workspaceSubmit(data);
    });

    ipcOn(this.ipcMain, "dashboard:refresh", async (event, data) => {
      this.refreshDashboard(data);
    });

    ipcOn(
      this.ipcMain,
      "dashboard:select-workspace-folder",
      async (event, data) => {
        if (!this.isMocked) {
          const results = await dialog.showOpenDialog({
            properties: ["openDirectory"],
          });

          if (!results.canceled && results.filePaths.length > 0) {
            store.set(dashboardNewWorkspaceFolderAtom, results.filePaths[0]);
          }
        }
      },
    );
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
            auth: {
              code: "1234",
              url: "http://checkpoint.localhost:3000/devices/1234",
            },
          };

          store.set(currentUserAtom, nextAuthUser);

          setTimeout(() => {
            const currentAuthUser = store.get(currentUserAtom);

            if (!currentAuthUser) return;

            const nextUser: User = {
              ...currentAuthUser,
              details: user.details,
              auth: undefined,
            };

            store.set(currentUserAtom, nextUser);

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
        auth: { code: loginResponse.code, url: loginResponse.url },
      };

      store.set(currentUserAtom, nextAuthUser);

      // wait for daemon to give us the user details
      for (let i = 0; i < 5 * 60; i++) {
        try {
          const { user } = await client.auth.getUser.query({
            daemonId: data.daemonId,
          });

          const currentAuthUser = store.get(currentUserAtom);

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

          store.set(currentUserAtom, nextUser);

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

  private async refreshDashboard(
    data: Channels["dashboard:refresh"],
  ): Promise<void> {
    if (!this.isMocked) {
      if (!data.daemonId) {
        store.set(dashboardOrgsAtom, []);
        store.set(dashboardReposAtom, []);
        return;
      }

      const client = await CreateDaemonClient();

      const orgs = await client.orgs.list.query({ daemonId: data.daemonId });
      store.set(dashboardOrgsAtom, orgs.orgs);

      if (!data.orgId) {
        store.set(dashboardReposAtom, []);
        return;
      }

      const reposResponse = await client.repos.list.query({
        daemonId: data.daemonId,
        orgId: data.orgId,
      });
      store.set(dashboardReposAtom, reposResponse.repos);

      const workspacesResponse = await client.workspaces.list.local.query({
        daemonId: data.daemonId,
      });

      store.set(workspacesAtom, workspacesResponse.workspaces);
    }
  }

  private async workspaceCreate(
    data: Channels["workspace:create"],
  ): Promise<void> {
    if (!this.isMocked) {
      const currentUser = store.get(currentUserAtom);

      if (!currentUser) {
        store.set(dashboardNewWorkspaceProgressAtom, {
          complete: true,
          error: "User not selected",
        });

        return;
      }

      store.set(dashboardNewWorkspaceProgressAtom, {
        complete: false,
        error: "",
      });

      const client = await CreateDaemonClient();

      const workspaceResponse = await client.workspaces.create.mutate({
        daemonId: currentUser.daemonId,
        ...data,
      });

      await this.refreshDashboard({
        daemonId: currentUser.daemonId,
        orgId: workspaceResponse.workspace.orgId,
      });

      store.set(dashboardNewWorkspaceProgressAtom, {
        complete: true,
        error: "",
      });
    }
  }

  private async selectWorkspace(workspace: Workspace): Promise<void> {
    store.set(currentWorkspaceAtom, workspace);
    store.set(workspaceDirectoriesAtom, {
      [workspace.localPath]: {
        children: [],
        containsChanges: false,
      },
    });

    this.workspaceRefresh();

    if (this.webContents) {
      ipcSend(this.webContents, "set-renderer-url", {
        url: "/workspace",
      });
    }
  }

  private async workspaceRefresh(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);

    if (!currentWorkspace) {
      return;
    }

    const client = await CreateDaemonClient();
    const pendingChanges = await client.workspaces.refresh.query({
      daemonId: currentWorkspace.daemonId,
      workspaceId: currentWorkspace.id,
    });

    store.set(workspacePendingChangesAtom, pendingChanges || null);
  }

  private async workspacePull(data: Channels["workspace:pull"]): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) {
      return;
    }

    if (this.isMocked) {
      return;
    }

    const currentUser = store.get(currentUserAtom);

    if (!currentUser) {
      throw new Error(
        "Could not find local user account; please try restarting the app",
      );
    }

    const client = await CreateDaemonClient();
    const pullResponse = await client.workspaces.pull.query({
      daemonId: currentUser.daemonId,
      workspaceId: currentWorkspace.id,
      ...data,
    });
  }

  private async workspaceSubmit(
    data: Channels["workspace:submit"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) {
      return;
    }

    if (this.isMocked) {
      return;
    }

    const currentUser = store.get(currentUserAtom);

    if (!currentUser) {
      throw new Error(
        "Could not find local user account; please try restarting the app",
      );
    }

    const client = await CreateDaemonClient();
    await client.workspaces.submit.query({
      daemonId: currentUser.daemonId,
      workspaceId: currentWorkspace.id,
      ...data,
    });
  }

  private async workspaceGetDirectory(
    data: Channels["workspace:get-directory"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || !this.webContents) return;

    const dirPath = data.path;

    if (this.isMocked) {
      const dirEntries = await fs.readdir(
        path.join(currentWorkspace.localPath, dirPath),
        { withFileTypes: true },
      );
      const children = await Promise.all(
        dirEntries.map(async (entry) => {
          const entryPath = path.join(
            currentWorkspace.localPath,
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
      ipcSend(this.webContents, "workspace:directory-contents", {
        path: dirPath,
        directory: {
          children,
          containsChanges: false,
        },
      });
    } else {
      const currentUser = store.get(currentUserAtom);

      if (!currentUser) {
        throw new Error(
          "Could not find local user account; please try restarting the app",
        );
      }

      const client = await CreateDaemonClient();
      const directoryResponse = await client.workspaces.getDirectory.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        path: data.path,
      });

      // Send the directory contents back to the renderer process
      ipcSend(this.webContents, "workspace:directory-contents", {
        path: dirPath,
        directory: directoryResponse,
      });
    }
  }

  private async workspaceDiffFile(
    data: Channels["workspace:diff:file"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    if (this.isMocked) {
      store.set(workspaceDiffAtom, {
        left: `hello world`,
        right: `hello checkpoint`,
      });
    } else {
      const currentUser = store.get(currentUserAtom);

      if (!currentUser) {
        throw new Error(
          "Could not find local user account; please try restarting the app",
        );
      }

      const client = await CreateDaemonClient();

      const diffResponse = await client.workspaces.diffFile.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        path: data.path,
      });

      store.set(workspaceDiffAtom, diffResponse);
    }
  }
}
