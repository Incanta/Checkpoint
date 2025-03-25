import path from "path";
import {
  dlopen,
  FFIType,
  ptr,
  suffix,
  toArrayBuffer,
  type Pointer,
} from "bun:ffi";
import jwt from "njwt";

function createStringBuffer(s: string): Buffer {
  return Buffer.from(s + "\0", "utf-8");
}

// on windows, requires PATH to include libraries folder
const { symbols: lib } = dlopen("LongtailWrapper.dll", {
  CommitAsync: {
    args: [
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
      FFIType.u64,
      FFIType.u32,
      FFIType.pointer,
      FFIType.pointer,
    ],
    returns: FFIType.pointer,
  },
  FreeHandle: {
    args: [FFIType.pointer],
    returns: FFIType.void,
  },
});

interface Modification {
  delete: boolean;
  path: string;
}

const targetChunkSize = 32768; // 32KB
const targetBlockSize = 8388608; // 8MB
const maxChunksPerBlock = 1024;
const minBlockUsagePercent = 80;
const hashingAlgo = "blake3";
const compressionAlgo = "zstd";
const enableMmapIndexing = false;
const enableMmapBlockStore = false;

const localRoot = path.join(__dirname, "../workspace");
const orgId = "org";
const repoId = "repo";
const filerUrl = "http://localhost:8888";
const remoteRoot = `/${orgId}/${repoId}`;
const signingKey = "secret";
const incomingJwt = jwt
  .create(
    {
      iss: "checkpoint-backend",
      sub: "checkpoint-storage",
      mode: "write",
      basePath: "/",
    },
    signingKey
  )
  .compact();
console.log(incomingJwt);
const clientJwt = jwt.verify(incomingJwt, signingKey, "HS256");

if (!clientJwt) {
  throw new Error("Invalid JWT");
}

const expirationMs = ((clientJwt.body as any).exp || 0) * 1000;

const modifications: Modification[] = [{ delete: false, path: "hello.txt" }];

// struct alignment will pad after the first bool to 8 bytes
const buffer = new ArrayBuffer((8 + 8) * modifications.length);
const view = new DataView(buffer);
let viewIndex = 0;

const modificationsBuffer: Buffer[] = [];
for (let i = 0; i < modifications.length; i++) {
  view.setUint8(viewIndex, modifications[i].delete ? 1 : 0);
  viewIndex += 8;

  modificationsBuffer.push(createStringBuffer(modifications[i].path));

  view.setBigUint64(
    viewIndex,
    BigInt(ptr(modificationsBuffer[i].buffer)),
    true
  );
  viewIndex += 8;
}

const hashingAlgoBuffer = createStringBuffer(hashingAlgo);
const compressionAlgoBuffer = createStringBuffer(compressionAlgo);
const localRootBuffer = createStringBuffer(localRoot);
const remoteRootBuffer = createStringBuffer(remoteRoot);
const filerUrlBuffer = createStringBuffer(filerUrl);
const incomingJwtBuffer = createStringBuffer(incomingJwt);

const asyncHandle = lib.CommitAsync(
  targetChunkSize,
  targetBlockSize,
  maxChunksPerBlock,
  minBlockUsagePercent,
  ptr(hashingAlgoBuffer.buffer),
  ptr(compressionAlgoBuffer.buffer),
  enableMmapIndexing ? 1 : 0,
  enableMmapBlockStore ? 1 : 0,
  ptr(localRootBuffer.buffer),
  ptr(remoteRootBuffer.buffer),
  ptr(filerUrlBuffer.buffer),
  ptr(incomingJwtBuffer.buffer),
  expirationMs,
  modifications.length,
  ptr(buffer)
);

if (asyncHandle === 0 || asyncHandle === null) {
  throw new Error("Failed to create diff handle");
}

function decodeHandle(handle: Uint8Array): {
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

function cancelHandle(handle: Uint8Array): void {
  const view = new DataView(handle.buffer);

  view.setUint32(260, 1, true);
}

let flagForGC = true;
let lastStep = "";

// eslint-disable-next-line no-constant-condition
while (true) {
  const decoded = decodeHandle(
    new Uint8Array(toArrayBuffer(asyncHandle, 0, 272))
  );

  if (decoded.currentStep !== lastStep) {
    console.log(`Current step: ${decoded.currentStep}`);
    lastStep = decoded.currentStep;
  }

  if (decoded.completed) {
    console.log(
      `Completed with exit code: ${decoded.error} and last step ${decoded.currentStep}`
    );
    flagForGC = false;
    break;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

if (flagForGC) {
  console.log(hashingAlgoBuffer);
  console.log(compressionAlgoBuffer);
  console.log(localRootBuffer);
  console.log(remoteRootBuffer);
  console.log(filerUrlBuffer);
  console.log(incomingJwtBuffer);
  console.log(buffer.byteLength);
  console.log(modificationsBuffer.length);
}

lib.FreeHandle(asyncHandle);
