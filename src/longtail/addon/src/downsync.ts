import fs from "fs";
import path from "path";
import { promisify } from "util";
import { Longtail } from "./longtail";
import { LongtailApiBlockStore } from "./apis/longtail-api-block-store";
import { LongtailApiProgress } from "./apis/longtail-api-progress";
import { StoreIndexPointer } from "./types/store-index";
import { NumberPointer, ObjectPointer } from "./types/pointer";
import { VersionIndexPointer } from "./types/version-index";
import { ClientInterface } from "./client";

export async function downsync(client: ClientInterface, version: string) {
  // const numWorkerCount = 1;

  const longtail = Longtail.get();

  const jobs = longtail.CreateBikeshedJobAPI(1, 0);

  // pathFilter

  // resolvedTargetFolderPath (local)

  // cacheTargetIndexPath (local)

  // target scanning (local)

  const hashRegistry = longtail.CreateFullHashRegistry();

  const remoteBuffer = await client.getVersionIndex(version);
  const remoteVersionIndexPtr = new VersionIndexPointer();
  longtail.ReadVersionIndexFromBuffer(
    remoteBuffer,
    remoteBuffer.length,
    remoteVersionIndexPtr.ptr(),
  );

  const remoteVersionIndex = remoteVersionIndexPtr.get();

  const hashApiPointer = new ObjectPointer();
  const getHashApiError = longtail.HashRegistry_GetHashAPI(
    hashRegistry,
    remoteVersionIndex.hashIdentifier,
    hashApiPointer.ptr(),
  );

  const localVersionIndexPointer = new VersionIndexPointer();
  const localBuffer = await client.getLocalVersionIndex();
  if (localBuffer !== null) {
    longtail.ReadVersionIndexFromBuffer(
      localBuffer,
      localBuffer.length,
      localVersionIndexPointer.ptr(),
    );
  } else {
    const err = longtail.CreateVersionIndex(
      client.getStorageApi(),
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

  const blockStoreApi = new LongtailApiBlockStore(client);
  const nodeStoreApi = blockStoreApi.get();

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

  const storeIndexBuffer = await client.getVersionStoreIndex(version);
  const remoteStoreIndexPtr = new StoreIndexPointer();
  longtail.ReadStoreIndexFromBuffer(
    storeIndexBuffer,
    storeIndexBuffer.length,
    remoteStoreIndexPtr.ptr(),
  );

  const progressApi = new LongtailApiProgress();

  const ChangeVersion = promisify(longtail.ChangeVersion.async);
  await ChangeVersion(
    indexStoreApi,
    client.getStorageApi(),
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
  );
}

/**
 * --------------------------------------
 */

class TestClient implements ClientInterface {
  private storageApi: any;

  constructor(private baseDirectory: string) {
    const longtail = Longtail.get();
    this.storageApi = longtail.CreateFSStorageAPI();
  }

  public getStorageApi(): any {
    return this.storageApi;
  }

  public async getLocalVersionIndex(): Promise<Buffer | null> {
    return null;
  }

  public async getVersionIndex(version: string): Promise<Buffer> {
    return fs.readFileSync(
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lvi`,
      ),
    );
  }

  public async getVersionStoreIndex(version: string): Promise<Buffer> {
    return fs.readFileSync(
      path.join(
        this.baseDirectory,
        "version-data",
        "version-store-index",
        `${version}.lsi`,
      ),
    );
  }

  public async getStoreIndex(): Promise<Buffer> {
    const storeDirectory = path.join(this.baseDirectory, "store");

    const storeIndexes = fs
      .readdirSync(storeDirectory)
      .filter((file) => file.endsWith(".lsi"));

    return fs.readFileSync(path.join(storeDirectory, storeIndexes[0]));
  }

  public async getBlock(blockHash: bigint): Promise<Buffer> {
    const hexString = blockHash.toString(16);

    const buffer = fs.readFileSync(
      path.join(
        this.baseDirectory,
        "store",
        "chunks",
        hexString.slice(0, 4),
        `0x${hexString}.lsb`,
      ),
    );
    return buffer;
  }
}

(async () => {
  const client = new TestClient(path.join(__dirname, "..", "download"));
  await downsync(client, "1.0.0");
})();
