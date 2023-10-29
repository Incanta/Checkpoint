import { ObjectPointer } from "./pointer";
export interface VersionIndex {
    version: number;
    hashIdentifier: number;
    targetChunkSize: number;
    assetCount: number;
    chunkCount: number;
    assetChunkIndexCount: number;
    pathHashes: bigint[];
    contentHashes: bigint[];
    assetSizes: bigint[];
    assetChunkCounts: number[];
    assetChunkIndexStarts: number[];
    assetChunkIndexes: number[];
    chunkHashes: bigint[];
    chunkSizes: number[];
    chunkTags: number[];
    nameOffsets: number[];
    nameDataSize: number;
    permissions: number[];
    nameData: string[];
}
export declare class VersionIndexPointer extends ObjectPointer {
    constructor();
    get(): VersionIndex;
}
//# sourceMappingURL=version-index.d.ts.map