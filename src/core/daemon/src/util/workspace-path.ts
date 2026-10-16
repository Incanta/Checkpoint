import path from "path";

import { canonicalPathProblem } from "./repo-path-rules.js";

// Every path the daemon writes, deletes, or backs up comes from the server,
// which stores what clients send. Repositories already hold paths that climb
// out of the workspace ("../x"), name its own .checkpoint directory, or (on
// Windows) contain a ":" that NTFS reads as a stream separator, and an older
// or compromised server will keep sending them. Each one is checked here
// before it is joined to the workspace root.

export class UnsafePathError extends Error {
  public constructor(
    public readonly relativePath: string,
    public readonly reason: string,
  ) {
    super(`Refusing unsafe path ${JSON.stringify(relativePath)}: ${reason}`);
    this.name = "UnsafePathError";
  }
}

/** Why the daemon must not touch `relativePath` on this OS, or null. */
export function unsafePathReason(
  relativePath: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const problem = canonicalPathProblem(relativePath.replace(/\\/g, "/"));
  if (problem) return problem;
  if (platform === "win32" && relativePath.includes(":")) {
    // "a:b" is the stream "b" of a file "a" on NTFS: the content would land
    // in a hidden stream and the real path would look deleted.
    return 'a ":", which Windows reads as a stream separator';
  }
  return null;
}

export function isSafeWorkspacePath(relativePath: string): boolean {
  return unsafePathReason(relativePath) === null;
}

/**
 * The absolute path of `relativePath` inside `root`, or an UnsafePathError if
 * it is not a path the daemon may touch.
 */
export function resolveInWorkspace(root: string, relativePath: string): string {
  const reason = unsafePathReason(relativePath);
  if (reason) throw new UnsafePathError(relativePath, reason);
  const resolved = path.resolve(root, relativePath);
  const inside = path.relative(path.resolve(root), resolved);
  if (
    inside === "" ||
    inside === ".." ||
    inside.startsWith(`..${path.sep}`) ||
    path.isAbsolute(inside)
  ) {
    throw new UnsafePathError(
      relativePath,
      "it resolves outside the workspace",
    );
  }
  return resolved;
}

/** Splits `paths` into the ones the daemon may touch and the rest. */
export function partitionSafePaths(paths: readonly string[]): {
  safe: string[];
  unsafe: { path: string; reason: string }[];
} {
  const safe: string[] = [];
  const unsafe: { path: string; reason: string }[] = [];
  for (const p of paths) {
    const reason = unsafePathReason(p);
    if (reason) unsafe.push({ path: p, reason });
    else safe.push(p);
  }
  return { safe, unsafe };
}
