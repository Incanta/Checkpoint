import fs from "fs";
import path from "path";
import { ClientInterface } from "../client";
import { StorageApi } from "../types/storage-api";
import { Modification } from "../types/modification";
import { VersionIndexPointer } from "../types/version-index";
import { StoreIndexPointer } from "../types/store-index";
import { Longtail } from "../longtail";

export class TestClientFull implements ClientInterface {
  private baseDirectory: string;
  private storageApi: StorageApi;

  constructor(baseDirectory: string) {
    this.baseDirectory = baseDirectory;
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
    const versionIndex = new VersionIndexPointer();

    longtail.ReadVersionIndex(
      this.storageApi.get(),
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lvi`,
      ),
      versionIndex.ptr(),
    );

    return versionIndex;
  }

  public async getVersionStoreIndex(
    version: string,
  ): Promise<StoreIndexPointer> {
    const longtail = Longtail.get();
    const storeIndex = new StoreIndexPointer();

    longtail.ReadStoreIndex(
      this.storageApi.get(),
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lsi`,
      ),
      storeIndex.ptr(),
    );

    return storeIndex;
  }

  public async getStoreIndex(): Promise<StoreIndexPointer> {
    const longtail = Longtail.get();
    const storeIndex = new StoreIndexPointer();

    longtail.ReadStoreIndex(
      this.storageApi.get(),
      path.join(this.baseDirectory, `store.lsi`),
      storeIndex.ptr(),
    );

    return storeIndex;
  }

  public async getBlock(blockHash: bigint): Promise<Buffer> {
    const hexString = blockHash.toString(16);
    const blockPath = path.join(
      this.baseDirectory,
      "store",
      "blocks",
      hexString.slice(0, 4),
      `0x${hexString}.lsb`,
    );

    const readFileResult = this.storageApi.OpenReadFile(blockPath);
    if (readFileResult.error) {
      throw new Error(`Could not open file ${blockPath}`);
    }

    const fileSizeResult = this.storageApi.GetSize(readFileResult.file);
    if (fileSizeResult.error) {
      throw new Error(`Could not get file size for ${blockPath}`);
    }

    const readResult = this.storageApi.Read(
      readFileResult.file,
      0,
      fileSizeResult.size,
    );
    if (readResult.error) {
      throw new Error(`Could not read file ${blockPath}`);
    }

    return Buffer.from(readResult.contents);
  }

  public async writeVersionIndex(
    versionIndex: VersionIndexPointer,
    version: string,
  ): Promise<void> {
    const longtail = Longtail.get();
    longtail.WriteVersionIndex(
      this.storageApi.get(),
      versionIndex.deref(),
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lvi`,
      ),
    );
  }

  public async writeStoreIndex(
    storeIndex: StoreIndexPointer,
    version: string,
  ): Promise<void> {
    const longtail = Longtail.get();
    longtail.WriteStoreIndex(
      this.storageApi.get(),
      storeIndex.deref(),
      path.join(
        this.baseDirectory,
        "version-data",
        "version-index",
        `${version}.lsi`,
      ),
    );
    longtail.WriteStoreIndex(
      this.storageApi.get(),
      storeIndex.deref(),
      path.join(this.baseDirectory, `store.lsi`),
    );
  }
}
