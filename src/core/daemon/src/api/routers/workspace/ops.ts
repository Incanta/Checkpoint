import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { DaemonConfig } from "../../../daemon-config.js";
import { Logger } from "../../../logging.js";
import { createAndRegisterWorkspace } from "../../../util/workspace-create.js";

export const opsRouter = router({
  list: {
    local: publicProcedure
      .input(
        z.object({
          daemonId: z.string(),
        }),
      )
      .query(async ({ ctx, input }) => {
        const manager = ctx.manager;

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
      const workspace = await createAndRegisterWorkspace(ctx.manager, {
        ...input,
        reloadConfig: ctx.manager.ephemeral,
      });
      return { workspace };
    }),

  remove: publicProcedure
    .input(
      z.object({
        daemonId: z.string(),
        workspaceId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const manager = ctx.manager;

      // Stop watching and clear cached state
      manager.unlinkWorkspace(input.workspaceId, input.daemonId);

      // Remove from daemon.json
      const config = DaemonConfig.Ensure().vars;
      config.workspaces = config.workspaces.filter(
        (w) => w.id !== input.workspaceId,
      );
      await DaemonConfig.Save();

      Logger.info(
        `Workspace ${input.workspaceId} unlinked for daemon ${input.daemonId}`,
      );

      return { success: true };
    }),
});
