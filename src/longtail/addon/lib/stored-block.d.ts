import { ObjectPointer } from "./pointer";
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
export declare class StoredBlockPointer extends ObjectPointer {
    constructor();
    get(): StoredBlock;
}
//# sourceMappingURL=stored-block.d.ts.map