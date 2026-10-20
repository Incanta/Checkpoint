import { exec as nativeExec } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";
import {
  CreateApiClientAuth,
  type TeamSyncBuildStep,
  type WorkspaceStateFile,
} from "@checkpointvcs/common";
import {
  applyWorkspaceDelta,
  loadWorkspaceState,
  replaceWorkspaceState,
} from "./state-store.js";
import type { StateDelta } from "./state-delta.js";
import { stampBaselines } from "./baseline.js";
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

export interface WorkspaceTeamSyncState {
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

export const WORKSPACE_STATE_VERSION = 5;

export interface WorkspaceState {
  /** State schema version; absent = 1. Current: WORKSPACE_STATE_VERSION. */
  version?: number;
  /**
   * The changelist the tree is materialized at on its domain root.
   *
   * A workspace with feature branches overlaid is not "at" one changelist, so
   * this is the domain-root component and `branchHeads` carries the rest. The
   * field keeps its old name so v2 state files load unchanged: before overlays
   * existed, the workspace's branch was its domain root and this was the whole
   * answer.
   */
  changelistNumber: number;
  /**
   * branchName -> last synced head, for each overlaid feature branch. Empty or
   * absent means no overlay, which is a workspace working directly on its
   * domain root.
   */
  branchHeads?: Record<string, number>;
  files: Record<string, WorkspaceStateFile>; // path -> file info
  artifactFiles?: Record<string, ArtifactStateFile>; // path -> artifact file info
  /** Relative paths of files explicitly marked for add */
  markedForAdd?: string[];
  /**
   * Relative paths staged for the next submit.
   *
   * Distinct from `markedForAdd`, which promotes an untracked file to
   * `Added` status. This is git's index: whether a change is ready to go into
   * its branch's next changelist. A file can be marked for add and unstaged,
   * or staged without ever being marked (the ordinary modified-file case).
   *
   * Which branch a staged file goes to is not stored here. That comes from
   * the file's `FileClaim.branchName` on the server, so the two cannot drift.
   */
  staged?: string[];
  /**
   * Tracked files the server deleted that a pull could not remove (open in
   * another program, say). They stay tracked, so they never look like
   * untracked files to add back, and the next pull tries again.
   */
  pendingRemovals?: string[];
  /**
   * Directories the tree renamed by case or normalization only that a pull
   * could not rename on disk (a file inside was open, say), by their new
   * spelling. Until the next pull manages it, the scan takes the old spelling
   * on disk for this one rather than for a rename the user made.
   */
  pendingDirRenames?: string[];
  /**
   * File modes to submit that the file on disk cannot carry: set with
   * `pending.setExecutable` on Windows, which has no executable bit. A file
   * whose mode here differs from its baseline's shows as modified, and its
   * next submit sends this mode. Never set on Linux or macOS, where the
   * command changes the file itself.
   */
  pendingModes?: Record<string, number>;
  /**
   * A pull that started writing to the workspace and has not finished: set
   * before its first write, cleared in the same transaction that records
   * what it wrote. Still here when the daemon starts means the pull died
   * partway (a crash, a reboot), and the local edits it backed up are put
   * back from `backupRoot` (see recoverInterruptedPull). Submits are refused
   * until a pull completes, since the files it wrote before dying look like
   * local edits against the old baselines.
   */
  interruptedPull?: InterruptedPull;
  teamSync?: WorkspaceTeamSyncState;
}

export interface InterruptedPull {
  /** The changelist the pull was bringing the workspace to. */
  changelist: number;
  /** The pull's backup folder; its journal lists what it backed up. */
  backupRoot: string;
  /** The process that ran the pull, so a live one is not recovered under. */
  pid: number;
  startedAt: string;
  /** Set once the backups have been put back. */
  restoredAt?: string;
}

export interface WorkspaceConfig {
  id: string;
  repoId: string;
  /**
   * The domain-root branch this workspace's tree is materialized from: a
   * mainline or release branch, never a feature branch.
   *
   * Was `branchName` before multi-branch workspaces. `readWorkspaceConfig`
   * migrates the old key on load, so v1 config files keep working: the branch
   * a workspace was pinned to becomes its domain root, which is correct
   * whenever that branch was a mainline or release branch, and is repaired
   * against the server otherwise.
   */
  domainBranchName: string;
  /**
   * Feature branches overlaid on the tree, applied ancestor-first.
   *
   * Empty is the ordinary case and means working directly on the domain root.
   * A stacked branch cannot be overlaid alone, so this always holds complete
   * ancestor chains rather than an arbitrary set.
   */
  activeBranches?: string[];
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
  teamSync?: WorkspaceTeamSyncSettings;
}

export interface WorkspaceScheduledSyncSettings {
  enabled: boolean;
  /** Local time of day, "HH:MM". */
  timeOfDay: string;
  target: "latest" | "latest-good" | "latest-starred";
}

export interface WorkspaceTeamSyncSettings {
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
  customBuildSteps?: TeamSyncBuildStep[];
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
    return migrateWorkspaceConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Brings a workspace.json forward to the current shape.
 *
 * Pre-overlay configs carried a single `branchName`. That branch becomes the
 * domain root with no overlays, which is exactly what the workspace was doing.
 * If it was actually a feature branch, the daemon repairs it against the server
 * on connect (see `reportBranchState`), because only the server knows which
 * branch anchors the domain.
 */
export function migrateWorkspaceConfig(
  raw: Workspace & { branchName?: string },
): Workspace {
  if (!raw.domainBranchName && raw.branchName) {
    raw.domainBranchName = raw.branchName;
  }

  delete raw.branchName;
  raw.activeBranches ??= [];

  return raw;
}

/**
 * Write workspace.json to disk (without touching state.json).
 */
export async function saveWorkspaceConfig(workspace: Workspace): Promise<void> {
  const workspaceConfigDir = path.join(workspace.localPath, ".checkpoint");
  await fs.mkdir(workspaceConfigDir, { recursive: true });
  // Write beside the file and rename over it, so a crash partway through
  // leaves the previous config rather than a truncated one. A workspace.json
  // that cannot be parsed reads as "not a workspace".
  const configPath = path.join(workspaceConfigDir, "workspace.json");
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(workspace, null, 2));
    await fs.rename(tmpPath, configPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true });
    throw err;
  }
}

/**
 * The workspace's tracked-file state. The returned object is shared by every
 * caller in the process: read it, but change state only through
 * {@link updateWorkspaceState}.
 */
export async function getWorkspaceState(
  localPath: string,
  backend?: DaemonConfigType["stateBackend"],
): Promise<WorkspaceState> {
  return loadWorkspaceState(localPath, backend);
}

/**
 * Records a change to the workspace's state, writing only what `delta`
 * changes. See {@link StateDelta}.
 */
export async function updateWorkspaceState(
  workspace: Pick<Workspace, "localPath">,
  delta: StateDelta,
  backend?: DaemonConfigType["stateBackend"],
): Promise<void> {
  // Each baseline recorded here gets the time it was recorded, so change
  // detection can tell a racily clean file from an unchanged one.
  if (delta.files?.upsert || delta.files?.replaceAll) {
    delta = { ...delta, files: { ...delta.files } };
    if (delta.files!.upsert) {
      delta.files!.upsert = { ...delta.files!.upsert };
      await stampBaselines(workspace.localPath, delta.files!.upsert);
    }
    if (delta.files!.replaceAll) {
      delta.files!.replaceAll = { ...delta.files!.replaceAll };
      await stampBaselines(workspace.localPath, delta.files!.replaceAll);
    }
  }
  try {
    await applyWorkspaceDelta(workspace.localPath, delta, backend);
  } catch (e) {
    throw new Error(
      `Could not write workspace state, did you initialize this workspace properly? (${
        (e as Error)?.message ?? e
      })`,
    );
  }
}

/**
 * Writes the workspace's tracked-file state. It does not touch
 * workspace.json: callers hand over whatever workspace object they hold,
 * which is often the daemon.json entry or a hand-built one without the
 * workspace's teamSync settings, so rewriting the config from it lost them.
 * Config changes go through {@link saveWorkspaceConfig}.
 */
export async function saveWorkspaceState(
  workspace: Pick<Workspace, "localPath">,
  state: WorkspaceState,
  backend?: DaemonConfigType["stateBackend"],
): Promise<void> {
  const workspaceConfigDir = path.join(workspace.localPath, ".checkpoint");

  try {
    await fs.mkdir(workspaceConfigDir, { recursive: true });
    await replaceWorkspaceState(workspace.localPath, state, backend);
  } catch (e) {
    throw new Error(
      `Could not write workspace state, did you initialize this workspace properly? (${
        (e as Error)?.message ?? e
      })`,
    );
  }
}

/**
 * The branch whose head a workspace syncs: the deepest active feature branch,
 * whose head holds its parents' changes too, or the domain root when none is
 * active. Every pull, sync status, and pre-submit check targets it; one that
 * looked at the domain root would take an active branch's changes back out of
 * the workspace (DL-10).
 */
export function syncTargetBranch(
  workspace: Pick<WorkspaceConfig, "domainBranchName" | "activeBranches">,
): string {
  const active = workspace.activeBranches ?? [];
  return active.length > 0
    ? active[active.length - 1]!
    : workspace.domainBranchName;
}

/**
 * Walks a feature branch up to its domain root, returning the chain in
 * ancestor-first order.
 *
 * Overlays are applied in this order, and a stacked branch is meaningless
 * without the branches beneath it, so activation always takes the whole chain
 * rather than a single name. It is also the only set of branches a workspace
 * may have active: two siblings have no one head that holds both, so there
 * would be nothing to sync or to check a submit's bases against.
 */
export async function resolveBranchChain(
  client: Awaited<ReturnType<typeof CreateApiClientAuth>>,
  repoId: string,
  branchName: string,
): Promise<string[]> {
  const chain: string[] = [];
  let current: string | null = branchName;

  for (let hops = 0; hops < 64 && current; hops++) {
    const branch = await client.branch.getBranch.query({
      repoId,
      name: current,
    });

    if (!branch || branch.isClaimDomainRoot) {
      break;
    }

    chain.unshift(branch.name);
    current = branch.parentBranchName;
  }

  return chain;
}

export async function getLatestChangelistId(
  workspace: Workspace,
): Promise<string> {
  const client = await CreateApiClientAuth(workspace.daemonId);

  const branch = await client.branch.getBranch.query({
    repoId: workspace.repoId,
    name: syncTargetBranch(workspace),
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
    branchName: syncTargetBranch(workspace),
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
