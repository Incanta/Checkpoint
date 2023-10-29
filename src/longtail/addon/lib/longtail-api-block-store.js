"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LongtailApiBlockStore = void 0;
const koffi_1 = require("koffi");
const longtail_api_1 = require("./longtail-api");
const longtail_1 = require("./longtail");
const util_1 = require("./util");
const async_sema_1 = require("async-sema");
const stored_block_1 = require("./stored-block");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
class LongtailApiBlockStore extends longtail_api_1.LongtailApi {
    putStoredBlockHandle;
    preflightGetHandle;
    getStoredBlockHandle;
    getExistingContentHandle;
    pruneBlocksHandle;
    getStatsHandle;
    flushHandle;
    storeApi;
    nodeStoreApi;
    blockLocks = new Map();
    blocks = new Map();
    longtail;
    constructor() {
        super();
        this.putStoredBlockHandle = (0, koffi_1.register)(this, this.putStoredBlock, "Longtail_BlockStore_PutStoredBlockFunc*");
        this.preflightGetHandle = (0, koffi_1.register)(this, this.preflightGet, "Longtail_BlockStore_PreflightGetFunc*");
        this.getStoredBlockHandle = (0, koffi_1.register)(this, this.getStoredBlock, "Longtail_BlockStore_GetStoredBlockFunc*");
        this.getExistingContentHandle = (0, koffi_1.register)(this, this.getExistingContent, "Longtail_BlockStore_GetExistingContentFunc*");
        this.pruneBlocksHandle = (0, koffi_1.register)(this, this.pruneBlocks, "Longtail_BlockStore_PruneBlocksFunc*");
        this.getStatsHandle = (0, koffi_1.register)(this, this.getStats, "Longtail_BlockStore_GetStatsFunc*");
        this.flushHandle = (0, koffi_1.register)(this, this.flush, "Longtail_BlockStore_FlushFunc*");
        this.longtail = longtail_1.Longtail.get();
        this.storeApi = this.longtail.Alloc("NodeJSStoreAPI", (0, koffi_1.sizeof)("Longtail_BlockStoreAPI"));
        this.nodeStoreApi = this.longtail.MakeBlockStoreAPI(this.storeApi, super.disposeHandle, this.putStoredBlockHandle, this.preflightGetHandle, this.getStoredBlockHandle, this.getExistingContentHandle, this.pruneBlocksHandle, this.getStatsHandle, this.flushHandle);
    }
    putStoredBlock(blockStoreApi, storedBlock, asyncComplete) {
        console.log("PutStoredBlock func");
        return 0;
    }
    preflightGet(inBlockStoreApi, blockCount, inBlockHashes, inAsyncComplete) {
        const blockHashes = (0, util_1.decodeHashes)(inBlockHashes, blockCount);
        const promises = blockHashes.map((blockHash) => {
            return this.getStoredBlockAsync(blockHash);
        });
        Promise.all(promises).then((results) => {
            // call inAsyncComplete i guess?
        });
        return 0;
    }
    getStoredBlock(inBlockStoreApi, inBlockHash, inAsyncComplete) {
        console.log("GetStoredBlock func");
        const callbackApi = (0, koffi_1.decode)(inAsyncComplete, "Longtail_AsyncGetStoredBlockAPI");
        const blockHash = (0, util_1.decodeHash)(inBlockHash);
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
    async getStoredBlockAsync(blockHash) {
        const lock = this.getOrCreateBlockLock(blockHash);
        const token = lock.acquire();
        const result = await new Promise((resolve) => {
            setTimeout(() => {
                resolve("hi");
            }, 100);
        });
        console.log(result);
        token.then(() => {
            console.log("token fulfilled");
        });
        console.log("pre await");
        await token;
        console.log("post await");
        let block = this.blocks.get(blockHash);
        if (typeof block === "undefined") {
            // TODO
            const baseDirectory = path_1.default.join(__dirname, "..", "download");
            const buffer = fs_1.default.readFileSync(path_1.default.join(baseDirectory, "store", "chunks", "701a", "0x701a4cbd8245bc55.lsb"));
            const blockPtr = new stored_block_1.StoredBlockPointer();
            this.longtail.ReadStoredBlockFromBuffer(buffer, buffer.length, blockPtr.ptr());
            block = blockPtr.deref();
            this.blocks.set(blockHash, block);
        }
        // lock.release();
        return block;
    }
    getOrCreateBlockLock(blockHash) {
        let lock = this.blockLocks.get(blockHash);
        if (lock === undefined) {
            lock = new async_sema_1.Sema(2);
            this.blockLocks.set(blockHash, lock);
        }
        return lock;
    }
    getExistingContent(blockStoreApi, chunkCount, chunkHashes, minBlockUsagePercent, asyncComplete) {
        console.log(`GetExistingContent func`);
        console.log((0, koffi_1.decode)(chunkHashes, "uint64", 2));
        return 0;
    }
    pruneBlocks(blockStoreApi, blockKeepCount, blockKeepHashes, asyncComplete) {
        console.log("PruneBlocks func");
        return 0;
    }
    getStats(blockStoreApi, outStats) {
        console.log("GetStats func");
        return 0;
    }
    flush(blockStoreApi, blockKeepCount, blockKeepHashes, asyncComplete) {
        console.log("Flush func");
        return 0;
    }
    unregister() {
        (0, koffi_1.unregister)(this.putStoredBlockHandle);
        (0, koffi_1.unregister)(this.preflightGetHandle);
        (0, koffi_1.unregister)(this.getStoredBlockHandle);
        (0, koffi_1.unregister)(this.getExistingContentHandle);
        (0, koffi_1.unregister)(this.pruneBlocksHandle);
        (0, koffi_1.unregister)(this.getStatsHandle);
        (0, koffi_1.unregister)(this.flushHandle);
        super.unregister();
    }
    get() {
        return this.nodeStoreApi;
    }
}
exports.LongtailApiBlockStore = LongtailApiBlockStore;
//# sourceMappingURL=longtail-api-block-store.js.map