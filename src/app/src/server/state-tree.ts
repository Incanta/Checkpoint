// State-tree access: build and materialize the content-addressed path tree, and
// adapt it to the fileId-keyed shape the daemon wire still expects (R2). The
// tree core lives in server/tree/; this module is the DB-backed entry point used
// by the routers. State is keyed by PATH -> sourceChangelistNumber.

import config from "@incanta/config";
import { type PrismaClient } from "@prisma/client";
import {
  buildTree,
  materialize as materializeTree,
  diff as diffTrees,
  BLOCK_BUDGET,
  type BlockStore,
  type StateMap,
  type TreeChange,
} from "./tree/tree";
import { PrismaBlockStore } from "./tree/prisma-store";
import { StorageBlockStore } from "./tree/storage-store";

/** path -> sourceChangelistNumber (the materialized tree). */
export type PathStateMap = StateMap;

export type BlockStoreType = "storage" | "postgres";

/**
 * Select the block store backend. "storage" uses the configured storage server
 * (R2 / SeaweedFS / stub); "postgres" uses the TreeBlock table (tests, and
 * setups with no storage server). See config/default/state-tree.yaml.
 */
function blockStoreFor(db: PrismaClient, repoId: string): BlockStore {
  const backend = config.get<BlockStoreType>("state-tree.block-store");
  return backend === "postgres"
    ? new PrismaBlockStore(db, repoId)
    : new StorageBlockStore(db, repoId);
}

/** Build a state tree from path -> CL entries; returns the root block hash. */
export async function buildStateTreeBlocks(
  db: PrismaClient,
  repoId: string,
  entries: Iterable<[string, number]>,
): Promise<string> {
  return buildTree(entries, blockStoreFor(db, repoId), BLOCK_BUDGET);
}

/** Materialize a state tree (by root hash) into a path -> CL map. */
export async function materializeStateTreeBlocks(
  db: PrismaClient,
  repoId: string,
  rootHash: string,
): Promise<StateMap> {
  return materializeTree(rootHash, blockStoreFor(db, repoId));
}

// Cache materialized path maps by repoId:rootHash. Root hashes are immutable
// content addresses, so entries never go stale and need no invalidation (a
// mutated shelf CL gets a new root hash, hence a new key).
const PATH_CACHE_MAX = 256;
const pathTreeCache = new Map<string, StateMap>();
function pathKey(repoId: string, rootHash: string): string {
  return `${repoId}:${rootHash}`;
}
function pathCacheGet(key: string): StateMap | undefined {
  const hit = pathTreeCache.get(key);
  if (hit === undefined) return undefined;
  pathTreeCache.delete(key);
  pathTreeCache.set(key, hit);
  return hit;
}
function pathCacheSet(key: string, map: StateMap): void {
  pathTreeCache.delete(key);
  pathTreeCache.set(key, map);
  while (pathTreeCache.size > PATH_CACHE_MAX) {
    const oldest = pathTreeCache.keys().next().value;
    if (oldest === undefined) break;
    pathTreeCache.delete(oldest);
  }
}

/** Clear the cache (test isolation; not needed for correctness). */
export function clearStateTreeCache(): void {
  pathTreeCache.clear();
}

/** The materialized path -> CL state of a changelist (empty if it has no tree). */
export async function getStateTreePaths(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
): Promise<StateMap> {
  const cl = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { stateRootHash: true },
  });
  if (!cl?.stateRootHash) return new Map();
  const key = pathKey(repoId, cl.stateRootHash);
  const hit = pathCacheGet(key);
  if (hit) return hit;
  const map = await materializeStateTreeBlocks(db, repoId, cl.stateRootHash);
  pathCacheSet(key, map);
  return map;
}

/** Seed the path cache for a just-built tree (avoids re-materializing). */
export function primeStateTreePaths(
  repoId: string,
  rootHash: string,
  map: StateMap,
): void {
  pathCacheSet(pathKey(repoId, rootHash), new Map(map));
}

/** A changed file: path, source CL, and fileId (for the daemon's state file). */
export interface StateTreeChange {
  path: string;
  cl: number;
  fileId: string;
}

/** Path-keyed diff between two changelists, with the LVIs to pull. */
export interface StateTreeDiff {
  /** Files present at `to` but not `from`. */
  added: StateTreeChange[];
  /** Files removed between `from` and `to` (paths). */
  removed: string[];
  /** Files whose source CL changed between `from` and `to`. */
  modified: StateTreeChange[];
  /** Distinct source CLs among added+modified (the LVIs the client must pull). */
  changelistsToPull: number[];
}

/**
 * Resolve fileIds for a set of paths (changed paths only). Chunked into IN
 * batches, with a bounded number of batches in flight so a large changed set
 * (e.g. a fresh full sync of 100k+ files) doesn't run hundreds of queries
 * strictly one-after-another.
 */
async function fileIdsForPaths(
  db: PrismaClient,
  repoId: string,
  paths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const CHUNK = 500;
  const CONCURRENCY = 8;

  const batches: string[][] = [];
  for (let i = 0; i < paths.length; i += CHUNK) {
    batches.push(paths.slice(i, i + CHUNK));
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < batches.length) {
      const batch = batches[cursor++]!;
      const files = await db.file.findMany({
        where: { repoId, path: { in: batch } },
        select: { id: true, path: true },
      });
      for (const f of files) out.set(f.path, f.id);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () =>
      worker(),
    ),
  );
  return out;
}

async function rootHashOf(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
): Promise<string | null> {
  const cl = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { stateRootHash: true },
  });
  return cl?.stateRootHash ?? null;
}

/** Options controlling how much enrichment the diff performs. */
export interface DiffStateTreesOptions {
  /**
   * Resolve fileIds for ADDED paths. The daemon's pull path needs these (it
   * records fileId per file in the workspace state), but the sync-status path
   * does not (it reports added files by path only). Resolving them means one DB
   * query per ~500 added paths, so on a fresh full sync of a large repo it is
   * the dominant cost; skip it where it is unused. fileIds for MODIFIED paths
   * are always resolved (both callers need them, and the set is typically tiny).
   * Defaults to true to preserve the pull path's behavior.
   */
  resolveAddedFileIds?: boolean;
}

/**
 * Diff the state trees of two changelists, returning only the changed paths and
 * the source CLs to pull. This is the daemon's sync path: O(changed), not the
 * whole tree, and path-keyed (no fileId round-trips).
 */
export async function diffStateTrees(
  db: PrismaClient,
  repoId: string,
  fromNumber: number,
  toNumber: number,
  options: DiffStateTreesOptions = {},
): Promise<StateTreeDiff> {
  const resolveAddedFileIds = options.resolveAddedFileIds ?? true;
  const [fromRoot, toRoot] = await Promise.all([
    rootHashOf(db, repoId, fromNumber),
    rootHashOf(db, repoId, toNumber),
  ]);
  const store = blockStoreFor(db, repoId);

  let added: TreeChange[] = [];
  let removed: string[] = [];
  let modified: TreeChange[] = [];

  if (fromRoot && toRoot) {
    const d = await diffTrees(fromRoot, toRoot, store);
    added = d.added;
    removed = d.removed;
    modified = d.modified;
  } else if (toRoot) {
    // No base: everything at `to` is added (fresh sync from empty).
    for (const [path, cl] of await materializeTree(toRoot, store)) {
      added.push({ path, cl });
    }
  } else if (fromRoot) {
    // Target has no tree: everything removed.
    for (const [path] of await materializeTree(fromRoot, store)) {
      removed.push(path);
    }
  }

  const cls = new Set<number>();
  for (const c of added) cls.add(c.cl);
  for (const c of modified) cls.add(c.cl);

  // Attach fileIds for the changed paths (so the daemon can update its state
  // file without a full getFiles round-trip). Modified paths always; added
  // paths only when the caller needs them (the sync-status path does not, and
  // on a fresh full sync that set is the entire repo). Only changed paths, not
  // all files.
  const fileIdByPath = await fileIdsForPaths(db, repoId, [
    ...(resolveAddedFileIds ? added.map((c) => c.path) : []),
    ...modified.map((c) => c.path),
  ]);
  const enrich = (c: TreeChange): StateTreeChange => ({
    path: c.path,
    cl: c.cl,
    fileId: fileIdByPath.get(c.path) ?? "",
  });

  return {
    added: added.map(enrich),
    removed,
    modified: modified.map(enrich),
    changelistsToPull: [...cls].sort((a, b) => a - b),
  };
}
