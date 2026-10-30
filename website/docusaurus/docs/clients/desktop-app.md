---
sidebar_position: 1
---

# Desktop App

The Checkpoint desktop app is where most people on your team will work day to day: browsing files, checking out and staging changes, submitting, syncing, and looking through history. It also installs the pieces every other client relies on: the background daemon, the tray app, and the `chk` command-line tool.

## Install

Download the installer for your platform from [checkpointvcs.com/download](https://checkpointvcs.com/download) or from the [latest GitHub Release](https://github.com/Incanta/Checkpoint/releases/latest).

| Platform | File |
| --- | --- |
| Windows (x64) | `Checkpoint-Windows-x64-<version>-Setup.exe` |
| macOS (Apple Silicon) | `Checkpoint-macOS-arm64-<version>.pkg` |
| macOS (Intel) | `Checkpoint-macOS-x64-<version>.pkg` |
| Debian / Ubuntu | `Checkpoint-Linux-amd64-<version>.deb` |
| Fedora / RHEL | `Checkpoint-Linux-amd64-<version>.rpm` |

The installer sets up:

- **The desktop app.**
- **The daemon**, a background service that watches your workspaces and does all the work of syncing and submitting. Every client (desktop, CLI, VS Code, and Unreal) talks to it.
- **The tray app**, which starts when you log in.
- **The `chk` CLI**, added to your `PATH`. See [CLI](./cli.md).

How the daemon runs depends on your platform:

- **Windows:** the tray app starts the daemon and restarts it if it crashes. The installer checks for the Microsoft Visual C++ x64 runtime and offers to install it if it is missing, since the daemon will not start without it.
- **macOS:** the daemon and tray run as launchd agents for your user.
- **Linux:** the daemon runs as a systemd service for the user who ran the installer, and the tray is added to that user's autostart.

## Sign in

When you first open the app, it asks for your **Server URL**. Enter the address of your team's Checkpoint server (for a self-hosted server this usually looks like `http://your-server:13000`) and select **Sign in**.

The app then shows a short device code. Select **Open authorization page**, sign in to the web app in your browser if needed, and confirm the code. The desktop app finishes signing in on its own once you confirm.

You can be signed in to more than one account or server at once. On the Dashboard, open the **Accounts** menu and choose **Add login credentials...** to add another, or **Logout** to sign out of the selected one.

## The tray app

The tray app is Checkpoint's always-on presence in your system tray (menu bar on macOS). It keeps running when the desktop app is closed. Its menu shows:

- The installed Checkpoint version, and a warning if the daemon needs an upgrade to work with your server.
- **Daemon status** (Running, Stopped, and so on), with **Start Daemon**, **Stop Daemon**, and **Restart Daemon**.
- **Update status**, with **Download update** and **Install update & restart** when an update is available.
- **MCP Server**, a checkbox that turns the daemon's MCP server (which exposes Checkpoint to AI tools) on or off.
- A status line for the job that is running right now (for example "Syncing" or "Building" a workspace), also shown in the tray tooltip.
- **Sync Latest**, a submenu listing your workspaces. Pick one to pull it to the latest changelist without opening the desktop app.
- **Open Desktop App** and **View Logs** (opens the Checkpoint log folder).

## Create a workspace

A workspace is a folder on your computer linked to a repository. Repositories are created in the web app; the desktop app creates workspaces for them.

1. On the Dashboard, pick your organization from the **Orgs** menu. Its repositories are listed on the left.
2. Select the **+** button next to a repository (**Create new workspace...**).
3. Enter a **Workspace Name** and a **Workspace Path** (use **Browse** to pick a folder), then select **Create Workspace**.
4. Select **Open workspace** next to the new workspace, then select **Pull** on the Files tab to download the repository's files.

New workspaces start on the `main` branch. Each workspace on the Dashboard also has an **Unlink workspace** button. Unlinking stops Checkpoint from tracking the folder but does not delete any files.

:::tip
To get back to the Dashboard from a workspace, open the workspace menu at the top left and choose **Configure...**.
:::

## The workspace window

The top bar shows the current workspace (use its menu to switch workspaces), the current branch (with a `+N` count when other branches are active in the workspace), and a **Team Sync** button. The status bar at the bottom shows whether you are up to date. Click it to refresh, or to preview incoming changes before you pull. The preview lists every incoming file and shows its diff.

The sidebar has five tabs. You can collapse it to icons.

### Files

A tree of everything in the workspace, with each file's status, size, modified date, type, and the changelist it came from. Use **Refresh** to rescan (or **Refresh (Reload Ignore/Hidden)** after editing `.chkignore` or `.chkhidden`, see [Ignoring files](../guides/ignoring-files.md)) and **Pull** to sync.

Right-click a file for:

- **Open**, **Open with...**, and **Open in explorer**
- **History**, the file's changelist history with diffs
- **Checkout**, **Checkout (exclusive)**, and **Undo checkout**
- **Revert**, and **Mark as Resolved** for conflicted files
- **Executable** (mark a file executable or remove the bit, which works on Windows too)
- Copy the full path, relative path, or paths with backslashes
- **Rename...** and **Delete** (move to trash or force delete)

### Pending

Your local changes, grouped the same way they will be submitted:

- **Unstaged** changes, including new files Checkpoint is not tracking yet.
- Each branch's default changelist, holding files you have staged for that branch.
- Numbered pending changelists you created to group related work.

Right-click files to **Stage to** a changelist, **Move to** another one, **Unstage**, or **Revert if Unchanged**. Choose **New changelist...** to start a numbered one. Each changelist has buttons to edit its description, delete it (its files stay staged in the branch's default changelist), and submit it. Select a file to see its diff. The toolbar has **Refresh** and **Revert Unchanged Files**, which reverts every pending file whose content matches the server.

See [Everyday workflow](../guides/workflow.md) for how staging, checkouts, and submitting fit together.

### History

The changelists on the current branch, with message, time, and author. Double-click a changelist (or right-click and choose **View changes**) to see the files it changed and their diffs. Right-click also offers **Create branch here...** and **Create label...**.

### Branches

Every branch in the repository, with its type, head changelist, creator, and whether it is archived. Right-click a branch to **Switch to this branch**, **Create branch**, **Merge into** the current branch, **Archive** or **Unarchive** it, or **Delete** it. See [Branches and merging](../guides/branches-and-merging.md).

### Labels

Named pointers to changelists. Right-click a label to **Rename...**, **Change changelist...**, or **Delete** it.

:::note
Diffs in the desktop app are syntax highlighted, including Unreal Angelscript (`.as`) files.
:::

## Team Sync

The **Team Sync** button opens a view built for teams that sync, build, and run a project together, similar to Unreal Game Sync: a changelist browser with CI status, one-click sync and build, precompiled binaries, bisecting, linked repos, and a workspace clean. Select **Files view** to return. See [Team Sync](../guides/team-sync.md) for the full guide.

## Settings

Select the gear icon in the title bar to open Settings:

| Section | Setting |
| --- | --- |
| Appearance | **Theme**: Light or Dark. |
| Daemon | **MCP server**: expose Checkpoint tools to AI agents. |
| Updates | **Channel**: Stable (published releases only) or Nightly (automated builds off `main`, expect rough edges). |
| Display | **Zoom**: zoom the app in or out. |
| Troubleshooting | **Collect logs**: build a bug report bundle (see below). |
| About | The app version, plus **Check for updates** and **Documentation**. |

## Updates

The daemon checks for new Checkpoint releases. When one is available, the desktop app shows an **Update Available** card: select **Download**, then **Restart & Update** once it has downloaded. Installing an update stops the daemon, tray, and desktop app, runs the installer, and starts everything again.

You can also update from the tray menu (**Download update**, then **Install update & restart**) or with `chk update install`.

If your server requires a newer version than you have installed, the app shows an **Upgrade Required** banner and Checkpoint operations are blocked until you update.

## Collect logs for a bug report

If something goes wrong, attach a log bundle to your report:

- In the desktop app, open **Settings**, then **Troubleshooting**, then **Collect logs**. On macOS it is also in the **Help** menu as **Collect Logs for a Bug Report**.
- From a terminal, run `chk bug-report`.

The bundle is a zip written to `~/.checkpoint/bug-reports/`. It contains the daemon's and desktop app's logs, version information, and a summary of each workspace. Tokens, passwords, email addresses, and your username are redacted, and it never contains your files' contents. A `README.txt` inside lists exactly what was removed. Look it over before you share it.

To browse the logs yourself, use **View Logs** in the tray menu. It opens `~/.checkpoint/logs`, where the daemon writes `daemon.log`.

For more help, see [Troubleshooting](../troubleshooting.md).
