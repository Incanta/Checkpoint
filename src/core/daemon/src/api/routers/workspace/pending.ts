import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import {
  File,
  FileClaimInfo,
  FileStatus,
  FileType,
} from "../../../types/index.js";
import {
  getBinaryExtensions,
  isBinaryFile,
  readFileFromChangelist,
  submit,
  checkConflicts,
  pullTextFilesForSubmit,
} from "../../../util/index.js";
import { TRPCError } from "@trpc/server";
import { JobManager } from "../../../job-manager.js";
import { DaemonManager } from "../../../daemon-manager.js";
import {
  computeHunks,
  computeLineChanges,
  applyHunks,
  isFullySelected,
} from "../../../util/hunks.js";
import {
  readStagedBlob,
  writeStagedBlob,
  clearStagedBlob,
} from "../../../util/staged-blobs.js";
import { prepareCompositeRoot } from "../../../util/composite-root.js";

/**
 * Resolves the manager and workspace for a daemon call, throwing the same way
 * every procedure in this router already does by hand.
 */
function resolveWorkspace(
  ctx: { manager: DaemonManager },
  input: { daemonId: string; workspaceId: string },
) {
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

  return { manager, workspace };
}

/** Repo-relative, forward-slashed, no leading separator. */
function normalizeRelPath(p: string): string {
  return p.replace(/^[/\\]/, "").replace(/\\/g, "/");
}

/**
 * Reads both sides of a text file's diff: the head revision from storage and
 * the current worktree content from disk.
 */
async function readHeadAndWorktree(
  daemonId: string,
  workspace: { id: string; repoId: string; localPath: string },
  relPath: string,
): Promise<{ head: string; worktree: string } | null> {
  const manager = DaemonManager.Get();
  const headInfo = manager.getWorkspaceState(workspace.id)?.files[relPath];
  if (!headInfo) {
    return null;
  }

  const headResult = await readFileFromChangelist({
    workspace: {
      daemonId,
      repoId: workspace.repoId,
      localPath: workspace.localPath,
    },
    filePath: relPath,
    changelistNumber: headInfo.changelist,
  });

  return {
    head: await fs.readFile(headResult.cachePath, "utf-8"),
    worktree: await fs.readFile(
      path.join(workspace.localPath, relPath),
      "utf-8",
    ),
  };
}

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

      if (
        isBinaryFile(
          normalizedPath,
          await getBinaryExtensions(input.daemonId, workspace.repoId),
        )
      ) {
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

      // Fetch active claims for files in this directory. The workspace's
      // domain root goes along so the server can say which claims actually
      // block this workspace and which are context from another domain.
      const client = await CreateApiClientAuth(input.daemonId);
      const filePaths = fileInfos
        .filter((fi) => !fi.isDirectory)
        .map((fi) => fi.relativePath);

      const stagedSet = manager.getStaged(workspace.id);
      const claimsMap: Record<string, FileClaimInfo[]> = {};

      if (filePaths.length > 0) {
        const claims = await client.file.getClaimsForFiles.mutate({
          repoId: workspace.repoId,
          filePaths,
          branchName: workspace.domainBranchName,
        });

        for (const claim of claims) {
          claimsMap[claim.filePath] ??= [];
          claimsMap[claim.filePath]!.push({
            id: claim.id,
            fileId: claim.fileId,
            filePath: claim.filePath,
            strength: claim.strength,
            state: claim.state,
            branchName: claim.branchName,
            domainBranchName: claim.domainBranchName,
            blocking: claim.blocking,
            workspaceId: claim.workspaceId,
            userId: claim.userId,
            user: claim.user,
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
            claims: claimsMap[relativePath] ?? [],
            staged: stagedSet.has(relativePath),
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
        /**
         * Which bucket to submit. Defaults to the workspace's domain root.
         * The file list is derived from the staged set filtered to this
         * branch; callers do not supply modifications.
         */
        branchName: z.string().optional(),
        keepCheckedOut: z.boolean().optional(),
        // When true, skip progress/step callbacks entirely (no per-tick
        // callback overhead). Used by the CLI's --no-progress flag.
        noProgress: z.boolean().optional(),
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

      const targetBranch = input.branchName ?? workspace.domainBranchName;

      if (
        targetBranch !== workspace.domainBranchName &&
        !workspace.activeBranches.includes(targetBranch)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${targetBranch}" is not active in this workspace.`,
        });
      }

      // Submit exactly the staged files destined for this branch. Unstaged
      // work is never submitted, and work staged to a different bucket stays
      // where it is. This is why the caller supplies no file list: the staged
      // set plus each file's claim already says what belongs here.
      const pending = await manager.refreshWorkspaceContents(workspace);
      const staged = manager.getStaged(workspace.id);

      const modifications = Object.values(pending.files)
        .filter((f) => staged.has(f.path))
        .filter((f) => {
          const claim = f.claims[0];
          // No claim means nothing has pinned this file to a branch, so it
          // belongs to the domain root by default.
          const destined = claim?.branchName ?? workspace.domainBranchName;
          return destined === targetBranch;
        })
        .map((f) => ({
          path: f.path,
          delete: f.status === FileStatus.Deleted,
        }));

      if (modifications.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Nothing staged for "${targetBranch}". Stage files before submitting.`,
        });
      }

      // Expand any directory paths into individual file modifications
      const expandedModifications = await manager.expandDirectoriesForSubmit(
        workspace,
        modifications,
      );

      // Check for conflicts before submitting (sync, fail fast)
      const modificationPaths = expandedModifications.map((m) =>
        m.path.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );
      const conflictResult = await checkConflicts(
        {
          id: workspace.id,
          repoId: workspace.repoId,
          domainBranchName: workspace.domainBranchName,
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
        domainBranchName: workspace.domainBranchName,
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

          const reportProgress = !input.noProgress;

          // Partially-staged files have content that exists in neither the
          // head nor the working tree, so they cannot be submitted straight
          // off disk. Materialize a tree where those files carry their staged
          // content and everything else is the worktree file, and point the
          // addon at that instead. Returns null (and costs nothing) when no
          // submitted file is partially staged, which is the common case.
          const composite = await prepareCompositeRoot(
            workspace.localPath,
            expandedModifications.map((m) => m.path),
          );

          try {
            await submit(
              composite
                ? { ...workspaceInfo, localPath: composite.rootPath }
                : workspaceInfo,
              repo.orgId,
              input.message,
              expandedModifications,
              workspace.id,
              input.keepCheckedOut ?? false,
              undefined,
              reportProgress
                ? (step) => jobManager.updateStep(job.id, step)
                : undefined,
              reportProgress
                ? (step, done, total) =>
                    jobManager.updateProgress(job.id, done, total)
                : undefined,
              undefined, // artifactForChangelistNum
              targetBranch,
            );
          } finally {
            await composite?.cleanup();
          }

          // Whatever was staged has landed, so no third state remains.
          for (const mod of expandedModifications) {
            await clearStagedBlob(workspace.localPath, mod.path);
          }

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
        /**
         * Which of the workspace's active branches this edit belongs to.
         * Defaults to the domain root, which is where a workspace with no
         * overlays is always working.
         */
        branchName: z.string().optional(),
        /**
         * Take an exclusive claim on a path the binary-extension set considers
         * mergeable. The escape hatch for a large refactor of a text file.
         */
        forceExclusive: z.boolean().default(false),
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
        branchName: input.branchName ?? workspace.domainBranchName,
        forceExclusive: input.forceExclusive,
      });
    }),

  releaseClaim: publicProcedure
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

      return client.file.releaseClaim.mutate({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
        filePath: normalizedPath,
      });
    }),

  /**
   * Stage files for the next submit, and point their claims at `branchName`.
   *
   * Staging is the git index: it says a change is ready, not which branch it
   * belongs to. The branch comes from the claim, which is why this moves the
   * claim as well rather than recording a target locally where the two could
   * drift.
   */
  stage: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1),
        /**
         * Which bucket to stage into. Defaults to the workspace's domain
         * root, which is where work goes unless you say otherwise.
         */
        branchName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);

      const targetBranch = input.branchName ?? workspace.domainBranchName;

      // You may only stage into a bucket you actually have overlaid, or the
      // domain root. Staging elsewhere would destine a change for a base that
      // is not on disk.
      if (
        targetBranch !== workspace.domainBranchName &&
        !workspace.activeBranches.includes(targetBranch)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${targetBranch}" is not active in this workspace. Activate it before staging to it.`,
        });
      }

      const normalizedPaths = input.paths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      const client = await CreateApiClientAuth(input.daemonId);

      // Claim each path onto the target branch. The server rejects a move
      // that is not legal (already submitted elsewhere, held by someone else,
      // or stale), so a failure here means the file genuinely cannot go to
      // that branch and it must not end up staged.
      for (const relPath of normalizedPaths) {
        await client.file.checkout.mutate({
          repoId: workspace.repoId,
          workspaceId: workspace.id,
          filePath: relPath,
          branchName: targetBranch,
        });
      }

      await manager.stage(workspace, normalizedPaths);

      return {
        success: true,
        paths: normalizedPaths,
        branchName: targetBranch,
      };
    }),

  /**
   * Returns the hunks between head and worktree for one text file, plus which
   * of them are currently staged.
   *
   * Only meaningful for mergeable content: a binary has no hunks, which is why
   * partial staging lines up exactly with advisory claims.
   */
  getHunks: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);
      const relPath = normalizeRelPath(input.path);

      if (
        isBinaryFile(
          relPath,
          await getBinaryExtensions(input.daemonId, workspace.repoId),
        )
      ) {
        return { hunks: [], staged: [], isBinary: true };
      }

      const sides = await readHeadAndWorktree(
        input.daemonId,
        workspace,
        relPath,
      );
      if (!sides) {
        return { hunks: [], staged: [], isBinary: false };
      }

      const hunks = computeHunks(sides.head, sides.worktree);
      const blob = await readStagedBlob(workspace.localPath, relPath);

      // Staged-ness is derived from the stored content, never kept as a
      // parallel list of indices, so the two cannot drift apart. A hunk is
      // staged when the staged content changes the same head lines it does.
      let staged: number[];
      if (blob === null) {
        staged = manager.getStaged(workspace.id).has(relPath)
          ? hunks.map((h) => h.index)
          : [];
      } else {
        const stagedRanges = new Set(
          computeHunks(sides.head, blob).map(
            (h) => `${h.oldStart}:${h.oldLines}`,
          ),
        );
        staged = hunks
          .filter((h) => stagedRanges.has(`${h.oldStart}:${h.oldLines}`))
          .map((h) => h.index);
      }

      return { hunks, staged, isBinary: false };
    }),

  /**
   * The changed regions between baseline and working tree, context-free, in
   * the shape the editor's staging flows use.
   *
   * Separate from getHunks, which keeps context for terminal display.
   */
  getLineChanges: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { workspace } = resolveWorkspace(ctx, input);
      const relPath = normalizeRelPath(input.path);

      if (
        isBinaryFile(
          relPath,
          await getBinaryExtensions(input.daemonId, workspace.repoId),
        )
      ) {
        return { changes: [], isBinary: true };
      }

      const sides = await readHeadAndWorktree(
        input.daemonId,
        workspace,
        relPath,
      );
      if (!sides) {
        return { changes: [], isBinary: false };
      }

      return {
        changes: computeLineChanges(sides.head, sides.worktree),
        isBinary: false,
      };
    }),

  /**
   * Stages explicit content for a text file.
   *
   * This is the primitive the editor-driven flows use: VS Code hands back
   * "the baseline with these blocks applied" as a string, so there is no hunk
   * arithmetic to redo on this side. `stageHunks` is the same operation with
   * the content computed here instead.
   *
   * Content equal to the working tree means the file is fully staged and
   * needs no blob, because submit already reads the tree off disk.
   */
  stageContent: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
        /** The file as it should be submitted. */
        content: z.string(),
        branchName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);
      const relPath = normalizeRelPath(input.path);

      if (
        isBinaryFile(
          relPath,
          await getBinaryExtensions(input.daemonId, workspace.repoId),
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${relPath}" is binary and stages whole-file.`,
        });
      }

      const sides = await readHeadAndWorktree(
        input.daemonId,
        workspace,
        relPath,
      );

      if (sides && input.content === sides.head) {
        // Staging the baseline back is an unstage: there is nothing to submit.
        await clearStagedBlob(workspace.localPath, relPath);
        await manager.unstage(workspace, [relPath]);
        return { success: true, partial: false, staged: false };
      }

      const partial = !sides || input.content !== sides.worktree;

      if (partial) {
        await writeStagedBlob(workspace.localPath, relPath, input.content);
      } else {
        await clearStagedBlob(workspace.localPath, relPath);
      }

      const client = await CreateApiClientAuth(input.daemonId);
      await client.file.checkout.mutate({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
        filePath: relPath,
        branchName: input.branchName ?? workspace.domainBranchName,
      });
      await manager.stage(workspace, [relPath]);

      return { success: true, partial, staged: true };
    }),

  /**
   * Stages a subset of a text file's hunks.
   *
   * Stores the RESULTING CONTENT, not the hunk indices: indices drift as soon
   * as the worktree file changes again, whereas a snapshot stays meaningful
   * and gives the honest head/staged/worktree three-way view. This is why git
   * stores blobs rather than patches.
   */
  stageHunks: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        path: z.string(),
        hunkIndices: z.array(z.number().int().min(0)),
        branchName: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);
      const relPath = normalizeRelPath(input.path);

      if (
        isBinaryFile(
          relPath,
          await getBinaryExtensions(input.daemonId, workspace.repoId),
        )
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${relPath}" is binary and stages whole-file.`,
        });
      }

      const sides = await readHeadAndWorktree(
        input.daemonId,
        workspace,
        relPath,
      );
      if (!sides) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${relPath}" has no head revision to diff against.`,
        });
      }

      const hunks = computeHunks(sides.head, sides.worktree);
      const selected = new Set(input.hunkIndices);

      if (selected.size === 0) {
        // Selecting nothing is an unstage, not an empty stage.
        await clearStagedBlob(workspace.localPath, relPath);
        await manager.unstage(workspace, [relPath]);
        return { success: true, partial: false, staged: false };
      }

      const partial = !isFullySelected(hunks, selected);

      if (partial) {
        await writeStagedBlob(
          workspace.localPath,
          relPath,
          applyHunks(sides.head, sides.worktree, hunks, selected),
        );
      } else {
        // Fully staged needs no blob: the staged content IS the worktree
        // content, which submit already reads off disk.
        await clearStagedBlob(workspace.localPath, relPath);
      }

      // Partial staging still moves the claim, exactly as whole-file does.
      const client = await CreateApiClientAuth(input.daemonId);
      await client.file.checkout.mutate({
        repoId: workspace.repoId,
        workspaceId: workspace.id,
        filePath: relPath,
        branchName: input.branchName ?? workspace.domainBranchName,
      });
      await manager.stage(workspace, [relPath]);

      return { success: true, partial, staged: true };
    }),

  /**
   * Remove files from the staged set.
   *
   * Leaves their claims alone: unstaging says "not ready yet", not "I am done
   * with this file". Releasing a claim is `releaseClaim`.
   */
  unstage: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);

      const normalizedPaths = input.paths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      await manager.unstage(workspace, normalizedPaths);

      return { success: true, paths: normalizedPaths };
    }),

  /** Move already-staged files from one bucket to another. */
  moveToBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        paths: z.array(z.string()).min(1),
        branchName: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { manager, workspace } = resolveWorkspace(ctx, input);

      if (
        input.branchName !== workspace.domainBranchName &&
        !workspace.activeBranches.includes(input.branchName)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `"${input.branchName}" is not active in this workspace.`,
        });
      }

      const normalizedPaths = input.paths.map((p) =>
        p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
      );

      const client = await CreateApiClientAuth(input.daemonId);

      for (const relPath of normalizedPaths) {
        await client.file.checkout.mutate({
          repoId: workspace.repoId,
          workspaceId: workspace.id,
          filePath: relPath,
          branchName: input.branchName,
        });
      }

      // Already staged by definition, but make it idempotent so a move can
      // also pull an unstaged file into a bucket.
      await manager.stage(workspace, normalizedPaths);

      return {
        success: true,
        paths: normalizedPaths,
        branchName: input.branchName,
      };
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

  getClaimsForFiles: publicProcedure
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

      return client.file.getClaimsForFiles.mutate({
        repoId: workspace.repoId,
        filePaths: normalizedPaths,
        // Without this the server cannot resolve the caller's domain, and
        // every exclusive claim comes back blocking, including ones anchored
        // in a sibling domain that should be context rather than an obstacle.
        branchName: workspace.domainBranchName,
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
            // File exists in head: download head version and overwrite local
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
            await client.file.releaseClaim.mutate({
              repoId: workspace.repoId,
              workspaceId: workspace.id,
              filePath: normalizedPath,
            });
          } catch {
            // Not claimed, which is fine
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
