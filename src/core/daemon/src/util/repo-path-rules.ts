// What a repo path may look like. A mirror of the app's
// src/app/src/server/repo-path.ts (the app does not depend on
// @checkpointvcs/common, and the daemon does not import the app's server
// code); src/tests/src/daemon/workspace-path.test.ts checks that the two copies
// answer the same for every test vector. Keep them in step.

/** Longest path accepted, in bytes of UTF-8. */
export const MAX_PATH_BYTES = 1024;

/** Longest name accepted by ext4, XFS, Btrfs, and APFS, in bytes of UTF-8. */
export const MAX_SEGMENT_BYTES = 255;

const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE =
  /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const DRIVE = /^[A-Za-z]:/;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const DEVICE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|(COM|LPT)[0-9¹²³])$/i;
// An 8.3 short name: up to six characters, "~", digits, and an optional
// extension of up to three. On volumes that keep short names, such a name can
// be another spelling of a different file.
const SHORT_NAME = /^[^~.]{1,6}~[0-9]+(\.[^.]{0,3})?$/;
// Code points HFS+ ignores when it compares names (as git's is_hfs_dotgit).
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

const utf8Length = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Whether a first path segment names the workspace's `.checkpoint` directory
 * on some filesystem: another case (Windows, macOS), trailing dots or spaces
 * (Win32), an NTFS stream suffix (`.checkpoint::$INDEX_ALLOCATION`), code
 * points HFS+ ignores, or its 8.3 short name (`CHECKP~1`).
 */
export function namesCheckpointDir(segment: string): boolean {
  let name = segment.replace(HFS_IGNORABLE, "");
  const colon = name.indexOf(":");
  if (colon >= 0) name = name.slice(0, colon);
  name = name.replace(/[. ]+$/, "").toLowerCase();
  return name === ".checkpoint" || /^checkp~[0-9]+$/.test(name);
}

/** Why a segment cannot be stored on every OS, or null. */
function portabilityProblem(segment: string): string | null {
  if (utf8Length(segment) > MAX_SEGMENT_BYTES) {
    return `a name longer than ${MAX_SEGMENT_BYTES} bytes`;
  }
  if (WINDOWS_FORBIDDEN.test(segment)) {
    return 'a character Windows does not allow in names (< > : " | ? *)';
  }
  if (/[. ]$/.test(segment)) {
    return "a name that ends in a dot or a space";
  }
  const base = segment.split(".")[0]!.replace(/ +$/, "");
  if (DEVICE.test(base)) {
    return "a name Windows reserves for a device";
  }
  if (SHORT_NAME.test(segment)) {
    return "a name in the form of a Windows 8.3 short name";
  }
  return null;
}

/**
 * Why `path` breaks the rules every repo enforces, or null when it does not.
 * The path must already have its backslashes converted.
 */
export function canonicalPathProblem(path: string): string | null {
  if (path.length === 0) return "an empty path";
  if (path.startsWith("/")) return "a leading slash";
  if (path.endsWith("/")) return "a trailing slash";
  if (CONTROL.test(path)) return "a control character";
  if (LONE_SURROGATE.test(path)) return "a broken UTF-16 surrogate";
  if (utf8Length(path) > MAX_PATH_BYTES) {
    return `more than ${MAX_PATH_BYTES} bytes`;
  }
  if (DRIVE.test(path)) return "a drive letter";
  const segments = path.split("/");
  for (const segment of segments) {
    if (segment === "") return "an empty segment (//)";
    if (segment === "." || segment === "..") return `a "${segment}" segment`;
  }
  if (namesCheckpointDir(segments[0]!)) {
    return "the workspace's .checkpoint directory";
  }
  return null;
}

/**
 * Why `path` cannot be stored on every OS, or null. Only meaningful for a path
 * that passes canonicalPathProblem.
 */
export function portablePathProblem(path: string): string | null {
  for (const segment of path.split("/")) {
    const problem = portabilityProblem(segment);
    if (problem) return problem;
  }
  return null;
}

/** Backslashes to slashes, as every client's separator is accepted. */
export function toRepoPath(path: string): string {
  return path.replaceAll("\\", "/");
}
