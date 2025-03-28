import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import os from "os";

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

export interface Workspace {
  orgId: string;
  repoId: string;
  workspaceId: string;
  workspaceName: string;
}

export async function getWorkspaceDetails(): Promise<Workspace> {
  const workspace = await getWorkspaceRoot(process.cwd());
  const workspaceConfigDir = path.join(workspace, ".checkpoint");

  const configPath = path.join(workspaceConfigDir, "config.json");
  try {
    const config = await fs.readFile(configPath, "utf-8");
    return JSON.parse(config);
  } catch (e) {
    throw new Error(
      "Could not read workspace configuration, did you initialize this workspace properly?"
    );
  }
}
