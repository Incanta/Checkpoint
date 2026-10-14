// Reading Longtail's serialized store index (format 1.0.0) in TypeScript, for
// checks the server makes without the addon. Layout (little-endian): u32
// version, u32 hash identifier, u32 block count, u32 chunk count, u64 block
// hashes, u64 chunk hashes, u32 block chunk offsets, u32 block chunk counts,
// u32 block tags, u32 chunk sizes.

export interface StoreIndexSummary {
  hashIdentifier: number;
  /** Block hash (hex) -> its chunk hashes (hex), in order. */
  blocks: Map<string, string[]>;
  /** Total bytes of all chunks. */
  chunkBytes: number;
}

/** Parses a serialized store index; throws on a truncated or malformed one. */
export function readStoreIndexSummary(b: Buffer): StoreIndexSummary {
  if (b.length < 16) throw new Error("store index is truncated");
  const hashIdentifier = b.readUInt32LE(4);
  const blockCount = b.readUInt32LE(8);
  const chunkCount = b.readUInt32LE(12);
  const size = 16 + 8 * blockCount + 8 * chunkCount + 12 * blockCount + 4 * chunkCount;
  if (b.length < size) throw new Error("store index is truncated");

  const hex = (offset: number) => b.toString("hex", offset, offset + 8);
  const blockHashesAt = 16;
  const chunkHashesAt = blockHashesAt + 8 * blockCount;
  const offsetsAt = chunkHashesAt + 8 * chunkCount;
  const countsAt = offsetsAt + 4 * blockCount;
  const sizesAt = countsAt + 8 * blockCount; // past offsets, counts, and tags

  const blocks = new Map<string, string[]>();
  for (let i = 0; i < blockCount; i++) {
    const first = b.readUInt32LE(offsetsAt + 4 * i);
    const count = b.readUInt32LE(countsAt + 4 * i);
    if (first + count > chunkCount) throw new Error("store index block overruns its chunks");
    const chunks: string[] = [];
    for (let c = 0; c < count; c++) chunks.push(hex(chunkHashesAt + 8 * (first + c)));
    blocks.set(hex(blockHashesAt + 8 * i), chunks);
  }
  let chunkBytes = 0;
  for (let c = 0; c < chunkCount; c++) chunkBytes += b.readUInt32LE(sizesAt + 4 * c);
  return { hashIdentifier, blocks, chunkBytes };
}

/**
 * Why `part` is not contained in `whole` (every block present, with the same
 * chunks), or null if it is. A segment is only recorded when it is contained
 * in a block map the server has verified, so a client cannot get blocks into
 * the shared dedup index that it did not prove exist.
 */
export function containmentProblem(part: StoreIndexSummary, whole: StoreIndexSummary): string | null {
  for (const [block, chunks] of part.blocks) {
    const other = whole.blocks.get(block);
    if (!other) return `block ${block} is not in the block map`;
    if (other.length !== chunks.length || other.some((c, i) => c !== chunks[i])) {
      return `block ${block} lists different chunks than the block map`;
    }
  }
  return null;
}
