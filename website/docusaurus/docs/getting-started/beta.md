---
sidebar_position: 3
title: Public Beta
---

# Public Beta

Checkpoint is in **public beta** (Early Access). Thank you for trying it. This page sets expectations: what the beta is, what works today, what does not yet, and how to tell us when something goes wrong.

:::caution Beta software
Checkpoint is ready for small teams to use day to day, but it is still beta software. Expect bugs and rough edges, and **back up your server** before you trust it with work you can't recreate. See [Backups](../self-hosting/backups.md).
:::

## What the beta looks like

- **You host it yourself.** Each team runs its own Checkpoint server, usually with Docker Compose. Your files and history stay on hardware or cloud storage you control. Start with the [Quickstart](./quickstart.md).
- **Teams are invited by their admin.** The beta is aimed at teams of roughly 5 to 20 people. Whoever sets up the server becomes its admin and invites the rest of the team. See [Organizations and Access](../self-hosting/organizations-and-access.md).
- **Things will change.** Expect frequent releases with fixes and new features. Keep your server and clients up to date (see [Updates](../self-hosting/updates.md)), and read the release notes before upgrading the server.

## Supported platforms

| Component | Platforms |
| --- | --- |
| Desktop app, daemon, tray, and `chk` CLI | Windows (x64), macOS (Intel and Apple Silicon), Linux (x64) |
| Server | A host with Docker and the Docker Compose v2 plugin (see [Deploy with Docker Compose](../self-hosting/deploy-docker-compose.md)) |
| VS Code extension | Wherever VS Code and the desktop app run |
| Unreal Editor plugin | See [Unreal Engine](../clients/unreal.md) |

## What works today

- Submitting, pulling, and syncing to any changelist, with large binary files as first-class citizens.
- Exclusive locks on binary files, and automatic three-way merging of text files.
- Staging, partial staging of text files (`chk add -p`, and selected ranges in VS Code), and Perforce-style pending changelists.
- Revert, "Revert if Unchanged", and file and repo history.
- Mainline, release, and feature branches, merging, merge requests with reviews, and labels.
- Ignoring files with `.chkignore`, and hiding local changes with `.chkhidden`.
- [Team Sync](../guides/team-sync.md), [linked repos](../guides/linked-repos.md), [artifacts and CI badges](../guides/artifacts-and-ci.md), and [issue tracker integrations](../guides/issue-trackers.md).
- Clients for desktop, command line, VS Code, and Unreal Editor, plus an [Unreal Horde integration](../integrations/horde.md).

## Known limitations

These are not supported yet. Plan around them:

- **No offline mode.** Your computer needs to reach the server to pull, submit, check out, or browse history. Editing files works offline, and you submit once you are back online.
- **No shelving.** There is no way to store pending work on the server without submitting it. To share unfinished work, submit it to a [feature branch](../guides/branches-and-merging.md).
- **Symbolic links are not stored.** A link to a file is submitted as a copy of the file it points to. A link to a folder is never submitted, and its contents are skipped.
- **File names must work on every OS.** Names that Windows, macOS, or Linux can't store, such as names containing `< > : " | ? *`, names ending in a dot or space, or reserved device names like `CON`, are refused when you submit.
- **Unknown binary formats are treated as text.** Only file extensions on your org's binary list are locked. Check the list before you start (see [Concepts](./concepts.md#checkouts-locks-and-claims)).

## Reporting a bug

Bug reports are the most useful thing you can give us during the beta. A good report has three parts: what you did, what you expected, and what happened instead. Please also attach a **log bundle**.

### Collect a log bundle

A log bundle is a zip of the daemon's logs, the desktop app's log, version information, and a summary of each workspace. Passwords, tokens, keys, and email addresses are removed, as is your OS username in file paths. It never contains your login credentials or the contents of your files. File paths, server URLs, and branch names are kept because they are needed for debugging, so look the zip over before you share it. The `README.txt` inside it lists exactly what was removed and what was kept.

- **Desktop app:** open **Settings**, and under **Troubleshooting** click **Collect logs**. The app tells you where it saved the zip.
- **Command line:** run `chk bug-report`. It prints the path of the zip.

Bundles are saved in the `.checkpoint/bug-reports` folder in your home directory.

If the problem is on the server side, the person who runs your server can also collect the server's logs. `chk redact <file>` writes a redacted copy of any log file, such as the output of `docker compose logs`. See [Troubleshooting](../troubleshooting.md).

### Where to report

- **Bugs:** open an issue on [GitHub Issues](https://github.com/Incanta/Checkpoint/issues) and attach the log bundle.
- **Questions, ideas, and feedback:** start a thread in [GitHub Discussions](https://github.com/Incanta/Checkpoint/discussions).

Before opening an issue, check [Troubleshooting](../troubleshooting.md) for known problems and fixes.

:::tip
If a pull or submit went wrong, report it before you try to fix things by hand. The log bundle captures the state of each workspace (including whether a pull was interrupted and recent errors), and that is much more useful before the workspace is cleaned up.
:::
