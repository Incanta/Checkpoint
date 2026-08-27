import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import {
  CreateApiClientAuth,
  type GameSyncBuildStep,
  type WorkspaceStateFile,
} from "@checkpointvcs/common";
import { getStateStore } from "./state-store.js";
import { DaemonConfigType } from "../daemon-config.js";

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

export type BisectVerdict = "pass" | "fail" | "include" | "exclude";

export interface AppliedArtifactInfo {
  /** The changelist the artifact set was attached at (Y). */
  changelistNumber: number;
  /** The source changelist the workspace was synced to when applied (X). */
  sourceChangelistNumber: number;
  /** ISO timestamp. */
  appliedAt: string;
  /**
   * Set when a local compile overwrote files from this set; forces the next
   * applyArtifacts to re-extract instead of skipping matching entries.
   */
  invalidatedByLocalBuild?: boolean;
}

export interface WorkspaceGameSyncState {
  /** Hash of the sync filter in effect for the files currently on disk. */
  syncFilterHash?: string;
  /** Last changelist a successful local build ran at (ForceClean boundaries). */
  lastBuiltChangelist?: number;
  /** Artifact type -> applied set info. */
  appliedArtifacts?: Record<string, AppliedArtifactInfo>;
  /** Changelist number -> bisect verdict. */
  bisect?: Record<number, BisectVerdict>;
  /** ISO timestamp of the last scheduled sync run. */
  lastScheduledSyncAt?: string;
}

export type ArtifactStateFile = WorkspaceStateFile & {
  /** Artifact channel the file came from (absent on legacy state: "editor"). */
  artifactType?: string;
};

export const WORKSPACE_STATE_VERSION = 2;

export interface WorkspaceState {
  /** State schema version; absent = 1. Current: WORKSPACE_STATE_VERSION. */
  version?: number;
  changelistNumber: number;
  files: Record<string, WorkspaceStateFile>; // path -> file info
  artifactFiles?: Record<string, ArtifactStateFile>; // path -> artifact file info
  /** Relative paths of files explicitly marked for add */
  markedForAdd?: string[];
  gameSync?: WorkspaceGameSyncState;
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
   * Used to guard resolveConflicts against stale conflict data: if the remote
   * head has moved since this value was recorded, resolve is rejected.
   */
  lastSyncStatusRemoteHead?: number | null;
  gameSync?: WorkspaceGameSyncSettings;
}

export interface WorkspaceScheduledSyncSettings {
  enabled: boolean;
  /** Local time of day, "HH:MM". */
  timeOfDay: string;
  target: "latest" | "latest-good" | "latest-starred";
}

export interface WorkspaceGameSyncSettings {
  /** Category id -> enabled override vs the repo config default. */
  categoryOverrides?: Record<string, boolean>;
  /** Ordered gitignore-style rules applied after category rules. */
  customIncludeRules?: string[];
  customExcludeRules?: string[];
  /** Preset name from repo config, if one is applied. */
  preset?: string | null;
  usePrecompiledBinaries?: boolean;
  /** Artifact channels to apply when usePrecompiledBinaries is on. */
  artifactTypes?: string[];
  /** Repo-relative .uproject path when the workspace holds several. */
  selectedProject?: string;
  editorConfiguration?: string;
  /** Opt-in: write the synced CL into Engine/Build/Build.version after syncs. */
  writeVersionFiles?: boolean;
  afterSync?: {
    build?: boolean;
    generateProjectFiles?: boolean;
    runEditor?: boolean;
    openSolution?: boolean;
  };
  /** Step id -> enabled override for repo-config and default steps. */
  buildStepOverrides?: Record<string, { enabled?: boolean }>;
  /** User-defined steps, merged after repo config steps. */
  customBuildSteps?: GameSyncBuildStep[];
  scheduledSync?: WorkspaceScheduledSyncSettings;
  lastScheduledSyncResult?: {
    at: string;
    target: string;
    changelistNumber: number | null;
    status: "success" | "failed" | "skipped";
    error?: string;
  };
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
  backend?: DaemonConfigType["stateBackend"],
): Promise<WorkspaceState> {
  const store = getStateStore(localPath, backend);
  return store.load();
}

export async function saveWorkspaceState(
  workspace: Workspace,
  state: WorkspaceState,
  backend?: DaemonConfigType["stateBackend"],
): Promise<void> {
  const workspaceConfigDir = path.join(workspace.localPath, ".checkpoint");

  try {
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    const store = getStateStore(workspace.localPath, backend);
    await store.save(state);

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
