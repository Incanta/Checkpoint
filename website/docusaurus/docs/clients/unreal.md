---
sidebar_position: 4
---

# Unreal Engine Plugin

The Checkpoint plugin is a revision control provider for the Unreal Editor. Once it is connected, the editor's built-in revision control features (status icons in the Content Browser, check out on edit, the Changelists window, Submit Content, and asset history) work with Checkpoint.

For UGS-style features (syncing the whole team to a known-good changelist, building, CI status badges, and precompiled editor binaries), use [Team Sync](../guides/team-sync.md) in the desktop app alongside this plugin. To build and test with Unreal Horde, see [Horde](../integrations/horde.md).

## Requirements

- The Checkpoint daemon running on the same machine. Installing the [desktop app](./desktop-app.md) takes care of this.
- An Unreal Engine 5 editor that can compile plugins (a C++ project, or a source or installed engine with a compiler set up).

:::note
Prebuilt plugin binaries are not published yet, so you build the plugin from source against your own engine. The source is in the [Checkpoint repository](https://github.com/Incanta/Checkpoint) under `src/clients/unreal`.
:::

## Install

### Into a project

1. Copy the contents of `src/clients/unreal` from the Checkpoint repository into your project at `Plugins/CheckpointSourceControl/` (so the file `Plugins/CheckpointSourceControl/CheckpointSourceControl.uplugin` exists).
2. Open the project. The editor offers to build the missing module; accept, or build the project from your IDE.

The plugin (it appears as **Checkpoint SCM** in the Plugins window) is enabled by default once it is installed.

### Into an engine

To make the plugin available to every project on an engine, package it with Unreal's `BuildPlugin` automation command and copy the result into the engine's `Engine/Plugins/` folder:

```bash
RunUAT BuildPlugin -Plugin=<path>/CheckpointSourceControl.uplugin -Package=<output folder> -TargetPlatforms=Win64
```

Use `RunUAT.bat` on Windows and `RunUAT.sh` on macOS and Linux (in `Engine/Build/BatchFiles/`), and set `-TargetPlatforms` to the platforms you need (for example `Mac`, or `Win64+Linux`).

## Connect the editor

The plugin works with a Checkpoint workspace. It looks for `.checkpoint/workspace.json` in the project folder and each folder above it, so the project should live inside a workspace (for example, the `.uproject` at the workspace root or in a subfolder).

1. In the editor, open **Revision Control** (called **Source Control** in older engine versions) and choose **Connect to Revision Control...**.
2. Pick **Checkpoint** as the provider.
3. What you see next depends on whether a workspace was found:
   - **Workspace found:** the panel shows the connection status. Select **Accept Settings**.
   - **No workspace found:** the panel shows a setup wizard. You can also cancel and create the workspace with the desktop app or `chk init` instead.

### Setup wizard

If you have not signed in yet, enter your **Server URL** and select **Connect Account**. Your browser opens; confirm the code shown in the panel, then pick your account from the **Account** list (it can take a moment to appear). Then:

1. Choose an **Organization** and **Repository**. To start a new repository, enter a **New Repo Name** and select **Create Repo**.
2. Enter a **Workspace Name** and **Workspace Root Path**, then select **Create Workspace**. New workspaces start on the `main` branch.
3. Select **Accept Settings**.

Once connected, the editor's status reads "Connected to Checkpoint" with your workspace name and email.

## What you can do

| Editor action | What Checkpoint does |
| --- | --- |
| **Check Out** | Checks the file out. Files the repository treats as unmergeable (binary assets such as `.uasset`) get an exclusive claim, so teammates see them as checked out by you and cannot edit them at the same time. |
| **Mark for Add** | Stages the new file into the default changelist (or the changelist you chose), so the next submit includes it. |
| **Submit Content** / **Submit** a changelist | Submits the changelist. With no description, the changelist's saved description is used, then "Submitted from Unreal Engine". **Keep files checked out** is honored. |
| **Revert** | Restores files to their head version and releases the checkout. Reverting a newly added file leaves it on disk and just takes it out of the next submit, as in Perforce. |
| **Revert Unchanged** | Reverts only files whose content matches the head version. |
| **Sync** | Pulls the latest changelist, for the whole workspace or the selected files. |
| **Delete** | The file is marked deleted, and the deletion is recorded when you submit. |
| **Changelists window** | Create pending changelists, edit their descriptions, delete them (their files go back to the default changelist), and move files between them. |
| **History** and **Diff Against Depot** | Show an asset's changelist history and diff your version against a previous one. |

### How changelists map to Checkpoint

Unreal's **Default** changelist is your workspace branch's default changelist. Each numbered changelist you create is a Checkpoint pending changelist. These are the same changelists you see in the desktop app's Pending tab and in `chk status`, so you can mix tools freely. See [Everyday workflow](../guides/workflow.md).

### Not supported yet

- Copy or branch with history (duplicating an asset is an ordinary add).
- Annotate / blame.
- Revision control labels (use labels in the desktop or web app).
- Syncing to a specific older changelist from the editor (use Team Sync, the desktop app, or `chk pull -c <n>`).
- Uncontrolled changelists and snapshots.
- Canceling an operation once it starts.

## Angelscript projects

The plugin has no special handling for Angelscript. Script files (`.as`) are tracked like any other text file, and the desktop and web apps syntax-highlight them in diffs and the file viewer.

## Troubleshooting

- **"Not connected to Checkpoint daemon":** make sure the daemon is running (start the desktop app, or use **Start Daemon** in the tray menu), then reconnect from the Revision Control menu.
- **Plugin too old:** if the Output Log says the plugin's daemon API is below the daemon's minimum, rebuild the plugin from the source that matches your installed Checkpoint version.
- Check the Output Log, filtered to `LogCheckpointSourceControl`, for details of any failed operation.

See also [Troubleshooting](../troubleshooting.md).
