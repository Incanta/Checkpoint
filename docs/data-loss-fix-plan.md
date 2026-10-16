# Data-loss fix plan: close every red-team finding, in dependency order

Plan for fixing the findings in `src/tests/src/data-loss/README.md` (DL-01 to DL-26, Gate, and Backslash) and the smaller observations listed there. For each step it says what changes, which red-team tests turn green, what it depends on, and what needs a decision from you. Nothing here is started. Written 2026-10-15 on `3d9fd73`; no product code has changed since the findings were written (`81ed16a`), so the README's line numbers still hold.

Each step is its own commit on `main`. When a step lands, its red-team tests pass, and they move into the main suite with the neighbouring edge cases its section lists (see [Moving tests and CI](#moving-tests-and-ci)). Size is a rough guess that includes tests: S is about a day, M a few days, L a week or more.

## Why this order

The findings come from five causes, so the steps follow causes rather than finding numbers:

1. **The server stores paths as sent.** There is no canonical form, no portability rule, no protection for `.checkpoint`, no check for two spellings of one file, and no check that content exists: DL-03, DL-08, DL-09, DL-16, DL-17, DL-18, and DL-23.
2. **The daemon's baselines describe the wrong moment.** The pull re-records files it did not write, trusts changelist numbers over content, stats files after other programs may have changed them, and trusts equal timestamps within one clock tick: DL-01, DL-06, DL-20, and DL-21.
3. **Destructive steps have no local-change check and no failure handling:** DL-02, DL-04, DL-05, DL-22, and DL-25.
4. **The daemon compares names byte for byte on filesystems that fold them, and joins paths without a containment check:** DL-03, DL-07, DL-17, DL-19, DL-23, DL-26, and Backslash.
5. **Branch overlays are half wired, and merges keep no provenance:** Gate and DL-10 to DL-15.

Ordering rules:

- Critical and security findings first (DL-01, DL-02, DL-03, and DL-23), each with a change that stands alone. Apart from R2 sharing R1's rule table, the phase 1 steps do not depend on each other and can go in parallel.
- A fix that makes a latent bug live waits for that bug's fix: R15 (the gate) lands after R14, which fixes DL-11 and DL-12.
- Server refusals and daemon defenses both ship. The server stops new bad paths; the daemon has to cope with the ones repositories already hold, and with older servers that still send them.
- The native changes (R10 to R13) go out in one addon release, since each release moves the four exact version pins together.

## Status

| Step | Fixes | What | Depends on | Size | Status |
|---|---|---|---|---|---|
| **Phase 1** | | **Stop the critical losses** | | | |
| R1 | DL-03, DL-09, DL-17, DL-23 | One path check at every API boundary that accepts a path | | M | Done |
| R2 | DL-03, DL-17, DL-23 | Every daemon write, delete, and backup goes through one containment helper | R1 (shared rules) | M | Done |
| R3 | DL-02, DL-04, DL-22 | The Team Sync reconcile never deletes on an unknown config, never deletes edits, survives a failed delete, and re-pulls when the filter widens | | M | Done |
| R4 | DL-01, DL-06 | The pull records only what it wrote, and protects by content | | M | Done |
| R5 | DL-05, DL-25 | A failing pull puts every edit back and reports what it could not | | M | Done |
| **Phase 2** | | **Filesystems and the native layer** | | | |
| R6 | DL-08, DL-18, DL-09 | The tree refuses a new name that folds onto an existing one | R1 | M | Done |
| R7 | DL-07, DL-19 | The daemon probes each workspace's volume and compares folded names where the volume folds | R6 (shared fold) | L | Done |
| R8 | Backslash | One odd file name no longer fails the scan | | S | Done |
| R9 | DL-20 | Racily clean baselines are checked by content | | M | Done |
| R10 | DL-21 | Native pulls report each file's size and mtime as written | | M | Done |
| R11 | DL-24 | File modes are recorded at submit and kept on pull | | M | Done |
| R12 | DL-26 | The native include filter folds case like the daemon's | R3 (re-pull) | M | Done |
| R13 | DL-03, DL-17, DL-23 | Native pulls and submits refuse unsafe asset paths | R1 | S | Done |
| **Phase 3** | | **Branches and merges** | | | |
| R14 | DL-10, DL-11, DL-12 | Sync and pre-submit checks use the active branch; every submit carries bases | | L | Done (server strictness: follow-up) |
| R15 | Gate | Staged files keep the branch they were staged to | R14 | M | Done |
| R16 | DL-13 | Merge changelists record what they merged, and the merge base follows it | | M | Done |
| R17 | DL-14 | Bring a branch's parent into it | R14, R16 | L | Done (desktop UI: follow-up) |
| R18 | DL-15 | Deleting a branch with unmerged work needs a flag, and deleted branches can be restored | | M | Done |
| **Phase 4** | | **Integrity and the smaller observations** | | | |
| R19 | DL-16 | The app records only version indexes that exist in the repo's storage | | M | Done |
| R20 | Other observations | Revert, resolve, the empty-tree diff, the merge log, watcher gaps, OS litter, and long paths | | M | Not started |

By finding: DL-01: R4; DL-02: R3; DL-03: R1, R2, R13; DL-04: R3; DL-05: R5; DL-06: R4; DL-07: R7; DL-08: R6, R7; DL-09: R1, R6; DL-10: R14; DL-11: R14; DL-12: R14; DL-13: R16; DL-14: R17; DL-15: R18; DL-16: R1, R19; DL-17: R1, R2, R13; DL-18: R6, R7; DL-19: R7; DL-20: R9; DL-21: R10; DL-22: R3; DL-23: R1, R2, R13; DL-24: R11; DL-25: R5; DL-26: R12, R3; Gate: R15; Backslash: R8.

## Phase 1: stop the critical losses

### R1. Path rules at the API boundary

Fixes DL-03, the `//`, leading `/`, and trailing `/` respellings of DL-09, DL-17, and the server half of DL-23.

**Change**

- A new `src/app/src/server/repo-path.ts` with one function, `checkRepoPath(path, { portable })`, that returns null or the rule a path breaks. `changelist.createChangelist` (which today only converts backslashes, `changelist.ts:392`), `artifact.attachToChangelist`, and the shelf writers call it for every modification's `path` and `oldPath`, and refuse with BAD_REQUEST naming the path and the rule.
- Always on, because these hurt every client:
  - non-empty; forward slashes (after the existing backslash conversion); no leading or trailing `/`; no empty, `.`, or `..` segment;
  - no drive prefix (`C:`), no control characters (U+0000 to U+001F, U+007F), and no lone UTF-16 surrogates;
  - a total length cap (1,024 bytes of UTF-8 is far below every OS's limit and leaves room for the workspace root and the pull's backup folder);
  - no first segment that names the workspace's `.checkpoint` directory on some filesystem. Compare after case folding, after stripping trailing dots and spaces, everything from the first `:` (NTFS streams, such as `.checkpoint::$INDEX_ALLOCATION`), and the code points HFS+ ignores, and refuse its 8.3 short names (`CHECKP~1` and up). This is what git's `verify_path` does for `.git` (`core.protectNTFS`, `core.protectHFS`).
- Portability rules, a repo setting that is on by default (decision 1), applied to every segment: Windows device names with or without an extension and in any case (`CON`, `PRN`, `AUX`, `NUL`, `COM0` to `COM9`, `LPT0` to `LPT9`, their superscript-digit forms, `CONIN$`, and `CONOUT$`); a trailing dot or space; the characters `< > : " | ? *`; more than 255 bytes of UTF-8; and the 8.3 short-name pattern (up to six characters, `~`, digits, and an optional extension of up to three).
- Grandfathering: the portability rules apply to paths a changelist adds (and to `oldPath`), not to edits or deletes of paths the head already has, so a repo that holds `aux.h` keeps working and can rename it. The always-on rules refuse edits too, since no existing path can break them legitimately. Deletes are always allowed.
- Refuse an empty `versionIndex` when any modification is not a delete. This is the cheap half of DL-16; R19 does the rest.
- Rollout: the always-on rules refuse from the first deploy. The portability rules (and R6's fold check) can start in a `log` mode for one deploy, like `state-tree.incremental`'s `verify`, so the logs show what real clients send before anything is refused.
- `scripts/audit-repo-paths.mjs` lists every head path, per branch, that breaks a rule or collides under R6's fold, so existing problems are known before the rules ship (decision 5). It only reads.

**Clients.** The daemon already sends canonical paths (`expandDirectoriesForSubmit` normalizes them, `daemon-manager.ts:782`). Check the Horde client before turning refusal on, since it calls `artifact.attachToChangelist` directly (`src/clients/horde/src/Checkpoint.Api/CheckpointClient.cs:276`).

**Tests.** Turns green in `server.test.ts`: "refuses a path that is not a canonical repo-relative path" (nine spellings), the four DL-17 tests, "refuses paths in a workspace's .checkpoint directory, in every spelling a filesystem folds onto it", the three DL-09 respellings, and the `::$DATA` and `HERO~1.UAS` rows of the OS-spelling test. Add each rule's edges: 255 and 256 bytes, `COM¹`, `LPT0.txt`, `con.tar.gz`, `nul ` with a trailing space, `.checkpoint.`, `.CHECKPOINT::$INDEX_ALLOCATION`, `.check‌point`, `oldPath`, a delete of a grandfathered path, the setting off, and the attach and shelf paths.

The pull-side red-team tests seed their bad changelists through the API, which this step refuses. Reseed them straight into the database, as a server from before this step (or a compromised one) would serve them, so R2 and R13 stay tested.

**Related.** `docs/scaling-plan.md` lists a known hazard that belongs with this step: the tree codec's prefix compression can split a UTF-16 surrogate pair, so names with emoji or other astral characters can decode lossily. A name that decodes differently loses its file the way DL-19 does (deleted under one name, untracked under another). Keep the encoder's shared prefix from ending inside a pair (existing blocks keep their damage; the audit can list names containing U+FFFD), or refuse astral characters here until that is fixed.

### R2. One containment helper in the daemon

Fixes the daemon halves of DL-03, DL-17, and DL-23.

**Change**

- A new `src/core/daemon/src/util/workspace-path.ts`, with `resolveInWorkspace(root, relPath)`, which returns the absolute path or throws `UnsafePathError`. It applies R1's always-on rules, checks that the resolved path stays under `root`, refuses `.checkpoint` in every spelling, and on Windows refuses `:`, so NTFS never takes part of a name as a stream. The rules are mirrored rather than shared, since the app must not depend on `@checkpointvcs/common` (as with `issue-refs.ts`); one table of test vectors runs against both copies.
- Every daemon write, delete, and backup goes through it: the pull's delete pass (`pull.ts:489`) and correction pass (`pull.ts:515` and `:528`), every `LocalChangeGuard` method, `reconcileSyncFilter`, `revertFiles`, Clean Workspace, `conflicts.resolve`, `pullTextFilesForSubmit`, and artifact application.
- A diff path that fails the check is neither pulled nor recorded in the state. A recorded path that cannot exist on disk shows as deleted, and "submit everything" then deletes it for the team, which is DL-17's colon file. The pull lists such paths in a new `unsafePaths` result field, and the desktop shows them. The single-pass selection leaves them out. Until R13 ships, the whole-index fallback refuses to run when an applied index holds one (R4's extended `getPullAnomalies` lists those paths).
- The scan's `.checkpoint` skip (`daemon-manager.ts:1254`) matches the first segment exactly (folded on folding volumes, R7) instead of any name that starts with `.checkpoint`.

**Tests.** Turns green: `pull.test.ts` "never deletes a file outside the workspace for a path that climbs out of it"; `os.test.ts` "does not let a pull replace the workspace's config through ..." (all three spellings) and "leaves nothing pending after pulling a file a Mac or Linux user named with a colon". Add: `..` deep inside a path, UNC and `\\?\` paths, a drive-relative `C:x` on Windows, each `LocalChangeGuard` method, and a symlinked or junctioned directory inside the workspace that points out of it (a follow-up may need to resolve the parent with `realpath` before writing).

### R3. A Team Sync reconcile that cannot delete work

Fixes DL-02, DL-04, and DL-22. All in `reconcileSyncFilter` (`src/core/daemon/src/util/team-sync/sync-pipeline.ts:206`).

**Change**

- When `resolveSyncFilter` reports `repoConfigResolved: false`, skip the reconcile and leave `syncFilterHash` alone: an unknown config is not an empty one. Correct the comment at `sync-pipeline.ts:146`, which holds only for a workspace with no include rules of its own.
- Before deleting an excluded file, call `hasLocalChanges`. Keep a modified file and its state entry, so it stays pending, and list it in the sync result. Never delete a file that is staged, marked for add, or claimed by this workspace.
- Delete one file at a time and drop its state entry as it goes (or in a `finally` for those already removed). Carry on past a file that cannot be removed and report it. Never throw out of the loop.
- When the filter widens (a new hash), pull the paths that the target tree has, the filter now includes, and the state lacks, instead of waiting for them to change upstream. The full list is the diff from the empty changelist 0 (`diffChangelists`), filtered, pulled in one selection pass. Correct the comment at `sync-pipeline.ts:75`.

**Tests.** Turns green: all three in `sync-filter.test.ts`, and `os.test.ts` "does not leave the files a sync filter change removed looking deleted when it cannot remove one". Add: a config that fails for the native-rules call but not for the reconcile's, and the reverse; staged, marked-for-add, and claimed files; a file already deleted locally; a filter narrowed and then widened on successive syncs; and a scheduled sync.

### R4. The pull records only what it wrote

Fixes DL-01 and DL-06.

**Change**

- The state update (`pull.ts:618`) records only the paths the pull wrote: the single-pass `selections`, merged files, and corrected files. A path skipped because the workspace already had it at the incoming changelist keeps its entry, baseline and hash included.
- The protect phase (`pull.ts:262`) decides by content: it skips a path only when the recorded changelist matches and `hasLocalChanges` says the file is unchanged (cheap when size or mtime differ).
- In the whole-index fallback, protect every path that an applied index writes, not just the diff's. Extend `changelist.getPullAnomalies` to return them; the server has them in `FileChange` rows.
- This also covers the two other ways a file's recorded changelist moves ahead of the workspace's: a submit aborted after `pullTextFilesForSubmit` rewrote the file, and `conflicts.resolve`.

**Tests.** Turns green: `pull.test.ts` "keeps an edit made after a submit as a pending change across the next pull", "does not overwrite that edit when the file next changes upstream", and "keeps that edit when the pull falls back to applying whole version indexes". Add one per trigger: a submit while behind, an aborted submit after a pre-submit merge, `conflicts.resolve`, the fallback with a stray and a stale write, and a file whose only change is its mtime.

### R5. A failing pull puts every edit back

Fixes DL-05 and DL-25.

**Change**

- Everything after the protect phase (from `pull.ts:480`: the delete pass, the correction pass, the merges, and the state update) runs in one `try`. Any failure restores the guard's backups before rethrowing, as a native failure already does (`pull.ts:705`).
- `LocalChangeGuard.restoreAll` (`pull-local-changes.ts:198`) restores file by file. It skips a file whose content already equals its backup (the native write never reached it), carries on past a failure, keeps the backup of anything it could not restore, and returns both lists. The pull's error names those files and their backups, instead of a `copyfile` error.
- The delete pass tolerates per-file failures (`EBUSY`, `EPERM`, `EISDIR`, and `ENOTEMPTY`), finishes the pull, and reports what it could not remove. Such a file must not turn into an untracked file that "submit everything" adds back: keep it in a new `pending_removals` state table, retry it at the start of the next pull, and show it as deleted upstream but still on disk, never stageable as an add.

**Tests.** Turns green: `pull.test.ts` "puts local edits back when the pull fails partway"; `os.test.ts` "puts local edits back when a file the pull deletes is open in the Unreal Editor" and "puts every local edit back when the pull cannot write a file open in the Unreal Editor". Add: a failure in each stage after the native pass, several locked files, a lock released before the retry, and a backup folder that cannot be written. The control "does not start writing when an edited file is open in a program that denies all sharing" must keep passing.

## Phase 2: filesystems and the native layer

Three tests in this phase were written on Windows and first run in CI (the README's "Written on Windows"): the macOS normalization test (R7), the Linux and macOS backslash test (R8), and the native file-mode tests (R11). Check their first results in `data-loss.yaml` before starting those steps, in case they fail differently from how the code reads.

### R6. The tree refuses names that fold together

Fixes DL-08, DL-18, and the case spelling of DL-09 (`content/HERO.uasset`).

**Change**

- One fold function, mirrored in the app and the daemon like R1's rules: NFC, then full Unicode case folding, then NFC again, dropping the code points HFS+ ignores. `toUpperCase().toLowerCase()` comes close and over-folds a few pairs such as `ß` and `ss`, which is the safe direction (decision 3). SQLite's `LOWER` and `NOCASE` fold ASCII only, so this cannot be done in SQL; the non-ASCII test catches that.
- The check goes in the tree's `applyChanges` walk (`src/app/src/server/tree/tree.ts:623`), which already loads every directory an edit touches. Once a directory's edits are applied, refuse when two of its entries fold to one key and at least one of them was added by this changelist (a file or a new directory). A case-only rename in one changelist passes, because by then the old name is gone, which keeps the control test green.
- The refusal is a new `TreeCollisionError` kind, which createChangelist turns into BAD_REQUEST and a merge into CONFLICT, as file-versus-directory collisions already are (`changelist.ts:613`, `branch-merge.ts:504`). Merges, shelves, and pull requests get the check with no extra code.
- Collisions already in a repo are grandfathered, since only new names are checked, so those repos keep working. R7 makes the daemon safe with them, and the R1 audit lists them.
- The check is tied to R1's portability setting, so a Linux-only repo can turn both off.
- Paths are stored as sent, not rewritten to NFC (decision 4).

**Tests.** Turns green: `server.test.ts` "refuses a new path that differs from an existing one only in the case of ..." (all four), the two normalization tests, and the case row of the DL-09 OS-spelling test; `os.test.ts` "does not leave two spellings on the server when a case-only rename is submitted as the new file" (with R7's staging rule). The control "accepts a case-only rename made in one changelist" must keep passing. Add fold vectors (`Ä` and `ä`, `ß` and `SS`, `Σ`, `σ`, and `ς`, `İ` and `i`, the Kelvin sign and `k`, NFC and NFD `é`, and Hangul), a directory renamed by case across many files, and a merge where each side added one spelling.

### R7. Folding volumes in the daemon

Fixes DL-07 and DL-19, the daemon sides of DL-08 and DL-18, and the README's HFS+ observation.

**Change**

- Probe each workspace's volume when it is registered and when the daemon starts, as `os.test.ts` does: case sensitivity, normalization sensitivity, and 8.3 short names. Keep the result in the workspace's state meta. Probe the volume rather than going by the OS, since macOS volumes can be case-sensitive and so can Windows directories.
- On a folding volume, key every path comparison by the fold: the state's path index (D3 in `docs/scaling-plan.md`), the full refresh's state lookup (`daemon-manager.ts:1259`) and its deleted-file pass (`:1283`), Clean Workspace's `isTracked` (`src/core/daemon/src/util/team-sync/clean.ts:59`, re-checked at `:210`), and the pull's delete pass.
- The delete pass (`pull.ts:489`) never deletes a file that a path remaining in the target tree still names. It drops the state entry and leaves the file.
- The pull treats a removed path and an added path that fold together as a rename: it renames in place first (`fs.rename` handles a case-only rename on both OSes), then writes. The guard protects the file under its tracked spelling instead of taking it for an untracked file.
- The scan matches a file whose name on disk differs from the state's only by the fold to that state entry (a rename, if the user renamed it), instead of reporting one untracked file and one deleted file. On HFS+, which lists decomposed names whatever was written, the same rule keeps every precomposed non-ASCII path from showing as deleted plus untracked.
- Staging: an untracked file whose name folds onto a locally deleted tracked file is a rename, so staging one stages both. A case rename made in Explorer or Finder then submits as a rename, which R6 accepts.

**Tests.** Turns green: `pull.test.ts` "brings the new content of a file renamed by case only (case-insensitive filesystems)"; `os.test.ts` "keeps Content/Hero.txt when Content/hero.txt is deleted upstream", "leaves nothing pending after pulling a directory the tree spells two ways", "does not let Clean Workspace delete a tracked file in a directory the tree spells two ways", and "keeps Docs/Café.txt when its decomposed spelling is deleted upstream". Add: a case-only rename of a directory, a rename that also changes content, a local rename racing an upstream one, a workspace moved to another volume, and a case-sensitive folder on Windows (`fsutil file setCaseSensitiveInfo`).

### R8. One odd file no longer fails the scan

Fixes Backslash.

**Change**

- The full refresh builds each relative path from the directory entry without rewriting the name. Today it turns backslashes into slashes (`daemon-manager.ts:1250`), which on Linux and macOS names a file that does not exist.
- A name the server would refuse (a backslash on Linux or macOS, a control character, or anything else under R1's rules) shows as an unsupported name that cannot be staged, listed so the user can rename it.
- Errors stay per file: a file that cannot be stat'ed (permissions, or deleted mid-scan) is reported on its own entry and never fails the whole refresh.

**Tests.** Turns green: `os.test.ts` "still submits other changes when a stray file's name contains a backslash". Add: a name with a newline, an unreadable file, and a file deleted between the directory listing and the stat.

### R9. Racily clean baselines are checked by content

Fixes DL-20, with git's answer to the same problem.

**Change**

- Record when each baseline was taken: a `recorded_at` column on the state's `files` rows, set by everything that records a baseline (pull, submit, merge, revert, and resolve). Take the time from the filesystem's own clock, by touching a marker file in `.checkpoint` and reading its mtime (git uses its index file's mtime the same way), so coarse ticks and the skewed clocks of network drives are handled.
- `compareWithBaseline` (`src/core/daemon/src/util/baseline.ts:33`) treats an entry whose mtime is not older than `recorded_at` minus 2 seconds (FAT32's tick, the coarsest) as racily clean. For such an entry, equal size and mtime prove nothing, so the answer is "compare-hash" (today it is "unchanged", `baseline.ts:53`).
- A racily clean entry needs a hash to compare with, so whatever records the baseline hashes the files that are racily clean at that moment. That is only the files written in the operation's last 2 seconds, so the cost stays bounded, and every other pulled file still goes unhashed.

**Tests.** Turns green: `os.test.ts` "still sees a same-size edit made within one timestamp tick of a pull". Add: a 2-second tick (FAT32), a 1-second tick (HFS+), a batch where only the last files are racy, a submit followed by a same-size edit in the same tick, a skewed clock, and state rows without `recorded_at` (from older daemons, which keep today's behavior).

**Residual.** A same-size edit, within one tick, between the native write and the end of the pull, on a volume with a coarse clock, still gets hashed as the baseline. R10's optional hash-on-write closes it.

### R10. Native pulls report what they wrote

Fixes DL-21.

**Change**

- In `pull.cpp` and `pull-selection.cpp`, wrap the workspace's `Longtail_StorageAPI` (from `Longtail_CreateFSStorageAPI`) so that closing a file opened for writing records its size and mtime, and return the list in the handle's result.
- The daemon records those stats instead of stat-ing every pulled file at the end (`pull.ts:622`), the way `submit()` records the stat it took before the native read (`statBeforeSubmit`, `submit.ts:186`). A file whose stat differs by the end of the pull was edited during it, and shows as a local change.
- Optional: hash each file while writing it and return the hash too. That closes R9's residual and gives every pulled file a baseline hash at no extra read. Measure the cost on a large sync first.

**Tests.** Turns green: `pull.test.ts` "does not record an edit made while the pull runs as the version it pulled". The fake addon in `stack.ts` must report stats at write time, as the real one will. Add a native integration test that the reported stats match the files right after a pull, for single-pass and whole-index pulls, including a path the whole-index pull writes twice.

### R11. File modes survive submit and pull

Fixes DL-24.

**Change**

- The native submit records each file's real mode on Linux and macOS (`Longtail_GetFilePermissions`) instead of 0644 (`submit.cpp:457`).
- On Windows, which has no executable bit, the daemon passes each modified file's mode at the head (from the state) and 0644 for new files, as git does with `core.fileMode=false`, so an edit made on Windows never strips `+x` (decision 12).
- A `mode` column in the state's `files` rows. On Linux and macOS a mode-only change (`chmod +x`) shows as pending and can be submitted.
- The pull keeps a local mode change when upstream did not change the mode. After the native write, it restores the mode the file had before the pull if that differed from the recorded base and the incoming mode equals the base.

**Tests.** Turns green: both tests in `native/file-modes.test.ts`. Add: a mode-only change pending and submitted, a mode changed on both sides, and a file executable by its owner only. The Windows side (an edit keeping 0755, a new file at 0644) runs in-process, where the fake addon records the modes it is given.

### R12. The native include filter folds case

Fixes DL-26 (decision 14).

**Change**

- `PathFilter` (`src/longtail/wrapper/src/util/path-filter.h`) folds ASCII case, as the `ignore` package does by default (`filter.ts:127`).
- The daemon withholds any rule containing non-ASCII letters from the native filter, because `ignore` folds those and an ASCII fold would not. Declining native filtering only costs bandwidth: the reconcile filters after the pull.
- Add a version to the filter hash, so every workspace's applied hash changes once and R3's widening re-pull fetches the files earlier syncs skipped.
- The Team Sync settings warn about a rule that matches nothing at the head.

**Tests.** Turns green: `native/include-filter.test.ts` and `os.test.ts` "pulls a folder whose Team Sync rule was typed in another case". Extend the agreement test (both matchers over the same rules and paths) with case variants, non-ASCII names, `**`, `?`, and anchored rules.

### R13. The native layer refuses unsafe asset paths

The native defense for DL-03, DL-17, and DL-23, and the answer to the README's open question about what the native pull does with `..`.

**Change**

- Before `Longtail_ChangeVersion`, `pull.cpp` and `pull-selection.cpp` check every asset path against R1's always-on rules (and `:` on Windows). A failing asset is skipped and reported, never written. That covers the whole-index fallback, which R2 cannot filter.
- The native submit refuses the same paths, so it never reads and uploads a file from outside the workspace.

**Tests.** A native integration test with a version index that holds `../x`, `.checkpoint/workspace.json`, and (on Windows) `a:b`, built where such names can exist (a Linux runner) or assembled through the addon's index API.

## Phase 3: branches and merges

### R14. The active branch, everywhere

Fixes DL-10, DL-11, and DL-12.

**Change**

- One helper decides a workspace's sync target: the deepest active branch, whose head contains its parents' changes, or the domain root when none is active. `branches.switch` already activates exactly one chain (`resolveBranchChain`), but `daemon-manager.ts:292` adds to the existing set, which can leave two sibling branches active. Enforce one chain in both (decision 6).
- Pass `activeBranches` wherever a target is computed: the sync endpoint's workspace (`sync.ts:104`), the scheduled sync, `checkSyncStatus`, `pull()`'s head lookup (`pull.ts:148`), and `writeVersionFiles` (`sync-pipeline.ts:122`).
- The pre-submit steps compare with the submit's target branch, not the domain root: `checkConflicts` (`pending.ts:528`) and `pullTextFilesForSubmit` (`pending.ts:578`).
- Every state entry records the branch whose head it was pulled from or submitted to (`WorkspaceStateFile.branch`, which nothing sets today).
- Every submit sends a base for every modification, and the server compares it with the target head. This drops the comparability rule at `submit.ts:137`, which is not needed once a workspace with a branch active only ever holds that branch's versions. Once a submit says its bases are complete, the server treats a modification with no base on a path the head has as a conflict, not as "not checked" (decision 8).
- How the domain root's changes reach a branch: through R17, as in git (decision 7).

**Status.** Done, except the server-side strictness (a missing base as a conflict once a submit says its bases are complete). The flag would have to travel through the native submit payload and the core server, and the daemon now sends a base for every tracked file, so it is left as a follow-up.

**Tests.** Turns green: `branches.test.ts` "keeps the branch's changes in the workspace when you pull with the branch active", and the three latent tests (still through `submitBehindTheGate` until R15). Add: a stacked chain, deactivating a branch (the pull back to the root), a scheduled sync and sync status with a branch active, a stale submit to a stacked branch, and an older daemon that does not send the flag.

### R15. Staged files keep their branch

Fixes the gate. It lands after R14, because it makes DL-11 and DL-12 reachable.

**Change**

- Staging records a destination: `pending.stage` takes an optional branch (the deepest active branch by default), kept in a new `branch` column of the state's `staged` table.
- The submit endpoint (`pending.ts:503`) and the desktop's bucket view assign a staged file by its recorded destination, then by its claim, and otherwise to the domain root.
- Changed files in the pending list carry their claims, from the `getWorkspaceClaims` call the refresh already makes (`daemon-manager.ts:1237`), instead of `claims: []` (`daemon-manager.ts:1035`).

**Tests.** Turns green: `branches.test.ts` "gate: submits a modified file staged to an active feature branch". Switch the latent tests from `submitBehindTheGate` to `stageAndSubmit(..., { branch: "feature" })`; they must still pass. Add: restaging to another bucket, staging with no branch active, and a file claimed on one branch staged to another (refuse or move it; settle which in review).

### R16. Merges record what they merged

Fixes DL-13.

**Change**

- `Changelist.mergedFromNumber Int?`: the incoming head that a merge changelist merged. `mergeBranch` sets it (the create at `branch-merge.ts:528` records only `parentNumber` today), and so does R17.
- `findMergeBase` (`branch-merge.ts:224`) walks both parent and merged-from edges: a max-heap by changelist number over both heads' ancestries, where the first number reached from both sides is the newest common ancestor. Numbers only decrease along both kinds of edge, so today's ordering argument still holds. `incomingNumbers` becomes the incoming side's changelists that the target cannot reach.
- Restacking needs no change: once `lower`'s merge records `lower`'s head, the merge base of `upper` and `main` is that head.
- A Prisma migration in both providers. Backfill existing merge changelists from their messages, or start fresh (decision 9).

**Status.** Done, without a backfill: merge changelists recorded before this carry no mergedFromNumber, so a stack whose parent merged before it still needs the old workaround once. A backfill from merge messages remains possible if any deployed repo needs it.

**Tests.** Turns green: `server.test.ts` "merges a stacked branch after its parent merged, when both changed the same file in turn". Add: a three-level stack merged bottom-up, the same stack merged top-down, a branch merged after its parent merged twice, and a history longer than one page of `walkChangelistAncestry`.

### R17. Bring a branch's parent into it

Fixes DL-14. It needs R16, so the merge base follows the result, and R14, so a workspace with the branch active syncs it.

**Change**

- Server: `branch.updateFromParent({ repoId, branchName })` merges three ways (base: the merge base of the branch and its parent's head; target: the branch head; incoming: the parent's head). With no conflicts, it records a changelist on the branch whose tree applies the parent's changes, with no version index of its own (like a squash merge) and `mergedFromNumber` set to the parent's head. With conflicts, it refuses and lists them.
- Resolving conflicts: `createChangelist` accepts `mergeFrom: { branchName, headNumber }`. It applies the parent's non-conflicting changes and the submitted resolutions in one changelist on the branch, refuses while any conflicting path is missing from the modifications, and records `mergedFromNumber`. A stale `headNumber` (the parent moved meanwhile) is refused, and the client starts over.
- Daemon and desktop: an "Update from parent" action. It calls the endpoint, and on conflicts pulls the parent's versions of the conflicting files with the branch active, merges text three ways (`autoMergeText`), asks about binaries (keep mine or take theirs), and submits with `mergeFrom`. Against an older server the first call fails, before anything is submitted.
- `describeMergeConflicts` (`branch-merge.ts:185`) names the new action instead of an operation that does not exist.

**Status.** Done on the server and in the daemon, with one change of shape: instead of a submit carrying `mergeFrom` (which would have to travel through the native submit payload), the resolution is an ordinary submit to the branch, and `updateFromParent` is called again naming it as `resolvedInNumber`; the branch keeps its version of each conflicting path that changelist touched. The daemon endpoint (`branches.updateFromParent`) calls the server and pulls the result when the branch is active. Not done: the desktop button and the guided resolution flow (pull the parent's versions, merge text, ask about binaries), which are UI work.

**Tests.** Turns green: `server.test.ts` "merges once a conflict is resolved on the branch, as the refusal says to". Add: an update with no conflicts, a binary conflict, a delete on one side, the parent moving during resolution, an update and then a merge in a stack, and an update of a branch with no changelists of its own.

### R18. Deleting a branch keeps its work reachable

Fixes DL-15.

**Change**

- `branch.deleteBranch` (`branch.ts:300`) and the daemon's `branches.delete` take `discardUnmerged`, false by default. Without it, they refuse a branch that has changelists its parent's head cannot reach, and list them (R16's walk, or today's ancestry walk if this lands first).
- Record every deleted branch head, including the ones `mergeBranch` deletes, in a new `DeletedBranch` table (repo, name, head, parent, who, when, and whether it was merged), and add `branch.restoreBranch`, which recreates the branch at its recorded head, under its old name if that is free (decision 10).
- Release the branch's claims and delete it in one transaction; today they are two separate calls (`branch.ts:367` and `:371`).
- The desktop asks before discarding, as archiving does with `releaseOutstandingClaims` (`branch.ts:186`).

**Tests.** Turns green: `server.test.ts` "refuses to delete a branch whose changelists were never merged, unless told to discard them". Add: a branch with no changelists of its own deletes without the flag, restore after delete, restore when the name is taken, and restoring a branch whose parent was deleted.

## Phase 4: integrity and the smaller observations

### R19. The app records only content that exists

Fixes DL-16.

**Change**

- `createChangelist` and `artifact.attachToChangelist` check that a non-empty `versionIndex` exists under the repo's own storage prefix before recording anything: a system call to the core server, which HEADs the version's block map (written and verified for every submit, N1 in `docs/scaling-plan.md`). This also covers callers that bypass the core server, such as the Horde client's direct attach (decision 11).
- R1 already refuses an empty `versionIndex` with non-delete modifications.

**Tests.** Turns green: `server.test.ts` "refuses a changelist that names no version index for the files it writes". Add: a name that does not exist, another repo's version index name (the check must use this repo's prefix), a delete-only changelist with no index, and an artifact attach.

### R20. The smaller observations

From the README's "Other observations". Each is small, they can land in any order, and none has a red-team test yet, so each brings its own test to the main suite.

- **Reverting an added file** deletes it with `fs.unlink` and no backup. Leave it on disk and unmark it, as Perforce does (decision 15).
- **`conflicts.resolve`** moves a file's recorded changelist without checking for local changes, so resolving a merely outdated file marks stale content current, and its next submit reverts the remote change. When the file has no local changes, pull the remote version instead.
- **`diffStateTrees`** treats a target with no tree as "every file removed". Throw instead, so the pull's safety does not depend on an earlier lookup failing first.
- **The `FileChange` log for merges** points at the merge changelist, which has no version index, so after a merge the log no longer says where merged content lives, while `src/app/src/server/tree/DESIGN.md` says the log is canonical. Record the source changelist on merge rows, or amend DESIGN.md (decision 16).
- **Watcher gaps.** A watcher event with no file name (how Windows reports an overflowed buffer) or a watcher error drops the cached pending list, forcing a full rescan, instead of being ignored (`daemon-manager.ts:1543`).
- **OS litter.** Default ignore rules for `.DS_Store`, `._*`, `Thumbs.db`, and `desktop.ini`, so a Mac "submit everything" does not add them and Explorer holding `Thumbs.db` open cannot fail Windows pulls (DL-05, DL-25).
- **Long paths.** Warn when a path plus the backup prefix (`.checkpoint/pull-backups/<timestamp>-cl<N>/`, about 50 characters) passes 260 characters, and shorten the prefix.

## Moving tests and CI

- Promote `src/tests/src/data-loss/stack.ts` into `src/tests/src/harness/`, so main-suite files can use it. The four hoisted `vi.mock` calls each file needs move with the tests.
- When a step lands, move its red-team tests, with the edge cases its section lists, into the main suite: server tests into `src/tests/src/api/`, in-process stack tests into `src/tests/src/daemon/`, filesystem-probing tests into `src/tests/src/os/`, and native ones into `src/tests/src/integration/`. Mark the finding fixed in the README's table (with the commit), and delete the moved tests from `src/data-loss/`.
- `test.yaml` runs the main suite on Linux and Windows, which covers most moved tests. The macOS-only ones (DL-18, and DL-07 and DL-19 on APFS) need a macOS leg (decision 13). Native tests that need services join `yarn test:integration`.
- `data-loss.yaml` stays red until the last finding on each OS is fixed, on purpose. Once `src/data-loss/` has no failing tests, either keep it for future red-team findings or remove the workflow and its configs.

## Needs you

Each decision is also noted in its step; the first option is the recommendation.

- **Decisions**
  1. **Portability rules** (R1, R6): on by default as a repo setting, with an opt-out for Linux-only teams; or off by default. The 8.3 pattern can refuse a real `FILE~1.TXT`, which seems an acceptable cost.
  2. **Benign respellings** (R1): refuse `//`, a leading `/`, and a trailing `/`, as the tests assert, since our daemon already sends canonical paths; or normalize them on the server. Normalizing would also close DL-09, but would leave two spellings on the wire.
  3. **Fold strength** (R6): accept `toUpperCase().toLowerCase()`, which over-folds a few pairs such as `ß` and `ss` (the safe direction); or ship a table from Unicode's `CaseFolding.txt`.
  4. **NFC** (R6): store paths as sent and refuse only fold collisions; or store new paths in NFC, which would rename files under Linux users whose names are decomposed on disk.
  5. **Existing bad paths and collisions** (R1, R6): run the audit on each deployed repo and grandfather what it finds, so teams can rename at their own pace; or rename everything before the rules ship.
  6. **One active chain per workspace** (R14): yes, enforced in both activation paths; or support sibling overlays, which have no single head to check bases against.
  7. **How a parent's changes reach a branch** (R14, R17): an explicit update, as in git; or a live overlay of the branch on the domain head at every sync.
  8. **Strict bases** (R14): a `basesComplete` flag on submits from new daemons, so older daemons keep working; or a storage protocol bump that refuses older daemons.
  9. **Merge provenance backfill** (R16): backfill `mergedFromNumber` from merge messages (the first line names the branches, and the highest changelist the body lists was the incoming head); or start fresh.
  10. **Deleted branches** (R18): a `DeletedBranch` table with restore; or a soft delete on `Branch`, which would block reusing the name under the unique `(repoId, name)` index.
  11. **Version check** (R19): ask the core server, which covers the Horde client's direct attach; or have the core server sign an attestation, which saves a round trip but would make Horde upload through it.
  12. **Windows-created files** (R11): 0644, as git does; add a way to mark one executable from Windows (a `checkpoint chmod +x`) only if teams ask.
  13. **macOS in the main CI** (moving tests): add a macOS leg to `test.yaml` for the OS tests (in-process, a few minutes); or keep them in `data-loss.yaml`.
  14. **Filter case** (R12): fold case in both matchers; or make both case-sensitive and warn about rules that match nothing.
  15. **Reverting an added file** (R20): keep the file on disk, as Perforce does; or delete it with a backup.
  16. **The merge log** (R20): record the source changelist on merge rows, which keeps the invariant `tree/DESIGN.md` relies on (the tree can be rebuilt from the log); or amend DESIGN.md to make the tree canonical for where content lives.

- **Actions**
  - Prisma migrations in both providers: the portability setting on `Repo` (R1, R6), `Changelist.mergedFromNumber` (R16), and `DeletedBranch` (R18). Author SQLite with `migrate diff` and Postgres by hand, then run `yarn --cwd src/app db:migrate:deploy` on every deployed database.
  - One addon release for R10 to R13 (and R11's submit change). Bump with `node scripts/set-addon-version.js <version>`, and publish before deploying the daemon. CI is unaffected, since it builds the addon from source.
  - Run `scripts/audit-repo-paths.mjs` (R1) on each deployed repo before turning on the portability and fold rules.
  - Deploy the core server's version check before turning on R19's check in the app.
  - The daemon's state schema changes (`recorded_at`, `mode`, the `staged` branch, `pending_removals`, and the volume probe) are stepwise migrations in `state-store.ts` (`MIGRATIONS`), so steps can land in any order. Nothing to deploy separately.

- **Known hazards**
  - Edits that DL-01, DL-20, or DL-21 already hid stay hidden: these fixes stop new cases, but a file that already dropped out of pending changes stays out until it changes again. Consider a one-time "Verify workspace" (index the folder natively, diff it against the synced version, and list files that differ but are not pending), run once per workspace after R4, R9, and R10 ship.
  - R9's residual window (above), until R10 hashes on write.
  - A daemon downgraded past the new state migrations writes rows without the new columns. Treat a missing `recorded_at` as today's behavior, and a missing mode as "keep the mode on disk".
  - Grandfathered paths and collisions stay in their repos until someone renames them. R2 and R7 keep them from losing data in the meantime.
