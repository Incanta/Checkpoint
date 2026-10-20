import {
  CreateApiClientAuth,
  type WorkspaceStateFile,
  hashFileMD5,
} from "@checkpointvcs/common";
import {
  filterPaths,
  pullAsync,
  pullSelectionAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import {
  getWorkspaceState,
  syncTargetBranch,
  updateWorkspaceState,
  type InterruptedPull,
  type Workspace,
} from "./util.js";
import {
  toStorageOptions,
  resolveStorageEndpoints,
  STORAGE_PROTOCOL,
} from "./storage-options.js";
import { readFileFromChangelist } from "./read-file.js";
import { getBinaryExtensions, isBinaryFile } from "./binary-extensions.js";
import { autoMergeText } from "./auto-merge.js";
import {
  LocalChangeGuard,
  describeFailedPull,
  describeSetAside,
  hasLocalChanges,
  isMergeableText,
  type SetAsideFile,
} from "./pull-local-changes.js";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";
import { Logger } from "../logging.js";
import { DaemonConfig } from "../daemon-config.js";
import { StageTimer } from "./stage-timer.js";
import { workspacePathKey } from "./volume.js";
import { alignDirectorySpellings } from "./dir-spelling.js";
import { markPullRunning, recoverInterruptedPull } from "./interrupted-pull.js";
import {
  clearPullRecord,
  takePullRecord,
  type WrittenFile,
} from "./pull-record.js";
import {
  isSafeWorkspacePath,
  resolveInWorkspace,
  unsafePathReason,
} from "./workspace-path.js";

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
  /**
   * Paths the server sent that this workspace cannot safely hold (they climb
   * out of it, name its .checkpoint directory, or contain a ":" on Windows),
   * with why. They were neither written nor recorded.
   */
  unsafePaths?: { path: string; reason: string }[];
  /**
   * Files the server deleted that the pull could not remove (open in another
   * program, say), with why. They stay tracked and the next pull retries.
   */
  notRemoved?: { path: string; error: string }[];
  /**
   * On Windows, pulled paths of 260 characters or more (as written, or as
   * backed up), which Explorer and many tools cannot handle.
   */
  longPaths?: string[];
}

/** How far a pull got, for the cleanup around it (see pull). */
interface PullProgress {
  /** Set once the pull has recorded itself as interruptedPull. */
  guard?: LocalChangeGuard;
  committed: boolean;
}

/**
 * Brings the workspace to `changelistNumber` (the target branch's head when
 * null). A pull that died partway before (see interrupted-pull.ts) is
 * recovered first.
 */
export async function pull(
  ...args: Parameters<typeof pullOnce> extends [PullProgress, ...infer A]
    ? A
    : never
): Promise<PullMergeResult> {
  const [workspace] = args;
  const stateBackend = (await DaemonConfig.Get()).stateBackend;

  const recovered = await recoverInterruptedPull(workspace, stateBackend);
  if (recovered && recovered.restore.failed.length > 0) {
    // Pulling over them now would leave the local versions only in the old
    // backup folder, with nothing pointing at them.
    throw new Error(
      describeFailedPull(
        `Pull stopped: an earlier pull to changelist ${recovered.changelist} was interrupted, and some of your local changes it had set aside could not be put back yet. Close the programs using them and pull again`,
        recovered.restore,
      ),
    );
  }

  const progress: PullProgress = { committed: false };
  try {
    return await pullOnce(progress, ...args);
  } catch (err) {
    const guard = progress.guard;
    if (guard && !progress.committed && guard.files.length > 0) {
      // A failure the steps after the native write did not handle
      // themselves: put the local versions back, as they do.
      const restore = await guard.restoreAll();
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(describeFailedPull(`Pull failed: ${cause}`, restore), {
        cause: err,
      });
    }
    throw err;
  } finally {
    const guard = progress.guard;
    if (guard) {
      markPullRunning(guard.backupRoot, false);
      if (!progress.committed) {
        // The record stays, so submits wait for a pull that completes: files
        // the native pass wrote look like local changes until then. Marked
        // restored once nothing is left in the journal to put back.
        await recoverInterruptedPull(workspace, stateBackend).catch((e) =>
          Logger.warn(`Could not settle the failed pull's record: ${e}`),
        );
      }
    }
  }
}

async function pullOnce(
  progress: PullProgress,
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
  /**
   * Optional hook supplying files the target has that the workspace should
   * have but does not track, and that no diff will mention again: files a
   * narrower sync filter left out, after the filter widens. They are pulled
   * as additions. Called once the diff is known.
   */
  resolveMissing?: (
    changelistNumber: number,
    trackedPaths: ReadonlySet<string>,
  ) => Promise<{ path: string; cl: number; fileId: string }[]>,
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
    clientProtocol: STORAGE_PROTOCOL,
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
      clientProtocol: STORAGE_PROTOCOL,
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

  // The branch this pull brings the workspace to (see syncTargetBranch).
  const targetBranch = syncTargetBranch(workspace);
  if (changelistNumber === null) {
    const branchResponse = await client.branch.getBranch.query({
      repoId: workspace.repoId,
      name: targetBranch,
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
  const serverDiff = await client.changelist.diffChangelists.query({
    repoId: workspace.repoId,
    fromNumber: workspaceState.changelistNumber,
    toNumber: changelistNumber,
  });

  // Paths this daemon must not touch (see workspace-path.ts) are neither
  // written, deleted, nor recorded: a recorded path that cannot exist on disk
  // would show as deleted, and "submit everything" would delete it for the
  // team. They are reported instead. A removed one still leaves the state.
  const unsafePaths: { path: string; reason: string }[] = [];
  const keepSafe = <T extends { path: string }>(changes: T[]): T[] =>
    changes.filter((c) => {
      const reason = unsafePathReason(c.path);
      if (reason) unsafePaths.push({ path: c.path, reason });
      return !reason;
    });
  const unsafeRemoved = serverDiff.removed.filter(
    (p) => !isSafeWorkspacePath(p),
  );
  const diff = {
    ...serverDiff,
    added: keepSafe(serverDiff.added),
    modified: keepSafe(serverDiff.modified),
    removed: serverDiff.removed.filter((p) => isSafeWorkspacePath(p)),
  };
  if (resolveMissing) {
    const known = new Set<string>([
      ...Object.keys(workspaceState.files),
      ...diff.added.map((c) => c.path),
      ...diff.modified.map((c) => c.path),
      ...diff.removed,
    ]);
    const missing = keepSafe(
      (await resolveMissing(changelistNumber, known)).filter(
        (c) => !known.has(c.path),
      ),
    );
    if (missing.length > 0) {
      Logger.info(
        `Pull: bringing in ${missing.length} file(s) the sync filter now includes`,
      );
      diff.added = [...diff.added, ...missing];
      diff.changelistsToPull = [
        ...new Set([...diff.changelistsToPull, ...missing.map((c) => c.cl)]),
      ];
    }
  }
  if (unsafePaths.length > 0) {
    Logger.warn(
      `Pull: not syncing ${unsafePaths.length} path(s) this workspace cannot safely hold: ${unsafePaths
        .map((u) => `${u.path} (${u.reason})`)
        .join(", ")}`,
    );
  }

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
  const versionByCl = new Map<number, string>(
    sortedChangelists.map((cl: any) => [cl.number, cl.versionIndex]),
  );

  // The paths the pull brings in, each from its own source changelist. When
  // every source has a version index they are written in one native pass
  // that touches nothing else (see pull-selection.cpp). Otherwise, or if the
  // native side declines, each source's whole index is applied in turn as
  // before, with the stray/stale correction that requires.
  const incoming = [...diff.added, ...diff.modified];
  let singlePass = incoming.every((c) => (versionByCl.get(c.cl) ?? "") !== "");

  // A changelist's version index holds everything that changelist touched,
  // so applying it whole can write paths the diff says nothing about: a file
  // a later changelist deleted (a stray), or a file whose current version
  // comes from some other changelist (a stale write). Only the per-index path
  // needs to know which; ask the server, so local files at those paths can be
  // protected and the workspace corrected afterwards.
  let anomalies: {
    stray: string[];
    stale: { path: string; cl: number }[];
    /** Every path the indexes write (servers from before it omit it). */
    written?: string[];
  } = {
    stray: [],
    stale: [],
  };
  const loadAnomalies = async (): Promise<void> => {
    const pulledNumbers: number[] = sortedChangelists
      .filter((cl: any) => cl.versionIndex !== "")
      .map((cl: any) => cl.number);
    if (pulledNumbers.length === 0) return;
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
  };
  timer.stage("anomalies");
  if (!singlePass) await loadAnomalies();
  const diffPaths = new Set<string>([
    ...diff.modified.map((c) => c.path),
    ...diff.added.map((c) => c.path),
    ...diff.removed,
  ]);

  // On a volume that takes two spellings for one file (see volume.ts), a
  // removed path and an added one that fold together are a rename by case
  // or normalization: the file is renamed in place before anything is
  // written, so the write lands on it and no delete removes it afterwards.
  // And a removed path is never deleted from disk while a path that stays in
  // the tree still names the same file.
  const pathKey = await workspacePathKey(workspace.localPath);
  const renamedFrom = new Map<string, string>(); // new spelling -> old
  const remainingKeys = new Set<string>();
  if (pathKey) {
    const removedSet = new Set(diff.removed);
    for (const p of Object.keys(workspaceState.files)) {
      if (!removedSet.has(p)) remainingKeys.add(pathKey(p));
    }
    for (const c of [...diff.added, ...diff.modified]) {
      remainingKeys.add(pathKey(c.path));
    }
    const removedByKey = new Map(diff.removed.map((p) => [pathKey(p), p]));
    for (const c of diff.added) {
      const old = removedByKey.get(pathKey(c.path));
      if (old !== undefined && old !== c.path && workspaceState.files[old]) {
        renamedFrom.set(c.path, old);
      }
    }
    for (const [to, from] of renamedFrom) {
      const fromPath = resolveInWorkspace(workspace.localPath, from);
      if (existsSync(fromPath)) {
        await fs.rename(fromPath, resolveInWorkspace(workspace.localPath, to));
      }
    }
    if (renamedFrom.size > 0) {
      Logger.info(
        `Pull: renamed ${renamedFrom.size} file(s) in place, by case or normalization only`,
      );
    }
  }
  const renamedAway = new Set(renamedFrom.values());

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
  // Written partway by a pull that failed, and left as it was: nothing to
  // keep, and the pull writes it whole now.
  const partial = workspaceState.interruptedPull?.partial;
  const leftPartway = (p: string) =>
    leftByFailedPull(resolveInWorkspace(workspace.localPath, p), partial, p);
  for (const change of diff.modified) {
    const localFile = workspaceState.files[change.path];
    // Already at the incoming changelist (this workspace submitted it): the
    // single pass leaves the file alone. Applying whole indexes rewrites it,
    // which protectAnomalies covers.
    if (localFile && localFile.changelist === change.cl) continue;
    if (await leftPartway(change.path)) continue;
    await guard.protect(change.path, "modified", localFile);
  }
  for (const change of diff.added) {
    if (await leftPartway(change.path)) continue;
    // A file renamed in place above is the tracked file under its new name.
    const old = renamedFrom.get(change.path);
    await guard.protect(
      change.path,
      old !== undefined ? "modified" : "added",
      workspaceState.files[change.path] ??
        (old !== undefined ? workspaceState.files[old] : undefined),
    );
  }
  for (const removedPath of diff.removed) {
    if (renamedAway.has(removedPath)) continue; // protected under its new name
    await guard.protect(
      removedPath,
      "removed",
      workspaceState.files[removedPath],
    );
  }
  // Paths whole indexes rewrite with the version the workspace already has:
  // after the native pass, any local edits go straight back on top, and the
  // workspace state keeps its entry. Only used when applying whole indexes.
  const putBackAfterNative = new Set<string>();
  const protectAnomalies = async (): Promise<void> => {
    if (singlePass) return;
    for (const change of diff.modified) {
      const localFile = workspaceState.files[change.path];
      if (localFile && localFile.changelist === change.cl) {
        await guard.protect(change.path, "modified", localFile);
        putBackAfterNative.add(change.path);
      }
    }
    const anomalous = new Set<string>([
      ...anomalies.stray,
      ...anomalies.stale.map((e) => e.path),
    ]);
    for (const writtenPath of anomalies.written ?? []) {
      if (
        diffPaths.has(writtenPath) ||
        anomalous.has(writtenPath) ||
        !isSafeWorkspacePath(writtenPath)
      ) {
        continue;
      }
      await guard.protect(
        writtenPath,
        "modified",
        workspaceState.files[writtenPath],
      );
      putBackAfterNative.add(writtenPath);
    }
    for (const strayPath of anomalies.stray) {
      if (diffPaths.has(strayPath) || !isSafeWorkspacePath(strayPath)) continue;
      await guard.protect(strayPath, "added", workspaceState.files[strayPath]);
    }
    for (const entry of anomalies.stale) {
      if (diffPaths.has(entry.path) || !isSafeWorkspacePath(entry.path)) {
        continue;
      }
      await guard.protect(
        entry.path,
        "modified",
        workspaceState.files[entry.path],
      );
    }
  };
  await protectAnomalies();
  if (guard.files.length > 0) {
    Logger.info(
      `Pull will touch ${guard.files.length} file(s) with local changes; copies kept in ${guard.backupRoot}`,
    );
  }

  // From here the pull writes to the workspace. Recorded before the first
  // write and cleared with the state update that records what it wrote, so
  // a pull that dies in between is put right on the next start (see
  // interrupted-pull.ts).
  markPullRunning(guard.backupRoot, true);
  progress.guard = guard;
  await updateWorkspaceState(
    workspace,
    {
      meta: {
        interruptedPull: {
          changelist: changelistNumber,
          backupRoot: guard.backupRoot,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
      },
    },
    stateBackend,
  );

  // Windows paths of 260 characters or more: Checkpoint writes them (through
  // \\?\ paths), but Explorer and many tools cannot open, move, or delete
  // them. Counted as written and, for files with local changes, as backed up
  // (the backup folder adds its own prefix). Reported, not refused.
  const longPaths: string[] = [];
  if (process.platform === "win32") {
    const LIMIT = 260;
    const backedUp = new Set(guard.files.map((f) => f.relativePath));
    for (const c of incoming) {
      const written = path.resolve(workspace.localPath, c.path).length;
      const backup = backedUp.has(c.path)
        ? path.join(guard.backupRoot, c.path).length
        : 0;
      if (written >= LIMIT || backup >= LIMIT) longPaths.push(c.path);
    }
    if (longPaths.length > 0) {
      Logger.warn(
        `Pull: ${longPaths.length} path(s) are ${LIMIT} characters or longer here, which Explorer and many Windows tools cannot handle: ${longPaths.slice(0, 10).join(", ")}`,
      );
    }
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

  // Paths the include rules keep. Excluded ones are neither written nor
  // recorded in the workspace state.
  const included =
    includePaths && includePaths.length > 0
      ? filterPaths(
          includePaths,
          incoming.map((c) => c.path),
        )
      : null;
  const stateIncoming = singlePass
    ? incoming.filter((_, i) => !included || included[i])
    : incoming;

  // Polling shared by both native paths.
  const pollNative = async (handle: any) => {
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
    try {
      return await pollHandle(handle, pollOptions);
    } finally {
      freeHandle(handle);
    }
  };

  // Each file's size, mtime, and mode as the native passes wrote it.
  const writtenByNative = new Map<string, WrittenFile>();

  // Local mode changes (chmod +x) on files the pull rewrites. The pull
  // applies the incoming version's mode; when upstream did not change the
  // mode, the local change goes back on top and stays pending.
  const localModes = new Map<string, number>();
  /** Paths whose local mode was put back over the incoming one. */
  const modesPutBack = new Set<string>();
  if (process.platform !== "win32") {
    for (const change of diff.modified) {
      const entry = workspaceState.files[change.path];
      if (entry?.mode === undefined) continue;
      try {
        const mode =
          (await fs.stat(resolveInWorkspace(workspace.localPath, change.path)))
            .mode & 0o777;
        if (mode !== entry.mode) localModes.set(change.path, mode);
      } catch {
        // Not on disk: nothing to keep.
      }
    }
  }

  // What the native pass writes: every incoming path when whole indexes are
  // applied, or just the selections in a single pass.
  let selections: typeof stateIncoming = stateIncoming;
  if (singlePass) {
    // A path the workspace already has at its source changelist is skipped:
    // its file is the one the changelist wrote, plus whatever local edits the
    // guard is keeping track of.
    selections = stateIncoming.filter(
      (c) => workspaceState.files[c.path]?.changelist !== c.cl,
    );
    if (selections.length > 0) {
      const sources: string[] = [];
      const sourceIndex = new Map<string, number>();
      const selectionSources = selections.map((c) => {
        const name = versionByCl.get(c.cl)!;
        let index = sourceIndex.get(name);
        if (index === undefined) {
          index = sources.length;
          sources.push(name);
          sourceIndex.set(name, index);
        }
        return index;
      });

      await clearPullRecord(workspace.localPath);
      const handle = pullSelectionAsync({
        sources,
        selectionPaths: selections.map((c) => c.path),
        selectionSources,
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
      nativePasses = 1;
      timer.count("selected", selections.length);
      timer.count("sources", sources.length);
      const { status, result } = await pollNative(handle);
      // A pass that stopped partway lists only the files it wrote whole.
      await takePullRecord(workspace.localPath, writtenByNative);
      if (result) Logger.debug(`[pull-selection] ${JSON.stringify(result)}`);
      if (status.error !== 0) {
        if (/different hashing or chunk sizes/.test(status.currentStep)) {
          // Sources that cannot share one index: apply them one at a time.
          Logger.info(
            "Pull: sources differ in hashing or chunking; applying each changelist in turn",
          );
          singlePass = false;
          selections = stateIncoming;
        } else {
          Logger.error(
            `Pull failed with exit code: ${status.error} and last step ${status.currentStep}`,
          );
          lastStep = status.currentStep;
          errored = true;
        }
      }
    }
  }

  if (!singlePass && !errored) {
    if (anomalies.stray.length === 0 && anomalies.stale.length === 0) {
      await loadAnomalies();
      await protectAnomalies();
    }
  }

  // A whole version index is applied as it is, so it would write the unsafe
  // paths the single pass leaves out. Refuse before anything is written.
  const unsafeInIndexes = [
    ...unsafePaths.map((u) => u.path),
    ...anomalies.stray.filter((p) => !isSafeWorkspacePath(p)),
    ...anomalies.stale
      .map((e) => e.path)
      .filter((p) => !isSafeWorkspacePath(p)),
  ];
  if (!singlePass && !errored && unsafeInIndexes.length > 0) {
    throw new Error(
      `Pull refused: the changelists to apply contain paths this workspace cannot safely hold (${unsafeInIndexes.join(", ")}), and they can only be applied whole here`,
    );
  }

  for (const versionIndex of singlePass || errored ? [] : versionsToPull) {
    if (versionIndex === "") {
      continue;
    }
    nativePasses++;

    Logger.debug(
      `Starting longtail pull for version index ${versionIndex} for workspace ${workspace.workspaceName}...`,
    );

    await clearPullRecord(workspace.localPath);
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
    if (status.error === 0) {
      await takePullRecord(workspace.localPath, writtenByNative);
    }

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
    try {
      for (const [modePath, localMode] of localModes) {
        const fullPath = resolveInWorkspace(workspace.localPath, modePath);
        const base = workspaceState.files[modePath]?.mode;
        const incoming =
          writtenByNative.get(modePath)?.mode ??
          (await fs.stat(fullPath).catch(() => null))?.mode;
        if (incoming !== undefined && (incoming & 0o777) === base) {
          await fs.chmod(fullPath, localMode).then(
            () => modesPutBack.add(modePath),
            () => undefined,
          );
        }
      }

      // Handle deletions (paths come straight from the diff; no getFiles needed).
      // A file that cannot be removed (open in another program, a directory
      // in its place) does not stop the pull. It stays tracked, so it never
      // looks like an untracked file to add back, and the next pull retries
      // it (WorkspaceState.pendingRemovals). Earlier pulls' leftovers go first.
      timer.stage("delete");
      const notRemoved: { path: string; error: string }[] = [];
      const retried = (workspaceState.pendingRemovals ?? []).filter(
        (p) =>
          !diffPaths.has(p) &&
          isSafeWorkspacePath(p) &&
          workspaceState.files[p] !== undefined,
      );
      const removedNow: string[] = [];
      const toRemove = [
        ...retried,
        ...diff.removed.filter((p) => !renamedAway.has(p)),
      ];
      if (toRemove.length > 0) {
        onStep?.("Deleting removed files");
        let deletedCount = 0;
        const deleteTotal = toRemove.length;
        onProgress?.("Deleting removed files", 0, deleteTotal);

        for (const removedPath of toRemove) {
          const filePath = resolveInWorkspace(workspace.localPath, removedPath);
          if (
            pathKey &&
            deletedCount >= retried.length &&
            remainingKeys.has(pathKey(removedPath))
          ) {
            // Another path in the tree names this same file here. Drop the
            // removed spelling from the state; keep the file.
            deletedCount++;
            continue;
          }
          const isRetry = deletedCount < retried.length;
          try {
            if (
              isRetry &&
              (await hasLocalChanges(
                filePath,
                workspaceState.files[removedPath],
              ))
            ) {
              // Edited since: it is the user's now. It stays tracked (a
              // modified file the server deleted, which a submit cannot
              // quietly re-add), and the pull stops retrying it.
            } else {
              if (existsSync(filePath)) {
                await fs.rm(filePath, { force: true });
              }
              if (isRetry) removedNow.push(removedPath);
            }
          } catch (err) {
            notRemoved.push({
              path: removedPath,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          deletedCount++;
          onProgress?.("Deleting removed files", deletedCount, deleteTotal);
        }
        if (notRemoved.length > 0) {
          Logger.warn(
            `Pull: could not remove ${notRemoved.length} file(s) the server deleted; will retry: ${notRemoved
              .map((n) => `${n.path} (${n.error})`)
              .join(", ")}`,
          );
        }
      }
      const stillPending = new Set(notRemoved.map((n) => n.path));

      // ─── Correction pass ───────────────────────────────────────────
      // Undo what the applied version indexes wrote beyond the diff. This used
      // to exist only for syncing backward, where it is common; it can happen
      // going forward too (a file added and later deleted leaves a stray, and
      // histories merged before merges were three-way can leave stale content).
      //
      // Files restored here that are not part of the diff keep their existing
      // state entry, so their new size and mtime are collected to update it.
      const restoredUnchanged = new Map<
        string,
        { size: number; mtime: number }
      >();
      for (const rewritten of putBackAfterNative) {
        const fullPath = resolveInWorkspace(workspace.localPath, rewritten);
        if (!existsSync(fullPath)) continue;
        if (!(await guard.putBack(rewritten))) {
          // No local edits: the index wrote the same content again, under a
          // new mtime. Record that, or it would look edited.
          const stat = await fs.stat(fullPath);
          restoredUnchanged.set(rewritten, {
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        }
      }
      timer.stage("correction");
      if (anomalies.stray.length > 0 || anomalies.stale.length > 0) {
        onStep?.("Verifying pulled files");
        Logger.info(
          `Pull correction: removing ${anomalies.stray.length} stray file(s), restoring ${anomalies.stale.length}`,
        );

        for (const strayPath of anomalies.stray) {
          if (diffPaths.has(strayPath)) continue; // the delete pass handled it
          if (!isSafeWorkspacePath(strayPath)) continue;
          const fullPath = resolveInWorkspace(workspace.localPath, strayPath);
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
          if (!isSafeWorkspacePath(entry.path)) continue;
          const fullPath = resolveInWorkspace(workspace.localPath, entry.path);
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
          Logger.warn(
            `Local changes set aside by pull: ${describeSetAside(file)}`,
          );
          mergeResult.localChangesSetAside.push(file);
          // Clients that only know about conflictMerges still need to tell the
          // user this file wants attention.
          mergeResult.conflictMerges.push(file.relativePath);
        }
      }

      // A directory the tree renamed by case keeps its old spelling on disk
      // (files renamed into it land in it as it is). Rename it to match, or
      // the scan takes the difference for a rename the user made.
      let pendingDirRenames: string[] | undefined;
      if (
        pathKey &&
        (diff.added.length > 0 ||
          (workspaceState.pendingDirRenames ?? []).length > 0)
      ) {
        const removedSet = new Set(diff.removed);
        const aligned = await alignDirectorySpellings(
          workspace.localPath,
          pathKey,
          {
            before: Object.keys(workspaceState.files),
            after: [
              ...Object.keys(workspaceState.files).filter(
                (p) => !removedSet.has(p),
              ),
              ...diff.added.map((c) => c.path),
            ],
            added: diff.added.map((c) => c.path),
            retry: workspaceState.pendingDirRenames ?? [],
          },
        );
        if (aligned.renamed.length > 0) {
          Logger.info(
            `Pull: renamed ${aligned.renamed.length} director${aligned.renamed.length === 1 ? "y" : "ies"} in place, by case or normalization only: ${aligned.renamed.join(", ")}`,
          );
        }
        if (aligned.failed.length > 0) {
          Logger.warn(
            `Pull: could not rename ${aligned.failed.length} director${aligned.failed.length === 1 ? "y" : "ies"} to the tree's spelling; will retry: ${aligned.failed
              .map((f) => `${f.path} (${f.error})`)
              .join(", ")}`,
          );
        }
        pendingDirRenames = aligned.failed.map((f) => f.path);
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

      // Only what the pull wrote. A path it skipped because the workspace
      // already had it at the incoming changelist keeps its entry: the file
      // may hold edits made after this workspace submitted it, and re-recording
      // its size and mtime now would hide them (and let a later pull
      // overwrite them).
      const changed = selections.filter((c) => !putBackAfterNative.has(c.path));
      // Entries pulled from a feature branch's head say so (absent means the
      // domain root), so a submit there can tell which head they match.
      const fromBranch =
        targetBranch !== workspace.domainBranchName ? targetBranch : undefined;
      const stateTotal = changed.length;
      onProgress?.("Updating workspace state", 0, stateTotal);

      // What the native pass reports it wrote, as each file was finished:
      // a stat taken now would record an edit made since as the pulled
      // version. Addons that report nothing leave the stat as the fallback.
      // The hash the native pass took of the bytes it wrote is the pulled
      // version's content, so recording it closes the gap a hash taken now
      // (stampBaselines, for racily clean files) would leave: a same-size
      // edit made since, in the same timestamp tick, would be hashed as the
      // pulled version and never show as a change.
      const posix = process.platform !== "win32";
      const statResults: {
        change: (typeof changed)[number];
        stat: { size: number; mtimeMs: number } | null;
        mode: number | undefined;
        md5?: string;
      }[] = await Promise.all(
        changed.map(async (change) => {
          const recorded = writtenByNative.get(change.path);
          if (recorded) {
            return {
              change,
              stat: { size: recorded.size, mtimeMs: recorded.mtimeMs },
              mode: recorded.mode,
              md5: recorded.md5,
            };
          }
          const fullPath = path.join(workspace.localPath, change.path);
          try {
            const stat = await fs.stat(fullPath);
            return {
              change,
              stat,
              // The pulled version's mode, even where a local change was
              // put back on top of it (that change stays pending).
              mode: modesPutBack.has(change.path)
                ? workspaceState.files[change.path]?.mode
                : posix
                  ? stat.mode & 0o777
                  : undefined,
            };
          } catch {
            return { change, stat: null, mode: undefined };
          }
        }),
      );
      for (let i = 0; i < statResults.length; i++) {
        const { change, stat, mode: writtenMode, md5 } = statResults[i]!;
        // The mode the pulled version has: what the pull applied, or (from
        // an addon that does not say) the one it had before.
        const mode = writtenMode ?? workspaceState.files[change.path]?.mode;
        const incoming = incomingBaselines.get(change.path);
        if (incoming) {
          newFiles[change.path] = {
            fileId: change.fileId,
            changelist: change.cl,
            md5: incoming.md5,
            size: incoming.size,
            mtime: incoming.mtime,
            ...(mode !== undefined && { mode }),
            ...(fromBranch && { branch: fromBranch }),
          };
        } else if (stat) {
          newFiles[change.path] = {
            fileId: change.fileId,
            changelist: change.cl,
            // Unknown ("") is hashed by stampBaselines if racily clean.
            md5: md5 ?? "",
            size: stat.size,
            mtime: stat.mtimeMs,
            ...(mode !== undefined && { mode }),
            ...(fromBranch && { branch: fromBranch }),
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

      // A mode set from Windows (pending.setExecutable) that the pulled
      // version already has, or for a file the pull removed, is done with;
      // kept, it would undo a later upstream mode change on the next edit.
      const deletedPaths = [
        ...diff.removed.filter((p) => !stillPending.has(p)),
        ...unsafeRemoved,
        ...removedNow.filter((p) => !stillPending.has(p)),
      ];
      let pendingModes: Record<string, number> | undefined;
      if (workspaceState.pendingModes) {
        const next = { ...workspaceState.pendingModes };
        for (const p of deletedPaths) delete next[p];
        for (const [p, f] of Object.entries(newFiles)) {
          if (next[p] !== undefined && next[p] === (f.mode ?? 0o644)) {
            delete next[p];
          }
        }
        if (
          Object.keys(next).length !==
          Object.keys(workspaceState.pendingModes).length
        ) {
          pendingModes = next;
        }
      }

      await updateWorkspaceState(
        workspace,
        {
          files: {
            delete: deletedPaths,
            upsert: newFiles,
          },
          meta: {
            changelistNumber: changelistResponse.number,
            pendingRemovals: [...stillPending],
            ...(pendingDirRenames !== undefined && { pendingDirRenames }),
            ...(pendingModes !== undefined && { pendingModes }),
            interruptedPull: null,
          },
        },
        stateBackend,
      );
      progress.committed = true;
      await guard.finish();

      timer.log("pull-timing");
      if (unsafePaths.length > 0) {
        mergeResult.unsafePaths = unsafePaths;
      }
      if (notRemoved.length > 0) {
        mergeResult.notRemoved = notRemoved;
      }
      if (longPaths.length > 0) {
        mergeResult.longPaths = longPaths;
      }
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
    } catch (err) {
      // Anything that fails after the native pass wrote files (reading a stale
      // file back, a merge, the state update) leaves the workspace state where
      // it was, so the local versions are still the current ones: put them
      // back, as for a native failure.
      timer.log("pull-timing");
      // Recorded already: the workspace copies are the current ones.
      if (progress.committed) throw err;
      const restore = await guard.restoreAll();
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(describeFailedPull(`Pull failed: ${cause}`, restore), {
        cause: err,
      });
    }
  }

  if (errored) {
    timer.log("pull-timing");
    // The workspace state was not advanced, so as far as it is concerned the
    // local versions are still the current ones. Put them back over whatever
    // the partial pull wrote.
    const guarded = new Set(guard.files.map((f) => f.relativePath));
    const restore = await guard.restoreAll();
    if (singlePass) {
      await recordPartialPull(
        workspace,
        stateBackend,
        selections,
        writtenByNative,
        guarded,
        renamedFrom,
        localModes,
        workspaceState,
        targetBranch !== workspace.domainBranchName ? targetBranch : undefined,
        restore.failed.length === 0,
      ).catch((e) =>
        Logger.warn(`Could not record the files the failed pull wrote: ${e}`),
      );
    }
    throw new Error(describeFailedPull("Pull failed: " + lastStep, restore));
  }

  // Should not reach here: errored throws above, and !errored returns above
  return { cleanMerges: [], conflictMerges: [], localChangesSetAside: [] };
}

/**
 * After a single pass that stopped partway (a file open in another program,
 * say), with local edits already put back: records each file it wrote whole
 * at its incoming changelist, as if that file had been pulled on its own, so
 * it does not look like a local edit. The workspace changelist stays where it
 * was, and the next pull brings in the rest.
 *
 * A selected file the pass changed without finishing (not in the record, and
 * no longer matching its entry) had no local edits, or the guard would have
 * kept it; it goes back to the version its entry names. Only once nothing is
 * left that could pass for a local edit is the interrupted-pull record
 * cleared, so submits are allowed again. Otherwise it stays, and submits wait
 * for a pull that completes.
 */
async function recordPartialPull(
  workspace: Workspace,
  stateBackend: Parameters<typeof updateWorkspaceState>[2],
  selections: { path: string; cl: number; fileId: string }[],
  written: Map<string, WrittenFile>,
  guarded: Set<string>,
  renamedFrom: Map<string, string>,
  localModes: Map<string, number>,
  workspaceState: Awaited<ReturnType<typeof getWorkspaceState>>,
  fromBranch: string | undefined,
  restoredAll: boolean,
): Promise<void> {
  const upsert: Record<string, WorkspaceStateFile> = {};
  const deleted: string[] = [];
  const partial: NonNullable<InterruptedPull["partial"]> = [];
  let settled = restoredAll;
  for (const change of selections) {
    if (guarded.has(change.path)) continue; // the local version is back
    const fullPath = resolveInWorkspace(workspace.localPath, change.path);
    const old = renamedFrom.get(change.path);
    const before =
      workspaceState.files[change.path] ??
      (old !== undefined ? workspaceState.files[old] : undefined);
    const recorded = written.get(change.path);
    if (recorded?.md5) {
      const mode = recorded.mode ?? before?.mode;
      upsert[change.path] = {
        fileId: change.fileId,
        changelist: change.cl,
        md5: recorded.md5,
        size: recorded.size,
        mtime: recorded.mtimeMs,
        ...(mode !== undefined && { mode }),
        ...(fromBranch && { branch: fromBranch }),
      };
      if (old !== undefined) deleted.push(old);
      // A local mode change the incoming version did not touch goes back on
      // top, as after a completed pull; it stays pending.
      const localMode = localModes.get(change.path);
      if (
        localMode !== undefined &&
        recorded.mode !== undefined &&
        (recorded.mode & 0o777) === before?.mode
      ) {
        await fs.chmod(fullPath, localMode).catch(() => undefined);
      }
      continue;
    }
    if (!existsSync(fullPath)) continue; // never written
    if (before && !(await hasLocalChanges(fullPath, before))) {
      continue; // untouched
    }
    try {
      if (before) {
        const result = await readFileFromChangelist({
          workspace,
          filePath: old ?? change.path,
          changelistNumber: before.changelist,
        });
        await fs.copyFile(result.cachePath, fullPath);
        const restored = await fs.stat(fullPath);
        upsert[old ?? change.path] = {
          ...before,
          md5: "",
          size: restored.size,
          mtime: restored.mtimeMs,
        };
      } else {
        // Not there before the pull (an untracked file would have been kept
        // by the guard): only the pull wrote it.
        await fs.rm(fullPath, { force: true });
      }
    } catch (err) {
      Logger.warn(
        `Pull: could not undo the partial write of ${change.path}: ${err}`,
      );
      settled = false;
      // Remembered as the pull left it, so the next pull does not take it
      // for a local edit and merge with it.
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat) {
        partial.push({
          path: change.path,
          size: stat.size,
          mtime: stat.mtimeMs,
        });
      }
    }
  }
  if (Object.keys(upsert).length > 0) {
    Logger.info(
      `Pull: recorded ${Object.keys(upsert).length} file(s) the failed pull finished writing`,
    );
  }
  let interruptedPull: InterruptedPull | null | undefined;
  if (settled) {
    interruptedPull = null;
  } else if (partial.length > 0) {
    const record = (await getWorkspaceState(workspace.localPath, stateBackend))
      .interruptedPull;
    if (record) interruptedPull = { ...record, partial };
  }
  if (
    Object.keys(upsert).length === 0 &&
    deleted.length === 0 &&
    interruptedPull === undefined
  ) {
    return;
  }
  await updateWorkspaceState(
    workspace,
    {
      files: { delete: deleted, upsert },
      ...(interruptedPull !== undefined && { meta: { interruptedPull } }),
    },
    stateBackend,
  );
}

/**
 * Whether a file is still as a failed pull left it partway written (see
 * InterruptedPull.partial): it holds no local edits to keep.
 */
async function leftByFailedPull(
  fullPath: string,
  partial: InterruptedPull["partial"],
  relativePath: string,
): Promise<boolean> {
  const left = Array.isArray(partial)
    ? partial.find((p) => p.path === relativePath)
    : undefined;
  if (!left) return false;
  const stat = await fs.stat(fullPath).catch(() => null);
  return (
    stat !== null && stat.size === left.size && stat.mtimeMs === left.mtime
  );
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
  /**
   * The branch being submitted to. Its head is what "outdated" means: a
   * feature branch's own earlier changes are not upstream changes to merge
   * back out (DL-11). Defaults to the workspace's sync target.
   */
  targetBranch: string = syncTargetBranch(workspace),
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
    name: targetBranch,
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

    if (!isSafeWorkspacePath(localPath)) continue;
    const fullPath = resolveInWorkspace(workspace.localPath, localPath);
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
      const fullPath = resolveInWorkspace(
        workspace.localPath,
        candidate.relativePath,
      );
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
