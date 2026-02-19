import { CreateApiClientAuth, DiffState } from "@checkpointvcs/common";
import { getWorkspaceState, type Workspace } from "./util.js";
import { isBinaryFile } from "./read-file.js";

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
  const workspaceState = await getWorkspaceState(workspace.localPath);

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

  // Get the head changelist's full state tree
  const changelistResponse = await client.changelist.getChangelist.query({
    repoId: workspace.repoId,
    changelistNumber: remoteHeadNumber,
  });

  if (!changelistResponse) {
    throw new Error("Could not get changelist information");
  }

  const serverStateTree = changelistResponse.stateTree as Record<
    string,
    number
  >;

  // Diff local state against server state
  const diff = DiffState(workspaceState.files, serverStateTree);

  // Build a map of fileId -> path from local state for lookups
  const localFileIdToPath = new Map<string, string>();
  const localFileIdToChangelist = new Map<string, number>();
  for (const [filePath, file] of Object.entries(workspaceState.files)) {
    localFileIdToPath.set(file.fileId, filePath);
    localFileIdToChangelist.set(file.fileId, file.changelist);
  }

  // Get file info for outdated and new files
  const outdatedFiles: OutdatedFile[] = [];
  const newOnRemote: string[] = [];

  // Find outdated files (exist locally but have newer CL on server)
  for (const [fileId, serverCl] of Object.entries(serverStateTree)) {
    const localCl = localFileIdToChangelist.get(fileId);
    if (localCl !== undefined && localCl !== serverCl) {
      const filePath = localFileIdToPath.get(fileId) ?? fileId;
      outdatedFiles.push({
        fileId,
        path: filePath,
        localChangelist: localCl,
        remoteChangelist: serverCl,
      });
    } else if (localCl === undefined) {
      // File is new on remote - we'll resolve the path later
      newOnRemote.push(fileId);
    }
  }

  // Find files deleted on remote
  const deletedOnRemote: string[] = [];
  for (const fileId of diff.deletions) {
    const filePath = localFileIdToPath.get(fileId);
    if (filePath) {
      deletedOnRemote.push(filePath);
    }
  }

  // Resolve paths for new-on-remote files
  const resolvedNewOnRemote: string[] = [];
  if (newOnRemote.length > 0) {
    try {
      const filesResponse = await client.file.getFiles.query({
        ids: newOnRemote,
        repoId: workspace.repoId,
      });
      for (const file of filesResponse) {
        if (file.path) {
          resolvedNewOnRemote.push(
            file.path.replace(/^\//, "").replace(/\\/g, "/"),
          );
        }
      }
    } catch {
      // If we can't resolve paths, just use the file IDs
      resolvedNewOnRemote.push(...newOnRemote);
    }
  }

  return {
    upToDate: false,
    localChangelistNumber,
    remoteHeadNumber,
    changelistsBehind: diff.changelistsToPull.length,
    changelistsToPull: diff.changelistsToPull,
    outdatedFiles,
    deletedOnRemote,
    newOnRemote: resolvedNewOnRemote,
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

  const conflicts: ConflictedFile[] = [];

  // Check if any outdated files are also locally modified
  // Only binary files are reported as conflicts — text files will be auto-merged during pull
  for (const outdated of status.outdatedFiles) {
    const normalizedPath = outdated.path
      .replace(/^[/\\]/, "")
      .replace(/\\/g, "/");
    if (modifiedSet.has(normalizedPath) && isBinaryFile(normalizedPath)) {
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
