import { createHash } from "crypto";
import { createReadStream } from "fs";

/**
 * Computes an MD5 hash of a file's contents using streaming I/O.
 * Does not load the entire file into memory.
 */
export async function hashFileMD5(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
