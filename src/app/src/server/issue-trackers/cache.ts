import type { ExternalIssue } from "./types";

const CACHE_TTL_MS = 60 * 1000;

const CACHE_KEY = Symbol.for("checkpoint.issueTrackerCache");

interface CacheEntry {
  at: number;
  data: ExternalIssue[];
}

const globalForCache = globalThis as unknown as {
  [CACHE_KEY]?: Map<string, CacheEntry>;
};

function getCache(): Map<string, CacheEntry> {
  globalForCache[CACHE_KEY] ??= new Map();
  return globalForCache[CACHE_KEY];
}

export function getCachedIssues(repoId: string): ExternalIssue[] | null {
  const entry = getCache().get(repoId);
  if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
    return null;
  }
  return entry.data;
}

export function setCachedIssues(repoId: string, data: ExternalIssue[]) {
  getCache().set(repoId, { at: Date.now(), data });
}

export function invalidateIssueCache(repoId: string) {
  getCache().delete(repoId);
}
