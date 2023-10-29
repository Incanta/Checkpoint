"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const longtail_1 = require("./longtail");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const pointer_1 = require("./pointer");
const version_index_1 = require("./version-index");
const longtail_api_block_store_1 = require("./longtail-api-block-store");
const store_index_1 = require("./store-index");
const longtail_api_progress_1 = require("./longtail-api-progress");
const baseDirectory = path_1.default.join(__dirname, "..", "download");
const versionIndexPath = path_1.default.join(baseDirectory, "version-data", "version-index", "1.0.0.lvi");
const versionStoreIndexPath = path_1.default.join(baseDirectory, "version-data", "version-store-index", "1.0.0.lsi");
const completeStoreIndexPath = path_1.default.join(baseDirectory, "store", "store_fdd58e082b966e122278252aaf3c2d40c9165b8acbd8ddf2f23a39ee0a070863.lsi");
function getVersionIndexBuffer() {
    return fs_1.default.readFileSync(versionIndexPath);
}
function getVersionStoreIndexBuffer() {
    return fs_1.default.readFileSync(versionStoreIndexPath);
}
function getCompleteStoreIndexBuffer() {
    return fs_1.default.readFileSync(completeStoreIndexPath);
}
// -------------------------------------
(async () => {
    // const numWorkerCount = 1;
    const longtail = longtail_1.Longtail.get();
    const jobs = longtail.CreateBikeshedJobAPI(1, 0);
    // pathFilter
    // resolvedTargetFolderPath (local)
    const fsApi = longtail.CreateFSStorageAPI();
    // cacheTargetIndexPath (local)
    // target scanning (local)
    const hashRegistry = longtail.CreateFullHashRegistry();
    const remoteBuffer = getVersionIndexBuffer();
    const remoteVersionIndexPtr = new version_index_1.VersionIndexPointer();
    longtail.ReadVersionIndexFromBuffer(remoteBuffer, remoteBuffer.length, remoteVersionIndexPtr.ptr());
    const remoteVersionIndex = remoteVersionIndexPtr.get();
    // console.log(remoteVersionIndex);
    const hashApiPointer = new pointer_1.ObjectPointer();
    const getHashApiError = longtail.HashRegistry_GetHashAPI(hashRegistry, remoteVersionIndex.hashIdentifier, hashApiPointer.ptr());
    const localVersionIndexPointer = new version_index_1.VersionIndexPointer();
    const localVersionIndexExists = false; // todo
    if (localVersionIndexExists) {
        const localBuffer = getVersionIndexBuffer();
        longtail.ReadVersionIndexFromBuffer(localBuffer, localBuffer.length, localVersionIndexPointer.ptr());
    }
    else {
        const err = longtail.CreateVersionIndex(fsApi, hashApiPointer.deref(), null, jobs, null, null, null, "", null, null, remoteVersionIndex.targetChunkSize, 0, localVersionIndexPointer.ptr());
    }
    const localVersionIndex = localVersionIndexPointer.get();
    const compressionRegistry = longtail.CreateFullCompressionRegistry();
    const localFsApi = longtail.CreateFSStorageAPI(); // how is this different than fsApi?
    const blockStoreApi = new longtail_api_block_store_1.LongtailApiBlockStore();
    const nodeStoreApi = blockStoreApi.get();
    // create remoteIndexStore remotestore.CreateBlockStoreForURI
    const compressionStoreApi = longtail.CreateCompressBlockStoreAPI(nodeStoreApi, compressionRegistry);
    // TODO: Caching
    // localIndexStore
    // cacheBlockStore
    // compressBlockStore
    const lruBlockStoreApi = longtail.CreateLRUBlockStoreAPI(compressionStoreApi, 32);
    const indexStoreApi = longtail.CreateShareBlockStoreAPI(lruBlockStoreApi);
    const versionDiffPointer = new pointer_1.ObjectPointer();
    const versionDiffError = longtail.CreateVersionDiff(hashApiPointer.deref(), localVersionIndexPointer.deref(), remoteVersionIndexPtr.deref(), versionDiffPointer.ptr());
    const maxChunkCount = remoteVersionIndex.chunkCount;
    const outChunkHashes = new Array(maxChunkCount);
    const outChunkCount = new pointer_1.NumberPointer();
    const requiredChunkHashesError = longtail.GetRequiredChunkHashes(remoteVersionIndexPtr.deref(), versionDiffPointer.deref(), outChunkCount.ptr(), outChunkHashes);
    // const getExistingContentAsyncApi = new LongtailApiAsyncGetExistingContent();
    // longtail.BlockStore_GetExistingContent(
    //   indexStoreApi,
    //   outChunkCount.deref(),
    //   outChunkHashes,
    //   0,
    //   getExistingContentAsyncApi.get(),
    // );
    const storeIndexBuffer = getVersionStoreIndexBuffer();
    const remoteStoreIndexPtr = new store_index_1.StoreIndexPointer();
    longtail.ReadStoreIndexFromBuffer(storeIndexBuffer, storeIndexBuffer.length, remoteStoreIndexPtr.ptr());
    const progressApi = new longtail_api_progress_1.LongtailApiProgress();
    console.log("calling change version");
    longtail.ChangeVersion.async(indexStoreApi, fsApi, hashApiPointer.deref(), jobs, progressApi.get(), null, null, remoteStoreIndexPtr.deref(), localVersionIndexPointer.deref(), remoteVersionIndexPtr.deref(), versionDiffPointer.deref(), "path/to/download", // todo?
    1);
    console.log("called change version");
    // await progressApi.wait();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log("done");
})();
//# sourceMappingURL=downsync.js.map