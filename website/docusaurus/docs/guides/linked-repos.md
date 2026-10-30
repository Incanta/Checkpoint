---
sidebar_position: 5
---

# Linked repos

Linked repos let one repository pin other repositories in the same organization at an exact changelist. When you sync the parent with [Team Sync](team-sync.md), Team Sync first brings each linked workspace to the changelist the parent pins, then syncs the parent.

Common uses:

- **A shared engine.** Keep a custom Unreal Engine (or any engine or SDK) in its own repository, sync it once per machine, and let every game pin the engine changelist it builds against. Bumping the engine is an ordinary, reviewable changelist in the game repo.
- **Plugins, source art, or tools mounted inside a project.** Mount another repository at a fixed folder in the parent, like a git submodule, and have it follow the parent's pin.

Linking is engine-agnostic. Team Sync only syncs the linked repo; it never looks inside it.

## Two kinds of link

| | Anywhere on disk | Nested (mounted) |
|---|---|---|
| Config | No `path` | `path: Plugins/StudioPlugins` |
| Where the linked workspace lives | Any folder you choose, or an existing workspace of that repo | Inside the parent, at `path` |
| Who creates it | You, once per machine | Team Sync, on the next sync |
| Shared between parents | Yes, several games can share one engine workspace | No, each parent has its own copy |
| Good for | Engines and other large shared repos | Plugins, source art, tools |

## Configure links in teamsync.yaml

Links live in the parent repo's `teamsync.yaml` under `linkedRepos`:

```yaml
version: 1

linkedRepos:
  # Anywhere on disk: each person picks or creates the workspace
  - repo: UE5
    branch: main
    changelist: 48213

  # Nested: Team Sync creates it at this folder inside the parent
  - repo: StudioPlugins
    branch: main
    changelist: 9120
    path: Plugins/StudioPlugins

  # Nested, but only for people who opt in
  - repo: StudioArt
    branch: main
    changelist: 3301
    path: SourceArt
    enabledByDefault: false
```

| Field | Type | Default | Purpose |
|---|---|---|---|
| `repo` | string | (required) | Name of a repository in the same organization. |
| `branch` | string | (required) | Branch the pin refers to. The linked workspace must be on this branch. |
| `changelist` | number | (required) | The exact changelist to pin. |
| `path` | string | none | Makes the link nested: the repo-relative folder where the linked workspace is created. |
| `enabledByDefault` | boolean | `true` | Nested links only. Whether workspaces that haven't chosen a mode get the link created and followed. Set `false` for something only some people need, like source art. |

Rules the server checks when it reads the config:

- Each repo can be linked only once.
- `path` must be relative and stay inside the repo: no leading slash, no drive letter, no `..`, no empty or `.` segments, and not inside `.checkpoint`.
- Two nested links can't share a folder or sit one inside the other (compared without case).
- A nested link can't be mounted where the parent repo tracks files. Delete or move those files first. Once a mount exists, submits that add or change files under it in the parent are refused; deleting files there is allowed.

Because the config is versioned, the pin is resolved per changelist: syncing the game to an old changelist brings the engine to the engine changelist that game changelist pinned. To bump a pin, edit `changelist` and submit.

Linking is not transitive. A linked repo's own `linkedRepos` are not followed.

## Link modes

Each workspace decides how it treats each link:

- **Follow the pin** (`follow-pin`): Team Sync syncs the linked workspace to the pin before syncing the parent.
- **Manual** (`manual`): Team Sync only reports when the linked workspace differs from the pin. Useful for engine developers who work ahead of the pin or carry local engine edits, since Team Sync never moves it.
- **Ignore** (`ignore`): Team Sync leaves the link alone: nothing is created or synced, and nothing is reported. An ignored nested link leaves its folder empty, and the folder still belongs to the linked repo.

A workspace's mode comes from, in order:

1. Its own choice in **Team Sync settings > Linked Repos**.
2. The selected [preset](team-sync.md#presets) (or the repo's `default: true` preset if none was picked), through the preset's `linkedRepos` map.
3. The default: follow the pin. For a nested link with `enabledByDefault: false`, the default is ignore.

Presets let you hand out roles instead of asking everyone to configure links:

```yaml
presets:
  - name: Artist
    default: true
    linkedRepos:
      UE5: follow-pin
      StudioArt: follow-pin
  - name: Programmer
    linkedRepos:
      StudioArt: ignore
```

## Setting up an anywhere-on-disk link

Team Sync can't guess where a shared workspace belongs, so each person sets it up once per machine. Until then the link shows as **not set up** and the parent still syncs normally.

1. In Team Sync, click the link's badge in the status bar (or open **Team Sync settings > Linked Repos**).
2. In the workspace picker, choose one of:
   - An existing workspace of the linked repo.
   - **Create a new workspace...**, then pick a folder. The folder can't be inside, contain, or be another workspace. The new workspace starts empty, and the next sync of the parent brings it to the pin.
   - **No workspace**, to clear the choice.
3. Pick a mode.

Link changes apply immediately rather than on **Save**. **Reset** drops your choice so the preset or default applies again.

Several parents can share one linked workspace. Since one workspace can only be at one changelist, if another parent last moved it and wants a different changelist, Team Sync asks before moving it. To keep two games on different engine versions, give each its own engine workspace.

## Nested links

In follow-pin mode, the first sync of the parent creates the nested workspace: it makes the folder, creates a workspace of the linked repo on the link's branch (named after the parent workspace and the repo), and syncs it to the pin. There's nothing to pick. Team Sync finds a nested link's workspace by its folder.

- In **Manual** mode, Team Sync doesn't create it, and reports a mismatch once one exists.
- If creation fails (for example, you have no access to that repo, or a file sits where the folder should go), the link shows **could not create** and the parent still syncs.
- If the folder already holds a workspace this machine doesn't know, Team Sync leaves it alone and reports it as missing.

The parent treats each mount folder as belonging to the linked repo, whatever the mode:

- Files there never show as pending changes or untracked files in the parent, and you can't stage them in the parent.
- The parent's sync filter, `checkpoint clean`, and Team Sync's **Clean Workspace** skip them.
- Any folder below the workspace root that holds its own `.checkpoint/workspace.json` is treated the same way, even if you nested it by hand.

When a nested workspace has pending changes, the desktop app's file view shows a strip above the parent's pending list ("*folder* is another workspace (*name*) with 2 pending changes. Submit them from there.") with an **Open** button, and `checkpoint status` prints a line for it. Submit those changes from the nested workspace.

If `path` changes in a later config, a new workspace is created at the new folder. The old one stays where it was (still protected, since it holds a workspace) until you remove it.

## What happens on sync

1. Team Sync reads the `linkedRepos` of the target changelist's config.
2. It checks every followed link before moving anything.
3. It syncs each followed link to its pin, using the linked repo's own `teamsync.yaml` (its categories and binaries).
4. It syncs the parent.

Linked repos go first, so if a linked sync fails, the parent stays on its old changelist with dependencies that still match.

Some situations stop the sync and ask you first:

- The linked workspace has local changes.
- It is ahead of the pin.
- Another parent moved it and is pinned to a different changelist.

The desktop app shows **Move linked repos?** listing each link and why, with **Move and sync**, **Sync without them**, and **Cancel**. It also sends an OS notification, since you may have walked away. If the linked workspace is busy with another operation, the sync fails with a "try again" message.

Other problems (link not set up, workspace missing, workspace on the wrong repo or branch, or a feature branch active in it) are reported, and the parent syncs anyway without moving that link.

If a changelist that moves a pin lands while you are syncing, the next sync catches the link up.

## Status and badges

- The Team Sync status bar shows a badge per link that isn't ignored, such as "UE5: at 48213", "UE5: needs sync", or "UE5: not set up". Click it to open the Linked Repos settings.
- **Linked Repos** settings show each link's pin, status, and a sentence on what the next sync will do ("Pinned 48213, at 48100. The next sync moves it to the pin.").
- The changelist browser marks changelists that move a pin with a "*Repo* update" chip; hover it for the old and new pin. Syncing across one also syncs that repo, and for an engine usually means a rebuild.
- [Bisect](team-sync.md#bisect) warns when its range moves a pin and offers **Hold linked repos where they are**.

## Linked repos from the CLI and build agents

`checkpoint pull` follows links too:

- `--confirm-links <repo...>` goes ahead with the named links that need confirmation. After a pull stops at linked repos, the CLI prints the command to run.
- `--skip-links` syncs the workspace without moving any links.
- If the workspace is already at the target changelist but a followed link is behind its pin, `pull` still syncs the links, so a build agent never builds against the wrong engine.
- For each followed link that didn't land, `pull` prints a warning with the reason. It still exits 0.

Build agents that run the CLI without a resident daemon (including [Unreal Horde](../integrations/horde.md) agents) follow links the same way, including creating nested workspaces. An anywhere-on-disk link still needs its workspace set up on that machine. See the [CLI guide](../clients/cli.md).

## Example: sharing a custom Unreal Engine

1. Put the engine in its own repo (say `UE5`) and each game in its own repo.
2. In each game's `.uproject`, set `"EngineAssociation"` to a fixed name the team agrees on, such as `"StudioEngine"`, and submit it.
3. In each game's `teamsync.yaml`, link the engine:

   ```yaml
   linkedRepos:
     - repo: UE5
       branch: main
       changelist: 48213
   ```

4. On each machine, set up the link once (pick or create the engine workspace), then register that folder under the agreed name: in the registry key `HKEY_CURRENT_USER\Software\Epic Games\Unreal Engine\Builds` on Windows, or in `Install.ini` on macOS and Linux. Team Sync's Unreal features look the name up there.

You can have the engine register itself with OS-specific `command` steps in the engine repo's own `teamsync.yaml`, which each person runs once with **Build** in the engine workspace:

```yaml
# UE5 repo's teamsync.yaml
version: 1
buildSteps:
  - id: register-engine-windows
    name: Register engine
    ifOs: windows
    command: reg
    arguments: 'add "HKCU\Software\Epic Games\Unreal Engine\Builds" /v StudioEngine /d "$(WorkspaceDir)" /f'
    normalSync: true

  - id: register-engine-unix
    name: Register engine
    ifOs: [macos, linux]
    command: $(WorkspaceDir)/Tools/register-engine.sh   # a script you commit in the engine repo
    arguments: StudioEngine "$(WorkspaceDir)"
    normalSync: true
```

Because artifacts are keyed by repo and changelist, the engine repo's own `artifacts` entries apply to the linked engine workspace: CI can build each engine changelist once, and everyone pinned to it downloads the binaries. See [Artifacts and CI](artifacts-and-ci.md).
