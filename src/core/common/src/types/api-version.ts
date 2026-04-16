export interface ApiVersionInfo {
  currentVersion: string;
  minimumVersion: string;
  recommendedVersion: string;
}

export type VersionCheckResult =
  | { status: "compatible" }
  | { status: "warning"; message: string }
  | { status: "incompatible"; message: string };

export function compareVersions(a: string, b: string): number {
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

export function checkVersionCompatibility(
  callerVersion: string,
  remote: ApiVersionInfo,
): VersionCheckResult {
  if (compareVersions(callerVersion, remote.minimumVersion) < 0) {
    return {
      status: "incompatible",
      message: `Version ${callerVersion} is below the minimum required version ${remote.minimumVersion}. Please upgrade to continue.`,
    };
  }

  if (compareVersions(callerVersion, remote.recommendedVersion) < 0) {
    return {
      status: "warning",
      message: `Version ${callerVersion} is below the recommended version ${remote.recommendedVersion}. Please consider upgrading.`,
    };
  }

  return { status: "compatible" };
}
