import { promisify } from "util";
import { Longtail } from "./longtail";
import { LongtailApiBlockStore } from "./apis/longtail-api-block-store";
import { StoreIndexPointer } from "./types/store-index";
import { BigIntPointer, ObjectPointer } from "./types/pointer";
import { VersionIndexPointer } from "./types/version-index";
import { ClientInterface } from "./client";
import { Modification, Operation } from "./types/modification";

export async function commit(
  client: ClientInterface,
  version: string,
  directory: string,
  modifications: Modification[],
) {
  const numWorkerCount = 1; // TODO do we want to expose this or read the num processors?

  const longtail = Longtail.get();

  const jobs = longtail.CreateBikeshedJobAPI(numWorkerCount, 0);

  const hashRegistry = longtail.CreateFullHashRegistry();

  const blockStoreApi = new LongtailApiBlockStore(client);
  const nodeStoreApi = blockStoreApi.get();

  const compressionRegistry = longtail.CreateFullCompressionRegistry();

  const indexStoreApi = longtail.CreateCompressBlockStoreAPI(
    nodeStoreApi,
    compressionRegistry,
  );

  // this is the string version that the client's "HEAD" points to.
  // changes to their repo are based off this version
  const baseVersion = await client.getLocalVersion();

  if (baseVersion === null) {
    throw new Error("No base version found; was the workspace initialized?");
  }

  // this is the version index of the client's "HEAD" without any changes
  const baseVersionIndexPtr = await client.getVersionIndex(baseVersion);

  // this is the version index of the proposed commit changes
  const localModifiedVersionIndex = await client.getLocalVersionIndex(
    directory,
    modifications,
  );

  if (localModifiedVersionIndex === null) {
    throw new Error(
      "No local version index computed; was the workspace initialized?",
    );
  }

  const hashApi = new ObjectPointer();
  longtail.HashRegistry_GetHashAPI(
    hashRegistry,
    baseVersionIndexPtr.get().hashIdentifier,
    hashApi.ptr(),
  );

  const removedFileHashes: bigint[] = [];
  for (const modification of modifications) {
    if (modification.operation === Operation.Delete) {
      const pointer = new BigIntPointer();
      longtail.GetPathHash(hashApi.deref(), modification.path, pointer.ptr());
      removedFileHashes.push(pointer.deref());
    }
  }

  // I believe this may just be necessary in the server code,
  // but this is the client code (no function for the server code yet).
  // I don't think that the client needs to get the merged version index
  // to create the missing content
  const nextVersionIndexPtr = new VersionIndexPointer();
  longtail.MergeVersionIndex(
    baseVersionIndexPtr.deref(),
    localModifiedVersionIndex.deref(),
    removedFileHashes,
    removedFileHashes.length,
    nextVersionIndexPtr.ptr(),
  );

  // this _should_ be the store index for the remote repo
  const storeIndexBufferPtr = await client.getStoreIndex();

  // CreateMissingContent

  // WriteContent

  // FlushStoresSync

  // WriteVersionIndexToBuffer

  // MergeStoreIndex and push
}
