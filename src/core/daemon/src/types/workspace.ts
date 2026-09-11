import type { ApiTypes } from "./api-types.js";
import type { Modification as CommonModification } from "@checkpointvcs/common";

export interface Workspace extends Omit<
  ApiTypes.Workspace,
  "domainBranchName"
> {
  localPath: string;
  daemonId: string;
  /**
   * The domain-root branch this workspace's tree is materialized from.
   *
   * Narrowed to non-null: the server column is nullable only for rows that
   * predate it, and the daemon always knows its own domain root because it
   * reads it from workspace.json before ever constructing this.
   */
  domainBranchName: string;
  /**
   * Feature branches overlaid on the tree, applied ancestor-first. Empty means
   * working directly on the domain root.
   */
  activeBranches: string[];
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
  /**
   * This file has been auto-merged during a pull but contains unresolved
   * git-style conflict markers (<<<<<<< / ======= / >>>>>>>).
   * The user must manually resolve the conflicts.
   */
  MergeConflict = 15,
}

/**
 * A claim on a file, as the UI needs to see it.
 *
 * `blocking` is the server's answer to "does this stop me", which the client
 * cannot work out on its own: it depends on the claim's strength and on
 * whether the claim's domain is the one this workspace is in. An advisory
 * claim, or one anchored in a sibling domain such as a release branch, shows
 * as context rather than an obstacle.
 */
export interface FileClaimInfo {
  id: string;
  /** The claimed file's server id. How refresh matches claims to baseline files. */
  fileId: string;
  /** Repo-relative, forward-slashed. */
  filePath: string;
  strength: "ADVISORY" | "EXCLUSIVE";
  state: "OPEN" | "SUBMITTED";
  /** The branch the work currently lives on. */
  branchName: string;
  /** The domain-root branch the exclusion applies to. */
  domainBranchName: string;
  blocking: boolean;
  workspaceId: string;
  userId: string;
  user: {
    id: string;
    email: string;
    name: string | null;
    username: string | null;
  };
}

export interface File {
  path: string;
  type: FileType;
  size: number;
  modifiedAt: number;

  status: FileStatus;
  id: string | null;
  changelist: number | null;

  claims: FileClaimInfo[];

  /**
   * Whether this file is staged for the next submit.
   *
   * Separate from the claim: the claim says WHICH branch the work is destined
   * for, this says whether it is READY to go. A checked-out binary has a claim
   * but starts unstaged.
   */
  staged: boolean;
}

export interface Directory {
  children: File[];
  containsChanges: boolean;
}

export type Modification = CommonModification;
