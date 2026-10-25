import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import type { LineChange } from "./staging";
import { FileStatus, FileType } from "@checkpointvcs/daemon";
import type {
  File,
  PendingChangelist,
  PendingChangelistState,
} from "@checkpointvcs/daemon";
import { pollJob, type DaemonClient, type JobResult } from "./daemon";
import type { CheckpointModel } from "./model";
import {
  debounce,
  isDescendant,
  relativeWorkspacePath,
  toCheckpointUri,
} from "./util";

/**
 * Mirror of the .checkpoint/workspace.json file the daemon writes into every
 * workspace root (see saveWorkspaceConfig in the daemon).
 */
export interface WorkspaceConfigFile {
  id: string;
  repoId: string;
  /**
   * The domain-root branch this workspace materializes from. Was `branchName`
   * before multi-branch workspaces; the daemon deletes that key on load, so
   * reading the old name yielded `undefined` and rendered as literal
   * "undefined" in the status bar and submit prompt.
   */
  domainBranchName: string;
  /** Feature branches overlaid on the tree. Empty means the domain root only. */
  activeBranches?: string[];
  workspaceName: string;
  localPath: string;
  daemonId: string;
}

/**
 * Resource-group identity.
 *
 * The fixed three, plus one per branch bucket and one per numbered pending
 * changelist. A bucket id is `branch:<name>` (that branch's default
 * changelist) and a numbered changelist's is `changelist:<id>`, which is why
 * this is a string rather than a union: the set of groups depends on which
 * feature branches the workspace has overlaid and which changelists exist,
 * not just on FileStatus.
 */
export type GroupId = string;

export const GROUP_CONFLICTS = "conflicts";
export const GROUP_UNSTAGED = "unstaged";

export function branchGroupId(branchName: string): GroupId {
  return `branch:${branchName}`;
}

export function branchFromGroupId(groupId: GroupId): string | undefined {
  return groupId.startsWith("branch:")
    ? groupId.slice("branch:".length)
    : undefined;
}

export function changelistGroupId(changelistId: number): GroupId {
  return `changelist:${changelistId}`;
}

export function changelistFromGroupId(groupId: GroupId): number | undefined {
  if (!groupId.startsWith("changelist:")) return undefined;
  const id = Number(groupId.slice("changelist:".length));
  return Number.isInteger(id) ? id : undefined;
}

/**
 * What a submit or a move targets: a numbered pending changelist, or the
 * default changelist of a branch (`changelistId` null).
 */
export interface ChangelistTarget {
  branchName: string;
  changelistId: number | null;
}

const NO_CHANGELISTS: PendingChangelistState = {
  changelists: [],
  assignments: {},
  defaultDescriptions: {},
};

interface StatusInfo {
  /**
   * Where this status lands when the file is NOT staged. A staged file goes
   * to its branch bucket instead, whatever its status.
   */
  group: GroupId;
  label: string;
  contextValue: string;
  badge: string;
  colorId: string;
}

const STATUS_INFO: Partial<Record<FileStatus, StatusInfo>> = {
  [FileStatus.Renamed]: {
    group: GROUP_UNSTAGED,
    label: "Renamed",
    contextValue: "renamed",
    badge: "R",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.Deleted]: {
    group: GROUP_UNSTAGED,
    label: "Deleted",
    contextValue: "deleted",
    badge: "D",
    colorId: "checkpointDecoration.deletedResourceForeground",
  },
  [FileStatus.ChangedNotCheckedOut]: {
    group: GROUP_UNSTAGED,
    label: "Modified",
    contextValue: "modified",
    badge: "M",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.ChangedCheckedOut]: {
    group: GROUP_UNSTAGED,
    label: "Modified (Checked Out)",
    contextValue: "modified-checkedout",
    badge: "M",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.NotChangedCheckedOut]: {
    group: GROUP_UNSTAGED,
    label: "Checked Out (Unchanged)",
    contextValue: "checkedout-clean",
    badge: "K",
    colorId: "checkpointDecoration.checkedOutResourceForeground",
  },
  [FileStatus.Conflicted]: {
    group: GROUP_CONFLICTS,
    label: "Conflicted",
    contextValue: "conflicted",
    badge: "!",
    colorId: "checkpointDecoration.conflictResourceForeground",
  },
  [FileStatus.MergeConflict]: {
    group: GROUP_CONFLICTS,
    label: "Merge Conflict",
    contextValue: "mergeconflict",
    badge: "!",
    colorId: "checkpointDecoration.conflictResourceForeground",
  },
  [FileStatus.Local]: {
    group: GROUP_UNSTAGED,
    label: "Untracked",
    contextValue: "untracked",
    badge: "U",
    colorId: "checkpointDecoration.untrackedResourceForeground",
  },
};

/**
 * An untracked file once it is staged. Staging is the only way a new file
 * joins a submit, so a staged one reads as added, as in git.
 */
const ADDED_INFO: StatusInfo = {
  group: GROUP_UNSTAGED,
  label: "Added",
  contextValue: "added",
  badge: "A",
  colorId: "checkpointDecoration.addedResourceForeground",
};

export function getStatusInfo(file: {
  status: FileStatus;
  staged?: boolean;
}): StatusInfo | undefined {
  if (file.status === FileStatus.Local && file.staged) {
    return ADDED_INFO;
  }
  return STATUS_INFO[file.status];
}

export class CheckpointResource implements vscode.SourceControlResourceState {
  public constructor(
    public readonly repository: CheckpointRepository,
    public readonly relPath: string,
    public readonly file: File,
    public readonly groupId: GroupId,
  ) {}

  public get resourceUri(): vscode.Uri {
    return vscode.Uri.file(path.join(this.repository.root, this.relPath));
  }

  public get command(): vscode.Command {
    return {
      command: "checkpoint.openDiff",
      title: "Open",
      arguments: [this],
    };
  }

  public get contextValue(): string {
    return getStatusInfo(this.file)?.contextValue ?? "unknown";
  }

  public get decorations(): vscode.SourceControlResourceDecorations {
    const info = getStatusInfo(this.file);
    const link = this.file.link;
    const color = info ? new vscode.ThemeColor(info.colorId) : undefined;
    // A symbolic link or junction gets the codicon VS Code's own explorer
    // uses for one, tinted like the badge it replaces, so it does not pass
    // for a plain file. Links to folders never reach pending changes.
    if (link) {
      return {
        strikeThrough: this.file.status === FileStatus.Deleted,
        faded: false,
        tooltip: `${info?.label ?? "Link"}: link to ${link.target || "an unknown target"}`,
        iconPath: new vscode.ThemeIcon(
          link.directory ? "file-symlink-directory" : "file-symlink-file",
          color,
        ),
      };
    }
    return {
      strikeThrough: this.file.status === FileStatus.Deleted,
      faded: false,
      tooltip: info?.label,
      // The daemon reports an untracked folder with no tracked files as a
      // single row, which stays one when it is too large to list file by
      // file (see expandUntrackedFolders). The SCM view
      // can't render them as collapsible folders, but without an explicit icon
      // the file icon theme resolves them as extension-less files and draws the
      // generic "unknown file" glyph. Force a folder codicon, tinted to match
      // the row's status color, so they at least read as directories.
      iconPath:
        this.file.type === FileType.Directory
          ? new vscode.ThemeIcon("folder", color)
          : undefined,
    };
  }
}

/** An untracked folder's non-ignored files and subfolders. */
interface UntrackedFolderContents {
  files: Map<string, File>;
  /** The folder itself and every non-empty subfolder. */
  folders: string[];
}

interface SyncStatusSummary {
  upToDate: boolean;
  localChangelistNumber: number;
  remoteHeadNumber: number;
  changelistsBehind: number;
}

export class CheckpointRepository implements vscode.Disposable {
  public readonly sourceControl: vscode.SourceControl;
  private readonly conflictsGroup: vscode.SourceControlResourceGroup;
  /**
   * Every group below Conflicts, in the order VS Code shows them, which is
   * the order they were created in (the API has no other way to order
   * groups). syncGroups keeps it in the desktop app's order: for each
   * branch, its default changelist (a branch bucket, `branch:<name>`, shown
   * only while it holds files) followed by its numbered changelists (shown
   * even when empty, so a new one can be moved into), then Unstaged Changes,
   * which holds untracked files too.
   */
  private orderedGroups = new Map<GroupId, vscode.SourceControlResourceGroup>();
  /** The daemon's pending changelists as of the last refresh. */
  private changelistState: PendingChangelistState = NO_CHANGELISTS;

  /** Pending files keyed by workspace-relative path (forward slashes). */
  private pendingFiles = new Map<string, File>();
  /**
   * The contents of the untracked folders the daemon reports as single
   * collapsed rows, keyed by that folder. `null` means the folder holds more
   * than `checkpoint.untrackedFolderFileLimit` entries and stays collapsed.
   * Entries are dropped when anything under the folder changes on disk.
   */
  private folderContents = new Map<string, UntrackedFolderContents | null>();
  /** Bumped on every folderContents invalidation, to discard stale listings. */
  private folderContentsGeneration = 0;
  /** Untracked folders whose files are listed individually, for decorations. */
  private untrackedFolders = new Set<string>();
  /**
   * The resource state currently handed to VS Code, keyed the same way.
   * Instances are reused across refreshes so the SCM tree only re-renders rows
   * whose status actually changed.
   */
  private resources = new Map<string, CheckpointResource>();
  /** False until the first successful refresh has populated the groups. */
  private applied = false;
  /**
   * Set by operations that move the workspace baseline (pull, submit, branch
   * switch) so the next apply re-reads open head documents even when no
   * pending status changed. Cleared once consumed.
   */
  private baselineMoved = false;
  private syncStatus: SyncStatusSummary | null = null;
  private syncTimer: NodeJS.Timeout | undefined;
  /** Last value written to sourceControl.count, to avoid redundant writes. */
  private lastCount = -1;
  /** Signature of the last status bar render, to avoid redundant writes. */
  private lastStatusBar = "";

  /**
   * A .chkignore changed since the last refresh. The daemon rescans its
   * ignore rules at the start of the next refresh, so ignore decorations are
   * only invalidated once that refresh has returned.
   */
  private ignoreRulesChanged = false;

  private refreshing = false;
  private refreshQueued = false;
  private debouncedRefresh: (() => void) & { dispose: () => void };

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly model: CheckpointModel,
    public config: WorkspaceConfigFile,
  ) {
    const rootUri = vscode.Uri.file(config.localPath);

    this.sourceControl = vscode.scm.createSourceControl(
      "checkpoint",
      `Checkpoint (${config.workspaceName})`,
      rootUri,
    );
    this.sourceControl.inputBox.placeholder =
      "Message (press Ctrl+Enter to submit)";
    this.sourceControl.acceptInputCommand = {
      command: "checkpoint.submit",
      title: "Submit Changes",
      arguments: [this.sourceControl],
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: (uri): vscode.Uri | undefined =>
        this.provideOriginalResource(uri),
    };

    this.conflictsGroup = this.sourceControl.createResourceGroup(
      "conflicts",
      "Conflicts",
    );
    this.conflictsGroup.hideWhenEmpty = true;
    this.syncGroups(new Set());

    this.disposables.push(this.sourceControl, this.conflictsGroup);

    this.debouncedRefresh = this.createDebouncedRefresh();

    // The daemon watches the workspace itself; this watcher only tells us
    // when to re-query it so the SCM view stays current.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, "**/*"),
    );
    const onFsEvent = (uri: vscode.Uri): void => {
      // Before the exclusion check: a listing is stale whether or not the
      // change is worth an automatic refresh.
      this.invalidateFolderContents(uri);
      if (this.isRefreshExcluded(uri)) {
        return;
      }
      if (path.basename(uri.fsPath) === ".chkignore") {
        this.ignoreRulesChanged = true;
      }
      const autoRefresh = vscode.workspace
        .getConfiguration("checkpoint")
        .get<boolean>("autoRefresh", true);
      if (autoRefresh) {
        this.debouncedRefresh();
      }
    };
    watcher.onDidChange(onFsEvent, this, this.disposables);
    watcher.onDidCreate(onFsEvent, this, this.disposables);
    watcher.onDidDelete(onFsEvent, this, this.disposables);
    this.disposables.push(watcher, {
      dispose: () => this.debouncedRefresh.dispose(),
    });

    this.restartSyncTimer();
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("checkpoint.syncStatusInterval")) {
          this.restartSyncTimer();
        }
        if (
          e.affectsConfiguration("checkpoint.autoRefreshDelay") ||
          e.affectsConfiguration("checkpoint.autoRefreshMaxDelay")
        ) {
          this.debouncedRefresh.dispose();
          this.debouncedRefresh = this.createDebouncedRefresh();
        }
      },
      this,
      this.disposables,
    );

    this.updateStatusBar();
  }

  public get root(): string {
    return this.config.localPath;
  }

  public get daemonId(): string {
    return this.config.daemonId;
  }

  public get workspaceId(): string {
    return this.config.id;
  }

  public getPendingFile(relPath: string): File | undefined {
    return this.pendingFiles.get(relPath);
  }

  /**
   * Whether the path is an untracked folder whose files are listed
   * individually. Such a folder has no pending row of its own, but should
   * still read as untracked in the explorer.
   */
  public isUntrackedFolder(relPath: string): boolean {
    return this.untrackedFolders.has(relPath);
  }

  public containsUri(uri: vscode.Uri): boolean {
    return uri.scheme === "file" && isDescendant(this.root, uri.fsPath);
  }

  /**
   * Whether a resource group is one of ours. Needed because an empty group
   * (a new changelist) has no resource state to resolve the repository from.
   */
  public ownsGroup(group: vscode.SourceControlResourceGroup): boolean {
    return (
      group === this.conflictsGroup ||
      [...this.orderedGroups.values()].includes(group)
    );
  }

  /** The branches this workspace can stage to: the domain root first. */
  public get stageableBranches(): string[] {
    return [
      this.config.domainBranchName,
      ...(this.config.activeBranches ?? []),
    ];
  }

  public get pendingChangelists(): PendingChangelist[] {
    return this.changelistState.changelists;
  }

  /** A changelist's description: a numbered one's, or a default's draft. */
  public descriptionOf(target: ChangelistTarget): string {
    if (target.changelistId !== null) {
      return (
        this.changelistState.changelists.find(
          (c) => c.id === target.changelistId,
        )?.description ?? ""
      );
    }
    return this.changelistState.defaultDescriptions[target.branchName] ?? "";
  }

  /** The changelist a resource group stands for, if it stands for one. */
  public targetForGroup(groupId: GroupId): ChangelistTarget | undefined {
    const changelistId = changelistFromGroupId(groupId);
    if (changelistId !== undefined) {
      const changelist = this.changelistState.changelists.find(
        (c) => c.id === changelistId,
      );
      return changelist
        ? { branchName: changelist.branchName, changelistId }
        : undefined;
    }
    const branchName = branchFromGroupId(groupId);
    return branchName !== undefined
      ? { branchName, changelistId: null }
      : undefined;
  }

  /** How a changelist reads in pickers and prompts. */
  public labelFor(target: ChangelistTarget): string {
    const onDomain = target.branchName === this.config.domainBranchName;
    if (target.changelistId === null) {
      return `Default changelist (${target.branchName})`;
    }
    const summary = firstLine(this.descriptionOf(target));
    return (
      `#${target.changelistId}` +
      (summary ? ` ${summary}` : "") +
      (onDomain ? "" : ` (${target.branchName})`)
    );
  }

  private createDebouncedRefresh(): (() => void) & { dispose: () => void } {
    const config = vscode.workspace.getConfiguration("checkpoint");
    const delay = Math.max(100, config.get<number>("autoRefreshDelay", 1000));
    const maxDelay = Math.max(
      delay,
      config.get<number>("autoRefreshMaxDelay", 5000),
    );
    return debounce(
      () => {
        void this.refresh();
      },
      delay,
      maxDelay,
    );
  }

  /**
   * Filters filesystem events that can never affect pending changes. The
   * daemon applies .chkignore itself, but a churning directory (an agent
   * rewriting sources, a build writing into node_modules) would otherwise wake
   * a round trip to the daemon for every single write.
   */
  private isRefreshExcluded(uri: vscode.Uri): boolean {
    const segments = uri.fsPath.split(/[\\/]/);
    if (segments.includes(".checkpoint")) {
      // Except the pending changelists, which another client (the desktop
      // app, the CLI) can edit without any working-tree file changing.
      return segments[segments.length - 1] !== "pending-changelists.json";
    }
    const excluded = vscode.workspace
      .getConfiguration("checkpoint")
      .get<string[]>("autoRefreshExcludeDirs", []);
    return excluded.some((dir) => segments.includes(dir));
  }

  // ─── Refresh ───────────────────────────────────────────────────────

  public async refresh(): Promise<void> {
    if (this.refreshing) {
      this.refreshQueued = true;
      return;
    }
    this.refreshing = true;
    const ignoreRulesChanged = this.ignoreRulesChanged;
    this.ignoreRulesChanged = false;
    try {
      await this.reloadWorkspaceConfig();

      const client = await this.model.getClient();
      const [pending, changelists] = await Promise.all([
        client.workspaces.pending.refresh.query({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
        }),
        client.workspaces.pending.listChangelists
          .query({
            daemonId: this.daemonId,
            workspaceId: this.workspaceId,
          })
          // A daemon that predates pending changelists has no such
          // procedure; everything is then in its branch's default one.
          .catch(() => NO_CHANGELISTS),
      ]);

      if (ignoreRulesChanged) {
        this.folderContents.clear();
        this.folderContentsGeneration++;
      }
      const files = new Map(Object.entries(pending?.files ?? {}));
      await this.expandUntrackedFolders(client, files);

      this.applyPendingFiles(files, changelists);

      if (ignoreRulesChanged) {
        this.model.notifyIgnoreRulesChanged(this);
      }
    } catch (error) {
      // Retry the invalidation with the next refresh.
      this.ignoreRulesChanged ||= ignoreRulesChanged;
      this.model.handleDaemonError("refreshing pending changes", error);
    } finally {
      this.refreshing = false;
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    }
    this.updateStatusBar();
  }

  /**
   * Replaces each collapsed untracked folder row with the files inside it.
   *
   * The daemon reports a folder holding no tracked files as one row, which
   * the SCM view can only draw as a file and which can only be acted on as a
   * whole. Listing its files instead lets the tree view show a real folder
   * and lets single files be staged or moved into a changelist. The listing
   * comes from the same one-level `getDirectoryPending` the desktop app uses
   * to expand a folder, walked level by level (each level is one batched
   * request).
   *
   * Only unstaged folders are expanded. A folder staged as a whole (from the
   * desktop app or the CLI) stays one row: its files are not individually
   * staged, so listing them would show them as unstaged.
   */
  private async expandUntrackedFolders(
    client: DaemonClient,
    files: Map<string, File>,
  ): Promise<void> {
    const limit = vscode.workspace
      .getConfiguration("checkpoint")
      .get<number>("untrackedFolderFileLimit", 5000);

    const folders = [...files]
      .filter(
        ([, file]) =>
          file.type === FileType.Directory &&
          file.status === FileStatus.Local &&
          !file.staged,
      )
      .map(([relPath]) => relPath);

    for (const folder of this.folderContents.keys()) {
      if (!folders.includes(folder)) {
        this.folderContents.delete(folder);
      }
    }

    const nextUntrackedFolders = new Set<string>();
    if (limit > 0) {
      const generation = this.folderContentsGeneration;
      const missing = folders.filter((f) => !this.folderContents.has(f));
      const listed = await Promise.all(
        missing.map((folder) =>
          this.listUntrackedFolder(client, folder, limit),
        ),
      );
      // A change on disk during the listing makes it stale; use it for this
      // refresh, but list again next time.
      if (generation === this.folderContentsGeneration) {
        missing.forEach((folder, i) =>
          this.folderContents.set(folder, listed[i]!),
        );
      }

      const fresh = new Map(missing.map((folder, i) => [folder, listed[i]]));
      for (const folder of folders) {
        const contents = fresh.has(folder)
          ? fresh.get(folder)
          : this.folderContents.get(folder);
        if (!contents) {
          continue;
        }
        files.delete(folder);
        for (const [relPath, file] of contents.files) {
          // A file staged from inside the folder already has its own row.
          if (!files.has(relPath)) {
            files.set(relPath, file);
          }
        }
        for (const sub of contents.folders) {
          nextUntrackedFolders.add(sub);
        }
      }
    } else {
      this.folderContents.clear();
    }

    const changed = [
      ...[...nextUntrackedFolders].filter((f) => !this.untrackedFolders.has(f)),
      ...[...this.untrackedFolders].filter((f) => !nextUntrackedFolders.has(f)),
    ];
    this.untrackedFolders = nextUntrackedFolders;
    if (changed.length > 0) {
      this.model.notifyRepositoryChanged(
        this,
        changed.map((f) => this.uriFor(f)),
      );
    }
  }

  /**
   * Lists an untracked folder's files, or returns null when it holds more
   * than `limit` entries (files and subfolders).
   */
  private async listUntrackedFolder(
    client: DaemonClient,
    folder: string,
    limit: number,
  ): Promise<UntrackedFolderContents | null> {
    const contents: UntrackedFolderContents = {
      files: new Map(),
      folders: [folder],
    };
    let budget = limit;
    let level = [folder];

    while (level.length > 0) {
      const results = await Promise.all(
        level.map((dir) =>
          client.workspaces.pending.getDirectoryPending.query({
            daemonId: this.daemonId,
            workspaceId: this.workspaceId,
            path: dir,
          }),
        ),
      );

      const nextLevel: string[] = [];
      for (const [i, { children }] of results.entries()) {
        for (const child of children) {
          if (--budget < 0) {
            return null;
          }
          const relPath = `${level[i]}/${child.path}`;
          if (child.type === FileType.Directory) {
            nextLevel.push(relPath);
            contents.folders.push(relPath);
          } else {
            contents.files.set(relPath, { ...child, path: relPath });
          }
        }
      }
      level = nextLevel;
    }

    return contents;
  }

  /** Drops the listings of the untracked folders a change on disk touches. */
  private invalidateFolderContents(uri: vscode.Uri): void {
    if (this.folderContents.size === 0) {
      return;
    }
    const relPath = relativeWorkspacePath(this.root, uri.fsPath);
    let invalidated = false;
    for (const folder of this.folderContents.keys()) {
      if (relPath === folder || relPath.startsWith(`${folder}/`)) {
        this.folderContents.delete(folder);
        invalidated = true;
      }
    }
    if (invalidated) {
      this.folderContentsGeneration++;
    }
  }

  /**
   * Reconciles a freshly fetched pending set against what VS Code is currently
   * showing and writes back only the difference.
   *
   * The daemon re-sends the full pending set on every refresh, and a File
   * carries volatile metadata (`size`, `modifiedAt`) that changes on every
   * save even when the file's status does not. Assigning `resourceStates`
   * and firing a blanket decoration invalidation each time made the SCM view
   * and every explorer badge re-render several times a second while an agent
   * was editing files. Only `status` drives what is rendered, so that is what
   * we diff on: unchanged rows keep their existing CheckpointResource
   * instance, untouched groups are never reassigned, and the decoration event
   * carries just the URIs whose badge actually changed.
   */
  private applyPendingFiles(
    next: Map<string, File>,
    nextChangelists: PendingChangelistState,
  ): void {
    const changedUris: vscode.Uri[] = [];
    const dirtyGroups = new Set<GroupId>();
    const resources = new Map<string, CheckpointResource>();
    // Previous rows are keyed against the changelists they were grouped
    // with, so a file moving between changelists registers as a change even
    // when nothing about the file itself did.
    const previousChangelists = this.changelistState;

    for (const [relPath, file] of next) {
      const previous = this.pendingFiles.get(relPath);
      const previousKey = previous
        ? this.renderKeyFor(previous, previousChangelists)
        : undefined;
      const key = this.renderKeyFor(file, nextChangelists);

      if (previousKey !== key) {
        changedUris.push(this.uriFor(relPath));
        const previousBucket = previous
          ? this.bucketFor(previous, previousChangelists)
          : undefined;
        if (previousBucket) {
          dirtyGroups.add(previousBucket);
        }
      }

      const bucket = this.bucketFor(file, nextChangelists);
      if (!bucket) {
        continue;
      }
      if (previousKey !== key) {
        dirtyGroups.add(bucket);
      }

      const existing = this.resources.get(relPath);
      resources.set(
        relPath,
        existing &&
          this.renderKeyFor(existing.file, previousChangelists) === key
          ? existing
          : new CheckpointResource(this, relPath, file, bucket),
      );
    }

    for (const [relPath, file] of this.pendingFiles) {
      if (next.has(relPath)) {
        continue;
      }
      changedUris.push(this.uriFor(relPath));
      const bucket = this.bucketFor(file, previousChangelists);
      if (bucket) {
        dirtyGroups.add(bucket);
      }
    }

    this.pendingFiles = next;
    this.resources = resources;
    this.changelistState = nextChangelists;
    // Done even when no row moved: creating, renaming, or deleting an empty
    // changelist changes the view without touching any file. A recreated
    // group starts out empty, so it must be refilled like a dirty one.
    const occupied = new Set([...resources.values()].map((r) => r.groupId));
    for (const groupId of this.syncGroups(occupied)) {
      dirtyGroups.add(groupId);
    }

    const baselineChanged = this.baselineMoved;
    this.baselineMoved = false;

    const firstApply = !this.applied;
    if (dirtyGroups.size === 0 && !firstApply) {
      // Nothing user-visible changed; leave the tree and decorations alone.
      // Open diffs still need re-reading if the baseline itself moved.
      if (baselineChanged) {
        this.model.notifyRepositoryChanged(this, [], true);
      }
      return;
    }
    this.applied = true;

    // Every group that currently exists must be considered, so a bucket that
    // has just emptied gets cleared rather than keeping stale rows.
    // syncGroups made a group for every occupied bucket, so each resource
    // has somewhere to go.
    const groups = new Map<GroupId, CheckpointResource[]>();
    for (const groupId of [GROUP_CONFLICTS, ...this.orderedGroups.keys()]) {
      groups.set(groupId, []);
    }
    for (const resource of resources.values()) {
      groups.get(resource.groupId)?.push(resource);
    }

    for (const [groupId, entries] of groups) {
      if (!firstApply && !dirtyGroups.has(groupId)) {
        continue;
      }
      entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
      this.groupFor(groupId).resourceStates = entries;
    }

    const count =
      (groups.get(GROUP_CONFLICTS)?.length ?? 0) +
      [...groups]
        .filter(
          ([id]) =>
            id.startsWith("branch:") ||
            id.startsWith("changelist:") ||
            id === GROUP_UNSTAGED,
        )
        .reduce((sum, [, entries]) => sum + entries.length, 0);
    if (count !== this.lastCount) {
      this.lastCount = count;
      this.sourceControl.count = count;
    }

    if (changedUris.length > 0 || baselineChanged) {
      this.model.notifyRepositoryChanged(this, changedUris, baselineChanged);
    }
  }

  private groupFor(groupId: GroupId): vscode.SourceControlResourceGroup {
    if (groupId === GROUP_CONFLICTS) return this.conflictsGroup;
    const group = this.orderedGroups.get(groupId);
    if (!group) {
      throw new Error(`No resource group ${groupId}`);
    }
    return group;
  }

  private get unstagedGroup(): vscode.SourceControlResourceGroup {
    return this.groupFor(GROUP_UNSTAGED);
  }

  /** The branch bucket groups that exist, by branch name. */
  private get branchGroupIds(): GroupId[] {
    return [...this.orderedGroups.keys()].filter(
      (id) => branchFromGroupId(id) !== undefined,
    );
  }

  /**
   * Brings the groups below Conflicts in line with the desktop app's order
   * (see orderedGroups), creating, removing, and relabelling as needed.
   * `occupied` names the groups that hold rows: a branch that is not active
   * gets a bucket only while something is staged to it, so the view never
   * keeps a section for a branch that was deactivated.
   *
   * VS Code places a group by when it was created, so when the order has to
   * change (a changelist is created, a branch gains its first staged file),
   * every group from the first out-of-place one down is disposed and created
   * again. Returns the ids of the groups created, which start out empty and
   * must be refilled.
   */
  private syncGroups(occupied: Set<GroupId>): Set<GroupId> {
    const wanted = this.wantedGroupOrder(occupied);

    const current = [...this.orderedGroups.keys()];
    let keep = 0;
    while (
      keep < current.length &&
      keep < wanted.length &&
      current[keep] === wanted[keep]
    ) {
      keep++;
    }

    for (const groupId of current.slice(keep)) {
      this.orderedGroups.get(groupId)!.dispose();
      this.orderedGroups.delete(groupId);
    }

    const created = new Set<GroupId>();
    for (const groupId of wanted.slice(keep)) {
      const group = this.sourceControl.createResourceGroup(
        groupId,
        this.groupLabel(groupId),
      );
      // Numbered changelists show even when empty; Unstaged Changes always
      // shows, as in git's Changes group.
      group.hideWhenEmpty =
        groupId !== GROUP_UNSTAGED &&
        changelistFromGroupId(groupId) === undefined;
      this.orderedGroups.set(groupId, group);
      created.add(groupId);
    }

    for (const [groupId, group] of this.orderedGroups) {
      const label = this.groupLabel(groupId);
      if (group.label !== label) {
        group.label = label;
      }
    }

    return created;
  }

  /** The ids of the groups below Conflicts, top to bottom. */
  private wantedGroupOrder(occupied: Set<GroupId>): GroupId[] {
    const changelists = [...this.changelistState.changelists].sort(
      (a, b) => a.id - b.id,
    );

    // The domain root, then each overlay, then any other branch something
    // is staged to (a claim on a branch no longer overlaid), so those files
    // stay visible rather than silently dropped.
    const branches = [...this.stageableBranches];
    for (const groupId of occupied) {
      const branch = branchFromGroupId(groupId);
      if (branch !== undefined && !branches.includes(branch)) {
        branches.push(branch);
      }
    }

    // An active branch keeps its bucket even when empty (it hides itself
    // then), so staging a branch's first file, or submitting its last, does
    // not shift every group below it.
    const order: GroupId[] = [];
    for (const branch of branches) {
      order.push(branchGroupId(branch));
      for (const changelist of changelists) {
        if (changelist.branchName === branch) {
          order.push(changelistGroupId(changelist.id));
        }
      }
    }
    // Changelists on a branch that is not overlaid any more.
    for (const changelist of changelists) {
      if (!branches.includes(changelist.branchName)) {
        order.push(changelistGroupId(changelist.id));
      }
    }

    order.push(GROUP_UNSTAGED);
    return order;
  }

  private groupLabel(groupId: GroupId): string {
    if (groupId === GROUP_UNSTAGED) return "Unstaged Changes";
    const branchName = branchFromGroupId(groupId);
    if (branchName !== undefined) return this.branchGroupLabel(branchName);
    const target = this.targetForGroup(groupId);
    return target ? this.labelFor(target) : groupId;
  }

  /** A default changelist's group label: its branch, then any draft. */
  private branchGroupLabel(branchName: string): string {
    const draft = firstLine(
      this.changelistState.defaultDescriptions[branchName] ?? "",
    );
    return `Staged: ${branchName}` + (draft ? ` - ${draft}` : "");
  }

  /**
   * Which group a file belongs in.
   *
   * Staging is what moves a file between groups, and it does not change the
   * file's status, so this cannot be derived from FileStatus alone the way it
   * used to be. Conflicts still win: an unresolved file is not submittable
   * whatever its staged flag says. A staged file is in the numbered
   * changelist it is assigned to when that changelist is on the branch the
   * file is destined for, and otherwise in that branch's default one, which
   * is the daemon's changelistOf rule.
   */
  private bucketFor(
    file: File,
    changelists: PendingChangelistState,
  ): GroupId | undefined {
    const info = getStatusInfo(file);
    if (!info) return undefined;
    if (info.group === GROUP_CONFLICTS) return GROUP_CONFLICTS;
    if (!file.staged) return info.group;

    const changelistId = this.changelistOf(file, changelists);
    if (changelistId !== null) {
      return changelistGroupId(changelistId);
    }
    return branchGroupId(this.destinedBranch(file));
  }

  /** Mirrors destinedBranch in the daemon's pending-changelists util. */
  private destinedBranch(file: File): string {
    return destinationClaim(file)?.branchName ?? this.config.domainBranchName;
  }

  /** Mirrors changelistOf in the daemon's pending-changelists util. */
  private changelistOf(
    file: File,
    changelists: PendingChangelistState,
  ): number | null {
    const id = changelists.assignments[file.path];
    if (id === undefined) return null;
    const changelist = changelists.changelists.find((c) => c.id === id);
    if (!changelist) return null;
    return changelist.branchName === this.destinedBranch(file) ? id : null;
  }

  /**
   * Identity for change detection.
   *
   * Status alone is not enough now: staging a file moves it between groups
   * without touching its status, and so does moving it between buckets or
   * pending changelists.
   */
  private renderKeyFor(
    file: File,
    changelists: PendingChangelistState,
  ): string {
    const changelistId = file.staged
      ? this.changelistOf(file, changelists)
      : null;
    return `${file.status}|${file.staged ? 1 : 0}|${destinationClaim(file)?.branchName ?? ""}|${changelistId ?? ""}`;
  }

  private uriFor(relPath: string): vscode.Uri {
    return vscode.Uri.file(path.join(this.root, relPath));
  }

  /**
   * The daemon rewrites .checkpoint/workspace.json on branch switches; re-read
   * it so the branch shown in the status bar stays accurate.
   */
  private async reloadWorkspaceConfig(): Promise<void> {
    try {
      const raw = await fs.readFile(
        path.join(this.root, ".checkpoint", "workspace.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw) as WorkspaceConfigFile;
      if (parsed.id === this.config.id) {
        this.config = { ...this.config, ...parsed, localPath: this.root };
      }
    } catch {
      // Keep the last known config if the file is temporarily unreadable.
    }
  }

  public async updateSyncStatus(forceRefresh: boolean): Promise<void> {
    try {
      const client = await this.model.getClient();
      const status = await client.workspaces.sync.getSyncStatus.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        forceRefresh,
      });
      this.syncStatus = {
        upToDate: status.upToDate,
        localChangelistNumber: status.localChangelistNumber,
        remoteHeadNumber: status.remoteHeadNumber,
        changelistsBehind: status.changelistsBehind,
      };
    } catch (error) {
      this.model.handleDaemonError("checking sync status", error);
    }
    this.updateStatusBar();
  }

  private restartSyncTimer(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    const seconds = Math.max(
      10,
      vscode.workspace
        .getConfiguration("checkpoint")
        .get<number>("syncStatusInterval", 60),
    );
    this.syncTimer = setInterval(() => {
      void this.updateSyncStatus(false);
    }, seconds * 1000);
  }

  private updateStatusBar(): void {
    const branch: vscode.Command = {
      command: "checkpoint.switchBranch",
      title:
        `$(git-branch) ${this.config.domainBranchName}` +
        ((this.config.activeBranches?.length ?? 0) > 0
          ? ` +${this.config.activeBranches!.length}`
          : ""),
      tooltip: `Checkpoint: switch branch (workspace "${this.config.workspaceName}")`,
      arguments: [this.sourceControl],
    };

    let syncTitle = "$(sync) Checking…";
    let syncTooltip = "Checkpoint: checking sync status";
    if (!this.model.connected) {
      syncTitle = "$(warning) Daemon offline";
      syncTooltip = "The Checkpoint daemon is not reachable";
    } else if (this.syncStatus) {
      if (this.syncStatus.upToDate) {
        syncTitle = `CL ${this.syncStatus.localChangelistNumber}`;
        syncTooltip = "Checkpoint: workspace is up to date";
      } else {
        syncTitle = `$(cloud-download) ${this.syncStatus.changelistsBehind} behind`;
        syncTooltip = `Checkpoint: pull to update to CL ${this.syncStatus.remoteHeadNumber}`;
      }
    }

    // Reassigning statusBarCommands pushes a new array to the SCM view even
    // when the contents are identical, so only write when something changed.
    const signature = `${branch.title}|${syncTitle}|${syncTooltip}`;
    if (signature === this.lastStatusBar) {
      return;
    }
    this.lastStatusBar = signature;

    this.sourceControl.statusBarCommands = [
      branch,
      {
        command: "checkpoint.pull",
        title: syncTitle,
        tooltip: syncTooltip,
        arguments: [this.sourceControl],
      },
    ];
  }

  // ─── Quick diff ────────────────────────────────────────────────────

  private provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (!this.containsUri(uri)) {
      return undefined;
    }
    const relPath = relativeWorkspacePath(this.root, uri.fsPath);
    const file = this.pendingFiles.get(relPath);
    if (!file) {
      return undefined;
    }
    const diffable = [
      FileStatus.ChangedNotCheckedOut,
      FileStatus.ChangedCheckedOut,
      FileStatus.Renamed,
      FileStatus.Conflicted,
      FileStatus.MergeConflict,
    ];
    if (!diffable.includes(file.status)) {
      return undefined;
    }
    return toCheckpointUri({
      root: this.root,
      path: relPath,
      ref: { type: "head" },
    });
  }

  // ─── Operations ────────────────────────────────────────────────────

  private async runJob(
    title: string,
    start: (client: DaemonClient) => Promise<{ jobId: string }>,
  ): Promise<JobResult> {
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async (progress) => {
        const client = await this.model.getClient();
        const { jobId } = await start(client);

        let lastDone = 0;
        const result = await pollJob(client, jobId, (p) => {
          const increment =
            p.total > 0 ? ((p.done - lastDone) / p.total) * 100 : 0;
          lastDone = p.done;
          progress.report({ message: p.currentStep, increment });
        });

        if (result.status === "failed") {
          throw new Error(result.error ?? `${title} failed`);
        }

        return result;
      },
    );
  }

  public async submit(resources?: CheckpointResource[]): Promise<void> {
    if (this.conflictsGroup.resourceStates.length > 0) {
      void vscode.window.showErrorMessage(
        "Checkpoint: resolve the conflicted files before submitting.",
      );
      return;
    }

    // Submit is per-changelist: it sends exactly what is in one numbered
    // pending changelist, or in one branch's default changelist. Work out
    // which, and stage anything the user selected that is not staged yet,
    // which is the common "select some rows and hit submit" path.
    let target: ChangelistTarget;
    let toStage: string[] = [];

    if (resources && resources.length > 0) {
      const targets = new Map<string, ChangelistTarget>();
      for (const r of resources) {
        const t = this.targetForGroup(r.groupId) ?? {
          branchName: this.config.domainBranchName,
          changelistId: null,
        };
        targets.set(`${t.changelistId ?? ""}|${t.branchName}`, t);
      }
      if (targets.size > 1) {
        void vscode.window.showErrorMessage(
          "Checkpoint: those files are in different changelists. Submit one changelist at a time.",
        );
        return;
      }
      target = [...targets.values()][0]!;
      toStage = resources.filter((r) => !r.file.staged).map((r) => r.relPath);
    } else {
      const candidates: ChangelistTarget[] = [
        ...this.branchGroupIds
          .filter((id) => this.groupFor(id).resourceStates.length > 0)
          .map((id) => ({
            branchName: branchFromGroupId(id)!,
            changelistId: null,
          }))
          .sort((a, b) => a.branchName.localeCompare(b.branchName)),
        ...this.changelistState.changelists
          .filter(
            (c) =>
              (this.orderedGroups.get(changelistGroupId(c.id))?.resourceStates
                .length ?? 0) > 0,
          )
          .sort((a, b) => a.id - b.id)
          .map((c) => ({ branchName: c.branchName, changelistId: c.id })),
      ];

      if (candidates.length === 0) {
        // Nothing staged anywhere. Offer the unstaged rows as the selection,
        // destined for the domain root.
        const unstaged = this.unstagedGroup
          .resourceStates as CheckpointResource[];
        if (unstaged.length === 0) {
          void vscode.window.showInformationMessage(
            "Checkpoint: there are no pending changes to submit.",
          );
          return;
        }
        target = {
          branchName: this.config.domainBranchName,
          changelistId: null,
        };
        toStage = unstaged.map((r) => r.relPath);
      } else if (candidates.length === 1) {
        target = candidates[0]!;
      } else {
        const picked = await vscode.window.showQuickPick(
          candidates.map((c) => ({
            label: this.labelFor(c),
            description:
              c.changelistId === null
                ? firstLine(this.descriptionOf(c))
                : c.branchName,
            target: c,
          })),
          {
            placeHolder: "Which changelist should be submitted?",
            ignoreFocusOut: true,
          },
        );
        if (!picked) return;
        target = picked.target;
      }
    }

    await this.submitTarget(target, toStage);
  }

  /**
   * Submits one changelist (a numbered one, or a branch's default), the
   * target of the Submit Changelist command on a group.
   */
  public async submitChangelist(target: ChangelistTarget): Promise<void> {
    if (this.conflictsGroup.resourceStates.length > 0) {
      void vscode.window.showErrorMessage(
        "Checkpoint: resolve the conflicted files before submitting.",
      );
      return;
    }
    await this.submitTarget(target, []);
  }

  private async submitTarget(
    target: ChangelistTarget,
    toStage: string[],
  ): Promise<void> {
    const { branchName, changelistId } = target;
    const name =
      changelistId !== null
        ? `changelist #${changelistId} to "${branchName}"`
        : `"${branchName}"`;

    // The SCM input box wins when the user typed into it; otherwise ask,
    // starting from the changelist's description.
    const fromInputBox = this.sourceControl.inputBox.value.trim();
    let message = fromInputBox;
    if (!message) {
      const input = await vscode.window.showInputBox({
        prompt: `Submit ${name}`,
        placeHolder: "Describe your changes",
        value: this.descriptionOf(target),
        ignoreFocusOut: true,
      });
      if (input === undefined || input.trim() === "") {
        return;
      }
      message = input.trim();
    }

    try {
      await this.runJob("Checkpoint: submitting changes", async (client) => {
        if (toStage.length > 0) {
          await client.workspaces.pending.stage.mutate({
            daemonId: this.daemonId,
            workspaceId: this.workspaceId,
            paths: toStage,
            ...(changelistId !== null ? { changelistId } : { branchName }),
          });
        }

        return client.workspaces.pending.submit.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          message,
          ...(changelistId !== null ? { changelistId } : { branchName }),
        });
      });
      if (fromInputBox) {
        this.sourceControl.inputBox.value = "";
      }
      this.baselineMoved = true;
      void vscode.window.showInformationMessage(
        `Checkpoint: submitted ${name}.`,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: submit failed. ${errorMessage(error)}`,
      );
    }

    await this.refresh();
  }

  // ─── Pending changelists ───────────────────────────────────────────

  /**
   * Asks which branch a new changelist is for. Only asks when there is a
   * choice, which is when the workspace has feature branches overlaid.
   */
  private async pickBranch(placeHolder: string): Promise<string | undefined> {
    const branches = this.stageableBranches;
    if (branches.length < 2) {
      return branches[0];
    }
    return vscode.window.showQuickPick(branches, {
      placeHolder,
      ignoreFocusOut: true,
    });
  }

  /**
   * Prompts for a description (and a branch, when overlays exist) and
   * creates an empty numbered changelist. `branchName` skips the branch
   * prompt.
   */
  public async newChangelist(
    branchName?: string,
  ): Promise<PendingChangelist | undefined> {
    const description = await vscode.window.showInputBox({
      prompt: "Description for the new pending changelist",
      placeHolder: "Describe the changes this changelist will hold",
      ignoreFocusOut: true,
    });
    if (description === undefined) {
      return undefined;
    }

    const branch =
      branchName ?? (await this.pickBranch("Which branch is it for?"));
    if (!branch) {
      return undefined;
    }

    let created: PendingChangelist | undefined;
    try {
      const client = await this.model.getClient();
      created = await client.workspaces.pending.createChangelist.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        description: description.trim(),
        branchName: branch,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: creating the changelist failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
    return created;
  }

  public async editChangelistDescription(
    target: ChangelistTarget,
  ): Promise<void> {
    const description = await vscode.window.showInputBox({
      prompt: `Description for ${this.labelFor(target)}`,
      value: this.descriptionOf(target),
      ignoreFocusOut: true,
    });
    if (description === undefined) {
      return;
    }

    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.setChangelistDescription.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        description: description.trim(),
        ...(target.changelistId !== null
          ? { changelistId: target.changelistId }
          : { branchName: target.branchName }),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: editing the description failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  /** Deletes a numbered changelist; its files stay staged, in the default. */
  public async deleteChangelist(changelistId: number): Promise<void> {
    const target = this.targetForGroup(changelistGroupId(changelistId));
    if (!target) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete pending changelist ${this.labelFor(target)}?`,
      {
        modal: true,
        detail: `Its files stay staged and move to the default changelist of "${target.branchName}".`,
      },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }

    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.deleteChangelist.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        changelistId,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: deleting the changelist failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  /**
   * Moves files into a changelist the user picks: a branch's default one, a
   * numbered one, or a new one. Unstaged files are staged on the way, since
   * only staged files belong to a changelist.
   */
  public async moveToChangelist(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) {
      return;
    }

    type Item = vscode.QuickPickItem & { target?: ChangelistTarget };
    const items: Item[] = [];
    for (const branchName of this.stageableBranches) {
      const target: ChangelistTarget = { branchName, changelistId: null };
      items.push({
        label: this.labelFor(target),
        description: firstLine(this.descriptionOf(target)),
        target,
      });
    }
    const numbered = [...this.changelistState.changelists].sort(
      (a, b) => a.id - b.id,
    );
    if (numbered.length > 0) {
      items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
      for (const c of numbered) {
        const target: ChangelistTarget = {
          branchName: c.branchName,
          changelistId: c.id,
        };
        items.push({
          label: this.labelFor(target),
          description: c.branchName,
          target,
        });
      }
    }
    items.push({ label: "", kind: vscode.QuickPickItemKind.Separator });
    items.push({ label: "$(add) New changelist..." });

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Move to which changelist?",
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }

    let target = picked.target;
    if (!target) {
      const created = await this.newChangelist();
      if (!created) {
        return;
      }
      target = { branchName: created.branchName, changelistId: created.id };
    }

    try {
      const client = await this.model.getClient();
      // Staging into a branch's default clears any numbered assignment, and
      // staging into a numbered one targets that changelist's branch.
      await client.workspaces.pending.stage.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
        ...(target.changelistId !== null
          ? { changelistId: target.changelistId }
          : { branchName: target.branchName, changelistId: null }),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: move failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async pull(): Promise<void> {
    try {
      const result = await this.runJob(
        "Checkpoint: pulling latest changes",
        (client) =>
          client.workspaces.sync.pull.mutate({
            daemonId: this.daemonId,
            workspaceId: this.workspaceId,
            changelistId: null,
            filePaths: null,
          }),
      );

      this.baselineMoved = true;

      const mergeResult = result.result as {
        cleanMerges: string[];
        conflictMerges: string[];
      } | null;

      if (mergeResult && mergeResult.conflictMerges.length > 0) {
        void vscode.window.showWarningMessage(
          `Checkpoint: pulled with ${mergeResult.conflictMerges.length} merge conflict(s). ` +
            `Resolve the conflict markers in: ${mergeResult.conflictMerges.join(", ")}`,
        );
      } else if (mergeResult && mergeResult.cleanMerges.length > 0) {
        void vscode.window.showInformationMessage(
          `Checkpoint: pulled and auto-merged ${mergeResult.cleanMerges.length} file(s).`,
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: pull failed. ${errorMessage(error)}`,
      );
    }

    await this.refresh();
    await this.updateSyncStatus(true);
  }

  public async revert(resources: CheckpointResource[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }

    const detail = resources.map((r) => r.relPath).join("\n");
    const confirm = await vscode.window.showWarningMessage(
      `Discard local changes to ${resources.length} file(s)? This cannot be undone.`,
      { modal: true, detail },
      "Revert",
    );
    if (confirm !== "Revert") {
      return;
    }

    try {
      const client = await this.model.getClient();
      const { results } = await client.workspaces.pending.revertFiles.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        filePaths: resources.map((r) => r.relPath),
      });

      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        void vscode.window.showErrorMessage(
          `Checkpoint: failed to revert ${failures.length} file(s): ` +
            failures.map((f) => `${f.filePath} (${f.error})`).join(", "),
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: revert failed. ${errorMessage(error)}`,
      );
    }

    await this.refresh();
  }

  /** Stage files, optionally into a feature branch's bucket. */
  public async stage(relPaths: string[], branchName?: string): Promise<void> {
    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.stage.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
        ...(branchName ? { branchName } : {}),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: stage failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  /**
   * Stages explicit content for one file: the baseline with some blocks
   * applied, as produced by the diff-editor staging flows.
   */
  public async stageContent(
    relPath: string,
    content: string,
    branchName?: string,
  ): Promise<void> {
    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.stageContent.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        path: relPath,
        content,
        ...(branchName ? { branchName } : {}),
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: stage failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  /**
   * Writes content back to the working tree.
   *
   * Used by the revert flows, which differ from staging in exactly this way:
   * staging records content without touching the tree, reverting changes the
   * tree itself.
   */
  public async writeWorkingTree(
    document: vscode.TextDocument,
    content: string,
  ): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      document.uri,
      new vscode.Range(
        new vscode.Position(0, 0),
        document.lineAt(document.lineCount - 1).range.end,
      ),
      content,
    );
    await vscode.workspace.applyEdit(edit);
    await document.save();
    await this.refresh();
  }

  /** Context-free changed regions for a file, computed by the daemon. */
  public async getLineChanges(
    relPath: string,
  ): Promise<{ changes: LineChange[]; isBinary: boolean } | undefined> {
    try {
      const client = await this.model.getClient();
      return await client.workspaces.pending.getLineChanges.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        path: relPath,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: could not diff "${relPath}". ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  /**
   * The branch a file's claim names, when it has one.
   *
   * Used so staging a second block of an already-staged file keeps it in the
   * bucket it is already destined for rather than silently moving it.
   */
  public claimBranchFor(relPath: string): string | undefined {
    const file = this.pendingFiles.get(relPath);
    return file ? destinationClaim(file)?.branchName : undefined;
  }

  /** Unstage files. Leaves their claims alone. */
  public async unstage(relPaths: string[]): Promise<void> {
    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.unstage.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: unstage failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  /** Restage files into a different branch's bucket. */
  public async moveToBranch(relPaths: string[]): Promise<void> {
    const branches = [
      this.config.domainBranchName,
      ...(this.config.activeBranches ?? []),
    ];
    if (branches.length < 2) {
      void vscode.window.showInformationMessage(
        "Checkpoint: no feature branches are active in this workspace.",
      );
      return;
    }

    const picked = await vscode.window.showQuickPick(branches, {
      placeHolder: "Move staged changes to which branch?",
      ignoreFocusOut: true,
    });
    if (!picked) return;

    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.moveToBranch.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
        branchName: picked,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: move failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async checkout(relPaths: string[], exclusive: boolean): Promise<void> {
    try {
      const client = await this.model.getClient();
      for (const relPath of relPaths) {
        await client.workspaces.pending.checkout.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          path: relPath,
          forceExclusive: exclusive,
        });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: checkout failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async undoCheckout(relPaths: string[]): Promise<void> {
    try {
      const client = await this.model.getClient();
      for (const relPath of relPaths) {
        await client.workspaces.pending.releaseClaim.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          path: relPath,
        });
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: undo checkout failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async resolveConflicts(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Mark ${relPaths.length} file(s) as resolved? Your local content will be submitted over the remote changes.`,
      { modal: true, detail: relPaths.join("\n") },
      "Mark as Resolved",
    );
    if (confirm !== "Mark as Resolved") {
      return;
    }

    try {
      const client = await this.model.getClient();
      await client.workspaces.conflicts.resolve.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        filePaths: relPaths,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: resolving conflicts failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async switchBranch(): Promise<void> {
    let branches: { name: string; headNumber: number; type: string }[];
    let currentBranchName: string;
    try {
      const client = await this.model.getClient();
      const result = await client.workspaces.branches.list.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        includeArchived: false,
      });
      branches = result.branches;
      currentBranchName = result.currentBranchName;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: could not list branches. ${errorMessage(error)}`,
      );
      return;
    }

    // A workspace materializes from a domain root and overlays feature
    // branches on top, so this list mixes two different actions: switching
    // the domain (a full re-pull) and activating an overlay (a delta).
    // Deactivating an already-overlaid branch is the third.
    const active = new Set(this.config.activeBranches ?? []);

    const picked = await vscode.window.showQuickPick(
      branches.map((b) => {
        const isDomain = b.name === currentBranchName;
        const isActive = active.has(b.name);
        const action = isDomain
          ? "current domain"
          : isActive
            ? "overlaid • select to deactivate"
            : b.type === "FEATURE"
              ? "activate as overlay"
              : "switch domain";
        return {
          label: `$(git-branch) ${b.name}`,
          description: `${action} • ${b.type.toLowerCase()} • head CL ${b.headNumber}`,
          branch: b,
          isActive,
          isDomain,
        };
      }),
      { placeHolder: "Switch domain, or activate/deactivate an overlay" },
    );
    if (!picked || picked.isDomain) {
      return;
    }

    const deactivating = picked.isActive;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: deactivating
            ? `Checkpoint: deactivating "${picked.branch.name}"`
            : `Checkpoint: switching to "${picked.branch.name}"`,
        },
        async () => {
          const client = await this.model.getClient();
          if (deactivating) {
            await client.workspaces.branches.deactivate.mutate({
              daemonId: this.daemonId,
              workspaceId: this.workspaceId,
              branchName: picked.branch.name,
            });
          } else {
            await client.workspaces.branches.switch.mutate({
              daemonId: this.daemonId,
              workspaceId: this.workspaceId,
              branchName: picked.branch.name,
            });
          }
          this.baselineMoved = true;
        },
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: branch switch failed. ${errorMessage(error)}`,
      );
    }

    await this.refresh();
    await this.updateSyncStatus(true);
  }

  public async createBranch(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "New branch name",
      ignoreFocusOut: true,
      validateInput: (value) =>
        value.trim().length === 0 ? "Branch name is required" : undefined,
    });
    if (!name) {
      return;
    }

    const type = await vscode.window.showQuickPick(
      ["FEATURE", "RELEASE", "MAINLINE"],
      { placeHolder: "Branch type" },
    );
    if (!type) {
      return;
    }

    try {
      if (!this.syncStatus) {
        await this.updateSyncStatus(true);
      }
      const headNumber = this.syncStatus?.localChangelistNumber ?? 0;

      const client = await this.model.getClient();
      await client.workspaces.branches.create.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        name: name.trim(),
        headNumber,
        type: type as "MAINLINE" | "RELEASE" | "FEATURE",
        parentBranchName: this.config.domainBranchName,
      });

      const switchNow = await vscode.window.showInformationMessage(
        `Checkpoint: created branch "${name.trim()}".`,
        "Switch to It",
      );
      if (switchNow === "Switch to It") {
        const switchClient = await this.model.getClient();
        await switchClient.workspaces.branches.switch.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          branchName: name.trim(),
        });
        this.baselineMoved = true;
        await this.refresh();
        await this.updateSyncStatus(true);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: creating branch failed. ${errorMessage(error)}`,
      );
    }
  }

  // ─── History ───────────────────────────────────────────────────────

  public async showHistory(): Promise<void> {
    try {
      const client = await this.model.getClient();
      const changelists = await client.workspaces.history.get.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
      });

      const pickedCl = await vscode.window.showQuickPick(
        changelists.map((cl) => ({
          label: `$(git-commit) CL ${cl.number}`,
          description: cl.user?.email ?? "",
          detail: cl.message,
          changelist: cl,
        })),
        {
          placeHolder: `Changelist history for "${this.config.domainBranchName}"`,
        },
      );
      if (!pickedCl) {
        return;
      }

      const files = await client.workspaces.history.changelistFiles.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        changelistNumber: pickedCl.changelist.number,
      });

      const pickedFile = await vscode.window.showQuickPick(
        files.map((f) => ({
          label: f.path,
          description: f.changeType,
          file: f,
        })),
        { placeHolder: `Files in CL ${pickedCl.changelist.number}` },
      );
      if (!pickedFile) {
        return;
      }

      await this.openHistoryDiff(
        pickedFile.file.path,
        pickedCl.changelist.number,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: could not load history. ${errorMessage(error)}`,
      );
    }
  }

  public async fileHistory(relPath: string): Promise<void> {
    try {
      const client = await this.model.getClient();
      const entries = await client.workspaces.history.file.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        filePath: relPath,
      });

      if (entries.length === 0) {
        void vscode.window.showInformationMessage(
          `Checkpoint: no history for ${relPath}.`,
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        entries.map((e) => ({
          label: `$(git-commit) CL ${e.changelistNumber}`,
          description: e.changeType,
          detail: e.changelist?.message,
          entry: e,
        })),
        { placeHolder: `History for ${relPath}` },
      );
      if (!picked) {
        return;
      }

      await this.openHistoryDiff(relPath, picked.entry.changelistNumber);
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: could not load file history. ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Opens a diff of a file at a given changelist against its previous
   * version. The daemon materializes both sides into its cache and hands
   * back the paths.
   */
  private async openHistoryDiff(
    relPath: string,
    changelistNumber: number,
  ): Promise<void> {
    const client = await this.model.getClient();

    // Find the version of this file that precedes the selected changelist.
    const entries = await client.workspaces.history.file.query({
      daemonId: this.daemonId,
      workspaceId: this.workspaceId,
      filePath: relPath,
    });
    const older = entries
      .map((e) => e.changelistNumber)
      .filter((n) => n < changelistNumber);
    const previousChangelistNumber =
      older.length > 0 ? Math.max(...older) : null;

    const diff = await client.workspaces.history.fileDiff.query({
      daemonId: this.daemonId,
      workspaceId: this.workspaceId,
      filePath: relPath,
      changelistNumber,
      previousChangelistNumber,
    });

    const left = diff.left
      ? toCheckpointUri({
          root: this.root,
          path: relPath,
          ref: {
            type: "cache",
            cachePath: diff.left.cachePath,
            isBinary: diff.left.isBinary,
          },
        })
      : toCheckpointUri({
          root: this.root,
          path: relPath,
          ref: { type: "empty" },
        });
    const right = diff.right
      ? toCheckpointUri({
          root: this.root,
          path: relPath,
          ref: {
            type: "cache",
            cachePath: diff.right.cachePath,
            isBinary: diff.right.isBinary,
          },
        })
      : toCheckpointUri({
          root: this.root,
          path: relPath,
          ref: { type: "empty" },
        });

    const title = `${path.basename(relPath)} (CL ${previousChangelistNumber ?? "none"} ↔ CL ${changelistNumber})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  public dispose(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    for (const group of this.orderedGroups.values()) {
      group.dispose();
    }
    this.orderedGroups.clear();
  }
}

/** The first line of a description, for labels. */
function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]!.trim();
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * The claim that says where a file is going: the open one (where it is being
 * worked on now) over a submitted one (where earlier work went, such as a
 * parent in a stack). Matches the daemon's submit endpoint.
 */
function destinationClaim(file: File): File["claims"][number] | undefined {
  return file.claims.find((c) => c.state === "OPEN") ?? file.claims[0];
}
