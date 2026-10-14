/**
 * Longtail's serialized store index (format 1.0.0), for tests: build random
 * ones and read the server's answers. Layout (little-endian):
 *
 *   u32 version (1 << 24), u32 hash identifier, u32 block count, u32 chunk count,
 *   u64 block hashes[blocks], u64 chunk hashes[chunks],
 *   u32 block chunk offsets[blocks], u32 block chunk counts[blocks],
 *   u32 block tags[blocks], u32 chunk sizes[chunks]
 */

export interface StoreIndexBlock {
  hash: bigint;
  tag: number;
  chunks: { hash: bigint; size: number }[];
}

export interface StoreIndex {
  hashIdentifier: number;
  blocks: StoreIndexBlock[];
}

export function writeStoreIndex(index: StoreIndex): Buffer {
  const blockCount = index.blocks.length;
  const chunkCount = index.blocks.reduce((n, b) => n + b.chunks.length, 0);
  const b = Buffer.alloc(16 + 8 * blockCount + 8 * chunkCount + 12 * blockCount + 4 * chunkCount);
  b.writeUInt32LE(1 << 24, 0);
  b.writeUInt32LE(blockCount > 0 ? index.hashIdentifier : 0, 4);
  b.writeUInt32LE(blockCount, 8);
  b.writeUInt32LE(chunkCount, 12);
  let p = 16;
  for (const block of index.blocks) {
    b.writeBigUInt64LE(block.hash, p);
    p += 8;
  }
  for (const block of index.blocks) {
    for (const c of block.chunks) {
      b.writeBigUInt64LE(c.hash, p);
      p += 8;
    }
  }
  let offset = 0;
  for (const block of index.blocks) {
    b.writeUInt32LE(offset, p);
    p += 4;
    offset += block.chunks.length;
  }
  for (const block of index.blocks) {
    b.writeUInt32LE(block.chunks.length, p);
    p += 4;
  }
  for (const block of index.blocks) {
    b.writeUInt32LE(block.tag, p);
    p += 4;
  }
  for (const block of index.blocks) {
    for (const c of block.chunks) {
      b.writeUInt32LE(c.size, p);
      p += 4;
    }
  }
  return b;
}

export function readStoreIndex(b: Buffer): StoreIndex {
  const hashIdentifier = b.readUInt32LE(4);
  const blockCount = b.readUInt32LE(8);
  const chunkCount = b.readUInt32LE(12);
  let p = 16;
  const blockHashes: bigint[] = [];
  for (let i = 0; i < blockCount; i++, p += 8) blockHashes.push(b.readBigUInt64LE(p));
  const chunkHashes: bigint[] = [];
  for (let i = 0; i < chunkCount; i++, p += 8) chunkHashes.push(b.readBigUInt64LE(p));
  const offsets: number[] = [];
  for (let i = 0; i < blockCount; i++, p += 4) offsets.push(b.readUInt32LE(p));
  const counts: number[] = [];
  for (let i = 0; i < blockCount; i++, p += 4) counts.push(b.readUInt32LE(p));
  const tags: number[] = [];
  for (let i = 0; i < blockCount; i++, p += 4) tags.push(b.readUInt32LE(p));
  const sizes: number[] = [];
  for (let i = 0; i < chunkCount; i++, p += 4) sizes.push(b.readUInt32LE(p));
  return {
    hashIdentifier,
    blocks: blockHashes.map((hash, i) => ({
      hash,
      tag: tags[i]!,
      chunks: Array.from({ length: counts[i]! }, (_, c) => ({
        hash: chunkHashes[offsets[i]! + c]!,
        size: sizes[offsets[i]! + c]!,
      })),
    })),
  };
}

/** Chunk hashes as the little-endian u64 buffer the native APIs take. */
export function hashesBuffer(hashes: bigint[]): Buffer {
  const b = Buffer.alloc(hashes.length * 8);
  hashes.forEach((h, i) => b.writeBigUInt64LE(h, i * 8));
  return b;
}
