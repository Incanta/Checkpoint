import config from "@incanta/config";
import {
  DiffState,
  CreateApiClientAuth,
  type WorkspaceStateFile,
  hashFile,
} from "@checkpointvcs/common";
import {
  pullAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import {
  getWorkspaceState,
  saveWorkspaceState,
  type Workspace,
} from "./util.js";
import { isBinaryFile, readFileFromChangelist } from "./read-file.js";
import { autoMergeText, type AutoMergeResult } from "./auto-merge.js";
import { existsSync, promises as fs } from "fs";
import path from "path";

/**
 * Files that were auto-merged during pull.
 * Returned so the caller can report merge results.
 */
export interface PullMergeResult {
  /** Files that were cleanly auto-merged (no conflicts). */
  cleanMerges: string[];
  /** Files that were merged but contain conflict markers that need manual resolution. */
  conflictMerges: string[];
}

export async function pull(
  workspace: Workspace,
  orgId: string,
  changelistNumber: number | null,
  filePaths: string[] | null = null, // TODO: implement partial pulls
  logLevel: LongtailLogLevel = config.get<LongtailLogLevel>(
    "longtail.log-level",
  ),
): Promise<PullMergeResult> {
  const client = await CreateApiClientAuth(workspace.daemonId);

  const storageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });

  if (
    !storageTokenResponse.token ||
    !storageTokenResponse.expiration ||
    !storageTokenResponse.backendUrl
  ) {
    throw new Error("Could not get storage token");
  }

  const token = storageTokenResponse.token;
  const tokenExpirationMs = storageTokenResponse.expiration * 1000;
  const backendUrl = storageTokenResponse.backendUrl;

  const filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) =>
    res.text(),
  );

  if (changelistNumber === null) {
    const branchResponse = await client.branch.getBranch.query({
      repoId: workspace.repoId,
      name: workspace.branchName,
    });

    if (!branchResponse) {
      throw new Error("Could not get branch information");
    }

    changelistNumber = branchResponse.headNumber;
  }

  const changelistResponse = await client.changelist.getChangelist.query({
    repoId: workspace.repoId,
    changelistNumber: changelistNumber,
  });

  if (!changelistResponse) {
    throw new Error("Could not get changelist information");
  }

  const workspaceState = await getWorkspaceState(workspace.localPath);

  const diff = DiffState(
    workspaceState.files,
    changelistResponse.stateTree as Record<string, number>,
  );

  const changelistsResponse =
    await client.changelist.getChangelistsWithNumbers.query({
      repoId: workspace.repoId,
      numbers: diff.changelistsToPull,
    });

  const sortedChangelists = changelistsResponse.sort(
    (a: any, b: any) => a.number - b.number,
  );

  const versionsToPull: string[] = sortedChangelists.map(
    (changelist: any) => changelist.versionIndex,
  );

  // ─── Pre-pull: save locally-modified text files for auto-merge ────
  // Identify text files that exist locally with a different CL on the server.
  // These will be overwritten by Longtail, so we save the current content
  // and the base CL for 3-way merge after pull completes.
  const serverStateTree = changelistResponse.stateTree as Record<
    string,
    number
  >;

  interface MergeCandidate {
    /** Normalized relative path */
    relativePath: string;
    /** The CL number the local state has for this file (base version) */
    baseCl: number;
    /** The file content on disk BEFORE pull (local modifications) */
    currentContent: string;
  }

  const mergeCandidates: MergeCandidate[] = [];

  // Build fileId -> path lookup from local state
  const localFileIdToPath = new Map<string, string>();
  for (const [filePath, file] of Object.entries(workspaceState.files)) {
    localFileIdToPath.set(file.fileId, filePath);
  }

  for (const [fileId, serverCl] of Object.entries(serverStateTree)) {
    const localPath = localFileIdToPath.get(fileId);
    if (!localPath) continue; // New file on server — no merge needed

    const localFile = workspaceState.files[localPath];
    if (!localFile || localFile.changelist === serverCl) continue; // Up to date

    // Only auto-merge text files
    if (isBinaryFile(localPath)) continue;

    const fullPath = path.join(workspace.localPath, localPath);
    if (!existsSync(fullPath)) continue; // Deleted locally — no merge

    // Check if the file has been modified locally by comparing hash
    try {
      const currentHash = await hashFile(fullPath);
      if (currentHash === localFile.hash) continue; // Not modified locally

      const currentContent = await fs.readFile(fullPath, "utf-8");
      mergeCandidates.push({
        relativePath: localPath,
        baseCl: localFile.changelist,
        currentContent,
      });
    } catch {
      // Can't read — skip merge for this file
    }
  }

  // ─── Longtail pull ────────────────────────────────────────────────
  let errored = false;
  let lastStep = "";
  for (const versionIndex of versionsToPull) {
    if (versionIndex === "") {
      continue;
    }

    const handle = pullAsync({
      versionIndex,
      enableMmapIndexing: config.get<boolean>("longtail.enable-mmap-indexing"),
      enableMmapBlockStore: config.get<boolean>(
        "longtail.enable-mmap-block-store",
      ),
      localRootPath: workspace.localPath,
      remoteBasePath: `/${orgId}/${workspace.repoId}`,
      filerUrl,
      jwt: token,
      jwtExpirationMs: tokenExpirationMs,
      logLevel: GetLogLevel(logLevel),
    });

    if (!handle) {
      throw new Error("Failed to create longtail handle");
    }

    const { status } = await pollHandle(handle, {
      onStep: (step) => {
        lastStep = step;
      },
    });

    if (status.error !== 0) {
      console.log(
        `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
      );
    }

    freeHandle(handle);

    if (status.error !== 0) {
      errored = true;
      break;
    }
  }

  if (!errored) {
    // Handle deletions
    const filesResponse = await client.file.getFiles.query({
      ids: diff.deletions,
      repoId: workspace.repoId,
    });

    for (const file of filesResponse) {
      if (file.path) {
        const filePath = path.join(workspace.localPath, file.path);

        if (existsSync(filePath)) {
          await fs.rm(filePath, {
            force: true,
          });
        }
      }
    }

    // ─── Post-pull: auto-merge text files ───────────────────────────
    const mergeResult: PullMergeResult = {
      cleanMerges: [],
      conflictMerges: [],
    };

    for (const candidate of mergeCandidates) {
      try {
        // Read the base version (the common ancestor for 3-way merge)
        const baseResult = await readFileFromChangelist({
          workspace,
          filePath: candidate.relativePath,
          changelistNumber: candidate.baseCl,
        });
        const baseContent = await fs.readFile(baseResult.cachePath, "utf-8");

        // Read the incoming version (now on disk after Longtail pull)
        const incomingPath = path.join(
          workspace.localPath,
          candidate.relativePath,
        );
        const incomingContent = await fs.readFile(incomingPath, "utf-8");

        // 3-way merge: base (ancestor), current (local), incoming (remote)
        const merged = autoMergeText(
          baseContent,
          candidate.currentContent,
          incomingContent,
        );

        // Write the merged result back to disk
        await fs.writeFile(incomingPath, merged.content, "utf-8");

        if (merged.clean) {
          mergeResult.cleanMerges.push(candidate.relativePath);
        } else {
          mergeResult.conflictMerges.push(candidate.relativePath);
        }
      } catch (err) {
        // If merge fails for any reason, leave the file as-is (remote version)
        console.error(`Auto-merge failed for ${candidate.relativePath}:`, err);
      }
    }

    // Build new state.json with path keys and file info
    const allFileIds = Object.keys(serverStateTree);

    // Get all file info from server
    const allFilesResponse = await client.file.getFiles.query({
      ids: allFileIds,
      repoId: workspace.repoId,
    });

    // Build the new state format: Record<path, WorkspaceStateFile>
    const newFiles: Record<string, WorkspaceStateFile> = {};

    for (const file of allFilesResponse) {
      if (!file.path) continue;

      // Normalize path: strip leading slash and use forward slashes
      const normalizedPath = file.path.replace(/^\//, "").replace(/\\/g, "/");
      const filePath = path.join(workspace.localPath, normalizedPath);
      const changelist = serverStateTree[file.id];

      if (existsSync(filePath)) {
        // Re-hash after potential merge overwrites
        const stat = await fs.stat(filePath);
        const hash = await hashFile(filePath);

        newFiles[normalizedPath] = {
          fileId: file.id,
          changelist: changelist,
          hash: hash,
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      }
    }

    await saveWorkspaceState(workspace, {
      changelistNumber: changelistResponse.number,
      files: newFiles,
    });

    return mergeResult;
  }

  if (errored) {
    throw new Error("Pull failed: " + lastStep);
  }

  // Should not reach here — errored throws above, and !errored returns above
  return { cleanMerges: [], conflictMerges: [] };
}
