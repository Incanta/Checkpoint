#pragma once

#include <string>

namespace Checkpoint {

/**
 * Why the native layer must not write or read `path`, a repo-relative asset
 * path from a version index or a submit, or an empty string when it may.
 *
 * Paths come from whoever recorded them. The server refuses unsafe ones now
 * (src/app/src/server/repo-path.ts), and the daemon checks again
 * (src/core/daemon/src/util/workspace-path.ts), but repositories already hold
 * some, and a whole version index is applied as it is, so the pull checks
 * every asset itself. Mirrors the server's always-on rules:
 *
 *   - no empty, ".", or ".." segment, and no leading separator;
 *   - no drive prefix ("C:") and no control characters;
 *   - no first segment that names the workspace's .checkpoint directory in
 *     any spelling a filesystem folds onto it (ASCII case, trailing dots and
 *     spaces, an NTFS stream suffix, or the 8.3 short name CHECKP~N);
 *   - on Windows, no ":", which NTFS reads as a stream separator.
 *
 * A trailing "/" (how Longtail marks a directory entry) is ignored.
 */
std::string UnsafeAssetPathReason(const char* path);

}  // namespace Checkpoint
