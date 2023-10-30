import { StorageApi } from "./types/storage-api";

export interface ClientInterface {
  getStorageApi(): StorageApi;
  getLocalVersionIndex(): Promise<Buffer | null>;
  getVersionIndex(version: string): Promise<Buffer>;
  getVersionStoreIndex(version: string): Promise<Buffer>;
  getStoreIndex(): Promise<Buffer>;
  getBlock(blockHash: bigint): Promise<Buffer>;
}
