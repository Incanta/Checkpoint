# Content-addressed state tree

The materialized state of a changelist (which file exists at which version) is a
**content-addressed nested directory tree**, keyed by path, with leaves holding
each file's `sourceChangelistNumber` (the changelist whose Longtail version
index holds the bytes). It replaces the per-changelist `stateTree` blob and the
periodic `StateSnapshot` mechanism: unchanged subtrees are shared by hash across
changelists, so storage is proportional to what changes, not to repo size.

This is the Lore/Git model (a Merkle tree of directories) adapted to
Checkpoint: leaves point at a changelist number, not at content, because
Longtail already content-addresses the bytes.

## Invariants (frozen / reversibility)

- **The `FileChange` log is canonical.** Trees are a derived index; any tree is
  re-derivable from the log. This makes even the structural choice reversible
  (rework, not data loss or a client break).
- **The wire stays `path -> CL`** (and tree-diff results). Clients and the
  daemon never see tree internals, so storage is swappable.
- **Frozen format**: the binary node layout (`codec.ts`), the hash function, and
  the packing constants. A format change bumps `FORMAT_VERSION` and re-derives.
  Committed golden `(tree -> root hash)` vectors guard against silent drift.
- **Canonical layout**: the tree is a pure function of the final key-set and the
  block budget, independent of edit history, so it dedups and is identical
  across regions and storage backends.

## Node and block format (`codec.ts`)

A node is a directory's child list, sorted by name. Each child is one of:

- `file`      -> name + `sourceChangelistNumber` (varint)
- `dirInline` -> name + the child node's payload embedded inline
- `dirRef`    -> name + the 32-byte hash of a separately stored child block

Names use shared-prefix compression against the previous entry (entries are
sorted), which is highly effective for long, prefix-redundant UE paths
(avg ~107 chars in Titan). Integers are unsigned LEB128. The block stored in the
backend is a node payload; a `dirRef` references another stored block, a
`dirInline` is embedded (no separate storage). A changelist records the root
block hash (`Changelist.stateRootHash`).

## Grouping policy: canonical subtree packing (`tree.ts`)

A block is a maximal subtree whose serialized size is under the budget:

- Small subtrees are **inlined** into their parent's block. This collapses the
  thin single-child scaffold (in Titan, 160k of 179k directories have exactly
  one child) into a few region blocks.
- Subtrees larger than `inlineMax = budget/4` are always their **own block**
  (referenced by hash), so an edit inside a large subtree does not re-version
  the parent's other content.
- If inlined children would overflow a node, the **largest** inline subtrees are
  demoted to refs (deterministic: largest payload first, name tiebreak) until
  the node fits. Starting from "all large subtrees already refs", this converges
  unless the all-ref entry list itself exceeds the budget.

**Dense directories** (whose entry list exceeds the budget even all-ref) are
split into chunk blocks under an INDEX node (`finalizeDir`/`finalizeIndex`).
Chunk boundaries are content-defined (a per-entry FNV bit past a minimum size,
with a hard max), so inserting or removing one child only re-chunks locally
rather than shifting every subsequent chunk. INDEX nodes are collapsed by
`readDirEntries`, so materialize/diff see a directory's children uniformly
whether or not it was chunked. This is required by real UE data: the largest
real committed directory observed (`Engine/Content/.../Substrate/Glints2`) has
2,049 children (~82 KB all-ref), over a 64 KB budget.

## Hash: SHA-256 (frozen)

Measured throughput on 64 KB blocks in this runtime: SHA-256 via `node:crypto`
(OpenSSL, hardware SHA extensions) ran at **1764 MB/s**, vs blake2b512 889 MB/s
and pure-JS BLAKE3 (`@noble/hashes`) just 35 MB/s (50x slower). A native BLAKE3
binding could beat SHA-256 but adds a native dependency and build complexity for
no practical gain at these speeds. Decision: **SHA-256**, zero-dependency. Still
routed through `hash.ts`.

## Block size budget

Benchmarked on four real projects (varied CLs as a conservative estimate; real
low-churn assets dedup even better). Blocks = whole-tree total; the values below
are at the recommended 128 KB budget.

| Project              | Files   | Blocks | Stored  | Single-edit | Region fetch |
|----------------------|--------:|-------:|--------:|------------:|-------------:|
| HollowedOath (indie) |  70,346 |     80 | 2.4 MB  | 2 blocks    | 2 |
| Titan                | 193,583 |    153 | 8.8 MB  | 3 blocks    | 4 |
| UE source+content    | 412,995 |    320 | 9.2 MB  | 5 blocks    | 6 |
| Hogwarts (AAA)       | 697,847 |    988 | 12.8 MB | 6 blocks    | 6 |

Block count by budget (whole tree):

| Project       | 32 KB | 64 KB | 128 KB | 256 KB |
|---------------|------:|------:|-------:|-------:|
| HollowedOath  |   221 |   128 |     80 |     44 |
| Titan         |   716 |   364 |    153 |     81 |
| UE            |  3186 |  1430 |    320 |    128 |
| Hogwarts      |  3335 |  2177 |    988 |    237 |

Across 70k-700k files (including Hogwarts' 32,804-child `WWiseAudio` directory),
the whole tree is a few hundred to ~1000 blocks (~2-13 MB total, shared across
all history), and any single-file commit writes ~2-8 new blocks, vs the old
~4 MB snapshot re-stored every K commits. Build is ~2s for 700k files (and real
commits are incremental, not full rebuilds). Smaller budgets lower per-commit
bytes; larger budgets minimize object count and partial-fetch requests (better
for object storage). **Recommended default: 128 KB** (object counts stay in the
hundreds even for a 700k-file AAA repo, single-edit 2-6 blocks, region fetch
2-6). 64 KB is the alternative if minimizing per-commit write bytes matters more
than object count. The chosen value is frozen with the golden vectors.

## Operations

- **build** (`buildTree`): from `path -> CL` entries, bottom-up subtree packing.
- **materialize**: root hash -> full `path -> CL` map (with a node cache, hot).
- **diff**: compare two roots top-down, skip equal subtree hashes, descend only
  changed subtrees -> changed paths. This is the daemon's hot path.
- **partial fetch**: a subtree is addressed by its node hash; fetch its blocks
  directly from storage.

## Storage backend (R2 or SeaweedFS Filer)

Blocks live in the configured backend (R2 **or** Filer, per `storageType`), the
same abstraction Longtail content uses, addressed by hash. The mutable
`Changelist.stateRootHash` pointer lives in Postgres. Write ordering: **blocks
first (idempotent), then the Postgres pointer** (a failed commit leaves harmless
orphan blocks, GC'd later, exactly like Longtail's upload-then-record flow).
Clients fetch subtree blocks directly from the backend via the existing
storage-token mechanism, offloading the app server.

## Status

- **R1 (this module): COMPLETE.** Pure core, no DB. `hash`, `codec`, `tree`
  (build/materialize/diff + dense-directory chunking + in-memory store). Property
  and correctness tests pass; benchmarked on four real projects (70k-700k files).
  **Frozen**: SHA-256, node format v1, packing/chunking algorithm, and the
  128 KB budget (`BLOCK_BUDGET`). Golden `(tree -> root hash)` vectors committed
  (`src/tests/src/tree/golden.test.ts`) to guard the format.
- **R2 (server-side): COMPLETE.** `Changelist.stateRootHash` + `TreeBlock`
  table; `PrismaBlockStore`; all writers build the tree and store blocks. The
  snapshot machinery was removed, along with `FileChange.sourceChangelistNumber`
  (the tree's leaves now hold the per-file source CL). The `FileChange` log is
  kept for change type, renames (`oldPath`), and merge inputs.
- **R2b: COMPLETE.** `StorageBlockStore` over the core storage server (R2 /
  SeaweedFS / stub), selected by `state-tree.block-store` config; Postgres
  `TreeBlock` is the fallback (tests, no-backend setups).
- **R3 (server-computed diff): COMPLETE.** `changelist.diffChangelists` returns
  the path-keyed delta between two CLs (added/modified with source CL + fileId,
  removed paths, and the distinct CLs to pull). The daemon's `sync-status` and
  `pull` consume it directly: no full-map transfer, no `getFiles` round-trip,
  path-keyed, with an incremental workspace-state update. The fileId shim
  (`getStateTreeByFileId`) is gone; `getChangelist` no longer attaches a state
  tree; `listFolder` is path-keyed.
- **R3 remaining**: client-side block fetch + partial subtree sync (the daemon
  fetching blocks itself, needs tree code in the daemon); true incremental
  server-side build (currently a full rebuild from the cached parent map).
- **Later**: orphan-block GC (only once history pruning exists).
