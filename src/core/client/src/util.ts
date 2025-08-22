import config from "@incanta/config";
import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import os from "os";
import { CreateApiClient } from "@checkpointvcs/common";

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
      "Could not find a Checkpoint workspace; run this from a child directory of an initialized workspace."
    );
    process.exit(1);
  }

  const checkpointDir = path.join(...dirParts);
  return checkpointDir;
}

export async function exec(
  command: string,
  cwd: string | null = null
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

export async function getAuthToken(): Promise<string> {
  try {
    const auth = await fs.readFile(
      path.join(os.homedir(), ".config", "checkpoint", "auth.json"),
      "utf-8"
    );
    return JSON.parse(auth).access_token;
  } catch (e) {
    console.error("Could not read authentication token; please login");
    process.exit(1);
  }
}

export interface WorkspaceState {
  changelistNumber: number;
  files: Record<string, number>;
}

export interface WorkspaceConfig {
  orgId: string;
  repoId: string;
  branchName: string;
  workspaceName: string;
}

export interface Workspace extends WorkspaceConfig {
  localRoot: string;
}

export async function getWorkspaceDetails(): Promise<Workspace> {
  const workspace = await getWorkspaceRoot(process.cwd());
  const workspaceConfigDir = path.join(workspace, ".checkpoint");

  const configPath = path.join(workspaceConfigDir, "config.json");
  try {
    const config = await fs.readFile(configPath, "utf-8");
    const details: Workspace = JSON.parse(config);
    details.localRoot = workspace;
    return details;
  } catch (e) {
    throw new Error(
      "Could not read workspace configuration, did you initialize this workspace properly?"
    );
  }
}

export async function saveWorkspaceDetails(
  workspace: WorkspaceConfig
): Promise<void> {
  const workspaceRoot = await getWorkspaceRoot(process.cwd());
  const workspaceConfigDir = path.join(workspaceRoot, ".checkpoint");

  try {
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceConfigDir, "config.json"),
      JSON.stringify(workspace, null, 2)
    );
  } catch (e) {
    throw new Error(
      "Could not write workspace configuration, did you initialize this workspace properly?"
    );
  }
}

export async function getWorkspaceState(): Promise<WorkspaceState> {
  const workspace = await getWorkspaceRoot(process.cwd());
  const workspaceConfigDir = path.join(workspace, ".checkpoint");

  const statePath = path.join(workspaceConfigDir, "state.json");
  try {
    const state = await fs.readFile(statePath, "utf-8");
    return JSON.parse(state);
  } catch (e) {
    return {
      changelistNumber: 0,
      files: {},
    };
  }
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  const workspace = await getWorkspaceRoot(process.cwd());
  const workspaceConfigDir = path.join(workspace, ".checkpoint");

  try {
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(workspaceConfigDir, "state.json"),
      JSON.stringify(state, null, 2)
    );
  } catch (e) {
    throw new Error(
      "Could not write workspace state, did you initialize this workspace properly?"
    );
  }
}

export async function getLatestChangelistId(
  workspace: Workspace
): Promise<string> {
  const apiToken = await getAuthToken();

    const client = CreateApiClient();

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
  changelistNumber: number
): Promise<string> {
  const apiToken = await getAuthToken();

  const client = CreateApiClient();

  const changelists = await client.changelist.getChangelists.query({
    repoId: workspace.repoId,
    numbers: [changelistNumber],
  });

  if (!changelists || changelists.length === 0) {
    throw new Error("Could not get changelist ID");
  }

  return changelists[0]!.id;
}
