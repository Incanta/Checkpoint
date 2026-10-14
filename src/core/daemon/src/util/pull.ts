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
  updateWorkspaceState,
  type Workspace,
} from "./util.js";
import {
  toStorageOptions,
  resolveStorageEndpoints,
} from "./storage-options.js";
import { readFileFromChangelist } from "./read-file.js";
import { getBinaryExtensions, isBinaryFile } from "./binary-extensions.js";
import { autoMergeText } from "./auto-merge.js";
import {
  LocalChangeGuard,
  describeSetAside,
  isMergeableText,
  type SetAsideFile,
} from "./pull-local-changes.js";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { Logger } from "../logging.js";
import { DaemonConfig } from "../daemon-config.js";
import { StageTimer } from "./stage-timer.js";

/**
 * Files that were auto-merged during pull.
 * Returned so the caller can report merge results.
 */
export interface PullMergeResult {
  /** Files that were cleanly auto-merged (no conflicts). */
  cleanMerges: string[];
  /**
   * Files that need manual attention: merged with conflict markers left in
   * them, or (see localChangesSetAside) replaced by the server's version with
   * the local one kept as a backup.
   */
  conflictMerges: string[];
  /**
   * Files whose local changes could not be merged. The workspace has the
   * server's version; the local version is at backupPath. Also listed in
   * conflictMerges so older clients surface them.
   */
  localChangesSetAside: SetAsideFile[];
  /**
   * Paths the pull added or modified, so later steps (the sync filter) can
   * look at just those instead of every tracked file. Absent from results
   * that did not pull anything.
   */
  pulledPaths?: string[];
  /**
   * Every path whose file or recorded baseline the pull may have changed
   * (pulled, removed, corrected, or merged), so the daemon can re-check just
   * those instead of rescanning the workspace. Absent when nothing changed.
   */
  touchedPaths?: string[];
  /**
   * Set when the pull added or removed tracked paths. Which directories count
   * as tracked decides how untracked folders show in status, so the daemon
   * then rescans instead of re-checking only `touchedPaths`.
   */
  trackedSetChanged?: true;
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
  const timer = new StageTimer();
  timer.stage("setup");
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
      name: workspace.domainBranchName,
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
  timer.stage("diff");
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

  // A changelist's version index holds everything that changelist touched,
  // so applying it can write paths the diff says nothing about: a file a later
  // changelist deleted (a stray), or a file whose current version comes from
  // some other changelist (a stale write). Ask the server which, so local
  // files at those paths can be protected now and the workspace corrected
  // afterwards. See changelist.getPullAnomalies.
  let anomalies: { stray: string[]; stale: { path: string; cl: number }[] } = {
    stray: [],
    stale: [],
  };
  const pulledNumbers: number[] = sortedChangelists
    .filter((cl: any) => cl.versionIndex !== "")
    .map((cl: any) => cl.number);
  timer.stage("anomalies");
  if (pulledNumbers.length > 0) {
    try {
      anomalies = await client.changelist.getPullAnomalies.mutate({
        repoId: workspace.repoId,
        toNumber: changelistNumber,
        numbers: pulledNumbers,
      });
    } catch (err) {
      // A server from before this check. The pull still works; it just cannot
      // clean up after itself.
      Logger.warn(`Could not check for stray files before pulling: ${err}`);
    }
  }
  const diffPaths = new Set<string>([
    ...diff.modified.map((c) => c.path),
    ...diff.added.map((c) => c.path),
    ...diff.removed,
  ]);

  // Pre-pull: copy aside every file the pull is about to overwrite or delete
  // that has local changes. See pull-local-changes.ts for what happens to
  // them afterwards. This runs before anything in the workspace is touched,
  // and a failure here stops the pull.
  const guard = new LocalChangeGuard(
    workspace.localPath,
    `cl${changelistNumber}`,
  );
  timer.stage("protect");
  onStep?.("Protecting local changes");
  for (const change of diff.modified) {
    const localFile = workspaceState.files[change.path];
    if (localFile && localFile.changelist === change.cl) continue; // up to date
    await guard.protect(change.path, "modified", localFile);
  }
  for (const change of diff.added) {
    await guard.protect(change.path, "added", workspaceState.files[change.path]);
  }
  for (const removedPath of diff.removed) {
    await guard.protect(
      removedPath,
      "removed",
      workspaceState.files[removedPath],
    );
  }
  for (const strayPath of anomalies.stray) {
    if (diffPaths.has(strayPath)) continue;
    await guard.protect(strayPath, "added", workspaceState.files[strayPath]);
  }
  for (const entry of anomalies.stale) {
    if (diffPaths.has(entry.path)) continue;
    await guard.protect(
      entry.path,
      "modified",
      workspaceState.files[entry.path],
    );
  }
  if (guard.files.length > 0) {
    Logger.info(
      `Pull will touch ${guard.files.length} file(s) with local changes; copies kept in ${guard.backupRoot}`,
    );
  }

  // ─── Longtail pull ────────────────────────────────────────────────
  const blockCachePath =
    (daemonConfig.longtail.enableBlockCache ?? true)
      ? path.join(homedir(), ".checkpoint", "cache", "blocks")
      : undefined;
  let errored = false;
  let lastStep = "";
  let nativePasses = 0;
  timer.stage("native");
  for (const versionIndex of versionsToPull) {
    if (versionIndex === "") {
      continue;
    }
    nativePasses++;

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
  timer.count("added", diff.added.length);
  timer.count("modified", diff.modified.length);
  timer.count("removed", diff.removed.length);
  timer.count("nativePasses", nativePasses);
  timer.count("stray", anomalies.stray.length);
  timer.count("stale", anomalies.stale.length);
  timer.count("localChanges", guard.files.length);
  if (!errored) {
    // Handle deletions (paths come straight from the diff; no getFiles needed).
    timer.stage("delete");
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

    // ─── Correction pass ───────────────────────────────────────────
    // Undo what the applied version indexes wrote beyond the diff. This used
    // to exist only for syncing backward, where it is common; it can happen
    // going forward too (a file added and later deleted leaves a stray, and
    // histories merged before merges were three-way can leave stale content).
    //
    // Files restored here that are not part of the diff keep their existing
    // state entry, so their new size and mtime are collected to update it.
    const restoredUnchanged = new Map<string, { size: number; mtime: number }>();
    timer.stage("correction");
    if (anomalies.stray.length > 0 || anomalies.stale.length > 0) {
      onStep?.("Verifying pulled files");
      Logger.info(
        `Pull correction: removing ${anomalies.stray.length} stray file(s), restoring ${anomalies.stale.length}`,
      );

      for (const strayPath of anomalies.stray) {
        if (diffPaths.has(strayPath)) continue; // the delete pass handled it
        const fullPath = path.join(workspace.localPath, strayPath);
        if (existsSync(fullPath)) {
          await fs.rm(fullPath, { force: true });
        }
        // An untracked local file that happened to sit at this path is not
        // the server's business: put it back exactly as it was.
        await guard.putBack(strayPath);
      }

      let restoredCount = 0;
      onProgress?.("Verifying pulled files", 0, anomalies.stale.length);
      for (const entry of anomalies.stale) {
        const fullPath = path.join(workspace.localPath, entry.path);
        // Not on disk means the pull never wrote it (filtered out).
        if (existsSync(fullPath)) {
          const result = await readFileFromChangelist({
            workspace,
            filePath: entry.path,
            changelistNumber: entry.cl,
          });
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.copyFile(result.cachePath, fullPath);

          if (!diffPaths.has(entry.path)) {
            // The workspace already had this version and the pull should not
            // have touched it. Local edits were made on top of exactly this
            // content, so they go straight back.
            if (!(await guard.putBack(entry.path))) {
              const stat = await fs.stat(fullPath);
              restoredUnchanged.set(entry.path, {
                size: stat.size,
                mtime: stat.mtimeMs,
              });
            }
          }
        }
        restoredCount++;
        onProgress?.(
          "Verifying pulled files",
          restoredCount,
          anomalies.stale.length,
        );
      }
    }

    // ─── Post-pull: settle files that had local changes ────────────
    const mergeResult: PullMergeResult = {
      cleanMerges: [],
      conflictMerges: [],
      localChangesSetAside: [],
    };
    // Baselines for merged files: what the server's version looked like, so
    // the local edits a merged file contains still show as local edits.
    const incomingBaselines = new Map<
      string,
      { size: number; mtime: number; md5: string }
    >();

    timer.stage("mergeLocal");
    if (guard.files.length > 0) {
      onStep?.("Merging local changes");
      const resolved = await guard.resolve(
        (relativePath) => isBinaryFile(relativePath, binaryExts),
        async (relativePath, baseCl) => {
          const baseResult = await readFileFromChangelist({
            workspace,
            filePath: relativePath,
            changelistNumber: baseCl,
          });
          return fs.readFile(baseResult.cachePath);
        },
      );

      for (const merged of resolved.merged) {
        incomingBaselines.set(merged.relativePath, merged.incoming);
        if (merged.clean) {
          mergeResult.cleanMerges.push(merged.relativePath);
        } else {
          mergeResult.conflictMerges.push(merged.relativePath);
        }
      }
      for (const file of resolved.setAside) {
        Logger.warn(`Local changes set aside by pull: ${describeSetAside(file)}`);
        mergeResult.localChangesSetAside.push(file);
        // Clients that only know about conflictMerges still need to tell the
        // user this file wants attention.
        mergeResult.conflictMerges.push(file.relativePath);
      }
    }

    // Update workspace state incrementally from the diff: start from the old
    // state, drop removed files, and re-record added/modified ones. Unchanged
    // files keep their existing entry (and hash). Hashes are deferred (md5 "");
    // the size+mtime baseline is enough until change detection needs them.
    onStep?.("Updating workspace state");
    timer.stage("state");

    // Only the paths the pull touched are written; everything else keeps its
    // existing entry (and hash).
    const newFiles: Record<string, WorkspaceStateFile> = {};

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
      const incoming = incomingBaselines.get(change.path);
      if (incoming) {
        newFiles[change.path] = {
          fileId: change.fileId,
          changelist: change.cl,
          md5: incoming.md5,
          size: incoming.size,
          mtime: incoming.mtime,
        };
      } else if (stat) {
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

    for (const [restoredPath, stat] of restoredUnchanged) {
      const existing =
        newFiles[restoredPath] ?? workspaceState.files[restoredPath];
      if (existing) {
        newFiles[restoredPath] = {
          ...existing,
          md5: "",
          size: stat.size,
          mtime: stat.mtime,
        };
      }
    }

    await updateWorkspaceState(
      workspace,
      {
        files: { delete: diff.removed, upsert: newFiles },
        meta: { changelistNumber: changelistResponse.number },
      },
      stateBackend,
    );

    timer.log("pull-timing");
    if (changed.length > 0) {
      mergeResult.pulledPaths = changed.map((change) => change.path);
    }
    const touched = new Set<string>([
      ...diffPaths,
      ...anomalies.stray,
      ...anomalies.stale.map((entry) => entry.path),
      ...guard.files.map((file) => file.relativePath),
    ]);
    if (touched.size > 0) {
      mergeResult.touchedPaths = [...touched];
    }
    if (
      diff.added.length > 0 ||
      diff.removed.length > 0 ||
      anomalies.stray.length > 0
    ) {
      mergeResult.trackedSetChanged = true;
    }
    return mergeResult;
  }

  if (errored) {
    timer.log("pull-timing");
    // The workspace state was not advanced, so as far as it is concerned the
    // local versions are still the current ones. Put them back over whatever
    // the partial pull wrote.
    await guard.restoreAll();
    throw new Error("Pull failed: " + lastStep);
  }

  // Should not reach here: errored throws above, and !errored returns above
  return { cleanMerges: [], conflictMerges: [], localChangesSetAside: [] };
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
    name: workspace.domainBranchName,
  });

  if (!branchResponse) {
    throw new Error("Could not get branch information");
  }

  const remoteHeadNumber = branchResponse.headNumber;

  // Already at head, nothing to do
  if (workspaceState.changelistNumber === remoteHeadNumber) {
    return { cleanMerges: [], conflictMerges: [], localChangesSetAside: [] };
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
    currentContent: Buffer;
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
      const currentContent = await fs.readFile(fullPath);
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
    return { cleanMerges: [], conflictMerges: [], localChangesSetAside: [] };
  }

  // Perform 3-way merge for each candidate
  const mergeResult: PullMergeResult = {
    cleanMerges: [],
    conflictMerges: [],
    localChangesSetAside: [],
  };
  const patched: Record<string, WorkspaceStateFile> = {};

  for (const candidate of candidates) {
    try {
      // Read base version (the version our local state was based on)
      const baseResult = await readFileFromChangelist({
        workspace,
        filePath: candidate.relativePath,
        changelistNumber: candidate.baseCl,
      });
      const baseContent = await fs.readFile(baseResult.cachePath);

      // Read incoming version (remote head)
      const incomingResult = await readFileFromChangelist({
        workspace,
        filePath: candidate.relativePath,
        changelistNumber: candidate.remoteCl,
      });
      const incomingContent = await fs.readFile(incomingResult.cachePath);

      // Decoding bytes that are not UTF-8 and writing the result back would
      // corrupt the file. Leave it alone and block the submit instead: the
      // local copy is out of date and cannot be merged here.
      if (
        !isMergeableText(baseContent) ||
        !isMergeableText(candidate.currentContent) ||
        !isMergeableText(incomingContent)
      ) {
        mergeResult.conflictMerges.push(candidate.relativePath);
        continue;
      }

      // 3-way merge
      const merged = autoMergeText(
        baseContent.toString("utf8"),
        candidate.currentContent.toString("utf8"),
        incomingContent.toString("utf8"),
      );

      // Write merged content back to disk
      const fullPath = path.join(workspace.localPath, candidate.relativePath);
      await fs.writeFile(fullPath, merged.content, "utf-8");

      if (merged.clean) {
        mergeResult.cleanMerges.push(candidate.relativePath);
      } else {
        mergeResult.conflictMerges.push(candidate.relativePath);
      }

      // Patch just this file's entry in workspace state: it is now based on
      // the incoming changelist. The baseline is the incoming version, not the
      // merged file. Recording the merged file as the baseline would make the
      // local edits in it look like no change at all, and they would drop out
      // of the pending list if this submit did not go through.
      const incomingStat = await fs.stat(incomingResult.cachePath);
      patched[candidate.relativePath] = {
        fileId: candidate.fileId,
        changelist: candidate.remoteCl,
        md5: await hashFileMD5(incomingResult.cachePath),
        size: incomingStat.size,
        // No file on disk has the incoming content, so there is no mtime that
        // means "unchanged"; zero forces a hash comparison.
        mtime: 0,
      };
    } catch (err) {
      console.error(
        `Pre-submit auto-merge failed for ${candidate.relativePath}:`,
        err,
      );
      // The file on disk is still the local version, which is still based on
      // an old changelist. Do not let it be submitted as if it were current.
      mergeResult.conflictMerges.push(candidate.relativePath);
    }
  }

  // Record the patched file entries; head CL is NOT changed
  await updateWorkspaceState(
    workspace,
    { files: { upsert: patched } },
    textPullBackend,
  );

  return mergeResult;
}
