import type { ApiTypes } from "./api-types";
import type { Modification as CommonModification } from "@checkpointvcs/common";

export interface Workspace extends ApiTypes.Workspace {
  localPath: string;
  daemonId: string;
  branchName: string;
}

export interface WorkspacePendingChanges {
  numChanges: number;
  files: Record<string, File>;
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

export type Modification = CommonModification;
