import { IKoffiRegisteredCallback } from "koffi";
import { LongtailApi } from "./longtail-api";
export declare class LongtailApiBlockStore extends LongtailApi {
    putStoredBlockHandle: IKoffiRegisteredCallback;
    preflightGetHandle: IKoffiRegisteredCallback;
    getStoredBlockHandle: IKoffiRegisteredCallback;
    getExistingContentHandle: IKoffiRegisteredCallback;
    pruneBlocksHandle: IKoffiRegisteredCallback;
    getStatsHandle: IKoffiRegisteredCallback;
    flushHandle: IKoffiRegisteredCallback;
    storeApi: any;
    nodeStoreApi: any;
    private blockLocks;
    private blocks;
    private longtail;
    constructor();
    putStoredBlock(blockStoreApi: any, storedBlock: any, asyncComplete: any): number;
    preflightGet(inBlockStoreApi: any, blockCount: number, inBlockHashes: any, inAsyncComplete: any): number;
    getStoredBlock(inBlockStoreApi: any, inBlockHash: any, inAsyncComplete: any): number;
    private getStoredBlockAsync;
    private getOrCreateBlockLock;
    getExistingContent(blockStoreApi: any, chunkCount: number, chunkHashes: bigint[], minBlockUsagePercent: number, asyncComplete: any): number;
    pruneBlocks(blockStoreApi: any, blockKeepCount: number, blockKeepHashes: bigint[], asyncComplete: any): number;
    getStats(blockStoreApi: any, outStats: any): number;
    flush(blockStoreApi: any, blockKeepCount: number, blockKeepHashes: bigint[], asyncComplete: any): number;
    unregister(): void;
    get(): any;
}
//# sourceMappingURL=longtail-api-block-store.d.ts.map