#pragma once

#include <string>

#include <longtail.h>
#include <longtail_platform.h>

// Checks that stored data a server is about to vouch for is really there:
// before a store index or a block map is written, every block it names must
// exist in the store.

namespace verify_blocks {

/**
 * Where FSBlockStore keeps a block, relative to the store root:
 * chunks/<first 4 hex digits>/0x<16 hex digits>.lrb. This has to match
 * GetBlockPath in longtail_fsblockstore.c (which is static, hence the copy).
 */
std::string BlockPath(const std::string& basePath, TLongtail_Hash block_hash);

/**
 * Checks that every block in `store_index` exists under `basePath`. Returns 0
 * if they all do, otherwise ENOENT with one missing path in `out_missing_path`.
 *
 * A block that cannot be confirmed counts as missing. On object storage IsFile
 * is a HEAD that also reads a timeout or a 5xx as "no", so a "no" there is
 * asked again before it is believed.
 */
int VerifyBlocksExist(
    struct Longtail_StorageAPI* storage_api,
    const std::string& basePath,
    const struct Longtail_StoreIndex* store_index,
    std::string* out_missing_path);

/**
 * Replaces `target` with `source` in one step on a local filesystem: anything
 * reading `target` gets the old file or the new one, whole. The data is
 * flushed before the rename.
 */
int ReplaceFileAtomically(const std::string& source, const std::string& target);

}  // namespace verify_blocks
