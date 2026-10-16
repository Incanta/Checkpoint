#pragma once

#include <longtail.h>

/**
 * A storage API that forwards every call to `inner` (which it takes ownership
 * of) and remembers, for each file opened for writing, its size and mtime the
 * moment the write is closed, plus any permissions applied to it afterwards.
 *
 * The daemon records those as the baseline of each file a pull wrote. Taking
 * them as each file is finished, instead of stat-ing every file when the pull
 * returns, is what keeps an edit made to an early file while a long pull is
 * still running from being recorded as the version the pull wrote (it shows
 * as a local change instead).
 */
struct Longtail_StorageAPI* CreateTrackingStorageAPI(
    struct Longtail_StorageAPI* inner);

/**
 * Writes what `tracking_api` (from CreateTrackingStorageAPI) recorded to
 * `out_path`, one line per file: the path relative to `root` (forward
 * slashes), size, mtime seconds, mtime nanoseconds, and permissions (octal,
 * or "-" when none were applied), separated by tabs. Returns 0 or an errno.
 */
int WriteTrackedFiles(
    struct Longtail_StorageAPI* tracking_api,
    const char* root,
    const char* out_path);

/**
 * WriteTrackedFiles to the workspace's ".checkpoint/pull-written.tsv", where
 * the daemon reads it after each native pull pass. One VCS operation runs in a
 * workspace at a time, so a fixed name is enough.
 */
int WritePullRecord(struct Longtail_StorageAPI* tracking_api, const char* root);
