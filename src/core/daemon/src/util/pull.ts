import {
  DiffState,
  CreateApiClientAuth,
  type WorkspaceStateFile,
  hashFileMD5,
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
import { readFileFromChangelist } from "./read-file.js";
import { getBinaryExtensions, isBinaryFile } from "./binary-extensions.js";
import { autoMergeText, type AutoMergeResult } from "./auto-merge.js";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { Logger } from "../logging.js";
import { DaemonConfig } from "../daemon-config.js";

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
  logLevel?: LongtailLogLevel,
  onStep?: (step: string) => void,
  onProgress?: (step: string, done: number, total: number) => void,
): Promise<PullMergeResult> {
  const daemonConfig = await DaemonConfig.Get();
  const resolvedLogLevel =
    logLevel ?? (daemonConfig.longtail.logLevel as LongtailLogLevel);
  const stateBackend = daemonConfig.stateBackend;
  const client = await CreateApiClientAuth(workspace.daemonId);
  const binaryExts = await getBinaryExtensions(
    workspace.daemonId,
    workspace.repoId,
  );

  const storageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });

  if (!storageTokenResponse.expiration) {
    throw new Error("Could not get storage token");
  }

  const tokenExpirationMs = storageTokenResponse.expiration * 1000;

  // Token refresh callback — shared between main pull and artifact pull loops
  const refreshStorageToken = async () => {
    Logger.debug("Token refresh requested by native addon");
    const newToken = await client.storage.getToken.query({
      repoId: workspace.repoId,
      write: true,
    });
    Logger.debug("Token refreshed successfully");
    return {
      jwt: newToken.token,
      jwtExpirationMs: (newToken.expiration ?? 0) * 1000,
      ...(newToken.r2Credentials && {
        r2AccessKeyId: newToken.r2Credentials.accessKeyId,
        r2SecretAccessKey: newToken.r2Credentials.secretAccessKey,
        r2SessionToken: newToken.r2Credentials.sessionToken,
      }),
    };
  };

  let filerUrl = "";
  let token = "";
  if (storageTokenResponse.storageType === "r2") {
    // R2: no filer URL needed, credentials are passed directly to addon
  } else {
    token = storageTokenResponse.token;
    const backendUrl = storageTokenResponse.backendUrl;
    filerUrl = await fetch(`${backendUrl}/filer-url`).then((res) => res.text());
  }

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

  const workspaceState = await getWorkspaceState(
    workspace.localPath,
    stateBackend,
  );

  const diff = DiffState(
    workspaceState.files,
    changelistResponse.stateTree as Record<string, number>,
  );

  const changelistsResponse =
    await client.changelist.getChangelistsWithNumbers.mutate({
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
    if (isBinaryFile(localPath, binaryExts)) continue;

    const fullPath = path.join(workspace.localPath, localPath);
    if (!existsSync(fullPath)) continue; // Deleted locally — no merge

    // Check if the file has been modified locally
    try {
      if (localFile.md5 === "") {
        // Hash was deferred (post-pull optimisation). Fall back to mtime+size.
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs === localFile.mtime && stat.size === localFile.size) {
          continue; // Not modified locally
        }
      } else {
        const currentHash = await hashFileMD5(fullPath);
        if (currentHash === localFile.md5) continue; // Not modified locally
      }

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
  const blockCachePath =
    (daemonConfig.longtail.enableBlockCache ?? true)
      ? path.join(homedir(), ".checkpoint", "cache", "blocks")
      : undefined;
  let errored = false;
  let lastStep = "";
  for (const versionIndex of versionsToPull) {
    if (versionIndex === "") {
      continue;
    }

    Logger.debug(
      `Starting longtail pull for version index ${versionIndex} for workspace ${workspace.workspaceName}...`,
    );

    const handle = pullAsync({
      versionIndex,
      enableMmapIndexing: daemonConfig.longtail.enableMmapIndexing,
      enableMmapBlockStore: daemonConfig.longtail.enableMmapBlockStore,
      localRootPath: workspace.localPath,
      remoteBasePath: `/${orgId}/${workspace.repoId}`,
      filerUrl,
      jwt: token,
      jwtExpirationMs: tokenExpirationMs,
      cachePath: blockCachePath,
      storageType: storageTokenResponse.storageType,
      ...(storageTokenResponse.r2Credentials && {
        r2AccessKeyId: storageTokenResponse.r2Credentials.accessKeyId,
        r2SecretAccessKey: storageTokenResponse.r2Credentials.secretAccessKey,
        r2SessionToken: storageTokenResponse.r2Credentials.sessionToken,
        r2Endpoint: storageTokenResponse.r2Credentials.endpoint,
        r2BucketName: storageTokenResponse.r2Credentials.bucket,
      }),
      logLevel: GetLogLevel(resolvedLogLevel),
    });

    if (!handle) {
      throw new Error("Failed to create longtail handle");
    }

    const { status } = await pollHandle(handle, {
      onStep: (step) => {
        lastStep = step;
        onStep?.(step);
      },
      onProgress: (step, done, total) => {
        onProgress?.(step, done, total);
      },
      onTokenRefresh: refreshStorageToken,
    });

    Logger.debug(
      `Longtail pull for version index ${versionIndex} completed with status: ${status.error === 0 ? "success" : "failure"}. Last step: ${lastStep}`,
    );

    if (status.error !== 0) {
      Logger.error(
        `Completed with exit code: ${status.error} and last step ${status.currentStep}`,
      );
    }

    freeHandle(handle);

    if (status.error !== 0) {
      errored = true;
      break;
    }
  }

  // ─── Artifact pull (optional) ──────────────────────────────────
  const newArtifactFiles: Record<string, WorkspaceStateFile> = {};
  const artifactStateTree = changelistResponse.artifactStateTree as Record<
    string,
    number
  > | null;

  if (!errored && artifactStateTree) {
    const artifactDiff = DiffState(
      workspaceState.artifactFiles ?? {},
      artifactStateTree,
    );

    if (artifactDiff.changelistsToPull.length > 0) {
      const artifactCls =
        await client.changelist.getChangelistsWithNumbers.mutate({
          repoId: workspace.repoId,
          numbers: artifactDiff.changelistsToPull,
        });

      const sortedArtifactCls = artifactCls.sort(
        (a: any, b: any) => a.number - b.number,
      );

      for (const cl of sortedArtifactCls) {
        const artVersionIndex = (cl as any).artifactVersionIndex;
        if (!artVersionIndex || artVersionIndex === "") continue;

        Logger.debug(
          `Starting longtail pull for artifact version index ${artVersionIndex}...`,
        );

        const handle = pullAsync({
          versionIndex: artVersionIndex,
          enableMmapIndexing: daemonConfig.longtail.enableMmapIndexing,
          enableMmapBlockStore: daemonConfig.longtail.enableMmapBlockStore,
          localRootPath: workspace.localPath,
          remoteBasePath: `/${orgId}/${workspace.repoId}`,
          filerUrl,
          jwt: token,
          jwtExpirationMs: tokenExpirationMs,
          cachePath: blockCachePath,
          storageType: storageTokenResponse.storageType,
          ...(storageTokenResponse.r2Credentials && {
            r2AccessKeyId: storageTokenResponse.r2Credentials.accessKeyId,
            r2SecretAccessKey:
              storageTokenResponse.r2Credentials.secretAccessKey,
            r2SessionToken: storageTokenResponse.r2Credentials.sessionToken,
            r2Endpoint: storageTokenResponse.r2Credentials.endpoint,
            r2BucketName: storageTokenResponse.r2Credentials.bucket,
          }),
          logLevel: GetLogLevel(resolvedLogLevel),
        });

        if (!handle) {
          Logger.error("Failed to create longtail handle for artifact pull");
          break;
        }

        const { status } = await pollHandle(handle, {
          onStep: (step) => {
            onStep?.(`[artifacts] ${step}`);
          },
          onProgress: (step, done, total) => {
            onProgress?.(`[artifacts] ${step}`, done, total);
          },
          onTokenRefresh: refreshStorageToken,
        });

        freeHandle(handle);

        if (status.error !== 0) {
          Logger.error(
            `Artifact pull failed: ${status.error} ${status.currentStep}`,
          );
          break;
        }
      }
    }

    // Batch-fetch all artifact file info in one API call
    const artFileIds = Object.keys(artifactStateTree);
    const artAllIds = [...new Set([...artifactDiff.deletions, ...artFileIds])];
    const artAllFilesResponse =
      artAllIds.length > 0
        ? await client.file.getFiles.mutate({
            ids: artAllIds,
            repoId: workspace.repoId,
          })
        : [];
    const artFilesById = new Map(
      artAllFilesResponse.map((f: any) => [f.id, f]),
    );

    // Handle artifact deletions
    if (artifactDiff.deletions.length > 0) {
      for (const delId of artifactDiff.deletions) {
        const file = artFilesById.get(delId);
        if (file?.path) {
          const filePath = path.join(workspace.localPath, file.path);
          if (existsSync(filePath)) {
            await fs.rm(filePath, { force: true });
          }
        }
      }
    }

    // Build artifact file state
    if (artFileIds.length > 0) {
      onStep?.("Updating artifact state");
      const artFilesResponse = artFileIds
        .map((id) => artFilesById.get(id))
        .filter(Boolean);

      // Collect artifact files that need hashing
      const oldArtFileIdToEntry = new Map<
        string,
        { path: string; file: WorkspaceStateFile }
      >();
      if (workspaceState.artifactFiles) {
        for (const [fp, f] of Object.entries(workspaceState.artifactFiles)) {
          oldArtFileIdToEntry.set(f.fileId, { path: fp, file: f });
        }
      }

      const artFilesToHash: {
        normalizedPath: string;
        fullPath: string;
        fileId: string;
        changelist: number;
      }[] = [];

      for (const file of artFilesResponse) {
        if (!file.path) continue;
        const normalizedPath = file.path.replace(/^\//, "").replace(/\\/g, "/");
        const filePath = path.join(workspace.localPath, normalizedPath);
        const changelist = artifactStateTree[file.id];

        if (!existsSync(filePath)) continue;

        const oldEntry = oldArtFileIdToEntry.get(file.id);
        if (
          oldEntry &&
          oldEntry.file.changelist === changelist &&
          oldEntry.path === normalizedPath
        ) {
          newArtifactFiles[normalizedPath] = { ...oldEntry.file };
          continue;
        }

        artFilesToHash.push({
          normalizedPath,
          fullPath: filePath,
          fileId: file.id,
          changelist,
        });
      }

      const artTotal = artFilesToHash.length;
      onProgress?.("Updating artifact state", 0, artTotal);

      if (artFilesToHash.length > 0) {
        // Stat files in parallel — hashes are deferred until change detection
        // actually needs them (size+mtime baseline is sufficient).
        const artStatResults = await Promise.all(
          artFilesToHash.map(async (entry) => {
            const stat = await fs.stat(entry.fullPath);
            return { entry, stat };
          }),
        );

        for (let i = 0; i < artStatResults.length; i++) {
          const { entry, stat } = artStatResults[i]!;

          newArtifactFiles[entry.normalizedPath] = {
            fileId: entry.fileId,
            changelist: entry.changelist,
            md5: "",
            size: stat.size,
            mtime: stat.mtimeMs,
          };

          onProgress?.("Updating artifact state", i + 1, artTotal);
        }
      }
    }
  }

  if (!errored) {
    // Batch-fetch all main file info in one API call
    const allFileIds = Object.keys(serverStateTree);
    const mainAllIds = [...new Set([...diff.deletions, ...allFileIds])];
    const mainAllFilesResponse =
      mainAllIds.length > 0
        ? await client.file.getFiles.mutate({
            ids: mainAllIds,
            repoId: workspace.repoId,
          })
        : [];
    const mainFilesById = new Map(
      mainAllFilesResponse.map((f: any) => [f.id, f]),
    );

    // Handle deletions
    const delFiles = diff.deletions
      .map((id) => mainFilesById.get(id))
      .filter(Boolean);

    if (delFiles.length > 0) {
      onStep?.("Deleting removed files");
      let deletedCount = 0;
      const deleteTotal = delFiles.length;
      onProgress?.("Deleting removed files", 0, deleteTotal);

      for (const file of delFiles) {
        if (file?.path) {
          const filePath = path.join(workspace.localPath, file.path);

          if (existsSync(filePath)) {
            await fs.rm(filePath, {
              force: true,
            });
          }
        }

        deletedCount++;
        onProgress?.("Deleting removed files", deletedCount, deleteTotal);
      }
    }

    // ─── Post-pull: auto-merge text files ───────────────────────────
    const mergeResult: PullMergeResult = {
      cleanMerges: [],
      conflictMerges: [],
    };

    if (mergeCandidates.length > 0) {
      onStep?.("Merging text files");
      let mergedCount = 0;
      const mergeTotal = mergeCandidates.length;
      onProgress?.("Merging text files", 0, mergeTotal);

      const MERGE_CONCURRENCY = 8;

      const processMerge = async (candidate: MergeCandidate) => {
        try {
          const baseResult = await readFileFromChangelist({
            workspace,
            filePath: candidate.relativePath,
            changelistNumber: candidate.baseCl,
          });
          const baseContent = await fs.readFile(baseResult.cachePath, "utf-8");

          const incomingPath = path.join(
            workspace.localPath,
            candidate.relativePath,
          );
          const incomingContent = await fs.readFile(incomingPath, "utf-8");

          const merged = autoMergeText(
            baseContent,
            candidate.currentContent,
            incomingContent,
          );

          await fs.writeFile(incomingPath, merged.content, "utf-8");

          if (merged.clean) {
            mergeResult.cleanMerges.push(candidate.relativePath);
          } else {
            mergeResult.conflictMerges.push(candidate.relativePath);
          }
        } catch (err) {
          Logger.error(
            `Auto-merge failed for ${candidate.relativePath}: ${err}`,
          );
        }

        mergedCount++;
        onProgress?.("Merging text files", mergedCount, mergeTotal);
      };

      // Worker pool: run up to MERGE_CONCURRENCY merges at a time
      let idx = 0;
      const next = async (): Promise<void> => {
        while (idx < mergeCandidates.length) {
          const candidate = mergeCandidates[idx++]!;
          await processMerge(candidate);
        }
      };
      const workers = Array.from(
        { length: Math.min(MERGE_CONCURRENCY, mergeCandidates.length) },
        () => next(),
      );
      await Promise.all(workers);
    }

    // Build new state with path keys and file info
    const allFilesResponse = allFileIds
      .map((id) => mainFilesById.get(id))
      .filter(Boolean);

    onStep?.("Updating workspace state");

    // Build lookup: fileId → old state entry (for skipping unchanged files)
    const oldFileIdToEntry = new Map<
      string,
      { path: string; file: WorkspaceStateFile }
    >();
    for (const [filePath, file] of Object.entries(workspaceState.files)) {
      oldFileIdToEntry.set(file.fileId, { path: filePath, file });
    }

    // Build set of merged file paths (these must be re-hashed even if CL matches)
    const mergedPaths = new Set<string>(
      mergeResult.cleanMerges.concat(mergeResult.conflictMerges),
    );

    // Partition files into changed (need hash) vs unchanged (copy old state)
    const newFiles: Record<string, WorkspaceStateFile> = {};
    const filesToHash: {
      normalizedPath: string;
      fullPath: string;
      fileId: string;
      changelist: number;
    }[] = [];

    for (const file of allFilesResponse) {
      if (!file.path) continue;

      const normalizedPath = file.path.replace(/^\//, "").replace(/\\/g, "/");
      const fullPath = path.join(workspace.localPath, normalizedPath);
      const changelist = serverStateTree[file.id];

      if (!existsSync(fullPath)) continue;

      const oldEntry = oldFileIdToEntry.get(file.id);
      const wasMerged = mergedPaths.has(normalizedPath);

      // Unchanged: same fileId, same changelist, not merged, and old path matches
      if (
        oldEntry &&
        oldEntry.file.changelist === changelist &&
        !wasMerged &&
        oldEntry.path === normalizedPath
      ) {
        newFiles[normalizedPath] = { ...oldEntry.file };
        continue;
      }

      filesToHash.push({
        normalizedPath,
        fullPath,
        fileId: file.id,
        changelist,
      });
    }

    // Stat files in parallel — hashes are deferred until change detection
    // actually needs them (size+mtime baseline is sufficient after pull).
    const stateTotal = filesToHash.length;
    onProgress?.("Updating workspace state", 0, stateTotal);

    if (filesToHash.length > 0) {
      const statResults = await Promise.all(
        filesToHash.map(async (entry) => {
          const stat = await fs.stat(entry.fullPath);
          return { entry, stat };
        }),
      );

      for (let i = 0; i < statResults.length; i++) {
        const { entry, stat } = statResults[i]!;

        newFiles[entry.normalizedPath] = {
          fileId: entry.fileId,
          changelist: entry.changelist,
          md5: "",
          size: stat.size,
          mtime: stat.mtimeMs,
        };

        onProgress?.("Updating workspace state", i + 1, stateTotal);
      }
    }

    await saveWorkspaceState(
      workspace,
      {
        changelistNumber: changelistResponse.number,
        files: newFiles,
        artifactFiles: newArtifactFiles,
      },
      stateBackend,
    );

    return mergeResult;
  }

  if (errored) {
    throw new Error("Pull failed: " + lastStep);
  }

  // Should not reach here — errored throws above, and !errored returns above
  return { cleanMerges: [], conflictMerges: [] };
}

/**
 * Pull only outdated text files for a pre-submit merge check.
 *
 * Unlike a full `pull()`, this does NOT use Longtail and does NOT advance the
 * workspace head CL. It downloads individual file versions from the remote,
 * performs 3-way auto-merge, writes the result back to disk, and patches only
 * the affected entries in state.json. The workspace still appears "out of date"
 * for any remaining files.
 *
 * @param workspace  - The workspace to operate on
 * @param orgId      - Organisation ID (unused here but kept for API consistency)
 * @param submitPaths - Normalised relative paths the user is about to submit
 * @returns Merge result — if `conflictMerges` is non-empty the caller should
 *          block the submit.
 */
export async function pullTextFilesForSubmit(
  workspace: Workspace,
  orgId: string,
  submitPaths: string[],
): Promise<PullMergeResult> {
  const client = await CreateApiClientAuth(workspace.daemonId);
  const binaryExts = await getBinaryExtensions(
    workspace.daemonId,
    workspace.repoId,
  );
  const daemonCfg = await DaemonConfig.Get();
  const textPullBackend = daemonCfg.stateBackend;
  const workspaceState = await getWorkspaceState(
    workspace.localPath,
    textPullBackend,
  );

  // Get the remote branch head
  const branchResponse = await client.branch.getBranch.query({
    repoId: workspace.repoId,
    name: workspace.branchName,
  });

  if (!branchResponse) {
    throw new Error("Could not get branch information");
  }

  const remoteHeadNumber = branchResponse.headNumber;

  // Already at head — nothing to do
  if (workspaceState.changelistNumber === remoteHeadNumber) {
    return { cleanMerges: [], conflictMerges: [] };
  }

  // Get the head changelist's state tree
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

  // Build quick lookups
  const submitSet = new Set(
    submitPaths.map((p) => p.replace(/^[/\\]/, "").replace(/\\/g, "/")),
  );
  const localFileIdToPath = new Map<string, string>();
  for (const [filePath, file] of Object.entries(workspaceState.files)) {
    localFileIdToPath.set(file.fileId, filePath);
  }

  // Find text files in the submit set that are outdated on the server
  interface TextMergeCandidate {
    relativePath: string;
    fileId: string;
    baseCl: number;
    remoteCl: number;
    currentContent: string;
  }

  const candidates: TextMergeCandidate[] = [];

  for (const [fileId, remoteCl] of Object.entries(serverStateTree)) {
    const localPath = localFileIdToPath.get(fileId);
    if (!localPath) continue; // New on server, not our problem
    if (!submitSet.has(localPath)) continue; // Not being submitted

    const localFile = workspaceState.files[localPath];
    if (!localFile || localFile.changelist === remoteCl) continue; // Up to date

    // Only text files
    if (isBinaryFile(localPath, binaryExts)) continue;

    const fullPath = path.join(workspace.localPath, localPath);
    if (!existsSync(fullPath)) continue; // Deleted locally

    try {
      const currentContent = await fs.readFile(fullPath, "utf-8");
      candidates.push({
        relativePath: localPath,
        fileId,
        baseCl: localFile.changelist,
        remoteCl,
        currentContent,
      });
    } catch {
      // Can't read — skip
    }
  }

  if (candidates.length === 0) {
    return { cleanMerges: [], conflictMerges: [] };
  }

  // Perform 3-way merge for each candidate
  const mergeResult: PullMergeResult = {
    cleanMerges: [],
    conflictMerges: [],
  };

  for (const candidate of candidates) {
    try {
      // Read base version (the version our local state was based on)
      const baseResult = await readFileFromChangelist({
        workspace,
        filePath: candidate.relativePath,
        changelistNumber: candidate.baseCl,
      });
      const baseContent = await fs.readFile(baseResult.cachePath, "utf-8");

      // Read incoming version (remote head)
      const incomingResult = await readFileFromChangelist({
        workspace,
        filePath: candidate.relativePath,
        changelistNumber: candidate.remoteCl,
      });
      const incomingContent = await fs.readFile(
        incomingResult.cachePath,
        "utf-8",
      );

      // 3-way merge
      const merged = autoMergeText(
        baseContent,
        candidate.currentContent,
        incomingContent,
      );

      // Write merged content back to disk
      const fullPath = path.join(workspace.localPath, candidate.relativePath);
      await fs.writeFile(fullPath, merged.content, "utf-8");

      if (merged.clean) {
        mergeResult.cleanMerges.push(candidate.relativePath);
      } else {
        mergeResult.conflictMerges.push(candidate.relativePath);
      }

      // Patch just this file's entry in workspace state (advance its CL, update hash)
      const stat = await fs.stat(fullPath);
      const hash = await hashFileMD5(fullPath);

      workspaceState.files[candidate.relativePath] = {
        fileId: candidate.fileId,
        changelist: candidate.remoteCl,
        md5: hash,
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    } catch (err) {
      console.error(
        `Pre-submit auto-merge failed for ${candidate.relativePath}:`,
        err,
      );
    }
  }

  // Save workspace state with patched file entries — head CL is NOT changed
  await saveWorkspaceState(workspace, workspaceState, textPullBackend);

  return mergeResult;
}
