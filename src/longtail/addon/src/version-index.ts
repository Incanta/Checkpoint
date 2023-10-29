import { decode } from "koffi";
import { ObjectPointer } from "./pointer";
import { decodeHash } from "./util";

export interface VersionIndex {
  version: number;
  hashIdentifier: number;
  targetChunkSize: number;
  assetCount: number;
  chunkCount: number;
  assetChunkIndexCount: number;
  pathHashes: bigint[];
  contentHashes: bigint[];
  assetSizes: bigint[];
  assetChunkCounts: number[];
  assetChunkIndexStarts: number[];
  assetChunkIndexes: number[];
  chunkHashes: bigint[];
  chunkSizes: number[];
  chunkTags: number[];
  nameOffsets: number[];
  nameDataSize: number;
  permissions: number[];
  nameData: string[];
}

export class VersionIndexPointer extends ObjectPointer {
  constructor() {
    super();
  }

  public get(): VersionIndex {
    const result: VersionIndex = {
      version: 0,
      hashIdentifier: 0,
      targetChunkSize: 0,
      assetCount: 0,
      chunkCount: 0,
      assetChunkIndexCount: 0,
      pathHashes: [],
      contentHashes: [],
      assetSizes: [],
      assetChunkCounts: [],
      assetChunkIndexStarts: [],
      assetChunkIndexes: [],
      chunkHashes: [],
      chunkSizes: [],
      chunkTags: [],
      nameOffsets: [],
      nameDataSize: 0,
      permissions: [],
      nameData: [],
    };

    if (!this.valid()) {
      return result;
    }

    const baseStruct = decode(this.deref(), "Longtail_VersionIndex");

    result.version = decode(baseStruct.m_Version, "uint32_t");
    result.hashIdentifier = decode(baseStruct.m_HashIdentifier, "uint32_t");
    result.targetChunkSize = decode(baseStruct.m_TargetChunkSize, "uint32_t");
    result.assetCount = decode(baseStruct.m_AssetCount, "uint32_t");
    result.chunkCount = decode(baseStruct.m_ChunkCount, "uint32_t");
    result.assetChunkIndexCount = decode(
      baseStruct.m_AssetChunkIndexCount,
      "uint32_t",
    );

    for (let i = 0; i < result.assetCount; i++) {
      result.pathHashes.push(decodeHash(baseStruct.m_PathHashes, i));
      result.contentHashes.push(decodeHash(baseStruct.m_ContentHashes, i));
      result.assetSizes.push(
        decode(baseStruct.m_AssetSizes, i * 8, "uint64_t"),
      );
      result.assetChunkCounts.push(
        decode(baseStruct.m_AssetChunkCounts, i * 4, "uint32_t"),
      );
      result.assetChunkIndexStarts.push(
        decode(baseStruct.m_AssetChunkIndexStarts, i * 4, "uint32_t"),
      );
      result.nameOffsets.push(
        decode(baseStruct.m_NameOffsets, i * 4, "uint32_t"),
      );
      result.permissions.push(
        decode(baseStruct.m_Permissions, i * 2, "uint16_t"),
      );
    }

    for (let i = 0; i < result.assetChunkIndexCount; i++) {
      result.assetChunkIndexes.push(
        decode(baseStruct.m_AssetChunkIndexes, i * 4, "uint32_t"),
      );
    }

    for (let i = 0; i < result.chunkCount; i++) {
      result.chunkHashes.push(decodeHash(baseStruct.m_ChunkHashes, i));
      result.chunkSizes.push(
        decode(baseStruct.m_ChunkSizes, i * 4, "uint32_t"),
      );
      result.chunkTags.push(decode(baseStruct.m_ChunkTags, i * 4, "uint32_t"));
    }

    result.nameDataSize = baseStruct.m_NameDataSize;

    const namesBinary: Uint8Array = decode(
      baseStruct.m_NameData,
      "uint8[]",
      result.nameDataSize,
    );

    for (let i = 0; i < result.nameOffsets.length; i++) {
      let slice: Uint8Array;
      if (i < result.nameOffsets.length - 1) {
        slice = namesBinary.slice(
          result.nameOffsets[i],
          result.nameOffsets[i + 1] - 1,
        );
      } else {
        slice = namesBinary.slice(
          result.nameOffsets[i],
          namesBinary.length - 1,
        );
      }
      result.nameData.push(String.fromCharCode(...slice));
    }

    return result;
  }
}
