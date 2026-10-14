// Content-addressing hash for tree blocks: SHA-256 from node:crypto. It is a
// FROZEN format constant, locked by the golden vectors with the node format
// and block budget (see DESIGN.md); everything goes through this module.

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
