# Scaling plan: cost scales with the change, not the repo

Living status doc for the plan agreed on 2026-10-13. It lists what is done, what remains, and what needs a decision or action from you. Each finished step is its own commit on `main`.

## Why

A survey found four places where per-operation cost tracks repo size or history length instead of the size of the change:

1. **Store index.** One flat `store.lsi` per repo, downloaded whole by every submit, pull pass, and file read, and rewritten whole by the server on every submit under a repo-wide lease.
2. **State tree.** Every submit attempt clones the full path map, re-encodes the whole tree, and writes every block.
3. **Pull.** One native pass per source changelist, each walking the whole workspace and fetching the full store index, plus a correction pass for stray and stale writes.
4. **Daemon state.** Every save deletes and reinserts every row; some callers used the wrong backend.

Decisions already made: a breaking change behind a version gate is fine; design for several core servers sharing one store; all four workstreams are in scope.

## Status

| Step | What | Status |
|---|---|---|
| D0 | Daemon state correctness: backend resolver, safe JSON import, no `workspace.json` rewrite on state save, `daemon.json` default backfill | Done |
| P0 | Instrumentation (`[pull-timing]`, `[state-tree]`, `[state-store]`, server merge timing) and a long-history benchmark scenario | To do |
| D1 | `StateStore.apply(delta)` with cached statements | To do |
| D2 | One in-memory state handle per workspace; every call site writes deltas | To do |
| D3 | Path index replacing O(dirty x tracked) scans; keep pending cache across pull/submit | To do |
| D4 | Remove `json` as a configurable backend | To do |
| S0 | Tree stats and test seams | To do |
| S1 | Block cache, batched reads, `lookup`/`listDir`, consumer switch-over, migration (`File(repoId, path)` index, `Changelist.fileCount`, `TreeBlockLength`) | To do |
| S2 | Incremental `applyChanges` (byte-identical to a full build), collision guard, `verify` rollout flag | To do |
| S3 | Sparse three-way merge, remove the full-map LRU | To do |
| N1 | Submit writes per-version block maps (`versions/<stem>.lsi`) | To do |
| N2 | Single-pass pull and file reads from block maps | To do |
| N3 | Server index segments and `/existing-content`, in shadow mode | To do |
| N4 | Cutover: client uses `/existing-content`, no lock or merge on submit, migration, version gate (breaking) | To do |
| N5 | Cleanup: compaction, delete `store.lsi` and the old merge path | To do |

## Needs you

Items only you can decide or do. Each is also noted where it comes up.

- **Open decisions**
  - Unique `(repoId, path)` index on `File` after a duplicate audit, or keep it non-unique?
  - Folder view total file count: keep the union with artifact paths (my default) or count main only?
  - Which release removes the writable JSON state backend?
  - r2 block-map protection: prefix-scoped R2 credentials (if R2 supports them) or a checksum column on the changelist?
- **Known hazards not in scope**
  - `DaemonConfig.Load` overwrites an unparseable `daemon.json` with defaults, which loses the workspace registry.
  - The frozen tree format's prefix compression can split a UTF-16 surrogate pair, so some astral-character file names decode lossily.
