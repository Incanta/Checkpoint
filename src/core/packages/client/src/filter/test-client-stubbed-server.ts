import {
  BufferPointer,
  LongtailLib,
  NumberPointer,
  ObjectPointer,
  StoreIndexPointer,
  VersionIndexPointer,
  type ClientInterface,
} from "@checkpointvcs/longtail-addon";
import { ptr } from "bun:ffi";
import { dir, type DirectoryResult } from "tmp-promise";
import { promises as fs } from "fs";
import path from "path";

export class TestClientStubbedServer implements ClientInterface {
  private storageApi: any;
  private serverDir: Promise<DirectoryResult>;

  public constructor() {
    this.storageApi = null;
    this.serverDir = dir({
      unsafeCleanup: true,
    });
  }

  public getStorageApi(): any {
    return this.storageApi;
  }

  public async getVersionIndexFromServer(
    version: string
  ): Promise<VersionIndexPointer> {
    const longtail = LongtailLib();
    const buffer = await fs.readFile(
      path.join(
        (
          await this.serverDir
        ).path,
        "version-data",
        "version-index",
        `${version}.lvi`
      )
    );
    const versionIndexPtr = new VersionIndexPointer();
    longtail.Longtail_ReadVersionIndexFromBuffer(
      buffer,
      buffer.length,
      versionIndexPtr.asOutput()
    );

    return versionIndexPtr;
  }

  public async getLatestStoreIndexFromServer(): Promise<StoreIndexPointer> {
    const longtail = LongtailLib();
    const storeDirectory = path.join((await this.serverDir).path, "store");

    const storeIndexes = (await fs.readdir(storeDirectory))
      .filter((file) => file.endsWith(".lsi"))
      .sort((a, b) => {
        const aNum = parseInt(path.basename(a), 10);
        const bNum = parseInt(path.basename(b), 10);
        return aNum - bNum;
      });

    if (storeIndexes.length === 0) {
      throw new Error("No store indexes when trying to get the latest one");
    }

    const buffer = await fs.readFile(
      path.join(storeDirectory, storeIndexes.at(-1)!)
    );
    const storeIndexPtr = new StoreIndexPointer();
    longtail.Longtail_ReadStoreIndexFromBuffer(
      buffer,
      buffer.length,
      storeIndexPtr.asOutput()
    );

    return storeIndexPtr;
  }

  public async getBlockFromServer(blockHash: bigint): Promise<Buffer> {
    const hexString = blockHash.toString(16);

    const buffer = await fs.readFile(
      path.join(
        (
          await this.serverDir
        ).path,
        "store",
        "chunks",
        hexString.slice(0, 4),
        `0x${hexString}.lsb`
      )
    );

    return buffer;
  }

  public async writeVersionIndexToServer(
    versionIndexPtr: VersionIndexPointer,
    version: string
  ): Promise<void> {
    const longtail = LongtailLib();

    const bufferDataPtr = new Uint8Array(2048); // TODO size tbd
    const bufferSizePtr = new BigUint64Array(1);
    longtail.Longtail_WriteVersionIndexToBuffer(
      versionIndexPtr.asInput(),
      ptr(bufferDataPtr),
      ptr(bufferSizePtr)
    );

    await fs.writeFile(
      path.join(
        (
          await this.serverDir
        ).path,
        "version-data",
        "version-index",
        `${version}.lvi`
      ),
      bufferDataPtr.slice(0, bufferSizePtr[0])
    );
  }

  public async writePartialStoreIndexToServer(
    storeIndexPtr: StoreIndexPointer
  ): Promise<void> {
    const longtail = LongtailLib();

    const latestStoreIndexPtr = await this.getLatestStoreIndexFromServer();

    const mergedStoreIndexPtr = new StoreIndexPointer();
    longtail.MergeStoreIndex(
      storeIndexPtr.deref(),
      latestStoreIndexPtr.deref(),
      mergedStoreIndexPtr.ptr()
    );

    const bufferDataPtr = new BufferPointer(2048); // TODO size tbd
    const bufferSizePtr = new NumberPointer();
    longtail.WriteStoreIndexToBuffer(
      mergedStoreIndexPtr.deref(),
      bufferDataPtr.ptr(),
      bufferSizePtr.ptr()
    );

    const storeDirectory = path.join((await this.serverDir).path, "store");

    const storeIndexes = (await fs.readdir(storeDirectory))
      .filter((file) => file.endsWith(".lsi"))
      .sort((a, b) => {
        const aNum = parseInt(path.basename(a), 10);
        const bNum = parseInt(path.basename(b), 10);
        return aNum - bNum;
      });

    const lastNum = parseInt(path.basename(storeIndexes.at(-1)!), 10);

    await fs.writeFile(
      path.join((await this.serverDir).path, "store", `${lastNum + 1}.lsi`),
      bufferDataPtr.deref().slice(0, bufferSizePtr.deref())
    );
  }

  public async writeBlockToServer(
    blockHash: bigint,
    blockData: Buffer
  ): Promise<void> {
    const hexString = blockHash.toString(16);

    await fs.writeFile(
      path.join(
        (
          await this.serverDir
        ).path,
        "store",
        "chunks",
        hexString.slice(0, 4),
        `0x${hexString}.lsb`
      ),
      blockData
    );
  }
}
