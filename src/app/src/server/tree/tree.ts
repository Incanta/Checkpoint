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
  /**
   * Payload lengths of stored blocks, where known without fetching them.
   * Partial: a hash missing from the result is simply unknown. A block's
   * length is a function of its content, so an answer can never be stale.
   */
  lengths?(hashes: Hash[]): Promise<Map<Hash, number>>;
}

/** What a tree operation did to the store, for logs and scaling tests. */
export interface TreeOpStats {
  blocksFetched: number;
  bytesFetched: number;
  blocksPut: number;
  bytesPut: number;
  /** Writes skipped because the block was known to be stored already. */
  putsSkipped: number;
  /** Directories re-encoded because something beneath them changed. */
  dirsRepacked: number;
  /** Sibling lengths answered without fetching the block. */
  lengthsKnown: number;
  /** Sibling blocks fetched only to learn their length or inline them. */
  siblingFetches: number;
}

export function newTreeOpStats(): TreeOpStats {
  return {
    blocksFetched: 0,
    bytesFetched: 0,
    blocksPut: 0,
    bytesPut: 0,
    putsSkipped: 0,
    dirsRepacked: 0,
    lengthsKnown: 0,
    siblingFetches: 0,
  };
}

/** State shared by one build or update. */
interface PackCtx {
  store: BlockStore;
  budget: number;
  /** Blocks known to be in the store, so writing them again is skipped. */
  existing: Set<Hash>;
  stats: TreeOpStats;
}

function newCtx(
  store: BlockStore,
  budget: number,
  stats?: TreeOpStats,
): PackCtx {
  return {
    store,
    budget,
    existing: new Set(),
    stats: stats ?? newTreeOpStats(),
  };
}

async function ctxPut(ctx: PackCtx, bytes: Uint8Array): Promise<Hash> {
  const hash = toHex(hashBytes(bytes));
  if (ctx.existing.has(hash)) {
    ctx.stats.putsSkipped++;
    return hash;
  }
  await ctx.store.put(bytes);
  ctx.existing.add(hash);
  ctx.stats.blocksPut++;
  ctx.stats.bytesPut += bytes.length;
  return hash;
}

async function ctxGet(ctx: PackCtx, hash: Hash): Promise<Uint8Array> {
  const bytes = await ctx.store.get(hash);
  ctx.existing.add(hash);
  ctx.stats.blocksFetched++;
  ctx.stats.bytesFetched += bytes.length;
  return bytes;
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

/** A child of a directory being packed. */
type PackChild =
  | { name: string; kind: "file"; cl: number }
  /** A subdirectory whose encoded payload is in hand. */
  | { name: string; kind: "dir"; payload: Uint8Array; hash?: Hash }
  /**
   * An unchanged subdirectory stored as its own block, known only by hash.
   * Its length decides whether it gets inlined; `len` is filled in when known.
   */
  | { name: string; kind: "ref"; hash: Hash; len?: number };

/**
 * Pack a directory subtree into the store and return its node payload bytes.
 * Children are packed bottom-up, then {@link packEntries} decides which are
 * inlined and which are stored as their own block.
 *
 * A name that is both a file and a directory (a path "a" and a path "a/b")
 * comes out as two file entries, which is how such trees were always built;
 * new submits refuse that shape (see {@link TreeCollisionError}).
 */
async function packDir(node: DirNode, ctx: PackCtx): Promise<Uint8Array> {
  // Pre-pack subdirectories (bottom-up) so we know each child's payload size.
  const childPayloads = new Map<string, Uint8Array>();
  for (const [name, child] of node.dirs) {
    childPayloads.set(name, await packDir(child, ctx));
  }
  const names = [...[...node.files.keys()], ...[...node.dirs.keys()]].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const children: PackChild[] = names.map((name) =>
    node.files.has(name)
      ? { name, kind: "file", cl: node.files.get(name)! }
      : { name, kind: "dir", payload: childPayloads.get(name)! },
  );
  return packEntries(children, ctx);
}

/**
 * Encode one directory from its children (sorted by name), storing the
 * children that become their own blocks. This is the single packing rule:
 * a full build and an incremental update both come through here, which is
 * what makes an update's root identical to a rebuild's.
 *
 * Children whose subtree is small are inline candidates that collapse the thin
 * single-child scaffold; larger subtrees are always their own block (better
 * sharing: an edit inside a large subtree must not re-version the parent's
 * other content). If the node overflows, the largest inline subtrees are
 * demoted to refs until it fits; a dense directory whose all-ref entry list
 * still overflows is chunked by {@link finalizeDir}.
 */
async function packEntries(
  children: PackChild[],
  ctx: PackCtx,
): Promise<Uint8Array> {
  const { budget } = ctx;
  const inlineMax = Math.max(256, Math.floor(budget / 4));
  ctx.stats.dirsRepacked++;

  // Unchanged subdirectories known only by hash need their payload length.
  // Skip the lookup when every subdirectory must end up a ref anyway: when
  // even the cheapest possible encoding (each one inline with the smallest
  // payload a non-empty node can have, or a ref, whichever is smaller)
  // overflows, the demotion below turns every one of them into a ref.
  const unknown = children.filter(
    (c): c is Extract<PackChild, { kind: "ref" }> =>
      c.kind === "ref" && c.len === undefined,
  );
  if (unknown.length > 0) {
    let lowerBound = 16;
    for (const c of children) {
      lowerBound +=
        c.kind === "file"
          ? fileCost(c.name)
          : Math.min(refCost(c.name), inlineCost(c.name, MIN_NODE_BYTES));
    }
    if (lowerBound <= budget) {
      await resolveLengths(unknown, ctx);
    }
  }

  interface Item {
    child: PackChild;
    len: number; // payload length of a subdirectory (unused for files)
    ref: boolean; // current decision
  }
  const items: Item[] = children.map((child) => {
    if (child.kind === "file") return { child, len: 0, ref: false };
    const len = child.kind === "dir" ? child.payload.length : child.len;
    // An unknown length only remains when every subdirectory becomes a ref.
    return {
      child,
      len: len ?? Infinity,
      ref: len === undefined || len > inlineMax,
    };
  });

  const itemSize = (it: Item): number =>
    it.child.kind === "file"
      ? fileCost(it.child.name)
      : it.ref
        ? refCost(it.child.name)
        : inlineCost(it.child.name, it.len);

  let size = 16; // header + count headroom
  for (const it of items) size += itemSize(it);

  // Demote the largest inline subtrees to refs (deterministic: largest payload
  // first, name tiebreak) until the node fits.
  if (size > budget) {
    const demotable = items
      .filter((it) => it.child.kind !== "file" && !it.ref)
      .sort((a, b) => b.len - a.len || (a.child.name < b.child.name ? -1 : 1));
    for (const it of demotable) {
      if (size <= budget) break;
      const before = itemSize(it);
      it.ref = true;
      size += itemSize(it) - before;
    }
  }

  const entries: EncodeEntry[] = [];
  for (const it of items) {
    const c = it.child;
    if (c.kind === "file") {
      entries.push({ name: c.name, kind: KIND_FILE, cl: c.cl });
    } else if (!it.ref) {
      // A stored subdirectory small enough to inline again: fetch its bytes.
      let payload: Uint8Array;
      if (c.kind === "dir") {
        payload = c.payload;
      } else {
        ctx.stats.siblingFetches++;
        payload = await ctxGet(ctx, c.hash);
      }
      entries.push({ name: c.name, kind: KIND_DIR_INLINE, payload });
    } else {
      const hash =
        c.kind === "ref" ? c.hash : (c.hash ?? (await ctxPut(ctx, c.payload)));
      entries.push({
        name: c.name,
        kind: KIND_DIR_REF,
        hash: hexToBytes(hash),
      });
    }
  }
  // A leaf node that fits is returned directly; a dense directory whose entry
  // list exceeds the budget is split into chunk blocks under an index node.
  return finalizeDir(entries, ctx);
}

// The smallest encoded node with at least one entry: version, type, count,
// then shared-prefix, suffix length, a one-byte name, kind, and a one-byte
// changelist. Empty directories never exist, so no subdirectory is smaller.
const MIN_NODE_BYTES = 8;

/** Fill in `len` for stored subdirectories, asking the store before fetching. */
async function resolveLengths(
  refs: Extract<PackChild, { kind: "ref" }>[],
  ctx: PackCtx,
): Promise<void> {
  const known = ctx.store.lengths
    ? await ctx.store.lengths(refs.map((r) => r.hash))
    : new Map<Hash, number>();
  for (const r of refs) {
    const len = known.get(r.hash);
    if (len !== undefined) {
      r.len = len;
      ctx.stats.lengthsKnown++;
    } else {
      ctx.stats.siblingFetches++;
      r.len = (await ctxGet(ctx, r.hash)).length;
    }
  }
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
  ctx: PackCtx,
): Promise<Uint8Array> {
  const leaf = encodeNode(NODE_LEAF, entries);
  if (leaf.length <= ctx.budget) return leaf;
  const groups = chunkEntries(entries, ctx.budget);
  const level: { name: string; hash: Uint8Array }[] = [];
  for (const g of groups) {
    const hash = hexToBytes(await ctxPut(ctx, encodeNode(NODE_LEAF, g)));
    level.push({ name: g[0]!.name, hash });
  }
  return finalizeIndex(level, ctx);
}

async function finalizeIndex(
  level: { name: string; hash: Uint8Array }[],
  ctx: PackCtx,
): Promise<Uint8Array> {
  const entries: EncodeEntry[] = level.map((l) => ({
    name: l.name,
    kind: KIND_DIR_REF,
    hash: l.hash,
  }));
  const idx = encodeNode(NODE_INDEX, entries);
  if (idx.length <= ctx.budget) return idx;
  const groups = chunkEntries(entries, ctx.budget);
  const up: { name: string; hash: Uint8Array }[] = [];
  for (const g of groups) {
    const hash = hexToBytes(await ctxPut(ctx, encodeNode(NODE_INDEX, g)));
    up.push({ name: g[0]!.name, hash });
  }
  return finalizeIndex(up, ctx);
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
  stats?: TreeOpStats,
): Promise<Hash> {
  const ctx = newCtx(store, budget, stats);
  const root = buildDirTree(entries);
  const rootPayload = await packDir(root, ctx);
  return ctxPut(ctx, rootPayload);
}

// ── incremental update ───────────────────────────────────────────────

/** One change to a tree: a path set to a source changelist, or deleted. */
export type TreeEdit =
  | { path: string; cl: number; delete?: false }
  | { path: string; delete: true };

/**
 * A path that would be both a file and a directory: adding "a/b" while "a" is
 * a file, or "a" while "a/..." holds files. A tree cannot hold both, and the
 * full build used to keep only the file and silently drop the directory.
 */
export class TreeCollisionError extends Error {
  public constructor(
    public readonly path: string,
    public readonly existing: "file" | "dir" | "fold",
    /** For "fold": the existing path it folds onto. */
    public readonly other?: string,
  ) {
    super(
      existing === "file"
        ? `${path} is a file, so nothing can be added beneath it`
        : existing === "dir"
          ? `${path} is a directory, so it cannot also be a file`
          : `${path} differs from ${other} only in case or Unicode normalization, so on Windows and macOS they are one file. Rename one of them, or delete ${other} in the same changelist`,
    );
    this.name = "TreeCollisionError";
  }
}

/**
 * Folds a name to the form it shares with every name some filesystem stores
 * as the same file (see foldName in repo-path.ts), or null to allow names
 * that differ only by such folding.
 */
export type NameFold = ((name: string) => string) | null;

/** The changes under one directory, keyed by child name. */
interface EditTrie {
  /** The edit to the file with this name, if any. */
  file?: { cl: number } | "delete";
  /** Changes beneath the directory with this name, if any. */
  dir?: Map<string, EditTrie>;
}

function splitPath(path: string): string[] {
  // Same normalization as buildDirTree: empty segments are dropped.
  return path.split("/").filter((p) => p.length > 0);
}

function buildEditTrie(edits: TreeEdit[]): Map<string, EditTrie> {
  const root = new Map<string, EditTrie>();
  for (const edit of edits) {
    const parts = splitPath(edit.path);
    if (parts.length === 0) {
      throw new Error(`empty path in tree edit: "${edit.path}"`);
    }
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let node = level.get(parts[i]!);
      if (!node) {
        node = {};
        level.set(parts[i]!, node);
      }
      node.dir ??= new Map();
      level = node.dir;
    }
    const leaf = parts[parts.length - 1]!;
    let node = level.get(leaf);
    if (!node) {
      node = {};
      level.set(leaf, node);
    }
    // Later edits to the same path win, as they would applied one by one.
    node.file = edit.delete ? "delete" : { cl: edit.cl };
  }
  return root;
}

/** Whether a trie adds anything (rather than only deleting). */
function addsAnything(trie: Map<string, EditTrie>): boolean {
  for (const node of trie.values()) {
    if (node.file && node.file !== "delete") return true;
    if (node.dir && addsAnything(node.dir)) return true;
  }
  return false;
}

/** A directory's children as they stand, before this update's changes. */
type ExistingChild =
  | { kind: "file"; cl: number }
  | { kind: "inline"; payload: Uint8Array }
  | { kind: "ref"; hash: Hash };

async function readChildren(
  payload: Uint8Array,
  ctx: PackCtx,
): Promise<Map<string, ExistingChild>> {
  const out = new Map<string, ExistingChild>();
  for (const e of await readDirEntriesCtx(payload, ctx)) {
    // A name can appear twice in trees built from a map holding both "a" and
    // "a/b" (both entries are files then). Keep the first, as readers do.
    if (out.has(e.name)) continue;
    if (e.kind === KIND_FILE) out.set(e.name, { kind: "file", cl: e.cl });
    else if (e.kind === KIND_DIR_INLINE)
      out.set(e.name, { kind: "inline", payload: e.payload });
    else out.set(e.name, { kind: "ref", hash: toHex(e.hash) });
  }
  return out;
}

/**
 * Applies `trie` to a directory (null for one that does not exist yet) and
 * returns its new payload, or null when it ends up empty (empty directories
 * do not exist, so the caller drops the entry).
 */
async function applyDir(
  payload: Uint8Array | null,
  trie: Map<string, EditTrie>,
  prefix: string,
  ctx: PackCtx,
  fold: NameFold,
): Promise<Uint8Array | null> {
  const children = payload
    ? await readChildren(payload, ctx)
    : new Map<string, ExistingChild>();
  const before = fold ? new Set(children.keys()) : null;
  const packed = new Map<string, Uint8Array>(); // changed subdirectories

  for (const [name, edit] of trie) {
    const path = prefix + name;
    let existing = children.get(name);

    // Deleting a file first lets the same batch put a directory in its place.
    if (edit.file === "delete" && existing?.kind === "file") {
      children.delete(name);
      existing = undefined;
    }

    if (edit.dir) {
      if (existing?.kind === "file") {
        if (addsAnything(edit.dir)) throw new TreeCollisionError(path, "file");
      } else {
        let current: Uint8Array | null = null;
        if (existing?.kind === "inline") current = existing.payload;
        else if (existing?.kind === "ref")
          current = await ctxGet(ctx, existing.hash);
        if (current || addsAnything(edit.dir)) {
          const next = await applyDir(current, edit.dir, `${path}/`, ctx, fold);
          if (next) {
            packed.set(name, next);
          } else {
            packed.delete(name);
            children.delete(name);
          }
          existing = next ? { kind: "inline", payload: next } : undefined;
        }
      }
    }

    if (edit.file && edit.file !== "delete") {
      if (existing && existing.kind !== "file") {
        throw new TreeCollisionError(path, "dir");
      }
      children.set(name, { kind: "file", cl: edit.file.cl });
    }
  }

  if (children.size === 0 && packed.size === 0) return null;

  const names = new Set([...children.keys(), ...packed.keys()]);
  if (fold && before) {
    // Two entries that fold together are one file on Windows and macOS.
    // Refuse a name this change brings in that does; collisions already in
    // the tree are left alone, so a repo that has one keeps working (and a
    // case-only rename passes, since the old name is gone by now).
    const byFold = new Map<string, string>();
    for (const name of [...names].sort(
      (a, b) => Number(before.has(b)) - Number(before.has(a)),
    )) {
      const key = fold(name);
      const seen = byFold.get(key);
      if (seen === undefined) {
        byFold.set(key, name);
      } else if (!before.has(name)) {
        throw new TreeCollisionError(prefix + name, "fold", prefix + seen);
      }
    }
  }
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const list: PackChild[] = sorted.map((name) => {
    const changed = packed.get(name);
    if (changed) return { name, kind: "dir", payload: changed };
    const c = children.get(name)!;
    if (c.kind === "file") return { name, kind: "file", cl: c.cl };
    if (c.kind === "inline") return { name, kind: "dir", payload: c.payload };
    return { name, kind: "ref", hash: c.hash };
  });
  return packEntries(list, ctx);
}

/**
 * Apply edits to an existing tree and return the new root hash.
 *
 * Path-copying: only the directories on the edited paths are read and
 * re-encoded, and only blocks that did not exist before are written. The
 * result is byte-identical to {@link buildTree} over the edited path map,
 * because both pack every directory with {@link packEntries}.
 *
 * Throws {@link TreeCollisionError} when an edit would make a path both a
 * file and a directory. Deleting a path that is not a file is a no-op.
 */
export async function applyChanges(
  parentRoot: Hash | null,
  edits: TreeEdit[],
  store: BlockStore,
  budget: number = BLOCK_BUDGET,
  stats?: TreeOpStats,
  fold: NameFold = null,
): Promise<Hash> {
  const ctx = newCtx(store, budget, stats);
  const trie = buildEditTrie(edits);
  let rootPayload: Uint8Array | null = null;
  if (parentRoot) {
    rootPayload = await ctxGet(ctx, parentRoot);
  }
  if (trie.size === 0 && parentRoot) {
    return parentRoot;
  }
  const next = await applyDir(rootPayload, trie, "", ctx, fold);
  return ctxPut(ctx, next ?? encodeNode(NODE_LEAF, []));
}

/** Like readDirEntries, but counts fetches and remembers chunk blocks as stored. */
async function readDirEntriesCtx(
  payload: Uint8Array,
  ctx: PackCtx,
): Promise<DecodedEntry[]> {
  const { type, entries } = decodeNode(payload);
  if (type === NODE_LEAF) return entries;
  const all: DecodedEntry[] = [];
  for (const e of entries) {
    if (e.kind !== KIND_DIR_REF) throw new Error("index entry must be a ref");
    const child = await ctxGet(ctx, toHex(e.hash));
    for (const s of await readDirEntriesCtx(child, ctx)) all.push(s);
  }
  return all;
}

// ── point reads ──────────────────────────────────────────────────────

/**
 * The entry named `name` in a directory node, reading only the chunk of a
 * dense (INDEX) directory that can hold it.
 */
async function findEntry(
  payload: Uint8Array,
  name: string,
  ctx: PackCtx,
): Promise<DecodedEntry | undefined> {
  const { type, entries } = decodeNode(payload);
  if (type === NODE_LEAF) {
    return entries.find((e) => e.name === name);
  }
  // Index entries are named after their chunk's first entry, in name order:
  // the chunk to read is the last one whose first name is <= `name`.
  let pick: DecodedEntry | undefined;
  for (const e of entries) {
    if (e.name <= name) pick = e;
    else break;
  }
  if (!pick || pick.kind !== KIND_DIR_REF) return undefined;
  return findEntry(await ctxGet(ctx, toHex(pick.hash)), name, ctx);
}

async function childPayload(
  e: DecodedEntry,
  ctx: PackCtx,
): Promise<Uint8Array | null> {
  if (e.kind === KIND_DIR_INLINE) return e.payload;
  if (e.kind === KIND_DIR_REF) return ctxGet(ctx, toHex(e.hash));
  return null;
}

/**
 * The source changelists of `paths` at a tree, reading only the blocks on
 * the way to them. Paths that are not files in the tree are absent from the
 * result.
 */
export async function lookup(
  rootHash: Hash,
  paths: Iterable<string>,
  store: BlockStore,
  stats?: TreeOpStats,
): Promise<StateMap> {
  const ctx = newCtx(store, BLOCK_BUDGET, stats);
  const out: StateMap = new Map();
  // Group the requested paths by directory so each directory is read once.
  const trie = new Map<string, EditTrie>();
  const original = new Map<string, string[]>();
  for (const path of paths) {
    const parts = splitPath(path);
    if (parts.length === 0) continue;
    const key = parts.join("/");
    const list = original.get(key);
    if (list) list.push(path);
    else original.set(key, [path]);
    let level = trie;
    for (let i = 0; i < parts.length - 1; i++) {
      let node = level.get(parts[i]!);
      if (!node) {
        node = {};
        level.set(parts[i]!, node);
      }
      node.dir ??= new Map();
      level = node.dir;
    }
    const leafName = parts[parts.length - 1]!;
    const leaf = level.get(leafName) ?? {};
    leaf.file = { cl: 0 };
    level.set(leafName, leaf);
  }

  const visit = async (
    payload: Uint8Array,
    level: Map<string, EditTrie>,
    prefix: string,
  ) => {
    // Many names in one directory: read it whole. A few: look each one up,
    // which in a dense directory reads one chunk per name.
    let byName: Map<string, DecodedEntry> | null = null;
    if (level.size > 8) {
      byName = new Map();
      for (const e of await readDirEntriesCtx(payload, ctx)) {
        if (!byName.has(e.name)) byName.set(e.name, e);
      }
    }
    for (const [name, want] of level) {
      const entry = byName
        ? byName.get(name)
        : await findEntry(payload, name, ctx);
      if (!entry) continue;
      const path = prefix + name;
      if (want.file && entry.kind === KIND_FILE) {
        for (const asked of original.get(path) ?? []) out.set(asked, entry.cl);
      }
      if (want.dir && entry.kind !== KIND_FILE) {
        const child = await childPayload(entry, ctx);
        if (child) await visit(child, want.dir, `${path}/`);
      }
    }
  };
  await visit(await ctxGet(ctx, rootHash), trie, "");
  return out;
}

/** The direct children of one directory of a tree. */
export interface DirListing {
  files: { name: string; cl: number }[];
  dirs: string[];
}

/**
 * The direct children of `dir` ("" for the root), or null if it is not a
 * directory in the tree. Reads only the blocks on the way there and the
 * directory itself.
 */
export async function listDir(
  rootHash: Hash,
  dir: string,
  store: BlockStore,
  stats?: TreeOpStats,
): Promise<DirListing | null> {
  const ctx = newCtx(store, BLOCK_BUDGET, stats);
  let payload: Uint8Array | null = await ctxGet(ctx, rootHash);
  for (const part of splitPath(dir)) {
    const entry = await findEntry(payload, part, ctx);
    if (!entry || entry.kind === KIND_FILE) return null;
    payload = await childPayload(entry, ctx);
    if (!payload) return null;
  }
  const listing: DirListing = { files: [], dirs: [] };
  const seen = new Set<string>();
  for (const e of await readDirEntriesCtx(payload, ctx)) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    if (e.kind === KIND_FILE) listing.files.push({ name: e.name, cl: e.cl });
    else listing.dirs.push(e.name);
  }
  return listing;
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
      else
        await collectRemoved(
          await payloadOf(ea, store),
          full + "/",
          store,
          d.removed,
        );
      continue;
    }
    if (ea.kind === KIND_FILE && eb.kind === KIND_FILE) {
      if (ea.cl !== eb.cl) d.modified.push({ path: full, cl: eb.cl });
    } else if (ea.kind === KIND_FILE || eb.kind === KIND_FILE) {
      // Kind changed (file<->dir): treat as remove + add.
      if (ea.kind === KIND_FILE) d.removed.push(full);
      else
        await collectRemoved(
          await payloadOf(ea, store),
          full + "/",
          store,
          d.removed,
        );
      if (eb.kind === KIND_FILE) d.added.push({ path: full, cl: eb.cl });
      else
        await collectFiles(
          await payloadOf(eb, store),
          full + "/",
          store,
          d.added,
        );
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
    else
      await collectFiles(
        await payloadOf(eb, store),
        full + "/",
        store,
        d.added,
      );
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
