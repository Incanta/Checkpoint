// Process-wide cache of state-tree blocks, and a BlockStore wrapper that uses
// it.
//
// Blocks are content-addressed and immutable, so a cached block can never be
// stale and needs no invalidation. The cache is bounded by bytes rather than
// entries (a whole large repo's tree is ~10 MB), and concurrent requests for
// the same block share one fetch.
//
// A block in the cache is known to be in the store: it got there by being
// read from the store or written to it. So a write of a cached block is
// skipped, which turns "write every block" into "write only new blocks"
// even for callers that do not track that themselves.

import { hashBytes, toHex } from "./hash";
import type { BlockStore, Hash } from "./tree";

export class BlockCache {
  private readonly blocks = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, Promise<Uint8Array>>();
  private bytes = 0;
  /** Lengths outlive their blocks in the cache: they are tiny. */
  private readonly lengths = new Map<string, number>();
  private static readonly MAX_LENGTHS = 1_000_000;

  public constructor(private readonly maxBytes: number) {}

  public has(key: string): boolean {
    return this.blocks.has(key);
  }

  public length(key: string): number | undefined {
    return this.lengths.get(key);
  }

  public rememberLength(key: string, length: number): void {
    if (this.lengths.size >= BlockCache.MAX_LENGTHS) this.lengths.clear();
    this.lengths.set(key, length);
  }

  public set(key: string, bytes: Uint8Array): void {
    this.rememberLength(key, bytes.length);
    if (bytes.length > this.maxBytes) return;
    const old = this.blocks.get(key);
    if (old) {
      this.blocks.delete(key);
      this.bytes -= old.length;
    }
    this.blocks.set(key, bytes);
    this.bytes += bytes.length;
    while (this.bytes > this.maxBytes) {
      const oldest = this.blocks.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.blocks.get(oldest)!.length;
      this.blocks.delete(oldest);
    }
  }

  /** The cached block, or `load()` it once however many callers ask. */
  public async getOrLoad(
    key: string,
    load: () => Promise<Uint8Array>,
  ): Promise<{ bytes: Uint8Array; hit: boolean }> {
    const hit = this.blocks.get(key);
    if (hit) {
      // Refresh recency.
      this.blocks.delete(key);
      this.blocks.set(key, hit);
      return { bytes: hit, hit: true };
    }
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    // A failed load is not cached; the next caller tries again.
    const bytes = await pending;
    this.set(key, bytes);
    return { bytes, hit: false };
  }

  public clear(): void {
    this.blocks.clear();
    this.inflight.clear();
    this.lengths.clear();
    this.bytes = 0;
  }

  public get size(): { blocks: number; bytes: number } {
    return { blocks: this.blocks.size, bytes: this.bytes };
  }
}

export interface CachingStats {
  hits: number;
  misses: number;
  /** Writes skipped because the block was already cached (so stored). */
  putsSkipped: number;
}

/**
 * A BlockStore over another, through a shared {@link BlockCache}. Records the
 * lengths of blocks it writes so they can be persisted (see takeNewLengths).
 */
export class CachingBlockStore implements BlockStore {
  public readonly stats: CachingStats = { hits: 0, misses: 0, putsSkipped: 0 };
  private readonly newLengths = new Map<Hash, number>();

  public constructor(
    private readonly inner: BlockStore,
    private readonly repoId: string,
    private readonly cache: BlockCache,
    /** Persisted lengths, for blocks this process has not seen. */
    private readonly lengthSource?: (hashes: Hash[]) => Promise<Map<Hash, number>>,
  ) {}

  private key(hash: Hash): string {
    return `${this.repoId}:${hash}`;
  }

  public async put(bytes: Uint8Array): Promise<Hash> {
    const hash = toHex(hashBytes(bytes));
    const key = this.key(hash);
    if (this.cache.has(key)) {
      this.stats.putsSkipped++;
      return hash;
    }
    await this.inner.put(bytes);
    this.cache.set(key, bytes);
    this.newLengths.set(hash, bytes.length);
    return hash;
  }

  public async get(hash: Hash): Promise<Uint8Array> {
    const { bytes, hit } = await this.cache.getOrLoad(this.key(hash), () =>
      this.inner.get(hash),
    );
    if (hit) this.stats.hits++;
    else this.stats.misses++;
    return bytes;
  }

  public async lengths(hashes: Hash[]): Promise<Map<Hash, number>> {
    const out = new Map<Hash, number>();
    const missing: Hash[] = [];
    for (const hash of hashes) {
      const known = this.cache.length(this.key(hash));
      if (known !== undefined) out.set(hash, known);
      else missing.push(hash);
    }
    if (missing.length > 0 && this.lengthSource) {
      for (const [hash, length] of await this.lengthSource(missing)) {
        out.set(hash, length);
        this.cache.rememberLength(this.key(hash), length);
      }
    }
    return out;
  }

  /** Lengths of the blocks written since the last call, to persist. */
  public takeNewLengths(): Map<Hash, number> {
    const taken = new Map(this.newLengths);
    this.newLengths.clear();
    return taken;
  }
}
