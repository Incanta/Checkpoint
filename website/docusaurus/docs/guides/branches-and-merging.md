---
sidebar_position: 3
title: Branches and Merging
---

# Branches and Merging

Branches let you keep work apart from the main line of development until it is ready: a risky feature, a release you are stabilizing, or an experiment you may throw away. This guide covers creating and switching branches, merging them back, merge requests, changelist reviews, labels, and what happens when a branch is archived or deleted.

## Kinds of branches

Every repo starts with a `main` branch. Checkpoint has three kinds of branch:

| Kind | Parent | Use it for | Locks |
| --- | --- | --- | --- |
| **Mainline** | None | A top-level line of development, such as `main` | Its own |
| **Release** | A mainline | Stabilizing and shipping a version | Its own, separate from the mainline's |
| **Feature** | A mainline, release, or another feature branch | Work you want to keep out of its parent until it is ready | Shared with its parent |

The "Locks" column matters for binary files. Because a release branch has its own locks, someone can fix a texture on `release/1.0` while someone else edits the same texture on `main`. Feature branches share their parent's locks, so a file locked on `main` is also locked on every feature branch made from `main`, and vice versa. Two people can never edit the same binary file in parallel on branches that will be merged together.

A feature branch made from another feature branch is **stacked** on it. Stacked branches merge one step at a time, each into its own parent.

## Create a branch

**Desktop app:** open the **Branches** tab and click **New Branch**, or right-click a mainline or release branch and choose **Create branch**. To branch from an older point in history, right-click a changelist on the **History** tab and choose **Create branch here...**. Pick the type, name, and parent in the dialog.

**Web app:** open the repo's **Branches** page, choose **Feature** or **Release**, pick a parent, and create it.

Creating a branch does not copy any files, so it is instant whatever the size of the repo. You need write access to the repo.

## Switch branches

**Desktop app:** on the **Branches** tab, right-click a branch and choose **Switch to this branch**. The title bar shows the branch you are on.

**Command line:**

```bash
chk branch                  # list branches, with type, head changelist, and parent
chk switch feature/new-hud
```

Switching works differently depending on the kind of branch:

- **Switching to a feature branch** keeps your workspace on its mainline or release branch and lays the feature branch on top. Only the files the feature branch changed are downloaded, so it is fast even in a huge repo. The title bar shows this as, for example, `main +1`. Switching to a stacked branch brings in the whole stack beneath it.
- **Switching to a different mainline or release branch** syncs the whole workspace to that branch. Any feature branch you had laid on top is removed.

Switching to another feature branch replaces the one you had laid on top. To take a feature branch off and go back to plain `main` (or whichever branch is underneath), use **Checkpoint: Switch Branch** in [VS Code](../clients/vscode.md) and pick the active feature branch, which is marked "select to deactivate". The desktop app and `chk switch` can't do this yet.

A switch is refused when it would overwrite your work:

- if you have local changes to binary files that the switch would replace;
- if you are moving to a different mainline or release branch while you still have files checked out on the current one (submit or revert them first);
- if the feature branch belongs to a different mainline or release branch than the one you are on (switch to that one first).

### Submitting to a feature branch

While a feature branch is active, your workspace can submit to either the feature branch or the branch beneath it. Files you stage go to the **mainline or release branch by default**, so be deliberate about where your work goes:

**Desktop app:** on the **Pending** tab, right-click files and use **Stage to** to choose the feature branch's default changelist, or a pending changelist you have set to submit to the feature branch. To change where a pending changelist submits, click its branch button and pick a branch.

**Command line:**

```bash
chk add -b feature/new-hud Content/UI/Hud.uasset   # stage for the feature branch
chk move -b feature/new-hud Source/Game/Hud.cpp    # move a staged file to it
chk submit -b feature/new-hud -m "New HUD layout"  # submit the feature branch's default changelist
chk cl new -b feature/new-hud -m "HUD polish"      # a pending changelist that submits to the feature branch
```

`chk status` shows each branch's changelists separately, so you can always see what goes where.

## Keep a feature branch up to date

While you work on a feature branch, its parent keeps moving. To bring the parent's newer changes into your branch, right-click the branch on the desktop app's **Branches** tab and choose **Update from** *parent*. This adds a changelist to the feature branch with everything the parent changed since the two last shared history.

If a file was changed on both the parent and the feature branch, the update stops and lists those files. To resolve them:

1. Make the version of each listed file you want on the feature branch, and submit it to the feature branch.
2. Right-click the branch again and choose **Update from** *parent* **, keeping my resolutions**. The feature branch keeps your resolved versions of those files and takes everything else from the parent.

Updating before you merge is the way through merge conflicts (see below).

## Merge a branch

Merging brings a feature branch's work into its parent. Only feature branches can be merged, and only into their own parent.

**Desktop app:** switch to the parent (mainline or release) branch. On the **Branches** tab, right-click the feature branch and choose **Merge into** *parent*, then confirm.

**Command line:** from a workspace on the parent branch:

```bash
chk merge feature/new-hud
```

**Web app:** open a [merge request](#merge-requests) and merge it there. This is also how you merge a stacked feature branch into the feature branch beneath it.

What a merge does:

- **It is a squash merge.** The parent gets one new changelist, "Merged *branch* into *parent*", whose description lists every changelist from the feature branch. The feature branch's own changelists stay in history.
- **It is all or nothing.** If any file was changed on both branches since they last shared history, the merge is refused, nothing is merged, and the error lists the files. [Update the feature branch from its parent](#keep-a-feature-branch-up-to-date), resolve the files there, and merge again.
- **The feature branch is deleted** once it is merged. Any branches stacked on it move onto its parent.
- **Locks are released** when the work lands on a mainline or release branch, since the work is done.

Repo admins can limit who may merge into mainline and release branches in the web app, on the repo's **Settings** page under **Merge permissions**. When no one is listed, anyone with write access can merge. You can use the same list for mainline and release branches, or separate ones.

## Merge requests

A merge request asks your team to review a feature branch before it is merged. Merge requests live in the web app.

1. Open the repo's **Merge Requests** page and create a new one.
2. Pick the feature branch to merge. The target is its parent branch.
3. Give it a title and a description (Markdown is supported) and create it.

On the merge request page you can:

- see the branch's changelists and the files it changes, with diffs;
- **request a review** from teammates, who get a notification;
- **approve** or **request changes** (as a reviewer; you can't approve your own merge request);
- comment, and subscribe to or unsubscribe from notifications;
- close a merge request without merging it, and reopen it later;
- **merge** it when it is ready.

A merge request can't be merged while any reviewer has requested changes, or while it has fewer approvals than the repo requires. Repo admins set the number of **Required approving reviews** on the repo's **Settings** page. Merge permissions apply to merge requests too. Merging works exactly like a [direct merge](#merge-a-branch): a squash changelist on the target, and the feature branch is deleted.

A branch can have only one open merge request at a time.

## Changelist reviews

Merge requests review a branch before it lands. You can also give feedback on individual changelists after they land, from the **Team Sync** view in the desktop app. Right-click a changelist to:

- **Mark good** or **Mark bad**, so teammates know whether it is safe to sync to. Marking a changelist bad notifies its author.
- **Star** it, to find it again later.
- **Start investigating**, to tell others you are looking into a problem with it, and **Stop investigating** when you are done.
- **Leave comment...**. The changelist's author and earlier commenters are notified.

These reviews feed into Team Sync's view of which changelists are good to sync to. See [Team Sync](./team-sync.md).

## Labels

A label gives a changelist a memorable name, such as `alpha-2` or `gdc-demo`. Label names are unique within a repo.

**Desktop app:** right-click a changelist on the **History** tab and choose **Create label...**. The **Labels** tab lists every label. Right-click one to **Rename...**, **Change changelist...** (point it at a different changelist), or **Delete** it.

**Web app:** the repo's **Labels** page lists labels, and lets you create and delete them.

You need write access to create or change labels. To get the files as of a label, pull its changelist number, for example `chk pull -c 1520`.

## Archive a branch

Archiving retires a branch you no longer work on but want to keep. An archived branch is read-only (submits to it are refused), can't be switched to, and is hidden from branch lists unless you choose to show archived branches.

In the web app, open the repo's **Branches** page and click **Archive** next to the branch. The default branch can't be archived. Anyone can archive feature branches they created; archiving other branches takes a repo admin.

Archiving is refused while files are still checked out on the branch. Submit, merge, or release them first.

## Delete a branch

Only feature branches can be deleted. Mainline and release branches are archived instead. You can delete feature branches you created; admins can delete any feature branch.

**Desktop app:** on the **Branches** tab, right-click the feature branch and choose **Delete**.

What happens when a branch is deleted, whether by you or by a merge:

- **Its history stays.** Every changelist submitted to it keeps its number and still appears in history. Nothing is removed from the server.
- **Its locks are released,** so others can check out those files again.
- **The server keeps a record of where it ended,** so it can be restored later under its old name or a new one. Restoring a deleted branch is not available in the apps yet.

Deleting a branch with work its parent never received (changelists that were never merged) is refused at first, and the error lists those changelists. The desktop app then asks whether to delete it anyway and discard them. A branch with other branches stacked on it can't be deleted until those are merged or deleted.
