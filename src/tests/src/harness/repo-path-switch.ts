// A switch for the app's path rules (~/server/repo-path), for tests of how
// the daemon copes with paths a repository already holds. Kept apart from
// stack.ts, and free of app imports, because the mock factory that uses it
// runs while app modules are still loading: importing stack.ts from there
// would wait on itself.
//
// Wire it up with
// `vi.mock("~/server/repo-path", async (io) => (await import("../harness/repo-path-switch")).repoPathModule(io))`.

declare global {
  // eslint-disable-next-line no-var
  var __checkpointSkipPathRules: boolean | undefined;
}

/**
 * `~/server/repo-path` with a switch: while `asOlderServer` runs, the app
 * accepts any path, as a server from before the path rules did (or a
 * compromised one would). Repositories hold such paths, and older servers
 * still serve them, so the daemon's own defenses are tested against them.
 */
export async function repoPathModule(
  importOriginal: () => Promise<Record<string, unknown>>,
) {
  const actual =
    (await importOriginal()) as typeof import("~/server/repo-path");
  return {
    ...actual,
    canonicalProblems: (
      mods: Parameters<typeof actual.canonicalProblems>[0],
    ) =>
      globalThis.__checkpointSkipPathRules
        ? []
        : actual.canonicalProblems(mods),
    // Folding every name to itself lets names that differ only in case in,
    // as servers from before the fold check did.
    foldName: (name: string) =>
      globalThis.__checkpointSkipPathRules ? name : actual.foldName(name),
    portabilityProblems: (
      ...args: Parameters<typeof actual.portabilityProblems>
    ) =>
      globalThis.__checkpointSkipPathRules
        ? []
        : actual.portabilityProblems(...args),
  };
}

/** Runs `fn` against an app that stores any path (see repoPathModule). */
export async function asOlderServer<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.__checkpointSkipPathRules = true;
  try {
    return await fn();
  } finally {
    globalThis.__checkpointSkipPathRules = false;
  }
}
