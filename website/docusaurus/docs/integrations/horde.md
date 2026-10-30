---
sidebar_position: 1
slug: /horde
---

# Unreal Horde Integration

Checkpoint ships a version control plugin for [Unreal Horde](https://dev.epicgames.com/documentation/en-us/unreal-engine/horde-in-unreal-engine), Epic's build automation and CI platform. It gives Horde the same core capabilities its built-in Perforce integration provides: commit ingestion, build scheduling on new changelists, config files versioned in your repository, and agent workspace sync, all backed by a Checkpoint server.

The plugin binds to Horde's assemblies exactly, so each build targets one Horde release (for example Horde 5.8). You never need to recompile the Horde server itself.

## What you get

- **Commit ingestion and build triggering**: Horde streams can point at a Checkpoint repository and branch. Scheduled builds trigger on new changelists, and commits appear in the Horde dashboard with author, description, and code/content tags derived from file filters.
- **Config from your repo**: Horde config files (`globals.json`, `*.horde.json`) can live in a Checkpoint repository via the `checkpoint://` config source, matching the Perforce workflow.
- **Agent workspace sync**: build agents materialize working trees at the exact changelist of each job using the Checkpoint CLI, including clean/conform support and [linked repos](../guides/linked-repos.md).

Not yet supported: preflight builds (building shelved changes before submit), AutoSDK workspaces, and submitting changes from Horde (`submitNewChange` templates).

## Components

| Component | Deployed to | Purpose |
|---|---|---|
| `HordeServer.Checkpoint.dll` + `Checkpoint.Api.dll` | Horde server directory | Version control plugin (commits, scheduling, config source) |
| Checkpoint JobDriver | Horde agents (via the agent tool zip) | Workspace materialization on build agents |

The JobDriver piece exists because Horde's agent-side sync layer is compiled into the JobDriver process rather than loaded as a plugin. Checkpoint's JobDriver is a strict superset of the stock one (Perforce workspaces keep working), and a repack script injects it into the standard agent tool zip.

A release zip is named `checkpoint-horde-<checkpointVersion>_horde-<hordeVersion>.zip` and contains `server/` (the two plugin DLLs), `JobDriver/` (the Checkpoint JobDriver with the Checkpoint CLI bundled), `scripts/` (`repack-agent.ps1` and `deploy-tool.ps1`), and a README. To build these yourself, see [Building from source](#building-from-source).

## Server installation

1. Copy `HordeServer.Checkpoint.dll` and `Checkpoint.Api.dll` into the Horde server's installation directory (next to `HordeServer.dll`). Horde discovers plugins by scanning for `HordeServer.*.dll`. For a containerized server, see [Docker deployments](#docker-deployments).

2. Create a Checkpoint service account and API token for Horde. Create a dedicated CI user and give it read access to the repositories Horde should build. Sign in to the Checkpoint web app as that user, open **Devices & Tokens** from the user menu, enter a token name, leave **Device Code** empty, and click **Create Token**. Copy the token; it is only shown once.

3. Enable and configure the plugin in the server's `server.json` (or `appsettings.json`):

```json
{
  "Horde": {
    "Plugins": {
      "Checkpoint": {
        "Enabled": true,
        "Connections": [
          {
            "Id": "default",
            "ServerUrl": "https://checkpoint.example.com",
            "TokenEnvVar": "CHECKPOINT_API_TOKEN"
          }
        ]
      }
    }
  }
}
```

Set the `CHECKPOINT_API_TOKEN` environment variable for the Horde server process, or use `"Token"` to inline it.

Connection fields:

| Field | Default | Description |
|---|---|---|
| `Id` | `default` | Name used by cluster configs and `checkpoint://` URIs. |
| `ServerUrl` | `CHECKPOINT_ENDPOINT` env var | Base URL of the Checkpoint web app. |
| `Token` | none | API token. Prefer `TokenEnvVar` to keep secrets out of config files. |
| `TokenEnvVar` | `CHECKPOINT_API_TOKEN` | Environment variable to read the token from when `Token` is unset. |
| `ServiceAccount` | none | Service account name reported to agents (informational). |

With no `Connections` at all, the plugin uses a `default` connection built from the `CHECKPOINT_ENDPOINT` and `CHECKPOINT_API_TOKEN` environment variables.

4. Define a placeholder Perforce cluster for Checkpoint streams in `globals.json`. Horde's job dispatch requires every stream's cluster to resolve, so Checkpoint streams reference a placeholder that the plugin keeps marked healthy:

```json
{
  "plugins": {
    "build": {
      "perforceClusters": [
        {
          "name": "Checkpoint",
          "servers": [{ "serverAndPort": "127.0.0.1:1", "resolveDns": false, "healthCheck": false }]
        }
      ]
    },
    "checkpoint": {
      "clusters": [
        { "name": "Checkpoint", "connection": "default", "pollIntervalSeconds": 15 }
      ]
    }
  }
}
```

Cluster fields under `plugins.checkpoint.clusters`:

| Field | Default | Description |
|---|---|---|
| `name` | `Checkpoint` | Matched against a stream's `clusterName` and the placeholder Perforce cluster. |
| `connection` | `default` | Connection profile from the server config. |
| `serverUrl` | from the connection | Optional endpoint override for this cluster. |
| `token` | from the connection | Optional token override. Can reference a secret with `horde:secret://`. |
| `pollIntervalSeconds` | `15` | How often to poll for new changelists. |
| `maxCommitsPerPoll` | `1000` | Most changelists fetched in one catch-up. A stream further behind skips older changelists. |

5. Configure a stream to use Checkpoint. In the stream's config (`*.horde.json`):

```json
{
  "vcs": "Checkpoint",
  "repositoryName": "myOrg/myRepo",
  "defaultBranchName": "main",
  "clusterName": "Checkpoint",
  "agentTypes": {
    "Win64": {
      "pool": "win-ue5",
      "workspace": "Default"
    }
  },
  "workspaceTypes": {
    "Default": {
      "useAutoSdk": false
    }
  }
}
```

`repositoryName` is the `orgName/repoName` pair from your Checkpoint server, and `defaultBranchName` selects the branch the stream tracks (`main` if omitted). `useAutoSdk` must be `false` for Checkpoint workspace types.

### Config files in your repository

To source Horde config from Checkpoint instead of local disk, point the server's `ConfigPath` at a `checkpoint://` URI:

```json
{
  "Horde": {
    "ConfigPath": "checkpoint://default/myOrg/myRepo/main/horde/globals.json"
  }
}
```

The URI format is `checkpoint://<connectionId>/<orgName>/<repoName>/<branchName>/<path/to/file.json>`. Relative includes inside config files resolve against the same scheme. Branch names containing `/` are not supported in config URIs.

### Docker deployments

For a containerized (usually Linux) Horde server, bind-mount the two plugin DLLs into the container. The assemblies are portable .NET, so building them on a Windows workstation is fine. Horde's image runs `dotnet HordeServer.dll` from `/app` and only scans that directory for `HordeServer.*.dll`, so mount each file individually into `/app`. Don't mount a directory over `/app`, which would hide the server itself.

Copy the DLLs to the host (for example to `/opt/horde/plugins`), then mount them read-only:

```yaml
# docker-compose.yml
services:
  horde-server:
    volumes:
      - /opt/horde/plugins/HordeServer.Checkpoint.dll:/app/HordeServer.Checkpoint.dll:ro
      - /opt/horde/plugins/Checkpoint.Api.dll:/app/Checkpoint.Api.dll:ro
```

or with `docker run`:

```sh
docker run ... \
  -v /opt/horde/plugins/HordeServer.Checkpoint.dll:/app/HordeServer.Checkpoint.dll:ro \
  -v /opt/horde/plugins/Checkpoint.Api.dll:/app/Checkpoint.Api.dll:ro \
  <horde-server-image>
```

Then enable the plugin in the server config, set `CHECKPOINT_API_TOKEN` in the container environment, and recreate the container. When you upgrade the Horde image, replace the DLLs with ones built for the matching Horde version before restarting.

## Agent installation

Agents need the Checkpoint JobDriver. The recommended path bakes it into the agent tool zip that Horde distributes. Download the stock agent tool zip from your Horde server's tools page (for example tool id `horde-agent-win-x64`), then:

```powershell
# 1. Repack the stock agent tool zip with the Checkpoint JobDriver.
#    From an unpacked release zip, point -JobDriverDir at its JobDriver folder.
#    From a source build, the default (artifacts/jobdriver/JobDriver) is used.
./scripts/repack-agent.ps1 -AgentZip horde-agent-win-x64.zip -JobDriverDir ./JobDriver

# 2. Upload it as a new agent tool deployment; agents pick it up through their normal upgrade
./scripts/deploy-tool.ps1 -Server https://horde.example.com -Zip horde-agent-win-x64-checkpoint.zip
```

`deploy-tool.ps1` needs a Horde bearer token with tool upload permission, passed as `-Token` or in the `HORDE_TOKEN` environment variable. It deploys to `horde-agent-win-x64` unless you pass `-ToolId`, and `-Duration` (for example `00:30:00`) rolls the deployment out gradually.

Notes:

- The release JobDriver bundles the Checkpoint CLI (and its daemon), so agents need no separate Checkpoint install. A JobDriver built without the CLI looks for `checkpoint` in the `CHECKPOINT_CLI` environment variable, then on the `PATH`.
- Job workspaces get the Checkpoint token from the server. Conform tasks run outside the normal job flow and don't, so set the `CHECKPOINT_API_TOKEN` environment variable for the agent service on each build machine.
- Any stock agent tool deployment (for example after a Horde server upgrade) replaces the Checkpoint JobDriver; re-run the repack against the new stock zip.
- Fallback without repacking: copy the Checkpoint JobDriver to `<agentDir>/CheckpointJobDriver` and set `"jobOptions": { "driver": "CheckpointJobDriver" }` on the stream. In this mode conform still uses the stock driver, so disable conform for those pools.

### What agents do

For each job, the agent keeps a Checkpoint workspace in the job's `Sync` folder and reuses it between jobs:

- The first time, it logs in with the token and runs `checkpoint init` for the stream's repository and branch. If the stream's branch changes later, it switches the workspace to the new branch.
- It runs `checkpoint pull` to the job's changelist, after `checkpoint clean` when Horde asks to remove untracked files.
- The CLI always runs without a resident daemon on agents, so builds never depend on (or interfere with) a desktop install on the same machine.
- `checkpoint pull` follows the repository's [linked repos](../guides/linked-repos.md): nested links are created and synced automatically. Anywhere-on-disk links (such as a shared engine) need their workspace set up on the agent first, or the pull warns and builds without them.

Job steps run with `CHECKPOINT_ENDPOINT`, `CHECKPOINT_REPO` (`org/repo`), and `CHECKPOINT_BRANCH` set in their environment. The API token is not passed to job steps.

## Limitations

- **Preflights**: do not set `defaultPreflight` on Checkpoint streams; preflight jobs fail with a clear error. Checkpoint has shelves, so this is planned for a later release.
- **Chained jobs**: avoid `useDefaultChangeForTemplate` in chained job configurations; that code path is Perforce-specific in current Horde releases.
- **AutoSDK**: set `"useAutoSdk": false` on Checkpoint workspace types.
- The placeholder cluster health keeper writes to Horde's internal Perforce server list storage, which is a private schema; use the Checkpoint plugin built for your Horde version.

## Building from source

The integration lives at `src/clients/horde` in the Checkpoint repository. Building needs an Unreal Engine checkout containing Horde source and a .NET 10 SDK. If no .NET 10 SDK is installed, the scripts use the one bundled with the engine.

**One step (Windows):** download the Checkpoint CLI zip for your agents' platform (for example `checkpoint-cli-win32-x64.zip`) into `artifacts/`, then run:

```powershell
./scripts/build-release.ps1 -EngineDir E:/epic/engine/UE_Custom
```

It cleans `artifacts/` (keeping `checkpoint-cli-*.zip`), builds the server plugin into `artifacts/server`, and builds the JobDriver with the CLI bundled into `artifacts/jobdriver/JobDriver`, which `repack-agent.ps1` uses by default. Options:

- `-CliZip <path>`: use a CLI zip from somewhere else. Its platform must match the build agents, not the machine running the script.
- `-Package`: also produce the release zip. Its Horde version comes from the engine's `Engine/Build/Build.version` unless you pass `-HordeVersion`.

**Piece by piece:**

```powershell
$env:HORDE_ENGINE_DIR = "E:/epic/engine/UE_Custom"
./build.ps1                                                  # server plugin -> artifacts/server
./jobdriver/build.ps1 -CheckpointCliDir path/to/checkpoint-cli  # JobDriver -> artifacts/jobdriver/JobDriver
```

`build.sh` builds the server plugin on Linux or macOS the same way (set `HORDE_ENGINE_DIR`). The JobDriver build is PowerShell only.

The JobDriver build patches two files in the engine's JobDriver source in place, publishes, and restores the originals, leaving the engine tree untouched. The applied changes are documented in `jobdriver/patches/`. If the build reports that a patch anchor wasn't found, the Horde version has changed in a way the plugin doesn't support yet.
