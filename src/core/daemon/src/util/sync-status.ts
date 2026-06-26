import { CreateApiClientAuth } from "@checkpointvcs/common";
import { getWorkspaceState, type Workspace } from "./util.js";
import { getBinaryExtensions, isBinaryFile } from "./binary-extensions.js";
import { DaemonConfig } from "../daemon-config.js";

/**
 * Represents a file that is outdated (remote has a newer version).
 */
export interface OutdatedFile {
  /** File ID on the server */
  fileId: string;
  /** Relative file path in the workspace */
  path: string;
  /** The CL number the local workspace has for this file */
  localChangelist: number;
  /** The latest CL number on the server for this file */
  remoteChangelist: number;
}

/**
 * Represents a file that conflicts between local changes and remote changes.
 * A conflict occurs when a file has been modified locally AND has a newer
 * version on the remote.
 */
export interface ConflictedFile {
  /** File ID on the server */
  fileId: string;
  /** Relative file path in the workspace */
  path: string;
  /** The CL number the local workspace has for this file */
  localChangelist: number;
  /** The latest CL number on the server for this file */
  remoteChangelist: number;
}

/**
 * Result of checking the sync status of a workspace against the remote.
 */
export interface SyncStatus {
  /** Whether the workspace is fully up to date */
  upToDate: boolean;
  /** The local workspace's current CL number */
  localChangelistNumber: number;
  /** The remote branch head CL number */
  remoteHeadNumber: number;
  /** Number of changelists behind the remote head */
  changelistsBehind: number;
  /** CL numbers that need to be pulled */
  changelistsToPull: number[];
  /** Files that are outdated (remote has newer version) */
  outdatedFiles: OutdatedFile[];
  /** Files that have been deleted on the remote but still exist locally */
  deletedOnRemote: string[];
  /** Files that are new on the remote */
  newOnRemote: string[];
  /** Timestamp of when this check was performed */
  checkedAt: Date;
}

/**
 * Result of detecting conflicts between local changes and remote changes.
 */
export interface ConflictCheckResult {
  /** Whether there are any conflicts */
  hasConflicts: boolean;
  /** Files that conflict (modified locally AND updated remotely) */
  conflicts: ConflictedFile[];
}

/**
 * Check the sync status of a workspace by comparing local state against
 * the remote branch head.
 */
export async function checkSyncStatus(
  workspace: Workspace,
): Promise<SyncStatus> {
  const client = await CreateApiClientAuth(workspace.daemonId);
  const daemonConfig = await DaemonConfig.Get();
  const workspaceState = await getWorkspaceState(
    workspace.localPath,
    daemonConfig.stateBackend,
  );

  // Get branch head info
  const branchResponse = await client.branch.getBranch.query({
    repoId: workspace.repoId,
    name: workspace.branchName,
  });

  if (!branchResponse) {
    throw new Error("Could not get branch information");
  }

  const remoteHeadNumber = branchResponse.headNumber;
  const localChangelistNumber = workspaceState.changelistNumber;

  // If already at head, no diff needed
  if (localChangelistNumber === remoteHeadNumber) {
    return {
      upToDate: true,
      localChangelistNumber,
      remoteHeadNumber,
      changelistsBehind: 0,
      changelistsToPull: [],
      outdatedFiles: [],
      deletedOnRemote: [],
      newOnRemote: [],
      checkedAt: new Date(),
    };
  }

  // Ask the server for the path-keyed diff between our base and the head. This
  // returns only the changed paths (and the source CLs to pull), not the whole
  // state tree, and needs no fileId resolution.
  const diff = await client.changelist.diffChangelists.query({
    repoId: workspace.repoId,
    fromNumber: localChangelistNumber,
    toNumber: remoteHeadNumber,
  });

  // Modified files: present locally with a newer version on the server.
  const outdatedFiles: OutdatedFile[] = diff.modified.map((change) => {
    const local = workspaceState.files[change.path];
    return {
      fileId: change.fileId,
      path: change.path,
      localChangelist: local?.changelist ?? localChangelistNumber,
      remoteChangelist: change.cl,
    };
  });

  // New on remote: paths come straight from the diff (no getFiles round-trip).
  const newOnRemote = diff.added.map((change) => change.path);

  // Deleted on remote: only those we actually have locally need removing.
  const deletedOnRemote = diff.removed.filter(
    (path) => workspaceState.files[path] !== undefined,
  );

  return {
    upToDate: false,
    localChangelistNumber,
    remoteHeadNumber,
    changelistsBehind: diff.changelistsToPull.length,
    changelistsToPull: diff.changelistsToPull,
    outdatedFiles,
    deletedOnRemote,
    newOnRemote,
    checkedAt: new Date(),
  };
}

/**
 * Check for conflicts between locally modified files and remote changes.
 * A conflict occurs when a file that has been modified locally also has
 * a newer version on the remote.
 *
 * @param workspace - The workspace to check
 * @param locallyModifiedPaths - Relative paths of files that have been modified locally
 * @param syncStatus - Optional pre-computed sync status to avoid re-fetching
 */
export async function checkConflicts(
  workspace: Workspace,
  locallyModifiedPaths: string[],
  syncStatus?: SyncStatus,
): Promise<ConflictCheckResult> {
  const status = syncStatus ?? (await checkSyncStatus(workspace));

  if (status.upToDate) {
    return { hasConflicts: false, conflicts: [] };
  }

  // Build set of locally modified paths for quick lookup
  const modifiedSet = new Set(
    locallyModifiedPaths.map((p) =>
      p.replace(/^[/\\]/, "").replace(/\\/g, "/"),
    ),
  );

  const binaryExts = await getBinaryExtensions(
    workspace.daemonId,
    workspace.repoId,
  );

  const conflicts: ConflictedFile[] = [];

  // Check if any outdated files are also locally modified
  // Only binary files are reported as conflicts — text files will be auto-merged during pull
  for (const outdated of status.outdatedFiles) {
    const normalizedPath = outdated.path
      .replace(/^[/\\]/, "")
      .replace(/\\/g, "/");
    if (
      modifiedSet.has(normalizedPath) &&
      isBinaryFile(normalizedPath, binaryExts)
    ) {
      conflicts.push({
        fileId: outdated.fileId,
        path: normalizedPath,
        localChangelist: outdated.localChangelist,
        remoteChangelist: outdated.remoteChangelist,
      });
    }
  }

  // Files deleted on remote that are modified locally are also conflicts
  // (both binary and text — deletion conflicts can't be auto-merged)
  for (const deletedPath of status.deletedOnRemote) {
    const normalizedPath = deletedPath
      .replace(/^[/\\]/, "")
      .replace(/\\/g, "/");
    if (modifiedSet.has(normalizedPath)) {
      conflicts.push({
        fileId: "",
        path: normalizedPath,
        localChangelist: status.localChangelistNumber,
        remoteChangelist: -1, // Indicates deletion
      });
    }
  }

  return {
    hasConflicts: conflicts.length > 0,
    conflicts,
  };
}
