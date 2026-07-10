import * as path from "path";
import { promises as fs } from "fs";
import * as vscode from "vscode";
import { FileStatus } from "@checkpointvcs/daemon";
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
  branchName: string;
  workspaceName: string;
  localPath: string;
  daemonId: string;
}

export type GroupId = "conflicts" | "changes" | "local";

interface StatusInfo {
  group: GroupId;
  label: string;
  contextValue: string;
  badge: string;
  colorId: string;
}

const STATUS_INFO: Partial<Record<FileStatus, StatusInfo>> = {
  [FileStatus.Added]: {
    group: "changes",
    label: "Added",
    contextValue: "added",
    badge: "A",
    colorId: "checkpointDecoration.addedResourceForeground",
  },
  [FileStatus.Renamed]: {
    group: "changes",
    label: "Renamed",
    contextValue: "renamed",
    badge: "R",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.Deleted]: {
    group: "changes",
    label: "Deleted",
    contextValue: "deleted",
    badge: "D",
    colorId: "checkpointDecoration.deletedResourceForeground",
  },
  [FileStatus.ChangedNotCheckedOut]: {
    group: "changes",
    label: "Modified",
    contextValue: "modified",
    badge: "M",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.ChangedCheckedOut]: {
    group: "changes",
    label: "Modified (Checked Out)",
    contextValue: "modified-checkedout",
    badge: "M",
    colorId: "checkpointDecoration.modifiedResourceForeground",
  },
  [FileStatus.NotChangedCheckedOut]: {
    group: "changes",
    label: "Checked Out (Unchanged)",
    contextValue: "checkedout-clean",
    badge: "K",
    colorId: "checkpointDecoration.checkedOutResourceForeground",
  },
  [FileStatus.Conflicted]: {
    group: "conflicts",
    label: "Conflicted",
    contextValue: "conflicted",
    badge: "!",
    colorId: "checkpointDecoration.conflictResourceForeground",
  },
  [FileStatus.MergeConflict]: {
    group: "conflicts",
    label: "Merge Conflict",
    contextValue: "mergeconflict",
    badge: "!",
    colorId: "checkpointDecoration.conflictResourceForeground",
  },
  [FileStatus.Local]: {
    group: "local",
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
  private readonly changesGroup: vscode.SourceControlResourceGroup;
  private readonly localGroup: vscode.SourceControlResourceGroup;

  /** Pending files keyed by workspace-relative path (forward slashes). */
  private pendingFiles = new Map<string, File>();
  private syncStatus: SyncStatusSummary | null = null;
  private syncTimer: NodeJS.Timeout | undefined;

  private refreshing = false;
  private refreshQueued = false;
  private readonly debouncedRefresh: (() => void) & { dispose: () => void };

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
    this.changesGroup = this.sourceControl.createResourceGroup(
      "changes",
      "Pending Changes",
    );
    this.localGroup = this.sourceControl.createResourceGroup(
      "local",
      "Local Files",
    );
    this.localGroup.hideWhenEmpty = true;

    this.disposables.push(
      this.sourceControl,
      this.conflictsGroup,
      this.changesGroup,
      this.localGroup,
    );

    this.debouncedRefresh = debounce(() => {
      void this.refresh();
    }, 500);

    // The daemon watches the workspace itself; this watcher only tells us
    // when to re-query it so the SCM view stays current.
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(rootUri, "**/*"),
    );
    const onFsEvent = (uri: vscode.Uri): void => {
      if (uri.fsPath.split(path.sep).includes(".checkpoint")) {
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
    this.disposables.push(watcher, this.debouncedRefresh);

    this.restartSyncTimer();
    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("checkpoint.syncStatusInterval")) {
          this.restartSyncTimer();
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

      const files = pending?.files ?? {};
      this.pendingFiles = new Map(Object.entries(files));

      const groups: Record<GroupId, CheckpointResource[]> = {
        conflicts: [],
        changes: [],
        local: [],
      };

      for (const [relPath, file] of this.pendingFiles) {
        const info = getStatusInfo(file.status);
        if (!info) {
          continue;
        }
        groups[info.group].push(
          new CheckpointResource(this, relPath, file, info.group),
        );
      }

      for (const group of Object.values(groups)) {
        group.sort((a, b) => a.relPath.localeCompare(b.relPath));
      }

      this.conflictsGroup.resourceStates = groups.conflicts;
      this.changesGroup.resourceStates = groups.changes;
      this.localGroup.resourceStates = groups.local;
      this.sourceControl.count =
        groups.conflicts.length + groups.changes.length;

      this.model.notifyRepositoryChanged(this);
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
      title: `$(git-branch) ${this.config.branchName}`,
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
        syncTitle = `$(check) CL ${this.syncStatus.localChangelistNumber}`;
        syncTooltip = "Checkpoint: workspace is up to date";
      } else {
        syncTitle = `$(cloud-download) ${this.syncStatus.changelistsBehind} behind`;
        syncTooltip = `Checkpoint: pull to update to CL ${this.syncStatus.remoteHeadNumber}`;
      }
    }

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

    const targets =
      resources && resources.length > 0
        ? resources
        : (this.changesGroup.resourceStates as CheckpointResource[]);

    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        "Checkpoint: there are no pending changes to submit.",
      );
      return;
    }

    let message = this.sourceControl.inputBox.value.trim();
    if (!message) {
      const input = await vscode.window.showInputBox({
        prompt: `Submit ${targets.length} file(s) to "${this.config.branchName}"`,
        placeHolder: "Describe your changes",
        ignoreFocusOut: true,
      });
      if (input === undefined || input.trim() === "") {
        return;
      }
      message = input.trim();
    }

    const modifications = targets.map((r) => ({
      path: r.relPath,
      delete: r.file.status === FileStatus.Deleted,
    }));

    try {
      await this.runJob("Checkpoint: submitting changes", (client) =>
        client.workspaces.pending.submit.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          message,
          modifications,
        }),
      );
      this.sourceControl.inputBox.value = "";
      void vscode.window.showInformationMessage(
        `Checkpoint: submitted ${modifications.length} file(s).`,
      );
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Checkpoint: submit failed. ${errorMessage(error)}`,
      );
    }

    await this.refresh();
    await this.updateSyncStatus(true);
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

  public async checkout(relPaths: string[], locked: boolean): Promise<void> {
    try {
      const client = await this.model.getClient();
      for (const relPath of relPaths) {
        await client.workspaces.pending.checkout.mutate({
          daemonId: this.daemonId,
          workspaceId: this.workspaceId,
          path: relPath,
          locked,
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
        await client.workspaces.pending.undoCheckout.mutate({
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

    const picked = await vscode.window.showQuickPick(
      branches.map((b) => ({
        label: `$(git-branch) ${b.name}`,
        description:
          (b.name === currentBranchName ? "current • " : "") +
          `${b.type.toLowerCase()} • head CL ${b.headNumber}`,
        branch: b,
      })),
      { placeHolder: "Switch to branch" },
    );
    if (!picked || picked.branch.name === currentBranchName) {
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Checkpoint: switching to branch "${picked.branch.name}"`,
        },
        async () => {
          const client = await this.model.getClient();
          await client.workspaces.branches.switch.mutate({
            daemonId: this.daemonId,
            workspaceId: this.workspaceId,
            branchName: picked.branch.name,
          });
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
        parentBranchName: this.config.branchName,
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
        { placeHolder: `Changelist history for "${this.config.branchName}"` },
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
