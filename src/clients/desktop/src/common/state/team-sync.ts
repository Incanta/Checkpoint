import { atom, type PrimitiveAtom } from "jotai";
import { store, syncAtom } from "./store";
import type {
  TeamSyncConfig,
  TeamSyncChangelistMeta,
  TeamSyncPinChange,
} from "@checkpointvcs/common";

export type {
  TeamSyncChangelistMeta,
  TeamSyncPinChange,
} from "@checkpointvcs/common";

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
  /** Linked repo name -> this workspace's choice (see the daemon's linked-repos.ts). */
  linkedWorkspaces?: Record<
    string,
    { workspaceId?: string; mode: "follow-pin" | "manual" | "ignore" }
  >;
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
  /**
   * Linked repo pins that differ between the good and bad bounds, so each
   * step may move linked repos too. Empty when none differ; null when unknown
   * or the range is not bounded yet.
   */
  pinChanges?: TeamSyncPinChange[] | null;
}

export type TeamSyncLinkMode = "follow-pin" | "manual" | "ignore";

/** How a link looks from this machine (mirrors the daemon's LinkStatus). */
export type TeamSyncLinkStatus =
  | "ignored"
  | "not-created"
  | "create-failed"
  | "not-set-up"
  | "missing-workspace"
  | "wrong-repo"
  | "wrong-branch"
  | "overlay-active"
  | "busy"
  | "up-to-date"
  | "out-of-date"
  | "synced"
  | "needs-confirmation";

export type TeamSyncLinkConfirmReason =
  | "local-changes"
  | "ahead-of-pin"
  | "held-by-other";

/** One link, as the daemon reports it (mirrors LinkStatusReport). */
export interface TeamSyncLinkReport {
  repo: string;
  branch: string;
  pin: number;
  mode: TeamSyncLinkMode;
  /** Where the mode came from: this workspace, its preset, or the default. */
  source: "workspace" | "preset" | "default";
  status: TeamSyncLinkStatus;
  /** A nested link's folder inside this workspace. */
  path?: string;
  /** Set with "create-failed": why. */
  error?: string;
  workspaceId?: string;
  workspaceName?: string;
  localPath?: string;
  /** The linked workspace's changelist. */
  fromChangelist?: number;
  reasons?: TeamSyncLinkConfirmReason[];
  holder?: {
    workspaceId: string;
    workspaceName: string;
    localPath: string;
    changelist: number;
  };
}

/** A workspace on this machine that can satisfy a link. */
export interface TeamSyncLinkCandidate {
  id: string;
  name: string;
  localPath: string;
  domainBranchName: string;
}

/** Links for the workspace's current changelist, plus candidates per link. */
export interface TeamSyncLinks {
  configChangelist: number | null;
  links: TeamSyncLinkReport[];
  /** Keyed by lowercased repo name. */
  candidates: Record<string, TeamSyncLinkCandidate[]>;
  /** The last failed link action or refresh, shown in settings. */
  error: string | null;
  /** A link action is running. */
  busy: boolean;
}

/** A sync that stopped because linked repos need the user's go-ahead. */
export interface TeamSyncLinkConfirm {
  /** The sync's target, so confirming resends the same sync. */
  changelistNumber: number | null;
  links: TeamSyncLinkReport[];
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

// Linked repo statuses and candidate workspaces per workspace.
export const teamSyncLinksAtom = atom<Record<string, TeamSyncLinks | null>>({});
syncAtom(teamSyncLinksAtom, "teamSyncLinks");

// A sync waiting on the user to confirm moving linked repos, per workspace.
export const teamSyncLinkConfirmAtom = atom<
  Record<string, TeamSyncLinkConfirm | null>
>({});
syncAtom(teamSyncLinkConfirmAtom, "teamSyncLinkConfirm");

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
