import { StoreIndexPointer } from "../types/store-index";
import { VersionIndexPointer } from "../types/version-index";

export interface ClientInterface {
  getStorageApi(): any;

  getVersionIndexFromServer(version: string): Promise<VersionIndexPointer>;
  getLatestStoreIndexFromServer(): Promise<StoreIndexPointer>;
  getBlockFromServer(blockHash: bigint): Promise<Buffer>;

  writeVersionIndexToServer(
    versionIndexPtr: VersionIndexPointer,
    version: string
  ): Promise<void>;
  writePartialStoreIndexToServer(
    storeIndexPtr: StoreIndexPointer
  ): Promise<void>;
  writeBlockToServer(blockHash: bigint, blockData: Buffer): Promise<void>;
}
