import { IKoffiRegisteredCallback, register, sizeof, unregister } from "koffi";
import { LongtailApi } from "./longtail-api";
import { Longtail } from "./longtail";

export class LongtailApiBlockStore extends LongtailApi {
  public putStoredBlockHandle: IKoffiRegisteredCallback;
  public preflightGetHandle: IKoffiRegisteredCallback;
  public getStoredBlockHandle: IKoffiRegisteredCallback;
  public getExistingContentHandle: IKoffiRegisteredCallback;
  public pruneBlocksHandle: IKoffiRegisteredCallback;
  public getStatsHandle: IKoffiRegisteredCallback;
  public flushHandle: IKoffiRegisteredCallback;

  public storeApi: any;
  public nodeStoreApi: any;

  public constructor() {
    super();

    this.putStoredBlockHandle = register(
      this,
      this.putStoredBlock,
      "Longtail_BlockStore_PutStoredBlockFunc*",
    );

    this.preflightGetHandle = register(
      this,
      this.preflightGet,
      "Longtail_BlockStore_PreflightGetFunc*",
    );

    this.getStoredBlockHandle = register(
      this,
      this.getStoredBlock,
      "Longtail_BlockStore_GetStoredBlockFunc*",
    );

    this.getExistingContentHandle = register(
      this,
      this.getExistingContent,
      "Longtail_BlockStore_GetExistingContentFunc*",
    );

    this.pruneBlocksHandle = register(
      this,
      this.pruneBlocks,
      "Longtail_BlockStore_PruneBlocksFunc*",
    );

    this.getStatsHandle = register(
      this,
      this.getStats,
      "Longtail_BlockStore_GetStatsFunc*",
    );

    this.flushHandle = register(
      this,
      this.flush,
      "Longtail_BlockStore_FlushFunc*",
    );

    const longtail = Longtail.get();
    this.storeApi = longtail.Alloc(
      "NodeJSStoreAPI",
      sizeof("Longtail_BlockStoreAPI"),
    );

    this.nodeStoreApi = longtail.MakeBlockStoreAPI(
      this.storeApi,
      super.disposeHandle,
      this.putStoredBlockHandle,
      this.preflightGetHandle,
      this.getStoredBlockHandle,
      this.getExistingContentHandle,
      this.pruneBlocksHandle,
      this.getStatsHandle,
      this.flushHandle,
    );
  }

  public putStoredBlock(
    blockStoreApi: any,
    storedBlock: any,
    asyncComplete: any,
  ): number {
    console.log("PutStoredBlock func");
    return 0;
  }

  public preflightGet(
    blockStoreApi: any,
    blockCount: number,
    blockHashes: bigint[],
    asyncComplete: any,
  ): number {
    console.log("PreflightGet func");
    return 0;
  }

  public getStoredBlock(
    blockStoreApi: any,
    blockHash: bigint,
    asyncComplete: any,
  ): number {
    console.log("GetStoredBlock func");
    return 0;
  }

  public getExistingContent(
    blockStoreApi: any,
    chunkCount: number,
    chunkHashes: bigint[],
    minBlockUsagePercent: number,
    asyncComplete: any,
  ): number {
    console.log(`GetExistingContent func`);
    console.log(chunkHashes);
    return 0;
  }

  public pruneBlocks(
    blockStoreApi: any,
    blockKeepCount: number,
    blockKeepHashes: bigint[],
    asyncComplete: any,
  ): number {
    console.log("PruneBlocks func");
    return 0;
  }

  public getStats(blockStoreApi: any, outStats: any): number {
    console.log("GetStats func");
    return 0;
  }

  public flush(
    blockStoreApi: any,
    blockKeepCount: number,
    blockKeepHashes: bigint[],
    asyncComplete: any,
  ): number {
    console.log("Flush func");
    return 0;
  }

  public unregister(): void {
    unregister(this.putStoredBlockHandle);
    unregister(this.preflightGetHandle);
    unregister(this.getStoredBlockHandle);
    unregister(this.getExistingContentHandle);
    unregister(this.pruneBlocksHandle);
    unregister(this.getStatsHandle);
    unregister(this.flushHandle);
    super.unregister();
  }

  public get(): any {
    return this.nodeStoreApi;
  }
}
