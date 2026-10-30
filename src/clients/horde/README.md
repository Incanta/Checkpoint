# Checkpoint Horde Integration

Version control integration for Epic's [Unreal Horde](https://dev.epicgames.com/documentation/en-us/unreal-engine/horde-in-unreal-engine) build server: commit ingestion, build triggering, config-from-repo, and agent workspace sync backed by Checkpoint.

End-user setup docs live at `website/docusaurus/docs/integrations/horde.md`. This README covers development.

## Layout

- `src/Checkpoint.Api`: standalone C# client for the Checkpoint app server's tRPC + superjson API. No NuGet dependencies (it loads into the Horde server's assembly context, so any dependency could collide with server-shipped DLLs). Wire format reference: `src/clients/cli/daemon_client.hpp`.
- `src/HordeServer.Checkpoint`: the Horde server plugin. Registers an `IVersionControlService` named `Checkpoint` (streams opt in with `"vcs": "Checkpoint"`), an `IWorkspaceMessageEnricher` that stamps connection details onto agent workspace messages, the `checkpoint://` `IConfigSource`, and a hosted service that keeps the placeholder Perforce cluster healthy for job dispatch.
- `jobdriver`: sources and build script for the Checkpoint-extended JobDriver. Horde's agent-side materializers are compiled into the JobDriver (no plugin loading), so `build.ps1` patches the stock JobDriver source in the engine checkout in place (two anchored edits documented in `patches/`), injects `CheckpointWorkspaceMaterializer`, publishes, and restores the engine tree.
- `scripts`: `repack-agent.ps1` swaps the JobDriver folder inside a stock agent tool zip; `deploy-tool.ps1` uploads the result as a new agent tool deployment.
- `tests`: `Checkpoint.Api.Tests` are offline golden-fixture wire tests; `Checkpoint.Integration.Tests` run against a live dev server when `CHECKPOINT_TEST_ENDPOINT`/`CHECKPOINT_TEST_TOKEN` are set.

## Building

Requires an Unreal Engine checkout containing Horde source (Horde 5.8 era) and a .NET 10 SDK. If no system SDK is installed, the scripts fall back to the engine-bundled one at `Engine/Binaries/ThirdParty/DotNet/10.0`.

```powershell
$env:HORDE_ENGINE_DIR = "E:/epic/engine/UE_Incanta"
./build.ps1              # server plugin -> artifacts/server (2 DLLs)
./jobdriver/build.ps1    # patched JobDriver -> artifacts/jobdriver/JobDriver
```

To build everything in one step, drop the CD-built CLI zip at `artifacts/checkpoint-cli-win32-x64.zip` and run `./scripts/build-release.ps1 -EngineDir E:/epic/engine/UE_Incanta`. It cleans `artifacts/` (keeping `checkpoint-cli-*.zip`), runs both builds, and bundles the CLI into the JobDriver. Copy the two DLLs from `artifacts/server` to the Horde server, and run `repack-agent.ps1` (which reads `artifacts/jobdriver/JobDriver` directly) for agents. Add `-Package` to also produce the distributable release zip via `package-release.ps1`; its Horde version defaults to the engine's `Build.version` Major.Minor (override with `-HordeVersion`).

`Checkpoint.Api` builds standalone (no engine needed):

```powershell
dotnet build src/Checkpoint.Api/Checkpoint.Api.csproj
dotnet test tests/Checkpoint.Api.Tests/Checkpoint.Api.Tests.csproj
```

## Deploying to a Docker Horde server

The recommended path for a containerized (usually Linux) Horde server is to bind-mount the two plugin DLLs into the container. The assemblies are portable .NET, so building them on a Windows workstation is fine. Horde's image runs `dotnet HordeServer.dll` from `/app` and only scans that directory for `HordeServer.*.dll`, so mount each file individually into `/app`. Do not mount a directory over `/app`, which would hide the server itself.

Copy `artifacts/server/*.dll` to the host (for example with `scp` to `/opt/horde/plugins`), then mount them read-only:

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

Then enable the plugin in the server config and set `CHECKPOINT_API_TOKEN` in the container environment (see `website/docusaurus/docs/integrations/horde.md`), and recreate the container. The plugin binds Horde's assemblies exactly, so when you upgrade the Horde image, rebuild the DLLs against the matching engine checkout and replace the files on the host before restarting.

## Integration tests

Start a dev server at the repo root (`node dev.js`), create an org/repo with some submitted changelists, mint an API token, then:

```powershell
$env:CHECKPOINT_TEST_ENDPOINT = "http://localhost:13000"
$env:CHECKPOINT_TEST_TOKEN = "<api token>"
$env:CHECKPOINT_TEST_REPO_ID = "<repo id>"
dotnet test tests/Checkpoint.Integration.Tests/Checkpoint.Integration.Tests.csproj
```

## Versioning

`Version.g.cs` is generated from the repo-root `versions.json` by `scripts/set-version.js`. Release artifacts are built per supported Horde release (the plugin binds engine assemblies exactly): `checkpoint-horde-<clientVersion>_horde-<hordeVersion>.zip`.

## Horde version compatibility notes

Things to re-verify when moving to a new Horde release:

- The plugin scan pattern (`HordeServer.*.dll`) and `IPluginStartup`/`PluginAttribute` contracts.
- `IVersionControlService`/`ICommitCollection` signatures and `StreamConfig.VCS`/`RepositoryName`/`DefaultBranchName`.
- The `IWorkspaceMessageEnricher` hook in `JobTaskSource`.
- The BSON shape of the `perforce-server-list` singleton (used by `CheckpointClusterHealthService`); this is private to `PerforceLoadBalancer` and the highest-risk coupling.
- The two JobDriver patch anchors in `jobdriver/build.ps1` (`DriverApp.cs` DI registrations and `ConformExecutor.cs` workspace routing).
- Perforce-typed call sites that bypass the VCS abstraction (for example `JobService` chained jobs with `useDefaultChangeForTemplate`).
