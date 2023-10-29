import { ObjectPointer } from "./pointer";
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
export declare class StoreIndexPointer extends ObjectPointer {
    constructor();
    get(): StoreIndex;
}
//# sourceMappingURL=store-index.d.ts.map