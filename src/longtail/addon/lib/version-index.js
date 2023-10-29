"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VersionIndexPointer = void 0;
const koffi_1 = require("koffi");
const pointer_1 = require("./pointer");
const util_1 = require("./util");
class VersionIndexPointer extends pointer_1.ObjectPointer {
    constructor() {
        super();
    }
    get() {
        const result = {
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
        const baseStruct = (0, koffi_1.decode)(this.deref(), "Longtail_VersionIndex");
        result.version = (0, koffi_1.decode)(baseStruct.m_Version, "uint32_t");
        result.hashIdentifier = (0, koffi_1.decode)(baseStruct.m_HashIdentifier, "uint32_t");
        result.targetChunkSize = (0, koffi_1.decode)(baseStruct.m_TargetChunkSize, "uint32_t");
        result.assetCount = (0, koffi_1.decode)(baseStruct.m_AssetCount, "uint32_t");
        result.chunkCount = (0, koffi_1.decode)(baseStruct.m_ChunkCount, "uint32_t");
        result.assetChunkIndexCount = (0, koffi_1.decode)(baseStruct.m_AssetChunkIndexCount, "uint32_t");
        for (let i = 0; i < result.assetCount; i++) {
            result.pathHashes.push((0, util_1.decodeHash)(baseStruct.m_PathHashes, i));
            result.contentHashes.push((0, util_1.decodeHash)(baseStruct.m_ContentHashes, i));
            result.assetSizes.push((0, koffi_1.decode)(baseStruct.m_AssetSizes, i * 8, "uint64_t"));
            result.assetChunkCounts.push((0, koffi_1.decode)(baseStruct.m_AssetChunkCounts, i * 4, "uint32_t"));
            result.assetChunkIndexStarts.push((0, koffi_1.decode)(baseStruct.m_AssetChunkIndexStarts, i * 4, "uint32_t"));
            result.nameOffsets.push((0, koffi_1.decode)(baseStruct.m_NameOffsets, i * 4, "uint32_t"));
            result.permissions.push((0, koffi_1.decode)(baseStruct.m_Permissions, i * 2, "uint16_t"));
        }
        for (let i = 0; i < result.assetChunkIndexCount; i++) {
            result.assetChunkIndexes.push((0, koffi_1.decode)(baseStruct.m_AssetChunkIndexes, i * 4, "uint32_t"));
        }
        for (let i = 0; i < result.chunkCount; i++) {
            result.chunkHashes.push((0, util_1.decodeHash)(baseStruct.m_ChunkHashes, i));
            result.chunkSizes.push((0, koffi_1.decode)(baseStruct.m_ChunkSizes, i * 4, "uint32_t"));
            result.chunkTags.push((0, koffi_1.decode)(baseStruct.m_ChunkTags, i * 4, "uint32_t"));
        }
        result.nameDataSize = baseStruct.m_NameDataSize;
        const namesBinary = (0, koffi_1.decode)(baseStruct.m_NameData, "uint8[]", result.nameDataSize);
        for (let i = 0; i < result.nameOffsets.length; i++) {
            let slice;
            if (i < result.nameOffsets.length - 1) {
                slice = namesBinary.slice(result.nameOffsets[i], result.nameOffsets[i + 1] - 1);
            }
            else {
                slice = namesBinary.slice(result.nameOffsets[i], namesBinary.length - 1);
            }
            result.nameData.push(String.fromCharCode(...slice));
        }
        return result;
    }
}
exports.VersionIndexPointer = VersionIndexPointer;
//# sourceMappingURL=version-index.js.map