---
sidebar_position: 2
title: Concepts
---

# Concepts

This page explains the moving parts of Checkpoint and the words the rest of the docs use. If you have used Perforce, most of it will feel familiar. If you come from Git, the biggest differences are that history lives on a server rather than in every copy, changelists get one number per repo, and binary files are locked rather than merged.

## The pieces: server, daemon, and clients

Checkpoint has three layers:

- **The server** is what your team self-hosts. It is a web app (the browser UI plus the API every client talks to) and a storage server that holds file contents. It is the single source of truth for history, branches, locks, and permissions. See [Deploy with Docker Compose](../self-hosting/deploy-docker-compose.md).
- **The daemon** is a small background service that runs on each person's computer. It watches your workspaces for changes, works out what is pending, and does the actual pulling and submitting. It is installed with the desktop app and started for you (the tray icon shows it is running).
- **Clients** are what you click or type in: the [desktop app](../clients/desktop-app.md), the [`chk` command line](../clients/cli.md), the [VS Code extension](../clients/vscode.md), and the [Unreal Editor plugin](../clients/unreal.md). Every client talks to the same local daemon, so you can mix them freely. Stage a file in Unreal, submit it from the desktop app, and check the result with `chk status`.

The web app is also a client in its own right: you use it to browse files and history, manage branches and labels, review merge requests, and administer your organization.

:::note
The daemon needs to reach the server for nearly everything (pulling, submitting, checking out, even listing history). There is no offline mode yet.
:::

## Organizations and repositories

An **organization** is a team: a set of members, their roles, and the repositories they share. Org admins manage membership and org-wide settings such as which file extensions count as binary. See [Organizations and Access](../self-hosting/organizations-and-access.md).

A **repository** (repo) is one versioned project, such as a game or a film. Each member's access to a repo is one of none, read, write, or admin. You need write access to submit, check out, or create branches, and admin access to change repo settings.

## Workspaces

A **workspace** is a folder on your computer that holds a working copy of one repo. It is the equivalent of a Git clone or a Perforce workspace (client). You can have several workspaces for the same repo, for example one per branch or one per drive.

Some things to know about workspaces:

- A workspace is registered with the server, so the server knows which workspace holds which locks.
- Creating a workspace does not download anything yet. You **pull** to fill it.
- Each workspace keeps its own bookkeeping in a `.checkpoint` folder at its root. Never edit, copy, or submit that folder.
- **Unlinking** a workspace makes Checkpoint stop tracking it. Your files stay on disk.

## Changelists and history

A **changelist** (CL) is one submit: a set of file changes with a message, an author, and a time. Checkpoint's changelists work like Perforce's:

- **Numbered per repo.** Every changelist in a repo gets the next number, whichever branch it lands on. A new repo starts with changelist 0 ("Repo Creation"), and the numbers only go up. Changelist #120 on a feature branch and #121 on `main` are neighbours in one sequence.
- **Atomic.** A submit lands completely or not at all.
- **Referred to by number.** You sync to a changelist, label a changelist, and see "3 CLs behind" in the desktop app's status bar.

Unlike Git, your workspace does not store the whole history. The server has it, and you browse it from the History views in the desktop app and web app, or with `chk log`. Each file also has its own **file history**: the list of changelists that changed it.

## Pending changes, staging, and pending changelists

Anything in your workspace that differs from what you last pulled is a **pending change**: an edited, added, deleted, or renamed file.

Pending changes are not submitted until you **stage** them, much like Git's index. Staging says "this is ready to go". Unstaged work never leaves your computer, so you can keep half-finished experiments around without worrying about submitting them by accident.

Staged files are grouped into **pending changelists**, as in Perforce:

- Every branch your workspace works on has a **default changelist**. Files you stage go there unless you say otherwise.
- You can create **numbered pending changelists** to keep separate pieces of work apart, for example "HUD polish" and "lighting fix". Each one has its own description and submits on its own.
- Pending changelist numbers are local to your workspace. When you submit one, the result gets the next real changelist number from the server.

See [Everyday Workflow](../guides/workflow.md) for how to stage and submit.

## Checkouts, locks, and claims

To **check out** a file is to tell the server you are editing it. Checkpoint records this as a **claim**. Claims come in two strengths, decided by the file's type:

| | Binary files | Text files |
| --- | --- | --- |
| Examples | `.uasset`, `.png`, `.fbx`, `.wav`, `.psd`, `.blend` | `.cpp`, `.ini`, `.json`, `.md`, `.py` |
| Claim | **Exclusive** (a lock) | **Advisory** |
| Others can check it out at the same time? | No | Yes |
| Must be synced to the latest version first? | Yes | No |
| If two people change it | Can't happen while it is locked | Changes are merged automatically |

**Binary files are locked.** Two people cannot both edit a texture or an Unreal asset and merge the results, so only one person at a time may hold an exclusive claim. Checkpoint also refuses the checkout if your copy is out of date, so you never start work on an old version. (Perforce lets you check out a stale file and only complains when you submit, after the work is done.) Other people can't submit changes to a file you have locked.

**Text files are merged.** Anyone may check out a text file at the same time. When you pull and someone else changed a file you also changed, Checkpoint does a three-way merge, like Git. If both of you changed the same lines, the file gets Git-style conflict markers for you to fix. If you want to keep everyone off a text file for a while (say, a big refactor), you can check it out **exclusively** instead.

**What counts as binary?** A file is binary when its extension is on the server's binary list. The default list covers common game and media formats: Unreal assets (`.uasset`, `.umap`, `.ubulk`, `.utxt`), images (`.png`, `.jpg`, `.psd`, `.exr`, `.tga`, `.dds`, `.svg`, and more), audio and video (`.wav`, `.mp3`, `.ogg`, `.mp4`, `.mov`, and more), 3D files (`.fbx`, `.obj`, `.abc`, `.gltf`, `.glb`, `.blend`, `.3ds`), Wwise banks, archives, native libraries and executables, `.db`, `.dat`, `.bin`, and `.pdf`. Org admins can add or remove extensions in the web app under the org's **Settings > Binary file extensions**. Everything else, including files with no extension, is treated as text.

:::caution
A binary format that is not on the list is treated as text: it is not locked, and Checkpoint will try to merge it. If your team uses formats such as Maya (`.ma`, `.mb`), 3ds Max (`.max`), Substance, ZBrush, or Krita files, ask your org admin to add their extensions before you start working with them.
:::

Checking out is optional for editing, since your files are never made read-only. Staging a file checks it out for you, so a binary file gets locked at the latest when you stage it. Checking out before you start working on a binary file is the polite habit, though: it tells everyone else to stay away, and it fails early if someone else already has it.

A claim is released when your submit lands on a mainline or release branch, when you revert the file, or when you undo the checkout. On a feature branch, a binary file's lock stays in place after you submit, until the branch is merged (or deleted), so nobody else changes the file in the meantime. The repo's **Checkouts** page in the web app lists every active checkout and who holds it. Repo admins can force-release a checkout there, for example when someone is away with a file locked.

## Pulling, conflicts, and auto-merge

**Pulling** (also called syncing) brings your workspace up to the latest changelist on its branch, or to a specific changelist you choose. When the server's changes overlap with your local edits:

- **Text files** you edited are merged three ways. Clean merges just happen. Overlapping edits leave conflict markers (`<<<<<<< CURRENT`, `=======`, `>>>>>>> INCOMING`) for you to resolve.
- **Binary files** you edited that also changed on the server stop the pull before anything is touched. You decide what to do (see [resolving conflicts](../guides/workflow.md#resolve-conflicts)).
- A file you changed that was **deleted** on the server also stops the pull.

Before a pull overwrites any file that has local changes, the daemon copies your version into a backup folder inside `.checkpoint`, and puts everything back if the pull fails partway. Local work is not silently lost.

## Branches

A **branch** is a line of history. Every repo starts with a `main` branch. Checkpoint has three kinds:

- **Mainline**: a top-level line of development, such as `main`. It has no parent.
- **Release**: a branch off a mainline for stabilizing and shipping a version. Locks on a release branch are separate from the mainline's, so fixing a file on the release branch does not block people working on the same file in `main`.
- **Feature**: a short-lived branch off a mainline, release, or other feature branch, for work you want to keep out of its parent until it is ready. Feature branches share their parent's locks, so a file locked on `main` is also locked on feature branches made from `main`.

A feature branch is merged back into its parent, either directly or through a **merge request** that teammates review in the web app. See [Branches and Merging](../guides/branches-and-merging.md).

## Labels

A **label** is a name for a changelist, such as `alpha-2` or `gdc-demo`. It is like a Git tag. Labels can be renamed, deleted, or moved to a different changelist later. See [Labels](../guides/branches-and-merging.md#labels).

## Ignored and hidden files

A `.chkignore` file lists untracked files Checkpoint should never offer to submit, like build output and editor caches. A `.chkhidden` file hides local changes to files that stay in the repo. See [Ignoring Files](../guides/ignoring-files.md).

## Team Sync

**Team Sync** is a separate view in the desktop app for people who mostly consume a project rather than change it. It shows each changelist with its CI results and teammates' notes, syncs to a known-good changelist, can download prebuilt binaries instead of compiling, and runs your project's build steps. See [Team Sync](../guides/team-sync.md).

## Quick comparison

| Concept | Checkpoint | Git | Perforce |
| --- | --- | --- | --- |
| Copy on your machine | Workspace | Clone | Workspace (client) |
| History lives | On the server | In every clone | On the server |
| A commit | Changelist, numbered per repo | Commit, identified by hash | Changelist, numbered per server |
| Get latest | Pull | `git pull` | `p4 sync` |
| Prepare a commit | Stage into a pending changelist | `git add` | `p4 edit` / `p4 add` into a changelist |
| Publish | Submit | `git commit` + `git push` | `p4 submit` |
| Lock a binary file | Check out (automatic for binary types) | Git LFS locks (opt-in) | `p4 edit` with `+l` file type |
| Tag | Label | Tag | Label |
| Ignore file | `.chkignore` | `.gitignore` | `.p4ignore` |
