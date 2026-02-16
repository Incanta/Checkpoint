import { createHash } from "crypto";
import { promises as fs } from "fs";

/**
 * Computes a SHA-256 hash of a file's contents.
 */
export async function hashFile(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Computes a SHA-256 hash of a buffer.
 */
export function hashBuffer(buffer: Buffer | Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}
