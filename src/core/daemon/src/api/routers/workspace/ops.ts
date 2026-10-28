import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Workspace } from "../../../types/index.js";
import { DaemonConfig } from "../../../daemon-config.js";
import { saveWorkspaceConfig } from "../../../util/util.js";
import { Logger } from "../../../logging.js";
import type { DaemonManager } from "../../../daemon-manager.js";

/**
 * Creates a workspace on the server, records it in the daemon config and its
 * own `.checkpoint/workspace.json`, and registers it with the manager. Shared
 * by workspace creation and Team Sync's "create a linked workspace".
 */
export async function createAndRegisterWorkspace(
  manager: DaemonManager,
  input: {
    daemonId: string;
    name: string;
    repoId: string;
    path: string;
    defaultBranchName: string;
  },
): Promise<Workspace> {
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
    domainBranchName: input.defaultBranchName,
    activeBranches: [],
  };

  DaemonConfig.Ensure().vars.workspaces.push(newWorkspace);
  await DaemonConfig.Save();

  // Write .checkpoint/workspace.json so CLI and other tools can discover the workspace
  await saveWorkspaceConfig({
    id: newWorkspace.id,
    repoId: newWorkspace.repoId,
    domainBranchName: newWorkspace.domainBranchName,
    activeBranches: [],
    workspaceName: newWorkspace.name,
    localPath: newWorkspace.localPath,
    daemonId: newWorkspace.daemonId,
  });

  // Registering (rather than pushing onto manager.workspaces directly)
  // loads the baseline state and scans the working tree for .chkignore /
  // .chkhidden, so a brand-new workspace honours its ignore rules
  // immediately instead of only after the next daemon restart.
  await manager.registerWorkspace(newWorkspace);

  return newWorkspace;
}

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
      const workspace = await createAndRegisterWorkspace(ctx.manager, input);
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
