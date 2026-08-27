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

/**
 * Trailing-edge debounce with an optional upper bound on how long a call can
 * be deferred.
 *
 * A plain debounce starves under sustained churn: an AI agent (or a build)
 * rewriting files every few hundred milliseconds keeps resetting the timer, so
 * the SCM view never updates until the burst ends. `maxWaitMs` guarantees the
 * function still runs at least that often while events keep arriving.
 */
export function debounce<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
  maxWaitMs?: number,
): T & { dispose: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let deadline: number | undefined;

  const wrapped = ((...args: never[]) => {
    const now = Date.now();
    if (deadline === undefined) {
      deadline =
        maxWaitMs !== undefined && maxWaitMs > 0 ? now + maxWaitMs : Infinity;
    }

    if (timer) {
      clearTimeout(timer);
    }
    const wait = Math.max(0, Math.min(delayMs, deadline - now));
    timer = setTimeout(() => {
      timer = undefined;
      deadline = undefined;
      fn(...args);
    }, wait);
  }) as T & { dispose: () => void };

  wrapped.dispose = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    deadline = undefined;
  };
  return wrapped;
}
