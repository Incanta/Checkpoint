#include <lrublockstore/longtail_lrublockstore.h>
#include <shareblockstore/longtail_shareblockstore.h>

#include "../util/existing-content.h"
#include "../util/progress.h"
#include "main.h"

int Pull(
    const char* VersionIndex,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    WrapperAsyncHandle* handle) {
  struct Longtail_HashRegistryAPI* hash_registry = Longtail_CreateFullHashRegistry();
  struct Longtail_JobAPI* job_api = Longtail_CreateBikeshedJobAPI(1, 0);
  struct Longtail_CompressionRegistryAPI* compression_registry = Longtail_CreateFullCompressionRegistry();

  struct Longtail_StorageAPI* file_storage_api = Longtail_CreateFSStorageAPI();
  struct Longtail_StorageAPI* seaweed_storage_api = CreateSeaweedFSStorageAPI(FilerUrl, JWT);

  struct Longtail_BlockStoreAPI* store_block_remotestore_api = Longtail_CreateFSBlockStoreAPI(
      job_api,
      seaweed_storage_api,
      RemoteBasePath,
      0,
      EnableMmapBlockStore);

  // TODO handle cache path/caching?

  struct Longtail_BlockStoreAPI* compress_block_store_api = Longtail_CreateCompressBlockStoreAPI(
      store_block_remotestore_api,
      compression_registry);

  struct Longtail_BlockStoreAPI* lru_block_store_api = Longtail_CreateLRUBlockStoreAPI(compress_block_store_api, 32);
  struct Longtail_BlockStoreAPI* store_block_store_api = Longtail_CreateShareBlockStoreAPI(lru_block_store_api);

  std::stringstream version_index_stream;
  version_index_stream << std::string(RemoteBasePath) << std::string("/versions/") << VersionIndex;
  std::string remote_version_index_path = version_index_stream.str().c_str();

  struct Longtail_VersionIndex* remote_version_index = 0;
  int err = Longtail_ReadVersionIndex(seaweed_storage_api, remote_version_index_path.c_str(), &remote_version_index);
  if (err) {
    SetHandleStep(handle, "Failed to read version index");
    handle->error = err;
    handle->completed = 1;
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  uint32_t hashing_type = *remote_version_index->m_HashIdentifier;
  struct Longtail_HashAPI* hash_api;
  err = hash_registry->GetHashAPI(hash_registry, hashing_type, &hash_api);
  if (err) {
    SetHandleStep(handle, "Failed to get hash API");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct Longtail_ChunkerAPI* chunker_api = Longtail_CreateHPCDCChunkerAPI();
  if (!chunker_api) {
    SetHandleStep(handle, "Failed to get chunker API");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  struct Longtail_VersionIndex* local_version_index = 0;
  uint32_t target_chunk_size = *remote_version_index->m_TargetChunkSize;

  struct Longtail_FileInfos* file_infos;
  err = Longtail_GetFilesFilteredByVersionIndex(
      file_storage_api,
      remote_version_index,
      0,
      0,
      LocalRootPath,
      &file_infos);

  if (err) {
    SetHandleStep(handle, "Failed to scan local files for diff");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  uint32_t* tags = file_infos->m_Count == 0 ? nullptr : (uint32_t*)Longtail_Alloc(0, sizeof(uint32_t) * file_infos->m_Count);
  for (uint32_t i = 0; i < file_infos->m_Count; ++i) {
    tags[i] = 0;
  }

  struct Longtail_ProgressAPI* progress = MakeProgressAPI("Indexing version");
  if (progress) {
    err = Longtail_CreateVersionIndex(
        file_storage_api,
        hash_api,
        chunker_api,
        job_api,
        progress,
        0,
        0,
        LocalRootPath,
        file_infos,
        tags,
        target_chunk_size,
        EnableMmapIndexing,
        &local_version_index);
    SAFE_DISPOSE_API(progress);
  } else {
    err = ENOMEM;
  }

  Longtail_Free(tags);
  Longtail_Free(file_infos);
  if (err) {
    SetHandleStep(handle, "Failed to create local version index");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct Longtail_VersionDiff* version_diff;
  err = Longtail_CreateVersionDiff(
      hash_api,
      local_version_index,
      remote_version_index,
      &version_diff);
  if (err) {
    SetHandleStep(handle, "Failed to create diff from local to remote");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(local_version_index);
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // For Checkpoint, versions are incremental so the diff will pick up false positives
  // for removals. This will override prevents ChangeVersion from deleting files
  *version_diff->m_SourceRemovedCount = 0;

  if ((*version_diff->m_ModifiedContentCount == 0) &&
      (*version_diff->m_TargetAddedCount == 0) &&
      (*version_diff->m_ModifiedPermissionsCount == 0 /*|| !retain_permissions*/))  // TODO
  {
    SetHandleStep(handle, "Completed");
    handle->error = 0;
    handle->completed = 1;
    Longtail_Free(version_diff);
    Longtail_Free(local_version_index);
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return 0;
  }

  uint32_t required_chunk_count;
  TLongtail_Hash* required_chunk_hashes = (TLongtail_Hash*)Longtail_Alloc(0, sizeof(TLongtail_Hash) * (*remote_version_index->m_ChunkCount));
  err = Longtail_GetRequiredChunkHashes(
      remote_version_index,
      version_diff,
      &required_chunk_count,
      required_chunk_hashes);
  if (err) {
    SetHandleStep(handle, "Failed to get required chunks");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(required_chunk_hashes);
    Longtail_Free(version_diff);
    Longtail_Free(local_version_index);
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  struct Longtail_StoreIndex* required_version_store_index;
  err = SyncGetExistingContent(
      store_block_store_api,
      required_chunk_count,
      required_chunk_hashes,
      0,
      &required_version_store_index);
  if (err) {
    SetHandleStep(handle, "Failed to retarget the store index to the remote store");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(required_chunk_hashes);
    Longtail_Free(version_diff);
    Longtail_Free(local_version_index);
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  Longtail_Free(required_chunk_hashes);

  progress = MakeProgressAPI("Updating version");
  if (progress) {
    err = Longtail_ChangeVersion(
        store_block_store_api,
        file_storage_api,
        hash_api,
        job_api,
        progress,
        0,
        0,
        required_version_store_index,
        local_version_index,
        remote_version_index,
        version_diff,
        LocalRootPath,
        /*retain_permissions*/ true ? 1 : 0);
    SAFE_DISPOSE_API(progress);
  } else {
    err = ENOMEM;
  }

  if (err) {
    SetHandleStep(handle, "Failed to update version");
    handle->error = err;
    handle->completed = 1;
    Longtail_Free(version_diff);
    Longtail_Free(local_version_index);
    Longtail_Free(required_version_store_index);
    Longtail_Free(remote_version_index);
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    // SAFE_DISPOSE_API(store_block_cachestore_api);
    // SAFE_DISPOSE_API(store_block_localstore_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(seaweed_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->completed = 1;

  Longtail_Free(version_diff);
  Longtail_Free(local_version_index);
  Longtail_Free(required_version_store_index);
  Longtail_Free(remote_version_index);
  SAFE_DISPOSE_API(chunker_api);
  SAFE_DISPOSE_API(store_block_store_api);
  SAFE_DISPOSE_API(lru_block_store_api);
  SAFE_DISPOSE_API(compress_block_store_api);
  // SAFE_DISPOSE_API(store_block_cachestore_api);
  // SAFE_DISPOSE_API(store_block_localstore_api);
  SAFE_DISPOSE_API(store_block_remotestore_api);
  SAFE_DISPOSE_API(seaweed_storage_api);
  SAFE_DISPOSE_API(file_storage_api);
  SAFE_DISPOSE_API(compression_registry);
  SAFE_DISPOSE_API(hash_registry);
  SAFE_DISPOSE_API(job_api);
  return 0;
}

DLL_EXPORT WrapperAsyncHandle*
PullAsync(
    const char* VersionIndex,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* FilerUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  SetHandleStep(handle, "Initializing");

  std::thread merge_thread([=]() {
    int32_t err = Pull(
        VersionIndex,
        EnableMmapIndexing,
        EnableMmapBlockStore,
        LocalRootPath,
        RemoteBasePath,
        FilerUrl,
        JWT,
        JWTExpirationMs,
        handle);

    if (err) {
      std::cerr << "Failed to pull version, " << err << ": " << handle->currentStep << std::endl;
    }
  });

  merge_thread.detach();

  return handle;
}
