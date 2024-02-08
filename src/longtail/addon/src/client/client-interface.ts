import { Modification } from "../types/modification";
import { StorageApi } from "../types/storage-api";
import { StoreIndexPointer } from "../types/store-index";
import { VersionIndexPointer } from "../types/version-index";

export interface ClientInterface {
  getStorageApi(): StorageApi;

  getLocalVersion(): Promise<string | null>;
  getLocalVersionIndex(
    directory: string,
    modifications: Modification[],
  ): Promise<VersionIndexPointer | null>;

  getVersionIndexFromServer(version: string): Promise<VersionIndexPointer>;
  getVersionStoreIndexFromServer(version: string): Promise<StoreIndexPointer>;
  getLatestStoreIndexFromServer(): Promise<StoreIndexPointer>;
  getBlockFromServer(blockHash: bigint): Promise<Buffer>;

  writeVersionIndex(
    versionIndex: VersionIndexPointer,
    version: string,
  ): Promise<void>;

  writeStoreIndex(
    storeIndex: StoreIndexPointer,
    version: string,
  ): Promise<void>;
}
