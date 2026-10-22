import * as vscode from "vscode";
import { FileStatus } from "@checkpointvcs/daemon";
import type { CheckpointModel } from "./model";
import { getStatusInfo, type CheckpointRepository } from "./repository";
import { relativeWorkspacePath } from "./util";

/** How long to collect decoration requests before asking the daemon. */
const IGNORE_BATCH_DELAY_MS = 100;

interface PendingIgnoreBatch {
  repository: CheckpointRepository;
  /** Resolvers waiting on each workspace-relative path. */
  waiting: Map<string, Array<(ignored: boolean) => void>>;
}

/**
 * Greys out files and folders that .chkignore excludes, the way the git
 * extension greys out .gitignore'd ones.
 *
 * VS Code asks for one URI at a time as explorer rows render, so requests are
 * collected for a moment and sent to the daemon as one batch per repository,
 * mirroring git's batched `check-ignore`. VS Code caches the answers until
 * this provider invalidates them.
 */
export class CheckpointIgnoreDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private static readonly Decoration: vscode.FileDecoration = {
    color: new vscode.ThemeColor(
      "checkpointDecoration.ignoredResourceForeground",
    ),
  };

  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  public readonly onDidChangeFileDecorations =
    this._onDidChangeFileDecorations.event;

  /** Keyed by repository root. */
  private batches = new Map<string, PendingIgnoreBatch>();
  private batchTimer: NodeJS.Timeout | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly model: CheckpointModel) {
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      // Ignore rules span the whole tree, so any change invalidates
      // everything this provider has answered.
      model.onDidChangeIgnoreRules(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      }),
      model.onDidChangeRepositories(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      }),
    );
  }

  public provideFileDecoration(
    uri: vscode.Uri,
  ): Promise<vscode.FileDecoration | undefined> | undefined {
    if (uri.scheme !== "file" || !this.model.connected) {
      return undefined;
    }

    const repository = this.model.getRepository(uri);
    if (!repository) {
      return undefined;
    }

    const relPath = relativeWorkspacePath(repository.root, uri.fsPath);
    // The workspace root itself is never ignored.
    if (!relPath) {
      return undefined;
    }

    let batch = this.batches.get(repository.root);
    if (!batch) {
      batch = { repository, waiting: new Map() };
      this.batches.set(repository.root, batch);
    }

    const waiting = batch.waiting;
    const ignored = new Promise<boolean>((resolve) => {
      const resolvers = waiting.get(relPath) ?? [];
      resolvers.push(resolve);
      waiting.set(relPath, resolvers);
    });

    this.batchTimer ??= setTimeout(() => {
      this.batchTimer = undefined;
      void this.flush();
    }, IGNORE_BATCH_DELAY_MS);

    return ignored.then((isIgnored) =>
      isIgnored ? CheckpointIgnoreDecorationProvider.Decoration : undefined,
    );
  }

  private async flush(): Promise<void> {
    const batches = [...this.batches.values()];
    this.batches.clear();

    await Promise.all(
      batches.map(async ({ repository, waiting }) => {
        let ignored = new Set<string>();
        try {
          const client = await this.model.getClient();
          ignored = new Set(
            await client.workspaces.pending.checkIgnore.mutate({
              daemonId: repository.daemonId,
              workspaceId: repository.workspaceId,
              paths: [...waiting.keys()],
            }),
          );
        } catch (error) {
          // Leave the rows undecorated rather than failing the explorer.
          // Reconnecting fires onDidChangeIgnoreRules, which asks again.
          this.model.handleDaemonError("checking ignored files", error);
        }

        for (const [relPath, resolvers] of waiting) {
          for (const resolve of resolvers) {
            resolve(ignored.has(relPath));
          }
        }
      }),
    );
  }

  public dispose(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = undefined;
    }
    // Settle anything still waiting so no decoration request hangs.
    for (const { waiting } of this.batches.values()) {
      for (const resolvers of waiting.values()) {
        for (const resolve of resolvers) {
          resolve(false);
        }
      }
    }
    this.batches.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
  }
}

/**
 * Badges and colors for files in the explorer and editor tabs, mirroring the
 * git extension's decorations but driven by Checkpoint file status.
 */
export class CheckpointDecorationProvider
  implements vscode.FileDecorationProvider, vscode.Disposable
{
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<
    vscode.Uri[] | undefined
  >();
  public readonly onDidChangeFileDecorations =
    this._onDidChangeFileDecorations.event;

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly model: CheckpointModel) {
    this.disposables.push(
      vscode.window.registerFileDecorationProvider(this),
      // Firing `undefined` invalidates every decoration VS Code is holding,
      // which re-renders every visible explorer row, editor tab and
      // breadcrumb. Pending-change updates carry the affected URIs so only
      // those rows (and, via propagation, their parent folders) repaint.
      model.onDidChangeRepositoryStatus((e) => {
        if (e.uris.length > 0) {
          this._onDidChangeFileDecorations.fire(e.uris);
        }
      }),
      // Adding or removing a whole workspace is rare enough that a blanket
      // invalidation is the right call.
      model.onDidChangeRepositories(() => {
        this._onDidChangeFileDecorations.fire(undefined);
      }),
    );
  }

  public provideFileDecoration(
    uri: vscode.Uri,
  ): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }

    const repository = this.model.getRepository(uri);
    if (!repository) {
      return undefined;
    }

    const relPath = relativeWorkspacePath(repository.root, uri.fsPath);
    const file = repository.getPendingFile(relPath);
    if (!file) {
      // An untracked folder listed file by file has no row of its own.
      return repository.isUntrackedFolder(relPath)
        ? this.untrackedFolderDecoration()
        : undefined;
    }

    const info = getStatusInfo(file.status);
    if (!info) {
      return undefined;
    }

    return {
      badge: info.badge,
      color: new vscode.ThemeColor(info.colorId),
      tooltip: `Checkpoint: ${info.label}`,
      // Tint parent folders for real pending changes, but not for the
      // (potentially huge) untracked set.
      propagate: file.status !== FileStatus.Local,
    };
  }

  /** Looks the same as the collapsed folder row it replaces. */
  private untrackedFolderDecoration(): vscode.FileDecoration | undefined {
    const info = getStatusInfo(FileStatus.Local);
    return info
      ? {
          badge: info.badge,
          color: new vscode.ThemeColor(info.colorId),
          tooltip: `Checkpoint: ${info.label}`,
        }
      : undefined;
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
  }
}
