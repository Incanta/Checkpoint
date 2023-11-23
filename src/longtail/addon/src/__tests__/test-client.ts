import fs from "fs";
import path from "path";
import { ClientInterface } from "../client";
import { StorageApi } from "../types/storage-api";
import { Modification } from "../types/modification";
import { VersionIndexPointer } from "../types/version-index";
import { StoreIndexPointer } from "../types/store-index";
import { Longtail } from "../longtail";

export class TestClient implements ClientInterface {
  private storageApi: StorageApi;

  constructor(private baseDirectory: string) {
    this.storageApi = StorageApi.CreateInMemStorageAPI();
  }

  public getStorageApi(): StorageApi {
    return this.storageApi;
  }

  public async getLocalVersion(): Promise<string | null> {
    return null;
  }

  public async getLocalVersionIndex(
    directory: string,
    modifications: Modification[],
  ): Promise<VersionIndexPointer | null> {
    return null;
  }

  public async getVersionIndex(version: string): Promise<VersionIndexPointer> {
    const longtail = Longtail.get();
    const buffer = fs.readFileSync(
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lvi`,
      ),
    );
    const versionIndexPtr = new VersionIndexPointer();
    longtail.ReadVersionIndexFromBuffer(
      buffer,
      buffer.length,
      versionIndexPtr.ptr(),
    );
    return versionIndexPtr;
  }

  public async getVersionStoreIndex(
    version: string,
  ): Promise<StoreIndexPointer> {
    const longtail = Longtail.get();
    const buffer = fs.readFileSync(
      path.join(
        this.baseDirectory,
        "version-data",
        "version-store-index",
        `${version}.lsi`,
      ),
    );
    const storeIndexPtr = new StoreIndexPointer();
    longtail.ReadStoreIndexFromBuffer(
      buffer,
      buffer.length,
      storeIndexPtr.ptr(),
    );
    return storeIndexPtr;
  }

  public async getStoreIndex(): Promise<StoreIndexPointer> {
    const longtail = Longtail.get();
    const storeDirectory = path.join(this.baseDirectory, "store");

    const storeIndexes = fs
      .readdirSync(storeDirectory)
      .filter((file) => file.endsWith(".lsi"));

    const buffer = fs.readFileSync(path.join(storeDirectory, storeIndexes[0]));
    const storeIndexPtr = new StoreIndexPointer();
    longtail.ReadStoreIndexFromBuffer(
      buffer,
      buffer.length,
      storeIndexPtr.ptr(),
    );
    return storeIndexPtr;
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

  public async writeVersionIndex(
    versionIndex: VersionIndexPointer,
    version: string,
  ): Promise<void> {
    //
  }

  public async writeStoreIndex(
    storeIndex: StoreIndexPointer,
    version: string,
  ): Promise<void> {
    //
  }
}
