// Storage keys are repo-scoped paths like "/{org}/{repo}/chunks/ab12/0x....lrb".
// They arrive in URLs and JWT claims, and they end up as file paths (local
// mode) or object keys (s3, r2), so the same key has to mean the same thing at
// every layer. A key that only looks like it is inside a repo is how one repo
// reads another: "/orgA/repoA/../../orgB/repoB/store.lsi" starts with
// "/orgA/repoA/" and resolves to orgB's store index.
//
// Rather than normalize such a key and guess what was meant, anything that is
// not already in canonical form is refused.

// One path segment: letters, digits, and "._-" only. This is deliberately
// narrower than what a filesystem allows. It rules out "." and ".." (see
// isSafeSegment), separators of either kind, percent signs left over from
// double encoding, NUL and control characters, and the Windows forms that
// alias another file: "name::$DATA" (alternate data streams), "C:" (drive
// relative paths), and trailing dots or spaces, which Windows strips.
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** True for a single path segment that cannot step outside its directory. */
export function isSafeSegment(segment: string): boolean {
  return (
    SEGMENT.test(segment) &&
    segment !== "." &&
    segment !== ".." &&
    !segment.endsWith(".") &&
    segment.length <= 255
  );
}

/**
 * True for a canonical key: a leading slash followed by safe segments
 * separated by single slashes, with no trailing slash.
 */
export function isCanonicalKey(key: string): boolean {
  if (!key.startsWith("/") || key.length > 1024) {
    return false;
  }
  const segments = key.slice(1).split("/");
  return segments.length > 0 && segments.every(isSafeSegment);
}

/**
 * The storage key a request path names, or null if the path is not a
 * canonical key. `rawPath` is the still-encoded URL path.
 */
export function keyFromRequestPath(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return isCanonicalKey(decoded) ? decoded : null;
}

/** True when `key` is `basePath` itself or lies under it. */
export function isUnder(key: string, basePath: string): boolean {
  return key === basePath || key.startsWith(basePath + "/");
}
