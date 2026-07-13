# Checkpoint for Visual Studio Code

A VS Code SCM extension for [Checkpoint](https://checkpointvcs.com). Like every Checkpoint client, it is a thin front-end over the local Checkpoint daemon's tRPC API; the daemon owns all filesystem and server interaction.

## Features

- Source Control view with Checkpoint pending changes, split into Conflicts, Pending Changes, and Local Files groups
- Submit from the SCM input box (Ctrl+Enter), with job progress reporting
- Pull latest with auto-merge results and conflict reporting
- Quick diff gutter and head-vs-working diffs backed by the daemon's Longtail storage
- File decorations (badges and colors) in the explorer and editor tabs
- Status bar items for the current branch (switch branches) and sync status (pull)
- Check out and lock files, undo checkouts, mark and unmark files for add, revert changes
- Changelist and per-file history browsing with diffs
- Branch switching and creation
- Sign in via device code or API token

## Requirements

The extension talks to the Checkpoint daemon on `127.0.0.1` (port from `~/.checkpoint/daemon.json`, default `13010`). The daemon must be running; it is started automatically by the Checkpoint desktop app or tray, or run it directly from `src/core/daemon`.

A folder is recognized as a Checkpoint workspace when it (or an ancestor) contains `.checkpoint/workspace.json`, which the daemon writes when a workspace is created.

## Development

From the repository root:

```bash
yarn install
yarn build          # builds app lib, common, and core (daemon types must exist)
cd src/clients/vscode
yarn build          # typecheck + bundle to dist/extension.js
```

Then open this folder in VS Code and press F5 (Run Extension) to launch an Extension Development Host. Use `yarn watch` to rebuild on change.

To produce a `.vsix` package: `yarn package`.

## Settings

- `checkpoint.autoRefresh`: refresh pending changes on file system events (default `true`)
- `checkpoint.syncStatusInterval`: seconds between remote sync status checks (default `60`)
- `checkpoint.daemonPort`: override the daemon port (`0` reads `~/.checkpoint/daemon.json`)
