import { publicProcedure, router } from "../../trpc.js";
import { CreateApiClientAuth } from "@checkpointvcs/common";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { Workspace } from "../../../types/index.js";
import { DaemonConfig } from "../../../daemon-config.js";

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
      const configDir = path.join(newWorkspace.localPath, ".checkpoint");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "workspace.json"),
        JSON.stringify(
          {
            id: newWorkspace.id,
            repoId: newWorkspace.repoId,
            branchName: newWorkspace.branchName,
            workspaceName: newWorkspace.name,
            localPath: newWorkspace.localPath,
            daemonId: newWorkspace.daemonId,
          },
          null,
          2,
        ),
      );

      const manager = ctx.manager;
      const existingWorkspaces = manager.workspaces.get(input.daemonId) || [];
      existingWorkspaces.push(newWorkspace);
      manager.workspaces.set(input.daemonId, existingWorkspaces);
      manager.watchWorkspace(newWorkspace);

      return { workspace: newWorkspace };
    }),
});
