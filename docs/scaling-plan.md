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
| P0 | Instrumentation (`[pull-timing]`, `[state-store]`, `[submit-server-timing]`) and the long-history scenario (`src/tests/src/integration/history-scaling.test.ts`) | Done (`[state-tree]` lands with S0) |
| D1 | `StateStore.apply(delta)` with cached statements, `dataVersion()` | Done |
| D2 | One shared in-memory state per workspace; every call site writes deltas; sync filter re-checks only pulled paths | Done |
| D3 | Path index replacing O(dirty x tracked) scans; pending cache kept across stage, revert, resolve, and submit/pull that only edit tracked files | Done |
| D4 | `json` is no longer a state backend: a workspace on `state.json` is imported into `state.db` on first open; unlinking a workspace now releases its `state.db` | Done (ships with the protocol 3 release, which is breaking anyway) |
| S0 | Tree stats (`TreeOpStats`, `[state-tree]` log line) | Done |
| S1 | Byte-bounded block cache, `lookup`/`listDir`, consumers switched (conflict check, file reads, claims, folder listing, pull anomalies), migration (`File(repoId, path)` index, `Changelist.fileCount`, `TreeBlockLength`) | Done |
| S2 | Incremental `applyChanges` (byte-identical to a full build), collision guard, `state-tree.incremental` rollout flag (default `verify`) | Done |
| S3 | Sparse three-way merge (reads only paths the branch changed; target-unmoved merges reuse the incoming tree), full-map LRU removed | Done |
| N1 | Submit writes per-version block maps (`versions/<stem>.lsi`), verified by the server before it records anything; block-tag bug in `Longtail_GetExistingStoreIndex` fixed | Done |
| N2 | Single-pass pull (`PullSelectionAsync`: each path from its own source, only selected paths scanned, one `ChangeVersion`), file reads from block maps; per-changelist path kept as fallback for versions without block maps | Done |
| N3 | Server index segments (`index/seg/<day>/<sha>-<mac>.lsi`, written per submit, lock-free) and `POST /existing-content` from an in-memory native index whose answers equal the full-index lookup; gateway refuses client writes under `index/` | Done (client switches in N4) |
| N4 | Cutover (breaking): client asks `/existing-content` instead of downloading `store.lsi`; `/submit` no longer locks or merges `store.lsi` (segment written, checked to be contained in the verified block map); storage protocol 3 gate (`storage.getToken` refuses older clients, `/submit` returns 426); background per-repo migration writes block maps for older versions; background compaction | Done |
| N5 | Cleanup: background compaction under a storage lease, segment pruning, LRU eviction of repo indexes, native merge path removed, lock module generalized into `withLease` | Done in code; two removals wait on your deployments (see below) |

## Baselines

Long-history scenario, 100 changelists over a 395-file tree, local dev stack (Windows, local storage mode), before any scaling change. Run with `CHECKPOINT_HISTORY_BENCH=1 HISTORY_CHANGELISTS=100 yarn test:integration src/integration/history-scaling` (plus the usual `CHECKPOINT_TEST_DAEMON_ID`).

| Measure | Before |
|---|---|
| Small submit at CL 10 / 50 / 100 | 1.6 s / 1.6 s / 1.4 s |
| `store.lsi` size at CL 10 / 50 / 100 | 6.4 KB / 9.6 KB / 13.0 KB (grows every submit) |
| Pull of one changelist | 1.7 s (diff 0.7 s, anomalies 0.3 s, native 0.26 s) |
| Fresh clone | 28.7 s, **101 native passes** (26.7 s native), 11 stray files corrected |
| Single-file read | 1.0 s |

At this size the submit cost is dominated by fixed overhead, so it does not yet show growth; the clone's pass count is the clear history-length cost.

After N4 (same scenario): no `store.lsi` is read or written at all; small submits 1.3 to 2.1 s (fixed overhead), fresh clone 1.8 s, pull of one changelist 1.4 s, single-file read 1.0 s.

After N2 (same scenario): fresh clone **2.1 s in 1 native pass** (was 28.7 s in 101), native time 0.5 s (was 26.7 s), no stray corrections; pull of one changelist 2.0 s (fixed overhead: setup and the server diff dominate).

## Needs you

Items only you can decide or do. Each is also noted where it comes up.

- **Actions**
  - Apply migration `20261013220000_state-tree-incremental` to every deployed database (`yarn --cwd src/app db:migrate:deploy`). It is additive. On Postgres, the `File(repoId, path)` index build locks writes to `File` while it runs; on a very large table, create it beforehand with `CREATE INDEX CONCURRENTLY "File_repoId_path_idx" ON "File"("repoId","path")` and skip that statement.
  - Publish a new `@checkpointvcs/longtail-addon` before deploying the server, daemon, or app from this work: the server now calls `storeBlockMapAsync`, which only the source-built addon has. Bump with `node scripts/set-addon-version.js <version>` (moves all four exact pins together) and release as usual. CI is unaffected (it builds the addon from source).
  - **The storage protocol 3 cutover is breaking.** After deploying, daemons older than this work are refused (`storage.getToken` returns PRECONDITION_FAILED "Update Checkpoint", and `/submit` returns 426). Ship the daemon/desktop update together with the server and app. No data step is required: each repo migrates itself in the background the first time a server loads its index (block maps for older versions, recorded in `index/migration.json`; failures listed there as `broken`, which were already unreadable). Until then, reads of older versions fall back to the frozen `store.lsi`.
  - Optionally set `CHECKPOINT_STORAGE_INDEX_KEY` (or `storage.index.signing-key`) on every core server, to a random value of at least 32 characters. Without it the segment MACs use the storage signing key, so rotating that key would make every server ignore existing segments (costing re-uploads, never correctness).
  - `store.lsi` is frozen, not deleted. Once every repo's `index/migration.json` reports no broken versions you may delete `store.lsi`, `store.lsi.sync`, and `store.lsi.next` from each repo (nothing reads them when every version has a block map). That is the remaining part of N5, left to you because it deletes data.
  - `state-tree.incremental` ships as `verify`: each submit updates the tree incrementally, also rebuilds it, and logs `[state-tree] MISMATCH` on any difference (using the rebuild). Watch production logs for that line; after a clean period, set it to `on` so submits stop paying for the rebuild. Locally: 0 mismatches over 125 submits; the test suite runs in `strict` mode (a mismatch fails the test).

- **After every deployed repo has migrated** (each repo's `index/migration.json` exists with an empty `broken` list), two code removals become safe; they are not done because they would break repos that have not migrated yet:
  - the per-changelist pull fallback in `src/core/daemon/src/util/pull.ts` (the `!singlePass` branch) and `changelist.getPullAnomalies` in the app router, with their tests;
  - the `store.lsi` fallback in `pull-selection.cpp` and `read-file.cpp` (`SyncGetExistingContent` when a block map is missing).
- **Open decisions**
  - Unique `(repoId, path)` index on `File` after a duplicate audit, or keep it non-unique?
  - Folder view total file count: keep the union with artifact paths (my default) or count main only?
  - r2 block-map protection: prefix-scoped R2 credentials (if R2 supports them) or a checksum column on the changelist?
- **Known hazards not in scope**
  - A daemon downgraded after its workspaces were imported from `state.json` into `state.db` sees them as empty; the original is kept as `state.json.bak` and can be renamed back.
  - `DaemonConfig.Load` overwrites an unparseable `daemon.json` with defaults, which loses the workspace registry.
  - The frozen tree format's prefix compression can split a UTF-16 surrogate pair, so some astral-character file names decode lossily.
