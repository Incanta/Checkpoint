import { CreateApiClientAuth } from "@checkpointvcs/common";

import type { Workspace } from "../types/index.js";
import { DaemonConfig } from "../daemon-config.js";
import { saveWorkspaceConfig } from "./util.js";

/** The part of the daemon manager creating a workspace needs. */
export interface WorkspaceRegistrar {
  registerWorkspace(workspace: Workspace): Promise<void>;
}

/**
 * Creates a workspace on the server, records it in the daemon config and its
 * own `.checkpoint/workspace.json`, and registers it with the manager. Shared
 * by workspace creation, Team Sync's "create a linked workspace", and the
 * child workspaces of nested linked repos.
 */
export async function createAndRegisterWorkspace(
  manager: WorkspaceRegistrar,
  input: {
    daemonId: string;
    name: string;
    repoId: string;
    path: string;
    defaultBranchName: string;
    /**
     * Re-read the daemon config before adding to it. An ephemeral daemon
     * loaded it at start, and a resident daemon may have saved since.
     */
    reloadConfig?: boolean;
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

  if (input.reloadConfig) await DaemonConfig.Load();
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
