import { promises as fs } from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { createDaemonClient, type DaemonClient } from "./daemon";
import {
  CheckpointRepository,
  errorMessage,
  type WorkspaceConfigFile,
} from "./repository";
import { isDescendant, normalizeFsPath } from "./util";

const CONNECT_RETRY_MS = 15000;

/**
 * Discovers Checkpoint workspaces for the open VS Code workspace folders and
 * owns the daemon connection shared by all of them.
 *
 * A folder belongs to a Checkpoint workspace when it (or one of its
 * ancestors) contains .checkpoint/workspace.json, which the daemon writes on
 * workspace creation.
 */
export class CheckpointModel implements vscode.Disposable {
  /** Keyed by normalized workspace root path. */
  private repositories = new Map<string, CheckpointRepository>();

  private client: DaemonClient | null = null;
  public connected = false;
  private connectTimer: NodeJS.Timeout | undefined;
  private warnedOffline = false;

  private readonly _onDidChangeRepositories = new vscode.EventEmitter<void>();
  public readonly onDidChangeRepositories = this._onDidChangeRepositories.event;

  private readonly _onDidChangeRepositoryStatus =
    new vscode.EventEmitter<CheckpointRepository>();
  public readonly onDidChangeRepositoryStatus =
    this._onDidChangeRepositoryStatus.event;

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly outputChannel: vscode.OutputChannel) {
    vscode.workspace.onDidChangeWorkspaceFolders(
      () => void this.scan(),
      this,
      this.disposables,
    );

    // Pick up workspaces created (e.g. via the desktop app or CLI) while
    // VS Code is open.
    const configWatcher = vscode.workspace.createFileSystemWatcher(
      "**/.checkpoint/workspace.json",
    );
    configWatcher.onDidCreate(() => void this.scan(), this, this.disposables);
    configWatcher.onDidDelete(() => void this.scan(), this, this.disposables);
    this.disposables.push(configWatcher);

    vscode.workspace.onDidChangeConfiguration(
      (e) => {
        if (e.affectsConfiguration("checkpoint.daemonPort")) {
          this.client = null;
          void this.ensureConnection();
        }
      },
      this,
      this.disposables,
    );
  }

  public log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  public get repositoryList(): CheckpointRepository[] {
    return [...this.repositories.values()];
  }

  public async getClient(): Promise<DaemonClient> {
    if (!this.client) {
      this.client = await createDaemonClient();
    }
    return this.client;
  }

  public async start(): Promise<void> {
    await this.scan();
    await this.ensureConnection();
  }

  // ─── Daemon connection ─────────────────────────────────────────────

  public async ensureConnection(): Promise<boolean> {
    try {
      const client = await this.getClient();
      const version = await client.version.check.query();
      if (!this.connected) {
        this.connected = true;
        this.warnedOffline = false;
        this.log(
          `Connected to Checkpoint daemon (v${version.clientVersion}, api ${version.daemonApi})`,
        );
        void vscode.commands.executeCommand(
          "setContext",
          "checkpoint.connected",
          true,
        );
        for (const repo of this.repositories.values()) {
          void repo.refresh();
          void repo.updateSyncStatus(false);
        }
      }
      return true;
    } catch (error) {
      this.client = null;
      if (this.connected) {
        this.log(
          `Lost connection to Checkpoint daemon: ${errorMessage(error)}`,
        );
      }
      this.connected = false;
      void vscode.commands.executeCommand(
        "setContext",
        "checkpoint.connected",
        false,
      );

      if (this.repositories.size > 0 && !this.warnedOffline) {
        this.warnedOffline = true;
        void vscode.window
          .showWarningMessage(
            "Checkpoint: the local daemon is not reachable. Start the Checkpoint daemon (or desktop app) to enable version control.",
            "Retry",
          )
          .then((choice) => {
            if (choice === "Retry") {
              this.warnedOffline = false;
              void this.ensureConnection();
            }
          });
      }

      this.scheduleConnectRetry();
      return false;
    }
  }

  private scheduleConnectRetry(): void {
    if (this.connectTimer || this.repositories.size === 0) {
      return;
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined;
      void this.ensureConnection();
    }, CONNECT_RETRY_MS);
  }

  /**
   * Called by repositories when a daemon request fails; logs and kicks off
   * reconnection probing without spamming the user per request.
   */
  public handleDaemonError(operation: string, error: unknown): void {
    this.log(`Error while ${operation}: ${errorMessage(error)}`);
    void this.ensureConnection();
  }

  public notifyRepositoryChanged(repository: CheckpointRepository): void {
    this._onDidChangeRepositoryStatus.fire(repository);
  }

  // ─── Workspace discovery ───────────────────────────────────────────

  public async scan(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const found = new Map<string, WorkspaceConfigFile>();

    for (const folder of folders) {
      if (folder.uri.scheme !== "file") {
        continue;
      }
      const config = await findWorkspaceConfig(folder.uri.fsPath);
      if (config) {
        found.set(normalizeFsPath(config.localPath), config);
      }
    }

    let changed = false;

    for (const [root, repo] of this.repositories) {
      if (!found.has(root)) {
        this.log(`Checkpoint workspace removed: ${repo.root}`);
        repo.dispose();
        this.repositories.delete(root);
        changed = true;
      }
    }

    for (const [root, config] of found) {
      if (this.repositories.has(root)) {
        continue;
      }
      this.log(
        `Discovered Checkpoint workspace "${config.workspaceName}" at ${config.localPath}`,
      );
      const repo = new CheckpointRepository(this, config);
      this.repositories.set(root, repo);
      changed = true;

      if (this.connected) {
        void repo.refresh();
        void repo.updateSyncStatus(false);
      }
    }

    void vscode.commands.executeCommand(
      "setContext",
      "checkpoint.enabled",
      this.repositories.size > 0,
    );

    if (changed) {
      this._onDidChangeRepositories.fire();
    }

    if (this.repositories.size > 0 && !this.connected) {
      this.scheduleConnectRetry();
    }
  }

  public getRepository(
    uri: vscode.Uri | string,
  ): CheckpointRepository | undefined {
    const fsPath = typeof uri === "string" ? uri : uri.fsPath;
    for (const repo of this.repositories.values()) {
      if (isDescendant(repo.root, fsPath)) {
        return repo;
      }
    }
    return undefined;
  }

  public getRepositoryByRoot(root: string): CheckpointRepository | undefined {
    return this.repositories.get(normalizeFsPath(root));
  }

  public async pickRepository(): Promise<CheckpointRepository | undefined> {
    const repos = this.repositoryList;
    if (repos.length === 0) {
      void vscode.window.showInformationMessage(
        "Checkpoint: no Checkpoint workspace found in the open folders.",
      );
      return undefined;
    }
    if (repos.length === 1) {
      return repos[0];
    }
    const picked = await vscode.window.showQuickPick(
      repos.map((repo) => ({
        label: repo.config.workspaceName,
        description: repo.root,
        repo,
      })),
      { placeHolder: "Select a Checkpoint workspace" },
    );
    return picked?.repo;
  }

  public dispose(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    for (const repo of this.repositories.values()) {
      repo.dispose();
    }
    this.repositories.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeRepositories.dispose();
    this._onDidChangeRepositoryStatus.dispose();
  }
}

/**
 * Walks up from `startDir` looking for .checkpoint/workspace.json.
 */
async function findWorkspaceConfig(
  startDir: string,
): Promise<WorkspaceConfigFile | undefined> {
  let dir = path.resolve(startDir);

  while (true) {
    const configPath = path.join(dir, ".checkpoint", "workspace.json");
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = JSON.parse(raw) as WorkspaceConfigFile;
      if (parsed.id && parsed.daemonId && parsed.localPath) {
        // Trust the on-disk location over the recorded localPath so moved
        // workspaces still resolve to where they actually are.
        return { ...parsed, localPath: dir };
      }
    } catch {
      // Not here; keep walking up.
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}
