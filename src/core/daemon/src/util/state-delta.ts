import type { WorkspaceStateFile } from "@checkpointvcs/common";
import type {
  AppliedArtifactInfo,
  ArtifactStateFile,
  BisectVerdict,
  WorkspaceState,
} from "./util.js";

/**
 * A change to a workspace's state, so a store can write only what changed.
 *
 * Saving the whole state rewrote every tracked file's row even when one path
 * was staged, which made each save cost as much as the workspace is large.
 *
 * For each collection, `replaceAll` (or `clear`) runs first, then deletes or
 * removals, then upserts or additions. For meta fields, a value sets the
 * field, `null` removes it, and an absent key leaves it alone.
 */
export interface StateDelta {
  files?: {
    replaceAll?: Record<string, WorkspaceStateFile>;
    delete?: string[];
    upsert?: Record<string, WorkspaceStateFile>;
  };
  artifactFiles?: {
    replaceAll?: Record<string, ArtifactStateFile>;
    delete?: string[];
    upsert?: Record<string, ArtifactStateFile>;
  };
  markedForAdd?: { clear?: boolean; remove?: string[]; add?: string[] };
  staged?: { clear?: boolean; remove?: string[]; add?: string[] };
  bisect?: {
    clear?: boolean;
    remove?: number[];
    set?: Record<number, BisectVerdict>;
  };
  meta?: {
    changelistNumber?: number;
    branchHeads?: Record<string, number> | null;
    syncFilterHash?: string | null;
    lastBuiltChangelist?: number | null;
    lastScheduledSyncAt?: string | null;
    appliedArtifacts?: Record<string, AppliedArtifactInfo> | null;
  };
}

/** How many rows a delta writes, for stats and logs. */
export function deltaRowCount(delta: StateDelta): number {
  const len = (o?: object) => (o ? Object.keys(o).length : 0);
  return (
    len(delta.files?.replaceAll) +
    (delta.files?.delete?.length ?? 0) +
    len(delta.files?.upsert) +
    len(delta.artifactFiles?.replaceAll) +
    (delta.artifactFiles?.delete?.length ?? 0) +
    len(delta.artifactFiles?.upsert) +
    (delta.markedForAdd?.remove?.length ?? 0) +
    (delta.markedForAdd?.add?.length ?? 0) +
    (delta.staged?.remove?.length ?? 0) +
    (delta.staged?.add?.length ?? 0) +
    (delta.bisect?.remove?.length ?? 0) +
    len(delta.bisect?.set) +
    len(delta.meta)
  );
}

function applyToList(
  current: string[] | undefined,
  change: { clear?: boolean; remove?: string[]; add?: string[] },
): string[] {
  const set = new Set(change.clear ? [] : (current ?? []));
  for (const p of change.remove ?? []) set.delete(p);
  for (const p of change.add ?? []) set.add(p);
  return [...set];
}

function applyToRecord<T>(
  current: Record<string, T> | undefined,
  change: { replaceAll?: Record<string, T>; delete?: string[]; upsert?: Record<string, T> },
): Record<string, T> {
  const next: Record<string, T> = change.replaceAll
    ? { ...change.replaceAll }
    : (current ?? {});
  for (const p of change.delete ?? []) delete next[p];
  Object.assign(next, change.upsert ?? {});
  return next;
}

/**
 * Applies a delta to an in-memory state, mutating it. This is the meaning of
 * a delta: every store must leave its persisted state equal to what this
 * produces from the state it held before.
 */
export function applyDeltaToState(state: WorkspaceState, delta: StateDelta): void {
  if (delta.files) {
    state.files = applyToRecord(state.files, delta.files);
  }
  if (delta.artifactFiles) {
    state.artifactFiles = applyToRecord(state.artifactFiles, delta.artifactFiles);
  }
  if (delta.markedForAdd) {
    state.markedForAdd = applyToList(state.markedForAdd, delta.markedForAdd);
  }
  if (delta.staged) {
    state.staged = applyToList(state.staged, delta.staged);
  }

  const meta = delta.meta;
  if (meta?.changelistNumber !== undefined) {
    state.changelistNumber = meta.changelistNumber;
  }
  if (meta && "branchHeads" in meta) {
    if (meta.branchHeads === null) delete state.branchHeads;
    else if (meta.branchHeads !== undefined) state.branchHeads = meta.branchHeads;
  }

  const teamSync = { ...(state.teamSync ?? {}) };
  const scalar = <K extends "syncFilterHash" | "lastBuiltChangelist" | "lastScheduledSyncAt" | "appliedArtifacts">(
    key: K,
  ) => {
    if (!meta || !(key in meta)) return;
    const value = meta[key];
    if (value === null) delete teamSync[key];
    else if (value !== undefined) (teamSync as Record<string, unknown>)[key] = value;
  };
  scalar("syncFilterHash");
  scalar("lastBuiltChangelist");
  scalar("lastScheduledSyncAt");
  scalar("appliedArtifacts");

  if (delta.bisect) {
    const bisect: Record<number, BisectVerdict> = delta.bisect.clear
      ? {}
      : { ...(teamSync.bisect ?? {}) };
    for (const cl of delta.bisect.remove ?? []) delete bisect[cl];
    Object.assign(bisect, delta.bisect.set ?? {});
    if (Object.keys(bisect).length > 0) teamSync.bisect = bisect;
    else delete teamSync.bisect;
  }

  if (Object.keys(teamSync).length > 0) state.teamSync = teamSync;
  else delete state.teamSync;
}
