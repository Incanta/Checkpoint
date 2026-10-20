import config from "@incanta/config";
import type { PrismaClient } from "@prisma/client";

import { createSystemToken } from "./storage-service";

// A changelist points its files at a version index, and nobody can sync them
// if that index is not in storage. The core server checks that on the submit
// path before it asks the app to record anything, but the app's own endpoints
// can be called by any token with write access (a script, the Horde client's
// artifact attach), so they check too: the index must exist under the repo's
// own prefix, which also rules out naming another repo's index.

/** Version index names: the SHA-256 of their bytes, as the core server makes them. */
const VERSION_INDEX_NAME = /^[0-9a-f]{64}\.lvi$/;

function verifying(): boolean {
  try {
    return (
      config.get<boolean | undefined>("storage.verify-version-index") ?? true
    );
  } catch {
    return true;
  }
}

/**
 * Why a changelist may not name `versionIndex`, or null when it may. Asks the
 * core server, so a storage backend that cannot be reached refuses rather
 * than lets the changelist through.
 */
export async function versionIndexProblem(
  db: PrismaClient,
  repoId: string,
  versionIndex: string,
): Promise<string | null> {
  if (!verifying()) return null;
  if (!VERSION_INDEX_NAME.test(versionIndex)) {
    return `${JSON.stringify(versionIndex)} is not a version index name`;
  }
  const repo = await db.repo.findUnique({
    where: { id: repoId },
    select: { orgId: true, r2BucketName: true },
  });
  if (!repo) return "the repo does not exist";

  const path = `/${repo.orgId}/${repoId}/versions/${versionIndex}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${await createSystemToken("version-head", path)}`,
    "x-checkpoint-path": path,
  };
  if (repo.r2BucketName) headers["x-checkpoint-bucket"] = repo.r2BucketName;

  try {
    const res = await fetch(
      `${config.get<string>("storage.backend-url.internal")}/system/version-exists?path=${encodeURIComponent(path)}`,
      { method: "GET", headers },
    );
    if (!res.ok) {
      return `could not confirm version index ${versionIndex} is in storage (${res.status})`;
    }
    const body = (await res.json()) as { exists?: boolean };
    return body.exists
      ? null
      : `version index ${versionIndex} is not in this repo's storage`;
  } catch (err) {
    return `could not confirm version index ${versionIndex} is in storage: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}
