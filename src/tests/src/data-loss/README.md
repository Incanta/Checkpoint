# Data-loss red team

Tests for scenarios that lose work during push (submit), pull (sync), merge, and branch use. Every test states the safe outcome, so a failing test here is an open bug, not a broken test. The suite is kept out of `yarn test` so the main suite stays green while the bugs are open.

```bash
cd src/tests
yarn test:data-loss                                                     # the whole suite
yarn vitest run --config vitest.data-loss.config.ts src/data-loss/pull.test.ts   # one file
```

Status when written (2026-10-14, on `81ed16a`): 35 tests, 32 failing (the findings below), 3 passing (controls that show the harness reproduces the protections that do work). When a fix lands, its tests pass; move them into `src/api` or `src/daemon` so they guard against regressions in the main suite.

Updated 2026-10-15 with OS and filesystem findings (DL-17 to DL-26). On Windows: 66 in-process tests, 58 failing, 6 passing, 2 skipped (they apply to macOS and to Linux and macOS), plus 3 native tests (1 failing; the 2 file-mode tests need services and do not apply on Windows). Linux and macOS skip a different set. `.github/workflows/data-loss.yaml` runs the suite on all three, plus the native tests on Linux, and lists every test by outcome in each run's summary. It fails while any finding reproduces, on purpose: a commit with open findings is not a clean one, and a green leg means every finding on that OS is fixed. It is a separate workflow so that the main CI (`test.yaml`) keeps meaning "nothing regressed".

The plan for fixing these findings, in dependency order and with the decisions it needs, is `docs/data-loss-fix-plan.md`.

## How the tests run

`server.test.ts` calls the app's tRPC routers in-process over the per-file SQLite database, like the rest of `src/api`.

The other files use `../harness/stack.ts`, which runs a whole Checkpoint stack in one process:

- **Real:** the app routers (submit, merge, tree diff, pull anomalies, claims), the daemon's own tRPC endpoints (`pending.stage`, `pending.submit`, `sync.pull`, `branches.switch`, `pending.refresh`), and everything they call (pull, submit, the pre-submit merge, the Team Sync pipeline, the local-change guard, the SQLite workspace state, pending-change detection).
- **Fake:** the native longtail addon. A submit stores each submitted file's bytes under a new version index name and records the changelist through the app; a version index holds only its own changelist's files, as the real format does. Selection pulls write exactly the selected paths; whole-index pulls write every file in the index. Also faked: the HTTP transport (an in-process adapter), storage tokens, the Team Sync config endpoint (so a test can make it fail), and the daemon's config and logger (so nothing reads or writes `~/.checkpoint`).
- **Per OS:** `os.test.ts` probes the filesystem the workspaces live on (case and Unicode normalization sensitivity, 8.3 short names) instead of going by the OS's name, since macOS volumes can be case-sensitive and so can Windows directories. Its Windows file-sharing tests hold a real lock from a PowerShell process: `FileShare.Read`, the way the Unreal Editor holds a package it has loaded (others may read it, nobody may write or delete it), or `FileShare.None`, the way Office does. A test that does not apply is skipped, so each OS reports its own counts.
- **Timestamps:** `overrides.writeTime` stamps every write the test and the fake native layer make with one mtime, the way writes within one tick of the filesystem's clock are stamped.
- **Native layer:** the native findings are fixed, and their tests moved to `src/integration` (`file-modes.test.ts`, `include-filter.test.ts`, `native-written-files.test.ts`), which `test.yaml` runs against the addon built from the commit. One test here still loads the installed addon's include matcher (DL-26 in `os.test.ts`), so it stays red until an addon release with the fix is installed.
- **Not verified here:** what the real native pull does with `..` paths (the fake writes with `path.join` and `fs.writeFile`, as any writer would). On Windows the addon writes through `\\?\` paths (`MakeLongPlatformPath` in `longtail_platform.c`), which do not resolve `..`, so its write probably fails there instead of escaping; on Linux and macOS it would follow `..`. Also from the source rather than a test: after one file fails to write, the fake writes the rest of the pull and then reports the failure, as the addon's parallel write jobs do. Node and the addon both use `\\?\` paths on Windows, so names ending in a dot or a space and reserved names are created as given by both, and `CHECKP~1` and `::$DATA` resolve through both (checked with Node on NTFS).
- **Written on Windows:** the macOS normalization test, the Linux and macOS backslash test, and the native file-mode tests could not run where they were written. Their expected failures come from reading the code, and CI is their first run.

## Findings

Severity: **Critical** means silent, unrecoverable loss in a common workflow, or loss outside the workspace. **High** means silent loss or a silent revert that needs a less common trigger. **Medium** means the work survives in the database but a normal workflow cannot reach it. **Low** means it takes a buggy or malicious client. **Latent** means the code is wrong but a separate bug (the gate, below) currently keeps users from reaching it.

| ID | Finding | Area | Severity | Status |
| --- | --- | --- | --- | --- |
| DL-01 | Edits made after a submit vanish from pending changes at the next pull, then get overwritten | Pull | Critical | Fixed (R4) |
| DL-02 | One failed Team Sync config read deletes most of the workspace, for good | Pull (Team Sync) | Critical | Fixed (R3) |
| DL-03 | The server stores paths as sent; `../x` makes teammates' pulls delete files outside their workspace | Push, pull | Critical | Fixed (R1, R2, R13) |
| DL-04 | Narrowing the sync filter deletes locally edited files with no backup | Pull (Team Sync) | High | Fixed (R3) |
| DL-05 | A pull that fails after writing files leaves local edits overwritten and unreported | Pull | High | Fixed (R5) |
| DL-06 | The whole-index pull fallback overwrites edits the pull meant to skip | Pull | High | Fixed (R4) |
| DL-07 | A case-only rename upstream leaves the old content, recorded as the new version | Pull | High | Fixed (R7) |
| DL-08 | The server accepts paths that differ only by case | Push | High | Fixed (R6, R7) |
| DL-09 | Respelling a path (`Content//x`, `/Content/x`, `Content/x/`) bypasses someone else's exclusive lock | Push | High | Fixed (R1, R6) |
| DL-10 | Pull with a feature branch active takes the branch's changes back out of the workspace | Branch | High | Fixed (R14) |
| DL-11 | The pre-submit merge on a feature branch reverts the branch's own earlier changes | Push, branch | High | Fixed (R14) |
| DL-12 | Submits to a feature branch have no lost-update protection | Push, branch | High | Fixed (R14) |
| DL-13 | A stacked branch can never merge after its parent merged | Merge | Medium | Fixed (R16) |
| DL-14 | A conflict resolved on the branch, as the error says to, never merges | Merge | Medium | Live |
| DL-15 | Deleting a branch discards unmerged changelists with no confirmation | Branch | Medium | Live |
| DL-16 | The app records changelists whose content does not exist | Push | Low | Empty index refused (R1); existence check open (R19) |
| DL-17 | Names Windows cannot store are accepted; a `:` hides a file's content in an NTFS stream, and a Windows "submit everything" then deletes the file | Push, pull | High | Fixed (R1, R2, R13) |
| DL-18 | Names that differ only in Unicode normalization are accepted; on macOS they are one file | Push, pull | High | Fixed (R6, R7); the macOS test runs in CI |
| DL-19 | On case-insensitive filesystems the daemon takes one file for two: deleting one spelling deletes both, phantom pending changes, Clean Workspace deletes tracked files | Pull, cleanup | High | Fixed (R7) |
| DL-20 | A same-size edit within one timestamp tick of a pull is invisible, then overwritten | Pull | High | Fixed (R9) |
| DL-21 | An edit made while a pull runs is recorded as the pulled version, then overwritten | Pull | High | Fixed (R10); users need an addon release |
| DL-22 | A sync filter change that cannot remove one file leaves the files it did remove looking deleted | Pull (Team Sync) | High | Fixed (R3) |
| DL-23 | A pull writes into the workspace's own `.checkpoint` directory; one changelist can wipe every teammate's workspace | Push, pull | High, and a security issue | Fixed (R1, R2, R13) |
| DL-24 | Executable bits are dropped on submit and stripped on pull | Push, pull (native) | High | Fixed (R11); users need an addon release; its tests run on Linux in CI |
| DL-25 | A failed pull stops putting edits back at the first file it cannot write | Pull | High | Fixed (R5) |
| DL-26 | A Team Sync rule typed in another case silently stops a folder from syncing | Pull (Team Sync, native) | Medium | Fixed (R12); users need an addon release, and the in-process test here stays red until one is installed |
| Gate | Modified files cannot be submitted to a feature branch at all | Push, branch | Functional, not data loss | Fixed (R15) |
| Backslash | A file name with a backslash blocks every submit | Push | Functional, not data loss | Fixed (R8); its tests run on Linux and macOS in CI |

### DL-01: Edits made after a submit vanish at the next pull, then get overwritten

Tests: `pull.test.ts` "keeps an edit made after a submit as a pending change across the next pull" and "does not overwrite that edit when the file next changes upstream".

Scenario: Bob submits `notes.txt` while a teammate's changelist has landed since his last pull (an everyday situation in a team). His workspace correctly keeps its old changelist number and records `notes.txt` individually at his new changelist. He keeps editing `notes.txt`. His next pull sees `notes.txt` already at the incoming changelist and skips writing it, which is right, but then records the file's current size and mtime as its pristine baseline. The unsubmitted edit stops showing as a pending change. The next time anyone changes `notes.txt` upstream, the guard sees no local changes and the pull overwrites it: no merge, no backup, no report.

Observed: `notes.txt` disappears from pending changes; later it holds Alice's version and no backup has Bob's edit.

Cause: `src/core/daemon/src/util/pull.ts:262` skips protection for any path whose recorded changelist equals the incoming one, and the state update at `pull.ts:618` re-records every incoming path from a fresh `stat`, including paths the pull did not write. The same holds after `pullTextFilesForSubmit` rewrites a file and the submit is then aborted (any other file with a conflicted merge aborts it), and after `conflicts.resolve`: both move a file's recorded changelist ahead of the workspace's.

Recommended fix: only write state entries for paths the pull actually wrote, and leave every other entry's baseline alone. Decide whether to protect a file by its content (`hasLocalChanges`, which is cheap when size or mtime differ), never by changelist equality alone. Add a regression test per trigger.

### DL-02: One failed Team Sync config read deletes most of the workspace

Tests: `sync-filter.test.ts` "keeps every file the real filter includes, and the local edit" and "brings the files back once the config can be read again".

Scenario: the repo's Team Sync config has categories (say, `Source/` and `Content/`, both on by default) and Bob's workspace adds one custom include rule (`Plugins/MyPlugin/`). One sync cannot read the repo config (a 503, a network blip, a scheduled sync at night). The filter is rebuilt from Bob's own rules alone, which is just the plugin, and every other tracked file is deleted, local edits included. The state entries go too, so after the API recovers, no pull's diff mentions those files again and they never come back.

Observed: `Source/game.cpp` and the locally edited `Content/level.txt` are gone (no backup of the edit exists), and `Source/game.cpp` is still gone after a later sync that reads the config fine.

Cause: `reconcileSyncFilter` (`src/core/daemon/src/util/team-sync/sync-pipeline.ts:215`) ignores the `repoConfigResolved` flag that `resolveSyncFilter` returns, and `compileFilter` with no repo config keeps only the custom include rules. The comment at `sync-pipeline.ts:146` ("a transient API failure never widens into mass deletion") holds only for a workspace with no include rules of its own. The comment at `sync-pipeline.ts:75` ("Newly-included files are picked up by the normal pull diff") holds only for files that change upstream.

Recommended fix: when the repo config was not resolved, skip the reconcile entirely: an unknown config is not an empty one. Separately, when a filter widens, re-pull files the target tree has but the workspace state lacks, instead of relying on the next diff.

### DL-03: Paths are stored as sent, and `../x` deletes files outside the workspace

Tests: `server.test.ts` "refuses a path that is not a canonical repo-relative path: ..." (nine spellings) and `pull.test.ts` "never deletes a file outside the workspace for a path that climbs out of it".

Scenario: anything holding a write token (a buggy tool, a script, or a malicious collaborator) records a changelist adding `../not-a-workspace.txt` and another removing it. Every teammate's pull joins the removed path to their workspace root and deletes whatever is at `<workspace>/../not-a-workspace.txt`.

Observed: the server accepts `../escape.txt`, `Content/../../escape.txt`, `Content\..\..\escape.txt`, `./a.txt`, `Content/./a.txt`, `Content//a.txt`, `/rooted.txt`, `Content/a.txt/`, and `C:/Windows/System32/drivers/etc/hosts`. Bob's pull deletes a file outside his workspace.

Cause: `createChangelist` (`src/app/src/server/api/routers/changelist.ts:392`) only converts backslashes. The daemon joins diff paths to the workspace root with `path.join` and no containment check in the pull's delete pass (`pull.ts:492`), its stray correction, the guard's backups, the sync-filter reconcile, `revertFiles`, and `clean`.

Recommended fix: validate every modification path at the API boundary (`createChangelist` and `artifact.attachToChangelist`): forward slashes only, no leading or trailing slash, no empty, `.`, or `..` segments, no drive letters or `:`, no control characters, within a length limit; reject anything else with BAD_REQUEST. In the daemon, route every write, delete, and backup path through one helper that resolves the path and refuses anything outside the workspace root. Check whether the native pull does the same, and add an integration test for it.

### DL-04: Narrowing the sync filter deletes locally edited files

Test: `sync-filter.test.ts` "does not delete a locally edited file when the filter is narrowed".

Scenario: Bob has an afternoon of edits in `Content/level.txt`, then narrows his sync to code only (or a repo admin moves `Content/` into a category that is off by default). The next sync, including an unattended scheduled one, deletes the file. Nothing is backed up, and the only report is a count.

Cause: `reconcileSyncFilter` deletes each excluded tracked file with a bare `fs.rm` (`sync-pipeline.ts:245`) and drops its state entry, with no local-change check.

Recommended fix: check `hasLocalChanges` before deleting. Keep modified files and their state entries (so they stay pending), or back them up through `LocalChangeGuard` and report them in the sync result. Never remove a file that is staged or claimed by this workspace.

### DL-05: A pull that fails after writing files leaves local edits overwritten

Tests: `pull.test.ts` "puts local edits back when the pull fails partway" (simulated, any OS) and `os.test.ts` "puts local edits back when a file the pull deletes is open in the Unreal Editor" (a real lock, Windows). With the real lock the delete fails with `EPERM` rather than `EBUSY`; the outcome is the same.

Scenario: Bob has a local edit to `a.txt`; upstream changed `a.txt` and deleted `b.txt`. On Windows, `b.txt` is open in another program (an editor or the Unreal Editor holding an asset), so deleting it fails with `EBUSY`. By then the pull has already written the server's `a.txt` over Bob's edit. The pull throws without restoring anything. The workspace state did not advance, so `a.txt` now looks like Bob's own edit of a version he never pulled, and his real edit is only in an unreported `.checkpoint/pull-backups` folder.

Cause: the guard restores backups only when the native pass fails (`pull.ts:705`). Everything after it (the delete pass, the stale correction that reads files over the network, the merge step, the state update) runs in a block with no error handling (`pull.ts:480`).

Recommended fix: wrap everything after the protect phase so any failure restores the backups (or settles them) before rethrowing. Make the delete pass tolerate per-file failures (`EBUSY`, `EPERM`, `EISDIR`), finish the pull, and report the files it could not remove, instead of aborting halfway.

### DL-06: The whole-index fallback overwrites edits the pull meant to skip

Test: `pull.test.ts` "keeps that edit when the pull falls back to applying whole version indexes".

Scenario: as in DL-01, but the pull's single-pass selection is declined because teammates' daemons indexed with different hashing or chunk settings, so the daemon applies each changelist's whole version index. Bob's own changelist's index holds his submitted `notes.txt`, and applying it rewrites the file he kept editing. The guard skipped it as up to date, so nothing was backed up.

Observed: `notes.txt` holds Bob's submitted v2; his unsubmitted v3 is gone.

Cause: the same changelist-equality skip as DL-01 (`pull.ts:262`); in this mode the pull writes every file of every applied index, not just the selections.

Recommended fix: the DL-01 fix (protect by content). Also, in this mode, protect every path any applied index will write; the server already knows them from the `FileChange` rows it uses for `getPullAnomalies`.

### DL-07: A case-only rename upstream leaves the old content, recorded as the new version

Test: `pull.test.ts` "brings the new content of a file renamed by case only (case-insensitive filesystems)" (skipped on case-sensitive filesystems).

Scenario: Alice renames `Textures/hero.txt` to `Textures/Hero.txt` and updates it in one changelist. On Bob's Windows machine the pull writes `Hero.txt` onto the existing file, then deletes `hero.txt`, which is the same file. The file survives only because the guard took it for an untracked `Hero.txt` before the pull and backed it up, so it puts back the old content. The state records that as Alice's new version, and nothing shows it as changed. The next time Bob edits and submits the file, Alice's change is silently reverted on the server.

Observed: `Textures/Hero.txt` holds the original content, the workspace state records it at Alice's changelist, and pending changes are empty.

Cause: the pull applies writes before deletes, by exact name, with no notion of names that collide on a case-insensitive filesystem; the server accepts the colliding names (DL-08).

Recommended fix: detect diff entries whose paths are equal when case-folded. Treat a removed and an added path that fold together as a rename: delete (or rename in place) first, then write. Fold Unicode normalization too: on macOS the same happens to a rename that only changes how an accented letter is encoded (DL-18). Also see DL-08 and DL-19.

### DL-08: The server accepts paths that differ only by case

Tests: `server.test.ts` "refuses a new path that differs from an existing one only in the case of the file name", "... of a directory name", "... of a non-ASCII letter", and "... of a file and a directory"; `os.test.ts` "does not leave two spellings on the server when a case-only rename is submitted as the new file". Control (passes): "accepts a case-only rename made in one changelist".

Scenario: `Content/Hero.txt` exists; someone adds `Content/hero.txt` as a new file (or `docs/guide/intro.txt` next to `Docs/Guide/intro.txt`, or `Content/level/arena.umap` next to a file `Content/Level`). The server accepts it, so the tree holds two files that are one file on Windows and macOS. No other client is needed: a user who renames a file by case in Explorer or Finder sees the old name as deleted and the new one as untracked, and submitting just the new file does it. What follows on Windows and macOS is DL-19.

Recommended fix: reject an added path that case-folds onto a different existing path at the head (file or directory segment), unless the same changelist deletes the old spelling. That keeps case-only renames working, as the control test requires. This needs a case-folded lookup over the tree for the added paths only. Fold the way the filesystems do (full Unicode case folding, as NTFS and APFS fold `Ä` and `ä`), not with SQL: SQLite's `LOWER` and `NOCASE` fold ASCII only, which the non-ASCII test catches. Fold Unicode normalization in the same lookup (DL-18). In the daemon, treat an untracked file whose name folds onto a locally deleted tracked file as a rename, so staging one stages both.

### DL-09: Respelling a path bypasses someone else's exclusive lock

Tests: `server.test.ts` "does not let Content//hero.uasset past someone else's exclusive claim on Content/hero.uasset", and the same for `/Content/hero.uasset` and `Content/hero.uasset/`; and "does not let content/HERO.uasset, the same file on Windows, past someone else's exclusive claim on Content/hero.uasset", and the same for `Content/hero.uasset::$DATA` and `Content/HERO~1.UAS`.

Scenario: Alice holds an exclusive claim on `Content/hero.uasset` and is editing it. Bob's submit spells the path `Content//hero.uasset`. The claim check finds no claim for that spelling and lets it through; the state tree drops the empty segment, so Bob's version replaces Alice's file. Binary work cannot be merged, so Alice's edit is lost when she syncs.

The OS spellings work differently. The tree keeps `content/HERO.uasset`, `Content/hero.uasset::$DATA`, and `Content/HERO~1.UAS` as new paths, so the server checks no claim at all; on Windows they all name Alice's file (another case; the file's main data stream, which NTFS resolves even through `\\?\` paths; and its 8.3 short name on volumes that keep them), so every Windows pull, Alice's included, writes Bob's version into the file she holds. The case spelling does the same on macOS.

Cause: the claim check looks up `File` rows by the exact spelling (`changelist.ts:451`), while the tree's `splitPath` (`src/app/src/server/tree/tree.ts:480`) drops empty segments. (`Content/./hero.uasset` is not folded: the tree keeps `.` as a directory, which is a collision of its own, covered by DL-03.)

Recommended fix: the DL-03 path validation, so every lookup (claims, `File` rows, tree, base check) keys on one canonical spelling. The OS spellings need DL-08's and DL-17's checks: the case fold, refusing `:`, and refusing names on the 8.3 short-name pattern (`NAME~N` with a base of up to six characters and an extension of up to three), as git does for `.git`.

### DL-10: Pull with a feature branch active takes the branch's changes back out

Test: `branches.test.ts` "keeps the branch's changes in the workspace when you pull with the branch active".

Scenario: Bob activates `feature` (the daemon's branch switch adds it to the workspace's overlays and pulls its head), and his workspace has the branch's version of `notes.txt`. He presses Pull, or a scheduled sync runs. The pull targets the domain root's head, takes the branch's change back out of his workspace, and records main's version as current. Local edits to such files are merged against, or set aside in favor of, the wrong version. Once the gate below is fixed, his next submit of that file to the branch reverts the branch's change on the server, with nothing to stop it (DL-12).

Cause: nothing after the switch reads `activeBranches`. The sync endpoint builds the workspace it hands to the pipeline without it (`src/core/daemon/src/api/routers/workspace/sync.ts:104`), and `pull`, `checkSyncStatus`, `checkConflicts`, and `pullTextFilesForSubmit` all look up `workspace.domainBranchName`'s head. The state store's `branchHeads` ("overlay heads ... the next sync recomputes them") is never written.

Recommended fix: compute every sync target from the overlay: the top of the active chain (which contains its parents' changes) when one is active. Pass `activeBranches` through `sync.ts`, the scheduled sync, sync status, and the pre-submit checks. Decide how domain-root changes reach an overlaid branch (see DL-14).

### DL-11: The pre-submit merge on a feature branch reverts the branch's own changes (latent)

Test: `branches.test.ts` "latent: a second edit on a feature branch does not revert the first".

Scenario: one person, no concurrency. Alice has `feature` active, edits the first line of `notes.txt`, and submits it to the branch. She then edits the last line and submits again. Before submitting, the endpoint merges "outdated" text files, comparing the workspace with main's head, so main's older `notes.txt` looks like an upstream change. It merges cleanly with her edit (different lines), the first branch change is taken back out on disk, and that is what gets submitted.

Observed: the branch head has the second edit and not the first.

Cause: the submit endpoint passes the domain root to `checkConflicts` and `pullTextFilesForSubmit` (`src/core/daemon/src/api/routers/workspace/pending.ts:554` and `:578`), whatever the target branch.

Recommended fix: give every pre-submit step the target branch, and compare with that branch's head. Record which branch each file's content came from (see DL-12).

### DL-12: Submits to a feature branch have no lost-update protection (latent)

Tests: `branches.test.ts` "latent: a stale submit to a feature branch does not silently replace a teammate's change" and "latent: a submit to a feature branch tells the server what each file was based on".

Scenario: Alice and Bob both have `feature` active. Alice submits an edit to `notes.txt`; Bob, who has not pulled it, submits his own edit of the same file. Nothing refuses Bob's submit, and Alice's change is gone from the branch. Text files take advisory claims, so no lock stands in the way, and both of the daemon's pre-submit checks look at main, where nothing changed.

Cause: `submit()` sends `baseChangelist` only when a state entry's `branch` matches the target branch (`src/core/daemon/src/util/submit.ts:137`), and no daemon code ever sets `branch`, so every tracked file appears to come from the domain root. The server skips the check for modifications without a base.

Recommended fix: set `branch` on state entries written by a pull of a feature branch, and by a submit to one. Always send a base and let the server decide comparability. Server side, once clients send bases, treat a missing base on a path that exists at the head as a conflict rather than "not checked".

### DL-13: A stacked branch can never merge after its parent merged

Test: `server.test.ts` "merges a stacked branch after its parent merged, when both changed the same file in turn".

Scenario: `upper` is stacked on `lower`, and both change `x.txt` in turn (upper's version builds on lower's). `lower` merges into `main`, and `upper` is restacked onto `main`. Merging `upper` now always conflicts on `x.txt`, and on every other file both branches touched.

Cause: a squash merge changelist records only the target as its parent (`src/app/src/server/branch-merge.ts:528`), so `findMergeBase` (`branch-merge.ts:224`) still finds the original fork from `main` for `upper`, and `x.txt` looks changed differently on both sides. With DL-14, the only way through is deleting and recreating the branch, which is what the existing "merges once the conflict is resolved on the branch" test in `src/api/branch-merge.test.ts` does, and that discards the branch's history and any work not re-applied.

Recommended fix: record merge provenance: a second parent (or the list of merged changelists) on the merge changelist, followed by `findMergeBase`. A smaller fix: when restacking a child, record the merge changelist on it as a base hint and use it as the merge base.

### DL-14: A conflict resolved on the branch never merges

Test: `server.test.ts` "merges once a conflict is resolved on the branch, as the refusal says to".

Scenario: `both.txt` changed on `main` and on `feature`; the merge refuses with "Bring main into feature, resolve them there, and merge again". No operation brings main into a branch. Submitting the resolved file to the branch does not move the merge base, so the same file conflicts on every attempt. Users are pushed toward deleting the branch (DL-15).

Recommended fix: add a "merge parent into branch" operation that records the parent's head as merged into the branch (a merge changelist on the branch with a second parent), and make `findMergeBase` follow it.

### DL-15: Deleting a branch discards unmerged changelists with no confirmation

Test: `server.test.ts` "refuses to delete a branch whose changelists were never merged, unless told to discard them".

Scenario: `branch.deleteBranch` (and the daemon's `branches.delete`) deletes a feature branch that has unmerged changelists, with no flag and no warning. Archiving already demands an explicit `releaseOutstandingClaims` for outstanding claims; deleting unmerged work demands nothing. The changelists stay in the database, but no branch reaches them, and nothing in the product can find or restore them.

Recommended fix: refuse when the branch head is not reachable from its parent's head unless an explicit `discardUnmerged` flag is passed, and keep a record of deleted branch heads so a branch can be restored.

### DL-16: The app records changelists whose content does not exist

Test: `server.test.ts` "refuses a changelist that names no version index for the files it writes".

Scenario: the storage server checks that a submit's version index is really in storage before asking the app to record the changelist, but the app's `createChangelist` is callable directly by any token with write access and checks nothing. A changelist can point files at content that does not exist (here, an empty version index name), and from then on nobody can sync those files at that head.

Recommended fix: reject non-delete modifications without a version index, and only record version indexes the storage server has verified (have the storage server call with its own credential, or check existence through the storage service).

### Gate: modified files cannot be submitted to a feature branch

Test: `branches.test.ts` "gate: submits a modified file staged to an active feature branch".

Not data loss, but it is why DL-11 and DL-12 are latent. Changed files in the daemon's pending list are built with `claims: []` (`src/core/daemon/src/daemon-manager.ts:1035`), and the submit endpoint (like the desktop's bucket view) assigns a file to a branch only by `claims[0]?.branchName` (`pending.ts:503`), so every changed file is destined for the domain root and submitting the feature bucket fails with "Nothing staged for feature". Fixing this makes DL-11 and DL-12 live, so fix those first or together; the latent tests then switch from `submitBehindTheGate` to `stageAndSubmit(..., { branch: "feature" })`.

### DL-17: Names Windows cannot store are accepted

Tests: `server.test.ts` "refuses names Windows reserves for devices", "refuses names that end in a dot or a space", "refuses characters Windows does not allow in names", and "refuses a name longer than Linux filesystems allow"; `os.test.ts` "leaves nothing pending after pulling a file a Mac or Linux user named with a colon" (Windows).

Scenario: Linux and macOS allow almost any name; Windows does not. A Linux user's `standup 10:15.txt` (or a Mac user's "standup 10/15", which Finder stores as `standup 10:15`) reaches a Windows teammate through a pull. NTFS reads the colon as a stream separator, so the pull creates an empty file `standup 10` and writes the text into a hidden stream named `15.txt`. The scan then shows `Notes/standup 10` as new and `Notes/standup 10:15.txt` as deleted, so the Windows user's "submit everything" deletes the file for everyone and adds an empty one. Reserved device names (`aux.h` is common in C code; `CON`, `NUL`, `COM1`) and names ending in a dot or a space are written as given, through `\\?\` paths, but Explorer and most Windows programs cannot open or delete them. In the other direction, a file name of 100 CJK characters is fine on Windows (100 UTF-16 units) but is 300 bytes of UTF-8, over the 255-byte limit of ext4, XFS, and Btrfs, so every pull on a Linux machine (a build agent) fails on it.

Observed: the server accepts every name tested; on Windows the colon file pulls as `{"Notes/standup 10": "Local", "Notes/standup 10:15.txt": "Deleted"}`.

Cause: `createChangelist` (`changelist.ts:392`) only converts backslashes (DL-03).

Recommended fix: a portability rule in the DL-03 validation. Refuse, in any segment: Windows device names with or without an extension and in any case (`CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9`, the superscript-digit forms, `CONIN$`, `CONOUT$`); a trailing dot or space; the characters `< > : " | ? *` and control characters; and more than 255 bytes of UTF-8. Make it a repo setting that is on by default, for teams that are Linux-only. In the daemon on Windows, refuse to write a path containing `:` instead of letting NTFS take it as a stream.

### DL-18: Names that differ only in Unicode normalization are accepted

Tests: `server.test.ts` "refuses a new path that differs from an existing one only in the Unicode normalization of the file name" and "... of a directory name"; `os.test.ts` "keeps Docs/Café.txt when its decomposed spelling is deleted upstream" (runs where the filesystem treats both forms as one name: macOS).

Scenario: "é" can be one code point (U+00E9, what Windows and Linux keyboards produce) or "e" followed by a combining accent (what older macOS tools, and anything that passed through HFS+, write). They are different bytes, so the server stores them as different files; APFS and HFS+ treat them as one. On every Mac, everything DL-08 and DL-19 describe for case then follows: a pull writes both into one file, and deleting either spelling deletes the other's file.

Recommended fix: fold Unicode normalization along with case in DL-08's collision check (NFC, then case folding), and consider storing every path in NFC.

### DL-19: On case-insensitive filesystems the daemon takes one file for two

Tests: `os.test.ts` "keeps Content/Hero.txt when Content/hero.txt is deleted upstream", "leaves nothing pending after pulling a directory the tree spells two ways", and "does not let Clean Workspace delete a tracked file in a directory the tree spells two ways" (Windows and macOS; skipped on case-sensitive filesystems).

Scenario: once the tree holds two spellings of one name (DL-08 lets them in; DL-18 is the macOS twin), the daemon on Windows and macOS acts as if they were two files:

- When one spelling is deleted upstream, the delete pass removes the one file both spellings name. The other is gone too, and the daemon shows it as deleted by the user, so "submit everything" deletes it for everyone.
- When the tree spells a directory two ways (`Content/Maps/arena.txt` and `content/maps/forest.txt`), both files land in one directory. The scan finds `Content/Maps/forest.txt`, which the state does not know (untracked), and never finds `content/maps/forest.txt`, which it does (deleted). "Submit everything" moves the file; reverting the untracked entry deletes it from disk.
- Clean Workspace offers that file as untracked and deletes it when asked; its own re-check against the state compares the exact spelling.

Observed: `Content/Hero.txt` deleted from Bob's workspace and pending as `Deleted`; pending `{"Content/Maps/forest.txt": "Local", "content/maps/forest.txt": "Deleted"}`; Clean Workspace offered `["Content/Maps/forest.txt"]` and deleted it.

Cause: the delete pass checks and removes each removed path by name (`pull.ts:489`); the full refresh looks the state up by the on-disk name (`daemon-manager.ts:1259`) and reports every state entry it did not see as deleted (`:1283`); Clean Workspace's `isTracked` is an exact lookup (`clean.ts:59`, re-checked at `:210`).

Recommended fix: probe each workspace's volume for case and normalization sensitivity when it is registered (as these tests do), and on an insensitive volume key every path comparison (state lookups, the delete pass, the scan, clean) by the folded form. Never delete a file that a path remaining in the target tree still names. The server-side checks stop new collisions, but repositories that already hold some still need this.

### DL-20: A same-size edit within one timestamp tick of a pull is invisible

Test: `os.test.ts` "still sees a same-size edit made within one timestamp tick of a pull" (any OS; the tick is emulated).

Scenario: a pull records each file's size and mtime and no hash (hashing a large sync is slow), and both change detection and the pull's guard call a file unchanged when its size and mtime match. A filesystem's clock moves in ticks: 2 seconds on FAT32, and coarse on exFAT too (exFAT drives are common for moving projects between Macs and PCs), 1 second on HFS+ and ext3, a few milliseconds on NTFS and ext4. Anything that rewrites a pulled file at the same length within the same tick (a build step stamping a version or changelist number, an editor resaving, a sync hook) leaves a change the daemon never looks at again. It drops out of pending changes, and the next upstream change overwrites it with no backup. This is git's "racily clean" problem.

Observed: nothing pending after the edit; after the next upstream change, the file holds the new upstream version and no backup has the edit.

Cause: `compareWithBaseline` returns "unchanged" for equal size and mtime when there is no hash (`baseline.ts:53`), and the pull records size and mtime with an empty hash (`pull.ts:643`).

Recommended fix: what git does. Record when each baseline was taken, and treat an entry whose mtime is not older than that, less the filesystem's tick (2 seconds covers them all), as racily clean: equal size and mtime are not enough for it, so compare content (hash those files when recording, or on their next check).

### DL-21: An edit made while a pull runs is recorded as the pulled version

Test: `pull.test.ts` "does not record an edit made while the pull runs as the version it pulled" (any OS; not OS-specific, found while checking file times).

Scenario: a large sync runs for minutes, and people keep working, or leave the editor open and it resaves. A file the pull wrote early is changed before the pull finishes. At the end, the pull stats every file it pulled and records that as the pristine baseline, the edit included. The edit drops out of pending changes, and the next upstream change to the file overwrites it with no backup.

Observed: nothing pending after the pull; after the next upstream change, the edit is gone and no backup holds it.

Cause: the state update stats files after the native pass, the delete pass, and the merges (`pull.ts:622`). `submit()` avoids exactly this by recording the stat it took before the native read (`statBeforeSubmit`, `submit.ts:181`); the pull has no equivalent.

Recommended fix: record what the pull wrote, not what is on disk when it finishes: have the native pass report each file's size and mtime as it finishes writing it, and record those. A file whose stat at the end differs was changed during the pull, and then shows as a local change.

### DL-22: A sync filter change that cannot remove one file leaves the rest looking deleted

Test: `os.test.ts` "does not leave the files a sync filter change removed looking deleted when it cannot remove one" (Windows, with a real lock).

Scenario: Bob narrows his Team Sync filter. The reconcile deletes the excluded files one at a time and only afterwards drops them from the workspace state. One of them is open in the Unreal Editor, so its delete fails (`EPERM`) and the sync throws. Every file deleted before it is gone from disk but still in the state, so each shows as deleted by Bob, and "submit everything" deletes them for the whole team. On Linux and macOS any failed delete (a permissions error, say) does the same.

Observed: `["Content/level1.txt", "Content/level2.txt"]` pending as `Deleted`.

Cause: `reconcileSyncFilter` removes files in a loop with no error handling and writes the state once, after the loop (`sync-pipeline.ts:242` and `:248`).

Recommended fix: drop each file from the state as it is deleted (or drop the deleted ones when the loop fails), carry on past files that cannot be removed, and report them. Together with DL-04's fix (never delete edited files).

### DL-23: A pull writes into the workspace's own `.checkpoint` directory

Tests: `server.test.ts` "refuses paths in a workspace's .checkpoint directory, in every spelling a filesystem folds onto it"; `os.test.ts` "does not let a pull replace the workspace's config through .checkpoint/workspace.json (everywhere)", "... through .CHECKPOINT/workspace.json (Windows and macOS)", and "... through CHECKP~1/workspace.json (Windows volumes with 8.3 short names)".

Scenario: anything holding a write token records a changelist that adds `.checkpoint/workspace.json`. Every teammate's next sync writes it over their workspace config (the guard keeps their own copy as a backup and reports it as added on both sides), and the sync pipeline then reads its Team Sync filter from that file. A filter that includes nothing makes the reconcile delete every tracked file, unsubmitted edits included and with no backup (DL-04), and the config itself, which is tracked now. A scheduled sync does this overnight. On Windows and macOS `.CHECKPOINT/` names the same directory, and on Windows volumes that keep 8.3 short names so does `CHECKP~1/`, so blocking the literal name is not enough. The same file holds custom build steps that Team Sync builds run, which makes this a code-execution path as well: treat it as a security issue.

Observed: after the sync, `Source/game.cpp`, the edited `Content/level.txt`, and `.checkpoint/workspace.json` are all gone, for each of the three spellings.

Cause: nothing on the server or in the pull treats `.checkpoint` specially; the scan skips it only by its literal lowercase prefix (`daemon-manager.ts:1254`).

Recommended fix: on the server, refuse any path whose first segment folds (by case, or as an 8.3 short name) to `.checkpoint`, as git does for `.git` (`core.protectNTFS`, `core.protectHFS`). In the daemon, refuse to pull such a path, as a second line of defense.

### DL-24: Executable bits are dropped on submit and stripped on pull (Linux, macOS)

Tests (now in `src/integration/file-modes.test.ts`): "gives a teammate a script the submitter made executable, still executable" and "keeps a teammate's executable executable when it changes upstream" (Linux and macOS with services; skipped on Windows).

Scenario: `Setup.sh`, `GenerateProjectFiles.sh`, `RunUAT.sh`, and the binaries under `Engine/Binaries/Linux` must be executable. The native submit records every file as 0644 whatever its mode, and both native pulls apply the recorded permissions to every file they write. A script added from Linux or macOS reaches teammates non-executable, and a teammate who fixes it by hand loses the fix the next time the file changes. Linux build agents and Mac and Linux developers have to `chmod` after every sync.

Cause: `submit.cpp:457` (`m_Permissions[...] = 0644`); `pull.cpp:463` and `pull-selection.cpp:432` call `Longtail_ChangeVersion` with `retain_permissions` set, which applies each asset's recorded permissions after writing it (`longtail.c:5637`), with `chmod` on POSIX (`longtail_platform.c:2060`).

Recommended fix: record the real mode at submit on POSIX (`Longtail_GetFilePermissions` already exists). On Windows, which has no executable bit, keep the mode the file has at the head instead of writing 0644, as git does with `core.fileMode=false`. Make a mode-only change (`chmod +x`) show as a pending change, which needs the mode in the workspace state.

### DL-25: A failed pull stops putting edits back at the first file it cannot write

Test: `os.test.ts` "puts every local edit back when the pull cannot write a file open in the Unreal Editor" (Windows, with a real lock).

Scenario: Bob saved changes to `Content/Hero.uasset` and `Docs/notes.txt` and still has the hero open in the Unreal Editor, which lets others read a loaded package but not write or delete it. Alice changed both. The pull backs both up (reading is allowed), the native pass writes the notes and fails on the hero, and the pull starts putting the backups back. Putting the hero's back fails for the same reason, which throws out of the loop before it reaches the notes. The notes are left holding Alice's version, which the state says Bob does not have, so it looks like his own edit, and the error he sees is about copying a file out of a backup folder.

Observed: the pull fails with `EBUSY: resource busy or locked, copyfile '...\pull-backups\...\Content\Hero.uasset' -> '...\Content\Hero.uasset'`; `Docs/notes.txt` holds Alice's version, and Bob's is only in the backup folder.

Cause: `restoreAll` (`pull-local-changes.ts:198`) has no per-file error handling, and it rewrites files the pull never managed to change.

Recommended fix: restore every file it can, skip files whose content already equals the backup (the native write never happened), and report the rest with their backup paths. With DL-05's fix this covers a failure anywhere in the pull.

### DL-26: A Team Sync rule typed in another case silently stops a folder from syncing

Tests: `src/integration/include-filter.test.ts` (the real addon's matcher against the daemon's, over case variants and every rule form; needs no services) and `os.test.ts` "pulls a folder whose Team Sync rule was typed in another case" (the daemon with the real matcher plugged in; any OS where the addon loads).

Scenario: on Windows and macOS `content/maps/` and `Content/Maps/` name the same folder, so a custom include rule typed either way looks right. The daemon's own filter (the `ignore` package, which folds case by default) includes the folder; the native include filter it hands the same rule to compares bytes and does not. The pull skips the folder's files, records the workspace at the head anyway, and no later pull's diff mentions them again. The reconcile agrees the folder is included, so nothing reports anything missing. New files never arrive and changed ones stay stale; an edit to a stale file is refused by the server's base check, and pulling again does not help.

Observed: the native matcher answers `[false, false]` where the daemon's says `[true, true]`; after two syncs the workspace is recorded at the head with only `Source/game.cpp`, and `Content/Maps/arena.umap` is missing.

Cause: `filter.ts:127` builds its matchers with `ignore()`, which folds case, while `PathFilter` (`src/longtail/wrapper/src/util/path-filter.h`) compares bytes, although it says its syntax was "chosen to agree with the `ignore` npm package". `filter.ts` relies on the native filter never being narrower than its own (the comment on `nativeIncludeRules`), and the pull records only what the native filter kept (`pull.ts:312`).

Recommended fix: make the two agree: fold case in `PathFilter`, or build the daemon's matchers with `ignore({ ignorecase: false })` and fold only on case-insensitive volumes. Have the Team Sync settings warn about a rule that matches nothing in the tree. Keep a test that runs both matchers over the same rules and paths.

### Backslash: a file name with a backslash blocks every submit (Linux, macOS)

Test: `os.test.ts` "still submits other changes when a stray file's name contains a backslash" (Linux and macOS; skipped on Windows).

Not data loss, but it stops all submits. A script written for Windows and run on Linux or macOS creates `C:\Users\bob\build.log` as a single file in the workspace root; a backslash is an ordinary character there. The full refresh rebuilds each file's path with backslashes turned into slashes (`daemon-manager.ts:1250`), stats a path that does not exist, and that error fails the whole refresh, so pending changes, and with them every submit, fail until the file is found and removed. Recommended fix: build the path from the directory entry without rewriting the name, and show such a file as unsupported (never staged) instead of failing the scan.

## Scenarios that held up

Probed and found safe (the existing suites cover most of them): a local text edit plus an upstream change to the same file merges three ways and stays pending (control in `pull.test.ts`); a local edit to a file deleted upstream is backed up and reported; an untracked file at a path the server adds is backed up; a native pull failure restores every backup; concurrent submits, a submit landing on the target during a merge, sibling merges at once, and double merges are all handled; a stale submit to the domain root is refused by the base check; and a case-only rename within one changelist is accepted (control in `server.test.ts`).

On the OS side (controls in `os.test.ts`): a working copy a Windows editor saved with CRLF line endings merges cleanly with an LF upstream change and keeps CRLF, because the merge compares lines without their endings; a UTF-16 text file (Unreal localization files, PowerShell output) changed on both sides is set aside whole, with a backup and a report, instead of being merged as UTF-8, which would corrupt it; and a locally edited file that another program holds open with no sharing stops the pull before anything is written. A Team Sync rule typed in the wrong case does not make the reconcile delete files, because the daemon's filter folds case (the native filter's disagreement is DL-26).

## Other observations

- `revertFiles` deletes a locally added file from disk with `fs.unlink` and no backup. Perforce, which many Unreal teams come from, leaves added files in place on revert.
- `conflicts.resolve` moves a file's recorded changelist to the remote one without checking the file has local changes. Resolving an unmodified, merely outdated file marks stale content as current, and its next submit reverts the remote change.
- `diffStateTrees` treats a target with no state tree as "every file removed". Pull is safe today only because it looks the changelist up first and fails when it does not exist.
- `tree/DESIGN.md` says the `FileChange` log is canonical and any tree can be re-derived from it. A merge's `FileChange` rows point at the merge changelist, which has no version index, so after a merge the log no longer says where a merged file's content lives; only the tree does.
- The file watcher ignores events with no file name (`daemon-manager.ts:1543`). That is how Windows reports an overflowed change buffer (many files changing at once: a build, an editor saving a level), so those edits never reach the dirty set, and the cached pending list keeps leaving them out until something forces a full rescan. A watcher error (Linux running out of inotify watches on a large tree) leaves the same gap until the retry. The pull's guard checks the disk itself, so this hides changes rather than losing them, but a hidden change is not submitted. Recommended: drop the cached pending list on a nameless event or a watcher error. Reasoned from libuv's behavior, not tested.
- There are no default ignore rules for files the OS writes: `.DS_Store`, the `._*` AppleDouble files macOS writes on exFAT and SMB volumes, `Thumbs.db`, and `desktop.ini`. A Mac "submit everything" adds them, and Explorer keeps `Thumbs.db` open while it shows thumbnails, which then fails Windows pulls that need to replace or delete it (DL-05, DL-25).
- HFS+ (older Macs, external drives) returns decomposed names from directory listings whatever was written, so after a pull every precomposed non-ASCII path would show as deleted plus untracked (DL-19's mechanism). APFS, which CI runs, keeps names as written, so this is not tested.
- Both writers use `\\?\` paths on Windows, so Checkpoint handles paths over 260 characters, but Explorer and many tools do not, and the pull's backup folder (`.checkpoint/pull-backups/<timestamp>-cl<N>/`) adds about 50 characters to each path. Consider warning when a path plus that prefix passes 260.
