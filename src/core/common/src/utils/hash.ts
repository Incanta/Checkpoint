import { promises as fs } from "fs";

/**
 * Computes a hash of a file's contents using Bun's built-in hash function.
 * Uses xxHash64 which is very fast for large files.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  // Bun.hash returns a number, convert to hex string for storage
  const hash = Bun.hash(content);
  return hash.toString(16);
}

/**
 * Computes a hash of a buffer using Bun's built-in hash function.
 */
export function hashBuffer(buffer: Buffer | Uint8Array): string {
  const hash = Bun.hash(buffer);
  return hash.toString(16);
}
