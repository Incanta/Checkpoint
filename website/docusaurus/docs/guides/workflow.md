---
sidebar_position: 1
title: Everyday Workflow
---

# Everyday Workflow

This guide walks through a normal day with Checkpoint: getting a workspace, pulling the latest, editing, submitting, and undoing mistakes. Each task shows the [desktop app](../clients/desktop-app.md) and the [`chk` command line](../clients/cli.md). Both talk to the same daemon, so you can switch between them at any time.

If terms like workspace, changelist, or claim are new to you, read [Concepts](../getting-started/concepts.md) first.

## Create a workspace

A workspace is a folder on your computer linked to one repository.

**Desktop app:**

1. On the dashboard, pick your account and organization at the top. Your repositories are listed on the left.
2. Click **+** (Create new workspace) next to the repository.
3. Enter a **Workspace Name** and a **Workspace Path** (or click **Browse**), then click **Create Workspace**.
4. Open the workspace, and click **Pull** on the **Files** tab to download the files.

The desktop app creates new workspaces on the `main` branch. To work on another branch, [switch](./branches-and-merging.md#switch-branches) after creating it.

**Command line:** make an empty folder, `cd` into it, and run:

```bash
chk init my-org/my-game          # or just `chk init` to pick from a list
chk pull
```

`chk init` uses the folder's name as the workspace name. Add `-b <branch>` to start on a branch other than `main`.

:::note
Creating a workspace never downloads anything. Always pull afterwards.
:::

## Pull the latest changes

Pulling brings your workspace up to the newest changelist on its branch.

**Desktop app:** the status bar at the bottom of the window shows **Up to date** or how many changelists you are behind (for example, **3 CLs behind**). Click the count to preview the incoming changes, with a diff for each file. Click **Pull** on the **Files** tab to sync.

**Command line:**

```bash
chk pull            # to the latest changelist on your branch
chk pull -c 1520    # to a specific changelist instead
```

When a pull touches files you have changed locally:

- **Text files** are merged automatically. If you and someone else changed the same lines, the file is left with conflict markers (see [Resolve conflicts](#resolve-conflicts)). `chk pull` reports how many files were auto-merged and lists any with conflicts.
- **Binary files** you changed that someone else also changed stop the pull before anything is downloaded. So does a file you changed that someone else deleted. The error lists the files. See [Resolve conflicts](#resolve-conflicts).

Before a pull overwrites any file you have changed, Checkpoint saves a copy of your version in `.checkpoint/pull-backups` inside the workspace, so your work is never silently lost.

## Check out files before you edit

Your files are never read-only, so you can open and edit anything. Checking out a file tells the server and your team that you are working on it:

- **Binary files** (textures, models, Unreal assets, audio, and so on) get an **exclusive lock**. Nobody else can check them out or submit changes to them until you submit or revert. Checking one out fails if someone else holds it, or if your copy is not the latest version (pull first).
- **Text files** get an **advisory** checkout. Others can work on them at the same time, and changes are merged.

Always check out a binary file *before* you start working on it. Finding out someone else has it after an hour of work is exactly what locking is there to prevent.

**Desktop app:** right-click a file on the **Files** or **Pending** tab and choose **Checkout**. Choose **Checkout (exclusive)** to lock a text file too, for example during a big refactor. **Undo checkout** gives the checkout up without touching your changes.

**Command line:**

```bash
chk checkout Content/Maps/Arena.umap
chk checkout -x Source/Game/Weapons.cpp    # exclusive, even for a text file
```

Staging a file also checks it out, so a binary file is locked at the latest when you stage it. To see who has what checked out, open the repo's **Checkouts** page in the web app.

## See what you changed

**Desktop app:** the **Pending** tab lists every changed, added, and deleted file. Select a file to see its diff. Use the layout button to put the diff beside or below the file list. **Refresh** rescans the workspace.

**Command line:**

```bash
chk status                  # pending changes, grouped by changelist
chk diff Source/Game/Hud.cpp
```

## Stage your changes

Only staged files are submitted. Anything you leave unstaged stays on your computer, so you can keep experiments around without submitting them by accident.

**Desktop app:** on the **Pending** tab, select files (or a folder) under **Unstaged**, right-click, and choose **Stage**. **Stage to** puts them straight into a particular changelist. You can also drag files between changelists. On the **Files** tab, right-click a new file and choose **Stage**, or right-click a folder and choose **Stage new files**.

**Command line:**

```bash
chk add Content/UI/Hud.uasset Source/Game/Hud.cpp
chk add -p Source/Game/Hud.cpp       # pick individual hunks of a text file
chk restore --staged Source/Game/Hud.cpp   # unstage
```

Deleted files are staged the same way: stage the deletion to submit it.

## Group work into pending changelists

Every staged file belongs to a pending changelist. Each branch your workspace works on has a **default** changelist, and you can create **numbered** ones to keep separate pieces of work apart and submit them separately. This works like Perforce.

**Desktop app:** on the **Pending** tab, click **New Changelist**, or right-click files and choose **Stage to > New changelist...** (or **Move to > New changelist...**). Each changelist header has buttons to edit its description, change the branch it submits to, delete it (its files stay staged and move to the default changelist), and submit it.

**Command line:**

```bash
chk cl new -m "HUD polish"           # prints the new changelist's id, e.g. 3
chk add -c 3 Content/UI/Hud.uasset   # stage into changelist 3
chk move -c 3 Source/Game/Hud.cpp    # move a staged file into changelist 3
chk cl list                          # list pending changelists
chk cl edit 3 -m "HUD polish, pass 2"
chk cl delete 3                      # its files go back to the default changelist
```

Pending changelists and their ids are local to your workspace. When you submit one, the server gives it a real changelist number.

## Submit

Submitting sends one changelist's staged files to the server as a new changelist.

**Desktop app:** click the submit button on a changelist's header on the **Pending** tab, check the description, and submit.

**Command line:**

```bash
chk submit -m "Add the new HUD"      # submits your branch's default changelist
chk submit -c 3                      # submits pending changelist 3, using its description
```

What happens when you submit:

- If someone else submitted newer versions of **text files** you are submitting, Checkpoint merges them into your files first. If that merge has conflicts, the submit stops so you can fix them.
- If someone else submitted newer versions of **binary files** you are submitting, the submit stops and asks you to pull first.
- If someone else has a binary file locked, the submit is refused and the error names who holds it.
- When the submit lands on a mainline or release branch, your checkouts on the submitted files are released. On a feature branch, binary files stay locked until the branch is merged.

## Revert changes

Reverting throws away your local changes to a file, restores the version you last pulled, and releases your checkout.

**Desktop app:** right-click the file and choose **Revert**, then confirm.

**Command line:**

```bash
chk revert Content/UI/Hud.uasset
```

Reverting a newly added file does not delete it. It is unstaged and shows up as an untracked file again, so you can delete it yourself if you want to.

## Revert if Unchanged

Files often show up as changed without really being different: you checked one out and never edited it, or a tool rewrote it with identical contents. **Revert if Unchanged** reverts only the files whose contents match the version you last pulled, and releases their checkouts. Files that really changed are left alone, so it never discards work. It is the same as Perforce's "Revert Unchanged Files".

**Desktop app:** on the **Pending** tab, right-click a selection and choose **Revert if Unchanged**, or open the **Refresh** dropdown and choose **Revert Unchanged Files** to check every pending change.

**Command line:**

```bash
chk revert -a                    # every pending change
chk revert -a Content/Maps/Arena.umap Config/Game.ini   # only these files; says why any were kept
```

## Resolve conflicts

### Text files

When a pull or submit merges a text file and both sides changed the same lines, Checkpoint writes both versions into the file between Git-style markers:

```text
<<<<<<< CURRENT
your version
=======
the incoming version
>>>>>>> INCOMING
```

Open the file, keep what you want, delete the marker lines, and save. The file then shows as an ordinary change you can stage and submit.

### Binary files

Binary files can't be merged, so when a pull stops because a binary file changed both locally and on the server, you choose which version wins:

- **Keep theirs:** revert your copy (see [Revert changes](#revert-changes)), then pull again. Your changes to that file are lost, so save a copy elsewhere first if you might need them.
- **Keep yours:** in the desktop app, right-click the file and choose **Mark as Resolved**. This tells Checkpoint your local version is correct even though there is a newer one on the server. When you submit, your version replaces theirs.

This kind of conflict is what checking out binary files prevents. If it happens often, make sure everyone checks out binary files before editing them.

## Look at history

**Desktop app:**

- The **History** tab lists your branch's changelists. Double-click one, or right-click it and choose **View changes**, to see the files it changed. Right-click also offers **Create branch here...** and **Create label...**.
- Right-click a file and choose **History** to see every changelist that changed it.

**Web app:** the repo's **History** page lists changelists, and each file's page shows its contents and history.

**Command line:**

```bash
chk log           # recent changelists on your branch
chk log -l 20     # only the 20 most recent
```

## Start over

To throw away *everything* local in a workspace, including untracked files, and return it to a clean copy of the changelist you are on:

```bash
chk clean
```

It asks you to type `YES` first. It reverts every modified file, **deletes untracked files and folders**, and releases your checkouts. Use it with care.

## Make a file executable

On Linux and macOS, `chmod +x` works as usual. Windows has no executable bit, so Checkpoint lets you set it for the next submit from any OS: right-click a file in the desktop app and choose **Executable**, or run `chk chmod +x tools/build.sh`.
