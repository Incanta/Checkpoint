// Canonical, deterministic binary serialization of a directory node.
//
// A node is a directory's sorted child list. Each child is one of:
//   file      -> name + sourceChangelistNumber
//   dirInline -> name + the child node's payload embedded directly (used to
//                collapse thin chains and small subtrees into one block)
//   dirRef    -> name + the 32-byte hash of a separately stored child block
//
// Names are stored with shared-prefix compression against the previous entry
// (entries are always sorted by name), which is highly effective for the long,
// prefix-redundant paths in UE/World-Partition repos.
//
// FROZEN FORMAT: layout + version byte. Do not change without bumping VERSION
// and re-deriving (golden vectors guard this once frozen).

import { HASH_BYTES } from "./hash";

export const FORMAT_VERSION = 1;

// A node is either a LEAF directory node (its entries are the directory's
// children) or an INDEX node (its entries are dirRef pointers to chunk blocks
// that, concatenated, form a dense directory's child list). Index nodes let a
// directory with too many children to fit one block split across blocks.
export const NODE_LEAF = 0;
export const NODE_INDEX = 1;

export const KIND_FILE = 0;
export const KIND_DIR_INLINE = 1;
export const KIND_DIR_REF = 2;

export type EncodeEntry =
  | { name: string; kind: typeof KIND_FILE; cl: number }
  | { name: string; kind: typeof KIND_DIR_INLINE; payload: Uint8Array }
  | { name: string; kind: typeof KIND_DIR_REF; hash: Uint8Array };

export type DecodedEntry =
  | { name: string; kind: typeof KIND_FILE; cl: number }
  | { name: string; kind: typeof KIND_DIR_INLINE; payload: Uint8Array }
  | { name: string; kind: typeof KIND_DIR_REF; hash: Uint8Array };

// ── varint (unsigned LEB128) ─────────────────────────────────────────
function pushVarint(out: number[], n: number): void {
  if (n < 0 || !Number.isInteger(n)) throw new Error(`varint: bad ${n}`);
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
}

function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 1;
  let p = pos;
  for (;;) {
    const byte = buf[p++]!;
    result += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) break;
    shift *= 128;
  }
  return [result, p];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** Encode a node (LEAF or INDEX); entries must be sorted by name ascending. */
export function encodeNode(nodeType: number, entries: EncodeEntry[]): Uint8Array {
  const out: number[] = [];
  out.push(FORMAT_VERSION);
  out.push(nodeType);
  pushVarint(out, entries.length);

  let prevName = "";
  for (const e of entries) {
    const shared = commonPrefixLen(prevName, e.name);
    const suffix = textEncoder.encode(e.name.slice(shared));
    pushVarint(out, shared);
    pushVarint(out, suffix.length);
    for (const b of suffix) out.push(b);
    out.push(e.kind);
    if (e.kind === KIND_FILE) {
      pushVarint(out, e.cl);
    } else if (e.kind === KIND_DIR_INLINE) {
      pushVarint(out, e.payload.length);
      for (const b of e.payload) out.push(b);
    } else {
      if (e.hash.length !== HASH_BYTES) throw new Error("dirRef hash size");
      for (const b of e.hash) out.push(b);
    }
    prevName = e.name;
  }
  return Uint8Array.from(out);
}

/** Decode a node payload into its type and entries (names reconstructed). */
export function decodeNode(buf: Uint8Array): {
  type: number;
  entries: DecodedEntry[];
} {
  let pos = 0;
  const version = buf[pos++]!;
  if (version !== FORMAT_VERSION) {
    throw new Error(`tree node format version ${version} != ${FORMAT_VERSION}`);
  }
  const type = buf[pos++]!;
  let count: number;
  [count, pos] = readVarint(buf, pos);

  const entries: DecodedEntry[] = [];
  let prevName = "";
  for (let i = 0; i < count; i++) {
    let shared: number;
    let suffixLen: number;
    [shared, pos] = readVarint(buf, pos);
    [suffixLen, pos] = readVarint(buf, pos);
    const suffix = textDecoder.decode(buf.subarray(pos, pos + suffixLen));
    pos += suffixLen;
    const name = prevName.slice(0, shared) + suffix;
    const kind = buf[pos++]!;
    if (kind === KIND_FILE) {
      let cl: number;
      [cl, pos] = readVarint(buf, pos);
      entries.push({ name, kind: KIND_FILE, cl });
    } else if (kind === KIND_DIR_INLINE) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      const payload = buf.subarray(pos, pos + len);
      pos += len;
      entries.push({ name, kind: KIND_DIR_INLINE, payload });
    } else if (kind === KIND_DIR_REF) {
      const hash = buf.subarray(pos, pos + HASH_BYTES);
      pos += HASH_BYTES;
      entries.push({ name, kind: KIND_DIR_REF, hash });
    } else {
      throw new Error(`unknown entry kind ${kind}`);
    }
    prevName = name;
  }
  return { type, entries };
}
