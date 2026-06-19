// Integer wire-format API versions. Used for the two compatibility checks:
//   1. Daemon vs server  — daemon checks its SERVER_API >= server's minServerApi
//   2. Client vs daemon  — client checks its DAEMON_API >= daemon's minDaemonApi
//
// There's no "recommended" or "warning" state. Either you're at or above the
// remote's minimum (compatible) or you're below it (incompatible → block).
// Being at a lower API than the remote's current is non-blocking: you just
// don't see new features.
export interface ApiVersionInfo {
  current: number;
  minimum: number;
}

export type VersionCheckResult =
  | { status: "compatible" }
  | { status: "incompatible"; message: string };

export function checkApiVersionCompatibility(
  callerVersion: number,
  remote: ApiVersionInfo,
): VersionCheckResult {
  if (callerVersion < remote.minimum) {
    return {
      status: "incompatible",
      message: `API version ${callerVersion} is below the minimum required version ${remote.minimum}. Please upgrade to continue.`,
    };
  }
  return { status: "compatible" };
}

// Semver comparison helper for the user-facing client/server versions
// (used by the updater to compare GitHub Release tags). Returns -1/0/1.
export function compareSemver(a: string, b: string): number {
  const va = a.replace(/^v/, "").split(".").map(Number);
  const vb = b.replace(/^v/, "").split(".").map(Number);

  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const na = va[i] ?? 0;
    const nb = vb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}
