---
sidebar_position: 3
---

# Unreal Horde Integration

Checkpoint ships a version control plugin for [Unreal Horde](https://dev.epicgames.com/documentation/en-us/unreal-engine/horde-in-unreal-engine), Epic's build automation and CI platform. It gives Horde the same core capabilities its built-in Perforce integration provides: commit ingestion, build scheduling on new changelists, config files versioned in your repository, and agent workspace sync, all backed by a Checkpoint server.

The integration is distributed as prebuilt binaries targeted at a specific Horde release (for example Horde 5.8). You never need to recompile the Horde server.

## What you get

- **Commit ingestion and build triggering**: Horde streams can point at a Checkpoint repository and branch. Scheduled builds trigger on new changelists, and commits appear in the Horde dashboard with author, description, and code/content tags derived from file filters.
- **Config from your repo**: Horde config files (`globals.json`, `*.horde.json`) can live in a Checkpoint repository via the `checkpoint://` config source, matching the Perforce workflow.
- **Agent workspace sync**: build agents materialize working trees at the exact changelist of each job using the Checkpoint CLI, including clean/conform support.

Not yet supported: preflight builds (building shelved changes before submit), AutoSDK workspaces, and submitting changes from Horde (`submitNewChange` templates).

## Components

| Component | Deployed to | Purpose |
|---|---|---|
| `HordeServer.Checkpoint.dll` + `Checkpoint.Api.dll` | Horde server directory | Version control plugin (commits, scheduling, config source) |
| Checkpoint JobDriver | Horde agents (via the agent tool zip) | Workspace materialization on build agents |

The JobDriver piece exists because Horde's agent-side sync layer is compiled into the JobDriver process rather than loaded as a plugin. Checkpoint distributes a prebuilt JobDriver that is a strict superset of the stock one (Perforce workspaces keep working), and a repack script that injects it into the standard agent tool zip.

## Server installation

1. Copy `HordeServer.Checkpoint.dll` and `Checkpoint.Api.dll` from the release artifact into the Horde server's installation directory (next to `HordeServer.dll`). Horde discovers plugins by scanning for `HordeServer.*.dll`.

2. Create a Checkpoint service account and API token for Horde: sign in to your Checkpoint web app as a dedicated CI user, then mint a token under Settings, Devices. Give the user read access to the repositories Horde should build.

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

Set the `CHECKPOINT_API_TOKEN` environment variable for the Horde server process, or use `"Token"` to inline it. The server fails at startup with a clear error if the plugin is enabled but the DLL is missing, which doubles as an install smoke test.

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

`repositoryName` is the `orgName/repoName` pair from your Checkpoint server, and `defaultBranchName` selects the branch the stream tracks. `useAutoSdk` must be `false` for Checkpoint workspace types.

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

## Agent installation

Agents need the Checkpoint-extended JobDriver. The recommended path bakes it into the agent tool zip that Horde distributes:

```powershell
# 1. Build the Checkpoint JobDriver against your engine checkout (or use the prebuilt release artifact)
./jobdriver/build.ps1 -HordeEngineDir E:/epic/engine/UE_Custom -CheckpointCliDir path/to/checkpoint-cli

# 2. Repack the stock agent tool zip with it
./scripts/repack-agent.ps1 -AgentZip horde-agent-win-x64.zip

# 3. Upload as a new agent tool deployment; agents auto-upgrade
./scripts/deploy-tool.ps1 -Server https://horde.example.com -Zip horde-agent-win-x64-checkpoint.zip
```

Notes:

- Passing `-CheckpointCliDir` bundles the Checkpoint CLI (and daemon) inside the driver so agents need no separate Checkpoint install. Without it, install the Checkpoint CLI on each agent and ensure `checkpoint` is on the PATH (or set `CHECKPOINT_CLI`).
- Conform tasks run outside the normal job flow and do not receive credentials from the server, so set the `CHECKPOINT_API_TOKEN` environment variable for the agent service on each build machine.
- Any stock agent tool deployment (for example after a Horde server upgrade) replaces the patched JobDriver; re-run the repack against the new stock zip.
- Fallback without repacking: copy the Checkpoint JobDriver to `<agentDir>/CheckpointJobDriver` and set `"jobOptions": { "driver": "CheckpointJobDriver" }` on the stream. In this mode conform still uses the stock driver, so disable conform for those pools.

## Limitations

- **Preflights**: do not set `defaultPreflight` on Checkpoint streams; preflight jobs fail with a clear error. Checkpoint has shelves, so this is planned for a later release.
- **Chained jobs**: avoid `useDefaultChangeForTemplate` in chained job configurations; that code path is Perforce-specific in current Horde releases.
- **AutoSDK**: set `"useAutoSdk": false` on Checkpoint workspace types.
- The placeholder cluster health keeper writes to Horde's internal Perforce server list storage, which is a private schema; use the Checkpoint release matching your Horde version.

## Building from source

The integration lives at `src/clients/horde` in the Checkpoint repository. Building requires an Unreal Engine checkout containing Horde source and a .NET 10 SDK (the engine bundles one):

```powershell
$env:HORDE_ENGINE_DIR = "E:/epic/engine/UE_Custom"
./build.ps1              # server plugin -> artifacts/server
./jobdriver/build.ps1    # patched JobDriver -> artifacts/jobdriver
```

The JobDriver build patches two files in the engine's JobDriver source in place, publishes, and restores the originals; the applied changes are documented in `jobdriver/patches/`.
