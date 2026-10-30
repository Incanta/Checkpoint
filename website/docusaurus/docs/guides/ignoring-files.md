---
sidebar_position: 2
title: Ignoring Files
---

# Ignoring Files

Most projects produce files that should never be submitted: build output, editor caches, logs, and local settings. A `.chkignore` file tells Checkpoint to leave them out. It works like Git's `.gitignore`.

A second file, `.chkhidden`, handles a different case: files that *are* in the repo, but whose local changes you never want to see or submit.

## Quick start

Create a file named `.chkignore` at the root of your workspace, list one pattern per line, and submit it so the whole team shares the same rules. For an Unreal Engine project, a good start is:

```gitignore
# Build output and caches
Binaries/
Intermediate/
Saved/
DerivedDataCache/
.vs/

# IDE and project files generated locally
*.sln
*.VC.db
.idea/

# Logs
*.log
```

Checkpoint notices edits to `.chkignore` on its own. If the desktop app still shows a file you just ignored, open the **Refresh** dropdown on the **Files** or **Pending** tab and choose **Refresh (Reload Ignore/Hidden)**.

## Ignore rules only apply to untracked files

As in Git, `.chkignore` only affects files that are **not already in the repo**. If a file has already been submitted, adding a rule that matches it changes nothing: edits to it still show up as pending changes, and deleting it still shows as a delete.

To stop tracking a file that is already in the repo:

1. Add a rule for it to `.chkignore`.
2. Delete the file (or move it out of the workspace), then stage and submit the deletion.

From then on, a new copy of the file at that path is ignored.

If what you want is to keep a file in the repo but stop seeing your local changes to it, use [`.chkhidden`](#hide-local-changes-with-chkhidden) instead.

## Pattern syntax

`.chkignore` uses the same pattern syntax as `.gitignore`:

| Pattern | Matches |
| --- | --- |
| `*.log` | Any file ending in `.log`, in any folder |
| `Saved/` | Any folder named `Saved` and everything in it (a trailing `/` matches folders only) |
| `/Build` | `Build` at the root only (a leading `/` anchors the pattern) |
| `Config/Local.ini` | That path, relative to the folder holding the `.chkignore` |
| `Content/**/Temp` | `Temp` at any depth under `Content` |
| `Shot_??.exr` | `?` matches one character |
| `[Tt]emp/` | `[...]` matches one of the listed characters |
| `!Keep.log` | Negation: un-ignores something an earlier rule ignored |
| `# comment` | Lines starting with `#` are comments; blank lines are ignored |

A few details:

- **A pattern containing a `/`** (other than at the very end) is anchored to the folder the `.chkignore` file is in. A pattern with no `/` matches at any depth below it.
- **Matching ignores letter case.** `*.PNG` and `*.png` are the same rule.
- **Backslashes are path separators,** so Windows-style rules like `Saved\Logs\` work. Unlike Git, a backslash is not an escape character, so you can't escape a leading `#` or `!`.
- **Later rules win.** A `!` rule only un-ignores files matched by earlier rules. As in Git, you can't un-ignore a file inside a folder that is itself ignored, because Checkpoint never looks inside ignored folders.

## Nested `.chkignore` files

You can put a `.chkignore` in any folder. Its rules apply to that folder and everything below it, and are read after the rules from the folders above, so a deeper file can override a shallower one with `!`. A `.chkignore` inside an ignored folder is never read.

## Ignore files from the desktop app

Right-click an untracked file in the desktop app and choose **Add to ignored list**. You can ignore the file's name, every file with its extension (`*.ext`), or its exact path. The rule is added to the `.chkignore` at the workspace root. **Remove from ignored list** takes it out again.

## Hide local changes with `.chkhidden`

Some files belong in the repo but get rewritten by tools on every run, such as editor layout files or per-user settings with shared defaults. You need them in the repo, but you don't want your local changes cluttering the Pending view or ending up in a submit.

List those files in a `.chkhidden` file. It uses the same syntax and nesting rules as `.chkignore`. Files it matches:

- stay in the repo (hiding a file does not delete or untrack it);
- never show up as pending changes, even when you edit or delete them locally;
- are therefore never staged or submitted from your workspace.

If a file matches both `.chkignore` and `.chkhidden`, hidden wins.

To submit a deliberate change to a hidden file, remove (or negate with `!`) its rule, submit the change, and put the rule back.

In the desktop app, right-click a file and choose **Add to hidden changes list** or **Remove from hidden changes list**. These edit the `.chkhidden` at the workspace root.

## Ignored by default

A few files are ignored everywhere, even without a `.chkignore`, because operating systems create them on their own:

- `.DS_Store` and `._*` (macOS)
- `Thumbs.db` and `desktop.ini` (Windows)

If your project really needs one of them, un-ignore it with a `!` rule, for example `!desktop.ini`.

## What can never be submitted

Some things are left out no matter what your ignore files say:

- **The `.checkpoint` folder** at the root of each workspace. It holds the workspace's own bookkeeping. A path whose first folder is `.checkpoint` is refused, in any spelling.
- **Other workspaces nested inside yours**, including [linked repos](./linked-repos.md) mounted in a subfolder. Their files belong to their own repo, so stage and submit them from that workspace.
- **Links to folders** (symbolic links and Windows junctions). Checkpoint does not follow them, so nothing inside them is submitted. A link to a *file* is submitted as a copy of the file it points to.
- **Paths that some OS can't store,** such as names with `< > : " | ? *`, names ending in a dot or space, or reserved Windows names like `CON` and `NUL`. The submit is refused and tells you which path is the problem.

## Related patterns elsewhere

[Team Sync](./team-sync.md) and [artifact uploads](./artifacts-and-ci.md) also take lists of path patterns (for example, which artifact files to collect). They use the same `.chkignore`-style syntax.
