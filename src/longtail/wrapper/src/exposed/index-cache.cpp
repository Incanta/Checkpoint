#include <algorithm>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "main.h"

// In-memory dedup index for one repo, held by the core server.
//
// A submit asks which of its chunks the store already has, so it uploads only
// the rest. The answer used to come from the repo-wide store.lsi, downloaded
// whole by every submitting client and rewritten whole by the server on every
// submit. The server now keeps the index in memory, built from immutable
// segments (one per submit), and answers per request.
//
// The answer is exactly Longtail_GetExistingStoreIndex over the full index,
// but computed over only the blocks that hold a requested chunk: that
// function skips blocks with no requested chunk, and ranks the rest by usage
// in their original relative order, so a store index of just those blocks, in
// the same order, yields the same blocks.

struct IndexCache {
  uint32_t hash_identifier = 0;
  // Blocks in insertion order; a block's chunks are a slice of the chunk
  // arrays.
  std::vector<TLongtail_Hash> block_hashes;
  std::vector<uint32_t> block_tags;
  std::vector<uint32_t> block_chunk_offsets;
  std::vector<uint32_t> block_chunk_counts;
  std::vector<TLongtail_Hash> chunk_hashes;
  std::vector<uint32_t> chunk_sizes;
  std::unordered_set<TLongtail_Hash> known_blocks;
  // Chunk -> the blocks holding it (a chunk can be in several).
  std::unordered_map<TLongtail_Hash, std::vector<uint32_t>> chunk_blocks;
};

namespace {

/** A Longtail_StoreIndex over the given blocks of the cache, in that order. */
int BuildStoreIndex(
    const IndexCache* cache,
    const std::vector<uint32_t>& blocks,
    struct Longtail_StoreIndex** out) {
  std::vector<struct Longtail_BlockIndex> headers(blocks.size());
  std::vector<const struct Longtail_BlockIndex*> header_ptrs(blocks.size());
  for (size_t i = 0; i < blocks.size(); ++i) {
    const uint32_t b = blocks[i];
    const uint32_t offset = cache->block_chunk_offsets[b];
    headers[i].m_BlockHash = const_cast<TLongtail_Hash*>(&cache->block_hashes[b]);
    headers[i].m_HashIdentifier = const_cast<uint32_t*>(&cache->hash_identifier);
    headers[i].m_ChunkCount = const_cast<uint32_t*>(&cache->block_chunk_counts[b]);
    headers[i].m_Tag = const_cast<uint32_t*>(&cache->block_tags[b]);
    headers[i].m_ChunkHashes = const_cast<TLongtail_Hash*>(cache->chunk_hashes.data() + offset);
    headers[i].m_ChunkSizes = const_cast<uint32_t*>(cache->chunk_sizes.data() + offset);
    header_ptrs[i] = &headers[i];
  }
  return Longtail_CreateStoreIndexFromBlocks(
      (uint32_t)blocks.size(), header_ptrs.empty() ? nullptr : header_ptrs.data(), out);
}

int WriteToBuffer(const struct Longtail_StoreIndex* index, void** out_buffer, size_t* out_size) {
  return Longtail_WriteStoreIndexToBuffer(index, out_buffer, out_size);
}

}  // namespace

DLL_EXPORT IndexCache* IndexCache_Create() {
  return new IndexCache();
}

DLL_EXPORT void IndexCache_Free(IndexCache* cache) {
  delete cache;
}

/**
 * Adds the blocks of a serialized store index (a segment or a base) that the
 * cache does not have yet. Returns 0, or an errno on unreadable input or a
 * hashing algorithm that does not match what the cache holds.
 */
DLL_EXPORT int IndexCache_Add(
    IndexCache* cache,
    const void* buffer,
    size_t size,
    uint32_t* out_blocks_added,
    uint32_t* out_chunks_added) {
  *out_blocks_added = 0;
  *out_chunks_added = 0;
  struct Longtail_StoreIndex* index = nullptr;
  int err = Longtail_ReadStoreIndexFromBuffer(buffer, size, &index);
  if (err) return err;
  const uint32_t block_count = *index->m_BlockCount;
  if (block_count > 0) {
    const uint32_t hash_id = *index->m_HashIdentifier;
    if (cache->hash_identifier == 0) {
      cache->hash_identifier = hash_id;
    } else if (hash_id != cache->hash_identifier) {
      Longtail_Free(index);
      return EINVAL;
    }
  }
  for (uint32_t b = 0; b < block_count; ++b) {
    const TLongtail_Hash block_hash = index->m_BlockHashes[b];
    if (!cache->known_blocks.insert(block_hash).second) continue;
    const uint32_t block_index = (uint32_t)cache->block_hashes.size();
    const uint32_t first = index->m_BlockChunksOffsets[b];
    const uint32_t count = index->m_BlockChunkCounts[b];
    cache->block_hashes.push_back(block_hash);
    cache->block_tags.push_back(index->m_BlockTags[b]);
    cache->block_chunk_offsets.push_back((uint32_t)cache->chunk_hashes.size());
    cache->block_chunk_counts.push_back(count);
    for (uint32_t c = 0; c < count; ++c) {
      const TLongtail_Hash chunk = index->m_ChunkHashes[first + c];
      cache->chunk_hashes.push_back(chunk);
      cache->chunk_sizes.push_back(index->m_ChunkSizes[first + c]);
      auto& holders = cache->chunk_blocks[chunk];
      if (holders.empty() || holders.back() != block_index) holders.push_back(block_index);
    }
    ++*out_blocks_added;
    *out_chunks_added += count;
  }
  Longtail_Free(index);
  return 0;
}

/**
 * The existing-content answer for `chunks`: a serialized store index of the
 * blocks a submit should reuse, exactly what Longtail_GetExistingStoreIndex
 * over the whole index would return. Free the buffer with Wrapper_FreeBuffer.
 */
DLL_EXPORT int IndexCache_Query(
    IndexCache* cache,
    const TLongtail_Hash* chunks,
    uint32_t chunk_count,
    uint32_t min_block_usage_percent,
    void** out_buffer,
    size_t* out_size) {
  std::vector<uint32_t> candidates;
  {
    std::unordered_set<uint32_t> seen;
    for (uint32_t i = 0; i < chunk_count; ++i) {
      auto it = cache->chunk_blocks.find(chunks[i]);
      if (it == cache->chunk_blocks.end()) continue;
      for (uint32_t b : it->second) {
        if (seen.insert(b).second) candidates.push_back(b);
      }
    }
  }
  // Insertion order, as in the full index.
  std::sort(candidates.begin(), candidates.end());

  struct Longtail_StoreIndex* subset = nullptr;
  int err = BuildStoreIndex(cache, candidates, &subset);
  if (err) return err;
  struct Longtail_StoreIndex* existing = nullptr;
  err = Longtail_GetExistingStoreIndex(subset, chunk_count, chunks, min_block_usage_percent, &existing);
  Longtail_Free(subset);
  if (err) return err;
  err = WriteToBuffer(existing, out_buffer, out_size);
  Longtail_Free(existing);
  return err;
}

/** The whole cache as one serialized store index (for compaction). */
DLL_EXPORT int IndexCache_Serialize(IndexCache* cache, void** out_buffer, size_t* out_size) {
  std::vector<uint32_t> all(cache->block_hashes.size());
  for (uint32_t b = 0; b < all.size(); ++b) all[b] = b;
  struct Longtail_StoreIndex* index = nullptr;
  int err = BuildStoreIndex(cache, all, &index);
  if (err) return err;
  err = WriteToBuffer(index, out_buffer, out_size);
  Longtail_Free(index);
  return err;
}

DLL_EXPORT void IndexCache_Stats(IndexCache* cache, uint32_t* out_blocks, uint32_t* out_chunks) {
  *out_blocks = (uint32_t)cache->block_hashes.size();
  *out_chunks = (uint32_t)cache->chunk_hashes.size();
}

/**
 * Reference answer: Longtail_GetExistingStoreIndex over a whole serialized
 * store index. For tests that hold IndexCache_Query to it.
 */
DLL_EXPORT int Wrapper_GetExistingStoreIndex(
    const void* store_index_buffer,
    size_t store_index_size,
    const TLongtail_Hash* chunks,
    uint32_t chunk_count,
    uint32_t min_block_usage_percent,
    void** out_buffer,
    size_t* out_size) {
  struct Longtail_StoreIndex* index = nullptr;
  int err = Longtail_ReadStoreIndexFromBuffer(store_index_buffer, store_index_size, &index);
  if (err) return err;
  struct Longtail_StoreIndex* existing = nullptr;
  err = Longtail_GetExistingStoreIndex(index, chunk_count, chunks, min_block_usage_percent, &existing);
  Longtail_Free(index);
  if (err) return err;
  err = WriteToBuffer(existing, out_buffer, out_size);
  Longtail_Free(existing);
  return err;
}

DLL_EXPORT void Wrapper_FreeBuffer(void* buffer) {
  if (buffer) Longtail_Free(buffer);
}

/**
 * The chunk hashes of a serialized version index, for building a block map
 * for a version submitted before block maps existed. Free the buffer with
 * Wrapper_FreeBuffer.
 */
DLL_EXPORT int Wrapper_VersionIndexChunkHashes(
    const void* version_index_buffer,
    size_t version_index_size,
    void** out_buffer,
    size_t* out_size) {
  struct Longtail_VersionIndex* vi = nullptr;
  int err = Longtail_ReadVersionIndexFromBuffer(version_index_buffer, version_index_size, &vi);
  if (err) return err;
  const uint32_t count = *vi->m_ChunkCount;
  void* out = Longtail_Alloc("VersionIndexChunkHashes", count == 0 ? 1 : (size_t)count * sizeof(TLongtail_Hash));
  if (!out) {
    Longtail_Free(vi);
    return ENOMEM;
  }
  if (count) memcpy(out, vi->m_ChunkHashes, (size_t)count * sizeof(TLongtail_Hash));
  Longtail_Free(vi);
  *out_buffer = out;
  *out_size = (size_t)count * sizeof(TLongtail_Hash);
  return 0;
}
