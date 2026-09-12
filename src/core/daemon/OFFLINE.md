# Offline Work

**Status:** proposal, not implemented. Written 2026-09-12.

Let a developer disconnect from the backend, keep working (create feature branches, stage files, submit changelists), and reconcile everything when they come back. While offline the daemon assumes no one else is touching the same files: no conflict checks, no claim acquisition, no server round trips. On reconnect it replays the queued work as real transactions.

## Why this is feasible

A changelist's Longtail version index is a **delta, not a whole-tree snapshot**.

`wrapper/src/exposed/submit.cpp` builds its `Longtail_FileInfos` purely from the modification list passed in, not from a walk of the workspace root. The resulting index is named by its own content hash (`submit.cpp:524`, `0x<hash>.lvi`). Pull confirms the shape from the other side: it resolves a *list* of version indexes for the changelists between base and target and applies them in order (`util/pull.ts:157,218`).

Two consequences, and they are the whole reason this design works:

1. An offline changelist is a **self-contained, server-independent artifact**. Its identity does not depend on a changelist number, a branch head, or anything else the server allocates.
2. Replaying an offline changelist onto a head that moved while we were away is an **ordinary submit**, not a rebase. We never have to reconcile trees.

What remains is a bookkeeping problem (server-allocated identity) and a policy problem (claims). Neither requires new merge machinery.

## Constraints in the current system

### 1. Changelist numbers are a repo-global server-allocated sequence

`app/src/server/api/routers/changelist.ts:394`:

```ts
const nextNumber = (lastChangelist?.number ?? -1) + 1;
```

Scoped to `repoId`, not to branch. Downstream consumers that key off it: `WorkspaceState.changelistNumber`, `WorkspaceStateFile.changelist`, `Branch.headNumber`, `FileChange.changelistNumber`, `FileClaim.baseChangelistNumber`, and the content-addressed state tree.

Offline changelists therefore need a local identity plus a renumber pass at replay.

### 2. Submit is one atomic native call that touches the network three times

In `submit.cpp`:

- `SyncGetExistingContent` (line 311) reads the **remote** store index to decide which chunks already exist.
- Block writes and flush (lines 365, 402) push to the remote store.
- `POST /submit` (line 604) hands the store index to the core server, which merges it and calls `changelist.createChangelist`.

So offline submit is not "buffer the tRPC call". The content-addressing pass itself is online today.

### 3. Branch creation is server-side and requires a real head

`daemon/src/api/routers/workspace/branches.ts:116` calls `client.branch.createBranch.mutate({ headNumber, ... })`. An offline branch has no server row and no valid head to cite.

### 4. Every checkout and stage is a round trip

`api/routers/workspace/pending.ts` calls `client.file.checkout.mutate` from `checkout` (:687), `stage` (:783), partial staging (:964, :1047), and unstage-adjacent paths (:1114). Each one takes or moves a `FileClaim` row on the server.

### 5. File IDs are server-allocated

`util/submit.ts:210` calls `client.file.getFileIds.mutate` **after** the native submit returns, to populate `WorkspaceStateFile.fileId`. Offline state needs placeholder IDs that get reconciled at replay.

### 6. The submit guard and claim settlement both run server-side

`changelist.ts:384` rejects a submit whose paths carry blocking `EXCLUSIVE` claims held by another workspace in the same domain. `changelist.ts:544` then calls `settleClaimsForSubmit`, which creates claims for paths that were never checked out. Its own comment notes this is the only claim-creation point that can fail a submit, because the claim is taken after the work rather than before it.

Offline work cannot run either of these. Both get deferred to replay, where they can genuinely fail.

## What already exists in our favor

- **A local storage backend in the addon.** `storageType: "local"` with `localStoragePath` is already in the `StorageOptions` union (`addon/lib/index.ts:116,130`). It is documented as merge-only (used by the core server's store-index merge), but nothing about the native code restricts it to the server side.
- **A client-side block cache.** `util/pull.ts:212` already maintains `~/.checkpoint/cache/blocks`, gated on `daemonConfig.longtail.enableBlockCache`.
- **Shelving is already plumbed.** `shelfName` exists on `SubmitAsyncOptions` and flows into the `/submit` payload (`submit.cpp:586`). An offline changelist is architecturally a shelf that has not yet picked a branch head.
- **A job queue with progress reporting.** `daemon/src/job-manager.ts` gives replay its queue, step states, log lines, and client-visible progress for free.
- **A local sqlite store pattern.** `util/state-store.ts` already implements a versioned, migrating sqlite store next to `state.json`. The outbox copies it rather than inventing one.
- **Claims are scoped per domain root, not per repo.** `Branch.isClaimDomainRoot` (`schema.prisma:305`) means a release branch's claims never block mainline work. The blast radius of "assume no conflicts" is one domain.

## Design

### Entering offline mode

`workspace.offline.enter` on the daemon. It must:

1. Refuse if the workspace is not fully materialized. A sparse workspace (see `includePaths` on `PullAsyncOptions`) does not hold the base content an offline edit may need.
2. Snapshot the remote store index to `.checkpoint/offline-store/` so `SyncGetExistingContent` has something to dedupe against.
3. Record the base changelist number. This is the branch point for replay, and the whole reconciliation hangs off it.
4. Optionally run **prepare for offline**: take exclusive claims now, on paths the user names, so they are genuinely held for the duration. See [Claims](#claims).

### Offline submit

Run the *same* native submit, changed in two ways:

- `storageType: "local"`, `localStoragePath` pointed at `.checkpoint/offline-store/`, seeded from the block cache plus the store-index snapshot.
- Skip the `POST /submit` entirely. The native call returns after writing the version index and the missing store index.

Then append to the outbox instead of calling the server.

**Cost:** dedup is only as good as the local store index snapshot. Blocks we have never seen locally get written again, so offline submits use more disk, and those blocks get re-uploaded at replay. The server-side merge dedupes them on arrival. This is an acceptable trade and it is the only correctness-neutral way to keep the native path unified.

### The outbox

`.checkpoint/offline.db`, following the `state-store.ts` pattern (versioned schema, stepwise migrations, JSON fallback).

| Table | Holds |
| --- | --- |
| `offline_meta` | base changelist, entered-at, mode flags |
| `local_branches` | local name, parent ref (local or real), base changelist |
| `local_changelists` | local id, target branch ref, message, version index name, ordinal |
| `local_modifications` | local changelist id, path, delete flag, old path |
| `local_claims` | claim *intents* recorded by offline checkout/stage |

Append-only, ordered by ordinal. Replay consumes it in order and never reorders.

### Local identity

Local changelists get a `localId` distinct from the server number space. Two workable encodings:

- **Negative integers.** Cheapest: `WorkspaceStateFile.changelist` is already `number`, so nothing widens. Sort order is wrong but replay never sorts locals against reals.
- **A string ref (`L1`, `L2`).** Cleaner, but widens the field and touches every consumer.

Recommend negative integers for v1, with a `localCl -> realCl` map produced at replay and applied to `WorkspaceState` in one pass.

Local branches are name-only until replay creates the real row.

### Exiting: replay

For each queued changelist, in ordinal order:

1. Push its blocks from the local store to the remote store. This is a new native operation: walk the offline store index, upload the blocks the remote is missing. It is close to what `mergeAsync` already does on the server, run from the other side.
2. Call a server endpoint that does the normal `createChangelist` path given `(branchName, versionIndex, modifications, keepCheckedOut, workspaceId)`. The real changelist number is assigned here.
3. Record `localId -> realNumber`.

After the queue drains, rewrite `WorkspaceState` through the map, resolve real file IDs via `client.file.getFileIds`, and clear the outbox.

Drive all of it through `JobManager` so the desktop app, CLI, and VS Code client get progress and per-step failure without new plumbing.

### Land offline work on a feature branch

**Replay creates a server feature branch based at the changelist we were sitting on when we went offline, and replays onto that.** Not onto the domain root.

`createBranch` already accepts an explicit `headNumber` (`branches.ts:116`), so branching at an older head needs no new capability.

This buys three things:

- **No new conflict machinery.** Collisions surface at the merge, through the path that already handles them.
- **A reviewable artifact.** The work arrives as a branch and a merge request, not as a silent overwrite of whatever landed while we were gone.
- **An honest degradation.** "I was offline" becomes "I worked on a branch", which the model already supports end to end.

Replaying straight onto the domain root is simpler and is a legitimate fast path when the branch head has not moved since the offline base. It breaks the moment anyone else submits, so it must be a checked optimization, never the default.

### Claims

This is the part with no clean technical answer, only a policy choice.

Offline, `checkout` and `stage` can only record intent in `local_claims`. The real claim is taken at replay, where `settleClaimsForSubmit` may find someone else holding it.

Two supported paths:

**Prepare for offline (recommended).** Take the exclusive claims *before* disconnecting and hold them for the duration. Nobody else can touch those paths while we are gone, so replay is guaranteed to succeed on them. This is the Perforce-on-a-plane workflow, and for binary assets it is the only thing that actually works. It costs the team those paths for the duration, which is exactly the honest price.

**Replay and reconcile (fallback).** Offline claims are attempted at replay. Where the path is uncontested, the claim is taken and the changelist lands. Where it is contested, the changelist still lands on the feature branch (claims there park as `SUBMITTED` and blocking rather than releasing), and the collision surfaces at merge.

For text, the existing three-way auto-merge (`util/auto-merge.ts`) resolves most of these. For binaries there is no merge, which is precisely what exclusive claims exist to prevent, so **offline binary edits without a pre-taken claim are a gamble**. The UI should say so plainly when entering offline mode rather than discovering it at replay.

## Failure modes

| Failure | When | Handling |
| --- | --- | --- |
| Contested exclusive claim | Replay | Land on the feature branch, surface at merge. Never silently drop the changelist. |
| Block upload interrupted | Replay | Idempotent: blocks are content-addressed, re-push is free. Resume from the outbox ordinal. |
| `createChangelist` rejects one changelist mid-queue | Replay | Stop the queue, keep the outbox intact from that ordinal on. Partial replay must leave a resumable state, never a half-applied one. |
| Workspace edited outside the daemon while offline | Offline | Same as today's pending-change detection; no new case. |
| Disk exhaustion in the offline store | Offline | Refuse further offline submits with a clear message. The store grows unbounded with no dedup against unseen remote blocks. |

## Open questions

- **`SyncGetExistingContent` against a thin local store.** Behavior is correct by construction (worst case it finds nothing and writes every block), but the cost is unmeasured. Needs a benchmark before committing to the seeded-snapshot approach.
- **Sparse branches.** Sparse workspaces landed in `11601e5`. A partially materialized workspace may not hold the base content an offline edit needs, and the version index delta assumes the base is present. Entering offline mode from a sparse workspace should be refused in v1.
- **Multiple offline branches.** The outbox model supports a chain of local branches, but replay ordering across sibling branches is unspecified. v1 should allow one local branch chain per workspace.
- **Token expiry.** Storage JWTs expire. Long offline sessions mean the token at entry is useless at replay, so replay must re-authenticate before pushing blocks rather than reusing the snapshot's credentials.

## Phasing

**v1: offline capture and branch replay.**
Offline mode flag, outbox, local identity, local-store submit, block push, replay onto a server feature branch. Prepare-for-offline pre-claiming as the supported path for binaries. This deliberately sidesteps claim reconciliation rather than solving it.

**v2: claim reconciliation.**
Attempt claims at replay, with a resolution UI for contested paths.

**v3: fast-path replay onto the domain root** when the head has not moved, and multi-branch offline chains.

## Files this touches

| Area | Files |
| --- | --- |
| Native | `wrapper/src/exposed/submit.cpp` (local-store variant, skip POST), new push-local-store op, `addon/src/longtail-addon.cpp`, `addon/lib/index.ts` |
| Daemon | new `util/offline-store.ts`, `util/submit.ts`, `api/routers/workspace/offline.ts`, offline guards in `pending.ts` / `branches.ts` / `sync.ts`, `job-manager.ts` |
| App | replay-submit endpoint in `routers/changelist.ts`, branch-at-older-head tolerance in `routers/branch.ts` |
| Clients | offline badge and queue view in desktop, CLI `offline enter` / `offline exit` / `offline status`, VS Code status bar |
