---
sidebar_position: 4
---

# Team Sync

Team Sync is a workspace view in the [desktop app](../clients/desktop-app.md) for teams that want everyone on a known-good build. If you have used UnrealGameSync (UGS) with Perforce, it will feel familiar: browse changelists with their CI results, sync to any of them, pull down precompiled binaries instead of building, run local build steps, and leave votes and comments for the team.

Team Sync is engine-agnostic. Everything works for any kind of project, and Unreal Engine support (default compile steps, Launch Editor, and Unreal build variables) is opt-in through an `unreal:` block in the config.

The team's shared setup lives in a `teamsync.yaml` file at the root of the repository. Each person's own choices (which categories to sync, which binaries to download, a sync schedule) are saved per workspace.

## Opening Team Sync

1. Open a workspace in the desktop app.
2. Click **Team Sync** in the workspace header.

The view has a status bar at the top, the changelist browser below it, and a log pane for the running job. Team Sync works without a `teamsync.yaml`: you can still browse, sync, vote, and comment. The config adds sync categories, build steps, binaries, and the rest.

## The changelist browser

Changelists on your branch are listed newest first and grouped by day. Each row shows:

- **CL**: the changelist number. A green dot means precompiled binaries were uploaded at exactly this changelist (hover to see their types). A ▶ marks the changelist you are synced to.
- **Type**: `Code`, `Content`, or `Both`, based on the file extensions in the change (see [`codeExtensions`](#codeextensions)).
- **Time**, **Author**, and **Message**. A "*Repo* update" chip before the message means the changelist moves a [linked repo](linked-repos.md) pin.
- **Status**: CI badges posted for that changelist, colored by state. Click a badge to open its build page. A person icon with a count shows how many teammates are synced there (hover for names).

Right-click a changelist for:

- **Sync to this CL**
- **Mark good** / **Mark bad** (click again to clear)
- **Star** / **Unstar**
- **Start investigating** / **Stop investigating**, to tell the team you are looking into a breakage
- **Leave comment...**
- **Copy CL number**

The changelist's author gets a notification when someone marks it bad or comments on it.

## Syncing

The status bar has the main actions:

- **Sync Latest**: sync to the head of your branch.
- **Sync Latest Good**: sync to the newest changelist where every required badge succeeded. Required badges come from the `requiredBadges` of the [`artifacts`](#artifacts) entries in `teamsync.yaml`. If the config defines none, there is no "good" changelist to find and Team Sync tells you so.
- **Build**: run the configured [build steps](#buildsteps).
- **Launch Editor**: Unreal repos only (see [Unreal Engine support](#unreal-engine-support)).

A Team Sync sync is an ordinary pull with extras. In order, it:

1. Syncs [linked repos](linked-repos.md) to the changelists the target changelist pins.
2. Pulls the workspace to the target changelist, keeping or merging local edits like any pull.
3. Applies your sync filter (sync categories plus your custom rules), removing files the filter now excludes. Files with local work are kept and reported.
4. Applies the precompiled binaries you chose, if any.
5. Writes Unreal version files, if you turned that on and no binaries were applied.

Build steps do not run automatically after a sync in this release. Click **Build** when you want them.

The status bar also shows the branch, the synced changelist, how many binary sets are applied, and a badge per linked repo.

## Precompiled binaries (artifacts)

CI can upload build outputs (an editor build, a game build, tools) for a changelist as **artifacts**. Each upload belongs to an artifact type, such as `editor-win64`. When you choose to sync a type, Team Sync downloads the newest set of that type at or before the changelist you sync to, so artists and designers can work without compiling.

To choose types:

1. Open **Team Sync settings** (the gear icon) and go to **After Sync**.
2. Under **Build**, click **Sync artifacts...** and tick the types you want.

No types are selected by default. Your choice saves immediately and applies on the next sync. Unticking a type removes its files on the next sync. If an `artifacts` entry has `requiredBadges`, Team Sync only uses sets from changelists where all of those badges succeeded. Team Sync looks back up to 200 changelists for a matching set.

See [Artifacts and CI](artifacts-and-ci.md) for how CI uploads artifacts and posts badges.

## Building locally

**Build** runs the build steps from `teamsync.yaml` (plus the default Unreal steps, if enabled) that have `normalSync: true` and are enabled for your workspace. Steps run in dependency order (`requires`), and the build stops at the first failing step. Output streams to the log pane and to `.checkpoint/logs/build-<job id>.log` in the workspace.

When the build finishes, Team Sync records an automatic compile vote (success or failure) on the synced changelist, so teammates can see whether it built for someone.

You can turn individual steps off for your workspace under **Team Sync settings > Build Steps**. Steps limited to other operating systems with `ifOs` are not listed.

## Bisect

Bisect finds the changelist that broke something.

1. Click the magnifying glass in the status bar.
2. Sync to a changelist, test it, and click **Mark good** or **Mark bad**. Do this for one good and one bad changelist to bound the search.
3. Click **Sync to next** to sync to the midpoint, test, and mark it. Repeat until the range narrows to the first bad changelist.
4. Click **Reset** to start over.

If the range moves a linked repo pin, the bisect bar says so and offers **Hold linked repos where they are**, which skips syncing linked repos while bisecting. It is faster, but a step may not build.

## Clean workspace

The broom icon opens **Clean Workspace**, which lists files on disk that the workspace does not account for.

- **Intermediate / derived** files (anything under `Intermediate/`, `Saved/`, `DerivedDataCache/`, `.vs/`, or `Binaries/`, plus `.sln` files) are selected by default and deleted outright.
- Other **Untracked** files are shown but not selected. If you select them, they are moved to `.checkpoint/clean-backups/<timestamp>/` rather than deleted.

Clean never touches tracked files, applied binaries, staged or new files, anything under `.checkpoint`, or folders that belong to a nested workspace.

## Scheduled sync

Under **Team Sync settings > Scheduled Sync** you can have the daemon sync the workspace every day at a set local time, even when the desktop app is closed (the daemon itself must be running).

Targets:

- **Latest changelist**: the branch head.
- **Latest good changelist**: the newest changelist whose required badges all succeeded. If the config has no required badges, this syncs the branch head.
- **Latest starred changelist**: not resolved yet in this release; it currently syncs the branch head.

If the computer was asleep at the scheduled time, the sync runs when the daemon next checks, as long as that is within 6 hours. A busy workspace is retried within the same window. A linked repo that needs your confirmation fails the run and leaves the workspace where it was. Scheduled syncs do not run build steps.

## Team Sync settings

The gear icon opens per-workspace settings, saved in the workspace's `.checkpoint/workspace.json`:

- **Sync Filters**: choose a preset, turn sync categories on or off, and add custom include and exclude rules (one gitignore-style pattern per line; exclude rules win). **Preview changes** tells you how many synced files the next sync would remove.
- **Linked Repos**: shown when the repo has linked repos. See [Linked repos](linked-repos.md).
- **Build Steps**: turn steps on or off for this workspace.
- **After Sync**: choose artifact types (**Sync artifacts...**). Unreal repos also get an editor configuration choice and **Write version files**. This tab also has after-sync checkboxes, but this release does not act on them yet.
- **Scheduled Sync**: see above.

## The teamsync.yaml file

Put `teamsync.yaml` at the root of the repository and submit it like any other file. Because it is versioned, the config that applies is the one at the changelist in question: a build uses the config at the changelist you are synced to, binaries use the config at the changelist being synced, and changing the config is a reviewable changelist.

Team Sync validates the file on the server. If it is not valid YAML or fails validation, Team Sync treats the repo as having no config, and the settings dialog says "No Team Sync config was found for this workspace."

:::caution
The desktop app does not show validation errors yet, and unknown keys are silently ignored rather than rejected. If your config seems to be ignored, check it against the reference below, especially spelling and indentation.
:::

### Minimal example (any engine)

```yaml
# teamsync.yaml at the repo root
version: 1

# Sync categories: what each person can choose to sync.
syncCategories:
  - id: core
    name: Code and config
    paths:
      - /src/
      - /tools/
      - /teamsync.yaml
  - id: art
    name: Art
    paths:
      - /assets/
  - id: source-art
    name: Source art (large)
    paths:
      - /source-art/
    enabledByDefault: false
    requires: [art]

# Local build steps, run with the Build button.
buildSteps:
  - id: build
    name: Build game
    command: ./build.sh
    arguments: --changelist $(Change)
    normalSync: true
    ifOs: [macos, linux]
  - id: build-windows
    name: Build game
    command: build.bat
    arguments: --changelist $(Change)
    normalSync: true
    ifOs: windows

# Binaries CI uploads, which people can download instead of building.
artifacts:
  - type: game-win64
    name: Windows game build
    requiredBadges: [Build Win64]
    include:
      - /bin/win64/
    exclude:
      - "*.pdb"
```

### Unreal example

```yaml
version: 1

# Opt in to Unreal support. All fields are optional.
unreal:
  editorTarget: MyGameEditor
  editorConfigurations: [Development, DebugGame]
  defaultBuildSteps: true   # adds the standard UBT compile steps

syncCategories:
  - id: engine-and-code
    name: Engine, code, and config
    paths:
      - /Engine/
      - /MyGame/Source/
      - /MyGame/Config/
      - /MyGame/*.uproject
      - /teamsync.yaml
  - id: content
    name: Game content
    paths:
      - /MyGame/Content/
  - id: cinematics
    name: Cinematics
    paths:
      - /MyGame/Content/Cinematics/
    enabledByDefault: false

buildSteps:
  # A cook through RunUAT, after the default editor compile step.
  # People who don't want it can turn it off under Build Steps.
  - id: cook-win64
    name: Cook Win64
    type: unreal-cook
    arguments: BuildCookRun -project="$(ProjectFile)" -platform=Win64 -cook -skipstage
    ifOs: windows
    normalSync: true
    requires: ["0FA1B2C3-D4E5-6789-ABCD-EF0123456701"]

artifacts:
  - type: editor-win64
    name: Editor binaries (Win64)
    requiredBadges: [Editor Win64]
    include:
      - "**/Binaries/Win64/"
    exclude:
      - "*.pdb"

forceClean:
  changelists: [1520]   # everyone does a clean compile once after crossing CL 1520

notifications:
  channels:
    - type: slack-webhook
      url: https://hooks.slack.com/services/XXX/YYY/ZZZ
      events: [badge-failure, badge-recovered]
```

## Config reference

Every field except `version` is optional. Defaults are applied before the config reaches any client.

Ids (`id` fields, step `requires`, category `requires`, and artifact `type`) may contain only letters, numbers, hyphens, and underscores, and are 1 to 100 characters long. Display names are up to 200 characters.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `version` | `1` | (required) | Config format version. Must be `1`. |
| `project` | object | none | Reserved (see [Reserved fields](#reserved-fields)). |
| `unreal` | object | none | Opt in to Unreal support. |
| `codeExtensions` | list of strings | built-in list | Extensions that make a changelist count as code. |
| `syncCategories` | list | `[]` | Groups of paths people choose to sync. |
| `presets` | list | `[]` | Named bundles of settings. |
| `linkedRepos` | list | `[]` | Other repos this repo pins. See [Linked repos](linked-repos.md). |
| `buildSteps` | list | `[]` | Local build steps. |
| `artifacts` | list | `[]` | Artifact types (precompiled binaries). |
| `forceClean` | object | `{ changelists: [] }` | Changelists that force a clean compile. |
| `notifications` | object | none | Webhooks for badge changes. |
| `badges`, `contentBadges`, `tools` | | | Reserved. |

### `unreal`

Its presence turns on Unreal support: the `unreal-compile` and `unreal-cook` step types, the default compile steps, Launch Editor, the Unreal build variables, and Unreal-only settings. Leave the block out for a non-Unreal repo. A step with an `unreal-*` type in a repo without this block fails with an error saying so.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `editorTarget` | string | discovered | UBT editor target name, such as `MyGameEditor`. Used when Team Sync can't find one from the project's target files. |
| `editorConfigurations` | list of strings | `[Development, DebugGame]` | Choices for the **Editor configuration** setting. |
| `defaultBuildSteps` | boolean | `true` | Add the standard compile steps (below) before your own `buildSteps`. Set `false` to define every step yourself. |
| `uproject` | string | | Reserved. Team Sync discovers `.uproject` files itself and uses the first one found. |

The default steps, all `unreal-compile` with `normalSync: true`:

| Step | Id | Runs after |
|---|---|---|
| Compile UnrealHeaderTool | `4A0B4F5A-4A9E-4D9A-8C2B-1E7B2A9C1D01` | |
| Compile *editor target* | `0FA1B2C3-D4E5-6789-ABCD-EF0123456701` | UnrealHeaderTool |
| Compile ShaderCompileWorker | `0FA1B2C3-D4E5-6789-ABCD-EF0123456702` | editor |
| Compile UnrealLightmass | `0FA1B2C3-D4E5-6789-ABCD-EF0123456703` | editor |
| Compile CrashReportClient | `0FA1B2C3-D4E5-6789-ABCD-EF0123456704` | editor |

To change a default step, add a step to `buildSteps` with the same `id`; yours replaces it. People can also turn default steps off for their own workspace.

### `codeExtensions`

A list of extensions, each starting with a dot (for example `[".cpp", ".h", ".cs"]`), that replaces the built-in list used for the **Type** column. A changelist touching any file with one of these extensions counts as code; any other file counts as content. The built-in list covers common source languages (C and C++, C#, Java, Kotlin, JavaScript, TypeScript, Python, Go, Rust, Swift, Lua, shell scripts, and more) plus `.usf`, `.ush`, `.uproject`, and `.uplugin`.

### `syncCategories`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `id` | id | (required) | Stable identifier. |
| `name` | string | (required) | Shown in settings. |
| `paths` | list of strings | (required, at least one) | Repo-relative gitignore-style patterns, such as `/Content/` or `*.wav`. |
| `enabledByDefault` | boolean | `true` | Whether the category is on for workspaces that haven't changed it. |
| `requires` | list of ids | `[]` | Categories turned on whenever this one is (transitively). |
| `hidden` | boolean | `false` | Leave it out of the settings dialog. Its default and `requires` still apply. |

:::warning
Once a repo defines sync categories, a workspace syncs **only** files that match an enabled category or one of its own custom include rules. Everything else is left out, for every workspace of the repo, including CLI and build-agent workspaces. Make sure your default categories cover everything people need (including `teamsync.yaml` and build scripts). If a workspace has no categories enabled and no custom include rules, no filter applies and everything syncs.
:::

Turning a category off removes its files from disk on the next sync. Files you have edited are kept.

### `presets`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | string | (required) | Shown in the **Preset** dropdown. |
| `default` | boolean | `false` | Applied to workspaces that never picked a preset. |
| `linkedRepos` | map of repo name to `follow-pin`, `manual`, or `ignore` | `{}` | Link modes for workspaces that haven't chosen one. See [Linked repos](linked-repos.md). |
| `categories` | map of category id to boolean | `{}` | Reserved. |
| `buildSteps` | map of step id to boolean | `{}` | Reserved. |
| `locked` | boolean | `false` | Only labels the preset "(locked)" in the dropdown. |

:::note
In this release, presets only apply their `linkedRepos` modes. Their `categories` and `buildSteps` maps are accepted but not applied yet, so set category defaults with `enabledByDefault` instead.
:::

### `buildSteps`

| Field | Type | Default | Purpose |
|---|---|---|---|
| `id` | id | (required) | Stable identifier, used by `requires` and per-workspace overrides. |
| `name` | string | (required) | Shown in the step list and log. |
| `type` | `command`, `unreal-compile`, or `unreal-cook` | `command` | How the step runs. |
| `command` | string | | The executable or script to run. Required for `command` steps. |
| `arguments` | string | | Appended to the command line. |
| `workingDir` | string | workspace root (`command`), engine root (`unreal-*`) | Where the step runs. |
| `target` | string | | UBT target. Required for `unreal-compile`. |
| `platform` | string | host platform (`Win64`, `Mac`, or `Linux`) | UBT platform, `unreal-compile` only. |
| `configuration` | string | `Development` | UBT configuration, `unreal-compile` only. |
| `ifOs` | `windows`, `macos`, `linux`, or a list of them | every OS | Only run (and only list) the step on these operating systems. |
| `requires` | list of step ids | `[]` | Steps that must run first. |
| `normalSync` | boolean | `false` | Include the step when someone clicks **Build**. |
| `scheduledSync` | boolean | `false` | Reserved for builds after a scheduled sync, which don't run build steps yet. |
| `estimatedDurationSec`, `link` | | | Reserved. |

:::tip
`normalSync` defaults to `false`, so a step you want the **Build** button to run needs `normalSync: true`.
:::

How each type runs:

- **`command`**: runs `command` followed by `arguments` through the system shell (`cmd.exe` on Windows, `/bin/sh` elsewhere). A non-zero exit code fails the step.
- **`unreal-compile`**: runs the engine's `Build.bat` (or `Build.sh`) with `target`, `platform`, `configuration`, `-Project="<your .uproject>"`, `-WaitMutex`, `-NoHotReloadFromIDE`, then `arguments`.
- **`unreal-cook`**: runs the engine's `RunUAT.bat` (or `RunUAT.sh`) with `arguments`, so put the full UAT command line there.

`ifOs` and `requires` work together: a step that requires a step skipped on this OS treats it as satisfied, so OS-specific variants of one step can feed a shared later step. Validation rejects a step that requires a step it never shares an OS with. A dependency cycle fails the build.

### Build variables

`command`, `arguments`, and `workingDir` can use `$(Name)` variables, matched without case. The syntax matches UGS, so UGS build step arguments port over.

| Variable | Value |
|---|---|
| `$(WorkspaceDir)` | Workspace root on disk. Alias: `$(BranchDir)`. |
| `$(Change)` | Changelist the workspace is synced to. |
| `$(Branch)` | The workspace's branch. |
| `$(WorkspaceName)` | Workspace name. Alias: `$(ClientName)`. |
| `$(PlatformName)` | Host platform: `Win64`, `Mac`, or `Linux`. |
| `$(ProjectDir)` | Unreal only: folder holding the `.uproject`. |
| `$(ProjectFile)` | Unreal only: full path to the `.uproject`. |
| `$(EngineDir)` | Unreal only: engine root (the folder containing `Engine/`). |
| `$(EditorExe)` | Unreal only: path to the editor executable. |
| `$(EditorTarget)` | Unreal only: the editor target name. |

An unknown variable, or an Unreal variable in a repo without Unreal support, is left as written and the build log warns about it.

### `artifacts`

Each entry declares an artifact type: a kind of build output CI uploads and people can choose to download.

| Field | Type | Default | Purpose |
|---|---|---|---|
| `type` | id | (required) | The artifact type, such as `editor-win64`. CI names it when uploading. |
| `name` | string | | Friendlier label in the **Sync artifacts** dialog. |
| `requiredBadges` | list of badge names | `[]` | Only use sets from changelists where all of these badges are `SUCCESS`. These badges also define "good" for **Sync Latest Good** and scheduled sync. |
| `include` | list of patterns | `[]` | Files `checkpoint artifact upload --type <type>` collects when CI names no files. |
| `exclude` | list of patterns | `[]` | Files left out of an upload, even inside folders CI names. |

Patterns use [`.chkignore` syntax](ignoring-files.md), with `/` as the separator (a backslash is rejected). `.chkignore` itself does not apply to artifact uploads, since build outputs are usually ignored. See [Artifacts and CI](artifacts-and-ci.md).

### `forceClean`

```yaml
forceClean:
  changelists: [1520, 1874]
```

The first time a workspace builds at or past one of these changelists, having last built before it, its `unreal-compile` steps run with `-Clean`. Use it after a change that leaves stale build products behind. It does not change how `command` steps run.

### `notifications`

```yaml
notifications:
  channels:
    - type: slack-webhook        # or generic-webhook
      url: https://hooks.slack.com/services/XXX/YYY/ZZZ
      events: [badge-failure, badge-recovered]   # default: [badge-failure]
```

The server posts to each channel when a CI badge changes:

- `badge-failure`: a badge enters `FAILURE`.
- `badge-recovered`: a badge on the same changelist goes from `FAILURE` to `SUCCESS`.

`slack-webhook` posts a Slack message. `generic-webhook` posts JSON with `event`, `repo` (`org/repo`), `changelist`, `badge`, `state`, and `url`. Delivery is best effort with a 5 second timeout. Channels are read from the config at the head of the repo's default branch.

The schema also accepts `investigation-started` and `investigation-resolved`, but this release does not send them.

### Reserved fields

These are accepted by validation so configs written for later releases still load, but nothing uses them yet: `project.name`, `unreal.uproject`, `badges.columns`, `contentBadges`, `tools`, preset `categories` and `buildSteps`, and step `scheduledSync`, `estimatedDurationSec`, and `link`.

## Unreal Engine support

With an `unreal:` block in the config, Team Sync:

- Finds the workspace's `.uproject` and its engine. The engine is the workspace itself when it contains `Engine/Build/Build.version`; otherwise it comes from the project's `EngineAssociation`, looked up (by GUID or by a name such as `StudioEngine`) in the Unreal builds registry on Windows or `Install.ini` on macOS and Linux, then as an installed launcher version.
- Adds the default compile steps unless `defaultBuildSteps: false`.
- Shows **Launch Editor** in the status bar once the project and engine are found. It opens the editor with your project.
- Offers **Write version files** (under **After Sync**), which writes the synced changelist into the engine's version files after a sync (unless binaries were applied) and after a successful local build.

For a custom engine kept in its own repository and shared by several games, see [Linked repos](linked-repos.md).

## Access

Anyone who can read a repository can use Team Sync with it. Posting badges and uploading artifacts need write access. Self-hosted servers have every Team Sync feature enabled; there is no license to install.
