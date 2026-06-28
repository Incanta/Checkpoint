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
import { toStorageOptions } from "./storage-options.js";
import { readFileFromChangelist } from "./read-file.js";
import { getBinaryExtensions, isBinaryFile } from "./binary-extensions.js";
import { autoMergeText } from "./auto-merge.js";
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

  // Storage backend options (gateway or s3/r2-direct) shared by the pull loops.
  const storageOptions = toStorageOptions(storageTokenResponse);

  // Token refresh callback shared between the main and artifact pull loops.
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
      ...(newToken.r2 && {
        s3AccessKeyId: newToken.r2.accessKeyId,
        s3SecretAccessKey: newToken.r2.secretAccessKey,
        s3SessionToken: newToken.r2.sessionToken,
      }),
    };
  };

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

  // Path-keyed diff from our base to the target CL: only the changed paths and
  // the source CLs to pull (no full state tree, no fileId resolution).
  const diff = await client.changelist.diffChangelists.query({
    repoId: workspace.repoId,
    fromNumber: workspaceState.changelistNumber,
    toNumber: changelistNumber,
  });

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

  // Pre-pull: save locally-modified text files for auto-merge.
  // The diff's modified files are the ones the pull will overwrite. If a file is
  // locally edited (text), save its current content + base CL for a 3-way merge
  // after the pull completes.
  interface MergeCandidate {
    /** Normalized relative path */
    relativePath: string;
    /** The CL number the local state has for this file (base version) */
    baseCl: number;
    /** The file content on disk BEFORE pull (local modifications) */
    currentContent: string;
  }

  const mergeCandidates: MergeCandidate[] = [];

  for (const change of diff.modified) {
    const localPath = change.path;
    const localFile = workspaceState.files[localPath];
    if (!localFile || localFile.changelist === change.cl) continue; // up to date

    // Only auto-merge text files
    if (isBinaryFile(localPath, binaryExts)) continue;

    const fullPath = path.join(workspace.localPath, localPath);
    if (!existsSync(fullPath)) continue; // deleted locally, no merge

    // Check if the file has been modified locally
    try {
      if (localFile.md5 === "") {
        // Hash was deferred (post-pull optimisation). Fall back to mtime+size.
        const stat = await fs.stat(fullPath);
        if (stat.mtimeMs === localFile.mtime && stat.size === localFile.size) {
          continue; // not modified locally
        }
      } else {
        const currentHash = await hashFileMD5(fullPath);
        if (currentHash === localFile.md5) continue; // not modified locally
      }

      const currentContent = await fs.readFile(fullPath, "utf-8");
      mergeCandidates.push({
        relativePath: localPath,
        baseCl: localFile.changelist,
        currentContent,
      });
    } catch {
      // Can't read; skip merge for this file.
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
      cachePath: blockCachePath,
      ...storageOptions,
      logLevel: GetLogLevel(resolvedLogLevel),
    });

    if (!handle) {
      throw new Error("Failed to create longtail handle");
    }

    // Only wire callbacks when a consumer wants progress; otherwise pollHandle
    // skips per-tick callback work and polls coarsely (no callback overhead).
    const pollOptions: Parameters<typeof pollHandle>[1] = {
      onTokenRefresh: refreshStorageToken,
    };
    if (onStep) {
      pollOptions.onStep = (step) => {
        lastStep = step;
        onStep(step);
      };
    }
    if (onProgress) {
      pollOptions.onProgress = (step, done, total) =>
        onProgress(step, done, total);
    }
    if (!onStep && !onProgress) {
      pollOptions.intervalMs = 250;
    }
    const { status } = await pollHandle(handle, pollOptions);

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
          cachePath: blockCachePath,
          ...storageOptions,
          logLevel: GetLogLevel(resolvedLogLevel),
        });

        if (!handle) {
          Logger.error("Failed to create longtail handle for artifact pull");
          break;
        }

        const artifactPollOptions: Parameters<typeof pollHandle>[1] = {
          onTokenRefresh: refreshStorageToken,
        };
        if (onStep) {
          artifactPollOptions.onStep = (step) =>
            onStep(`[artifacts] ${step}`);
        }
        if (onProgress) {
          artifactPollOptions.onProgress = (step, done, total) =>
            onProgress(`[artifacts] ${step}`, done, total);
        }
        if (!onStep && !onProgress) {
          artifactPollOptions.intervalMs = 250;
        }
        const { status } = await pollHandle(handle, artifactPollOptions);

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
    // Handle deletions (paths come straight from the diff; no getFiles needed).
    if (diff.removed.length > 0) {
      onStep?.("Deleting removed files");
      let deletedCount = 0;
      const deleteTotal = diff.removed.length;
      onProgress?.("Deleting removed files", 0, deleteTotal);

      for (const removedPath of diff.removed) {
        const filePath = path.join(workspace.localPath, removedPath);
        if (existsSync(filePath)) {
          await fs.rm(filePath, { force: true });
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

    // Update workspace state incrementally from the diff: start from the old
    // state, drop removed files, and re-record added/modified ones. Unchanged
    // files keep their existing entry (and hash). Hashes are deferred (md5 "");
    // the size+mtime baseline is enough until change detection needs them.
    onStep?.("Updating workspace state");

    const newFiles: Record<string, WorkspaceStateFile> = {
      ...workspaceState.files,
    };
    for (const removedPath of diff.removed) {
      delete newFiles[removedPath];
    }

    const changed = [...diff.added, ...diff.modified];
    const stateTotal = changed.length;
    onProgress?.("Updating workspace state", 0, stateTotal);

    const statResults = await Promise.all(
      changed.map(async (change) => {
        const fullPath = path.join(workspace.localPath, change.path);
        try {
          return { change, stat: await fs.stat(fullPath) };
        } catch {
          return { change, stat: null };
        }
      }),
    );
    for (let i = 0; i < statResults.length; i++) {
      const { change, stat } = statResults[i]!;
      if (stat) {
        newFiles[change.path] = {
          fileId: change.fileId,
          changelist: change.cl,
          md5: "",
          size: stat.size,
          mtime: stat.mtimeMs,
        };
      }
      onProgress?.("Updating workspace state", i + 1, stateTotal);
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

  // Path-keyed diff from our base to head: the modified files are the outdated
  // ones. Intersect with the submit set, text files only.
  const diff = await client.changelist.diffChangelists.query({
    repoId: workspace.repoId,
    fromNumber: workspaceState.changelistNumber,
    toNumber: remoteHeadNumber,
  });

  const submitSet = new Set(
    submitPaths.map((p) => p.replace(/^[/\\]/, "").replace(/\\/g, "/")),
  );

  interface TextMergeCandidate {
    relativePath: string;
    fileId: string;
    baseCl: number;
    remoteCl: number;
    currentContent: string;
  }

  const candidates: TextMergeCandidate[] = [];

  for (const change of diff.modified) {
    const localPath = change.path;
    if (!submitSet.has(localPath)) continue; // not being submitted

    const localFile = workspaceState.files[localPath];
    if (!localFile || localFile.changelist === change.cl) continue; // up to date

    // Only text files
    if (isBinaryFile(localPath, binaryExts)) continue;

    const fullPath = path.join(workspace.localPath, localPath);
    if (!existsSync(fullPath)) continue; // deleted locally

    try {
      const currentContent = await fs.readFile(fullPath, "utf-8");
      candidates.push({
        relativePath: localPath,
        fileId: change.fileId,
        baseCl: localFile.changelist,
        remoteCl: change.cl,
        currentContent,
      });
    } catch {
      // Can't read; skip.
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
