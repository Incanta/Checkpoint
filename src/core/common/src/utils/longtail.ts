import { dlopen, FFIType } from "bun:ffi";
import path from "path";

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
  process.env["PATH"] = `${process.env["PATH"]};${path.join(
    __dirname,
    "..",
    "..",
    "..",
    "libraries"
  )}`;

  const { symbols: lib } = dlopen("LongtailWrapper.dll", {
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
  });

  return lib;
}

export function createStringBuffer(s: string): Buffer {
  return Buffer.from(s + "\0", "utf-8");
}

export function decodeHandle(
  handle: Uint8Array,
  includeResult: boolean = false
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
        resultString.substring(0, end === -1 ? resultString.length : end)
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
