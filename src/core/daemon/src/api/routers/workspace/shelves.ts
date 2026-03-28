import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

export const shelvesRouter = router({
  list: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        status: z.enum(["ACTIVE", "SUBMITTED", "DELETED"]).optional(),
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

      const client = await CreateApiClientAuth(input.daemonId);
      return client.shelf.list.query({
        repoId: workspace.repoId,
        status: input.status,
      });
    }),

  get: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
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

      const client = await CreateApiClientAuth(input.daemonId);
      return client.shelf.get.query({
        repoId: workspace.repoId,
        name: input.name,
      });
    }),

  delete: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
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
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.shelf.delete.mutate({
        repoId: workspace.repoId,
        shelfName: input.name,
      });
    }),

  rename: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        name: z.string(),
        newName: z.string(),
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
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.shelf.rename.mutate({
        repoId: workspace.repoId,
        shelfName: input.name,
        newName: input.newName,
      });
    }),

  submitToBranch: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
        shelfName: z.string(),
        branchName: z.string(),
        message: z.string().optional(),
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
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Could not find workspace ID ${input.workspaceId}`,
        });
      }

      const client = await CreateApiClientAuth(input.daemonId);
      return client.shelf.submitToBranch.mutate({
        repoId: workspace.repoId,
        shelfName: input.shelfName,
        branchName: input.branchName,
        message: input.message,
      });
    }),
});
