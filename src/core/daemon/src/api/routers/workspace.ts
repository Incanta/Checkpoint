import { publicProcedure, router } from "../trpc";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "daemon/src/daemon-manager";
import { DaemonConfig } from "daemon/src/daemon-config";
import fs from "fs/promises";
import path from "path";
import { pull, submit, readFileFromChangelist } from "@checkpointvcs/client";
import {
  FileStatus,
  FileType,
  type File,
  type Workspace,
} from "daemon/src/types";
import { getFileStatuses } from "daemon/src/file-status";

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
          leftContent = headResult.content;
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
          leftContent = headResult.content;
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

      await pull(
        {
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

      await submit(
        {
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

      let leftContent = "";
      let rightContent = "";

      // Get the file content at the selected changelist
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
        rightContent = result.content;
      } catch (err) {
        console.error("Failed to read file at changelist:", err);
        rightContent = `[Error reading file from changelist ${input.changelistNumber}]\n${err instanceof Error ? err.message : String(err)}`;
      }

      // Get the file content at the previous changelist (if exists)
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
          leftContent = result.content;
        } catch {
          // File might not exist at the previous changelist (was added in this changelist)
          leftContent = "";
        }
      }

      return {
        left: leftContent,
        right: rightContent,
      };
    }),
});
