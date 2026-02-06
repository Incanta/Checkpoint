import type { WorkspaceStateFile } from "@checkpointvcs/client";

export interface StateDiff {
  timestamp: Date;
  deletions: string[];
  changelistsToPull: number[];
}

/**
 * Compares local workspace state against the server's state tree to determine
 * what needs to be pulled and what has been deleted.
 *
 * @param localFiles - Local state: Record<path, WorkspaceStateFile>
 * @param serverStateTree - Server state tree: Record<fileId, changelistNumber>
 * @returns Diff containing deletions (fileIds) and changelists to pull
 */
export function DiffState(
  localFiles: Record<string, WorkspaceStateFile>,
  serverStateTree: Record<string, number>,
): StateDiff {
  const deletions: string[] = [];
  const changelistsToPull: number[] = [];

  // Build a map of fileId -> changelist from local state for comparison
  const localFileIdToChangelist = new Map<string, number>();
  for (const file of Object.values(localFiles)) {
    localFileIdToChangelist.set(file.fileId, file.changelist);
  }

  // Check for deletions and updates
  for (const [fileId, changelist] of localFileIdToChangelist) {
    if (serverStateTree[fileId] === undefined) {
      // File was deleted on server
      deletions.push(fileId);
    } else if (changelist !== serverStateTree[fileId]) {
      // File was updated on server
      if (!changelistsToPull.includes(serverStateTree[fileId])) {
        changelistsToPull.push(serverStateTree[fileId]);
      }
    }
  }

  // Check for new files on server
  for (const [serverFileId, serverChangelist] of Object.entries(
    serverStateTree,
  )) {
    if (!localFileIdToChangelist.has(serverFileId)) {
      // New file on server
      if (!changelistsToPull.includes(serverChangelist)) {
        changelistsToPull.push(serverChangelist);
      }
    }
  }

  return { timestamp: new Date(), deletions, changelistsToPull };
}
