import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { File, FileStatus, FileType } from "../../../types/index.js";
import {
  isBinaryFile,
  readFileFromChangelist,
  submit,
  checkConflicts,
  pullTextFilesForSubmit,
} from "../../../util/index.js";
import { TRPCError } from "@trpc/server";
import { JobManager } from "../../../job-manager.js";

export const pendingRouter = router({
  refresh: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspaces = ctx.manager.workspaces.get(input.daemonId);
      if (workspaces) {
        const workspace = workspaces.find((w) => w.id === input.workspaceId);
        if (workspace) {
          return await ctx.manager.refreshWorkspaceContents(workspace);
        }

        return null;
      }
    }),

  rescanIgnoreFiles: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const workspaces = ctx.manager.workspaces.get(input.daemonId);
      if (workspaces) {
        const workspace = workspaces.find((w) => w.id === input.workspaceId);
        if (workspace) {
          await ctx.manager.scanIgnoreFiles(workspace);
          return await ctx.manager.refreshWorkspaceContents(workspace, {
            forceFullRefresh: true,
          });
        }

        return null;
      }
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
      const manager = ctx.manager;
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

  getDirectory: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = ctx.manager;
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
      const statuses = await manager.getFileStatuses(
        workspace.id,
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
        const checkouts = await client.file.getActiveCheckoutsForFiles.mutate({
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

  getDirectoryPending: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const manager = ctx.manager;
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

      return manager.getDirectoryPending(workspace.id, workspace, input.path);
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
        shelfName: z.string().optional(),
        keepCheckedOut: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
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

      // Expand any directory paths into individual file modifications
      const expandedModifications = await manager.expandDirectoriesForSubmit(
        workspace,
        input.modifications,
      );

      // Check for conflicts before submitting (sync — fail fast)
      const modificationPaths = expandedModifications.map((m) =>
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

      // Create async job for the long-running work
      const jobManager = JobManager.Get();
      const job = jobManager.createJob("submit");

      const workspaceInfo = {
        id: workspace.id,
        repoId: workspace.repoId,
        branchName: workspace.branchName,
        workspaceName: workspace.name,
        localPath: workspace.localPath,
        daemonId: workspace.daemonId,
      };

      // Fire-and-forget: run the submit in the background
      (async () => {
        manager.beginVcsOperation(workspace.id);
        try {
          jobManager.updateStep(job.id, "Merging outdated text files");

          const mergeResult = await pullTextFilesForSubmit(
            workspaceInfo,
            repo.orgId,
            modificationPaths,
          );

          if (mergeResult.conflictMerges.length > 0) {
            const conflictPaths = mergeResult.conflictMerges.join(", ");
            throw new Error(
              `${mergeResult.conflictMerges.length} text file(s) have merge conflicts after auto-merge. Please resolve the conflict markers and try again: ${conflictPaths}`,
            );
          }

          await submit(
            workspaceInfo,
            repo.orgId,
            input.message,
            expandedModifications,
            workspace.id,
            input.keepCheckedOut ?? false,
            undefined,
            (step) => jobManager.updateStep(job.id, step),
            (step, done, total) =>
              jobManager.updateProgress(job.id, done, total),
            input.shelfName ? input.shelfName : undefined,
          );

          jobManager.updateStep(job.id, "Reloading workspace state");
          await manager.reloadWorkspaceState(workspace);

          const submittedPaths = expandedModifications.map((m) =>
            m.path.replace(/^[/\\]/, "").replace(/\\/g, "/"),
          );
          if (submittedPaths.length > 0) {
            await manager.unmarkForAdd(workspace, submittedPaths);
          }

          jobManager.completeJob(job.id);
        } catch (e: any) {
          jobManager.failJob(job.id, e.message ?? String(e));
        } finally {
          await manager.endVcsOperation(workspace.id);
        }
      })();

      return { jobId: job.id };
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
      const manager = ctx.manager;
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
      const manager = ctx.manager;
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
      const manager = ctx.manager;
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
      const manager = ctx.manager;
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
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;
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

      return client.file.getActiveCheckoutsForFiles.mutate({
        repoId: workspace.repoId,
        filePaths: normalizedPaths,
      });
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
      const manager = ctx.manager;
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
});
