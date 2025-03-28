import { dlopen, FFIType } from "bun:ffi";
import path from "path";

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
    CommitAsync: {
      args: [
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
        FFIType.u32,
        FFIType.pointer,
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
      ],
      returns: FFIType.pointer,
    },
  });

  return lib;
}

export function createStringBuffer(s: string): Buffer {
  return Buffer.from(s + "\0", "utf-8");
}

export function decodeHandle(handle: Uint8Array): {
  currentStep: string;
  changingStep: boolean;
  canceled: boolean;
  completed: boolean;
  error: number;
} {
  const view = new DataView(handle.buffer);

  return {
    currentStep: Buffer.from(handle.slice(0, 256)).toString("utf-8"),
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
