import { CreateApiClientAuth } from "@checkpointvcs/common";
import {
  pullAsync,
  pollHandle,
  freeHandle,
  GetLogLevel,
  type LongtailLogLevel,
} from "@checkpointvcs/longtail-addon";
import { existsSync, promises as fs } from "fs";
import path from "path";
import { homedir } from "os";

import {
  saveWorkspaceState,
  getWorkspaceState,
  type AppliedArtifactInfo,
  type ArtifactStateFile,
  type Workspace,
  type WorkspaceTeamSyncSettings,
  type WorkspaceState,
} from "../util.js";
import {
  toStorageOptions,
  resolveStorageEndpoints,
} from "../storage-options.js";
import { Logger } from "../../logging.js";
import { DaemonConfig, type DaemonConfigType } from "../../daemon-config.js";

type StateBackend = DaemonConfigType["stateBackend"];

const DEFAULT_ARTIFACT_TYPES = ["editor"];

export interface AppliedArtifactSummary {
  type: string;
  changelistNumber: number;
  fileCount: number;
}

export interface ApplyArtifactsResult {
  artifactFiles: Record<string, ArtifactStateFile>;
  appliedArtifacts: Record<string, AppliedArtifactInfo>;
  applied: AppliedArtifactSummary[];
  /** Artifact types requested but with no set at or before the source CL. */
  missingTypes: string[];
}

function normalizeArtifactPath(p: string): string {
  return p.replace(/^\//, "").replace(/\\/g, "/");
}

/**
 * Apply (or remove) precompiled-binary artifact overlays for a workspace,
 * decoupled from the source changelist. For each configured artifact type we
 * ask the server for the newest set at or before the source CL (gated on the
 * repo config's required badges), remove any stale files from the previously
 * applied set, longtail-pull the chosen set, and record what was applied.
 *
 * When precompiled binaries are disabled, every previously applied artifact
 * file is removed from disk.
 */
export async function applyArtifacts(
  workspace: Workspace,
  orgId: string,
  sourceChangelistNumber: number,
  settings: WorkspaceTeamSyncSettings,
  onStep?: (step: string) => void,
  onProgress?: (step: string, done: number, total: number) => void,
  logLevel?: LongtailLogLevel,
): Promise<ApplyArtifactsResult> {
  const daemonConfig = await DaemonConfig.Get();
  const stateBackend = daemonConfig.stateBackend;
  const resolvedLogLevel =
    logLevel ?? (daemonConfig.longtail.logLevel as LongtailLogLevel);

  const state = await getWorkspaceState(workspace.localPath, stateBackend);
  const existingArtifacts = state.artifactFiles ?? {};

  // Toggle off: remove every applied artifact file and clear tracking.
  if (!settings.usePrecompiledBinaries) {
    await removeArtifactPaths(
      workspace,
      Object.keys(existingArtifacts),
      onStep,
    );
    await persistArtifactState(workspace, state, {}, {}, stateBackend);
    return {
      artifactFiles: {},
      appliedArtifacts: {},
      applied: [],
      missingTypes: [],
    };
  }

  const client = await CreateApiClientAuth(workspace.daemonId);

  // Required badges per artifact type from the repo config at the source CL.
  const configResult = await client.teamSync.getConfig
    .query({
      repoId: workspace.repoId,
      changelistNumber: sourceChangelistNumber,
    })
    .catch(() => null);
  const requiredBadgesByType = new Map<string, string[]>();
  for (const channel of configResult?.config?.artifacts ?? []) {
    requiredBadgesByType.set(channel.type, channel.requiredBadges);
  }

  const types =
    settings.artifactTypes && settings.artifactTypes.length > 0
      ? settings.artifactTypes
      : DEFAULT_ARTIFACT_TYPES;

  // Storage plumbing (shared across the per-type pulls).
  const rawStorageTokenResponse = await client.storage.getToken.query({
    repoId: workspace.repoId,
    write: true,
  });
  if (!rawStorageTokenResponse.expiration) {
    throw new Error("Could not get storage token for artifact application");
  }
  const storageTokenResponse = await resolveStorageEndpoints(
    rawStorageTokenResponse,
  );
  const storageOptions = toStorageOptions(storageTokenResponse);
  const refreshStorageToken = async () => {
    const newToken = await client.storage.getToken.query({
      repoId: workspace.repoId,
      write: true,
    });
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

  const blockCachePath =
    (daemonConfig.longtail.enableBlockCache ?? true)
      ? path.join(homedir(), ".checkpoint", "cache", "blocks")
      : undefined;

  const nextArtifactFiles: Record<string, ArtifactStateFile> = {};
  const nextApplied: Record<string, AppliedArtifactInfo> = {};
  const applied: AppliedArtifactSummary[] = [];
  const missingTypes: string[] = [];

  for (const type of types) {
    const oldEntriesForType = Object.entries(existingArtifacts).filter(
      ([, f]) => (f.artifactType ?? "editor") === type,
    );
    const prevApplied = state.teamSync?.appliedArtifacts?.[type];

    const set = await client.artifact.findLatestSet.query({
      repoId: workspace.repoId,
      type,
      maxChangelistNumber: sourceChangelistNumber,
      requiredBadges: requiredBadgesByType.get(type),
    });

    if (!set) {
      Logger.warn(
        `No '${type}' artifacts at or before CL ${sourceChangelistNumber} for workspace ${workspace.workspaceName}`,
      );
      missingTypes.push(type);
      // Remove any previously applied files of this type (they are now stale).
      await removeArtifactPaths(
        workspace,
        oldEntriesForType.map(([p]) => p),
        onStep,
      );
      continue;
    }

    onStep?.(`Applying ${type} binaries from CL ${set.changelistNumber}`);

    // Resolve file paths for the set's fileIds and the previously applied set.
    const fileIds = Object.keys(set.stateTree);
    const oldFileIds = oldEntriesForType.map(([, f]) => f.fileId);
    const allIds = [...new Set([...fileIds, ...oldFileIds])];
    const files =
      allIds.length > 0
        ? await client.file.getFiles.mutate({
            ids: allIds,
            repoId: workspace.repoId,
          })
        : [];
    const pathById = new Map(
      files.map((f) => [f.id, normalizeArtifactPath(f.path)]),
    );

    // Remove stale files first (present in the old set, absent or changed in
    // the new one), unless a local build invalidated this type, in which case
    // we re-extract everything.
    const invalidated = prevApplied?.invalidatedByLocalBuild ?? false;
    const newPathToFileId = new Map<string, string>();
    for (const fileId of fileIds) {
      const p = pathById.get(fileId);
      if (p) newPathToFileId.set(p, fileId);
    }
    const stalePaths: string[] = [];
    for (const [oldPath, oldFile] of oldEntriesForType) {
      const stillPresent =
        newPathToFileId.get(oldPath) === oldFile.fileId &&
        set.stateTree[oldFile.fileId] === oldFile.changelist;
      if (!stillPresent) {
        stalePaths.push(oldPath);
      }
    }
    await removeArtifactPaths(workspace, stalePaths, onStep);

    // Pull the set's single version index.
    const handle = pullAsync({
      versionIndex: set.versionIndex,
      enableMmapIndexing: daemonConfig.longtail.enableMmapIndexing,
      enableMmapBlockStore: daemonConfig.longtail.enableMmapBlockStore,
      localRootPath: workspace.localPath,
      remoteBasePath: `/${orgId}/${workspace.repoId}`,
      cachePath: blockCachePath,
      ...storageOptions,
      logLevel: GetLogLevel(resolvedLogLevel),
    });
    if (!handle) {
      throw new Error(`Failed to create longtail handle for ${type} artifacts`);
    }
    const pollOptions: Parameters<typeof pollHandle>[1] = {
      onTokenRefresh: refreshStorageToken,
    };
    if (onStep) {
      pollOptions.onStep = (step) => onStep(`[${type}] ${step}`);
    }
    if (onProgress) {
      pollOptions.onProgress = (step, done, total) =>
        onProgress(`[${type}] ${step}`, done, total);
    }
    if (!onStep && !onProgress) {
      pollOptions.intervalMs = 250;
    }
    const { status } = await pollHandle(handle, pollOptions);
    freeHandle(handle);
    if (status.error !== 0) {
      throw new Error(
        `Artifact pull for ${type} failed: ${status.error} ${status.currentStep}`,
      );
    }

    // Record on-disk state for the set's files.
    const oldByFileId = new Map(
      oldEntriesForType.map(([, f]) => [f.fileId, f]),
    );
    let fileCount = 0;
    for (const fileId of fileIds) {
      const relPath = pathById.get(fileId);
      if (!relPath) continue;
      const fullPath = path.join(workspace.localPath, relPath);
      if (!existsSync(fullPath)) continue;
      const changelist = set.stateTree[fileId]!;

      const reusable =
        !invalidated &&
        oldByFileId.get(fileId)?.changelist === changelist &&
        existingArtifacts[relPath] !== undefined;
      if (reusable) {
        nextArtifactFiles[relPath] = {
          ...existingArtifacts[relPath]!,
          artifactType: type,
        };
      } else {
        const stat = await fs.stat(fullPath);
        nextArtifactFiles[relPath] = {
          fileId,
          changelist,
          md5: "",
          size: stat.size,
          mtime: stat.mtimeMs,
          artifactType: type,
        };
      }
      fileCount++;
    }

    nextApplied[type] = {
      changelistNumber: set.changelistNumber,
      sourceChangelistNumber,
      appliedAt: new Date().toISOString(),
    };
    applied.push({ type, changelistNumber: set.changelistNumber, fileCount });
  }

  await persistArtifactState(
    workspace,
    state,
    nextArtifactFiles,
    nextApplied,
    stateBackend,
  );

  return {
    artifactFiles: nextArtifactFiles,
    appliedArtifacts: nextApplied,
    applied,
    missingTypes,
  };
}

/**
 * Mark an artifact type as invalidated by a local build so the next
 * applyArtifacts re-extracts it, and drop the overlapping tracked files.
 */
export async function invalidateArtifactType(
  workspace: Workspace,
  type: string,
  overlappingPaths: string[],
): Promise<void> {
  const daemonConfig = await DaemonConfig.Get();
  const stateBackend = daemonConfig.stateBackend;
  const state = await getWorkspaceState(workspace.localPath, stateBackend);

  const artifactFiles = { ...(state.artifactFiles ?? {}) };
  for (const p of overlappingPaths) {
    delete artifactFiles[normalizeArtifactPath(p)];
  }

  const teamSync = { ...(state.teamSync ?? {}) };
  const appliedArtifacts = { ...(teamSync.appliedArtifacts ?? {}) };
  const info = appliedArtifacts[type];
  if (info) {
    appliedArtifacts[type] = { ...info, invalidatedByLocalBuild: true };
    teamSync.appliedArtifacts = appliedArtifacts;
  }

  await saveWorkspaceState(
    workspace,
    { ...state, artifactFiles, teamSync },
    stateBackend,
  );
}

async function removeArtifactPaths(
  workspace: Workspace,
  relPaths: string[],
  onStep?: (step: string) => void,
): Promise<void> {
  if (relPaths.length === 0) return;
  onStep?.("Removing stale binaries");
  for (const relPath of relPaths) {
    const fullPath = path.join(workspace.localPath, relPath);
    if (existsSync(fullPath)) {
      await fs.rm(fullPath, { force: true });
    }
  }
}

async function persistArtifactState(
  workspace: Workspace,
  state: WorkspaceState,
  artifactFiles: Record<string, ArtifactStateFile>,
  appliedArtifacts: Record<string, AppliedArtifactInfo>,
  stateBackend: StateBackend,
): Promise<void> {
  const teamSync = { ...(state.teamSync ?? {}) };
  if (Object.keys(appliedArtifacts).length > 0) {
    teamSync.appliedArtifacts = appliedArtifacts;
  } else {
    delete teamSync.appliedArtifacts;
  }

  await saveWorkspaceState(
    workspace,
    { ...state, artifactFiles, teamSync },
    stateBackend,
  );
}
