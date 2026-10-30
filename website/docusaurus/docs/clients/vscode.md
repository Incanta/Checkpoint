---
sidebar_position: 3
---

# VS Code Extension

The Checkpoint extension adds Checkpoint to Visual Studio Code's Source Control view, so you can stage, check out, diff, submit, and pull without leaving the editor.

## Requirements

- VS Code 1.96 or newer.
- The Checkpoint daemon running on the same machine. Installing the [desktop app](./desktop-app.md) takes care of this.
- A workspace created with the desktop app, the [CLI](./cli.md) (`chk init`), or the Unreal plugin. Open the workspace folder (or any folder inside it) in VS Code. The extension recognizes a Checkpoint workspace by its `.checkpoint/workspace.json` file.

## Install

Release builds are published to the Visual Studio Marketplace and to Open VSX (where editors built on VS Code, such as Cursor, VSCodium, and Windsurf, get their extensions). Search the Extensions view for **Checkpoint** by **Incanta**, or install it by ID:

```bash
code --install-extension incanta.checkpoint-vscode
```

Each [GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest) also has the extension attached as a `.vsix` file. Install a downloaded `.vsix` with:

```bash
code --install-extension checkpoint-vscode-<version>.vsix
```

:::tip
Nightly builds of the extension are only available as a `.vsix` on the `nightly` prerelease on GitHub, since the marketplaces do not accept prerelease version numbers.
:::

## Sign in

If you already signed in with the desktop app or CLI, there is nothing to do: the extension uses the daemon's saved logins. Otherwise, open the Command Palette and run one of:

- **Checkpoint: Sign In (Device Code)** to sign in through your browser.
- **Checkpoint: Sign In with API Token** to paste a server URL and an API token (create one in the web app under **Settings > Devices**).

**Checkpoint: Sign Out** removes a login.

## Features

### Source Control view

Pending changes appear in the Source Control view in this order:

1. **Conflicts**, if a pull left any.
2. Each branch's default changelist, then each numbered pending changelist.
3. **Unstaged Changes**. Untracked files show as `U`, and as `A` once staged. Folders with no tracked files are listed file by file (up to a limit, see `checkpoint.untrackedFolderFileLimit` below).

Type a message in the input box and press **Ctrl+Enter** (or use **Submit Changes** in the view's toolbar) to submit, with progress reported while the job runs.

### Staging and changelists

- Right-click files in Unstaged Changes to **Stage Changes**. Right-click staged files to **Unstage Changes**, **Move to Branch...**, or **Move to Changelist...**.
- **New Pending Changelist** creates a numbered changelist. Right-click a changelist's header to **Submit Changelist**, **Edit Changelist Description**, or **Delete Changelist**.
- Stage only part of a text file: in a diff, use **Stage Block** on a change in the gutter, **Stage Selection** for selected lines, or **Stage Selected Ranges** from the editor's title bar or context menu. **Revert Selected Ranges** discards selected changes instead.

### Checkouts and reverting

- **Check Out File** and **Check Out File (Locked)** (an exclusive claim) are in the Command Palette for the active file. **Undo Checkout** releases a checkout.
- **Revert Changes** restores a file to its head version.
- **Revert if Unchanged** reverts the selected files only if their content matches the head version. **Revert Unchanged Files** in the view's toolbar does that for every pending file.
- **Mark Conflicts as Resolved** clears a file from Conflicts once you have fixed it.

### Diffs and decorations

- Quick diff markers in the editor gutter show changes against the head version, and **Open Changes** opens a full diff.
- Files show Checkpoint status badges and colors in the Explorer and on editor tabs. Files ignored by `.chkignore` are greyed out in the Explorer (see [Ignoring files](../guides/ignoring-files.md)).

### Syncing, branches, and history

- The status bar shows the current branch (click to switch branches) and the sync status (click to pull).
- **Pull Latest** syncs the workspace and reports any merges and conflicts.
- **Switch Branch** and **Create Branch** are in the view's toolbar and the Command Palette.
- **Show Changelist History** browses the branch's history with diffs, and **Show File History** shows the history of the current file.

### Toolbar

The Source Control view's toolbar has **Submit Changes**, **Pull Latest**, **Refresh**, **Switch Branch**, **Create Branch**, **Show Changelist History**, **Revert Unchanged Files**, and **New Pending Changelist**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `checkpoint.autoRefresh` | `true` | Refresh pending changes automatically when files in the workspace change. |
| `checkpoint.autoRefreshDelay` | `1000` | Milliseconds to wait after the last file change before refreshing. |
| `checkpoint.autoRefreshMaxDelay` | `5000` | Longest a refresh can be put off (in milliseconds) while files keep changing, so a long build or an AI agent rewriting files cannot block refreshes entirely. |
| `checkpoint.autoRefreshExcludeDirs` | `[".git", "node_modules"]` | Folder names whose changes never trigger a refresh. Matches any path segment. `.checkpoint` is always excluded. |
| `checkpoint.untrackedFolderFileLimit` | `5000` | Folders with no tracked files are listed file by file (so you can stage single files) when they hold up to this many files and subfolders. Larger folders stay a single row. `0` never lists them. |
| `checkpoint.syncStatusInterval` | `60` | Seconds between checks for whether the workspace is behind the server. Minimum `10`. |
| `checkpoint.daemonPort` | `0` | Port of the local daemon. `0` reads it from `~/.checkpoint/daemon.json` (normally `13010`). |

## Troubleshooting

If the extension shows "the local daemon is not reachable", start the desktop app or use **Start Daemon** in the tray menu, then choose **Retry**. The extension also keeps retrying in the background. See [Troubleshooting](../troubleshooting.md) for more.
