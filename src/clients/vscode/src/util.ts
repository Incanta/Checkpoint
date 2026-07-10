import * as path from "path";
import * as vscode from "vscode";

export const CHECKPOINT_SCHEME = "checkpoint";

/**
 * What a checkpoint: URI resolves to. "head" is the workspace's baseline
 * version of the file, "empty" is an empty document (used as the right-hand
 * side for deleted files), and a cache ref points at a file the daemon has
 * already materialized on disk (file history diffs).
 */
export type CheckpointRef =
  | { type: "head" }
  | { type: "empty" }
  | { type: "cache"; cachePath: string; isBinary: boolean };

export interface CheckpointUriParams {
  /** Absolute local path of the Checkpoint workspace root */
  root: string;
  /** Workspace-relative path of the file, forward slashes */
  path: string;
  ref: CheckpointRef;
}

export function toCheckpointUri(params: CheckpointUriParams): vscode.Uri {
  return vscode.Uri.from({
    scheme: CHECKPOINT_SCHEME,
    path: "/" + params.path,
    query: JSON.stringify(params),
  });
}

export function fromCheckpointUri(uri: vscode.Uri): CheckpointUriParams {
  return JSON.parse(uri.query) as CheckpointUriParams;
}

/** Normalizes an absolute path for prefix comparison across platforms. */
export function normalizeFsPath(fsPath: string): string {
  let normalized = path.normalize(fsPath).replace(/\\/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  if (process.platform === "win32") {
    normalized = normalized.toLowerCase();
  }
  return normalized;
}

/** True when `child` equals or lives underneath `parent`. */
export function isDescendant(parent: string, child: string): boolean {
  const p = normalizeFsPath(parent);
  const c = normalizeFsPath(child);
  return c === p || c.startsWith(p + "/");
}

/**
 * Workspace-relative path (forward slashes) of an absolute path inside a
 * Checkpoint workspace root.
 */
export function relativeWorkspacePath(root: string, fsPath: string): string {
  return path.relative(root, fsPath).replace(/\\/g, "/");
}

export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): T & { dispose: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const wrapped = ((...args: never[]) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, delayMs);
  }) as T & { dispose: () => void };
  wrapped.dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  return wrapped;
}
