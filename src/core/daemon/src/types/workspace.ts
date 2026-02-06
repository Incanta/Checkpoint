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
  /** This file exists in a directory that doesn't share the workspace root as an ancestor */
  NotInWorkspaceRoot = 1,
  /** This file was locally added but has correlation to the controlled workspace */
  Local = 2,
  /** This file was locally added and is marked for add for a pending submission */
  Added = 3,
  /** This file is controlled and was moved or renamed locally */
  Renamed = 4,
  /** This file is controlled and was deleted locally */
  Deleted = 5,
  /** This file is not controlled and is ignored for any changes */
  Ignored = 6,
  /**
   * This file is controlled, local changes are tracked by the daemon, but this
   * file won't show up as a modified file in pending changes
   */
  HiddenChanges = 7,
  /**
   * This file is controlled, unchanged locally, and is marked read-only on
   * the local file system
   */
  ReadOnlyControlled = 8,
  /**
   * This file is controlled, unchanged locally, and is marked writeable on
   * the local file system
   */
  WritableControlled = 9,
  /** This file is controlled, changed locally, but hasn't been checked out */
  ChangedNotCheckedOut = 10,
  /** This file is controlled, changed locally, and has been checked out */
  ChangedCheckedOut = 11,
  /** This file is controlled, unchanged locally, and has been checked out */
  NotChangedCheckedOut = 12,
  /** This file is marked conflicted and is preventing a pull/sync */
  Conflicted = 13,
  /**
   * This file is controlled, but exists as an artifact. Artifacts are added
   * to changelists post-submission and are not considered "source" material.
   * These typically are compiler output binaries distributed to prevent the
   * team from recompiling. They are hidden from the pending changes.
   */
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
