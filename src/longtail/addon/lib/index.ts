// TypeScript bindings for the longtail-addon N-API module.
// Drop-in replacement for the Bun FFI-based longtail.ts utilities.

// The native addon — resolved at runtime from the build output
// eslint-disable-next-line @typescript-eslint/no-var-requires
const addon: LongtailAddonNative = require("../build/longtail_addon.node");

// --------------------------------------------------------------------------
// Native addon interface (what the C++ module exports)
// --------------------------------------------------------------------------

interface HandleStatus {
  currentStep: string;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
}

/** Opaque native handle — do not inspect directly */
type NativeHandle = object;

interface LongtailAddonNative {
  submitAsync(options: SubmitAsyncOptions): NativeHandle;
  pullAsync(options: PullAsyncOptions): NativeHandle;
  mergeAsync(options: MergeAsyncOptions): NativeHandle;
  readFileFromVersionAsync(
    options: ReadFileFromVersionAsyncOptions,
  ): NativeHandle;

  getHandleStatus(handle: NativeHandle): HandleStatus;
  getHandleResult(handle: NativeHandle): any;
  cancelHandle(handle: NativeHandle): void;
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
}

export interface SubmitAsyncOptions {
  branchName: string;
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
  filerUrl: string;
  backendUrl: string;
  jwt: string;
  jwtExpirationMs: number;
  apiJwt: string;
  keepCheckedOut: boolean;
  workspaceId: string;
  modifications: Modification[];
  logLevel: number;
}

export interface PullAsyncOptions {
  versionIndex: string;
  enableMmapIndexing: boolean;
  enableMmapBlockStore: boolean;
  localRootPath: string;
  remoteBasePath: string;
  filerUrl: string;
  jwt: string;
  jwtExpirationMs: number;
  logLevel: number;
}

export interface MergeAsyncOptions {
  remoteBasePath: string;
  filerUrl: string;
  jwt: string;
  storeIndexBuffer: Buffer;
  logLevel: number;
}

export interface ReadFileFromVersionAsyncOptions {
  filePath: string;
  versionIndexName: string;
  remoteBasePath: string;
  filerUrl: string;
  jwt: string;
  jwtExpirationMs: number;
  logLevel: number;
}

export { HandleStatus, NativeHandle };

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

export function mergeAsync(options: MergeAsyncOptions): NativeHandle {
  return addon.mergeAsync(options);
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

  while (true) {
    const status = getHandleStatus(handle);

    if (status.currentStep !== lastStep) {
      lastStep = status.currentStep;
      if (options.onStep) {
        options.onStep(status.currentStep);
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
