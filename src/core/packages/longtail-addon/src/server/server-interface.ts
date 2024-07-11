import { StorageApi } from "../types/storage-api";
import { StoreIndexPointer } from "../types/store-index";
import { VersionIndexPointer } from "../types/version-index";

export interface ServerInterface {
  init(): Promise<void>;

  // API
  requestUpload(repoId: string): Promise<string>;
  commitUpload(repoId: string, uploadId: string): Promise<void>;

  // Internal
  getStorageApi(): StorageApi;
  getVersionIndex(version: string): Promise<VersionIndexPointer>;
  getVersionStoreIndex(version: string): Promise<StoreIndexPointer>;
  getStoreIndex(): Promise<StoreIndexPointer>;
  getBlock(blockHash: bigint): Promise<Buffer>;
  writeVersionIndex(
    versionIndex: VersionIndexPointer,
    version: string
  ): Promise<void>;
  writeStoreIndex(
    storeIndex: StoreIndexPointer,
    version: string
  ): Promise<void>;
}
