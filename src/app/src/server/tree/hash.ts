// Pluggable content-addressing hash for tree blocks.
//
// R1 uses SHA-256 from node:crypto (zero-dependency, deterministic, available
// everywhere). The hash is a FROZEN format constant: before committing golden
// vectors we evaluate BLAKE3 (faster, same 32-byte digest) and pick one. Until
// then everything goes through this module so the choice is swappable.

import { createHash } from "node:crypto";

export const HASH_BYTES = 32;

export function hashBytes(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

export function fromHex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "hex"));
}
