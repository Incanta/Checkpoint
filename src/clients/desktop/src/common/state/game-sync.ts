import { atom, type PrimitiveAtom } from "jotai";
import { store, syncAtom } from "./store";
import type {
  GameSyncConfig,
  GameSyncChangelistMeta,
} from "@checkpointvcs/common";

export type { GameSyncChangelistMeta } from "@checkpointvcs/common";

// All Game Sync atoms are keyed by workspace id so multiple workspaces can hold
// independent Game Sync state at once. Read a workspace's slice with
// `getWsRecord`; write one with `setWsRecord`.

/** Whether the workspace looks like an Unreal project (drives the affordance). */
export interface GameSyncMode {
  detected: boolean;
  uprojectPath: string | null;
  projectName: string | null;
}

/** A precompiled-binary set that has been applied at a given changelist. */
export interface GameSyncAppliedBinary {
  type: string;
  changelistNumber: number;
}

/** Current sync state summary for the workspace. */
export interface GameSyncStatus {
  syncedCl: number | null;
  appliedBinaries: GameSyncAppliedBinary[];
  lastSync: string | null;
}

export interface GameSyncChangelistUser {
  email: string;
  name: string | null;
  username: string | null;
}

export interface GameSyncChangelistEntry {
  number: number;
  message: string;
  createdAt: string;
  user: GameSyncChangelistUser | null;
}

export interface GameSyncChangelists {
  entries: GameSyncChangelistEntry[];
  hasMore: boolean;
}

export type GameSyncJobKind = "sync" | "build" | "clean";

/** Mirror of the daemon job currently driving Game Sync in this workspace. */
export interface GameSyncJob {
  jobId: string;
  kind: GameSyncJobKind;
  currentStep: string | null;
  progress: { done: number; total: number } | null;
  startedAt: string;
}

/** Scheduled (unattended) sync configuration, run by the daemon. */
export interface GameSyncScheduledSync {
  enabled: boolean;
  /** Local time of day in "HH:MM" 24-hour form. */
  timeOfDay: string;
  target: "latest" | "latest-good" | "latest-starred";
}

/** Per-workspace Game Sync settings (subset of WorkspaceGameSyncSettings). */
export interface GameSyncSettings {
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
  scheduledSync?: GameSyncScheduledSync;
  // NOTE: not yet in the daemon's settings schema, so these are stripped on
  // save; the UI still renders/toggles them for a future daemon change.
  buildStepOverrides?: Record<string, { enabled: boolean }>;
  [key: string]: unknown;
}

/** A file surfaced by the clean preview, grouped by category in the UI. */
export interface GameSyncCleanFile {
  path: string;
  size: number;
  category: string;
}

/** The next changelist to test plus the current good/bad bounds of a bisect. */
export interface GameSyncBisectNext {
  nextCl: number | null;
  remaining: number;
  low: number | null;
  high: number | null;
}

/** Active bisect state: per-CL verdicts plus the computed next step. */
export interface GameSyncBisectState {
  bisect: Record<string, string>;
  next: GameSyncBisectNext;
}

/** Result of a destructive-filter preview: files removed on the next sync. */
export interface GameSyncFilterPreview {
  toDelete: string[];
}

export const gameSyncModeAtom = atom<Record<string, GameSyncMode | null>>({});
syncAtom(gameSyncModeAtom, "gameSyncMode");

export const gameSyncConfigAtom = atom<Record<string, GameSyncConfig | null>>(
  {},
);
syncAtom(gameSyncConfigAtom, "gameSyncConfig");

export const gameSyncStatusAtom = atom<Record<string, GameSyncStatus | null>>(
  {},
);
syncAtom(gameSyncStatusAtom, "gameSyncStatus");

export const gameSyncChangelistsAtom = atom<
  Record<string, GameSyncChangelists>
>({});
syncAtom(gameSyncChangelistsAtom, "gameSyncChangelists");

export const gameSyncJobAtom = atom<Record<string, GameSyncJob | null>>({});
syncAtom(gameSyncJobAtom, "gameSyncJob");

// Per-workspace changelist metadata, keyed by workspace id then by CL number
// (as a string). Populated for the currently-loaded browser page.
export const gameSyncMetadataAtom = atom<
  Record<string, Record<string, GameSyncChangelistMeta>>
>({});
syncAtom(gameSyncMetadataAtom, "gameSyncMetadata");

export const gameSyncSettingsAtom = atom<
  Record<string, GameSyncSettings | null>
>({});
syncAtom(gameSyncSettingsAtom, "gameSyncSettings");

// Files surfaced by the last clean preview for a workspace.
export const gameSyncCleanAtom = atom<Record<string, GameSyncCleanFile[]>>({});
syncAtom(gameSyncCleanAtom, "gameSyncClean");

// Active bisect state per workspace (null when no verdicts have been recorded).
export const gameSyncBisectAtom = atom<
  Record<string, GameSyncBisectState | null>
>({});
syncAtom(gameSyncBisectAtom, "gameSyncBisect");

// Files a proposed filter change would remove on the next sync, per workspace.
export const gameSyncFilterPreviewAtom = atom<
  Record<string, GameSyncFilterPreview>
>({});
syncAtom(gameSyncFilterPreviewAtom, "gameSyncFilterPreview");

/** Read a single workspace's slice out of a Game Sync record atom's value. */
export function getWsRecord<T>(
  record: Record<string, T> | undefined,
  workspaceId: string | null | undefined,
): T | undefined {
  if (!record || !workspaceId) return undefined;
  return record[workspaceId];
}

/**
 * Write a single workspace's slice into a Game Sync record atom, preserving the
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
