---
sidebar_position: 6
---

# Artifacts and CI

Checkpoint gives your CI system two ways to report back on a changelist:

- **Artifacts**: build outputs (editor binaries, a game build, tools) uploaded for a changelist, so teammates can download them with [Team Sync](team-sync.md) instead of building.
- **Build badges**: a named status per changelist (such as "Editor Win64: SUCCESS") with a link to the build, shown in Team Sync's changelist browser.

Both work with any CI system that can run the [Checkpoint CLI](../clients/cli.md) or make an HTTP request. If you use Unreal Horde, see the [Horde integration](../integrations/horde.md) for agent setup.

## Set up a CI account

CI authenticates with an API token, just like a person's device.

1. Create a user for CI (for example `ci@yourstudio.com`) and add it to your organization with **write** access to the repositories it builds. Posting badges and uploading artifacts both need write access. See [Organizations and access](../self-hosting/organizations-and-access.md).
2. Sign in to the web app as that user and open **Devices & Tokens** from the user menu.
3. Enter a token name, leave **Device Code** empty, choose an expiration, and click **Create Token**.
4. Copy the token from the dialog and store it as a secret in your CI system. It is only shown once.

## Artifacts

An artifact upload attaches files to an existing changelist as a set of one **artifact type**. Every upload must name its type. Types are names you choose, such as `editor-win64` or `game-linux`, using letters, numbers, hyphens, and underscores.

Each changelist holds at most one set per type. Teammates choose which types they want, and Team Sync applies the newest set of each type at or before the changelist they sync to.

### Declare the type in teamsync.yaml

Declare each type in the repo's `teamsync.yaml`, so Team Sync can offer it and the CLI knows which files to collect:

```yaml
artifacts:
  - type: editor-win64
    name: Editor binaries (Win64)
    requiredBadges: [Editor Win64]
    include:
      - "**/Binaries/Win64/"
    exclude:
      - "*.pdb"
```

- `include` and `exclude` use [`.chkignore` syntax](ignoring-files.md) with `/` separators. An upload with no files named collects everything that matches `include` and not `exclude`.
- `requiredBadges` makes Team Sync skip sets from changelists where any of these badges isn't `SUCCESS`. Post those badges after the upload so nobody downloads a build that failed its tests.

See the [`artifacts` reference](team-sync.md#artifacts) for every field.

### Upload from CI

Run the upload from inside a Checkpoint workspace on the build machine. On a machine with no Checkpoint daemon running, the CLI starts a temporary one for each command, so CI agents need only the CLI.

```sh
# One-time setup on the agent (or at the start of each job)
checkpoint login --endpoint https://checkpoint.example.com --token "$CHECKPOINT_TOKEN" --id ci
mkdir -p build-ws && cd build-ws
checkpoint init myorg/mygame --branch main

# Each build
checkpoint pull --changelist 1234
# ... build ...
checkpoint artifact upload 1234 --type editor-win64
```

`checkpoint artifact upload <changelist> --type <type> [files...]`:

- **No files named**: collects the files the type's `include` and `exclude` patterns select, and **replaces** the type's set at that changelist. This is the usual way to upload.
- **Files or folders named**: uploads those (a folder means every file in it, minus `exclude` matches) and **adds** them to the set. Add `--replace` to replace the set instead.
- `--message` (`-m`) sets the upload message.

`.chkignore` never applies to artifact uploads, since build outputs are what it usually ignores. Paths are relative to the workspace root, and they are the paths the files land at in teammates' workspaces. Files inside a nested [linked repo](linked-repos.md) folder can't be uploaded from the parent; upload them from that workspace.

The changelist must already exist on the server. Uploads are content-addressed like any other Checkpoint data, so unchanged binaries upload quickly.

### How Team Sync uses artifacts

When someone has chosen a type under **Team Sync settings > After Sync > Sync artifacts...**, each sync:

1. Finds the newest set of that type at or before the synced changelist on the branch's history (looking back up to 200 changelists), skipping changelists where a `requiredBadges` badge didn't succeed.
2. Removes files from the previously applied set that the new set no longer has or has changed.
3. Downloads the set into the workspace.

The status bar shows which sets are applied ("editor-win64 @ CL 1230"), and the changelist browser shows a green dot on changelists that have artifacts.

## Build badges

A badge is a named status on one changelist. Posting a badge again with the same name and changelist updates it, so post `STARTING` when a build begins and the result when it ends.

| State | Meaning |
|---|---|
| `STARTING` | Build in progress. |
| `SUCCESS` | Passed. |
| `WARNING` | Passed with warnings. |
| `FAILURE` | Failed. |
| `SKIPPED` | Not run for this changelist. |

### Post badges over HTTP

Send a `POST` to `/api/ci/badges` on your Checkpoint web app with the CI token as a bearer token:

```sh
curl -X POST "https://checkpoint.example.com/api/ci/badges" \
  -H "Authorization: Bearer $CHECKPOINT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "myorg/mygame",
    "changelist": 1234,
    "badges": [
      { "name": "Editor Win64", "state": "SUCCESS", "url": "https://ci.example.com/runs/987" },
      { "name": "Tests", "state": "FAILURE", "url": "https://ci.example.com/runs/988" }
    ]
  }'
```

Body fields:

| Field | Required | Description |
|---|---|---|
| `repo` | `repo` or `repoId` | Repository as `org/repo`. |
| `repoId` | `repo` or `repoId` | Repository id, instead of `repo`. |
| `changelist` | yes | Changelist number. |
| `badges` | yes, at least one | List of badges. |
| `badges[].name` | yes | Badge name, up to 100 characters. This is what `requiredBadges` refers to. |
| `badges[].state` | yes | One of the states above, in any case. |
| `badges[].url` | no | Link to the build. Must be a full URL. |
| `badges[].group` | no | Optional group label, up to 100 characters. |
| `badges[].metadata` | no | Any JSON object, stored with the badge. |

A successful call returns `{ "ok": true, "count": <badges written> }`. Errors return `{ "error": "..." }` with status 400 (bad input), 401 (missing or invalid token), 403 (no write access), or 404 (unknown repo).

### What badges do

- Team Sync's changelist browser shows them as colored chips; clicking one opens its `url`.
- `requiredBadges` on an artifact type gates which artifact sets Team Sync applies.
- The same required badges define "good" for **Sync Latest Good** and scheduled syncs to the latest good changelist. A repo with no `requiredBadges` has no notion of a good changelist.
- When a badge enters `FAILURE`, the server notifies the authors of the changelists since that badge last succeeded, plus anyone investigating. When the same badge on that changelist later goes back to `SUCCESS`, they get a recovery notification.
- A `notifications` block in `teamsync.yaml` can also post failures and recoveries to Slack or a generic webhook. See the [`notifications` reference](team-sync.md#notifications).

## Putting it together

A typical CI job for one changelist:

1. Post `STARTING` badges for the jobs it will run.
2. `checkpoint pull --changelist <n>` in the build workspace.
3. Build and test.
4. On success, `checkpoint artifact upload <n> --type <type>` for each type it produced.
5. Post the final badge states.

Uploading before posting `SUCCESS` means that by the time a changelist counts as good, its binaries are already there.
