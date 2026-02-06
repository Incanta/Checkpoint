#include <lrublockstore/longtail_lrublockstore.h>
#include <shareblockstore/longtail_shareblockstore.h>

#include <unordered_map>

#include "../util/existing-content.h"
#include "main.h"

// Structure to hold the result of reading a file
struct ReadFileResult {
  void* data;
  uint64_t size;
  int32_t error;
};

// Find asset index by path in version index
static int FindAssetIndexByPath(
    struct Longtail_HashAPI* hash_api,
    const struct Longtail_VersionIndex* version_index,
    const char* path,
    uint32_t* out_asset_index) {
  TLongtail_Hash path_hash;
  int err = Longtail_GetPathHash(hash_api, path, &path_hash);
  if (err) {
    return err;
  }

  uint32_t asset_count = *version_index->m_AssetCount;

  std::cerr << "Looking for path: '" << path << "' (hash: " << path_hash << ") in " << asset_count << " assets" << std::endl;

  for (uint32_t i = 0; i < asset_count; ++i) {
    const char* asset_path = &version_index->m_NameData[version_index->m_NameOffsets[i]];
    if (version_index->m_PathHashes[i] == path_hash) {
      // Verify by comparing actual path string
      if (strcmp(asset_path, path) == 0) {
        *out_asset_index = i;
        return 0;
      } else {
        std::cerr << "Hash matched but path differs: stored='" << asset_path << "'" << std::endl;
      }
    }
  }

  // Debug: print first few asset paths
  std::cerr << "First 10 asset paths in version:" << std::endl;
  for (uint32_t i = 0; i < asset_count && i < 10; ++i) {
    const char* asset_path = &version_index->m_NameData[version_index->m_NameOffsets[i]];
    std::cerr << "  [" << i << "]: '" << asset_path << "'" << std::endl;
  }

  return ENOENT;  // File not found
}

// Read a single file from a version and return its content in a buffer
static int ReadFileFromVersionSync(
    const char* FilePath,
    const char* VersionIndexName,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    WrapperAsyncHandle* handle,
    void** out_data,
    uint64_t* out_size) {
  *out_data = nullptr;
  *out_size = 0;

  struct Longtail_HashRegistryAPI* hash_registry = Longtail_CreateFullHashRegistry();
  struct Longtail_JobAPI* job_api = Longtail_CreateBikeshedJobAPI(1, 0);
  struct Longtail_CompressionRegistryAPI* compression_registry = Longtail_CreateFullCompressionRegistry();

  struct Longtail_StorageAPI* seaweed_storage_api = CreateSeaweedFSStorageAPI(FilerUrl, JWT);

  struct Longtail_BlockStoreAPI* store_block_remotestore_api = Longtail_CreateFSBlockStoreAPI(
      job_api,
      seaweed_storage_api,
      RemoteBasePath,
      0,
      0);  // No mmap for remote

  struct Longtail_BlockStoreAPI* compress_block_store_api = Longtail_CreateCompressBlockStoreAPI(
      store_block_remotestore_api,
      compression_registry);

  struct Longtail_BlockStoreAPI* lru_block_store_api = Longtail_CreateLRUBlockStoreAPI(compress_block_store_api, 32);
  struct Longtail_BlockStoreAPI* store_block_store_api = Longtail_CreateShareBlockStoreAPI(lru_block_store_api);

  // Read version index from remote
  std::stringstream version_index_stream;
  version_index_stream << std::string(RemoteBasePath) << std::string("/versions/") << VersionIndexName;
  std::string remote_version_index_path = version_index_stream.str();

  SetHandleStep(handle, "Reading version index");

  struct Longtail_VersionIndex* version_index = nullptr;
  int err = Longtail_ReadVersionIndex(seaweed_storage_api, remote_version_index_path.c_str(), &version_index);
  if (err) {
    SetHandleStep(handle, "Failed to read version index");
    handle->error = err;
    handle->completed = 1;
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // Get the hash API for this version
  uint32_t hashing_type = *version_index->m_HashIdentifier;
  struct Longtail_HashAPI* hash_api;
  err = hash_registry->GetHashAPI(hash_registry, hashing_type, &hash_api);
  if (err) {
    SetHandleStep(handle, "Failed to get hash API");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // Normalize file path - Longtail stores paths with a leading slash
  // std::string normalized_path = FilePath;
  // if (normalized_path.empty() || normalized_path[0] != '/') {
  //   normalized_path = "/" + normalized_path;
  // }

  // Find the asset in the version index
  SetHandleStep(handle, "Finding file in version");
  uint32_t asset_index;
  err = FindAssetIndexByPath(hash_api, version_index, FilePath, &asset_index);
  if (err) {
    SetHandleStep(handle, "File not found in version");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // Get the file size
  uint64_t file_size = version_index->m_AssetSizes[asset_index];

  // Handle empty files
  if (file_size == 0) {
    *out_data = nullptr;
    *out_size = 0;
    SetHandleStep(handle, "Completed");
    handle->error = 0;
    handle->completed = 1;
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return 0;
  }

  // Get chunk information for this asset
  uint32_t chunk_index_start = version_index->m_AssetChunkIndexStarts[asset_index];
  uint32_t chunk_count = version_index->m_AssetChunkCounts[asset_index];

  // Collect chunk hashes for this file
  TLongtail_Hash* chunk_hashes = (TLongtail_Hash*)Longtail_Alloc(0, sizeof(TLongtail_Hash) * chunk_count);
  if (!chunk_hashes) {
    SetHandleStep(handle, "Memory allocation failed");
    handle->error = ENOMEM;
    handle->completed = 1;
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  for (uint32_t i = 0; i < chunk_count; ++i) {
    uint32_t chunk_index = version_index->m_AssetChunkIndexes[chunk_index_start + i];
    chunk_hashes[i] = version_index->m_ChunkHashes[chunk_index];
  }

  // Get store index for these chunks
  SetHandleStep(handle, "Fetching block information");
  struct Longtail_StoreIndex* store_index;
  err = SyncGetExistingContent(store_block_store_api, chunk_count, chunk_hashes, 0, &store_index);
  if (err) {
    SetHandleStep(handle, "Failed to get store index");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(chunk_hashes);
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // Build a lookup table for chunk hash -> store index position using std::unordered_map
  std::unordered_map<TLongtail_Hash, uint32_t> chunk_hash_to_index;
  chunk_hash_to_index.reserve(*store_index->m_ChunkCount);
  for (uint32_t i = 0; i < *store_index->m_ChunkCount; ++i) {
    chunk_hash_to_index[store_index->m_ChunkHashes[i]] = i;
  }

  // Build block hash -> block index lookup using std::unordered_map
  std::unordered_map<TLongtail_Hash, uint32_t> block_hash_to_index;
  block_hash_to_index.reserve(*store_index->m_BlockCount);
  for (uint32_t i = 0; i < *store_index->m_BlockCount; ++i) {
    block_hash_to_index[store_index->m_BlockHashes[i]] = i;
  }

  // Allocate output buffer
  void* file_data = Longtail_Alloc(0, (size_t)file_size);
  if (!file_data) {
    SetHandleStep(handle, "Memory allocation failed");
    handle->error = ENOMEM;
    handle->completed = 1;
    Longtail_Free(store_index);
    Longtail_Free(chunk_hashes);
    Longtail_Free(version_index);
    ;
    Longtail_Free(version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  // Read chunks and assemble file
  SetHandleStep(handle, "Downloading file content");
  uint64_t file_offset = 0;

  // Group chunks by block for efficient reading
  std::map<TLongtail_Hash, std::vector<uint32_t>> block_to_chunks;
  for (uint32_t i = 0; i < chunk_count; ++i) {
    TLongtail_Hash chunk_hash = chunk_hashes[i];
    auto chunk_it = chunk_hash_to_index.find(chunk_hash);
    if (chunk_it == chunk_hash_to_index.end()) {
      SetHandleStep(handle, "Chunk not found in store");
      handle->error = ENOENT;
      handle->completed = 1;
      Longtail_Free(file_data);
      Longtail_Free(store_index);
      Longtail_Free(chunk_hashes);
      Longtail_Free(version_index);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(lru_block_store_api);
      SAFE_DISPOSE_API(compress_block_store_api);
      SAFE_DISPOSE_API(store_block_remotestore_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return ENOENT;
    }

    // Find which block this chunk is in
    uint32_t store_chunk_index = chunk_it->second;
    TLongtail_Hash block_hash = 0;
    for (uint32_t b = 0; b < *store_index->m_BlockCount; ++b) {
      uint32_t block_chunk_offset = store_index->m_BlockChunksOffsets[b];
      uint32_t block_chunk_count = store_index->m_BlockChunkCounts[b];
      if (store_chunk_index >= block_chunk_offset &&
          store_chunk_index < block_chunk_offset + block_chunk_count) {
        block_hash = store_index->m_BlockHashes[b];
        break;
      }
    }

    block_to_chunks[block_hash].push_back(i);
  }

  // Async block get callback
  struct AsyncGetStoredBlockComplete {
    struct Longtail_AsyncGetStoredBlockAPI m_API;
    HLongtail_Sema m_NotifySema;
    int m_Err;
    struct Longtail_StoredBlock* m_StoredBlock;
  };

  auto BlockGetOnComplete = [](struct Longtail_AsyncGetStoredBlockAPI* async_api,
                               struct Longtail_StoredBlock* stored_block, int err) {
    AsyncGetStoredBlockComplete* cb = (AsyncGetStoredBlockComplete*)async_api;
    cb->m_Err = err;
    cb->m_StoredBlock = stored_block;
    Longtail_PostSema(cb->m_NotifySema, 1);
  };

  // Process each block
  for (auto& [block_hash, chunk_indices] : block_to_chunks) {
    if (IsHandleCanceled(handle)) {
      Longtail_Free(file_data);
      Longtail_Free(store_index);
      Longtail_Free(chunk_hashes);
      Longtail_Free(version_index);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(lru_block_store_api);
      SAFE_DISPOSE_API(compress_block_store_api);
      SAFE_DISPOSE_API(store_block_remotestore_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return ECANCELED;
    }

    // Get the block
    AsyncGetStoredBlockComplete block_complete;
    block_complete.m_Err = EINVAL;
    block_complete.m_API.m_API.Dispose = nullptr;
    block_complete.m_API.OnComplete = BlockGetOnComplete;
    block_complete.m_StoredBlock = nullptr;
    Longtail_CreateSema(Longtail_Alloc(0, Longtail_GetSemaSize()), 0, &block_complete.m_NotifySema);

    err = store_block_store_api->GetStoredBlock(store_block_store_api, block_hash, &block_complete.m_API);
    if (err) {
      Longtail_DeleteSema(block_complete.m_NotifySema);
      Longtail_Free(block_complete.m_NotifySema);
      SetHandleStep(handle, "Failed to fetch block");
      handle->error = err;
      handle->completed = 1;
      Longtail_Free(file_data);
      Longtail_Free(store_index);
      Longtail_Free(chunk_hashes);
      Longtail_Free(version_index);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(lru_block_store_api);
      SAFE_DISPOSE_API(compress_block_store_api);
      SAFE_DISPOSE_API(store_block_remotestore_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return err;
    }

    Longtail_WaitSema(block_complete.m_NotifySema, LONGTAIL_TIMEOUT_INFINITE);
    Longtail_DeleteSema(block_complete.m_NotifySema);
    Longtail_Free(block_complete.m_NotifySema);

    if (block_complete.m_Err) {
      SetHandleStep(handle, "Failed to read block");
      handle->error = block_complete.m_Err;
      handle->completed = 1;
      Longtail_Free(file_data);
      Longtail_Free(store_index);
      Longtail_Free(chunk_hashes);
      Longtail_Free(version_index);
      SAFE_DISPOSE_API(store_block_store_api);
      SAFE_DISPOSE_API(lru_block_store_api);
      SAFE_DISPOSE_API(compress_block_store_api);
      SAFE_DISPOSE_API(store_block_remotestore_api);
      SAFE_DISPOSE_API(seaweed_storage_api);
      SAFE_DISPOSE_API(compression_registry);
      SAFE_DISPOSE_API(hash_registry);
      SAFE_DISPOSE_API(job_api);
      return block_complete.m_Err;
    }

    struct Longtail_StoredBlock* stored_block = block_complete.m_StoredBlock;
    struct Longtail_BlockIndex* block_index = stored_block->m_BlockIndex;

    // Build chunk offset within block
    uint32_t block_chunk_count = *block_index->m_ChunkCount;
    std::map<TLongtail_Hash, std::pair<uint32_t, uint32_t>> chunk_offset_size;  // hash -> (offset, size)
    uint32_t current_offset = 0;
    for (uint32_t c = 0; c < block_chunk_count; ++c) {
      chunk_offset_size[block_index->m_ChunkHashes[c]] = {current_offset, block_index->m_ChunkSizes[c]};
      current_offset += block_index->m_ChunkSizes[c];
    }

    // Copy chunks to output buffer (in order!)
    for (uint32_t chunk_idx : chunk_indices) {
      TLongtail_Hash chunk_hash = chunk_hashes[chunk_idx];
      auto it = chunk_offset_size.find(chunk_hash);
      if (it == chunk_offset_size.end()) {
        stored_block->Dispose(stored_block);
        SetHandleStep(handle, "Chunk not found in block");
        handle->error = ENOENT;
        handle->completed = 1;
        Longtail_Free(file_data);
        Longtail_Free(store_index);
        Longtail_Free(chunk_hashes);
        Longtail_Free(version_index);
        SAFE_DISPOSE_API(store_block_store_api);
        SAFE_DISPOSE_API(lru_block_store_api);
        SAFE_DISPOSE_API(compress_block_store_api);
        SAFE_DISPOSE_API(store_block_remotestore_api);
        SAFE_DISPOSE_API(seaweed_storage_api);
        SAFE_DISPOSE_API(compression_registry);
        SAFE_DISPOSE_API(hash_registry);
        SAFE_DISPOSE_API(job_api);
        return ENOENT;
      }

      uint32_t chunk_offset = it->second.first;
      uint32_t chunk_size = it->second.second;

      // Calculate the destination offset in the file
      // We need the offset based on chunk order in the asset
      uint64_t dest_offset = 0;
      for (uint32_t j = 0; j < chunk_idx; ++j) {
        uint32_t prev_chunk_index = version_index->m_AssetChunkIndexes[chunk_index_start + j];
        dest_offset += version_index->m_ChunkSizes[prev_chunk_index];
      }

      memcpy((char*)file_data + dest_offset,
             (char*)stored_block->m_BlockData + chunk_offset,
             chunk_size);
    }

    stored_block->Dispose(stored_block);
  }

  // Success
  *out_data = file_data;
  *out_size = file_size;

  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->completed = 1;

  Longtail_Free(store_index);
  Longtail_Free(chunk_hashes);
  Longtail_Free(version_index);
  SAFE_DISPOSE_API(store_block_store_api);
  SAFE_DISPOSE_API(lru_block_store_api);
  SAFE_DISPOSE_API(compress_block_store_api);
  SAFE_DISPOSE_API(store_block_remotestore_api);
  SAFE_DISPOSE_API(seaweed_storage_api);
  SAFE_DISPOSE_API(compression_registry);
  SAFE_DISPOSE_API(hash_registry);
  SAFE_DISPOSE_API(job_api);

  return 0;
}

// ReadFileAsyncHandle is defined in main.h

DLL_EXPORT ReadFileAsyncHandle* ReadFileFromVersionAsync(
    const char* FilePath,
    const char* VersionIndexName,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    int LogLevel) {
  SetLogging(LogLevel);

  ReadFileAsyncHandle* handle = (ReadFileAsyncHandle*)Longtail_Alloc(0, sizeof(ReadFileAsyncHandle));
  if (!handle) {
    return nullptr;
  }

  memset(handle, 0, sizeof(ReadFileAsyncHandle));
  SetHandleStep(&handle->base, "Initializing");

  std::thread read_thread([=]() {
    void* data = nullptr;
    uint64_t size = 0;

    int32_t err = ReadFileFromVersionSync(
        FilePath,
        VersionIndexName,
        RemoteBasePath,
        FilerUrl,
        JWT,
        JWTExpirationMs,
        &handle->base,
        &data,
        &size);

    handle->data = data;
    handle->size = size;

    if (err) {
      std::cerr << "Failed to read file from version, " << err << ": " << handle->base.currentStep << std::endl;
    }
  });

  read_thread.detach();

  return handle;
}

DLL_EXPORT void FreeReadFileHandle(ReadFileAsyncHandle* handle) {
  if (handle) {
    if (handle->data) {
      Longtail_Free(handle->data);
    }
    Longtail_Free(handle);
  }
}

DLL_EXPORT void* GetReadFileData(ReadFileAsyncHandle* handle) {
  return handle ? handle->data : nullptr;
}

DLL_EXPORT uint64_t GetReadFileSize(ReadFileAsyncHandle* handle) {
  return handle ? handle->size : 0;
}
