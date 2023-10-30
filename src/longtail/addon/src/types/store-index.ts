import { decode } from "koffi";
import { ObjectPointer } from "./pointer";
import { decodeHash } from "../util/decode";

export interface Chunk {
  hash: bigint;
  size: number;
}

export interface Block {
  hash: bigint;
  chunks: Chunk[];
}

export interface StoreIndex {
  version: number;
  hashIdentifier: number;
  blockCount: number;
  chunkCount: number;
  blockHashes: bigint[];

  /**
   * All of the chunk hashes for all blocks. Each block starts at
   * blockChunkOffsets[blockIndex] and has blockChunkCounts[blockIndex]
   * sequential chunks.
   */
  chunkHashes: bigint[];

  /**
   * The offset of the first chunk hash of each block for chunkHashes
   */
  blockChunkOffsets: number[];

  /**
   * The number of chunks in each block
   */
  blockChunkCounts: number[];
  blockTags: number[];
  chunkSizes: number[];

  /**
   * The assembled blocks
   */
  blocks: Block[];
}

export class StoreIndexPointer extends ObjectPointer {
  constructor() {
    super();
  }

  public get(): StoreIndex {
    const result: StoreIndex = {
      version: 0,
      hashIdentifier: 0,
      blockCount: 0,
      chunkCount: 0,
      blockHashes: [],
      chunkHashes: [],
      blockChunkOffsets: [],
      blockChunkCounts: [],
      blockTags: [],
      chunkSizes: [],
      blocks: [],
    };

    if (!this.valid()) {
      return result;
    }

    const baseStruct = decode(this.deref(), "Longtail_StoreIndex");

    result.version = decode(baseStruct.m_Version, "uint32_t");
    result.hashIdentifier = decode(baseStruct.m_HashIdentifier, "uint32_t");
    result.blockCount = decode(baseStruct.m_BlockCount, "uint32_t");
    result.chunkCount = decode(baseStruct.m_ChunkCount, "uint32_t");

    for (let i = 0; i < result.blockCount; i++) {
      result.blockHashes.push(decodeHash(baseStruct.m_BlockHashes, i));
      result.blockChunkOffsets.push(
        decode(baseStruct.m_BlockChunksOffsets, i * 4, "uint32_t"),
      );
      result.blockChunkCounts.push(
        decode(baseStruct.m_BlockChunkCounts, i * 4, "uint32_t"),
      );
      result.blockTags.push(decode(baseStruct.m_BlockTags, i * 4, "uint32_t"));
    }

    for (let i = 0; i < result.chunkCount; i++) {
      result.chunkHashes.push(decodeHash(baseStruct.m_ChunkHashes, i));
      result.chunkSizes.push(
        decode(baseStruct.m_ChunkSizes, i * 4, "uint32_t"),
      );
    }

    for (let i = 0; i < result.blockCount; i++) {
      const block: Block = {
        hash: result.blockHashes[i],
        chunks: [],
      };

      const offset = result.blockChunkOffsets[i];
      const count = result.blockChunkCounts[i];

      for (let j = offset; j < offset + count; j++) {
        block.chunks.push({
          hash: result.chunkHashes[j],
          size: result.chunkSizes[j],
        });
      }

      result.blocks.push(block);
    }

    return result;
  }
}
