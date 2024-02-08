import { Modification } from "../types/modification";
import { StorageApi } from "../types/storage-api";
import { StoreIndexPointer } from "../types/store-index";
import { VersionIndexPointer } from "../types/version-index";

export interface ServerInterface {
  getStorageApi(): StorageApi;
  getLocalVersion(): Promise<string | null>;
  getLocalVersionIndex(
    directory: string,
    modifications: Modification[],
  ): Promise<VersionIndexPointer | null>;
  getVersionIndex(version: string): Promise<VersionIndexPointer>;
  getVersionStoreIndex(version: string): Promise<StoreIndexPointer>;
  getStoreIndex(): Promise<StoreIndexPointer>;
  getBlock(blockHash: bigint): Promise<Buffer>;

  writeVersionIndex(
    versionIndex: VersionIndexPointer,
    version: string,
  ): Promise<void>;

  writeStoreIndex(
    storeIndex: StoreIndexPointer,
    version: string,
  ): Promise<void>;
}
