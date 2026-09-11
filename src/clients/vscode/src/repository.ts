import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { FileStatus, FileType } from "@checkpointvcs/daemon";
import type { File } from "@checkpointvcs/daemon";
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
 * The fixed three, plus one per branch bucket. A bucket id is
 * `branch:<name>`, which is why this is a string rather than a union: the
 * set of groups now depends on which feature branches the workspace has
 * overlaid, not just on FileStatus.
 */
export type GroupId = string;

export const GROUP_CONFLICTS = "conflicts";
export const GROUP_UNSTAGED = "unstaged";
export const GROUP_LOCAL = "local";

export function branchGroupId(branchName: string): GroupId {
  return `branch:${branchName}`;
}

export function branchFromGroupId(groupId: GroupId): string | undefined {
  return groupId.startsWith("branch:")
    ? groupId.slice("branch:".length)
    : undefined;
}

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
  [FileStatus.Added]: {
    group: GROUP_UNSTAGED,
    label: "Added",
    contextValue: "added",
    badge: "A",
    colorId: "checkpointDecoration.addedResourceForeground",
  },
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
    group: GROUP_LOCAL,
    label: "Local (Untracked)",
    contextValue: "local",
    badge: "U",
    colorId: "checkpointDecoration.untrackedResourceForeground",
  },
};

export function getStatusInfo(status: FileStatus): StatusInfo | undefined {
  return STATUS_INFO[status];
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
    return getStatusInfo(this.file.status)?.contextValue ?? "unknown";
  }

  public get decorations(): vscode.SourceControlResourceDecorations {
    const info = getStatusInfo(this.file.status);
    return {
      strikeThrough: this.file.status === FileStatus.Deleted,
      faded: false,
      tooltip: info?.label,
      // The daemon reports pending directories (an untracked or marked-for-add
      // folder with no pending files of its own) as single rows. The SCM view
      // can't render them as collapsible folders, but without an explicit icon
      // the file icon theme resolves them as extension-less files and draws the
      // generic "unknown file" glyph. Force a folder codicon, tinted to match
      // the row's status color, so they at least read as directories.
      iconPath:
        this.file.type === FileType.Directory
          ? new vscode.ThemeIcon(
              "folder",
              info ? new vscode.ThemeColor(info.colorId) : undefined,
            )
          : undefined,
    };
  }
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
  private readonly unstagedGroup: vscode.SourceControlResourceGroup;
  private readonly localGroup: vscode.SourceControlResourceGroup;
  /**
   * One group per branch bucket, created on demand as branches are overlaid
   * and disposed when they go away. Keyed by GroupId, not branch name.
   */
  private branchGroups = new Map<GroupId, vscode.SourceControlResourceGroup>();

  /** Pending files keyed by workspace-relative path (forward slashes). */
  private pendingFiles = new Map<string, File>();
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
    this.unstagedGroup = this.sourceControl.createResourceGroup(
      GROUP_UNSTAGED,
      "Unstaged Changes",
    );
    this.localGroup = this.sourceControl.createResourceGroup(
      "local",
      "Local Files",
    );
    this.localGroup.hideWhenEmpty = true;

    this.disposables.push(
      this.sourceControl,
      this.conflictsGroup,
      this.unstagedGroup,
      this.localGroup,
    );

    this.debouncedRefresh = this.createDebouncedRefresh();

    // The daemon watches the workspace itself; this watcher only tells us
    // when to re-query it so the SCM view stays current.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, "**/*"),
    );
    const onFsEvent = (uri: vscode.Uri): void => {
      if (this.isRefreshExcluded(uri)) {
        return;
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

  public containsUri(uri: vscode.Uri): boolean {
    return uri.scheme === "file" && isDescendant(this.root, uri.fsPath);
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
      return true;
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
    try {
      await this.reloadWorkspaceConfig();

      const client = await this.model.getClient();
      const pending = await client.workspaces.pending.refresh.query({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
      });

      this.applyPendingFiles(new Map(Object.entries(pending?.files ?? {})));
    } catch (error) {
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
  private applyPendingFiles(next: Map<string, File>): void {
    const changedUris: vscode.Uri[] = [];
    const dirtyGroups = new Set<GroupId>();
    const resources = new Map<string, CheckpointResource>();

    for (const [relPath, file] of next) {
      const previous = this.pendingFiles.get(relPath);
      const previousKey = previous ? this.renderKeyFor(previous) : undefined;
      const key = this.renderKeyFor(file);

      if (previousKey !== key) {
        changedUris.push(this.uriFor(relPath));
        const previousBucket = previous ? this.bucketFor(previous) : undefined;
        if (previousBucket) {
          dirtyGroups.add(previousBucket);
        }
      }

      const bucket = this.bucketFor(file);
      if (!bucket) {
        continue;
      }
      if (previousKey !== key) {
        dirtyGroups.add(bucket);
      }

      const existing = this.resources.get(relPath);
      resources.set(
        relPath,
        existing && this.renderKeyFor(existing.file) === key
          ? existing
          : new CheckpointResource(this, relPath, file, bucket),
      );
    }

    for (const [relPath, file] of this.pendingFiles) {
      if (next.has(relPath)) {
        continue;
      }
      changedUris.push(this.uriFor(relPath));
      const bucket = this.bucketFor(file);
      if (bucket) {
        dirtyGroups.add(bucket);
      }
    }

    this.pendingFiles = next;
    this.resources = resources;

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
    const groups = new Map<GroupId, CheckpointResource[]>();
    for (const groupId of [
      GROUP_CONFLICTS,
      GROUP_UNSTAGED,
      GROUP_LOCAL,
      ...this.branchGroups.keys(),
    ]) {
      groups.set(groupId, []);
    }
    for (const resource of resources.values()) {
      const bucket = groups.get(resource.groupId);
      if (bucket) {
        bucket.push(resource);
      } else {
        groups.set(resource.groupId, [resource]);
      }
    }

    for (const [groupId, entries] of groups) {
      if (!firstApply && !dirtyGroups.has(groupId)) {
        continue;
      }
      entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
      this.groupFor(groupId).resourceStates = entries;
    }

    // Drop branch groups that no longer hold anything, so the view does not
    // keep an empty section for a branch that was deactivated.
    for (const [groupId, group] of this.branchGroups) {
      if ((groups.get(groupId)?.length ?? 0) === 0) {
        group.dispose();
        this.branchGroups.delete(groupId);
      }
    }

    const count =
      (groups.get(GROUP_CONFLICTS)?.length ?? 0) +
      [...groups]
        .filter(([id]) => id.startsWith("branch:") || id === GROUP_UNSTAGED)
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
    if (groupId === GROUP_UNSTAGED) return this.unstagedGroup;
    if (groupId === GROUP_LOCAL) return this.localGroup;

    // Branch buckets are created the first time a file is staged into them
    // and disposed in applyPendingFiles when they empty out, so the SCM view
    // never shows a bucket for a branch that is no longer overlaid.
    let group = this.branchGroups.get(groupId);
    if (!group) {
      const branchName = branchFromGroupId(groupId) ?? groupId;
      group = this.sourceControl.createResourceGroup(
        groupId,
        `Staged: ${branchName}`,
      );
      group.hideWhenEmpty = true;
      this.branchGroups.set(groupId, group);
      this.disposables.push(group);
    }
    return group;
  }

  /**
   * Which group a file belongs in.
   *
   * Staging is what moves a file between groups, and it does not change the
   * file's status, so this cannot be derived from FileStatus alone the way it
   * used to be. Conflicts still win: an unresolved file is not submittable
   * whatever its staged flag says.
   */
  private bucketFor(file: File): GroupId | undefined {
    const info = getStatusInfo(file.status);
    if (!info) return undefined;
    if (info.group === GROUP_CONFLICTS) return GROUP_CONFLICTS;
    if (!file.staged) return info.group;

    const destination =
      file.claims[0]?.branchName ?? this.config.domainBranchName;
    return branchGroupId(destination);
  }

  /**
   * Identity for change detection.
   *
   * Status alone is not enough now: staging a file moves it between groups
   * without touching its status, and so does moving it between buckets.
   */
  private renderKeyFor(file: File): string {
    return `${file.status}|${file.staged ? 1 : 0}|${file.claims[0]?.branchName ?? ""}`;
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

    // Submit is per-bucket: it sends exactly what is staged for one branch.
    // Work out which bucket, and stage anything the user selected that is not
    // staged yet, which is the common "select some rows and hit submit" path.
    let branchName: string;
    let toStage: string[] = [];

    if (resources && resources.length > 0) {
      const buckets = new Set(
        resources.map(
          (r) => branchFromGroupId(r.groupId) ?? this.config.domainBranchName,
        ),
      );
      if (buckets.size > 1) {
        void vscode.window.showErrorMessage(
          "Checkpoint: those files are staged for different branches. Submit one branch at a time.",
        );
        return;
      }
      branchName = [...buckets][0]!;
      toStage = resources.filter((r) => !r.file.staged).map((r) => r.relPath);
    } else {
      const candidates = [...this.branchGroups.entries()]
        .filter(([, g]) => g.resourceStates.length > 0)
        .map(([id]) => branchFromGroupId(id)!)
        .sort();

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
        branchName = this.config.domainBranchName;
        toStage = unstaged.map((r) => r.relPath);
      } else if (candidates.length === 1) {
        branchName = candidates[0]!;
      } else {
        const picked = await vscode.window.showQuickPick(candidates, {
          placeHolder: "Which branch's staged changes should be submitted?",
          ignoreFocusOut: true,
        });
        if (!picked) return;
        branchName = picked;
      }
    }

    let message = this.sourceControl.inputBox.value.trim();
    if (!message) {
      const input = await vscode.window.showInputBox({
        prompt: `Submit staged changes to "${branchName}"`,
        placeHolder: "Describe your changes",
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
            branchName,
          });
        }

        return client.workspaces.pending.submit.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          message,
          branchName,
        });
      });
      this.sourceControl.inputBox.value = "";
      this.baselineMoved = true;
      void vscode.window.showInformationMessage(
        `Checkpoint: submitted to "${branchName}".`,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: submit failed. ${errorMessage(error)}`,
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

  public async markForAdd(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) {
      return;
    }
    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.markForAdd.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: mark for add failed. ${errorMessage(error)}`,
      );
    }
    await this.refresh();
  }

  public async unmarkForAdd(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) {
      return;
    }
    try {
      const client = await this.model.getClient();
      await client.workspaces.pending.unmarkForAdd.mutate({
        daemonId: this.daemonId,
        workspaceId: this.workspaceId,
        paths: relPaths,
      });
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: unmark for add failed. ${errorMessage(error)}`,
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
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
