// Content-addressed nested directory tree: build, materialize, diff.
//
// The state of a changelist is a directory tree keyed by path. Leaves hold a
// file's sourceChangelistNumber (which CL's Longtail index holds its bytes).
// Nodes are packed into content-addressed blocks: a block holds a maximal
// subtree whose serialized size is under a budget, so thin single-child chains
// and small subtrees collapse into one block (canonical "subtree packing"),
// and larger subtrees are split off into their own blocks referenced by hash.
// Unchanged subtrees share blocks by hash across changelists.
//
// This module is pure (no DB): blocks live behind a BlockStore. R2 / SeaweedFS
// implementations come in R2 of the plan.

import { hashBytes, toHex, HASH_BYTES } from "./hash";
import {
  encodeNode,
  decodeNode,
  NODE_LEAF,
  NODE_INDEX,
  KIND_FILE,
  KIND_DIR_INLINE,
  KIND_DIR_REF,
  type EncodeEntry,
  type DecodedEntry,
} from "./codec";

export type Hash = string; // hex of the block's content hash

// FROZEN production block budget (max serialized node size). Chosen from
// benchmarks across four real projects (70k-700k files); see DESIGN.md. Locked
// together with the node format and hash by the golden vectors. Changing it
// re-chunks every tree (a non-breaking re-derivation, but bump deliberately).
export const BLOCK_BUDGET = 128 * 1024;

/** Content-addressed block store. put is idempotent (keyed by content hash). */
export interface BlockStore {
  put(bytes: Uint8Array): Promise<Hash>;
  get(hash: Hash): Promise<Uint8Array>;
}

/** A path -> sourceChangelistNumber map (the materialized state tree). */
export type StateMap = Map<string, number>;

// ── in-memory directory model used during build ──────────────────────
interface DirNode {
  files: Map<string, number>; // name -> cl
  dirs: Map<string, DirNode>; // name -> child
}

function emptyDir(): DirNode {
  return { files: new Map(), dirs: new Map() };
}

/** Build the in-memory directory tree from path -> cl entries. */
export function buildDirTree(entries: Iterable<[string, number]>): DirNode {
  const root = emptyDir();
  for (const [path, cl] of entries) {
    const parts = path.split("/").filter((p) => p.length > 0);
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]!;
      let child = node.dirs.get(seg);
      if (!child) {
        child = emptyDir();
        node.dirs.set(seg, child);
      }
      node = child;
    }
    const leaf = parts[parts.length - 1]!;
    node.files.set(leaf, cl);
  }
  return root;
}

// Rough encoded-size estimate of an entry, to drive greedy inline/ref packing
// without re-encoding repeatedly. Slight over/under-estimate is fine; the final
// encodeNode is authoritative and we guard the result against the budget.
function fileCost(name: string): number {
  return name.length + 8;
}
function refCost(name: string): number {
  return name.length + HASH_BYTES + 6;
}
function inlineCost(name: string, payloadLen: number): number {
  return name.length + payloadLen + 8;
}

/**
 * Pack a directory subtree into the store and return its node payload bytes.
 * Children whose subtree fits the remaining budget are inlined (their payload
 * embedded); children that don't fit are stored as their own block and
 * referenced by hash. Files are always inline. The returned payload is < budget
 * for any directory whose own entry list fits a block (true for all real UE /
 * World-Partition data; a single directory with a multi-block entry list is an
 * R1 limitation that throws, to be handled by entry chunking later).
 */
async function packDir(
  node: DirNode,
  store: BlockStore,
  budget: number,
): Promise<Uint8Array> {
  // Pre-pack subdirectories (bottom-up) so we know each child's payload size.
  const childPayloads = new Map<string, Uint8Array>();
  for (const [name, child] of node.dirs) {
    childPayloads.set(name, await packDir(child, store, budget));
  }

  // Subtrees larger than this are always their own block (better sharing: an
  // edit inside a large subtree must not re-version the parent's other
  // content). Smaller subtrees are inline candidates that collapse the thin
  // single-child scaffold; some are demoted to refs below if the node overflows.
  const inlineMax = Math.max(256, Math.floor(budget / 4));

  interface Item {
    name: string;
    isFile: boolean;
    cl?: number;
    payload?: Uint8Array;
    ref: boolean; // current decision
  }
  const items: Item[] = [];
  const names = [
    ...[...node.files.keys()],
    ...[...node.dirs.keys()],
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    if (node.files.has(name)) {
      items.push({ name, isFile: true, cl: node.files.get(name)!, ref: false });
    } else {
      const payload = childPayloads.get(name)!;
      items.push({ name, isFile: false, payload, ref: payload.length > inlineMax });
    }
  }

  const itemSize = (it: Item): number =>
    it.isFile
      ? fileCost(it.name)
      : it.ref
        ? refCost(it.name)
        : inlineCost(it.name, it.payload!.length);

  let size = 16; // header + count headroom
  for (const it of items) size += itemSize(it);

  // Demote the largest inline subtrees to refs (deterministic: largest payload
  // first, name tiebreak) until the node fits. Starting from "all big subtrees
  // already refs", this converges unless the all-ref entry list itself exceeds
  // the budget (dense directory), which throws below.
  if (size > budget) {
    const demotable = items
      .filter((it) => !it.isFile && !it.ref)
      .sort((a, b) =>
        b.payload!.length - a.payload!.length || (a.name < b.name ? -1 : 1),
      );
    for (const it of demotable) {
      if (size <= budget) break;
      const before = itemSize(it);
      it.ref = true;
      size += itemSize(it) - before;
    }
  }
  const entries: EncodeEntry[] = [];
  for (const it of items) {
    if (it.isFile) {
      entries.push({ name: it.name, kind: KIND_FILE, cl: it.cl! });
    } else if (!it.ref) {
      entries.push({ name: it.name, kind: KIND_DIR_INLINE, payload: it.payload! });
    } else {
      const hash = hexToBytes(await store.put(it.payload!));
      entries.push({ name: it.name, kind: KIND_DIR_REF, hash });
    }
  }
  // A leaf node that fits is returned directly; a dense directory whose entry
  // list exceeds the budget is split into chunk blocks under an index node.
  return finalizeDir(entries, store, budget);
}

// ── dense-directory chunking ─────────────────────────────────────────
// FNV-1a 32-bit of a name, used only to place content-defined chunk
// boundaries (not security-sensitive; deterministic and frozen).
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function entryEnc(e: EncodeEntry): number {
  if (e.kind === KIND_FILE) return fileCost(e.name);
  if (e.kind === KIND_DIR_REF) return refCost(e.name);
  return inlineCost(e.name, e.payload.length);
}

/**
 * Split a sorted entry list into chunks that each fit a block. Boundaries are
 * content-defined (a per-entry hash bit past a minimum size, with a hard max),
 * so inserting or removing one entry only re-chunks locally rather than
 * shifting every subsequent chunk. Pure function of the entries: canonical.
 */
function chunkEntries(entries: EncodeEntry[], budget: number): EncodeEntry[][] {
  const minChunk = Math.floor(budget * 0.4);
  const maxChunk = Math.floor(budget * 0.9);
  const groups: EncodeEntry[][] = [];
  let cur: EncodeEntry[] = [];
  let size = 16;
  for (const e of entries) {
    cur.push(e);
    size += entryEnc(e);
    const boundary =
      size >= maxChunk || (size >= minChunk && (fnv1a(e.name) & 1) === 0);
    if (boundary) {
      groups.push(cur);
      cur = [];
      size = 16;
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

async function finalizeDir(
  entries: EncodeEntry[],
  store: BlockStore,
  budget: number,
): Promise<Uint8Array> {
  const leaf = encodeNode(NODE_LEAF, entries);
  if (leaf.length <= budget) return leaf;
  const groups = chunkEntries(entries, budget);
  const level: { name: string; hash: Uint8Array }[] = [];
  for (const g of groups) {
    const hash = hexToBytes(await store.put(encodeNode(NODE_LEAF, g)));
    level.push({ name: g[0]!.name, hash });
  }
  return finalizeIndex(level, store, budget);
}

async function finalizeIndex(
  level: { name: string; hash: Uint8Array }[],
  store: BlockStore,
  budget: number,
): Promise<Uint8Array> {
  const entries: EncodeEntry[] = level.map((l) => ({
    name: l.name,
    kind: KIND_DIR_REF,
    hash: l.hash,
  }));
  const idx = encodeNode(NODE_INDEX, entries);
  if (idx.length <= budget) return idx;
  const groups = chunkEntries(entries, budget);
  const up: { name: string; hash: Uint8Array }[] = [];
  for (const g of groups) {
    const hash = hexToBytes(await store.put(encodeNode(NODE_INDEX, g)));
    up.push({ name: g[0]!.name, hash });
  }
  return finalizeIndex(up, store, budget);
}

/**
 * Expand a directory node to its logical child entries, collapsing any INDEX
 * chunk levels so callers see a single leaf entry list regardless of whether
 * the directory was dense enough to be chunked.
 */
async function readDirEntries(
  payload: Uint8Array,
  store: BlockStore,
): Promise<DecodedEntry[]> {
  const { type, entries } = decodeNode(payload);
  if (type === NODE_LEAF) return entries;
  const all: DecodedEntry[] = [];
  for (const e of entries) {
    if (e.kind !== KIND_DIR_REF) throw new Error("index entry must be a ref");
    const child = await store.get(toHex(e.hash));
    for (const s of await readDirEntries(child, store)) all.push(s);
  }
  return all;
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, "hex"));
}

/** Build the whole tree and return the root block hash. */
export async function buildTree(
  entries: Iterable<[string, number]>,
  store: BlockStore,
  budget: number,
): Promise<Hash> {
  const root = buildDirTree(entries);
  const rootPayload = await packDir(root, store, budget);
  return store.put(rootPayload);
}

// ── materialize ──────────────────────────────────────────────────────
async function materializeNode(
  payload: Uint8Array,
  prefix: string,
  store: BlockStore,
  out: StateMap,
): Promise<void> {
  for (const e of await readDirEntries(payload, store)) {
    if (e.kind === KIND_FILE) {
      out.set(prefix + e.name, e.cl);
    } else if (e.kind === KIND_DIR_INLINE) {
      await materializeNode(e.payload, prefix + e.name + "/", store, out);
    } else {
      const child = await store.get(toHex(e.hash));
      await materializeNode(child, prefix + e.name + "/", store, out);
    }
  }
}

/** Materialize a tree into the full path -> cl map. */
export async function materialize(
  rootHash: Hash,
  store: BlockStore,
): Promise<StateMap> {
  const out: StateMap = new Map();
  await materializeNode(await store.get(rootHash), "", store, out);
  return out;
}

// ── diff ─────────────────────────────────────────────────────────────
/** A changed file: its path and the source CL whose LVI holds the new bytes. */
export interface TreeChange {
  path: string;
  cl: number;
}

export interface TreeDiff {
  added: TreeChange[];
  removed: string[];
  modified: TreeChange[];
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function collectFiles(
  payload: Uint8Array,
  prefix: string,
  store: BlockStore,
  out: TreeChange[],
): Promise<void> {
  for (const e of await readDirEntries(payload, store)) {
    if (e.kind === KIND_FILE) {
      out.push({ path: prefix + e.name, cl: e.cl });
    } else if (e.kind === KIND_DIR_INLINE) {
      await collectFiles(e.payload, prefix + e.name + "/", store, out);
    } else {
      await collectFiles(
        await store.get(toHex(e.hash)),
        prefix + e.name + "/",
        store,
        out,
      );
    }
  }
}

async function collectRemoved(
  payload: Uint8Array,
  prefix: string,
  store: BlockStore,
  out: string[],
): Promise<void> {
  const tmp: TreeChange[] = [];
  await collectFiles(payload, prefix, store, tmp);
  for (const c of tmp) out.push(c.path);
}

async function payloadOf(
  e: { kind: number; payload?: Uint8Array; hash?: Uint8Array },
  store: BlockStore,
): Promise<Uint8Array> {
  if (e.kind === KIND_DIR_INLINE) return e.payload!;
  return store.get(toHex(e.hash!));
}

async function diffNode(
  a: Uint8Array,
  b: Uint8Array,
  prefix: string,
  store: BlockStore,
  d: TreeDiff,
): Promise<void> {
  const am = new Map((await readDirEntries(a, store)).map((e) => [e.name, e]));
  const bm = new Map((await readDirEntries(b, store)).map((e) => [e.name, e]));

  for (const [name, ea] of am) {
    const eb = bm.get(name);
    const full = prefix + name;
    if (!eb) {
      // Removed (file or whole subtree).
      if (ea.kind === KIND_FILE) d.removed.push(full);
      else await collectRemoved(await payloadOf(ea, store), full + "/", store, d.removed);
      continue;
    }
    if (ea.kind === KIND_FILE && eb.kind === KIND_FILE) {
      if (ea.cl !== eb.cl) d.modified.push({ path: full, cl: eb.cl });
    } else if (ea.kind === KIND_FILE || eb.kind === KIND_FILE) {
      // Kind changed (file<->dir): treat as remove + add.
      if (ea.kind === KIND_FILE) d.removed.push(full);
      else await collectRemoved(await payloadOf(ea, store), full + "/", store, d.removed);
      if (eb.kind === KIND_FILE) d.added.push({ path: full, cl: eb.cl });
      else await collectFiles(await payloadOf(eb, store), full + "/", store, d.added);
    } else {
      // Both directories. Fast path: identical subtree (ref hash or inline
      // bytes equal) -> shared, skip entirely.
      if (
        ea.kind === KIND_DIR_REF &&
        eb.kind === KIND_DIR_REF &&
        bytesEqual(ea.hash, eb.hash)
      ) {
        continue;
      }
      if (
        ea.kind === KIND_DIR_INLINE &&
        eb.kind === KIND_DIR_INLINE &&
        bytesEqual(ea.payload, eb.payload)
      ) {
        continue;
      }
      await diffNode(
        await payloadOf(ea, store),
        await payloadOf(eb, store),
        full + "/",
        store,
        d,
      );
    }
  }
  for (const [name, eb] of bm) {
    if (am.has(name)) continue;
    const full = prefix + name;
    if (eb.kind === KIND_FILE) d.added.push({ path: full, cl: eb.cl });
    else await collectFiles(await payloadOf(eb, store), full + "/", store, d.added);
  }
}

/** Diff two trees, returning changed file paths. Skips equal subtrees by hash. */
export async function diff(
  rootA: Hash,
  rootB: Hash,
  store: BlockStore,
): Promise<TreeDiff> {
  const d: TreeDiff = { added: [], removed: [], modified: [] };
  if (rootA === rootB) return d;
  await diffNode(await store.get(rootA), await store.get(rootB), "", store, d);
  return d;
}

// ── in-memory store (tests + benchmark) ──────────────────────────────
export class MemBlockStore implements BlockStore {
  private blocks = new Map<Hash, Uint8Array>();
  /** Number of put() calls that created a new (previously unseen) block. */
  newBlocks = 0;
  /** Total bytes of newly-created blocks (write volume). */
  newBytes = 0;
  /** Number of put() calls total. */
  puts = 0;

  put(bytes: Uint8Array): Promise<Hash> {
    this.puts++;
    const hash = toHex(hashBytes(bytes));
    if (!this.blocks.has(hash)) {
      this.blocks.set(hash, bytes);
      this.newBlocks++;
      this.newBytes += bytes.length;
    }
    return Promise.resolve(hash);
  }

  get(hash: Hash): Promise<Uint8Array> {
    const b = this.blocks.get(hash);
    if (!b) return Promise.reject(new Error(`missing block ${hash}`));
    return Promise.resolve(b);
  }

  get size(): number {
    return this.blocks.size;
  }
  get totalBytes(): number {
    let n = 0;
    for (const b of this.blocks.values()) n += b.length;
    return n;
  }
  blockSizes(): number[] {
    return [...this.blocks.values()].map((b) => b.length);
  }
}
