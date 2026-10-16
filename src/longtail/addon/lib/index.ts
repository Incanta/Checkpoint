// TypeScript bindings for the longtail-addon N-API module.
// Drop-in replacement for the Bun FFI-based longtail.ts utilities.

import * as path from "path";
import * as os from "os";

// --------------------------------------------------------------------------
// Native addon loader — tries prebuilt binaries first (npm package),
// then falls back to local build output (development).
// --------------------------------------------------------------------------

function loadNativeAddon(): LongtailAddonNative {
  const platform = os.platform();
  const arch = os.arch();
  const addonName = "longtail_addon.node";

  // When bundled into the daemon (esbuild) and run by the portable Node.js
  // runtime, this file's __dirname points at the bundle, not the addon
  // package. The native addon is shipped alongside the runtime instead, so we
  // also search relative to process.execPath. See scripts/build-daemon.* for
  // the installed layout (checkpoint-daemon.exe + lib/longtail_addon.node).
  const execDir = path.dirname(process.execPath);

  const candidates = [
    // Explicit override, if the host sets one.
    process.env.CHECKPOINT_LONGTAIL_ADDON_PATH,
    // Dev / npm-package layout (relative to this module).
    path.join(
      __dirname,
      "..",
      "prebuilds",
      `${platform}-${arch}`,
      addonName,
    ),
    path.join(__dirname, "..", "build", addonName),
    // Portable-daemon layout (relative to the runtime executable).
    path.join(execDir, "lib", addonName),
    path.join(execDir, addonName),
    path.join(execDir, "prebuilds", `${platform}-${arch}`, addonName),
  ].filter((c): c is string => Boolean(c));

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require(candidate);
    } catch {
      continue;
    }
  }

  throw new Error(
    `@checkpointvcs/longtail-addon: No native binary found for ${platform}-${arch}. ` +
      `Ensure the package includes prebuilds for your platform, or build from source. ` +
      `Searched: ${candidates.join(", ")}`,
  );
}

const addon: LongtailAddonNative = loadNativeAddon();

// --------------------------------------------------------------------------
// Native addon interface (what the C++ module exports)
// --------------------------------------------------------------------------

interface HandleStatus {
  currentStep: string;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
  progressTotal: number;
  progressDone: number;
  needsTokenRefresh: boolean;
}

/** Opaque native handle — do not inspect directly */
type NativeHandle = object;

interface LongtailAddonNative {
  submitAsync(options: SubmitAsyncOptions): NativeHandle;
  pullAsync(options: PullAsyncOptions): NativeHandle;
  pullSelectionAsync(options: PullSelectionAsyncOptions): NativeHandle;
  filterPaths(includeRules: string[], paths: string[]): boolean[];
  indexCacheCreate(): IndexCacheHandle;
  indexCacheAdd(cache: IndexCacheHandle, storeIndex: Buffer): IndexCacheAddResult;
  indexCacheQuery(cache: IndexCacheHandle, chunkHashes: Buffer, minBlockUsagePercent: number): Buffer;
  indexCacheSerialize(cache: IndexCacheHandle): Buffer;
  indexCacheStats(cache: IndexCacheHandle): { blocks: number; chunks: number };
  getExistingStoreIndex(storeIndex: Buffer, chunkHashes: Buffer, minBlockUsagePercent: number): Buffer;
  versionIndexChunkHashes(versionIndex: Buffer): Buffer;
  storeBlockMapAsync(options: StoreBlockMapAsyncOptions): NativeHandle;
  readFileFromVersionAsync(
    options: ReadFileFromVersionAsyncOptions,
  ): NativeHandle;

  getHandleStatus(handle: NativeHandle): HandleStatus;
  getHandleResult(handle: NativeHandle): any;
  cancelHandle(handle: NativeHandle): void;
  setRefreshedToken(handle: NativeHandle, options: RefreshedTokenOptions): void;
  freeHandle(handle: NativeHandle): void;

  getReadFileData(handle: NativeHandle): Buffer;
  getReadFileSize(handle: NativeHandle): number;
  freeReadFileHandle(handle: NativeHandle): void;
}

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export type LongtailLogLevel = "debug" | "info" | "warn" | "error" | "off";

export interface Modification {
  delete: boolean;
  path: string;
  oldPath?: string;
  /**
   * The changelist the submitter's copy of this file came from, or null if the
   * file is new to the branch. The server refuses the submit when the branch
   * head holds a different version, so a change the submitter never saw cannot
   * be silently replaced. Leave it out and the path is not checked.
   */
  baseChangelist?: number | null;
  /**
   * The mode to record for the file (0o644, 0o755, ...). Leave it out to read
   * it from the file, which is right on Linux and macOS; on Windows, which has
   * no executable bit, pass the mode the file has at the head so an edit made
   * there never strips +x. Ignored for deletes.
   */
  mode?: number;
  /**
   * The caller always sends a base for files it tracks, so the server treats
   * a missing base on a path the branch has as a conflict.
   */
  requireBase?: boolean;
}

// Storage backend selection shared by the async operations. See STORAGE.md.
//   gateway - the Checkpoint core-server gateway (storage.mode local / s3);
//             the client streams blobs over HTTP with a Bearer JWT.
//   s3      - direct S3-compatible access (R2 for clients; any S3 for the
//             server-side store-index merge).
//   local   - the server's own disk (store-index merge only).
export interface StorageOptions {
  storageType: "gateway" | "s3" | "local";
  // gateway
  gatewayUrl?: string;
  jwt?: string; // gateway Bearer token (also the control-plane token)
  jwtExpirationMs?: number;
  // s3 (and r2, which is just s3 with R2's endpoint/region)
  s3Endpoint?: string;
  s3Region?: string;
  s3Bucket?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3SessionToken?: string;
  s3ForcePathStyle?: boolean;
  // local (merge only)
  localStoragePath?: string;
}

export interface SubmitAsyncOptions extends StorageOptions {
  branchName: string;
  shelfName?: string;
  artifactForChangelistNum?: number;
  message: string;
  targetChunkSize: number;
  targetBlockSize: number;
  maxChunksPerBlock: number;
  minBlockUsagePercent: number;
  hashingAlgo: string;
  compressionAlgo: string;
  enableMmapIndexing: boolean;
  enableMmapBlockStore: boolean;
  localRootPath: string;
  remoteBasePath: string;
  backendUrl: string; // core-server control plane (/submit)
  apiJwt: string;
  keepCheckedOut: boolean;
  workspaceId: string;
  modifications: Modification[];
  logLevel: number;
}

export interface PullAsyncOptions extends StorageOptions {
  versionIndex: string;
  enableMmapIndexing: boolean;
  enableMmapBlockStore: boolean;
  localRootPath: string;
  remoteBasePath: string;
  logLevel: number;
  cachePath?: string;
  /**
   * Optional gitignore-style include rules applied to repo-relative,
   * forward-slash asset paths. When present and non-empty, only assets whose
   * path matches at least one rule are pulled; every other asset in the target
   * version is dropped from the version diff, so its blocks are never
   * downloaded and no file is written. When absent or empty, the whole version
   * is pulled, exactly as before.
   *
   * Supported syntax (see wrapper/src/util/path-filter.h for the matcher):
   * a leading "/" anchors a rule to the repo root, as does any other embedded
   * "/"; a rule with no separator other than a trailing one ("Engine/",
   * "*.uasset") matches at any depth; a rule that matches a directory pulls in
   * that directory's whole subtree; "*" matches within one segment, "**"
   * across segments, and "?" matches one non-separator character.
   *
   * NOT supported: "!" negation and "[...]" character classes. Callers must
   * withhold rules that use them rather than passing them through. Because a
   * caller that filters again after the pull can only lose work, not
   * correctness, erring toward broader rules here is always the safe choice.
   */
  includePaths?: string[];
}

/**
 * Bring the given paths to the content each has in its own source version
 * index, in one pass, finding blocks through each source's block map. Only
 * the selected paths are scanned and written; deletions are the caller's.
 * The handle result is `{ assets, written, sources, blockMaps, indexBytes,
 * fetchMs, ms }`. Fails with ENOTSUP (95 on Linux, 129 on Windows) when the
 * sources were hashed or chunked differently; apply them one by one then.
 */
export interface PullSelectionAsyncOptions extends StorageOptions {
  /** Version index file names; selections refer to them by position. */
  sources: string[];
  selectionPaths: string[];
  /** For each selection path, the index into `sources` that holds it. */
  selectionSources: number[];
  enableMmapIndexing: boolean;
  enableMmapBlockStore: boolean;
  localRootPath: string;
  remoteBasePath: string;
  cachePath?: string;
  logLevel: number;
}

/**
 * Server side: verify a submit's block map against its version index (every
 * chunk covered, every named block stored) and store it beside the index as
 * versions/<name>.lsi, unless one is there already. The handle result is
 * `{ written: boolean, blocks: number }`.
 */
export interface StoreBlockMapAsyncOptions extends StorageOptions {
  remoteBasePath: string;
  /** The version index's file name, e.g. "<sha256>.lvi". */
  versionIndex: string;
  blockMapBuffer: Buffer;
  logLevel: number;
}

export interface ReadFileFromVersionAsyncOptions extends StorageOptions {
  filePath: string;
  versionIndexName: string;
  remoteBasePath: string;
  logLevel: number;
}

export { HandleStatus, NativeHandle };

// --------------------------------------------------------------------------
// Token refresh types
// --------------------------------------------------------------------------

export interface RefreshedTokenOptions {
  jwt?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3SessionToken?: string;
  expirationMs: number;
}

export interface TokenRefreshResult {
  jwt?: string;
  jwtExpirationMs: number;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3SessionToken?: string;
}

// --------------------------------------------------------------------------
// Utility functions (matching the old longtail.ts API)
// --------------------------------------------------------------------------

export function GetLogLevel(value: LongtailLogLevel): number {
  switch (value.toLowerCase().trim()) {
    case "debug":
      return 0;
    case "info":
      return 1;
    case "warn":
    case "warning":
      return 2;
    case "error":
      return 3;
    case "off":
    default:
      return 4;
  }
}

// --------------------------------------------------------------------------
// Async operation wrappers
// --------------------------------------------------------------------------

export function submitAsync(options: SubmitAsyncOptions): NativeHandle {
  return addon.submitAsync(options);
}

export function pullAsync(options: PullAsyncOptions): NativeHandle {
  return addon.pullAsync(options);
}

export function pullSelectionAsync(
  options: PullSelectionAsyncOptions,
): NativeHandle {
  return addon.pullSelectionAsync(options);
}

/**
 * Whether each path passes the gitignore-style include rules, by the matcher
 * the native pull uses. No rules includes everything.
 */
export function filterPaths(includeRules: string[], paths: string[]): boolean[] {
  return addon.filterPaths(includeRules, paths);
}

/** Opaque handle to a native in-memory dedup index (see index-cache.cpp). */
export type IndexCacheHandle = object & { readonly __indexCache: unique symbol };

export interface IndexCacheAddResult {
  blocksAdded: number;
  chunksAdded: number;
}

/**
 * A new, empty dedup index. Fed serialized store indexes (segments, bases)
 * with indexCacheAdd; answers what Longtail_GetExistingStoreIndex over all of
 * them would, while reading only the blocks holding requested chunks. Freed
 * when garbage collected.
 */
export function indexCacheCreate(): IndexCacheHandle {
  return addon.indexCacheCreate();
}

/** Adds the blocks of a serialized store index that the cache lacks. */
export function indexCacheAdd(cache: IndexCacheHandle, storeIndex: Buffer): IndexCacheAddResult {
  return addon.indexCacheAdd(cache, storeIndex);
}

/**
 * The blocks to reuse for `chunkHashes` (little-endian u64s), as a serialized
 * store index.
 */
export function indexCacheQuery(
  cache: IndexCacheHandle,
  chunkHashes: Buffer,
  minBlockUsagePercent: number,
): Buffer {
  return addon.indexCacheQuery(cache, chunkHashes, minBlockUsagePercent);
}

/** The whole index as one serialized store index. */
export function indexCacheSerialize(cache: IndexCacheHandle): Buffer {
  return addon.indexCacheSerialize(cache);
}

export function indexCacheStats(cache: IndexCacheHandle): { blocks: number; chunks: number } {
  return addon.indexCacheStats(cache);
}

/** Longtail_GetExistingStoreIndex over a whole serialized store index. */
export function getExistingStoreIndex(
  storeIndex: Buffer,
  chunkHashes: Buffer,
  minBlockUsagePercent: number,
): Buffer {
  return addon.getExistingStoreIndex(storeIndex, chunkHashes, minBlockUsagePercent);
}

/** The chunk hashes of a serialized version index (little-endian u64s). */
export function versionIndexChunkHashes(versionIndex: Buffer): Buffer {
  return addon.versionIndexChunkHashes(versionIndex);
}

export function storeBlockMapAsync(
  options: StoreBlockMapAsyncOptions,
): NativeHandle {
  return addon.storeBlockMapAsync(options);
}

export function readFileFromVersionAsync(
  options: ReadFileFromVersionAsyncOptions,
): NativeHandle {
  return addon.readFileFromVersionAsync(options);
}

// --------------------------------------------------------------------------
// Handle operations
// --------------------------------------------------------------------------

export function getHandleStatus(handle: NativeHandle): HandleStatus {
  return addon.getHandleStatus(handle);
}

export function getHandleResult(handle: NativeHandle): any {
  return addon.getHandleResult(handle);
}

export function cancelHandle(handle: NativeHandle): void {
  addon.cancelHandle(handle);
}

export function freeHandle(handle: NativeHandle): void {
  addon.freeHandle(handle);
}

export function setRefreshedToken(
  handle: NativeHandle,
  options: RefreshedTokenOptions,
): void {
  addon.setRefreshedToken(handle, options);
}

export function getReadFileData(handle: NativeHandle): Buffer {
  return addon.getReadFileData(handle);
}

export function getReadFileSize(handle: NativeHandle): number {
  return addon.getReadFileSize(handle);
}

export function freeReadFileHandle(handle: NativeHandle): void {
  addon.freeReadFileHandle(handle);
}

// --------------------------------------------------------------------------
// High-level polling helper
// --------------------------------------------------------------------------

export interface PollOptions {
  /** Polling interval in milliseconds (default: 10) */
  intervalMs?: number;
  /** Callback invoked on each step change */
  onStep?: (step: string) => void;
  /** Callback invoked when progress changes within a step */
  onProgress?: (step: string, done: number, total: number) => void;
  /** Callback invoked when C++ requests a token refresh (credentials near expiry) */
  onTokenRefresh?: () => Promise<TokenRefreshResult>;
}

/**
 * Polls an async handle until completion. Returns the final status and
 * optionally the parsed result.
 *
 * Usage:
 * ```ts
 * const handle = submitAsync({ ... });
 * const { status, result } = await pollHandle(handle, {
 *   onStep: (step) => console.log("Step:", step),
 * });
 * freeHandle(handle);
 * ```
 */
export async function pollHandle(
  handle: NativeHandle,
  options: PollOptions = {},
): Promise<{ status: HandleStatus; result: any }> {
  const intervalMs = options.intervalMs ?? 10;
  let lastStep = "";
  let lastDone = 0;

  while (true) {
    const status = getHandleStatus(handle);

    if (status.currentStep !== lastStep) {
      lastStep = status.currentStep;
      lastDone = 0;
      if (options.onStep) {
        options.onStep(status.currentStep);
      }
    }

    if (
      options.onProgress &&
      status.progressTotal > 0 &&
      status.progressDone !== lastDone
    ) {
      lastDone = status.progressDone;
      options.onProgress(
        status.currentStep,
        status.progressDone,
        status.progressTotal,
      );
    }

    // C++ is requesting a token refresh — fetch new credentials and write them back
    if (status.needsTokenRefresh && options.onTokenRefresh) {
      try {
        const refreshed = await options.onTokenRefresh();
        setRefreshedToken(handle, {
          jwt: refreshed.jwt,
          s3AccessKeyId: refreshed.s3AccessKeyId,
          s3SecretAccessKey: refreshed.s3SecretAccessKey,
          s3SessionToken: refreshed.s3SessionToken,
          expirationMs: refreshed.jwtExpirationMs,
        });
      } catch (err) {
        console.error("[pollHandle] Token refresh failed:", err);
        // Let C++ time out — it will return ETIMEDOUT
      }
    }

    if (status.completed) {
      const result = getHandleResult(handle);
      return { status, result };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Polls a read-file handle until completion. Returns the file data as a Buffer.
 *
 * Usage:
 * ```ts
 * const handle = readFileFromVersionAsync({ ... });
 * const { data, size } = await pollReadFileHandle(handle);
 * freeReadFileHandle(handle);
 * ```
 */
export async function pollReadFileHandle(
  handle: NativeHandle,
  options: PollOptions = {},
): Promise<{ data: Buffer; size: number }> {
  const intervalMs = options.intervalMs ?? 10;
  let lastStep = "";

  while (true) {
    const status = getHandleStatus(handle);

    if (status.currentStep !== lastStep) {
      lastStep = status.currentStep;
      if (options.onStep) {
        options.onStep(status.currentStep);
      }
    }

    if (status.completed) {
      if (status.error !== 0) {
        throw new Error(
          `ReadFileFromVersion failed: ${status.currentStep} (error: ${status.error})`,
        );
      }

      const data = getReadFileData(handle);
      const size = getReadFileSize(handle);
      return { data, size };
    }

    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
