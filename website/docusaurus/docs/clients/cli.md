---
sidebar_position: 2
---

# CLI

`chk` is Checkpoint's command-line client. It does everything the desktop app's core workflow does (staging, checkouts, submitting, syncing, branches, and history), and it can run on build machines and servers with no desktop app installed.

The CLI is also installed as `checkpoint`. Both names run the same program; this page uses `chk`.

## Install

There are two ways to get the CLI.

**With the desktop app.** Every desktop installer includes `chk` and puts it on your `PATH`. Nothing else to do. See [Desktop App](./desktop-app.md).

**Standalone (headless).** For CI agents, servers, and anyone who does not want the desktop app, download a command-line package from [checkpointvcs.com/download](https://checkpointvcs.com/download) (under "Command-line tools") or the [latest GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest). These packages contain the CLI and a bundled copy of the daemon, and need nothing else.

| Platform | File |
| --- | --- |
| Windows (x64), portable | `checkpoint-cli-win32-x64.zip` |
| macOS (Apple Silicon), portable | `checkpoint-cli-darwin-arm64.tar.gz` |
| macOS (Intel), portable | `checkpoint-cli-darwin-x64.tar.gz` |
| Linux (x64), portable | `checkpoint-cli-linux-x64.tar.gz` |
| Debian / Ubuntu | `checkpoint-cli_<version>_amd64.deb` |
| Fedora / RHEL | `checkpoint-cli-<version>.x86_64.rpm` |

Extract a portable archive anywhere and add its folder to your `PATH`. Keep the `resources` folder next to `chk`, since that is where the bundled daemon lives. The `.deb` and `.rpm` packages install `chk` to `/usr/bin` for you. Neither installs the daemon as a service.

## How the CLI finds the daemon

All the real work happens in the Checkpoint daemon. The CLI connects to it on `127.0.0.1` (the port comes from `~/.checkpoint/daemon.json`, default `13010`).

When the desktop app is installed, its daemon is already running and the CLI uses it. When no daemon is running (or you force it), the CLI starts its bundled daemon in **daemonless mode**: a short-lived daemon scoped to the current workspace. It stays warm between back-to-back commands and shuts itself down after about 45 seconds of inactivity. Its log is `~/.checkpoint/logs/ephemeral-daemon.log`.

To force daemonless mode even when a resident daemon is running, pass `--no-daemon` before the command (`chk --no-daemon status`) or set `CHECKPOINT_DAEMONLESS=1`.

Run commands from inside a workspace. The CLI walks up from the current directory until it finds a `.checkpoint/workspace.json`.

## Sign in

### Interactively

```bash
chk login --endpoint https://checkpoint.example.com
```

The CLI prints a URL and a device code, and tries to open your browser. Confirm the code in the web app and the CLI finishes signing in. It waits up to five minutes.

:::caution
`--endpoint` defaults to `http://localhost:13000`. Always pass your team's server URL unless the server is running on the same machine.
:::

### With an API token (CI and servers)

For machines with no browser, create an API token in the web app under **Settings > Devices**: give it a name, leave **Device Code** empty to get a copyable token, and pick an expiration. Then:

```bash
chk login --endpoint https://checkpoint.example.com --token "$CHK_TOKEN"
```

### With environment variables only

Instead of logging in, a CI job can set two environment variables. Nothing is written to disk.

```bash
export CHECKPOINT_API_TOKEN="..."
export CHECKPOINT_ENDPOINT="https://checkpoint.example.com"
chk pull
```

An environment token takes precedence over any saved login. `CHECKPOINT_ENDPOINT` is only needed when there is no saved login for that workspace.

:::note
Environment-variable auth covers commands run inside an existing workspace. `chk init`, `chk unlink`, and `chk accounts` look at saved logins, so use `chk login --token` on a machine where you need to create workspaces.
:::

## A typical session

```bash
mkdir MyGame && cd MyGame
chk init my-studio/MyGame     # link this folder to a repository
chk pull                      # download the files

chk checkout Content/Hero.uasset
# ...edit...
chk status
chk add Content/Hero.uasset
chk submit -m "Hero: new idle animation"
```

See [Everyday workflow](../guides/workflow.md) for the concepts behind staging, checkouts, and changelists.

## Command reference

Global options, given before the command:

| Option | Description |
| --- | --- |
| `--no-daemon` | Never use a resident daemon. Start a short-lived one for this command. |
| `-h`, `--help` | Show help. Works after any command too, for example `chk submit --help`. |
| `-v`, `--version` | Print the CLI version. |

### Workspaces and accounts

#### `chk init [org/repo]`

Create a workspace in the current directory, named after the directory. With no argument, it asks you to pick an organization and repository interactively. The repository must already exist (create it in the web app). `init` does not download files; run `chk pull` afterwards.

| Option | Description |
| --- | --- |
| `-b`, `--branch <name>` | Branch the workspace starts on. Default `main`. |
| `--account <email or username>` | Which saved login to use when you are signed in to several. Skips the picker, which is useful in CI. |

#### `chk unlink`

Pick a workspace (interactively) and stop the daemon tracking it. The files and the `.checkpoint` folder stay on disk.

#### `chk login`

Sign in to a Checkpoint server. See [Sign in](#sign-in).

| Option | Description |
| --- | --- |
| `-e`, `--endpoint <url>` | Server URL. Default `http://localhost:13000`. |
| `-t`, `--token <token>` | Log in non-interactively with an API token. |
| `--id <id>` | ID to store this login under. Generated if omitted. |

#### `chk logout`

Pick a saved login (interactively) and sign out of it.

#### `chk accounts`

List saved logins with their name, email, ID, and server.

### Pending changes

#### `chk status`

Show the current branch, whether you are behind the server, and your pending changes: each branch's default changelist, each numbered pending changelist (including empty ones), and changes not yet staged.

#### `chk add <file...>`

Stage files for the next submit, including new files. Staged files go into the domain branch's default changelist unless you say otherwise.

| Option | Description |
| --- | --- |
| `-b`, `--branch <name>` | Stage into this branch's default changelist instead. |
| `-c`, `--changelist <id>` | Stage into a numbered pending changelist. Cannot be combined with `-b`. |
| `-p`, `--patch` | Interactively stage individual hunks of one text file. Takes exactly one file and no `-c`. |

#### `chk move (-b <branch> | -c <id>) <file...>`

Move staged files to a different branch's default changelist (`-b`, the branch must be active in this workspace) or to a numbered changelist (`-c`). Give exactly one of the two.

#### `chk restore [--staged] <file...>`

With `-s` / `--staged`, unstage the files (they stay modified on disk and leave their changelist). Without it, revert the files to their head version and undo any checkout, the same as `chk revert`.

#### `chk checkout <file>`

Check out a file you intend to edit. Files that cannot be merged (binary assets such as `.uasset`) get an exclusive claim automatically, so nobody else can edit them at the same time.

| Option | Description |
| --- | --- |
| `-x`, `--exclusive` | Take an exclusive claim even on a mergeable file. |

#### `chk revert <file...>`

Discard local changes to the files and restore their head version.

| Option | Description |
| --- | --- |
| `-a`, `--unchanged` | Only revert files whose content is identical to the head version. With no files given, applies to all pending changes. Handy for releasing checkouts you never actually changed. |

#### `chk chmod (+x | -x) <file...>`

Mark files as executable (`+x`) or not (`-x`) in their next submit. Works on Windows, which has no executable bit of its own.

#### `chk diff <file>`

Print a simple line diff of a file against its head version.

#### `chk clean`

Restore the workspace to a pristine copy of its current changelist: revert local modifications to tracked files, **delete untracked files and folders**, and release checkouts held by this workspace. Asks you to type `YES` first.

| Option | Description |
| --- | --- |
| `-y`, `--yes` | Skip the confirmation (for CI). |
| `--no-progress` | Hide the progress bar. |

### Pending changelists

`chk changelist` (alias `chk cl`) manages numbered pending changelists: groups of staged files that submit together. Each one belongs to a branch and submits there. Every branch also has an unnumbered default changelist. The grouping is stored locally in the workspace.

| Command | Description |
| --- | --- |
| `chk cl new [-m <msg>] [-b <branch>]` | Create an empty changelist and print its id. `-b` sets the branch it submits to (default: the domain branch). |
| `chk cl list` | List changelists and their file counts. Also what `chk cl` does with no action. |
| `chk cl edit <id> -m <msg>` | Set a numbered changelist's description. |
| `chk cl edit default -m <msg> [-b <branch>]` | Set the description of a branch's default changelist. |
| `chk cl delete <id>` | Delete a changelist. Its files stay staged in their branch's default changelist. |

### Submitting and syncing

#### `chk submit`

Submit one changelist as a new version. By default that is the domain branch's default changelist. Without `-m`, the changelist's description is used as the message. A submitted numbered changelist is deleted; a default changelist's description is cleared.

| Option | Description |
| --- | --- |
| `-m`, `--message <msg>` | Submit message. |
| `-b`, `--branch <name>` | Submit this branch's default changelist. |
| `-c`, `--changelist <id>` | Submit a numbered changelist. Cannot be combined with `-b`. |
| `--no-progress` | Hide the progress bar. |

#### `chk pull`

Sync the workspace to the head of its branch.

| Option | Description |
| --- | --- |
| `-c`, `--changelist <n>` | Sync to a specific changelist instead of the head. |
| `--skip-links` | Sync only this workspace and leave its [linked repos](../guides/linked-repos.md) where they are. |
| `--confirm-links <name...>` | Move these linked repos even though they have local changes, are ahead of their pin, or another workspace moved them. |
| `--no-progress` | Hide the progress bar. |

### History and branches

#### `chk log`

Show changelist history, newest first (up to 100 by default), with author, date, and message. Long output is paged.

| Option | Description |
| --- | --- |
| `-l`, `--limit <n>` | Show at most `n` changelists. `chk log -5` is shorthand for `--limit 5`. |

#### `chk branch`

List branches with their type, head changelist, and parent. The current branch is marked with `*`.

#### `chk switch <branch>`

Switch the workspace to another branch.

#### `chk merge <branch>`

Merge a branch into the current branch. Prints the merge changelist it created. See [Branches and merging](../guides/branches-and-merging.md).

### Team Sync artifacts

#### `chk artifact upload <changelist> -t <type> [files...]`

Upload build outputs (such as precompiled editor binaries) and attach them to a changelist as an artifact set. With no files named, it collects the files that `teamsync.yaml`'s include and exclude patterns select for that type, and replaces the set. Named files and folders are added to the set. `.chkignore` never applies. See [Artifacts and CI](../guides/artifacts-and-ci.md).

| Option | Description |
| --- | --- |
| `-t`, `--type <type>` | Artifact type, as defined in `teamsync.yaml`. Required. |
| `--replace` | Replace the type's set at that changelist instead of adding to it. |
| `-m`, `--message <msg>` | Upload message. |

### Maintenance

#### `chk update [check | install]`

`check` (the default) asks for the latest release and tells you whether an update is available. `install` downloads and runs the installer, which stops the daemon, tray, and desktop app and restarts them afterwards. `-y` / `--yes` skips the confirmation. This manages the desktop installation; in headless setups, update by downloading the newest CLI package instead.

#### `chk mcp [status | enable | disable]`

Show, enable, or disable the daemon's MCP server, which exposes Checkpoint to AI tools. Applies immediately and is remembered. Needs a running resident daemon.

#### `chk bug-report`

Collect the daemon's logs, version information, and a summary of each workspace into a zip in `~/.checkpoint/bug-reports/`, and print its path. Tokens, passwords, email addresses, and your username are redacted; `README.txt` inside lists what was removed. Look it over, then attach it to your bug report. This works even when the daemon and CLI versions do not match.

#### `chk redact <file>`

Write a redacted copy of any log file using the same rules as `bug-report`. Useful for server logs from a self-hosted install, for example the output of `docker compose logs`. The original is left unchanged.

| Option | Description |
| --- | --- |
| `-o`, `--output <path>` | Where to write the copy. Default `<name>.redacted<ext>` next to the original. |

## Environment variables

| Variable | Description |
| --- | --- |
| `CHECKPOINT_API_TOKEN` | API token to authenticate with. Takes precedence over saved logins. |
| `CHECKPOINT_ENDPOINT` | Server URL to use with `CHECKPOINT_API_TOKEN` when there is no saved login. |
| `CHECKPOINT_DAEMONLESS` | Set to `1` to force daemonless mode, like `--no-daemon`. |
| `CHECKPOINT_DAEMON_BIN` | Folder containing the bundled daemon, if it is not in its usual place next to the CLI. |
| `PAGER` | Pager for `chk log` on macOS and Linux. Default `less -FRX`. |
