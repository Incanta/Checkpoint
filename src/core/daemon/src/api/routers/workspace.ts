import { publicProcedure, router } from "../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { DaemonManager } from "../../daemon-manager.js";
import { File, FileStatus, FileType, Workspace } from "../../types/index.js";
import { DaemonConfig } from "../../daemon-config.js";
import { getFileStatuses } from "../../file-status.js";
import {
  isBinaryFile,
  pull,
  readFileFromChangelist,
  submit,
  checkConflicts,
  getWorkspaceState,
  saveWorkspaceState,
  getWorkspaceConfig,
  saveWorkspaceConfig,
  type Workspace as UtilWorkspace,
} from "../../util/index.js";
import { TRPCError } from "@trpc/server";

export const workspaceRouter = router({
  list: {
    local: publicProcedure
      .input(
        z.object({
          daemonId: z.string(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const manager = DaemonManager.Get();

        return { workspaces: manager.workspaces.get(input.daemonId) || [] };
      }),

    all: publicProcedure
      .input(
        z.object({
          daemonId: z.string(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const client = await CreateApiClientAuth(input.daemonId);

        const workspaces = await client.workspace.list.query();
        return { workspaces };
      }),
  },

  refresh: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspaces = DaemonManager.Get().workspaces.get(input.daemonId);
      if (workspaces) {
        const workspace = workspaces.find((w) => w.id === input.workspaceId);
        if (workspace) {
          return await DaemonManager.Get().refreshWorkspaceContents(workspace);
        }

        return null;
      }
    }),

  create: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        name: z.string().min(1).max(100),
        repoId: z.string(),
        path: z.string(),
        defaultBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const client = await CreateApiClientAuth(input.daemonId);

      const newWorkspaceApi = await client.workspace.create.mutate({
        name: input.name,
        repoId: input.repoId,
        defaultBranchName: input.defaultBranchName,
      });

      const newWorkspace: Workspace = {
        ...newWorkspaceApi,
        localPath: input.path.replace(/\\/g, "/"),
        daemonId: input.daemonId,
        branchName: input.defaultBranchName,
      };

      DaemonConfig.Ensure().vars.workspaces.push(newWorkspace);
      await DaemonConfig.Save();

      const manager = DaemonManager.Get();
      const existingWorkspaces = manager.workspaces.get(input.daemonId) || [];
      existingWorkspaces.push(newWorkspace);
      manager.workspaces.set(input.daemonId, existingWorkspaces);
      manager.watchWorkspace(newWorkspace);

      return { workspace: newWorkspace };
    }),

  getDirectory: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      const workspaceState = manager.getWorkspaceState(workspace.id);

      const dirEntries = await fs.readdir(
        path.join(workspace.localPath, input.path),
        { withFileTypes: true },
      );

      // Build file info for batch status lookup
      const fileInfos = dirEntries.map((entry) => {
        const relativePath = path
          .join(input.path, entry.name)
          .replace(/\\/g, "/")
          .replace(/^\//, "");

        return {
          relativePath,
          existsOnDisk: true,
          isDirectory: entry.isDirectory(),
          entry,
        };
      });

      // Convert pending changes to the format expected by getFileStatuses
      const pendingChangesMap = pendingChanges
        ? Object.fromEntries(
            Object.entries(pendingChanges.files).map(([key, file]) => [
              key,
              { status: file.status, id: file.id, changelist: file.changelist },
            ]),
          )
        : undefined;

      // Get statuses for all files in batch
      const statuses = await getFileStatuses(
        workspace.localPath,
        fileInfos,
        workspaceState,
        pendingChangesMap,
      );

      // Fetch active checkouts for files in this directory
      const client = await CreateApiClientAuth(input.daemonId);
      const filePaths = fileInfos
        .filter((fi) => !fi.isDirectory)
        .map((fi) => fi.relativePath);

      const checkoutsMap: Record<
        string,
        Array<{
          id: string;
          locked: boolean;
          workspaceId: string;
          userId: string;
          user: {
            id: string;
            email: string;
            name: string | null;
            username: string | null;
          };
        }>
      > = {};

      if (filePaths.length > 0) {
        const checkouts = await client.file.getActiveCheckoutsForFiles.query({
          repoId: workspace.repoId,
          filePaths,
        });

        for (const checkout of checkouts) {
          if (!checkoutsMap[checkout.filePath]) {
            checkoutsMap[checkout.filePath] = [];
          }
          checkoutsMap[checkout.filePath].push({
            id: checkout.id,
            locked: checkout.locked,
            workspaceId: checkout.workspaceId,
            userId: checkout.userId,
            user: checkout.user,
          });
        }
      }

      // Build children with stats
      const children = await Promise.all(
        fileInfos.map(async ({ relativePath, entry }) => {
          const entryPath = path.join(
            workspace.localPath,
            input.path,
            entry.name,
          );
          const stats = await fs.stat(entryPath);
          const statusResult = statuses.get(relativePath);

          const f: File = {
            path: entry.name,
            type: entry.isDirectory() ? FileType.Directory : FileType.Text,
            size: stats.size,
            modifiedAt: stats.mtimeMs,
            status: statusResult?.status ?? 0,
            id: statusResult?.fileId ?? null,
            changelist: statusResult?.changelist ?? null,
            checkouts: checkoutsMap[relativePath] ?? [],
          };

          return f;
        }),
      );

      // Check if any children have changes (pending change statuses)
      const pendingStatuses = [
        FileStatus.Added,
        FileStatus.Renamed,
        FileStatus.Deleted,
        FileStatus.ChangedCheckedOut,
        FileStatus.ChangedNotCheckedOut,
        FileStatus.NotChangedCheckedOut,
      ];
      const containsChanges = children.some((child) =>
        pendingStatuses.includes(child.status),
      );

      return {
        children,
        containsChanges,
      };
    }),

  diffFile: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      // Normalize the input path (remove leading slash if present)
      const normalizedPath = input.path
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      // Get workspace state to determine if file exists in head version
      const workspaceState = manager.getWorkspaceState(workspace.id);
      const headFileInfo = workspaceState?.files[normalizedPath];

      // Try to read current file from disk
      const filePath = path.join(workspace.localPath, normalizedPath);
      let currentContent: string | null = null;
      try {
        currentContent = await fs.readFile(filePath, "utf-8");
      } catch {
        // File doesn't exist on disk (deleted)
        currentContent = null;
      }

      // Determine left (head) and right (current) content based on file status
      let leftContent: string;
      let rightContent: string;

      if (isBinaryFile(normalizedPath)) {
        return {
          left: "[Binary file]",
          right: "[Binary file]",
        };
      }

      if (!headFileInfo) {
        // File is new/added (not in head) - left is empty, right is current
        leftContent = "";
        rightContent = currentContent ?? "";
      } else if (currentContent === null) {
        // File is deleted (exists in head but not on disk)
        // Retrieve head content from Longtail storage
        try {
          const headResult = await readFileFromChangelist({
            workspace: {
              daemonId: input.daemonId,
              repoId: workspace.repoId,
              localPath: workspace.localPath,
            },
            filePath: normalizedPath,
            changelistNumber: headFileInfo.changelist,
          });
          leftContent = await fs.readFile(headResult.cachePath, "utf-8");
        } catch (err) {
          console.error("Failed to read head version:", err);
          leftContent = `[Error reading file from changelist ${headFileInfo.changelist}]\n${err instanceof Error ? err.message : String(err)}`;
        }
        rightContent = "";
      } else {
        // File is modified (exists in both head and current)
        // Retrieve head content from Longtail storage
        try {
          const headResult = await readFileFromChangelist({
            workspace: {
              daemonId: input.daemonId,
              repoId: workspace.repoId,
              localPath: workspace.localPath,
            },
            filePath: normalizedPath,
            changelistNumber: headFileInfo.changelist,
          });
          leftContent = await fs.readFile(headResult.cachePath, "utf-8");
        } catch (err) {
          console.error("Failed to read head version:", err);
          leftContent = `[Error reading file from changelist ${headFileInfo.changelist}]\n${err instanceof Error ? err.message : String(err)}`;
        }
        rightContent = currentContent;
      }

      return {
        left: leftContent,
        right: rightContent,
      };
    }),

  pull: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistId: z.number().nullable(),
        filePaths: z.array(z.string()).nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const repo = await client.repo.getRepo.query({ id: workspace.repoId });

      if (!repo) {
        throw new Error(
          `Could not find repo for workspace ID ${input.workspaceId}`,
        );
      }

      // Check for conflicts before pulling
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      if (pendingChanges && pendingChanges.numChanges > 0) {
        const locallyModifiedPaths = Object.keys(pendingChanges.files);
        const conflictResult = await checkConflicts(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: workspace.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          locallyModifiedPaths,
        );

        if (conflictResult.hasConflicts) {
          const conflictPaths = conflictResult.conflicts
            .map((c) => c.path)
            .join(", ");
          throw new TRPCError({
            code: "CONFLICT",
            message: `Cannot pull: ${conflictResult.conflicts.length} conflicting file(s) detected. These files have been modified locally and also changed on the remote: ${conflictPaths}`,
          });
        }
      }

      const mergeResult = await pull(
        {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        },
        repo.orgId,
        input.changelistId,
        input.filePaths,
      );

      // Reload workspace state from the updated state.json
      await manager.reloadWorkspaceState(workspace);

      // Clear cached sync status since we just pulled
      manager.clearSyncStatus(workspace.id);

      return mergeResult;
    }),

  submit: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        message: z.string(),
        modifications: z.array(
          z.object({
            delete: z.boolean(),
            path: z.string(),
            oldPath: z.string().optional(),
          }),
        ),
        shelved: z.boolean(),
        keepCheckedOut: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      console.log(
        "[daemon.submit] Called with workspaceId:",
        input.workspaceId,
      );
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const repo = await client.repo.getRepo.query({ id: workspace.repoId });

      if (!repo) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find repo for workspace ID ${input.workspaceId}`,
        });
      }

      try {
        // Check for conflicts before submitting
        const modificationPaths = input.modifications.map((m) =>
          m.path.replace(/^[/\\]/, "").replace(/\\/g, "/"),
        );
        const conflictResult = await checkConflicts(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: workspace.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          modificationPaths,
        );

        if (conflictResult.hasConflicts) {
          const conflictPaths = conflictResult.conflicts
            .map((c) => c.path)
            .join(", ");
          throw new TRPCError({
            code: "CONFLICT",
            message: `Cannot submit: ${conflictResult.conflicts.length} conflicting file(s) detected. These files have been modified locally and also changed on the remote. Please pull first to resolve: ${conflictPaths}`,
          });
        }

        await submit(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: workspace.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          repo.orgId,
          input.message,
          input.modifications,
          workspace.id,
          input.keepCheckedOut ?? false,
        );

        // Reload workspace state from the updated state.json
        await manager.reloadWorkspaceState(workspace);

        // Clear submitted files from marked-for-add list
        const submittedPaths = input.modifications.map((m) =>
          m.path.replace(/^[/\\]/, "").replace(/\\/g, "/"),
        );
        if (submittedPaths.length > 0) {
          await manager.unmarkForAdd(workspace, submittedPaths);
        }
      } catch (e: any) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: e.message ?? JSON.stringify(e),
        });
      }
    }),

  history: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .output(
      z.array(
        z.object({
          number: z.number(),
          id: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          userId: z.string().nullable(),
          repoId: z.string(),
          message: z.string(),
          versionIndex: z.string(),
          stateTree: z.any(),
          parentNumber: z.number().nullable(),
          user: z
            .object({
              email: z.string(),
            })
            .nullable(),
        }),
      ),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const repo = await client.repo.getRepo.query({ id: workspace.repoId });

      if (!repo) {
        throw new Error(
          `Could not find repo for workspace ID ${input.workspaceId}`,
        );
      }

      const changelists = await client.changelist.getChangelists.query({
        repoId: repo.id,
        branchName: workspace.branchName,
        start: {
          number: null,
          timestamp: null,
        },
        count: 100,
      });

      return changelists;
    }),

  createLabel: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string().min(1),
        changelistNumber: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return client.label.createLabel.mutate({
        repoId: workspace.repoId,
        name: input.name,
        number: input.changelistNumber,
      });
    }),

  getLabels: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return client.label.getLabels.query({
        repoId: workspace.repoId,
      });
    }),

  deleteLabel: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        labelId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return client.label.deleteLabel.mutate({
        id: input.labelId,
        repoId: workspace.repoId,
      });
    }),

  renameLabel: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        labelId: z.string(),
        name: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return client.label.renameLabel.mutate({
        id: input.labelId,
        repoId: workspace.repoId,
        name: input.name,
      });
    }),

  changeLabelChangelist: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        labelId: z.string(),
        number: z.number().int().min(0),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      return client.label.changeChangelist.mutate({
        id: input.labelId,
        repoId: workspace.repoId,
        number: input.number,
      });
    }),

  fileHistory: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
        count: z.number().min(1).max(100).optional().default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      // Normalize the file path
      const normalizedPath = input.filePath
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      const fileHistory = await client.file.getFileHistory.query({
        repoId: workspace.repoId,
        filePath: normalizedPath,
        count: input.count,
      });

      return fileHistory;
    }),

  changelistFiles: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const files = await client.changelist.getChangelistFiles.query({
        repoId: workspace.repoId,
        changelistNumber: input.changelistNumber,
      });

      return files;
    }),

  checkout: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
        locked: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const normalizedPath = input.path
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      return client.file.checkout.mutate({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
        filePath: normalizedPath,
        locked: input.locked,
      });
    }),

  undoCheckout: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const normalizedPath = input.path
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      return client.file.undoCheckout.mutate({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
        filePath: normalizedPath,
      });
    }),

  markForAdd: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const normalizedPaths = input.paths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      await manager.markForAdd(workspace, normalizedPaths);

      return { success: true, paths: normalizedPaths };
    }),

  unmarkForAdd: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const normalizedPaths = input.paths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      await manager.unmarkForAdd(workspace, normalizedPaths);

      return { success: true, paths: normalizedPaths };
    }),

  getActiveCheckoutsForFiles: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);

      const normalizedPaths = input.filePaths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      return client.file.getActiveCheckoutsForFiles.query({
        repoId: workspace.repoId,
        filePaths: normalizedPaths,
      });
    }),

  fileHistoryDiff: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
        changelistNumber: z.number(),
        previousChangelistNumber: z.number().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const normalizedPath = input.filePath
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      let leftResult: { cachePath: string; isBinary: boolean } | null = null;
      let rightResult: { cachePath: string; isBinary: boolean } | null = null;

      // Get the file at the selected changelist
      try {
        const result = await readFileFromChangelist({
          workspace: {
            daemonId: input.daemonId,
            repoId: workspace.repoId,
            localPath: workspace.localPath,
          },
          filePath: normalizedPath,
          changelistNumber: input.changelistNumber,
        });
        rightResult = {
          cachePath: result.cachePath,
          isBinary: result.isBinary,
        };
      } catch (err) {
        console.error("Failed to read file at changelist:", err);
      }

      // Get the file at the previous changelist (if exists)
      if (input.previousChangelistNumber !== null) {
        try {
          const result = await readFileFromChangelist({
            workspace: {
              daemonId: input.daemonId,
              repoId: workspace.repoId,
              localPath: workspace.localPath,
            },
            filePath: normalizedPath,
            changelistNumber: input.previousChangelistNumber,
          });
          leftResult = {
            cachePath: result.cachePath,
            isBinary: result.isBinary,
          };
        } catch {
          // File might not exist at the previous changelist (was added in this changelist)
        }
      }

      return {
        left: leftResult,
        right: rightResult,
      };
    }),

  revertFiles: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const workspaceState = manager.getWorkspaceState(workspace.id);

      const results: {
        filePath: string;
        success: boolean;
        error?: string;
      }[] = [];

      for (const rawPath of input.filePaths) {
        const normalizedPath = rawPath
          .replace(/^[/\\]/, "")
          .replace(/\\/g, "/");

        try {
          // Look up the head changelist for this file from workspace state
          const headFileInfo = workspaceState?.files[normalizedPath];

          if (headFileInfo && headFileInfo.changelist) {
            // File exists in head — download head version and overwrite local
            const result = await readFileFromChangelist({
              workspace: {
                daemonId: input.daemonId,
                repoId: workspace.repoId,
                localPath: workspace.localPath,
              },
              filePath: normalizedPath,
              changelistNumber: headFileInfo.changelist,
            });

            // Copy cached head version over the working copy
            const localFilePath = path.join(
              workspace.localPath,
              normalizedPath,
            );
            await fs.copyFile(result.cachePath, localFilePath);
          } else {
            // File is not in any head version (locally added file).
            // Delete it from disk so it reverts to "not existing".
            const localFilePath = path.join(
              workspace.localPath,
              normalizedPath,
            );
            try {
              await fs.unlink(localFilePath);
            } catch {
              // File may already be gone
            }
          }

          // Undo checkout if the file was checked out
          try {
            await client.file.undoCheckout.mutate({
              repoId: workspace.repoId,
              workspaceId: workspace.id,
              filePath: normalizedPath,
            });
          } catch {
            // Not checked out — that's fine
          }

          results.push({ filePath: normalizedPath, success: true });
        } catch (error: any) {
          results.push({
            filePath: normalizedPath,
            success: false,
            error: error?.message || "Unknown error",
          });
        }
      }

      // Remove any reverted files from the marked-for-add list
      const revertedPaths = results
        .filter((r) => r.success)
        .map((r) => r.filePath);
      if (revertedPaths.length > 0) {
        await manager.unmarkForAdd(workspace, revertedPaths);
      }

      return { results };
    }),

  readFileAtChangelist: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePath: z.string(),
        changelistNumber: z.number(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      const normalizedPath = input.filePath
        .replace(/^[/\\]/, "")
        .replace(/\\/g, "/");

      const result = await readFileFromChangelist({
        workspace: {
          daemonId: input.daemonId,
          repoId: workspace.repoId,
          localPath: workspace.localPath,
        },
        filePath: normalizedPath,
        changelistNumber: input.changelistNumber,
      });

      return {
        cachePath: result.cachePath,
        isBinary: result.isBinary,
        size: result.size,
      };
    }),

  // ─── Sync Status & Preview ───────────────────────────────────────

  getSyncStatus: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        forceRefresh: z.boolean().optional().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      // Return cached status unless force refresh
      if (!input.forceRefresh) {
        const cached = manager.getSyncStatus(workspace.id);
        if (cached) {
          return cached;
        }
      }

      return await manager.refreshSyncStatus(workspace);
    }),

  getSyncPreview: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      // Get fresh sync status
      const syncStatus = await manager.refreshSyncStatus(workspace);

      if (syncStatus.upToDate) {
        return {
          syncStatus,
          changelists: [],
          allFileChanges: [],
        };
      }

      // Fetch the changelist details for all CLs that need to be pulled
      const client = await CreateApiClientAuth(input.daemonId);

      const changelistsResponse =
        await client.changelist.getChangelistsWithNumbers.query({
          repoId: workspace.repoId,
          numbers: syncStatus.changelistsToPull,
        });

      const sortedChangelists = changelistsResponse.sort(
        (a: any, b: any) => a.number - b.number,
      );

      // Fetch file changes for each changelist
      const allFileChanges: Array<{
        changelistNumber: number;
        message: string;
        user: string;
        date: string;
        files: Array<{
          fileId: string;
          path: string;
          changeType: string;
          oldPath: string | null;
        }>;
      }> = [];

      for (const cl of sortedChangelists) {
        try {
          const files = await client.changelist.getChangelistFiles.query({
            repoId: workspace.repoId,
            changelistNumber: cl.number,
          });

          allFileChanges.push({
            changelistNumber: cl.number,
            message: cl.message ?? "",
            user: (cl as any).user?.email ?? "Unknown",
            date: new Date(cl.createdAt).toISOString(),
            files,
          });
        } catch {
          // Skip changelists we can't fetch files for
          allFileChanges.push({
            changelistNumber: cl.number,
            message: cl.message ?? "",
            user: (cl as any).user?.email ?? "Unknown",
            date: new Date(cl.createdAt).toISOString(),
            files: [],
          });
        }
      }

      return {
        syncStatus,
        changelists: sortedChangelists,
        allFileChanges,
      };
    }),

  checkConflicts: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new Error(
          `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        );
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new Error(`Could not find workspace ID ${input.workspaceId}`);
      }

      // Get pending changes for locally modified paths
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      const locallyModifiedPaths = pendingChanges
        ? Object.keys(pendingChanges.files)
        : [];

      return await checkConflicts(
        {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        },
        locallyModifiedPaths,
      );
    }),

  resolveConflicts: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        filePaths: z.array(z.string()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);

      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      // Get current sync status to know the remote head CL for each file
      let syncStatus = manager.getSyncStatus(workspace.id);
      if (!syncStatus) {
        syncStatus = await manager.refreshSyncStatus(workspace);
      }

      // Verify the remote head hasn't moved in a way that affects the files
      // being resolved. This prevents silently resolving against stale conflict
      // data when another user pushed changes to the SAME files in the meantime.
      // If the head moved but only touched unrelated files, we allow the resolve.
      const config = await getWorkspaceConfig(workspace.localPath);
      if (config?.lastSyncStatusRemoteHead != null) {
        const client = await CreateApiClientAuth(workspace.daemonId);
        const branch = await client.branch.getBranch.query({
          repoId: workspace.repoId,
          name: workspace.branchName,
        });

        if (branch && branch.headNumber !== config.lastSyncStatusRemoteHead) {
          // Head moved — walk the parent chain from headNumber back to
          // lastSyncStatusRemoteHead and check if any of the requested
          // files were modified in those intervening changelists.
          const normalizedResolvePaths = new Set(
            input.filePaths.map((p) =>
              p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
            ),
          );

          const { paths: changedPaths } =
            (await client.changelist.getFilePathsChangedBetween.query({
              repoId: workspace.repoId,
              fromNumber: config.lastSyncStatusRemoteHead,
              toNumber: branch.headNumber,
            })) as { paths: string[] };

          const affectedPaths = changedPaths
            .map((p: string) => p.replace(/^[/\\]/, "").replace(/\\/g, "/"))
            .filter((p: string) => normalizedResolvePaths.has(p));

          if (affectedPaths.length > 0) {
            const affectedList = affectedPaths.join(", ");
            throw new TRPCError({
              code: "CONFLICT",
              message:
                `The remote branch head has moved from CL ${config.lastSyncStatusRemoteHead} ` +
                `to CL ${branch.headNumber} since the last sync status check, ` +
                `and the following files you are trying to resolve were modified ` +
                `in the new changelist(s): ${affectedList}. ` +
                `Please refresh sync status before resolving these conflicts.`,
            });
          }
        }
      }

      // Get the current workspace state
      const state = await getWorkspaceState(workspace.localPath);

      // Build a lookup from the outdated files
      const outdatedByPath = new Map(
        syncStatus.outdatedFiles.map((f) => [
          f.path.replace(/^[\/\\]/, "").replace(/\\/g, "/"),
          f,
        ]),
      );

      const resolvedPaths: string[] = [];

      for (const filePath of input.filePaths) {
        const normalizedPath = filePath
          .replace(/^[\/\\]/, "")
          .replace(/\\/g, "/");

        const outdated = outdatedByPath.get(normalizedPath);
        if (outdated && state.files[normalizedPath]) {
          // Update the file's CL to match the remote, marking it as resolved
          state.files[normalizedPath]!.changelist = outdated.remoteChangelist;
          resolvedPaths.push(normalizedPath);
        }
      }

      if (resolvedPaths.length > 0) {
        // Persist the updated state
        const utilWorkspace: UtilWorkspace = {
          id: workspace.id,
          repoId: workspace.repoId,
          branchName: workspace.branchName,
          workspaceName: workspace.name,
          localPath: workspace.localPath,
          daemonId: workspace.daemonId,
        };
        await saveWorkspaceState(utilWorkspace, state);

        // Reload cached state in the daemon manager
        await manager.reloadWorkspaceState(workspace);

        // Refresh sync status since conflicts may have changed
        await manager.refreshSyncStatus(workspace);
      }

      return { resolvedPaths };
    }),

  getResolveConfirmSuppressed: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) return { suppressed: false };

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) return { suppressed: false };

      const config = await getWorkspaceConfig(workspace.localPath);
      if (!config?.suppressResolveConfirmUntil) return { suppressed: false };

      const value = config.suppressResolveConfirmUntil;

      // "workspace" means permanently suppressed for this workspace
      if (value === "workspace") return { suppressed: true };

      // Otherwise it's an ISO date string — check if we're still within the day
      const suppressDate = new Date(value);
      const now = new Date();
      if (
        suppressDate.getFullYear() === now.getFullYear() &&
        suppressDate.getMonth() === now.getMonth() &&
        suppressDate.getDate() === now.getDate()
      ) {
        return { suppressed: true };
      }

      // Expired — clear it
      if (config) {
        config.suppressResolveConfirmUntil = null;
        await saveWorkspaceConfig(config);
      }
      return { suppressed: false };
    }),

  setResolveConfirmSuppressed: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        /** "today" or "workspace" */
        duration: z.enum(["today", "workspace"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);

      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const config = await getWorkspaceConfig(workspace.localPath);
      const workspaceConfig: UtilWorkspace = config ?? {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: workspace.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      if (input.duration === "workspace") {
        workspaceConfig.suppressResolveConfirmUntil = "workspace";
      } else {
        // "today" — store today's date in ISO format
        workspaceConfig.suppressResolveConfirmUntil = new Date().toISOString();
      }

      await saveWorkspaceConfig(workspaceConfig);
      return { success: true };
    }),

  // ─── Branch Operations ─────────────────────────────────────────

  listBranches: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        includeArchived: z.boolean().default(false),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const branches = await client.branch.listBranches.query({
        repoId: workspace.repoId,
        includeArchived: input.includeArchived,
      });

      return { branches, currentBranchName: workspace.branchName };
    }),

  createBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string().min(1),
        headNumber: z.number(),
        type: z.enum(["MAINLINE", "RELEASE", "FEATURE"]).default("FEATURE"),
        parentBranchName: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const branch = await client.branch.createBranch.mutate({
        repoId: workspace.repoId,
        name: input.name,
        headNumber: input.headNumber,
        type: input.type,
        parentBranchName: input.parentBranchName,
      });

      return branch;
    }),

  switchBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);

      // Get the target branch
      const targetBranch = await client.branch.getBranch.query({
        repoId: workspace.repoId,
        name: input.branchName,
      });

      if (!targetBranch) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Branch "${input.branchName}" not found`,
        });
      }

      if (targetBranch.archivedAt) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot switch to an archived branch",
        });
      }

      // Check for conflicts: get pending changes
      const pendingChanges = manager.workspacePendingChanges.get(workspace.id);
      if (pendingChanges && pendingChanges.numChanges > 0) {
        // Check if any binary files have been modified
        const locallyModifiedPaths = Object.entries(pendingChanges.files)
          .filter(([_, file]) => {
            const status = file.status;
            return (
              status === FileStatus.Added ||
              status === FileStatus.Renamed ||
              status === FileStatus.Deleted ||
              status === FileStatus.ChangedCheckedOut ||
              status === FileStatus.ChangedNotCheckedOut
            );
          })
          .map(([path]) => path);

        if (locallyModifiedPaths.length > 0) {
          // Get all files changed between the current and target branch heads
          const currentBranch = await client.branch.getBranch.query({
            repoId: workspace.repoId,
            name: workspace.branchName,
          });

          if (currentBranch) {
            // Check for binary file conflicts
            const { paths: remoteChangedPaths } =
              (await client.changelist.getFilePathsChangedBetween.query({
                repoId: workspace.repoId,
                fromNumber: Math.min(
                  currentBranch.headNumber,
                  targetBranch.headNumber,
                ),
                toNumber: Math.max(
                  currentBranch.headNumber,
                  targetBranch.headNumber,
                ),
              })) as { paths: string[] };

            const conflictingPaths = locallyModifiedPaths.filter((p) =>
              remoteChangedPaths.includes(p),
            );

            if (conflictingPaths.length > 0) {
              // Check for binary files in conflicts
              const binaryConflicts = conflictingPaths.filter((p) =>
                isBinaryFile(p),
              );

              if (binaryConflicts.length > 0) {
                throw new TRPCError({
                  code: "CONFLICT",
                  message: `Cannot switch branches: the following binary files have local changes that conflict: ${binaryConflicts.join(", ")}`,
                });
              }
            }
          }
        }
      }

      // Update the workspace branch name
      workspace.branchName = input.branchName;

      // Update daemon config
      const daemonConfig = DaemonConfig.Ensure();
      const configWorkspace = daemonConfig.vars.workspaces.find(
        (w) => w.id === workspace.id,
      );
      if (configWorkspace) {
        configWorkspace.branchName = input.branchName;
      }
      await DaemonConfig.Save();

      // Save workspace config to disk
      const config = await getWorkspaceConfig(workspace.localPath);
      const workspaceConfigToSave: UtilWorkspace = config ?? {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: input.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };
      workspaceConfigToSave.branchName = input.branchName;
      await saveWorkspaceConfig(workspaceConfigToSave);

      // Pull to the target branch head
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        await pull(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: input.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          repo.orgId,
          null,
          null,
        );
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return { success: true, branchName: input.branchName };
    }),

  archiveBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.branch.archiveBranch.mutate({
        repoId: workspace.repoId,
        branchName: input.branchName,
      });
    }),

  unarchiveBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.branch.unarchiveBranch.mutate({
        repoId: workspace.repoId,
        branchName: input.branchName,
      });
    }),

  deleteBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.branch.deleteBranch.mutate({
        repoId: workspace.repoId,
        branchName: input.branchName,
      });
    }),

  mergeBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        incomingBranchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = DaemonManager.Get();
      const workspaces = manager.workspaces.get(input.daemonId);
      if (!workspaces) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find any workspaces locally for daemon ID ${input.daemonId}`,
        });
      }

      const workspace = workspaces.find((w) => w.id === input.workspaceId);
      if (!workspace) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      const result = await client.branch.mergeBranch.mutate({
        repoId: workspace.repoId,
        incomingBranchName: input.incomingBranchName,
        targetBranchName: workspace.branchName,
      });

      // Pull the merge CL into the workspace
      const repo = await client.repo.getRepo.query({ id: workspace.repoId });
      if (repo) {
        await pull(
          {
            id: workspace.id,
            repoId: workspace.repoId,
            branchName: workspace.branchName,
            workspaceName: workspace.name,
            localPath: workspace.localPath,
            daemonId: workspace.daemonId,
          },
          repo.orgId,
          null,
          null,
        );
      }

      // Reload workspace state
      await manager.reloadWorkspaceState(workspace);
      manager.clearSyncStatus(workspace.id);

      return result;
    }),
});
