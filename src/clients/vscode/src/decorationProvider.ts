import * as vscode from "vscode";
import { FileStatus } from "@checkpointvcs/daemon";
import type { CheckpointModel } from "./model";
import { getStatusInfo } from "./repository";
import { relativeWorkspacePath } from "./util";

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
      return undefined;
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

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
  }
}
