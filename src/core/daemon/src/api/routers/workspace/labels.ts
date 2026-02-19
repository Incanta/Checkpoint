import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { DaemonManager } from "../../../daemon-manager.js";

export const labelsRouter = router({
  create: publicProcedure
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

  list: publicProcedure
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

  delete: publicProcedure
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

  rename: publicProcedure
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

  changeChangelist: publicProcedure
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
});
