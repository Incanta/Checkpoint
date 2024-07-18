import {
  BigIntPointer,
  EncodeFileInfos,
  LongtailApiBlockStore,
  LongtailBun,
  LongtailLib,
  ObjectPointer,
  StoreIndexPointer,
  VersionIndexPointer,
  type ClientInterface,
  type FileInfos,
} from "@checkpointvcs/longtail-addon";
import type { CheckpointConfig } from "../config";
import path from "path";
import { promises as fs } from "fs";

// 1. create a version using local store (perhaps get latest remote store
//    as it's possible to have changes that are already pushed [starter content])
// 2. get the blocks and write those to the server
// 3. get the version index and write that to the server
// 4. write the missing store index to the server
// 5. [server] merge the missing store index with the latest store index
//    while locking the store index to synchronize writes

export async function CreateVersion(
  config: CheckpointConfig,
  client: ClientInterface,
  files: string[]
): Promise<void> {
  const numWorkerCount = 1; // TODO do we want to expose this or read the num processors?
  const targetBlockSize = 8388608; // 8MB, default from golongtail
  const maxChunksPerBlock = 1024; // default from golongtail

  const longtail = LongtailLib();

  const jobs = longtail.Longtail_CreateBikeshedJobAPI(numWorkerCount, 0);

  const hashRegistry = longtail.Longtail_CreateFullHashRegistry();

  const blockStoreApi = new LongtailApiBlockStore(client);
  // const nodeStoreApi = blockStoreApi.get();

  // const compressionRegistry = longtail.CreateFullCompressionRegistry();

  // const indexStoreApi = longtail.CreateCompressBlockStoreAPI(
  //   nodeStoreApi,
  //   compressionRegistry
  // );

  // // TODO should this be configurable?
  // const hashIdentifier = longtail.GetBlake3HashType();

  // const hashApi = new ObjectPointer();
  // longtail.HashRegistry_GetHashAPI(
  //   hashRegistry,
  //   hashIdentifier,
  //   hashApi.asOutput()
  // );

  // const fileStatPromises = files.map(async (f) => {
  //   return await fs.stat(path.join(config.repoRoot, f), {
  //     bigint: true,
  //   });
  // });

  // const fileStats = await Promise.all(fileStatPromises);

  // const fileInfos: FileInfos = {
  //   count: files.length,
  //   sizes: fileStats.map((stat) => stat.size),
  //   paths: files.map((f) => path.normalize(f).replaceAll("\\", "/")),
  //   permissions: fileStats.map((stat) => 0o644),
  // };

  // const fileInfosPtr = EncodeFileInfos(fileInfos);

  // const compressionType = longtail.GetZStdDefaultCompressionType();
  // const compressionTypes = files.map((f) => compressionType);

  // const enableFileMapping = false; // this seems to be the default in golongtail

  // const localModifiedVersionIndex = new VersionIndexPointer();
  // longtail.CreateVersionIndex(
  //   client.getStorageApi().get(),
  //   hashApi.deref(),
  //   null, // chunker
  //   jobs,
  //   null, // createVersionIndexProgress
  //   null,
  //   null,
  //   path.normalize(config.repoRoot),
  //   fileInfosPtr.deref(),
  //   compressionTypes,
  //   32768, // TODO make the target chunk size configurable
  //   enableFileMapping,
  //   localModifiedVersionIndex.ptr()
  // );

  // if (localModifiedVersionIndex === null) {
  //   throw new Error(
  //     "No local version index computed; was the workspace initialized?"
  //   );
  // }

  // const storeIndexBufferPtr = await client.getLatestStoreIndexFromServer();

  // const missingContentVersionStoreIndex = new StoreIndexPointer();
  // longtail.CreateMissingContent(
  //   hashApi.deref(),
  //   storeIndexBufferPtr.deref(),
  //   localModifiedVersionIndex.deref(),
  //   targetBlockSize,
  //   maxChunksPerBlock,
  //   missingContentVersionStoreIndex.ptr()
  // );

  // // WriteContent - need to write the content to our own in-memory store
  // // where we can push it to the server
  // longtail.WriteContent(
  //   client.getStorageApi().get(),
  //   null, // TODO
  //   jobs,
  //   null,
  //   null,
  //   null,
  //   missingContentVersionStoreIndex.deref(),
  //   localModifiedVersionIndex.deref(),
  //   config.repoRoot
  // );

  // // FlushStoresSync
  // const storesToFlush = [indexStoreApi, nodeStoreApi];
  // for (const store of storesToFlush) {
  //   // TODO MIKE HERE
  //   // need to create a Flush Completion API and wait for the progress
  //   // to finish I guess. See longtailutils.go
  // }

  // // WriteVersionIndexToBuffer
  // await client.writeVersionIndexToServer(localModifiedVersionIndex, "1");

  // // MergeStoreIndex and push
  // await client.writePartialStoreIndexToServer(missingContentVersionStoreIndex);
}
