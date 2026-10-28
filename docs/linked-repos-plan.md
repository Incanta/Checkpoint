# Linked repos plan: share one engine across games, mount plugins in place

Plan for letting a Team Sync repo pin other repos at a changelist and keep local workspaces of them in sync. The motivating case is a custom Unreal Engine kept in its own repo and synced once per machine, shared by every game, instead of the Perforce convention of committing `Engine/` next to (or around) each game. Written 2026-10-27 on `1b2757a`.

**Progress (2026-10-27): phases 1 and 2 are implemented** (uncommitted). See [Phase 1 as built](#phase-1-as-built) and [Phase 2 as built](#phase-2-as-built) for where they live and where they differ from this plan.

## Goals

- A game repo says which engine repo and changelist it builds against. Syncing the game to any changelist brings the engine to the changelist that game CL was pinned to.
- One engine workspace on disk can serve several games.
- Plugins, source art, and similar repos can be mounted at a fixed path inside a parent workspace and follow the parent's pin, like git submodules.
- The linking feature stays engine-agnostic. It syncs repos and knows nothing about what is inside them.

## Config

Links live in the parent repo's `.checkpoint/teamsync.yaml`, as a new top-level `linkedRepos` list. Because the server already serves `teamSync.getConfig` as of any changelist, the pin resolves per changelist for free, and bumping the engine is an ordinary, reviewable changelist in the game repo.

```yaml
linkedRepos:
  # Anywhere on disk: the user picks or creates the workspace; it can be shared
  - repo: UE5
    branch: main
    changelist: 48213

  # Fixed spot inside this workspace: Team Sync creates it there
  - repo: StudioPlugins
    branch: main
    changelist: 9120
    path: Plugins/StudioPlugins
```

Fields:

- `repo`: repo name in the same org.
- `branch`: branch the pin refers to.
- `changelist`: exact pin.
- `path` (optional): repo-relative mount path. Its presence makes the link a nested link (see below); absent means an anywhere-on-disk link.
- `enabledByDefault` (optional, nested links only, default `true`): whether a workspace with no entry for this link gets it created automatically. See [Links missing from `workspace.json`](#links-missing-from-workspacejson).

Nothing goes in the `unreal` block. Its presence still only opts the repo into Unreal features. Earlier drafts had `unreal.engine` pointing at a linked repo; that only helped Team Sync's own build actions find the engine, while UE itself still needed the engine registered, so it was dropped.

The per-machine half lives in the parent workspace's `workspace.json`, since which local workspace satisfies a link is a user choice, not a repo fact:

```json
"teamSync": {
  "linkedWorkspaces": {
    "UE5": { "workspaceId": "...", "mode": "follow-pin" }
  }
}
```

Entries are keyed by repo name, which is unique within a parent's `linkedRepos` (linking the same repo twice is rejected at config validation).

`mode` is one of:

- `follow-pin`: Team Sync syncs the linked workspace to the pin.
- `manual`: Team Sync only reports a mismatch. For engine developers who work ahead of the pin or carry local engine edits; Team Sync must never downgrade them silently.
- `ignore`: Team Sync leaves the link alone entirely. No workspace is created or synced, no mismatch is reported, and the link doesn't count toward "out of date" status. For people who don't need it, such as programmers who never open source art. An ignored nested link leaves its mount path empty; the parent still treats the path as owned by the child, so nothing there shows up as untracked.

### Links missing from `workspace.json`

A link the parent workspace has no entry for (a fresh workspace, or a link added to `teamsync.yaml` after the workspace was set up) is never an error, and never blocks syncing the parent.

- **Nested links** follow a repo-level default: an optional `enabledByDefault` on the link (default `true`), like sync categories. Enabled means Team Sync creates the child workspace at `path` on the next sync and records it as `follow-pin`; disabled means it records `ignore`. A source art link would typically set `enabledByDefault: false` so only artists opt in.
- **Anywhere-on-disk links** can't be created without knowing where to put them, so the parent syncs normally and Team Sync shows the link as "not set up" with three actions: pick an existing workspace of that repo, create one in a chosen folder, or ignore. Scheduled sync and the CLI skip unset links and say so in their log.

Presets can set link modes alongside categories and build steps (`linkedRepos: { StudioArt: ignore }`), so a team can hand out an "Artist" and a "Programmer" preset instead of asking each person to configure links.

## Two kinds of link

### Anywhere on disk (engine-style)

- The user chooses the folder, or picks an existing workspace of that repo. The choice is stored in `workspace.json`.
- Several parent workspaces can share one linked workspace, so two games can pin it to different changelists. See [Shared pin conflicts](#shared-pin-conflicts).
- The parent does not need to know where it is. Other tools find it on their own (for the engine, UE's builds registry).

### Fixed relative path (plugins, source art)

- Team Sync creates the workspace at `path` inside the parent automatically. There is nothing for the user to pick.
- It belongs to exactly one parent, so pins never conflict. The cost is one copy per parent on disk, which is fine for plugins and source art but would defeat the purpose for an engine.
- Moving the pin in the parent repo moves the child.

## Sync flow

1. Resolve the target parent changelist's `teamsync.yaml` and read its `linkedRepos`.
2. For each link in `follow-pin` mode (resolving links missing from `workspace.json` as described above), sync the linked workspace to the pin through the normal `runSyncPipeline`, using the linked repo's own `teamsync.yaml` (its own categories, presets, artifacts, and after-sync build steps).
3. Sync the parent.

Linked repos go first so a failed link sync leaves the parent on its old changelist with its old dependencies, which still builds. The whole thing is still not atomic, so the parent workspace state records the last applied pin per link, and the UI can show "engine out of date" when they disagree.

Scheduled sync and the CLI go through the same pipeline and get this for free.

### Shared pin conflicts

One shared workspace can only be at one changelist, and moving an engine usually means a full rebuild. The linked workspace's state records which parent workspace last moved it. When a different parent wants a different changelist, Team Sync asks first ("Game A is pinned to 48213; this moves the engine to 48500") instead of syncing silently. Keeping one engine workspace per pin is the escape hatch when two games must stay on different engine versions.

### Local changes in a linked workspace

Syncing a linked workspace follows the same rules as any pull: local edits are merged or kept, never lost. A linked workspace with pending changes, or one ahead of the pin, should prompt rather than sync automatically, even in `follow-pin` mode.

## Unreal engine resolution

The `.uproject`'s `EngineAssociation` already says which engine a game uses. The team commits a fixed, agreed name there (for example `"EngineAssociation": "StudioEngine"`), and each machine registers its engine workspace's folder under that name in UE's builds registry: `HKCU\Software\Epic Games\Unreal Engine\Builds` on Windows, `Install.ini` on macOS and Linux. Registration happens once per engine folder, not per sync.

A fixed name matters. UE's own "Switch Unreal Engine version" (UnrealVersionSelector) registers a source engine under a random GUID that differs per machine and writes it into the committed `.uproject`, which causes churn.

How the folder gets registered is up to the team:

- By hand, once per machine.
- Optionally, as `command` build steps in the engine repo's own `teamsync.yaml`, so linking stays agnostic and the engine registers itself. Registration differs per OS, so each step is limited to one OS with the new `ifOs` field (see [Build step OS condition](#build-step-os-condition)):

```yaml
# UE5 repo's .checkpoint/teamsync.yaml
buildSteps:
  - id: register-engine-windows
    name: Register engine
    type: command
    ifOs: windows
    command: reg
    arguments: add "HKCU\Software\Epic Games\Unreal Engine\Builds" /v StudioEngine /d "$(WorkspaceDir)" /f
    normalSync: true

  # Install.ini edits aren't a one-liner, so this calls a script committed in the engine repo
  - id: register-engine-unix
    name: Register engine
    type: command
    ifOs: [macos, linux]
    command: $(WorkspaceDir)/Tools/register-engine.sh
    arguments: StudioEngine "$(WorkspaceDir)"
    normalSync: true
```

### Build step OS condition

New optional field on `TeamSyncBuildStep`: `ifOs`, either one OS or a list, from `windows`, `macos`, and `linux`. A step whose `ifOs` doesn't include the host OS is skipped and hidden in the build step list. Absent means every OS, which is today's behavior.

- It's named `ifOs` rather than `os` or `platform` because `platform` already means UBT's target platform (Win64 and so on), and the `if` prefix makes it read as a condition. It follows the config's camelCase keys.
- A step that `requires` an OS-skipped step treats it as satisfied, so OS variants of one step can be required by a shared later step. Config validation should flag a `requires` chain where a step needs a step that can never run on any OS it runs on.
- Steps keep distinct ids per OS variant, so presets and workspace overrides can still target each one.
- The field is generic and useful beyond engine registration (for example, a Windows-only `Setup.bat` versus `Setup.sh` elsewhere).

Required code change: `resolveEngine` (`src/core/daemon/src/util/unreal/engine-discovery.ts`) only looks up GUID associations in the builds registry today; anything else is treated as a launcher version such as `5.4`. It must look up non-version names in the builds registry (and `Install.ini`) too, or Team Sync's own `unreal-*` steps, Launch Editor, and Generate Project Files fail for a name like `StudioEngine`.

### Shared engine binaries

Games on a shared engine should keep their editor targets at the default `BuildEnvironment = TargetBuildEnvironment.Shared`. A Shared target reuses the engine's compiled modules in `Engine/Binaries` and only compiles its own modules into the game folder, so the engine compiles once for every game. UBT refuses to let a Shared target change engine-affecting settings (the "has build products in common with UnrealEditor" error), so Shared games can't invalidate each other's engine binaries.

A game that needs custom engine-wide settings switches to `TargetBuildEnvironment.Unique` and compiles its own copy of the engine modules. That costs disk and compile time per game but doesn't interfere with other games.

The coupling that does exist is the engine's BuildId: a game's module binaries load only if they were built against the engine binaries' current BuildId. Whenever the engine binaries change (the pin moves, someone rebuilds the engine, or precompiled engine binaries are applied), every game's own modules need a rebuild before the editor loads them. This is a cost of sharing an engine, and part of why pin changes get an "engine update" badge. Which engine changes bump the BuildId should be verified on the engine version in use. Worth documenting for users.

### Precompiled binaries

Engine artifacts are keyed by engine repo and changelist, so the engine repo's own `artifacts` channels apply to the linked workspace. CI builds each engine changelist once and every game on that pin pulls the binaries. This is what makes the shared-engine model cheap for people who don't build the engine.

## Nested link groundwork

The parent workspace does not know about workspaces nested inside it yet. Before nested links ship:

- **Status and file listing:** the directory scan only skips the parent's own root `.checkpoint` (`daemon-manager.ts`, in the directory listing). Everything under a mount path, including the child's `.checkpoint/state.db`, would show up as untracked files in the parent and could be submitted to the wrong repo. The parent must treat mount paths as owned by the child: excluded from scanning, the file watcher, submit, sync-filter reconcile, and Clean Workspace.
- **Collisions:** if the parent repo tracks files under a mount path, reject the link at config validation (in the app's zod schema), not at sync time.
- **Command targeting:** `getWorkspaceRoot` (`util.ts`) walks up to the nearest `.checkpoint`, so a CLI command run inside a mount already targets the child. No change needed.
- **UI:** the parent's pending changes should show that a nested child has local changes, or link to them, so plugin edits aren't forgotten in a workspace the user isn't looking at.

## UX

- Team Sync settings show each link: the linked workspace, its mode, the pin, and whether the workspace matches ("pinned 48213, at 48213" or "pinned 48213, at 48100, needs sync").
- The changelist browser badges parent changelists that change a pin ("engine update"), since syncing across one costs a linked sync and maybe a rebuild.
- Bisect warns, or offers to hold linked repos fixed, when its range crosses pin changes.

## Phases

| Phase | What | Notes |
|---|---|---|
| 1 | `linkedRepos` schema (app zod schema and `teamsync-config.ts`), `linkedWorkspaces` in `workspace.json`, anywhere-on-disk links, sync flow, `follow-pin`, `manual`, and `ignore` modes, "not set up" handling for missing entries, link modes in presets, shared-pin confirmation | Covers the engine case. Does not touch the parent's scanning. |
| 2 | `resolveEngine` looks up non-GUID names in the builds registry and `Install.ini`; `ifOs` on build steps (zod schema, `teamsync-config.ts`, step resolution in the daemon, desktop step list) | Small; can land alongside phase 1. |
| 3 | Settings UI, pin-change badge, bisect warning | |
| 4 | Nested-link groundwork: mount paths owned by the child across scan, watcher, submit, reconcile, and clean; collision validation | Must land before nested links. |
| 5 | Nested links (`path`), `enabledByDefault`, auto-created child workspaces, pending-change surfacing in the parent | |

## Phase 1 as built

Where it lives:

- Schema: `linkedRepos` and preset `linkedRepos` in `src/app/src/server/team-sync/config-schema.ts`, mirrored in `src/core/common/src/types/teamsync-config.ts`.
- Rules and orchestration: `src/core/daemon/src/util/team-sync/linked-repos.ts`. `resolveLinkChoice` (workspace entry, then preset, then default) and `decideLinkSync` are pure; `syncLinkedRepos` runs before the parent's sync in the pull endpoint (`api/routers/workspace/sync.ts`) and in scheduled sync (`daemon-manager.ts`).
- State: `linkedPins` on the parent and `linkHolder` on the linked workspace, as `workspace_meta` keys in the state store.
- Endpoints (`api/routers/workspace/team-sync.ts`): `getLinkedRepos`, `listLinkCandidates`, `setLinkedWorkspace` (checks the workspace holds the linked repo in the same org), and `clearLinkedWorkspace`. The pull endpoint takes `confirmLinks` (repo names) and `skipLinks`, and its job result carries `linkedRepos` and `stalePins`.
- Tests: `src/tests/src/daemon/linked-repos-rules.test.ts` (rules), `src/tests/src/daemon/linked-repos.test.ts` (end to end through the daemon), and `src/tests/src/server/team-sync-linked-repos-config.test.ts` (schema).

Decisions made while building:

- **What stops the parent's sync:** a link that needs confirmation (local changes, ahead of the pin, held by another parent at a different changelist), a busy linked workspace, or a failed linked sync. All links are checked before any moves. Configuration problems (not set up, missing or wrong workspace, wrong branch, feature branches overlaid) are reported and the parent syncs anyway. An unreadable repo config skips links and syncs the parent.
- **Busy blocks:** a linked workspace in the middle of another operation would otherwise be skipped, leaving the parent ahead of it, so the sync fails with a "try again" message. A busy workspace already at the pin doesn't matter.
- **Held by another:** only counts while that parent is still registered and the linked workspace is still at the changelist it moved it to.
- **Presets:** the selected preset applies, or the repo's default preset when the workspace never chose one; an explicit Custom (`preset: null`) applies none. Presets weren't applied anywhere in the daemon before (categories ignore them too), so this is the first consumer.
- **Not transitive:** a linked repo's own links are not followed.
- **Nested links:** `path` and `enabledByDefault` validate, but such links report `unsupported` and are never synced until phase 5.
- **Stale pins:** if a changelist that moves a pin lands between resolving the target and the parent's pull, the job result lists the link in `stalePins`; the next sync fixes it.

Not done in phase 1:

- **Creating a linked workspace in a chosen folder:** phase 3's UI can use the existing workspace-creation flow and then call `setLinkedWorkspace`.
- **Confirmation in the desktop app:** a blocked pull shows the error text until phase 3 adds a prompt that resends with `confirmLinks`.
- **The C++ CLI:** it has no `--confirm-links` flag yet, and a daemonless CLI only registers its own workspace, so its links report `missing-workspace`.

## Phase 2 as built

Engine lookup (`src/core/daemon/src/util/unreal/engine-discovery.ts`):

- `resolveEngine` looks up any registrable association (a GUID or a name like `StudioEngine`) in the builds registry key on Windows and `Install.ini` on macOS and Linux. An unregistered GUID still resolves to nothing; an unregistered name falls through to the launcher lookup, since a version like `5.4` can also be registered by hand.
- Identifiers compare without case, and GUIDs match with or without braces.
- `reg` now runs through `execFile`, never a shell. Before, an association that wasn't a GUID was pasted into a shell command for the HKLM lookup, so a hostile `.uproject` could run commands. Associations with control characters or path separators are not looked up at all.
- The registry and `Install.ini` parsing are pure functions (`parseBuildsRegOutput`, `parseInstallIni`), tested directly.

Build step OS condition:

- `ifOs` in the app schema accepts one OS or a list and resolves to a list without repeats; `TeamSyncBuildStep.ifOs` in common is always a list. Validation rejects a step that requires a step sharing none of its OSes. Ids the config doesn't define (the Unreal default steps) run everywhere, so requiring them never trips it.
- The daemon's `hostOs` and `stepRunsOn` (`util/build/steps.ts`) filter steps before ordering in `runBuild`, so a requirement on a skipped step counts as met. A skipped step requested by id gets a line in the build log saying why. A platform `ifOs` can't name runs only steps without `ifOs`.
- Workspace custom steps accept `ifOs` too, and the desktop settings dialog hides steps for other OSes.
- Tests: `src/tests/src/daemon/build-step-os.test.ts`, `src/tests/src/daemon/engine-association.test.ts` (including that the association never reaches a shell), and `src/tests/src/server/team-sync-build-step-os-config.test.ts`.

## Open questions

- Exact pins only, or also allow a minimum engine changelist so games can share an engine more easily? Exact is the default either way.
- Support several workspaces of the same linked repo per machine from day one (one per pin), or start with one?
- Links across orgs: out of scope for now; `repo` is a name in the parent's org.

## Rejected alternatives

- **Server-side import (Perforce stream `import` style):** composing the engine into each game's tree on the server would give every game workspace its own engine copy, which defeats syncing the engine once.
- **Rewriting `EngineAssociation` per user:** the `.uproject` is committed, so per-machine values cause churn. A fixed committed name plus per-machine registration avoids it.
- **`unreal.engine` pointing at a linked repo:** only helped Team Sync's own build actions; UE outside Team Sync still needed registration, so it added config without removing work.
