# Checkpoint Horde Integration

Version control integration for Epic's [Unreal Horde](https://dev.epicgames.com/documentation/en-us/unreal-engine/horde-in-unreal-engine) build server: commit ingestion, build triggering, config-from-repo, and agent workspace sync backed by Checkpoint.

End-user setup docs live at `website/docusaurus/docs/horde.md`. This README covers development.

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

`Checkpoint.Api` builds standalone (no engine needed):

```powershell
dotnet build src/Checkpoint.Api/Checkpoint.Api.csproj
dotnet test tests/Checkpoint.Api.Tests/Checkpoint.Api.Tests.csproj
```

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
