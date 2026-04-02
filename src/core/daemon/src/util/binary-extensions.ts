import { CreateApiClientAuth } from "@checkpointvcs/common";

const cache = new Map<string, { extensions: Set<string>; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetches the resolved binary extensions for an org (via the repo)
 * and caches the result.
 */
export async function getBinaryExtensions(
  daemonId: string,
  repoId: string,
): Promise<Set<string>> {
  const cacheKey = `${daemonId}:${repoId}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.extensions;
  }

  const client = await CreateApiClientAuth(daemonId);
  const repo = await client.repo.getRepo.query({ id: repoId });
  if (!repo) {
    throw new Error("Could not find repository");
  }

  const result = await (client.org as any).getBinaryExtensions.query({
    orgId: repo.orgId,
  });

  const extensions = new Set<string>(result.resolved as string[]);
  cache.set(cacheKey, {
    extensions,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return extensions;
}

/**
 * Checks whether a file is binary given an extensions set.
 */
export function isBinaryFile(
  filePath: string,
  extensions: Set<string>,
): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot === -1) return false;
  return extensions.has(filePath.slice(dot).toLowerCase());
}
