import {
  IKoffiRegisteredCallback,
  decode,
  register,
  sizeof,
  unregister,
} from "koffi";
import { LongtailApi } from "./longtail-api";
import { Longtail } from "./longtail";
import { decodeHash, decodeHashes } from "./util";
import { Sema } from "async-sema";
import { StoredBlockPointer } from "./stored-block";
import fs from "fs";
import path from "path";

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

  private blockLocks: Map<bigint, Sema> = new Map<bigint, Sema>();
  private blocks: Map<bigint, any> = new Map<bigint, any>();

  private longtail: Longtail;

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

    this.longtail = Longtail.get();
    this.storeApi = this.longtail.Alloc(
      "NodeJSStoreAPI",
      sizeof("Longtail_BlockStoreAPI"),
    );

    this.nodeStoreApi = this.longtail.MakeBlockStoreAPI(
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
    inBlockStoreApi: any,
    blockCount: number,
    inBlockHashes: any,
    inAsyncComplete: any,
  ): number {
    const blockHashes = decodeHashes(inBlockHashes, blockCount);

    const promises = blockHashes.map((blockHash) => {
      return this.getStoredBlockAsync(blockHash);
    });

    Promise.all(promises).then((results) => {
      // call inAsyncComplete i guess?
    });

    return 0;
  }

  public getStoredBlock(
    inBlockStoreApi: any,
    blockHash: bigint,
    inAsyncComplete: any,
  ): number {
    console.log("GetStoredBlock func");

    const callbackApi = decode(
      inAsyncComplete,
      "Longtail_AsyncGetStoredBlockAPI",
    );

    this.getStoredBlockAsync(blockHash)
      .then((block) => {
        callbackApi.OnComplete(inAsyncComplete, block, 0);
      })
      .catch((err) => {
        console.error(`Error getting block ${blockHash.toString()}: ${err}`);
        callbackApi.OnComplete(inAsyncComplete, null, 1);
      });

    return 0;
  }

  private async getStoredBlockAsync(blockHash: bigint): Promise<any> {
    const lock = this.getOrCreateBlockLock(blockHash);
    await lock.acquire();

    let block = this.blocks.get(blockHash);

    if (typeof block === "undefined") {
      // TODO
      const baseDirectory = path.join(__dirname, "..", "download");
      const buffer = fs.readFileSync(
        path.join(
          baseDirectory,
          "store",
          "chunks",
          "701a",
          "0x701a4cbd8245bc55.lsb",
        ),
      );

      const blockPtr = new StoredBlockPointer();
      this.longtail.ReadStoredBlockFromBuffer(
        buffer,
        buffer.length,
        blockPtr.ptr(),
      );

      block = blockPtr.deref();
      this.blocks.set(blockHash, block);
    }

    lock.release();

    return block;
  }

  private getOrCreateBlockLock(blockHash: bigint): Sema {
    let lock = this.blockLocks.get(blockHash);
    if (lock === undefined) {
      lock = new Sema(2);
      this.blockLocks.set(blockHash, lock);
    }
    return lock;
  }

  public getExistingContent(
    blockStoreApi: any,
    chunkCount: number,
    chunkHashes: bigint[],
    minBlockUsagePercent: number,
    asyncComplete: any,
  ): number {
    console.log(`GetExistingContent func`);
    console.log(decode(chunkHashes, "uint64", 2));
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
