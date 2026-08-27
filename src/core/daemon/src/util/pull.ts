import {
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
import {
  toStorageOptions,
  resolveStorageEndpoints,
} from "./storage-options.js";
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
  /**
   * Optional hook supplying gitignore-style include rules for the native pull.
   * Called once the target changelist is resolved, so the caller can compile
   * its filter against the config that actually applies to what is being
   * synced. Returning null (the default) pulls every file in the version;
   * otherwise longtail drops non-matching assets from the diff and never
   * downloads them.
   */
  resolveIncludePaths?: (changelistNumber: number) => Promise<string[] | null>,
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

  const rawStorageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });

  if (!rawStorageTokenResponse.expiration) {
    throw new Error("Could not get storage token");
  }

  // Prefer the LAN address when the daemon can reach it (falls back otherwise).
  const storageTokenResponse = await resolveStorageEndpoints(
    rawStorageTokenResponse,
  );

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

  // Resolved after changelistNumber is known so the caller can compile its
  // filter against the config that applies to the CL being synced.
  const includePaths = resolveIncludePaths
    ? await resolveIncludePaths(changelistNumber)
    : null;

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
      ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
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

  // Precompiled-binary (artifact) application no longer happens inline here.
  // It is an opt-in, per-workspace step decoupled from the source changelist
  // (see util/team-sync/artifacts.ts applyArtifacts, invoked by the sync
  // pipeline). Existing artifact files are preserved across a source pull.
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

    // ─── Downgrade correction pass ──────────────────────────────────
    // When syncing BACKWARD (target < current), the version indices applied
    // above can overwrite paths with stale content: a pulled CL B may have
    // touched a path whose target-state reference is a newer CL C that is not
    // itself in the pull set (only possible for paths unchanged between the
    // two states). Forward pulls cannot hit this (every pulled CL is newer
    // than the previous state, so any path it touches is a changed path whose
    // target reference is >= that CL). Detect such paths by computing the
    // last pulled writer per path and restore the ones whose last writer is
    // not the CL the target state references. Stray paths written by a pulled
    // index but absent from the target state entirely are removed.
    const isDowngrade =
      changelistResponse.number < workspaceState.changelistNumber;
    if (isDowngrade && sortedChangelists.length > 0) {
      onStep?.("Verifying downgraded files");

      // Expected per-path reference in the TARGET state: unchanged paths keep
      // the previous state's reference; changed paths come from the diff.
      const expectedCl = new Map<string, number>();
      for (const [p, f] of Object.entries(workspaceState.files)) {
        expectedCl.set(p, f.changelist);
      }
      for (const removedPath of diff.removed) {
        expectedCl.delete(removedPath);
      }
      for (const change of [...diff.added, ...diff.modified]) {
        expectedCl.set(change.path, change.cl);
      }

      // Last pulled CL that wrote each path (ascending apply order, so the
      // newest pulled writer is what's on disk now)
      const lastWriter = new Map<string, number>();
      for (const cl of sortedChangelists) {
        const clFiles = await client.changelist.getChangelistFiles.query({
          repoId: workspace.repoId,
          changelistNumber: (cl as any).number,
        });
        for (const f of clFiles) {
          if (f.changeType === "DELETE") continue;
          const normalized = f.path.replace(/^\//, "").replace(/\\/g, "/");
          lastWriter.set(normalized, (cl as any).number);
        }
      }

      const toRestore: Array<{ relativePath: string; cl: number }> = [];
      const toRemove: string[] = [];
      for (const [p, writer] of lastWriter) {
        const expected = expectedCl.get(p);
        if (expected === undefined) {
          toRemove.push(p);
        } else if (expected !== writer) {
          toRestore.push({ relativePath: p, cl: expected });
        }
      }

      if (toRestore.length > 0 || toRemove.length > 0) {
        Logger.info(
          `Downgrade correction: restoring ${toRestore.length} file(s), removing ${toRemove.length} stray file(s)`,
        );

        for (const strayPath of toRemove) {
          const fullPath = path.join(workspace.localPath, strayPath);
          if (existsSync(fullPath)) {
            await fs.rm(fullPath, { force: true });
          }
        }

        let restoredCount = 0;
        onProgress?.("Verifying downgraded files", 0, toRestore.length);
        for (const entry of toRestore) {
          const result = await readFileFromChangelist({
            workspace,
            filePath: entry.relativePath,
            changelistNumber: entry.cl,
          });
          const fullPath = path.join(workspace.localPath, entry.relativePath);
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.copyFile(result.cachePath, fullPath);
          restoredCount++;
          onProgress?.(
            "Verifying downgraded files",
            restoredCount,
            toRestore.length,
          );
        }
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
        ...workspaceState,
        changelistNumber: changelistResponse.number,
        files: newFiles,
        // Preserve any already-applied artifacts; the pipeline's applyArtifacts
        // step owns changes to this map.
        artifactFiles: workspaceState.artifactFiles ?? {},
      },
      stateBackend,
    );

    return mergeResult;
  }

  if (errored) {
    throw new Error("Pull failed: " + lastStep);
  }

  // Should not reach here: errored throws above, and !errored returns above
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
 * @returns Merge result; if `conflictMerges` is non-empty the caller should
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

  // Already at head, nothing to do
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

  // Save workspace state with patched file entries; head CL is NOT changed
  await saveWorkspaceState(workspace, workspaceState, textPullBackend);

  return mergeResult;
}
