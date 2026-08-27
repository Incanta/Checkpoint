import { atom, type PrimitiveAtom } from "jotai";
import { store, syncAtom } from "./store";
import type {
  TeamSyncConfig,
  TeamSyncChangelistMeta,
} from "@checkpointvcs/common";

export type { TeamSyncChangelistMeta } from "@checkpointvcs/common";

// All Team Sync atoms are keyed by workspace id so multiple workspaces can hold
// independent Team Sync state at once. Read a workspace's slice with
// `getWsRecord`; write one with `setWsRecord`.

/**
 * Unreal status for the workspace, which gates the Unreal-only affordances
 * (Launch Editor, Generate Project Files).
 *
 * Both halves have to be true for those to be offered. `enabled` is the repo
 * opting in via an `unreal` block in its Team Sync config; `detected` is a
 * .uproject or in-workspace engine actually being found. Detection alone is not
 * enough: finding a .uproject in a repo that never asked for Unreal support
 * should not silently turn Unreal features on.
 */
export interface TeamSyncMode {
  /** The repo's Team Sync config declares an `unreal` block. */
  enabled: boolean;
  /** An Unreal project or in-workspace engine was found on disk. */
  detected: boolean;
  uprojectPath: string | null;
  projectName: string | null;
}

/** A precompiled-binary set that has been applied at a given changelist. */
export interface TeamSyncAppliedBinary {
  type: string;
  changelistNumber: number;
}

/** Current sync state summary for the workspace. */
export interface TeamSyncStatus {
  syncedCl: number | null;
  appliedBinaries: TeamSyncAppliedBinary[];
  lastSync: string | null;
}

export interface TeamSyncChangelistUser {
  email: string;
  name: string | null;
  username: string | null;
}

export interface TeamSyncChangelistEntry {
  number: number;
  message: string;
  createdAt: string;
  user: TeamSyncChangelistUser | null;
}

export interface TeamSyncChangelists {
  entries: TeamSyncChangelistEntry[];
  hasMore: boolean;
}

export type TeamSyncJobKind = "sync" | "build" | "clean";

/** Mirror of the daemon job currently driving Team Sync in this workspace. */
export interface TeamSyncJob {
  jobId: string;
  kind: TeamSyncJobKind;
  currentStep: string | null;
  progress: { done: number; total: number } | null;
  startedAt: string;
}

/** Scheduled (unattended) sync configuration, run by the daemon. */
export interface TeamSyncScheduledSync {
  enabled: boolean;
  /** Local time of day in "HH:MM" 24-hour form. */
  timeOfDay: string;
  target: "latest" | "latest-good" | "latest-starred";
}

/** Per-workspace Team Sync settings (subset of WorkspaceTeamSyncSettings). */
export interface TeamSyncSettings {
  categoryOverrides?: Record<string, boolean>;
  customIncludeRules?: string[];
  customExcludeRules?: string[];
  preset?: string | null;
  usePrecompiledBinaries?: boolean;
  artifactTypes?: string[];
  editorConfiguration?: string;
  selectedProject?: string;
  writeVersionFiles?: boolean;
  afterSync?: {
    build?: boolean;
    generateProjectFiles?: boolean;
    runEditor?: boolean;
    openSolution?: boolean;
  };
  scheduledSync?: TeamSyncScheduledSync;
  // NOTE: not yet in the daemon's settings schema, so these are stripped on
  // save; the UI still renders/toggles them for a future daemon change.
  buildStepOverrides?: Record<string, { enabled: boolean }>;
  [key: string]: unknown;
}

/** A file surfaced by the clean preview, grouped by category in the UI. */
export interface TeamSyncCleanFile {
  path: string;
  size: number;
  category: string;
}

/** The next changelist to test plus the current good/bad bounds of a bisect. */
export interface TeamSyncBisectNext {
  nextCl: number | null;
  remaining: number;
  low: number | null;
  high: number | null;
}

/** Active bisect state: per-CL verdicts plus the computed next step. */
export interface TeamSyncBisectState {
  bisect: Record<string, string>;
  next: TeamSyncBisectNext;
}

/** Result of a destructive-filter preview: files removed on the next sync. */
export interface TeamSyncFilterPreview {
  toDelete: string[];
}

export const teamSyncModeAtom = atom<Record<string, TeamSyncMode | null>>({});
syncAtom(teamSyncModeAtom, "teamSyncMode");

export const teamSyncConfigAtom = atom<Record<string, TeamSyncConfig | null>>(
  {},
);
syncAtom(teamSyncConfigAtom, "teamSyncConfig");

export const teamSyncStatusAtom = atom<Record<string, TeamSyncStatus | null>>(
  {},
);
syncAtom(teamSyncStatusAtom, "teamSyncStatus");

export const teamSyncChangelistsAtom = atom<
  Record<string, TeamSyncChangelists>
>({});
syncAtom(teamSyncChangelistsAtom, "teamSyncChangelists");

export const teamSyncJobAtom = atom<Record<string, TeamSyncJob | null>>({});
syncAtom(teamSyncJobAtom, "teamSyncJob");

// Per-workspace changelist metadata, keyed by workspace id then by CL number
// (as a string). Populated for the currently-loaded browser page.
export const teamSyncMetadataAtom = atom<
  Record<string, Record<string, TeamSyncChangelistMeta>>
>({});
syncAtom(teamSyncMetadataAtom, "teamSyncMetadata");

export const teamSyncSettingsAtom = atom<
  Record<string, TeamSyncSettings | null>
>({});
syncAtom(teamSyncSettingsAtom, "teamSyncSettings");

// Files surfaced by the last clean preview for a workspace.
export const teamSyncCleanAtom = atom<Record<string, TeamSyncCleanFile[]>>({});
syncAtom(teamSyncCleanAtom, "teamSyncClean");

// Active bisect state per workspace (null when no verdicts have been recorded).
export const teamSyncBisectAtom = atom<
  Record<string, TeamSyncBisectState | null>
>({});
syncAtom(teamSyncBisectAtom, "teamSyncBisect");

// Files a proposed filter change would remove on the next sync, per workspace.
export const teamSyncFilterPreviewAtom = atom<
  Record<string, TeamSyncFilterPreview>
>({});
syncAtom(teamSyncFilterPreviewAtom, "teamSyncFilterPreview");

/** Read a single workspace's slice out of a Team Sync record atom's value. */
export function getWsRecord<T>(
  record: Record<string, T> | undefined,
  workspaceId: string | null | undefined,
): T | undefined {
  if (!record || !workspaceId) return undefined;
  return record[workspaceId];
}

/**
 * Write a single workspace's slice into a Team Sync record atom, preserving the
 * other workspaces' entries. Intended for use in the main process where the
 * shared `store` is the source of truth that `syncAtom` broadcasts.
 */
export function setWsRecord<T>(
  recordAtom: PrimitiveAtom<Record<string, T>>,
  workspaceId: string,
  value: T,
): void {
  const current = store.get(recordAtom);
  store.set(recordAtom, { ...current, [workspaceId]: value });
}
