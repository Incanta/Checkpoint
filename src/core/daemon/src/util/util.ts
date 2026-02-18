import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import {
  CreateApiClientAuth,
  type WorkspaceStateFile,
} from "@checkpointvcs/common";

export function relativePath(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, "/");
}

export async function getWorkspaceRoot(directory: string): Promise<string> {
  // find the .checkpoint directory in any parent directory
  const dirParts = directory.split(path.sep);
  while (dirParts.length > 0) {
    try {
      await fs.stat(path.join(...dirParts, ".checkpoint"));
      break;
    } catch (e) {
      dirParts.pop();
    }
  }

  if (dirParts.length === 0) {
    console.error(
      "Could not find a Checkpoint workspace; run this from a child directory of an initialized workspace.",
    );
    process.exit(1);
  }

  const checkpointDir = path.join(...dirParts);
  return checkpointDir;
}

export async function exec(
  command: string,
  cwd: string | null = null,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const exec = promisify(nativeExec);
  let result: { stdout: string; stderr: string; code: number } = {
    stdout: "",
    stderr: "",
    code: 0,
  };

  try {
    const r = await exec(command, {
      cwd: cwd || process.cwd(),
    });
    result = { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (e: any) {
    result.code = e.code;
  }

  return result;
}

export interface WorkspaceState {
  changelistNumber: number;
  files: Record<string, WorkspaceStateFile>; // path -> file info
  /** Relative paths of files explicitly marked for add */
  markedForAdd?: string[];
}

export interface WorkspaceConfig {
  id: string;
  repoId: string;
  branchName: string;
  workspaceName: string;
  /**
   * Controls whether the "mark as resolved" confirmation dialog is suppressed.
   * - undefined/null: always show the confirmation
   * - ISO date string: suppressed until end of that day ("today" option)
   * - "workspace": suppressed permanently for this workspace
   */
  suppressResolveConfirmUntil?: string | null;
  /**
   * The remote branch head CL number that was last checked during sync status.
   * Used to guard resolveConflicts against stale conflict data — if the remote
   * head has moved since this value was recorded, resolve is rejected.
   */
  lastSyncStatusRemoteHead?: number | null;
}

export interface Workspace extends WorkspaceConfig {
  localPath: string;
  daemonId: string;
}

/**
 * Read workspace.json from disk.
 */
export async function getWorkspaceConfig(
  localPath: string,
): Promise<Workspace | null> {
  const workspaceConfigDir = path.join(localPath, ".checkpoint");
  const configPath = path.join(workspaceConfigDir, "workspace.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write workspace.json to disk (without touching state.json).
 */
export async function saveWorkspaceConfig(workspace: Workspace): Promise<void> {
  const workspaceConfigDir = path.join(workspace.localPath, ".checkpoint");
  await fs.mkdir(workspaceConfigDir, { recursive: true });
  await fs.writeFile(
    path.join(workspaceConfigDir, "workspace.json"),
    JSON.stringify(workspace, null, 2),
  );
}

export async function getWorkspaceState(
  localPath: string,
): Promise<WorkspaceState> {
  const workspaceConfigDir = path.join(localPath, ".checkpoint");

  const statePath = path.join(workspaceConfigDir, "state.json");
  try {
    const state = await fs.readFile(statePath, "utf-8");
    return JSON.parse(state);
  } catch (e) {
    return {
      changelistNumber: 0,
      files: {},
      markedForAdd: [],
    };
  }
}

export async function saveWorkspaceState(
  workspace: Workspace,
  state: WorkspaceState,
): Promise<void> {
  const workspaceConfigDir = path.join(workspace.localPath, ".checkpoint");

  try {
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceConfigDir, "state.json"),
      JSON.stringify(state, null, 2),
    );

    await saveWorkspaceConfig(workspace);
  } catch (e) {
    throw new Error(
      "Could not write workspace state, did you initialize this workspace properly?",
    );
  }
}

export async function getLatestChangelistId(
  workspace: Workspace,
): Promise<string> {
  const client = await CreateApiClientAuth(workspace.daemonId);

  const branch = await client.branch.getBranch.query({
    repoId: workspace.repoId,
    name: workspace.branchName,
  });

  if (!branch) {
    throw new Error("Could not get latest changelist number");
  }

  const changelistNumber = branch.headNumber;

  return getChangelistId(workspace, changelistNumber);
}

export async function getChangelistId(
  workspace: Workspace,
  changelistNumber: number,
): Promise<string> {
  const client = await CreateApiClientAuth(workspace.daemonId);

  const changelists = await client.changelist.getChangelists.query({
    repoId: workspace.repoId,
    branchName: workspace.branchName,
    start: {
      number: changelistNumber,
      timestamp: null,
    },
    count: 1,
  });

  if (!changelists || changelists.length === 0) {
    throw new Error("Could not get changelist ID");
  }

  return changelists[0]!.id;
}
