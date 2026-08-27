#include <lrublockstore/longtail_lrublockstore.h>
#include <shareblockstore/longtail_shareblockstore.h>
#include <cacheblockstore/longtail_cacheblockstore.h>

#include "../util/existing-content.h"
#include "../util/path-filter.h"
#include "../util/progress.h"
#include "main.h"

/** The repo-relative path of an asset in a version index. */
static const char* AssetPath(
    const struct Longtail_VersionIndex* version_index,
    uint32_t asset_index) {
  return &version_index->m_NameData[version_index->m_NameOffsets[asset_index]];
}

/**
 * Drop every asset the filter excludes from `version_diff`, in place, and
 * return how many were dropped.
 *
 * The diff's arrays are parallel (a source index and a target index per
 * modified asset), so each kept entry is copied down to the next free slot of
 * every array in its group and the group's count is lowered. Relative order is
 * preserved, and the diff still occupies one allocation, so it is freed exactly
 * as before.
 *
 * This is the right seam for include filtering. Filtering the *local* scan
 * instead would be actively wrong: an excluded file that is missing from the
 * local version index reads as "added" in the diff and gets downloaded, the
 * opposite of the intent. Filtering here means excluded assets are never asked
 * for by Longtail_GetRequiredChunkHashes and never written by
 * Longtail_ChangeVersion, so their blocks are never fetched at all.
 *
 * m_SourceRemovedCount is not filtered because the caller zeroes it
 * unconditionally: Checkpoint versions are incremental, so diff removals are
 * always false positives.
 */
static uint32_t FilterVersionDiff(
    struct Longtail_VersionDiff* version_diff,
    const struct Longtail_VersionIndex* target_version_index,
    const Checkpoint::PathFilter& filter) {
  uint32_t dropped = 0;

  // Added assets carry only a target index.
  const uint32_t added_count = *version_diff->m_TargetAddedCount;
  uint32_t added_kept = 0;
  for (uint32_t i = 0; i < added_count; ++i) {
    const uint32_t target = version_diff->m_TargetAddedAssetIndexes[i];
    if (!filter.Includes(AssetPath(target_version_index, target))) {
      ++dropped;
      continue;
    }
    version_diff->m_TargetAddedAssetIndexes[added_kept++] = target;
  }
  *version_diff->m_TargetAddedCount = added_kept;

  // Content changes pair a source index with a target index.
  const uint32_t modified_count = *version_diff->m_ModifiedContentCount;
  uint32_t modified_kept = 0;
  for (uint32_t i = 0; i < modified_count; ++i) {
    const uint32_t target = version_diff->m_TargetContentModifiedAssetIndexes[i];
    if (!filter.Includes(AssetPath(target_version_index, target))) {
      ++dropped;
      continue;
    }
    version_diff->m_SourceContentModifiedAssetIndexes[modified_kept] =
        version_diff->m_SourceContentModifiedAssetIndexes[i];
    version_diff->m_TargetContentModifiedAssetIndexes[modified_kept] = target;
    ++modified_kept;
  }
  *version_diff->m_ModifiedContentCount = modified_kept;

  // Permission-only changes are paired the same way.
  const uint32_t permissions_count = *version_diff->m_ModifiedPermissionsCount;
  uint32_t permissions_kept = 0;
  for (uint32_t i = 0; i < permissions_count; ++i) {
    const uint32_t target =
        version_diff->m_TargetPermissionsModifiedAssetIndexes[i];
    if (!filter.Includes(AssetPath(target_version_index, target))) {
      ++dropped;
      continue;
    }
    version_diff->m_SourcePermissionsModifiedAssetIndexes[permissions_kept] =
        version_diff->m_SourcePermissionsModifiedAssetIndexes[i];
    version_diff->m_TargetPermissionsModifiedAssetIndexes[permissions_kept] =
        target;
    ++permissions_kept;
  }
  *version_diff->m_ModifiedPermissionsCount = permissions_kept;

  return dropped;
}

int PullSync(
    const char* VersionIndex,
    bool EnableMmapIndexing,
    bool EnableMmapBlockStore,
    const char* LocalRootPath,
    const char* RemoteBasePath,
    const char* StorageType,
    const char* GatewayUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    const char* CachePath,
    const Checkpoint::PathFilter& IncludeFilter,
    WrapperAsyncHandle* handle) {
  struct Longtail_HashRegistryAPI* hash_registry = Longtail_CreateFullHashRegistry();
  struct Longtail_JobAPI* job_api = Longtail_CreateBikeshedJobAPI(Longtail_GetCPUCount(), 0);
  struct Longtail_CompressionRegistryAPI* compression_registry = Longtail_CreateFullCompressionRegistry();

  struct Longtail_StorageAPI* file_storage_api = Longtail_CreateFSStorageAPI();
  struct Longtail_StorageAPI* remote_storage_api;
  if (StorageType && strcmp(StorageType, "gateway") == 0) {
    remote_storage_api = CreateGatewayStorageAPI(GatewayUrl, JWT, handle, JWTExpirationMs);
  } else {
    remote_storage_api = CreateS3StorageAPI(S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken, handle, JWTExpirationMs);
  }

  struct Longtail_BlockStoreAPI* store_block_remotestore_api = Longtail_CreateFSBlockStoreAPI(
      job_api,
      remote_storage_api,
      RemoteBasePath,
      0,
      EnableMmapBlockStore);

  // Persistent block cache: stores compressed blocks locally to avoid re-downloads
  struct Longtail_StorageAPI* cache_storage_api = 0;
  struct Longtail_BlockStoreAPI* local_cache_store_api = 0;
  struct Longtail_BlockStoreAPI* cache_block_store_api = 0;
  struct Longtail_BlockStoreAPI* block_source_api = store_block_remotestore_api;

  if (CachePath && CachePath[0] != '\0') {
    cache_storage_api = Longtail_CreateFSStorageAPI();
    local_cache_store_api = Longtail_CreateFSBlockStoreAPI(
        job_api,
        cache_storage_api,
        CachePath,
        0,
        EnableMmapBlockStore);
    cache_block_store_api = Longtail_CreateCacheBlockStoreAPI(
        job_api,
        local_cache_store_api,
        store_block_remotestore_api);
    block_source_api = cache_block_store_api;
  }

  struct Longtail_BlockStoreAPI* compress_block_store_api = Longtail_CreateCompressBlockStoreAPI(
      block_source_api,
      compression_registry);

  struct Longtail_BlockStoreAPI* lru_block_store_api = Longtail_CreateLRUBlockStoreAPI(compress_block_store_api, 32);
  struct Longtail_BlockStoreAPI* store_block_store_api = Longtail_CreateShareBlockStoreAPI(lru_block_store_api);

  std::stringstream version_index_stream;
  version_index_stream << std::string(RemoteBasePath) << std::string("/versions/") << VersionIndex;
  std::string remote_version_index_path = version_index_stream.str().c_str();

  SetHandleStep(handle, "Fetching version data");

  struct Longtail_VersionIndex* remote_version_index = 0;
  int err = Longtail_ReadVersionIndex(remote_storage_api, remote_version_index_path.c_str(), &remote_version_index);
  if (err) {
    SetHandleStep(handle, "Failed to read version index");
    handle->error = err;
    handle->completed = 1;
    SAFE_DISPOSE_API(store_block_store_api);
    SAFE_DISPOSE_API(lru_block_store_api);
    SAFE_DISPOSE_API(compress_block_store_api);
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return ENOMEM;
  }

  struct Longtail_VersionIndex* local_version_index = 0;
  uint32_t target_chunk_size = *remote_version_index->m_TargetChunkSize;

  SetHandleStep(handle, "Scanning local files");

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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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

  struct Longtail_ProgressAPI* progress = MakeProgressAPI("Indexing local files", handle);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  SetHandleStep(handle, "Comparing versions");

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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  // For Checkpoint, versions are incremental so the diff will pick up false positives
  // for removals. This will override prevents ChangeVersion from deleting files
  *version_diff->m_SourceRemovedCount = 0;

  // Apply the caller's include rules before anything reads the diff, so
  // excluded assets are never requested from the block store and never written.
  if (!IncludeFilter.IsNoOp()) {
    FilterVersionDiff(version_diff, remote_version_index, IncludeFilter);
  }

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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
    return err;
  }

  Longtail_Free(required_chunk_hashes);

  progress = MakeProgressAPI("Downloading files", handle);
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
    SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
    SAFE_DISPOSE_API(remote_storage_api);
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
  SAFE_DISPOSE_API(cache_block_store_api);
    SAFE_DISPOSE_API(local_cache_store_api);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(store_block_remotestore_api);
  SAFE_DISPOSE_API(remote_storage_api);
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
    const char* StorageType,
    const char* GatewayUrl,
    const char* JWT,
    uint64_t JWTExpirationMs,
    const char* S3Endpoint,
    const char* S3Region,
    const char* S3Bucket,
    const char* S3AccessKeyId,
    const char* S3SecretAccessKey,
    const char* S3SessionToken,
    const char* CachePath,
    const char* const* IncludePaths,
    uint32_t NumIncludePaths,
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }

  memset(handle, 0, sizeof(WrapperAsyncHandle));

  SetHandleStep(handle, "Initializing");

  // Compile the rules here and capture the filter by value, so the worker
  // thread does not depend on the caller's string array outliving this call.
  Checkpoint::PathFilter include_filter(IncludePaths, NumIncludePaths);

  std::thread merge_thread([=]() {
    int32_t err = PullSync(
        VersionIndex,
        EnableMmapIndexing,
        EnableMmapBlockStore,
        LocalRootPath,
        RemoteBasePath,
        StorageType,
        GatewayUrl,
        JWT,
        JWTExpirationMs,
        S3Endpoint,
        S3Region,
        S3Bucket,
        S3AccessKeyId,
        S3SecretAccessKey,
        S3SessionToken,
        CachePath,
        include_filter,
        handle);

    if (err) {
      std::cerr << "Failed to pull version, " << err << ": " << handle->currentStep << std::endl;
    }
  });

  merge_thread.detach();

  return handle;
}
