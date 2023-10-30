import fs from "fs";
import path from "path";
import { ClientInterface } from "../client";
import { StorageApi } from "../types/storage-api";

export class TestClient implements ClientInterface {
  private storageApi: StorageApi;

  constructor(private baseDirectory: string) {
    this.storageApi = StorageApi.CreateInMemStorageAPI();
  }

  public getStorageApi(): StorageApi {
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
