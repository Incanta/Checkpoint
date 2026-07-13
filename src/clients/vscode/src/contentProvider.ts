import { promises as fs } from "fs";
import * as vscode from "vscode";
import type { CheckpointModel } from "./model";
import { CHECKPOINT_SCHEME, fromCheckpointUri, toCheckpointUri } from "./util";

/**
 * Serves checkpoint: documents — the read-only side of diff editors and the
 * quick-diff gutter. "head" refs are resolved through the daemon's diffFile
 * (which reads the workspace baseline out of Longtail storage); "cache" refs
 * point at files the daemon already materialized for history diffs.
 */
export class CheckpointContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this._onDidChange.event;

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(private readonly model: CheckpointModel) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(
        CHECKPOINT_SCHEME,
        this,
      ),
      // When a repository refreshes, the baseline may have moved (pull,
      // submit); poke any open head documents so diffs re-render.
      model.onDidChangeRepositoryStatus((repository) => {
        for (const doc of vscode.workspace.textDocuments) {
          if (doc.uri.scheme !== CHECKPOINT_SCHEME) {
            continue;
          }
          try {
            const params = fromCheckpointUri(doc.uri);
            if (params.ref.type === "head" && params.root === repository.root) {
              this._onDidChange.fire(doc.uri);
            }
          } catch {
            // Ignore malformed URIs.
          }
        }
      }),
    );
  }

  public async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = fromCheckpointUri(uri);

    switch (params.ref.type) {
      case "empty":
        return "";

      case "cache": {
        if (params.ref.isBinary) {
          return "[Binary file]";
        }
        return fs.readFile(params.ref.cachePath, "utf-8");
      }

      case "head": {
        const repository = this.model.getRepositoryByRoot(params.root);
        if (!repository) {
          return "";
        }
        const client = await this.model.getClient();
        const diff = await client.workspaces.pending.diffFile.query({
          daemonId: repository.daemonId,
          workspaceId: repository.workspaceId,
          path: params.path,
        });
        return diff.left;
      }
    }
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this._onDidChange.dispose();
  }
}

export function headUri(root: string, relPath: string): vscode.Uri {
  return toCheckpointUri({ root, path: relPath, ref: { type: "head" } });
}

export function emptyUri(root: string, relPath: string): vscode.Uri {
  return toCheckpointUri({ root, path: relPath, ref: { type: "empty" } });
}
