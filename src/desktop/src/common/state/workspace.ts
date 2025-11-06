import { atom } from "jotai";
import { syncAtom } from "./store";

export interface Workspace {
  id: string;
  accountId: string;
  repoId: string;
  name: string;
  rootPath: string;

  // current branch

  pendingChanges: WorkspacePendingChanges;
}

export interface WorkspacePendingChanges {
  numChanges: number;
  files: File[];
}

export enum FileType {
  Unknown = 0,
  Directory = 1,
  Text = 2,
  Binary = 3,
  Symlink = 4,
}

export enum FileStatus {
  Unknown = 0,
  NotInWorkspaceRoot = 1,
  Local = 2,
  Added = 3,
  Renamed = 4,
  Deleted = 5,
  Ignored = 6,
  Cloaked = 7,
  ReadOnlyControlled = 8,
  WritableControlled = 9,
  ChangedNotCheckedOut = 10,
  ChangedCheckedOut = 11,
  NotChangedCheckedOut = 12,
  Conflicted = 13,
  Artifact = 14,
}

export interface File {
  path: string;
  type: FileType;
  size: number;
  modifiedAt: number;

  status: FileStatus;
  id: string | null;
  changelist: number | null;

  // locked by info
}

export interface Directory {
  children: File[];
  containsChanges: boolean;
}

export const workspacesAtom = atom<Workspace[] | null>(null);
syncAtom(workspacesAtom, "workspaces");

export const currentWorkspaceAtom = atom<Workspace | null>(null);
syncAtom(currentWorkspaceAtom, "currentWorkspace");

export const workspaceDirectoriesAtom = atom<Record<string, Directory>>({});
syncAtom(workspaceDirectoriesAtom, "workspaceDirectories");

export const workspaceDiffAtom = atom<{ left: string; right: string } | null>(
  null,
);
syncAtom(workspaceDiffAtom, "workspaceDiff");
