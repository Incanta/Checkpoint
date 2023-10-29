import { Longtail } from "./longtail";
import fs from "fs";
import path from "path";
import { NumberPointer, ObjectPointer } from "./pointer";
import { VersionIndexPointer } from "./version-index";
import { LongtailApiAsyncGetExistingContent } from "./longtail-api-async-get-existing-content";
import { LongtailApiBlockStore } from "./longtail-api-block-store";
import { StoreIndexPointer } from "./store-index";
import { LongtailApiProgress } from "./longtail-api-progress";
import { stringify } from "./util";

const baseDirectory = path.join(__dirname, "..", "download");
const versionIndexPath = path.join(
  baseDirectory,
  "version-data",
  "version-index",
  "1.0.0.lvi",
);
const versionStoreIndexPath = path.join(
  baseDirectory,
  "version-data",
  "version-store-index",
  "1.0.0.lsi",
);
const completeStoreIndexPath = path.join(
  baseDirectory,
  "store",
  "store_fdd58e082b966e122278252aaf3c2d40c9165b8acbd8ddf2f23a39ee0a070863.lsi",
);

function getVersionIndexBuffer() {
  return fs.readFileSync(versionIndexPath);
}

function getVersionStoreIndexBuffer() {
  return fs.readFileSync(versionStoreIndexPath);
}

function getCompleteStoreIndexBuffer() {
  return fs.readFileSync(completeStoreIndexPath);
}

// -------------------------------------

(async () => {
  // const numWorkerCount = 1;

  const longtail = Longtail.get();

  // TODO MIKE HERE make a new job api
  const jobs = longtail.CreateBikeshedJobAPI(1, 0);

  // pathFilter

  // resolvedTargetFolderPath (local)

  const fsApi = longtail.CreateFSStorageAPI();

  // cacheTargetIndexPath (local)

  // target scanning (local)

  const hashRegistry = longtail.CreateFullHashRegistry();

  const remoteBuffer = getVersionIndexBuffer();
  const remoteVersionIndexPtr = new VersionIndexPointer();
  longtail.ReadVersionIndexFromBuffer(
    remoteBuffer,
    remoteBuffer.length,
    remoteVersionIndexPtr.ptr(),
  );

  const remoteVersionIndex = remoteVersionIndexPtr.get();
  // console.log(remoteVersionIndex);

  const hashApiPointer = new ObjectPointer();
  const getHashApiError = longtail.HashRegistry_GetHashAPI(
    hashRegistry,
    remoteVersionIndex.hashIdentifier,
    hashApiPointer.ptr(),
  );

  const localVersionIndexPointer = new VersionIndexPointer();
  const localVersionIndexExists = false; // todo
  if (localVersionIndexExists) {
    const localBuffer = getVersionIndexBuffer();
    longtail.ReadVersionIndexFromBuffer(
      localBuffer,
      localBuffer.length,
      localVersionIndexPointer.ptr(),
    );
  } else {
    const err = longtail.CreateVersionIndex(
      fsApi,
      hashApiPointer.deref(),
      null,
      jobs,
      null,
      null,
      null,
      "",
      null,
      null,
      remoteVersionIndex.targetChunkSize,
      0,
      localVersionIndexPointer.ptr(),
    );
  }
  const localVersionIndex = localVersionIndexPointer.get();

  const compressionRegistry = longtail.CreateFullCompressionRegistry();

  const localFsApi = longtail.CreateFSStorageAPI(); // how is this different than fsApi?

  const blockStoreApi = new LongtailApiBlockStore();
  const nodeStoreApi = blockStoreApi.get();

  // create remoteIndexStore remotestore.CreateBlockStoreForURI
  const compressionStoreApi = longtail.CreateCompressBlockStoreAPI(
    nodeStoreApi,
    compressionRegistry,
  );

  // TODO: Caching
  // localIndexStore
  // cacheBlockStore
  // compressBlockStore

  const lruBlockStoreApi = longtail.CreateLRUBlockStoreAPI(
    compressionStoreApi,
    32,
  );
  const indexStoreApi = longtail.CreateShareBlockStoreAPI(lruBlockStoreApi);

  const versionDiffPointer = new ObjectPointer();
  const versionDiffError = longtail.CreateVersionDiff(
    hashApiPointer.deref(),
    localVersionIndexPointer.deref(),
    remoteVersionIndexPtr.deref(),
    versionDiffPointer.ptr(),
  );

  const maxChunkCount = remoteVersionIndex.chunkCount;
  const outChunkHashes = new Array<bigint>(maxChunkCount);
  const outChunkCount = new NumberPointer();
  const requiredChunkHashesError = longtail.GetRequiredChunkHashes(
    remoteVersionIndexPtr.deref(),
    versionDiffPointer.deref(),
    outChunkCount.ptr(),
    outChunkHashes,
  );

  // const getExistingContentAsyncApi = new LongtailApiAsyncGetExistingContent();

  // longtail.BlockStore_GetExistingContent(
  //   indexStoreApi,
  //   outChunkCount.deref(),
  //   outChunkHashes,
  //   0,
  //   getExistingContentAsyncApi.get(),
  // );

  const storeIndexBuffer = getVersionStoreIndexBuffer();
  const remoteStoreIndexPtr = new StoreIndexPointer();
  longtail.ReadStoreIndexFromBuffer(
    storeIndexBuffer,
    storeIndexBuffer.length,
    remoteStoreIndexPtr.ptr(),
  );

  const progressApi = new LongtailApiProgress();

  console.log("calling change version");

  longtail.ChangeVersion.async(
    indexStoreApi,
    fsApi,
    hashApiPointer.deref(),
    jobs,
    progressApi.get(),
    null,
    null,
    remoteStoreIndexPtr.deref(),
    localVersionIndexPointer.deref(),
    remoteVersionIndexPtr.deref(),
    versionDiffPointer.deref(),
    "path/to/download", // todo?
    1,
    (err: any, result: any) => {
      console.log("change version finished");
      console.log(err);
      console.log(result);
    },
  );
})();
