"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoreIndexPointer = void 0;
const koffi_1 = require("koffi");
const pointer_1 = require("./pointer");
const util_1 = require("./util");
class StoreIndexPointer extends pointer_1.ObjectPointer {
    constructor() {
        super();
    }
    get() {
        const result = {
            version: 0,
            hashIdentifier: 0,
            blockCount: 0,
            chunkCount: 0,
            blockHashes: [],
            chunkHashes: [],
            blockChunkOffsets: [],
            blockChunkCounts: [],
            blockTags: [],
            chunkSizes: [],
            blocks: [],
        };
        if (!this.valid()) {
            return result;
        }
        const baseStruct = (0, koffi_1.decode)(this.deref(), "Longtail_StoreIndex");
        result.version = (0, koffi_1.decode)(baseStruct.m_Version, "uint32_t");
        result.hashIdentifier = (0, koffi_1.decode)(baseStruct.m_HashIdentifier, "uint32_t");
        result.blockCount = (0, koffi_1.decode)(baseStruct.m_BlockCount, "uint32_t");
        result.chunkCount = (0, koffi_1.decode)(baseStruct.m_ChunkCount, "uint32_t");
        for (let i = 0; i < result.blockCount; i++) {
            result.blockHashes.push((0, util_1.decodeHash)(baseStruct.m_BlockHashes, i));
            result.blockChunkOffsets.push((0, koffi_1.decode)(baseStruct.m_BlockChunksOffsets, i * 4, "uint32_t"));
            result.blockChunkCounts.push((0, koffi_1.decode)(baseStruct.m_BlockChunkCounts, i * 4, "uint32_t"));
            result.blockTags.push((0, koffi_1.decode)(baseStruct.m_BlockTags, i * 4, "uint32_t"));
        }
        for (let i = 0; i < result.chunkCount; i++) {
            result.chunkHashes.push((0, util_1.decodeHash)(baseStruct.m_ChunkHashes, i));
            result.chunkSizes.push((0, koffi_1.decode)(baseStruct.m_ChunkSizes, i * 4, "uint32_t"));
        }
        for (let i = 0; i < result.blockCount; i++) {
            const block = {
                hash: result.blockHashes[i],
                chunks: [],
            };
            const offset = result.blockChunkOffsets[i];
            const count = result.blockChunkCounts[i];
            for (let j = offset; j < offset + count; j++) {
                block.chunks.push({
                    hash: result.chunkHashes[j],
                    size: result.chunkSizes[j],
                });
            }
            result.blocks.push(block);
        }
        return result;
    }
}
exports.StoreIndexPointer = StoreIndexPointer;
//# sourceMappingURL=store-index.js.map