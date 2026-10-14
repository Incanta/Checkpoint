// State-tree access: build and materialize the content-addressed path tree, and
// adapt it to the fileId-keyed shape the daemon wire still expects (R2). The
// tree core lives in server/tree/; this module is the DB-backed entry point used
// by the routers. State is keyed by PATH -> sourceChangelistNumber.

import config from "@incanta/config";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  applyChanges,
  buildTree,
  listDir,
  lookup,
  materialize as materializeTree,
  diff as diffTrees,
  newTreeOpStats,
  BLOCK_BUDGET,
  type BlockStore,
  type DirListing,
  type Hash,
  type StateMap,
  type TreeChange,
  type TreeEdit,
  type TreeOpStats,
} from "./tree/tree";
import { BlockCache, CachingBlockStore } from "./tree/cache";
import { PrismaBlockStore } from "./tree/prisma-store";
import { StorageBlockStore } from "./tree/storage-store";

/** path -> sourceChangelistNumber (the materialized tree). */
export type PathStateMap = StateMap;

export type BlockStoreType = "storage" | "postgres";

// One cache for the process. Blocks are immutable, so it never goes stale.
let blockCache: BlockCache | null = null;
function sharedBlockCache(): BlockCache {
  if (!blockCache) {
    const configured = config.get<number | undefined>(
      "state-tree.block-cache-bytes",
    );
    blockCache = new BlockCache(configured ?? 128 * 1024 * 1024);
  }
  return blockCache;
}

/**
 * Select the block store backend. "storage" uses the configured storage server
 * (R2 / SeaweedFS / stub); "postgres" uses the TreeBlock table (tests, and
 * setups with no storage server). See config/default/state-tree.yaml. Either
 * way it is read and written through the shared block cache.
 */
function blockStoreFor(db: PrismaClient, repoId: string): CachingBlockStore {
  const backend = config.get<BlockStoreType>("state-tree.block-store");
  const inner: BlockStore =
    backend === "postgres"
      ? new PrismaBlockStore(db, repoId)
      : new StorageBlockStore(db, repoId);
  return new CachingBlockStore(inner, repoId, sharedBlockCache(), (hashes) =>
    storedLengths(db, repoId, hashes),
  );
}

/** Lengths recorded for stored blocks (see TreeBlockLength). */
async function storedLengths(
  db: PrismaClient,
  repoId: string,
  hashes: Hash[],
): Promise<Map<Hash, number>> {
  const out = new Map<Hash, number>();
  const CHUNK = 500;
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const rows = await db.treeBlockLength.findMany({
      where: { repoId, hash: { in: hashes.slice(i, i + CHUNK) } },
      select: { hash: true, length: true },
    });
    for (const row of rows) out.set(row.hash, row.length);
  }
  return out;
}

/**
 * Records the lengths of blocks the store wrote. Called after the blocks are
 * stored, so a row always describes a block that exists. Losing this write
 * costs only fetches later, never correctness.
 */
async function persistNewLengths(
  db: PrismaClient,
  repoId: string,
  store: CachingBlockStore,
): Promise<void> {
  const rows = [...store.takeNewLengths()];
  const CHUNK = 300;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const values = rows
      .slice(i, i + CHUNK)
      .map(([hash, length]) => Prisma.sql`(${repoId}, ${hash}, ${length})`);
    await db.$executeRaw`INSERT INTO "TreeBlockLength" ("repoId", "hash", "length") VALUES ${Prisma.join(values)} ON CONFLICT DO NOTHING`;
  }
}

function logTreeOp(
  op: string,
  repoId: string,
  stats: TreeOpStats,
  extra: Record<string, unknown> = {},
): void {
  // The server's logger lives in the app; plain console keeps this module
  // usable from scripts and tests.
  console.debug(
    `[state-tree] ${JSON.stringify({ op, repoId, ...extra, ...stats })}`,
  );
}

/** Build a state tree from path -> CL entries; returns the root block hash. */
export async function buildStateTreeBlocks(
  db: PrismaClient,
  repoId: string,
  entries: Iterable<[string, number]>,
): Promise<string> {
  const store = blockStoreFor(db, repoId);
  const stats = newTreeOpStats();
  const root = await buildTree(entries, store, BLOCK_BUDGET, stats);
  await persistNewLengths(db, repoId, store);
  logTreeOp("build", repoId, stats);
  return root;
}

/**
 * Apply edits to the tree rooted at `parentRoot` (null for none) and store
 * the new blocks; returns the new root hash. Reads and writes only what the
 * edits touch. Throws TreeCollisionError for an edit that would make a path
 * both a file and a directory.
 */
export async function applyStateTreeChanges(
  db: PrismaClient,
  repoId: string,
  parentRoot: string | null,
  edits: TreeEdit[],
): Promise<string> {
  const store = blockStoreFor(db, repoId);
  const stats = newTreeOpStats();
  const started = Date.now();
  const root = await applyChanges(parentRoot, edits, store, BLOCK_BUDGET, stats);
  await persistNewLengths(db, repoId, store);
  logTreeOp("apply", repoId, stats, {
    edits: edits.length,
    ms: Date.now() - started,
    cacheHits: store.stats.hits,
    cacheMisses: store.stats.misses,
  });
  return root;
}

export type IncrementalMode = "on" | "verify" | "strict" | "off";

/**
 * The state tree for a submit: the head's tree with `edits` applied. How it
 * is computed follows `state-tree.incremental`:
 *
 *   on      update only the edited paths.
 *   verify  update, also rebuild from the parent's full path map, log a
 *           mismatch as "[state-tree] MISMATCH" and use the rebuild's root.
 *   strict  like verify, but a mismatch throws (tests).
 *   off     rebuild from the parent's full path map.
 */
export async function submitStateTree(
  db: PrismaClient,
  repoId: string,
  parentNumber: number,
  parentRoot: string | null,
  edits: TreeEdit[],
): Promise<string> {
  const mode = config.get<IncrementalMode | undefined>("state-tree.incremental") ?? "on";

  const rebuild = async (): Promise<string> => {
    const paths = new Map(await getStateTreePaths(db, repoId, parentNumber));
    for (const e of edits) {
      if (e.delete) paths.delete(e.path);
      else paths.set(e.path, e.cl);
    }
    return buildStateTreeBlocks(db, repoId, paths.entries());
  };

  if (mode === "off") return rebuild();

  const incremental = await applyStateTreeChanges(db, repoId, parentRoot, edits);
  if (mode === "on") return incremental;

  const rebuilt = await rebuild();
  if (rebuilt !== incremental) {
    const message = `[state-tree] MISMATCH ${JSON.stringify({
      repoId,
      parentNumber,
      parentRoot,
      edits: edits.length,
      sample: edits.slice(0, 20),
      incremental,
      rebuilt,
    })}`;
    if (mode === "strict") throw new Error(message);
    console.error(message);
  }
  return rebuilt;
}

/** Source changelists of `paths` in the tree rooted at `rootHash`. */
export async function lookupStateTreePaths(
  db: PrismaClient,
  repoId: string,
  rootHash: string | null,
  paths: Iterable<string>,
): Promise<StateMap> {
  if (!rootHash) return new Map();
  return lookup(rootHash, paths, blockStoreFor(db, repoId));
}

/** The direct children of `dir` in the tree rooted at `rootHash`. */
export async function listStateTreeDir(
  db: PrismaClient,
  repoId: string,
  rootHash: string | null,
  dir: string,
): Promise<DirListing | null> {
  if (!rootHash) return dir ? null : { files: [], dirs: [] };
  return listDir(rootHash, dir, blockStoreFor(db, repoId));
}

/**
 * The number of files in a changelist's state. Submits and merges keep it
 * from the parent's count; a changelist from before that has none, so it is
 * counted from the tree once and recorded.
 */
export async function stateTreeFileCount(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
): Promise<number> {
  const cl = await db.changelist.findUnique({
    where: { repoId_number: { repoId, number: changelistNumber } },
    select: { fileCount: true, stateRootHash: true },
  });
  if (!cl) return 0;
  if (cl.fileCount !== null) return cl.fileCount;
  const count = cl.stateRootHash
    ? (await materializeStateTreeBlocks(db, repoId, cl.stateRootHash)).size
    : 0;
  await db.changelist.update({
    where: { repoId_number: { repoId, number: changelistNumber } },
    data: { fileCount: count },
  });
  return count;
}

/** The state-tree root hash of a changelist, or null if it has none. */
export async function stateRootOf(
  db: PrismaClient,
  repoId: string,
  changelistNumber: number,
): Promise<string | null> {
  return rootHashOf(db, repoId, changelistNumber);
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
// content addresses, so entries never go stale and need no invalidation:
// different content produces a different hash, hence a different key.
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

/** Clear the caches (test isolation; not needed for correctness). */
export function clearStateTreeCache(): void {
  pathTreeCache.clear();
  blockCache?.clear();
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
