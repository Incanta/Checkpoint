import { clipboard, dialog, shell, type IpcMain } from "electron";
import {
  CreateDaemonClient,
  FileStatus,
  FileType,
} from "@checkpointvcs/daemon";
import { MockedData } from "../common/mock-data";
import { User, usersAtom, currentUserAtom } from "../common/state/auth";
import { store } from "../common/state/store";
import { Channels, ipcOn, ipcSend, ipcHandle } from "./channels";
import {
  currentWorkspaceAtom,
  fileHistoryAtom,
  changelistChangesAtom,
  workspaceDiffAtom,
  workspaceDirectoriesAtom,
  workspaceHistoryAtom,
  workspaceLabelsAtom,
  workspacePendingChangesAtom,
  workspacesAtom,
  workspaceSyncStatusAtom,
  workspaceSyncPreviewAtom,
  workspaceConflictsAtom,
  resolveConfirmSuppressedAtom,
  workspaceBranchesAtom,
} from "../common/state/workspace";
import { promises as fs, existsSync } from "fs";
import path from "path";
import {
  dashboardNewWorkspaceFolderAtom,
  dashboardNewWorkspaceProgressAtom,
  dashboardOrgsAtom,
  dashboardReposAtom,
} from "../common/state/dashboard";
import type { File, Workspace } from "@checkpointvcs/daemon";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

/**
 * Reads diffContent from the fileHistoryDiff response, which now returns
 * cache file paths instead of raw content.
 */
async function readDiffFromPaths(result: {
  left: { cachePath: string; isBinary: boolean } | null;
  right: { cachePath: string; isBinary: boolean } | null;
}): Promise<{ left: string; right: string }> {
  let left = "";
  let right = "";

  if (result.left) {
    if (result.left.isBinary) {
      left = "[Binary file]";
    } else {
      left = await fs.readFile(result.left.cachePath, "utf-8");
    }
  }

  if (result.right) {
    if (result.right.isBinary) {
      right = "[Binary file]";
    } else {
      right = await fs.readFile(result.right.cachePath, "utf-8");
    }
  }

  return { left, right };
}

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

    ipcOn(this.ipcMain, "workspace:history", async (event, data) => {
      this.workspaceHistory();
    });

    ipcOn(
      this.ipcMain,
      "workspace:history:view-changes",
      async (event, data) => {
        this.workspaceHistoryViewChanges(data);
      },
    );

    ipcOn(
      this.ipcMain,
      "workspace:history:select-file",
      async (event, data) => {
        this.workspaceHistorySelectFile(data);
      },
    );

    ipcOn(this.ipcMain, "workspace:history:close", async (event, data) => {
      store.set(changelistChangesAtom, null);
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

    ipcOn(this.ipcMain, "workspace:create-label", async (event, data) => {
      this.workspaceCreateLabel(data);
    });

    ipcOn(this.ipcMain, "workspace:labels", async (event, data) => {
      this.workspaceGetLabels();
    });

    ipcOn(this.ipcMain, "workspace:delete-label", async (event, data) => {
      this.workspaceDeleteLabel(data);
    });

    ipcOn(this.ipcMain, "workspace:rename-label", async (event, data) => {
      this.workspaceRenameLabel(data);
    });

    ipcOn(
      this.ipcMain,
      "workspace:change-label-changelist",
      async (event, data) => {
        this.workspaceChangeLabelChangelist(data);
      },
    );

    // Branch handlers
    ipcOn(this.ipcMain, "workspace:branches", async (event, data) => {
      this.workspaceGetBranches();
    });

    ipcOn(this.ipcMain, "workspace:create-branch", async (event, data) => {
      this.workspaceCreateBranch(data);
    });

    ipcOn(this.ipcMain, "workspace:select-branch", async (event, data) => {
      this.workspaceSwitchBranch(data);
    });

    ipcOn(this.ipcMain, "workspace:archive-branch", async (event, data) => {
      this.workspaceArchiveBranch(data);
    });

    ipcOn(this.ipcMain, "workspace:unarchive-branch", async (event, data) => {
      this.workspaceUnarchiveBranch(data);
    });

    ipcOn(this.ipcMain, "workspace:delete-branch", async (event, data) => {
      this.workspaceDeleteBranch(data);
    });

    ipcOn(this.ipcMain, "workspace:merge-branch", async (event, data) => {
      this.workspaceMergeBranch(data);
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

    // Sync status & preview handlers
    ipcOn(this.ipcMain, "workspace:sync-status", async (event, data) => {
      this.workspaceSyncStatus(false);
    });

    ipcOn(
      this.ipcMain,
      "workspace:sync-status:refresh",
      async (event, data) => {
        this.workspaceSyncStatus(true);
      },
    );

    ipcOn(this.ipcMain, "workspace:sync-preview", async (event, data) => {
      this.workspaceSyncPreview();
    });

    ipcOn(
      this.ipcMain,
      "workspace:sync-preview:select-file",
      async (event, data) => {
        this.workspaceSyncPreviewSelectFile(data);
      },
    );

    ipcOn(this.ipcMain, "workspace:sync-preview:close", async (event, data) => {
      store.set(workspaceSyncPreviewAtom, null);
    });

    ipcOn(this.ipcMain, "workspace:check-conflicts", async (event, data) => {
      this.workspaceCheckConflicts();
    });

    ipcOn(this.ipcMain, "file:resolve-conflict", async (event, data) => {
      this.resolveConflicts(data);
    });

    ipcOn(
      this.ipcMain,
      "workspace:resolve-confirm-suppressed",
      async (event, data) => {
        this.getResolveConfirmSuppressed();
      },
    );

    ipcOn(
      this.ipcMain,
      "workspace:set-resolve-confirm-suppressed",
      async (event, data) => {
        this.setResolveConfirmSuppressed(data);
      },
    );

    // File context menu handlers
    this.initFileContextMenuHandlers();
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

      const workspacesResponse = await client.workspaces.ops.list.local.query({
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

      const workspaceResponse = await client.workspaces.ops.create.mutate({
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

    // Clear previous sync state
    store.set(workspaceSyncStatusAtom, null);
    store.set(workspaceSyncPreviewAtom, null);
    store.set(workspaceConflictsAtom, null);
    store.set(resolveConfirmSuppressedAtom, null);

    this.workspaceRefresh();

    // Fetch sync status and resolve confirm suppression in background
    this.workspaceSyncStatus(true);
    this.getResolveConfirmSuppressed();

    if (this.webContents) {
      ipcSend(this.webContents, "set-renderer-url", {
        url: "/workspace",
      });
    }
  }

  private async workspaceHistory(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);

    if (!currentWorkspace) {
      return;
    }

    const client = await CreateDaemonClient();

    const changelists = await client.workspaces.history.get.query({
      daemonId: currentWorkspace.daemonId,
      workspaceId: currentWorkspace.id,
    });

    store.set(workspaceHistoryAtom, changelists);
  }

  private async workspaceHistoryViewChanges(
    data: Channels["workspace:history:view-changes"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    if (this.isMocked) {
      store.set(changelistChangesAtom, {
        changelistNumber: data.changelistNumber,
        message: "Mock changelist",
        user: "mock@user.com",
        date: new Date(),
        files: [],
        selectedFilePath: null,
        diffContent: null,
      });
      return;
    }

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();

      const files = await client.workspaces.history.changelistFiles.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        changelistNumber: data.changelistNumber,
      });

      // Find the changelist metadata from history
      const history = store.get(workspaceHistoryAtom);
      const changelist = history?.find(
        (cl) => cl.number === data.changelistNumber,
      );

      store.set(changelistChangesAtom, {
        changelistNumber: data.changelistNumber,
        message: changelist?.message || "",
        user: changelist?.user?.email || "Unknown",
        date: changelist ? new Date(changelist.createdAt) : new Date(),
        files,
        selectedFilePath: null,
        diffContent: null,
      });
    } catch (error) {
      console.error("Failed to fetch changelist files:", error);
      store.set(changelistChangesAtom, {
        changelistNumber: data.changelistNumber,
        message: "",
        user: "Unknown",
        date: new Date(),
        files: [],
        selectedFilePath: null,
        diffContent: null,
      });
    }
  }

  private async workspaceHistorySelectFile(
    data: Channels["workspace:history:select-file"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    const currentChanges = store.get(changelistChangesAtom);
    if (!currentWorkspace || !currentChanges || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();

      // Find the parent changelist number from history
      const history = store.get(workspaceHistoryAtom);
      const changelist = history?.find(
        (cl) => cl.number === currentChanges.changelistNumber,
      );
      const previousChangelistNumber = changelist?.parentNumber ?? null;

      const rawResult = await client.workspaces.history.fileDiff.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        filePath: data.filePath,
        changelistNumber: currentChanges.changelistNumber,
        previousChangelistNumber,
      });

      const diffContent = await readDiffFromPaths(rawResult);

      store.set(changelistChangesAtom, {
        ...currentChanges,
        selectedFilePath: data.filePath,
        diffContent,
      });
    } catch (error) {
      console.error("Failed to get file diff:", error);
    }
  }

  private async fileHistory(data: Channels["file:history"]): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);

    if (!currentWorkspace) {
      return;
    }

    if (this.isMocked) {
      // Mock data for testing
      store.set(fileHistoryAtom, {
        filePath: data.path,
        entries: [],
        selectedChangelistNumber: null,
        diffContent: null,
      });
      return;
    }

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      return;
    }

    try {
      const client = await CreateDaemonClient();

      const fileHistoryEntries = await client.workspaces.history.file.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        filePath: data.path,
        count: 50,
      });

      store.set(fileHistoryAtom, {
        filePath: data.path,
        entries: fileHistoryEntries.map((entry) => ({
          ...entry,
          changelist: {
            ...entry.changelist,
            createdAt: new Date(entry.changelist.createdAt),
            updatedAt: new Date(entry.changelist.updatedAt),
          },
        })),
        selectedChangelistNumber: null,
        diffContent: null,
      });
    } catch (error) {
      console.error("Failed to fetch file history:", error);
      store.set(fileHistoryAtom, {
        filePath: data.path,
        entries: [],
        selectedChangelistNumber: null,
        diffContent: null,
      });
    }
  }

  private async workspaceRefresh(): Promise<void> {
    console.log(
      "workspaceRefresh called, pendingChanges: ",
      store.get(workspacePendingChangesAtom),
    );

    const currentWorkspace = store.get(currentWorkspaceAtom);

    if (!currentWorkspace) {
      console.log("No current workspace, skipping refresh");
      return;
    }

    const client = await CreateDaemonClient();
    const pendingChanges = await client.workspaces.pending.refresh.query({
      daemonId: currentWorkspace.daemonId,
      workspaceId: currentWorkspace.id,
    });

    console.log("Fetched pending changes: ", pendingChanges);

    store.set(workspacePendingChangesAtom, pendingChanges || null);

    // Reset workspaceDirectoriesAtom to trigger tree re-initialization
    store.set(workspaceDirectoriesAtom, {
      [currentWorkspace.localPath]: {
        children: [],
        containsChanges: false,
      },
    });
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

    try {
      const client = await CreateDaemonClient();
      const mergeResult = await client.workspaces.sync.pull.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        ...data,
      });

      // Refresh sync status after successful pull
      this.workspaceSyncStatus(true);

      // Notify renderer of merge results (clean + conflict merges)
      if (
        this.webContents &&
        mergeResult &&
        (mergeResult.cleanMerges.length > 0 ||
          mergeResult.conflictMerges.length > 0)
      ) {
        ipcSend(this.webContents, "workspace:pull:merge-result", {
          cleanMerges: mergeResult.cleanMerges,
          conflictMerges: mergeResult.conflictMerges,
        });
      }
    } catch (error: any) {
      const message = error?.message || "An unknown error occurred during pull";
      if (message.includes("conflicting file")) {
        // Extract conflict paths from error message
        const pathsMatch = message.match(/: ([^]+)$/);
        const conflictPaths = pathsMatch
          ? pathsMatch[1].split(", ").map((p: string) => p.trim())
          : [];
        if (this.webContents) {
          ipcSend(this.webContents, "workspace:pull:conflict-error", {
            message,
            conflictPaths,
          });
        }
      }
      throw error;
    }
  }

  private async workspaceSubmit(
    data: Channels["workspace:submit"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) {
      return;
    }

    if (this.isMocked) {
      // Simulate success for mock mode
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:submit:success", null);
      }
      return;
    }

    const currentUser = store.get(currentUserAtom);

    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:submit:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.pending.submit.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        ...data,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:submit:success", null);
      }
    } catch (error: any) {
      const message =
        error?.message || "An unknown error occurred during submit";
      if (this.webContents) {
        if (message.includes("conflicting file")) {
          const pathsMatch = message.match(/: ([^]+)$/);
          const conflictPaths = pathsMatch
            ? pathsMatch[1].split(", ").map((p: string) => p.trim())
            : [];
          ipcSend(this.webContents, "workspace:submit:conflict-error", {
            message,
            conflictPaths,
          });
        }
        ipcSend(this.webContents, "workspace:submit:error", {
          message,
        });
      }
    }
  }

  private async workspaceCreateLabel(
    data: Channels["workspace:create-label"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-label:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.labels.create.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        name: data.name,
        changelistNumber: data.changelistNumber,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-label:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-label:error", {
          message:
            error?.message || "An unknown error occurred creating the label",
        });
      }
    }
  }

  private async workspaceGetLabels(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:labels:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      const labels = await client.workspaces.labels.list.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
      });

      store.set(workspaceLabelsAtom, labels as any);

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:labels:data", {
          labels: labels as any,
        });
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:labels:error", {
          message:
            error?.message || "An unknown error occurred fetching labels",
        });
      }
    }
  }

  private async workspaceDeleteLabel(
    data: Channels["workspace:delete-label"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-label:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.labels.delete.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        labelId: data.labelId,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-label:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-label:error", {
          message:
            error?.message || "An unknown error occurred deleting the label",
        });
      }
    }
  }

  private async workspaceRenameLabel(
    data: Channels["workspace:rename-label"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:rename-label:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.labels.rename.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        labelId: data.labelId,
        name: data.newName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:rename-label:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:rename-label:error", {
          message:
            error?.message || "An unknown error occurred renaming the label",
        });
      }
    }
  }

  private async workspaceChangeLabelChangelist(
    data: Channels["workspace:change-label-changelist"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:change-label-changelist:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.labels.changeChangelist.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        labelId: data.labelId,
        number: data.newNumber,
      });

      if (this.webContents) {
        ipcSend(
          this.webContents,
          "workspace:change-label-changelist:success",
          null,
        );
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:change-label-changelist:error", {
          message:
            error?.message ||
            "An unknown error occurred changing the label changelist",
        });
      }
    }
  }

  // ─── Branch Handlers ──────────────────────────────────────────

  private async workspaceGetBranches(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.branches.list.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        includeArchived: true,
      });

      store.set(workspaceBranchesAtom, result as any);

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:branches:data", null);
      }
    } catch (error: any) {
      console.error("Failed to get branches:", error);
    }
  }

  private async workspaceCreateBranch(
    data: Channels["workspace:create-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-branch:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.branches.create.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        name: data.name,
        headNumber: data.headNumber,
        type: data.type,
        parentBranchName: data.parentBranchName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-branch:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:create-branch:error", {
          message:
            error?.message || "An unknown error occurred creating the branch",
        });
      }
    }
  }

  private async workspaceSwitchBranch(
    data: Channels["workspace:select-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:select-branch:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.branches.switch.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        branchName: data.name,
      });

      // Update the current workspace's branch name in the store
      const updatedWorkspace = {
        ...currentWorkspace,
        branchName: result.branchName,
      };
      store.set(currentWorkspaceAtom, updatedWorkspace);

      // Also update in the workspaces list
      const workspaces = store.get(workspacesAtom);
      if (workspaces) {
        store.set(
          workspacesAtom,
          workspaces.map((w) =>
            w.id === currentWorkspace.id ? updatedWorkspace : w,
          ),
        );
      }

      // Clear stale state for the new branch
      store.set(workspaceHistoryAtom, null);
      store.set(workspaceSyncStatusAtom, null);
      store.set(workspaceSyncPreviewAtom, null);

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:select-branch:success", {
          branchName: result.branchName,
        });
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:select-branch:error", {
          message:
            error?.message || "An unknown error occurred switching branches",
        });
      }
    }
  }

  private async workspaceArchiveBranch(
    data: Channels["workspace:archive-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.branches.archive.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        branchName: data.branchName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:archive-branch:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:archive-branch:error", {
          message:
            error?.message || "An unknown error occurred archiving the branch",
        });
      }
    }
  }

  private async workspaceUnarchiveBranch(
    data: Channels["workspace:unarchive-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.branches.unarchive.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        branchName: data.branchName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:unarchive-branch:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:unarchive-branch:error", {
          message:
            error?.message ||
            "An unknown error occurred unarchiving the branch",
        });
      }
    }
  }

  private async workspaceDeleteBranch(
    data: Channels["workspace:delete-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-branch:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.branches.delete.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        branchName: data.branchName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-branch:success", null);
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:delete-branch:error", {
          message:
            error?.message || "An unknown error occurred deleting the branch",
        });
      }
    }
  }

  private async workspaceMergeBranch(
    data: Channels["workspace:merge-branch"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:merge-branch:error", {
          message:
            "Could not find local user account; please try restarting the app",
        });
      }
      return;
    }

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.branches.merge.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        incomingBranchName: data.incomingBranchName,
      });

      if (this.webContents) {
        ipcSend(this.webContents, "workspace:merge-branch:success", {
          message: `Merged ${data.incomingBranchName} into ${currentWorkspace.branchName} (CL #${result.mergeChangelist.number})`,
        });
      }
    } catch (error: any) {
      if (this.webContents) {
        ipcSend(this.webContents, "workspace:merge-branch:error", {
          message:
            error?.message || "An unknown error occurred merging the branch",
        });
      }
    }
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
            checkouts: [],
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
      const directoryResponse =
        await client.workspaces.pending.getDirectory.query({
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

      const diffResponse = await client.workspaces.pending.diffFile.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        path: data.path,
      });

      store.set(workspaceDiffAtom, diffResponse);
    }
  }

  // ─── Sync Status & Preview ───────────────────────────────────────

  private async workspaceSyncStatus(forceRefresh: boolean): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const syncStatus = await client.workspaces.sync.getSyncStatus.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        forceRefresh,
      });

      store.set(workspaceSyncStatusAtom, {
        ...syncStatus,
        checkedAt: new Date(syncStatus.checkedAt),
      });
    } catch (error) {
      console.error("Failed to fetch sync status:", error);
    }
  }

  private async workspaceSyncPreview(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const preview = await client.workspaces.sync.getSyncPreview.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
      });

      store.set(workspaceSyncPreviewAtom, {
        syncStatus: {
          ...preview.syncStatus,
          checkedAt: new Date(preview.syncStatus.checkedAt),
        },
        changelists: preview.allFileChanges,
        allFileChanges: preview.allFileChanges,
        selectedFilePath: null,
        diffContent: null,
      });

      // Also update the sync status atom
      store.set(workspaceSyncStatusAtom, {
        ...preview.syncStatus,
        checkedAt: new Date(preview.syncStatus.checkedAt),
      });
    } catch (error) {
      console.error("Failed to fetch sync preview:", error);
    }
  }

  private async workspaceSyncPreviewSelectFile(
    data: Channels["workspace:sync-preview:select-file"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    const currentPreview = store.get(workspaceSyncPreviewAtom);
    if (!currentWorkspace || !currentPreview || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();

      // Find the latest changelist that modified this file
      let latestCl: number | null = null;
      let previousCl: number | null = null;

      for (const cl of currentPreview.allFileChanges) {
        const fileChange = cl.files.find((f) => f.path === data.filePath);
        if (fileChange) {
          if (latestCl === null || cl.changelistNumber > latestCl) {
            previousCl = latestCl;
            latestCl = cl.changelistNumber;
          }
        }
      }

      // If we didn't find a previous CL from the incoming changes,
      // use the local workspace's CL for this file
      if (previousCl === null && latestCl !== null) {
        const syncStatus = currentPreview.syncStatus;
        previousCl =
          syncStatus.localChangelistNumber > 0
            ? syncStatus.localChangelistNumber
            : null;

        // Check if the file has a specific local CL from outdated files
        const outdated = syncStatus.outdatedFiles?.find(
          (f) => f.path === data.filePath,
        );
        if (outdated) {
          previousCl = outdated.localChangelist;
        }
      }

      if (latestCl === null) {
        return;
      }

      const rawResult = await client.workspaces.history.fileDiff.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        filePath: data.filePath,
        changelistNumber: latestCl,
        previousChangelistNumber: previousCl,
      });

      const diffContent = await readDiffFromPaths(rawResult);

      store.set(workspaceSyncPreviewAtom, {
        ...currentPreview,
        selectedFilePath: data.filePath,
        diffContent,
      });
    } catch (error) {
      console.error("Failed to get sync preview file diff:", error);
    }
  }

  private async workspaceCheckConflicts(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const conflicts = await client.workspaces.conflicts.check.query({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
      });

      store.set(workspaceConflictsAtom, conflicts);
    } catch (error) {
      console.error("Failed to check conflicts:", error);
    }
  }

  private async resolveConflicts(
    data: Channels["file:resolve-conflict"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const result = await client.workspaces.conflicts.resolve.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        filePaths: data.paths,
      });

      // Notify renderer of success
      if (this.webContents) {
        ipcSend(this.webContents, "file:resolve-conflict:success", {
          resolvedPaths: result.resolvedPaths,
        });
      }

      // Refresh sync status and conflicts
      this.workspaceSyncStatus(true);
      this.workspaceCheckConflicts();

      // Refresh pending changes since file statuses may have changed
      this.workspaceRefresh();
    } catch (error: any) {
      console.error("Failed to resolve conflicts:", error);
      if (this.webContents) {
        ipcSend(this.webContents, "file:resolve-conflict:error", {
          message: error?.message || "Failed to resolve conflicts",
        });
      }
    }
  }

  private async getResolveConfirmSuppressed(): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      const result =
        await client.workspaces.conflicts.getResolveConfirmSuppressed.query({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
        });

      store.set(resolveConfirmSuppressedAtom, result);
    } catch (error) {
      console.error("Failed to get resolve confirm suppressed:", error);
    }
  }

  private async setResolveConfirmSuppressed(
    data: Channels["workspace:set-resolve-confirm-suppressed"],
  ): Promise<void> {
    const currentWorkspace = store.get(currentWorkspaceAtom);
    if (!currentWorkspace || this.isMocked) return;

    const currentUser = store.get(currentUserAtom);
    if (!currentUser) return;

    try {
      const client = await CreateDaemonClient();
      await client.workspaces.conflicts.setResolveConfirmSuppressed.mutate({
        daemonId: currentUser.daemonId,
        workspaceId: currentWorkspace.id,
        duration: data.duration,
      });

      // Refresh the suppressed state
      store.set(resolveConfirmSuppressedAtom, { suppressed: true });
    } catch (error) {
      console.error("Failed to set resolve confirm suppressed:", error);
    }
  }

  private initFileContextMenuHandlers(): void {
    // Open file with default application
    ipcOn(this.ipcMain, "file:open", async (_event, data) => {
      try {
        await shell.openPath(data.path);
      } catch (error) {
        console.error("Failed to open file:", error);
      }
    });

    // Open with... (shows system open with dialog)
    ipcOn(this.ipcMain, "file:open-with", async (_event, data) => {
      try {
        if (process.platform === "win32") {
          // On Windows, use OpenAs_RunDLL to show "Open with" dialog
          await execAsync(
            `rundll32.exe shell32.dll,OpenAs_RunDLL "${data.path}"`,
          );
        } else if (process.platform === "darwin") {
          // On macOS, use open -a to show application chooser
          await execAsync(`open -a "Choose Application" "${data.path}"`);
        } else {
          // On Linux, try xdg-open or show in file manager
          await shell.openPath(data.path);
        }
      } catch (error) {
        console.error("Failed to open with:", error);
      }
    });

    // Open in explorer/finder
    ipcOn(this.ipcMain, "file:open-in-explorer", async (_event, data) => {
      try {
        shell.showItemInFolder(data.path);
      } catch (error) {
        console.error("Failed to open in explorer:", error);
      }
    });

    // View file history
    ipcOn(this.ipcMain, "file:history", async (_event, data) => {
      this.fileHistory(data);
    });

    // Select a changelist in file history to view the diff
    ipcOn(
      this.ipcMain,
      "file:history:select-changelist",
      async (_event, data) => {
        const currentWorkspace = store.get(currentWorkspaceAtom);
        const currentFileHistory = store.get(fileHistoryAtom);

        if (!currentWorkspace || !currentFileHistory || this.isMocked) {
          return;
        }

        const currentUser = store.get(currentUserAtom);
        if (!currentUser) {
          return;
        }

        try {
          const client = await CreateDaemonClient();

          // Find the selected entry and the previous one
          const entries = currentFileHistory.entries;
          const selectedIndex = entries.findIndex(
            (e) => e.changelistNumber === data.changelistNumber,
          );

          if (selectedIndex === -1) {
            return;
          }

          const previousEntry =
            selectedIndex < entries.length - 1
              ? entries[selectedIndex + 1]
              : null;

          const rawResult = await client.workspaces.history.fileDiff.query({
            daemonId: currentUser.daemonId,
            workspaceId: currentWorkspace.id,
            filePath: currentFileHistory.filePath,
            changelistNumber: data.changelistNumber,
            previousChangelistNumber: previousEntry?.changelistNumber ?? null,
          });

          const diffContent = await readDiffFromPaths(rawResult);

          store.set(fileHistoryAtom, {
            ...currentFileHistory,
            selectedChangelistNumber: data.changelistNumber,
            diffContent,
          });
        } catch (error) {
          console.error("Failed to get file history diff:", error);
        }
      },
    );

    // Close file history view
    ipcOn(this.ipcMain, "file:history:close", async () => {
      store.set(fileHistoryAtom, null);
    });

    // Popout: get diff (used by popout windows with independent state)
    ipcHandle(this.ipcMain, "popout:get-diff", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace || this.isMocked) {
        return null;
      }

      const currentUser = store.get(currentUserAtom);
      if (!currentUser) {
        return null;
      }

      try {
        const client = await CreateDaemonClient();

        const rawResult = await client.workspaces.history.fileDiff.query({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
          filePath: data.filePath,
          changelistNumber: data.changelistNumber,
          previousChangelistNumber: data.previousChangelistNumber,
        });

        return await readDiffFromPaths(rawResult);
      } catch (error) {
        console.error("Failed to get popout diff:", error);
        return null;
      }
    });

    // Mark file as added
    ipcOn(this.ipcMain, "file:mark-as-added", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace || this.isMocked) return;

      const currentUser = store.get(currentUserAtom);
      if (!currentUser) return;

      try {
        const client = await CreateDaemonClient();
        await client.workspaces.pending.markForAdd.mutate({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
          paths: [data.path],
        });
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to mark as added:", error);
      }
    });

    // Mark directory contents as added
    ipcOn(
      this.ipcMain,
      "file:mark-directory-as-added",
      async (_event, data) => {
        const currentWorkspace = store.get(currentWorkspaceAtom);
        if (!currentWorkspace || this.isMocked) return;

        const currentUser = store.get(currentUserAtom);
        if (!currentUser) return;

        try {
          // Gather all file paths in the pending changes that start with the directory path
          const pendingChanges = store.get(workspacePendingChangesAtom);
          const dirPrefix = data.path.endsWith("/")
            ? data.path
            : data.path + "/";
          const filePaths: string[] = [];

          if (pendingChanges?.files) {
            for (const [filePath, file] of Object.entries(
              pendingChanges.files,
            )) {
              if (
                filePath.startsWith(dirPrefix) &&
                file.status === FileStatus.Local
              ) {
                filePaths.push(filePath);
              }
            }
          }

          if (filePaths.length > 0) {
            const client = await CreateDaemonClient();
            await client.workspaces.pending.markForAdd.mutate({
              daemonId: currentUser.daemonId,
              workspaceId: currentWorkspace.id,
              paths: filePaths,
            });
          }

          this.workspaceRefresh();
        } catch (error) {
          console.error("Failed to mark directory as added:", error);
        }
      },
    );

    // Checkout file
    ipcOn(this.ipcMain, "file:checkout", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace || this.isMocked) return;

      const currentUser = store.get(currentUserAtom);
      if (!currentUser) return;

      try {
        const client = await CreateDaemonClient();

        // Check if the file is locked by another user
        if (data.checkForLock) {
          const checkouts =
            await client.workspaces.pending.getActiveCheckoutsForFiles.query({
              daemonId: currentUser.daemonId,
              workspaceId: currentWorkspace.id,
              filePaths: [data.path],
            });

          const lockedByOther = checkouts.find(
            (c) => c.locked && c.userId !== currentUser.details?.id,
          );

          if (lockedByOther) {
            const displayName =
              lockedByOther.user.name ||
              lockedByOther.user.username ||
              lockedByOther.user.email;
            if (this.webContents) {
              ipcSend(this.webContents, "file:checkout:locked-warning", {
                path: data.path,
                lockedBy: displayName,
              });
            }
            return;
          }
        }

        await client.workspaces.pending.checkout.mutate({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
          path: data.path,
          locked: data.locked ?? false,
        });
        this.workspaceRefresh();
      } catch (error: any) {
        console.error("Failed to checkout:", error);
        if (this.webContents) {
          ipcSend(this.webContents, "file:checkout:error", {
            message: error?.message || "Failed to checkout file",
          });
        }
      }
    });

    // Undo checkout
    ipcOn(this.ipcMain, "file:undo-checkout", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace || this.isMocked) return;

      const currentUser = store.get(currentUserAtom);
      if (!currentUser) return;

      try {
        const client = await CreateDaemonClient();
        await client.workspaces.pending.undoCheckout.mutate({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
          path: data.path,
        });
        this.workspaceRefresh();
      } catch (error: any) {
        console.error("Failed to undo checkout:", error);
        if (this.webContents) {
          ipcSend(this.webContents, "file:checkout:error", {
            message: error?.message || "Failed to undo checkout",
          });
        }
      }
    });

    // Revert files (restore head content + undo checkout)
    ipcOn(this.ipcMain, "workspace:revert", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace || this.isMocked) return;

      const currentUser = store.get(currentUserAtom);
      if (!currentUser) return;

      try {
        const client = await CreateDaemonClient();
        await client.workspaces.pending.revertFiles.mutate({
          daemonId: currentUser.daemonId,
          workspaceId: currentWorkspace.id,
          filePaths: data.filePaths,
        });
        this.workspaceRefresh();
      } catch (error: any) {
        console.error("Failed to revert files:", error);
      }
    });

    // Add to ignored list
    ipcOn(this.ipcMain, "file:add-to-ignored", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      try {
        const ignoreFilePath = path.join(
          currentWorkspace.localPath,
          ".chkignore",
        );
        let content = "";
        if (existsSync(ignoreFilePath)) {
          content = await fs.readFile(ignoreFilePath, "utf-8");
        }
        const newContent = content.trim() + "\n" + data.pattern + "\n";
        await fs.writeFile(ignoreFilePath, newContent, "utf-8");

        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to add to ignored list:", error);
      }
    });

    // Remove from ignored list
    ipcOn(this.ipcMain, "file:remove-from-ignored", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      try {
        const ignoreFilePath = path.join(
          currentWorkspace.localPath,
          ".chkignore",
        );
        if (!existsSync(ignoreFilePath)) return;

        const content = await fs.readFile(ignoreFilePath, "utf-8");
        const lines = content
          .split("\n")
          .filter((line) => line.trim() !== data.pattern);
        await fs.writeFile(ignoreFilePath, lines.join("\n"), "utf-8");
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to remove from ignored list:", error);
      }
    });

    // Add to hidden changes list
    ipcOn(this.ipcMain, "file:add-to-hidden", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      try {
        const hiddenFilePath = path.join(
          currentWorkspace.localPath,
          ".chkhidden",
        );
        let content = "";
        if (existsSync(hiddenFilePath)) {
          content = await fs.readFile(hiddenFilePath, "utf-8");
        }
        const newContent = content.trim() + "\n" + data.pattern + "\n";
        await fs.writeFile(hiddenFilePath, newContent, "utf-8");
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to add to hidden list:", error);
      }
    });

    // Remove from hidden changes list
    ipcOn(this.ipcMain, "file:remove-from-hidden", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      try {
        const hiddenFilePath = path.join(
          currentWorkspace.localPath,
          ".chkhidden",
        );
        if (!existsSync(hiddenFilePath)) return;

        const content = await fs.readFile(hiddenFilePath, "utf-8");
        const lines = content
          .split("\n")
          .filter((line) => line.trim() !== data.pattern);
        await fs.writeFile(hiddenFilePath, lines.join("\n"), "utf-8");
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to remove from hidden list:", error);
      }
    });

    // Copy full path
    ipcOn(this.ipcMain, "file:copy-full-path", async (_event, data) => {
      let pathToCopy = data.path;
      if (data.useBackslashes && process.platform === "win32") {
        pathToCopy = pathToCopy.replace(/\//g, "\\");
      } else if (!data.useBackslashes) {
        pathToCopy = pathToCopy.replace(/\\/g, "/");
      }
      clipboard.writeText(pathToCopy);
    });

    // Copy relative path
    ipcOn(this.ipcMain, "file:copy-relative-path", async (_event, data) => {
      const currentWorkspace = store.get(currentWorkspaceAtom);
      if (!currentWorkspace) return;

      let relativePath = path.relative(currentWorkspace.localPath, data.path);
      if (data.useBackslashes && process.platform === "win32") {
        relativePath = relativePath.replace(/\//g, "\\");
      } else if (!data.useBackslashes) {
        relativePath = relativePath.replace(/\\/g, "/");
      }
      clipboard.writeText(relativePath);
    });

    // Rename file (prompt for new name)
    ipcOn(this.ipcMain, "file:rename:prompt", async (event, data) => {
      // The rename dialog will be handled in the renderer
      // This is just for future reference if we need native dialogs
    });

    // Rename file (execute rename)
    ipcOn(this.ipcMain, "file:rename", async (event, data) => {
      try {
        const dir = path.dirname(data.path);
        const newPath = path.join(dir, data.newName);
        await fs.rename(data.path, newPath);
        if (this.webContents) {
          ipcSend(this.webContents, "file:rename:result", {
            success: true,
            newPath,
          });
        }
        this.workspaceRefresh();
      } catch (error: any) {
        if (this.webContents) {
          ipcSend(this.webContents, "file:rename:result", {
            success: false,
            error: error?.message || "Failed to rename file",
          });
        }
      }
    });

    // Delete to trash
    ipcOn(this.ipcMain, "file:delete-to-trash", async (_event, data) => {
      try {
        await shell.trashItem(data.path);
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to move to trash:", error);
      }
    });

    // Force delete
    ipcOn(this.ipcMain, "file:force-delete", async (_event, data) => {
      try {
        const stat = await fs.stat(data.path);
        if (stat.isDirectory()) {
          await fs.rm(data.path, { recursive: true, force: true });
        } else {
          await fs.unlink(data.path);
        }
        this.workspaceRefresh();
      } catch (error) {
        console.error("Failed to delete:", error);
      }
    });
  }
}
