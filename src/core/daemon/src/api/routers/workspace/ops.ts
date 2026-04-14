import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Workspace } from "../../../types/index.js";
import { DaemonConfig } from "../../../daemon-config.js";
import { saveWorkspaceConfig } from "../../../util/util.js";
import { Logger } from "../../../logging.js";

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

      // Write .checkpoint/workspace.json so CLI and other tools can discover the workspace
      await saveWorkspaceConfig({
        id: newWorkspace.id,
        repoId: newWorkspace.repoId,
        branchName: newWorkspace.branchName,
        workspaceName: newWorkspace.name,
        localPath: newWorkspace.localPath,
        daemonId: newWorkspace.daemonId,
      });

      const manager = ctx.manager;
      const existingWorkspaces = manager.workspaces.get(input.daemonId) || [];
      existingWorkspaces.push(newWorkspace);
      manager.workspaces.set(input.daemonId, existingWorkspaces);
      manager.watchWorkspace(newWorkspace);

      return { workspace: newWorkspace };
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
