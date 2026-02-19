import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "../../../daemon-manager.js";
import { readFileFromChangelist } from "../../../util/index.js";

export const historyRouter = router({
  get: publicProcedure
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

  file: publicProcedure
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

  fileDiff: publicProcedure
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
});
