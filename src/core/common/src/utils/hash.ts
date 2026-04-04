import { createHash } from "crypto";
import { createReadStream } from "fs";
import { promises as fs } from "fs";

/**
 * Computes a SHA-256 hash of a file's contents using streaming I/O.
 * Does not load the entire file into memory.
 */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Hashes multiple files in parallel with a concurrency limit.
 * Returns a Map of filePath → hex hash.
 */
export async function hashFilesParallel(
  filePaths: string[],
  concurrency = 8,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (filePaths.length === 0) return results;

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < filePaths.length) {
      const i = nextIndex++;
      const fp = filePaths[i]!;
      const hash = await hashFile(fp);
      results.set(fp, hash);
    }
  }

  const workerCount = Math.min(concurrency, filePaths.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  return results;
}

/**
 * Computes a SHA-256 hash of a buffer.
 */
export function hashBuffer(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
