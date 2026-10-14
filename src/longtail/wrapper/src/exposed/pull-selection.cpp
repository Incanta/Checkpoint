#include <lrublockstore/longtail_lrublockstore.h>
#include <shareblockstore/longtail_shareblockstore.h>
#include <cacheblockstore/longtail_cacheblockstore.h>

#include <filesystem>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "../util/existing-content.h"
#include "../util/progress.h"
#include "../util/version-index-io.h"
#include "main.h"

// One pass over a pull: bring the given paths to the content each one has in
// its own source changelist's version index.
//
// A changelist's version index holds only what that changelist changed, so a
// pull used to apply the index of every changelist it needed, one native pass
// each, oldest first. Every pass walked the whole workspace and downloaded
// the repo-wide store index, and applying a whole index wrote paths the pull
// did not want (files later deleted, files later replaced), which a
// correction pass then repaired file by file.
//
// Here the caller names exactly the paths to write and the source of each.
// Their entries are taken from their own sources' indexes into one synthetic
// target index, only those paths are scanned locally, their blocks are found
// through each source's block map (versions/<name>.lsi), and one
// Longtail_ChangeVersion writes them. Nothing outside the selection is
// written, so there is nothing to correct afterwards.
//
// Deletions are not done here; the caller removes paths itself.

namespace {

template <typename T>
struct Owned {
  T* p = nullptr;
  Owned() = default;
  Owned(const Owned&) = delete;
  Owned& operator=(const Owned&) = delete;
  Owned(Owned&& o) noexcept : p(o.p) { o.p = nullptr; }
  ~Owned() {
    if (p) Longtail_Free(p);
  }
  T** out() { return &p; }
};

struct ApiStack {
  struct Longtail_HashRegistryAPI* hash_registry = nullptr;
  struct Longtail_JobAPI* job_api = nullptr;
  struct Longtail_CompressionRegistryAPI* compression_registry = nullptr;
  struct Longtail_StorageAPI* file_storage_api = nullptr;
  struct Longtail_StorageAPI* remote_storage_api = nullptr;
  struct Longtail_BlockStoreAPI* remote_store = nullptr;
  struct Longtail_StorageAPI* cache_storage_api = nullptr;
  struct Longtail_BlockStoreAPI* local_cache_store = nullptr;
  struct Longtail_BlockStoreAPI* cache_store = nullptr;
  struct Longtail_BlockStoreAPI* compress_store = nullptr;
  struct Longtail_BlockStoreAPI* lru_store = nullptr;
  struct Longtail_BlockStoreAPI* block_store = nullptr;
  struct Longtail_ChunkerAPI* chunker_api = nullptr;

  ~ApiStack() {
    SAFE_DISPOSE_API(chunker_api);
    SAFE_DISPOSE_API(block_store);
    SAFE_DISPOSE_API(lru_store);
    SAFE_DISPOSE_API(compress_store);
    SAFE_DISPOSE_API(cache_store);
    SAFE_DISPOSE_API(local_cache_store);
    SAFE_DISPOSE_API(cache_storage_api);
    SAFE_DISPOSE_API(remote_store);
    SAFE_DISPOSE_API(remote_storage_api);
    SAFE_DISPOSE_API(file_storage_api);
    SAFE_DISPOSE_API(compression_registry);
    SAFE_DISPOSE_API(hash_registry);
    SAFE_DISPOSE_API(job_api);
  }
};

int Fail(WrapperAsyncHandle* handle, int err, const std::string& step) {
  SetHandleStep(handle, step.c_str());
  handle->error = err;
  handle->settled = 1;
  return err;
}

/** A Longtail_FileInfos in one allocation, laid out as Longtail expects. */
struct Longtail_FileInfos* MakeFileInfos(
    const std::vector<std::string>& paths,
    const std::vector<uint64_t>& sizes,
    const std::vector<uint16_t>& permissions) {
  const uint32_t count = (uint32_t)paths.size();
  uint32_t path_data_size = 0;
  for (const auto& p : paths) path_data_size += (uint32_t)p.size() + 1;
  size_t total = sizeof(struct Longtail_FileInfos) + sizeof(uint64_t) * count +
                 sizeof(uint32_t) * count + sizeof(uint16_t) * count + path_data_size;
  auto* infos = (struct Longtail_FileInfos*)Longtail_Alloc("PullSelectionFileInfos", total);
  if (!infos) return nullptr;
  char* p = (char*)&infos[1];
  infos->m_Count = count;
  infos->m_PathDataSize = path_data_size;
  infos->m_Sizes = (uint64_t*)p;
  p += sizeof(uint64_t) * count;
  infos->m_PathStartOffsets = (uint32_t*)p;
  p += sizeof(uint32_t) * count;
  infos->m_Permissions = (uint16_t*)p;
  p += sizeof(uint16_t) * count;
  infos->m_PathData = p;
  uint32_t offset = 0;
  for (uint32_t i = 0; i < count; ++i) {
    infos->m_Sizes[i] = sizes[i];
    infos->m_Permissions[i] = permissions[i];
    infos->m_PathStartOffsets[i] = offset;
    memcpy(&infos->m_PathData[offset], paths[i].c_str(), paths[i].size() + 1);
    offset += (uint32_t)paths[i].size() + 1;
  }
  return infos;
}

std::string BlockMapPathFor(const std::string& remoteBasePath, const std::string& versionIndex) {
  std::string stem = versionIndex;
  if (stem.size() > 4 && stem.compare(stem.size() - 4, 4, ".lvi") == 0) {
    stem = stem.substr(0, stem.size() - 4);
  }
  return remoteBasePath + "/versions/" + stem + ".lsi";
}

}  // namespace

int PullSelectionSync(
    const std::vector<std::string>& Sources,
    const std::vector<std::string>& SelectionPaths,
    const std::vector<uint32_t>& SelectionSources,
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
    WrapperAsyncHandle* handle) {
  const auto started = std::chrono::steady_clock::now();
  auto elapsedMs = [&]() {
    return (long long)std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now() - started)
        .count();
  };

  ApiStack apis;
  apis.hash_registry = Longtail_CreateFullHashRegistry();
  apis.job_api = Longtail_CreateBikeshedJobAPI(Longtail_GetCPUCount(), 0);
  apis.compression_registry = Longtail_CreateFullCompressionRegistry();
  apis.file_storage_api = Longtail_CreateFSStorageAPI();
  if (StorageType && strcmp(StorageType, "gateway") == 0) {
    apis.remote_storage_api = CreateGatewayStorageAPI(GatewayUrl, JWT, handle, JWTExpirationMs);
  } else {
    apis.remote_storage_api = CreateS3StorageAPI(S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken, handle, JWTExpirationMs);
  }
  if (!apis.remote_storage_api) {
    return Fail(handle, ENOMEM, "Failed to create storage api");
  }
  apis.remote_store = Longtail_CreateFSBlockStoreAPI(apis.job_api, apis.remote_storage_api, RemoteBasePath, 0, EnableMmapBlockStore);
  struct Longtail_BlockStoreAPI* block_source = apis.remote_store;
  if (CachePath && CachePath[0] != '\0') {
    apis.cache_storage_api = Longtail_CreateFSStorageAPI();
    apis.local_cache_store = Longtail_CreateFSBlockStoreAPI(apis.job_api, apis.cache_storage_api, CachePath, 0, EnableMmapBlockStore);
    apis.cache_store = Longtail_CreateCacheBlockStoreAPI(apis.job_api, apis.local_cache_store, apis.remote_store);
    block_source = apis.cache_store;
  }
  apis.compress_store = Longtail_CreateCompressBlockStoreAPI(block_source, apis.compression_registry);
  apis.lru_store = Longtail_CreateLRUBlockStoreAPI(apis.compress_store, 32);
  apis.block_store = Longtail_CreateShareBlockStoreAPI(apis.lru_store);
  apis.chunker_api = Longtail_CreateHPCDCChunkerAPI();
  if (!apis.chunker_api) {
    return Fail(handle, ENOMEM, "Failed to get chunker API");
  }

  // ── Collect each selected path's entry from its own source ─────────
  // Everything the target index needs, with chunks deduplicated across
  // sources.
  std::vector<std::string> asset_paths;
  std::vector<uint64_t> asset_sizes;
  std::vector<uint16_t> asset_permissions;
  std::vector<TLongtail_Hash> asset_content_hashes;
  std::vector<uint32_t> asset_chunk_starts;
  std::vector<uint32_t> asset_chunk_counts;
  std::vector<uint32_t> asset_chunk_indexes;
  std::vector<TLongtail_Hash> chunk_hashes;
  std::vector<uint32_t> chunk_sizes;
  std::vector<uint32_t> chunk_tags;
  std::unordered_map<TLongtail_Hash, uint32_t> chunk_lookup;

  uint32_t hash_identifier = 0;
  uint32_t target_chunk_size = 0;
  bool all_block_maps = true;
  Owned<struct Longtail_StoreIndex> merged_maps;
  uint64_t index_bytes = 0;

  std::vector<std::vector<uint32_t>> by_source(Sources.size());
  for (uint32_t i = 0; i < SelectionPaths.size(); ++i) {
    if (SelectionSources[i] >= Sources.size()) {
      return Fail(handle, EINVAL, "A selection names a source that was not given");
    }
    by_source[SelectionSources[i]].push_back(i);
  }

  SetHandleStep(handle, "Fetching version data");
  for (uint32_t s = 0; s < Sources.size(); ++s) {
    if (by_source[s].empty()) continue;
    if (IsHandleCanceled(handle)) return Fail(handle, ECANCELED, "Canceled");

    const std::string& name = Sources[s];
    const std::string path = std::string(RemoteBasePath) + "/versions/" + name;
    Owned<struct Longtail_VersionIndex> vi;
    int err = version_index_io::ReadVerified(apis.remote_storage_api, path.c_str(), name, vi.out());
    if (err) {
      return Fail(handle, err, err == EBADMSG
          ? "Version index failed verification: its content does not match its name: " + name
          : "Failed to read version index " + name);
    }
    if (hash_identifier == 0) {
      hash_identifier = *vi.p->m_HashIdentifier;
      target_chunk_size = *vi.p->m_TargetChunkSize;
    } else if (*vi.p->m_HashIdentifier != hash_identifier || *vi.p->m_TargetChunkSize != target_chunk_size) {
      // Sources hashed or chunked differently cannot share one index; the
      // caller falls back to applying them one at a time.
      return Fail(handle, ENOTSUP, "Sources use different hashing or chunk sizes");
    }

    std::unordered_map<std::string, uint32_t> assets;
    const uint32_t asset_count = *vi.p->m_AssetCount;
    assets.reserve(asset_count);
    for (uint32_t a = 0; a < asset_count; ++a) {
      assets.emplace(&vi.p->m_NameData[vi.p->m_NameOffsets[a]], a);
    }

    std::vector<TLongtail_Hash> wanted;
    std::unordered_set<TLongtail_Hash> wanted_set;
    for (uint32_t sel : by_source[s]) {
      auto found = assets.find(SelectionPaths[sel]);
      if (found == assets.end()) {
        // The server's tree says this source wrote the path; its index says
        // otherwise. Writing anything would be guessing.
        return Fail(handle, EBADMSG, "Version index " + name + " does not contain " + SelectionPaths[sel]);
      }
      const uint32_t a = found->second;
      asset_paths.push_back(SelectionPaths[sel]);
      asset_sizes.push_back(vi.p->m_AssetSizes[a]);
      asset_permissions.push_back(vi.p->m_Permissions[a]);
      asset_content_hashes.push_back(vi.p->m_ContentHashes[a]);
      asset_chunk_starts.push_back((uint32_t)asset_chunk_indexes.size());
      const uint32_t start = vi.p->m_AssetChunkIndexStarts[a];
      const uint32_t count = vi.p->m_AssetChunkCounts[a];
      asset_chunk_counts.push_back(count);
      for (uint32_t c = 0; c < count; ++c) {
        const uint32_t ci = vi.p->m_AssetChunkIndexes[start + c];
        const TLongtail_Hash h = vi.p->m_ChunkHashes[ci];
        auto it = chunk_lookup.find(h);
        uint32_t index;
        if (it == chunk_lookup.end()) {
          index = (uint32_t)chunk_hashes.size();
          chunk_lookup.emplace(h, index);
          chunk_hashes.push_back(h);
          chunk_sizes.push_back(vi.p->m_ChunkSizes[ci]);
          chunk_tags.push_back(vi.p->m_ChunkTags[ci]);
        } else {
          index = it->second;
        }
        asset_chunk_indexes.push_back(index);
        if (wanted_set.insert(h).second) wanted.push_back(h);
      }
    }

    // The blocks holding this source's selected chunks, from its block map.
    if (all_block_maps && !wanted.empty()) {
      const std::string map_path = BlockMapPathFor(RemoteBasePath, name);
      Owned<struct Longtail_StoreIndex> block_map;
      if (!apis.remote_storage_api->IsFile(apis.remote_storage_api, map_path.c_str()) ||
          Longtail_ReadStoreIndex(apis.remote_storage_api, map_path.c_str(), block_map.out()) != 0) {
        // Submitted before block maps existed: find blocks the old way.
        all_block_maps = false;
        continue;
      }
      index_bytes += 16 + 20ull * *block_map.p->m_BlockCount + 12ull * *block_map.p->m_ChunkCount;
      Owned<struct Longtail_StoreIndex> subset;
      err = Longtail_GetExistingStoreIndex(block_map.p, (uint32_t)wanted.size(), wanted.data(), 0, subset.out());
      if (err) return Fail(handle, err, "Failed to read the block map of " + name);
      std::unordered_set<TLongtail_Hash> covered(subset.p->m_ChunkHashes, subset.p->m_ChunkHashes + *subset.p->m_ChunkCount);
      for (TLongtail_Hash h : wanted) {
        if (!covered.count(h)) {
          return Fail(handle, EBADMSG, "The block map of " + name + " does not cover its own chunks");
        }
      }
      if (!merged_maps.p) {
        std::swap(merged_maps.p, subset.p);
      } else {
        Owned<struct Longtail_StoreIndex> next;
        err = Longtail_MergeStoreIndex(merged_maps.p, subset.p, next.out());
        if (err) return Fail(handle, err, "Failed to combine block maps");
        std::swap(merged_maps.p, next.p);
      }
    }
  }
  const long long fetchMs = elapsedMs();

  const uint32_t asset_total = (uint32_t)asset_paths.size();
  if (asset_total == 0) {
    SetHandleStep(handle, "Completed");
    handle->error = 0;
    handle->settled = 1;
    return 0;
  }

  struct Longtail_HashAPI* hash_api = nullptr;
  int err = apis.hash_registry->GetHashAPI(apis.hash_registry, hash_identifier, &hash_api);
  if (err) return Fail(handle, err, "Failed to get hash API");

  // ── The target: exactly the selected paths ─────────────────────────
  SetHandleStep(handle, "Building target version");
  std::vector<TLongtail_Hash> path_hashes(asset_total);
  for (uint32_t a = 0; a < asset_total; ++a) {
    err = Longtail_GetPathHash(hash_api, asset_paths[a].c_str(), &path_hashes[a]);
    if (err) return Fail(handle, err, "Failed to hash a path");
  }
  Owned<struct Longtail_FileInfos> target_infos;
  target_infos.p = MakeFileInfos(asset_paths, asset_sizes, asset_permissions);
  if (!target_infos.p) return Fail(handle, ENOMEM, "Out of memory");

  const size_t vi_size = Longtail_GetVersionIndexSize(
      asset_total, (uint32_t)chunk_hashes.size(), (uint32_t)asset_chunk_indexes.size(), target_infos.p->m_PathDataSize);
  void* vi_mem = Longtail_Alloc("PullSelectionTarget", vi_size);
  if (!vi_mem) return Fail(handle, ENOMEM, "Out of memory");
  Owned<struct Longtail_VersionIndex> target;
  err = Longtail_BuildVersionIndex(
      vi_mem, vi_size, target_infos.p,
      path_hashes.data(), asset_content_hashes.data(),
      asset_chunk_starts.data(), asset_chunk_counts.data(),
      (uint32_t)asset_chunk_indexes.size(), asset_chunk_indexes.data(),
      (uint32_t)chunk_hashes.size(), chunk_sizes.data(), chunk_hashes.data(), chunk_tags.data(),
      hash_identifier, target_chunk_size, target.out());
  if (err) {
    Longtail_Free(vi_mem);
    return Fail(handle, err, "Failed to build the target version");
  }

  // ── What is on disk at those paths ─────────────────────────────────
  // Only selected paths are looked at, never the rest of the workspace. A
  // file whose size differs from the target's certainly differs, so only
  // same-size files are hashed; the rest are simply overwritten.
  SetHandleStep(handle, "Scanning local files");
  std::vector<std::string> local_paths;
  std::vector<uint64_t> local_sizes;
  std::vector<uint16_t> local_permissions;
  for (uint32_t a = 0; a < asset_total; ++a) {
    std::error_code ec;
    const auto full = std::filesystem::u8path(std::string(LocalRootPath) + "/" + asset_paths[a]);
    if (!std::filesystem::is_regular_file(full, ec) || ec) continue;
    const uint64_t size = (uint64_t)std::filesystem::file_size(full, ec);
    if (ec || size != asset_sizes[a]) continue;
    local_paths.push_back(asset_paths[a]);
    local_sizes.push_back(size);
    // The target's permissions, so a permission difference alone does not
    // rewrite a file whose content already matches.
    local_permissions.push_back(asset_permissions[a]);
  }
  Owned<struct Longtail_FileInfos> local_infos;
  local_infos.p = MakeFileInfos(local_paths, local_sizes, local_permissions);
  if (!local_infos.p) return Fail(handle, ENOMEM, "Out of memory");

  Owned<struct Longtail_VersionIndex> local;
  {
    std::vector<uint32_t> tags(local_paths.size(), 0);
    struct Longtail_ProgressAPI* progress = MakeProgressAPI("Indexing local files", handle);
    if (!progress) return Fail(handle, ENOMEM, "Out of memory");
    err = Longtail_CreateVersionIndex(
        apis.file_storage_api, hash_api, apis.chunker_api, apis.job_api, progress, 0, 0,
        LocalRootPath, local_infos.p, tags.empty() ? nullptr : tags.data(),
        target_chunk_size, EnableMmapIndexing, local.out());
    SAFE_DISPOSE_API(progress);
    if (err) return Fail(handle, err, "Failed to index local files");
  }

  SetHandleStep(handle, "Comparing versions");
  Owned<struct Longtail_VersionDiff> diff;
  err = Longtail_CreateVersionDiff(hash_api, local.p, target.p, diff.out());
  if (err) return Fail(handle, err, "Failed to compare local files with the target");
  // Removals are the caller's to make; nothing outside the selection is
  // touched.
  *diff.p->m_SourceRemovedCount = 0;

  const uint32_t to_write = *diff.p->m_TargetAddedCount + *diff.p->m_ModifiedContentCount;
  if (to_write == 0 && *diff.p->m_ModifiedPermissionsCount == 0) {
    std::stringstream result;
    result << "{\"assets\":" << asset_total << ",\"written\":0,\"sources\":" << Sources.size()
           << ",\"blockMaps\":" << (all_block_maps ? "true" : "false")
           << ",\"indexBytes\":" << index_bytes << ",\"fetchMs\":" << fetchMs << ",\"ms\":" << elapsedMs() << "}";
    strncpy(handle->result, result.str().c_str(), sizeof(handle->result) - 1);
    SetHandleStep(handle, "Completed");
    handle->error = 0;
    handle->settled = 1;
    return 0;
  }

  std::vector<TLongtail_Hash> required(*target.p->m_ChunkCount);
  uint32_t required_count = 0;
  err = Longtail_GetRequiredChunkHashes(target.p, diff.p, &required_count, required.data());
  if (err) return Fail(handle, err, "Failed to get required chunks");

  Owned<struct Longtail_StoreIndex> store_index;
  if (all_block_maps && merged_maps.p) {
    err = Longtail_GetExistingStoreIndex(merged_maps.p, required_count, required.data(), 0, store_index.out());
  } else if (all_block_maps) {
    // Every selected file is empty: there are no blocks to find.
    err = Longtail_CreateStoreIndexFromBlocks(0, 0, store_index.out());
  } else {
    // At least one source predates block maps: ask the repo's store index.
    err = SyncGetExistingContent(apis.block_store, required_count, required.data(), 0, store_index.out());
  }
  if (err) return Fail(handle, err, "Failed to find the blocks to download");

  struct Longtail_ProgressAPI* progress = MakeProgressAPI("Downloading files", handle);
  if (!progress) return Fail(handle, ENOMEM, "Out of memory");
  err = Longtail_ChangeVersion(
      apis.block_store, apis.file_storage_api, hash_api, apis.job_api, progress, 0, 0,
      store_index.p, local.p, target.p, diff.p, LocalRootPath, 1);
  SAFE_DISPOSE_API(progress);
  if (err) return Fail(handle, err, "Failed to update version");

  std::stringstream result;
  result << "{\"assets\":" << asset_total << ",\"written\":" << to_write << ",\"sources\":" << Sources.size()
         << ",\"blockMaps\":" << (all_block_maps ? "true" : "false")
         << ",\"indexBytes\":" << index_bytes << ",\"fetchMs\":" << fetchMs << ",\"ms\":" << elapsedMs() << "}";
  strncpy(handle->result, result.str().c_str(), sizeof(handle->result) - 1);
  handle->result[sizeof(handle->result) - 1] = '\0';
  SetHandleStep(handle, "Completed");
  handle->error = 0;
  handle->settled = 1;
  return 0;
}

DLL_EXPORT WrapperAsyncHandle*
PullSelectionAsync(
    const char* const* Sources,
    uint32_t NumSources,
    const char* const* SelectionPaths,
    const uint32_t* SelectionSources,
    uint32_t NumSelections,
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
    int LogLevel = 4) {
  SetLogging(LogLevel);

  WrapperAsyncHandle* handle = (WrapperAsyncHandle*)Longtail_Alloc(0, sizeof(WrapperAsyncHandle));
  if (!handle) {
    return 0;
  }
  memset(handle, 0, sizeof(WrapperAsyncHandle));
  SetHandleStep(handle, "Initializing");

  // Copied here so the worker does not depend on the caller's arrays.
  std::vector<std::string> sources(Sources, Sources + NumSources);
  std::vector<std::string> paths(SelectionPaths, SelectionPaths + NumSelections);
  std::vector<uint32_t> selection_sources(SelectionSources, SelectionSources + NumSelections);

  std::thread worker([=]() {
    int32_t err = PullSelectionSync(
        sources, paths, selection_sources,
        EnableMmapIndexing, EnableMmapBlockStore, LocalRootPath, RemoteBasePath,
        StorageType, GatewayUrl, JWT, JWTExpirationMs,
        S3Endpoint, S3Region, S3Bucket, S3AccessKeyId, S3SecretAccessKey, S3SessionToken,
        CachePath, handle);
    if (err) {
      std::cerr << "Failed to pull selection, " << err << ": " << handle->currentStep << std::endl;
    }
    // Last touch of the handle: the poller may free it from here on. See
    // wrapper-handle.h.
    handle->completed = 1;
  });
  worker.detach();

  return handle;
}
