"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.StoredBlockPointer = void 0;
const koffi_1 = require("koffi");
const pointer_1 = require("./pointer");
const util_1 = require("./util");
class StoredBlockPointer extends pointer_1.ObjectPointer {
    constructor() {
        super();
    }
    get() {
        const result = {
            blockIndex: {
                blockHash: BigInt(0),
                hashIdentifier: 0,
                chunkCount: 0,
                tag: 0,
                chunkHashes: [],
                chunkSizes: [],
            },
            blockData: new Uint8Array(),
            blockChunksDataSize: 0,
        };
        if (!this.valid()) {
            return result;
        }
        const baseStruct = (0, koffi_1.decode)(this.deref(), "Longtail_StoredBlock");
        const blockIndexStruct = (0, koffi_1.decode)(baseStruct.m_BlockIndex, "Longtail_BlockIndex");
        result.blockIndex.blockHash = (0, util_1.decodeHash)(blockIndexStruct.m_BlockHash);
        result.blockIndex.hashIdentifier = (0, koffi_1.decode)(blockIndexStruct.m_HashIdentifier, "uint32_t");
        result.blockIndex.chunkCount = (0, koffi_1.decode)(blockIndexStruct.m_ChunkCount, "uint32_t");
        result.blockIndex.tag = (0, koffi_1.decode)(blockIndexStruct.m_Tag, "uint32_t");
        result.blockIndex.chunkHashes = (0, util_1.decodeHashes)(blockIndexStruct.m_ChunkHashes, result.blockIndex.chunkCount);
        for (let i = 0; i < result.blockIndex.chunkCount; i++) {
            result.blockIndex.chunkSizes.push((0, koffi_1.decode)(blockIndexStruct.m_ChunkSizes, i * 4, "uint32_t"));
        }
        result.blockChunksDataSize = baseStruct.m_BlockChunksDataSize;
        result.blockData = (0, koffi_1.decode)(baseStruct.m_BlockData, "uint8", result.blockChunksDataSize);
        return result;
    }
}
exports.StoredBlockPointer = StoredBlockPointer;
//# sourceMappingURL=stored-block.js.map