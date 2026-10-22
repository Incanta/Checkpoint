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
  /**
   * Files on disk whose names cannot be submitted (a backslash on Linux or
   * macOS, a control character), with why. Never staged; listed so they can
   * be renamed.
   */
  unsupported?: { path: string; reason: string }[];
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
  /**
   * This file exists locally but is not controlled (untracked). Staging it is
   * what makes it part of the next submit.
   */
  Local = 2,
  // 3 was Added (an untracked file marked for add). Marking for add was
  // removed; staging alone says a new file should be submitted. The value
  // stays reserved because clients cast statuses straight from the wire.
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

  /**
   * Whether the next submit makes the file executable (true) or not (false),
   * when that differs from the version it is based on: a `chmod` on Linux or
   * macOS, or `pending.setExecutable` on Windows (where a new file counts as
   * 0644 until set). Absent when that does not change, and for new files on
   * Linux and macOS, which are submitted with whatever mode they have.
   */
  executableChange?: boolean;
}

export interface Directory {
  children: File[];
  containsChanges: boolean;
}

export type Modification = CommonModification;

/**
 * A named group of staged changes waiting to be submitted together, as a
 * Perforce pending changelist. Local to the workspace: the server never sees
 * one until it is submitted.
 */
export interface PendingChangelist {
  /** Workspace-local number; never reused, and never a server CL number. */
  id: number;
  description: string;
  /** The branch it submits to: the domain root or an active overlay. */
  branchName: string;
  createdAt: number;
}

/**
 * The workspace's pending changelists and which staged files belong to them.
 *
 * Every branch also has an unnumbered default changelist, holding each staged
 * file destined for that branch that no numbered one claims. An assignment
 * only counts while its changelist targets the file's branch (the branch its
 * claim names); otherwise the file falls back to that branch's default, so a
 * claim moved elsewhere can never leave a file submitted to the wrong branch.
 */
export interface PendingChangelistState {
  changelists: PendingChangelist[];
  /** Repo-relative path to the id of the changelist it is in. */
  assignments: Record<string, number>;
  /** Draft description of each branch's default changelist. */
  defaultDescriptions: Record<string, string>;
}
