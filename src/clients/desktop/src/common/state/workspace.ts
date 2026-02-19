import { atom } from "jotai";
import { syncAtom } from "./store";
import type {
  Directory,
  Workspace,
  WorkspacePendingChanges,
  ApiTypes,
} from "@checkpointvcs/daemon/types";

export const workspacesAtom = atom<Workspace[] | null>(null);
syncAtom(workspacesAtom, "workspaces");

export const currentWorkspaceAtom = atom<Workspace | null>(null);
syncAtom(currentWorkspaceAtom, "currentWorkspace");

export const workspaceDirectoriesAtom = atom<Record<string, Directory>>({});
syncAtom(workspaceDirectoriesAtom, "workspaceDirectories");

export const workspacePendingChangesAtom = atom<WorkspacePendingChanges | null>(
  null,
);
syncAtom(workspacePendingChangesAtom, "workspacePendingChanges");

export const workspaceDiffAtom = atom<{ left: string; right: string } | null>(
  null,
);
syncAtom(workspaceDiffAtom, "workspaceDiff");

export const workspaceHistoryAtom = atom<ApiTypes.Changelist[] | null>(null);
syncAtom(workspaceHistoryAtom, "workspaceHistory");

// File history types
export interface FileHistoryEntry {
  changelistNumber: number;
  changeType: "ADD" | "DELETE" | "MODIFY";
  oldPath: string | null;
  changelist: {
    id: string;
    number: number;
    message: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string | null;
    user: {
      email: string;
      name: string | null;
      username: string | null;
    } | null;
  };
}

export interface FileHistoryState {
  filePath: string;
  entries: FileHistoryEntry[];
  selectedChangelistNumber: number | null;
  diffContent: { left: string; right: string } | null;
}

export const fileHistoryAtom = atom<FileHistoryState | null>(null);
syncAtom(fileHistoryAtom, "fileHistory");

// Changelist changes types (for viewing changes in a specific changelist)
export interface ChangelistFileChange {
  fileId: string;
  path: string;
  changeType: "ADD" | "DELETE" | "MODIFY";
  oldPath: string | null;
}

export interface ChangelistChangesState {
  changelistNumber: number;
  message: string;
  user: string;
  date: Date;
  files: ChangelistFileChange[];
  selectedFilePath: string | null;
  diffContent: { left: string; right: string } | null;
}

export const changelistChangesAtom = atom<ChangelistChangesState | null>(null);
syncAtom(changelistChangesAtom, "changelistChanges");

// Labels types
export interface LabelEntry {
  id: string;
  name: string;
  number: number;
  repoId: string;
  changelist: {
    number: number;
    message: string | null;
    createdAt: string;
    user: { email: string; name: string | null } | null;
  };
}

export const workspaceLabelsAtom = atom<LabelEntry[] | null>(null);
syncAtom(workspaceLabelsAtom, "workspaceLabels");

// Sync status types (incoming remote changes)
export interface SyncStatusOutdatedFile {
  fileId: string;
  path: string;
  localChangelist: number;
  remoteChangelist: number;
}

export interface SyncStatusState {
  upToDate: boolean;
  localChangelistNumber: number;
  remoteHeadNumber: number;
  changelistsBehind: number;
  changelistsToPull: number[];
  outdatedFiles: SyncStatusOutdatedFile[];
  deletedOnRemote: string[];
  newOnRemote: string[];
  checkedAt: Date;
}

export const workspaceSyncStatusAtom = atom<SyncStatusState | null>(null);
syncAtom(workspaceSyncStatusAtom, "workspaceSyncStatus");

// Sync preview types (detailed view of incoming changes)
export interface SyncPreviewFileChange {
  fileId: string;
  path: string;
  changeType: "ADD" | "DELETE" | "MODIFY";
  oldPath: string | null;
}

export interface SyncPreviewChangelist {
  changelistNumber: number;
  message: string;
  user: string;
  date: string;
  files: SyncPreviewFileChange[];
}

export interface SyncPreviewState {
  syncStatus: SyncStatusState;
  changelists: SyncPreviewChangelist[];
  /** Aggregated file changes across all incoming CLs */
  allFileChanges: SyncPreviewChangelist[];
  /** Currently selected file for diff view */
  selectedFilePath: string | null;
  /** Diff content for the selected file */
  diffContent: { left: string; right: string } | null;
}

export const workspaceSyncPreviewAtom = atom<SyncPreviewState | null>(null);
syncAtom(workspaceSyncPreviewAtom, "workspaceSyncPreview");

// Conflict types
export interface ConflictedFile {
  fileId: string;
  path: string;
  localChangelist: number;
  remoteChangelist: number;
}

export interface ConflictCheckState {
  hasConflicts: boolean;
  conflicts: ConflictedFile[];
}

export const workspaceConflictsAtom = atom<ConflictCheckState | null>(null);
syncAtom(workspaceConflictsAtom, "workspaceConflicts");

// Resolve confirmation suppression
export interface ResolveConfirmSuppressedState {
  suppressed: boolean;
}

export const resolveConfirmSuppressedAtom =
  atom<ResolveConfirmSuppressedState | null>(null);
syncAtom(resolveConfirmSuppressedAtom, "resolveConfirmSuppressed");

// Branch types
export type BranchType = "MAINLINE" | "RELEASE" | "FEATURE";

export interface BranchEntry {
  id: string;
  name: string;
  headNumber: number;
  isDefault: boolean;
  type: BranchType;
  archivedAt: string | null;
  parentBranchName: string | null;
  createdById: string | null;
  createdBy: {
    id: string;
    email: string;
    name: string | null;
    username: string | null;
  } | null;
}

export interface BranchesState {
  branches: BranchEntry[];
  currentBranchName: string;
}

export const workspaceBranchesAtom = atom<BranchesState | null>(null);
syncAtom(workspaceBranchesAtom, "workspaceBranches");
