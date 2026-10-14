// The repo's dedup index, as immutable segments instead of one store.lsi.
//
// A submit needs to know which of its chunks the store already has. That was
// the repo-wide store.lsi: every submitting client downloaded it whole, and
// the server read, merged, and rewrote it whole on every submit under a
// repo-wide lock. It grows with the repo, so every submit cost more than the
// last.
//
// Now each submit writes one immutable segment (the blocks it uploaded) and
// nothing else, with no lock. Servers keep a repo's index in memory (a
// native IndexCache) and answer existing-content queries from it.
//
// Storage layout, under a repo's base path:
//
//   index/seg/<YYYYMMDD>/<sha256>-<mac16>.lsi   one per submit, write-once
//   index/base/<sha256>-<mac16>.lsi             a compacted snapshot
//   index/base.json                             { base, watermarkDay, ... }
//
// Several servers may share one store. Each finds segments it has not seen by
// listing day buckets (today and yesterday on a catch-up, everything after
// the base's watermark on a cold load). A server that misses a segment for a
// while only answers that some chunks are missing, and the client uploads
// them again: staleness costs bytes, never correctness.
//
// Every name carries a MAC over the repo and the content hash. In r2 mode
// clients hold bucket-wide credentials and could write objects here; a name
// that does not verify is ignored, so a forged segment cannot make a submit
// skip uploading chunks the store does not have.

import { createHash, createHmac } from "crypto";
import config from "@incanta/config";
import {
  indexCacheAdd,
  indexCacheCreate,
  indexCacheQuery,
  indexCacheSerialize,
  indexCacheStats,
  type IndexCacheHandle,
} from "@checkpointvcs/longtail-addon";
import type { StorageBackend } from "./backend.js";
import { storageSigningKey } from "../utils/signing-key.js";
import { Logger } from "../logging.js";
import { storeBlockMap } from "./block-maps.js";
import { migrateRepoInBackground } from "./index-migration.js";
import { withLease } from "./lease.js";

export const INDEX_KEY_ENV = "CHECKPOINT_STORAGE_INDEX_KEY";

/**
 * The key segment names are MAC'd with. A dedicated key, so rotating the
 * storage signing key does not invalidate every segment (which would only
 * cost re-uploads, but all of them). Falls back to the signing key.
 */
function indexKey(): string {
  const fromEnv = process.env[INDEX_KEY_ENV];
  if (fromEnv) return fromEnv;
  const configured = config.get<string | undefined>("storage.index.signing-key");
  return configured || storageSigningKey();
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function mac(repoId: string, sha: string): string {
  return createHmac("sha256", indexKey())
    .update(`${repoId}:${sha}`)
    .digest("hex")
    .slice(0, 16);
}

/** The write-once name of an index object with this content. */
export function indexObjectName(repoId: string, buffer: Buffer): string {
  const sha = sha256(buffer);
  return `${sha}-${mac(repoId, sha)}.lsi`;
}

/** Whether `buffer` is genuinely the object this server would name `name`. */
export function verifyIndexObject(repoId: string, name: string, buffer: Buffer): boolean {
  const match = /^([0-9a-f]{64})-([0-9a-f]{16})\.lsi$/.exec(name);
  if (!match) return false;
  return match[1] === sha256(buffer) && match[2] === mac(repoId, match[1]!);
}

/** UTC day bucket of a time, as YYYYMMDD. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replaceAll("-", "");
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface BaseInfo {
  /** Object name under index/base/. */
  base: string;
  /** Segments in day buckets up to and including this one are in the base. */
  watermarkDay: string;
  segmentCount: number;
  createdAt: string;
}

/** One repo's index, in memory. */
class RepoIndex {
  public readonly cache: IndexCacheHandle = indexCacheCreate();
  private readonly known = new Set<string>();
  private lastCatchUp = 0;
  private catchingUp: Promise<void> | null = null;
  public loaded: Promise<void> | null = null;
  public chunks = 0;
  public segmentsSinceBase = 0;
  public baseCreatedAt: string | null = null;

  public constructor(
    private readonly repoId: string,
    private readonly basePath: string,
    private readonly backend: StorageBackend,
  ) {}

  private add(buffer: Buffer): void {
    indexCacheAdd(this.cache, buffer);
    this.chunks = indexCacheStats(this.cache).chunks;
  }

  /** Adds a segment this server knows to be genuine (it just wrote it). */
  public addOwnSegment(day: string, name: string, buffer: Buffer): void {
    const key = `${day}/${name}`;
    if (this.known.has(key)) return;
    this.known.add(key);
    this.add(buffer);
    this.segmentsSinceBase++;
  }

  private async addDay(day: string): Promise<void> {
    const prefix = `${this.basePath}/index/seg/${day}`;
    const names = (await this.backend.listKeys(prefix)).filter(
      (n) => !this.known.has(`${day}/${n}`),
    );
    const CONCURRENCY = 8;
    for (let i = 0; i < names.length; i += CONCURRENCY) {
      const batch = names.slice(i, i + CONCURRENCY);
      const buffers = await Promise.all(
        batch.map((n) => this.backend.getBuffer(`${prefix}/${n}`)),
      );
      batch.forEach((name, j) => {
        const buffer = buffers[j];
        this.known.add(`${day}/${name}`);
        if (!buffer) return;
        if (!verifyIndexObject(this.repoId, name, buffer)) {
          Logger.warn(`[index] ignoring segment that does not verify: ${prefix}/${name}`);
          return;
        }
        try {
          this.add(buffer);
          this.segmentsSinceBase++;
        } catch (e) {
          Logger.warn(`[index] ignoring unreadable segment ${prefix}/${name}: ${(e as Error).message}`);
        }
      });
    }
  }

  /** Cold load: the base (or the legacy store.lsi), then later segments. */
  public async load(): Promise<void> {
    const started = Date.now();
    let watermark: string | null = null;
    const baseInfo = await this.backend.getBuffer(`${this.basePath}/index/base.json`);
    if (baseInfo) {
      try {
        const info = JSON.parse(baseInfo.toString("utf8")) as BaseInfo;
        const base = await this.backend.getBuffer(`${this.basePath}/index/base/${info.base}`);
        if (base && verifyIndexObject(this.repoId, info.base, base)) {
          this.add(base);
          watermark = info.watermarkDay;
          this.baseCreatedAt = info.createdAt;
        }
      } catch (e) {
        Logger.warn(`[index] unreadable base.json for ${this.basePath}: ${(e as Error).message}`);
      }
    }
    if (watermark === null) {
      // No base yet: the store index from before segments, written only by
      // servers, is the base.
      const legacy = await this.backend.getBuffer(`${this.basePath}/store.lsi`);
      if (legacy) this.add(legacy);
    }

    // Segments after the watermark. The day before it is read again, since
    // a segment can land in a bucket a compactor had already listed.
    const days = new Set(
      (await this.backend.listKeys(`${this.basePath}/index/seg`))
        .map((k) => k.split("/")[0]!)
        .filter((d) => /^\d{8}$/.test(d)),
    );
    const from = watermark ? dayOf(Date.parse(`${watermark.slice(0, 4)}-${watermark.slice(4, 6)}-${watermark.slice(6)}T00:00:00Z`) - DAY_MS) : "";
    for (const day of [...days].sort()) {
      if (day >= from) await this.addDay(day);
    }
    this.lastCatchUp = Date.now();
    Logger.info(
      `[index-cache] ${JSON.stringify({ op: "load", basePath: this.basePath, chunks: this.chunks, ms: Date.now() - started })}`,
    );
  }

  /** Picks up segments other servers wrote recently; at most once a second. */
  public async catchUp(): Promise<void> {
    if (this.catchingUp) return this.catchingUp;
    if (Date.now() - this.lastCatchUp < 1000) return;
    this.catchingUp = (async () => {
      const now = Date.now();
      await this.addDay(dayOf(now - DAY_MS));
      await this.addDay(dayOf(now));
      this.lastCatchUp = Date.now();
    })().finally(() => {
      this.catchingUp = null;
    });
    return this.catchingUp;
  }

  public query(chunkHashes: Buffer, minBlockUsagePercent: number): Buffer {
    return indexCacheQuery(this.cache, chunkHashes, minBlockUsagePercent);
  }

  public serialize(): Buffer {
    return indexCacheSerialize(this.cache);
  }
}

// ── registry ──────────────────────────────────────────────────────

// About 24 bytes per chunk in the native cache plus map overhead.
const BYTES_PER_CHUNK = 64;
const repos = new Map<string, RepoIndex>();

function maxCacheBytes(): number {
  return config.get<number | undefined>("storage.index.cache-bytes") ?? 1024 * 1024 * 1024;
}

function evict(): void {
  let total = 0;
  for (const r of repos.values()) total += r.chunks * BYTES_PER_CHUNK;
  // Least recently used first (Map iteration order; see repoIndex).
  for (const [key, r] of repos) {
    if (total <= maxCacheBytes() || repos.size <= 1) break;
    total -= r.chunks * BYTES_PER_CHUNK;
    repos.delete(key);
    Logger.info(`[index-cache] ${JSON.stringify({ op: "evict", key, chunks: r.chunks })}`);
  }
}

function repoIndex(repoId: string, basePath: string, backend: StorageBackend): RepoIndex {
  const key = `${repoId}:${basePath}`;
  let r = repos.get(key);
  if (r) {
    repos.delete(key);
  } else {
    r = new RepoIndex(repoId, basePath, backend);
  }
  repos.set(key, r);
  return r;
}

/** Drop every in-memory index (tests). */
export function clearIndexCaches(): void {
  repos.clear();
}

/**
 * Records a submit's new blocks as a segment. Write-once and lock-free: two
 * submits of the same blocks produce the same name, and the second write is
 * a no-op. Returns the segment's key, or null when there was nothing new.
 */
export async function writeSegment(
  backend: StorageBackend,
  repoId: string,
  basePath: string,
  missingStoreIndex: Buffer,
  blockCount: number,
): Promise<string | null> {
  if (blockCount === 0) return null;
  const day = dayOf(Date.now());
  const name = indexObjectName(repoId, missingStoreIndex);
  const key = `${basePath}/index/seg/${day}/${name}`;
  await backend.putIfAbsent(key, missingStoreIndex);
  const loaded = repos.get(`${repoId}:${basePath}`);
  if (loaded?.loaded) loaded.addOwnSegment(day, name, missingStoreIndex);
  if (needsCompaction(repoId, basePath)) {
    void compactInBackground(backend, repoId, basePath);
  }
  return key;
}

/**
 * Compacts a repo's index off the submit path, under a lease so only one
 * server does it at a time. Never throws.
 */
async function compactInBackground(
  backend: StorageBackend,
  repoId: string,
  basePath: string,
): Promise<void> {
  try {
    await withLease(
      backend,
      `${basePath}/index/compact.lease`,
      async () => {
        if (!needsCompaction(repoId, basePath)) return;
        const started = Date.now();
        const done = await compactIndex(backend, repoId, basePath);
        Logger.info(
          `[index-compact] ${JSON.stringify({ basePath, ...done, ms: Date.now() - started })}`,
        );
      },
      // Another server holding it is compacting: skip, do not wait.
      { acquireTimeoutMs: 1 },
    );
  } catch (e) {
    Logger.info(`[index-compact] ${basePath}: not run now (${(e as Error).message})`);
  }
}

export interface ExistingContentAnswer {
  storeIndex: Buffer;
  /** False when the index was not ready in time and the answer is empty. */
  complete: boolean;
}

/**
 * Which of `chunkHashes` (little-endian u64s) the store already has, as the
 * store index of the blocks to reuse. Exactly the answer the old client-side
 * lookup against store.lsi gave, minus anything this server has not caught up
 * with yet.
 */
export async function existingContent(
  backend: StorageBackend,
  repoId: string,
  basePath: string,
  chunkHashes: Buffer,
  minBlockUsagePercent: number,
  options: { coldLoadTimeoutMs?: number; emptyIndex: () => Buffer },
): Promise<ExistingContentAnswer> {
  const index = repoIndex(repoId, basePath, backend);
  if (!index.loaded) {
    index.loaded = index
      .load()
      .then(() => {
        // Versions from before block maps get theirs now, in the background.
        void migrateRepoInBackground({
          backend,
          repoId,
          basePath,
          query: (hashes) => index.query(hashes, 0),
          storeBlockMap: (versionIndex, blockMap) =>
            storeBlockMap(repoId, basePath, versionIndex, blockMap),
        });
      })
      .catch((e) => {
        // Let the next request try again.
        index.loaded = null;
        throw e;
      });
  }
  const timeout = options.coldLoadTimeoutMs ?? 60_000;
  const ready = await Promise.race([
    index.loaded.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeout)),
  ]);
  if (!ready) {
    // An empty answer only means the client uploads its whole change.
    return { storeIndex: options.emptyIndex(), complete: false };
  }
  await index.catchUp();
  evict();
  return { storeIndex: index.query(chunkHashes, minBlockUsagePercent), complete: true };
}

/**
 * Folds every segment into a new base snapshot, off the submit path. Only
 * one server should compact a repo at a time (the caller holds a lease);
 * racing compactors only make base.json point at an older snapshot, which
 * costs re-reading some segments.
 */
export async function compactIndex(
  backend: StorageBackend,
  repoId: string,
  basePath: string,
): Promise<{ base: string; chunks: number } | null> {
  const index = repoIndex(repoId, basePath, backend);
  if (!index.loaded) index.loaded = index.load();
  await index.loaded;
  await index.catchUp();
  // Everything up to yesterday is in memory now; today's bucket may still be
  // receiving segments, so the watermark stops short of it.
  const watermarkDay = dayOf(Date.now() - DAY_MS);
  const snapshot = index.serialize();
  const name = indexObjectName(repoId, snapshot);
  await backend.putIfAbsent(`${basePath}/index/base/${name}`, snapshot);
  const info: BaseInfo = {
    base: name,
    watermarkDay,
    segmentCount: index.segmentsSinceBase,
    createdAt: new Date().toISOString(),
  };
  const body = Buffer.from(JSON.stringify(info, null, 2));
  await backend.put(`${basePath}/index/base.json`, body, body.length);
  index.segmentsSinceBase = 0;
  index.baseCreatedAt = info.createdAt;

  // Segments the base has long since absorbed. A margin past the watermark
  // keeps them for any server still loading an older base.json.
  const pruneBefore = dayOf(Date.now() - 15 * DAY_MS);
  for (const key of await backend.listKeys(`${basePath}/index/seg`)) {
    const day = key.split("/")[0]!;
    if (/^\d{8}$/.test(day) && day < pruneBefore) {
      await backend.delete(`${basePath}/index/seg/${key}`);
    }
  }
  return { base: name, chunks: index.chunks };
}

/** Whether a repo's index has grown enough since its base to compact. */
export function needsCompaction(repoId: string, basePath: string): boolean {
  const index = repos.get(`${repoId}:${basePath}`);
  if (!index?.loaded) return false;
  if (index.segmentsSinceBase > 500) return true;
  const age = index.baseCreatedAt ? Date.now() - Date.parse(index.baseCreatedAt) : Infinity;
  return index.segmentsSinceBase > 0 && age > 7 * DAY_MS;
}
