#pragma once

#include <longtail.h>

#include <cstdint>
#include <string>
#include <unordered_map>

/**
 * A storage API that forwards every call to `inner` (which it takes ownership
 * of) and remembers, for each file opened for writing, its size and mtime the
 * moment the write is closed, plus any permissions applied to it afterwards.
 * It also hashes (MD5) the bytes as they are written, when the writes cover
 * the file in order from offset 0 to its final size; any other pattern (a
 * gap, a rewrite, a failed write, or a second handle open for writing the
 * same path) leaves the hash unknown.
 *
 * The daemon records those as the baseline of each file a pull wrote. Taking
 * them as each file is finished, instead of stat-ing every file when the pull
 * returns, is what keeps an edit made to an early file while a long pull is
 * still running from being recorded as the version the pull wrote (it shows
 * as a local change instead). The hash is the content those stats describe,
 * so the daemon needs no read of its own to check a file whose mtime is too
 * close to the pull's end to trust (a same-size edit made in the same
 * timestamp tick as the native write shows as a change).
 */
struct Longtail_StorageAPI* CreateTrackingStorageAPI(
    struct Longtail_StorageAPI* inner);

/**
 * Writes what `tracking_api` (from CreateTrackingStorageAPI) recorded to
 * `out_path`, one line per file: the path relative to `root` (forward
 * slashes), size, mtime seconds, mtime nanoseconds, permissions (octal, or
 * "-" when none were applied), and the MD5 of the content as 32 lowercase hex
 * digits (or "-" when unknown), separated by tabs. Readers must accept lines
 * without the last column (addons before it). Returns 0 or an errno.
 *
 * With `complete_sizes` (relative path to the size the file should end up),
 * only files known to be written whole are listed: a hash (so the writes
 * covered the file in order) and the expected size. A pass that failed
 * partway uses it, since a file it was writing when it stopped can be cut
 * short.
 */
int WriteTrackedFiles(
    struct Longtail_StorageAPI* tracking_api,
    const char* root,
    const char* out_path,
    const std::unordered_map<std::string, uint64_t>* complete_sizes = nullptr);

/**
 * WriteTrackedFiles to the workspace's ".checkpoint/pull-written.tsv", where
 * the daemon reads it after each native pull pass. One VCS operation runs in a
 * workspace at a time, so a fixed name is enough.
 */
int WritePullRecord(
    struct Longtail_StorageAPI* tracking_api,
    const char* root,
    const std::unordered_map<std::string, uint64_t>* complete_sizes = nullptr);
