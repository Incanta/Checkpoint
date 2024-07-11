import { decode } from "koffi";
import { ObjectPointer } from "./pointer";
import { decodeHash, decodeHashes } from "../util/decode";

export interface BlockIndex {
  blockHash: bigint;
  hashIdentifier: number;
  chunkCount: number;
  tag: number;
  chunkHashes: bigint[];
  chunkSizes: number[];
}

export interface StoredBlock {
  blockIndex: BlockIndex;
  blockData: Uint8Array;
  blockChunksDataSize: number;
}

export class StoredBlockPointer extends ObjectPointer {
  constructor() {
    super();
  }

  public get(): StoredBlock {
    const result: StoredBlock = {
      blockIndex: {
        blockHash: BigInt(0),
        hashIdentifier: 0,
        chunkCount: 0,
        tag: 0,
        chunkHashes: [],
        chunkSizes: [],
      },
      blockData: new Uint8Array(),
      blockChunksDataSize: 0,
    };

    if (!this.valid()) {
      return result;
    }

    const baseStruct = decode(this.deref(), "Longtail_StoredBlock");
    const blockIndexStruct = decode(
      baseStruct.m_BlockIndex,
      "Longtail_BlockIndex"
    );

    result.blockIndex.blockHash = decodeHash(blockIndexStruct.m_BlockHash);
    result.blockIndex.hashIdentifier = decode(
      blockIndexStruct.m_HashIdentifier,
      "uint32_t"
    );
    result.blockIndex.chunkCount = decode(
      blockIndexStruct.m_ChunkCount,
      "uint32_t"
    );
    result.blockIndex.tag = decode(blockIndexStruct.m_Tag, "uint32_t");
    result.blockIndex.chunkHashes = decodeHashes(
      blockIndexStruct.m_ChunkHashes,
      result.blockIndex.chunkCount
    );

    for (let i = 0; i < result.blockIndex.chunkCount; i++) {
      result.blockIndex.chunkSizes.push(
        decode(blockIndexStruct.m_ChunkSizes, i * 4, "uint32_t")
      );
    }

    result.blockChunksDataSize = baseStruct.m_BlockChunksDataSize;
    result.blockData = decode(
      baseStruct.m_BlockData,
      "uint8",
      result.blockChunksDataSize
    );

    return result;
  }
}
