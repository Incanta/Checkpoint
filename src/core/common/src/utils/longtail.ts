import { dlopen, FFIType } from "bun:ffi";
import path from "path";
import os from "os";

export type LongtailLogLevel = "debug" | "info" | "warn" | "error" | "off";

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

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function CreateLongtailLibrary() {
  let folder: string;
  let library: string;
  switch (os.platform()) {
    case "darwin": {
      folder = "macos";
      library = "libLongtailWrapper.dylib";
      break;
    }
    case "linux": {
      folder = "linux";
      library = "libLongtailWrapper.so";
      break;
    }
    case "win32": {
      folder = "windows";
      library = "LongtailWrapper.dll";
      break;
    }
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }

  const libPath = path.join(__dirname, "..", "..", "..", "libraries", folder);
  process.env["PATH"] = `${process.env["PATH"]};${libPath}`;
  process.env["LD_LIBRARY_PATH"] =
    `${process.env["LD_LIBRARY_PATH"]};${libPath}`;

  const { symbols: lib } = dlopen(library, {
    SubmitAsync: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.u32,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u8,
        FFIType.u8,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u64,
        FFIType.cstring,
        FFIType.u8,
        FFIType.cstring,
        FFIType.u32,
        FFIType.pointer,
        FFIType.int,
      ],
      returns: FFIType.pointer,
    },
    FreeHandle: {
      args: [FFIType.pointer],
      returns: FFIType.void,
    },
    MergeAsync: {
      args: [
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.pointer,
        FFIType.u64,
        FFIType.int,
      ],
      returns: FFIType.pointer,
    },
    PullAsync: {
      args: [
        FFIType.cstring,
        FFIType.bool,
        FFIType.bool,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.cstring,
        FFIType.u64,
        FFIType.int,
      ],
      returns: FFIType.pointer,
    },
    ReadFileFromVersionAsync: {
      args: [
        FFIType.cstring, // FilePath
        FFIType.cstring, // VersionIndexName
        FFIType.cstring, // RemoteBasePath
        FFIType.cstring, // FilerUrl
        FFIType.cstring, // JWT
        FFIType.u64, // JWTExpirationMs
        FFIType.int, // LogLevel
      ],
      returns: FFIType.pointer,
    },
    FreeReadFileHandle: {
      args: [FFIType.pointer],
      returns: FFIType.void,
    },
    GetReadFileData: {
      args: [FFIType.pointer],
      returns: FFIType.pointer,
    },
    GetReadFileSize: {
      args: [FFIType.pointer],
      returns: FFIType.u64,
    },
  });

  return lib;
}

export function createStringBuffer(s: string): Buffer {
  return Buffer.from(s + "\0", "utf-8");
}

export function decodeHandle(
  handle: Uint8Array,
  includeResult: boolean = false,
): {
  currentStep: string;
  result: any;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
} {
  const view = new DataView(handle.buffer);

  const resultString = includeResult
    ? Buffer.from(handle.slice(272, 272 + 2048)).toString("utf-8")
    : "";

  let result = null;
  if (resultString.startsWith("{")) {
    try {
      const end = resultString.search("\0");
      result = JSON.parse(
        resultString.substring(0, end === -1 ? resultString.length : end),
      );
    } catch (e) {
      console.error("Failed to parse result string as JSON:", e);
      console.error("Result string:", resultString);
    }
  }

  return {
    currentStep: Buffer.from(handle.slice(0, 256)).toString("utf-8"),
    result,
    changingStep: view.getUint32(256, true) !== 0,
    canceled: view.getUint32(260, true) !== 0,
    completed: view.getUint32(264, true) !== 0,
    error: view.getInt32(268, true),
  };
}

export function cancelHandle(handle: Uint8Array): void {
  const view = new DataView(handle.buffer);

  view.setUint32(260, 1, true);
}

/**
 * Decode the extended ReadFileAsyncHandle structure.
 * Layout: WrapperAsyncHandle (2320 bytes) + data pointer (8 bytes) + size (8 bytes)
 */
export function decodeReadFileHandle(handle: Uint8Array): {
  currentStep: string;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
  dataPointer: bigint;
  size: bigint;
} {
  const view = new DataView(handle.buffer);

  return {
    currentStep: Buffer.from(handle.slice(0, 256)).toString("utf-8"),
    changingStep: view.getUint32(256, true) !== 0,
    canceled: view.getUint32(260, true) !== 0,
    completed: view.getUint32(264, true) !== 0,
    error: view.getInt32(268, true),
    // After the base handle (2320 bytes), we have data pointer and size
    dataPointer: view.getBigUint64(2320, true),
    size: view.getBigUint64(2328, true),
  };
}
