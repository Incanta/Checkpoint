// Copyright Incanta Games. All Rights Reserved.

using System.Text.Json;
using System.Web;
using EpicGames.Core;
using HordeCommon.Rpc.Messages;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace JobDriver.Execution;

/// <summary>
/// Workspace materializer for the Checkpoint version control system. Shells out to the Checkpoint
/// CLI in headless mode (ephemeral daemon) to materialize a working tree at a specific changelist.
///
/// Connection details arrive in the RpcAgentWorkspace stamped by the HordeServer.Checkpoint plugin:
///   Method = "name=Checkpoint&amp;server=&lt;endpoint&gt;&amp;repo=&lt;org/repo&gt;&amp;branch=&lt;branch&gt;[&amp;cli=&lt;path&gt;]"
///   Ticket = Checkpoint API token (falls back to the agent's CHECKPOINT_API_TOKEN env var, which
///   is also the only token source for conform tasks since those bypass the server-side enricher)
/// </summary>
public sealed class CheckpointWorkspaceMaterializer : IWorkspaceMaterializer
{
	/// <summary>
	/// Name of this materializer (selected via the workspace Method query string)
	/// </summary>
	public const string TypeName = "Checkpoint";

	readonly RpcAgentWorkspace _agentWorkspace;
	readonly ILogger _logger;

	readonly string _serverUrl;
	readonly string _repositoryName;
	readonly string _branchName;
	readonly string _token;
	readonly CheckpointCli _cli;

	/// <inheritdoc/>
	public string Name => TypeName;

	/// <inheritdoc/>
	public DirectoryReference BaseDir { get; }

	/// <inheritdoc/>
	public DirectoryReference SyncDir { get; }

	/// <inheritdoc/>
	public string Identifier => _agentWorkspace.Identifier;

	/// <inheritdoc/>
	public IReadOnlyDictionary<string, string> EnvironmentVariables { get; }

	/// <inheritdoc/>
	public bool IsPerforceWorkspace => false;

	/// <summary>
	/// Constructor
	/// </summary>
	public CheckpointWorkspaceMaterializer(RpcAgentWorkspace agentWorkspace, DirectoryReference workingDir, ILogger logger)
	{
		_agentWorkspace = agentWorkspace;
		_logger = logger;

		System.Collections.Specialized.NameValueCollection parameters = HttpUtility.ParseQueryString(agentWorkspace.Method ?? String.Empty);
		_serverUrl = GetRequiredParameter(parameters, "server", agentWorkspace);
		_repositoryName = GetRequiredParameter(parameters, "repo", agentWorkspace);
		_branchName = parameters["branch"] ?? "main";

		_token = !String.IsNullOrEmpty(agentWorkspace.Ticket) ? agentWorkspace.Ticket : (Environment.GetEnvironmentVariable("CHECKPOINT_API_TOKEN") ?? String.Empty);

		BaseDir = DirectoryReference.Combine(workingDir, agentWorkspace.Identifier);
		SyncDir = DirectoryReference.Combine(BaseDir, "Sync");

		Dictionary<string, string> cliEnvironment = new Dictionary<string, string>
		{
			["CHECKPOINT_ENDPOINT"] = _serverUrl,
			["CHECKPOINT_API_TOKEN"] = _token,
			// Force the workspace-scoped ephemeral daemon so builds never depend on (or interfere
			// with) a resident desktop daemon on the agent
			["CHECKPOINT_DAEMONLESS"] = "1",
		};

		string? bundledDaemonDir = CheckpointCli.ResolveBundledDaemonDir();
		if (bundledDaemonDir != null)
		{
			cliEnvironment["CHECKPOINT_DAEMON_BIN"] = bundledDaemonDir;
		}

		_cli = new CheckpointCli(CheckpointCli.ResolveCliPath(parameters["cli"]), cliEnvironment, new[] { _token }, logger);

		// Environment for job steps executing inside the workspace
		EnvironmentVariables = new Dictionary<string, string>
		{
			["CHECKPOINT_ENDPOINT"] = _serverUrl,
			["CHECKPOINT_REPO"] = _repositoryName,
			["CHECKPOINT_BRANCH"] = _branchName,
		};
	}

	static string GetRequiredParameter(System.Collections.Specialized.NameValueCollection parameters, string name, RpcAgentWorkspace workspace)
	{
		string? value = parameters[name];
		if (String.IsNullOrEmpty(value))
		{
			throw new WorkspaceMaterializationException(
				$"Checkpoint workspace '{workspace.Identifier}' is missing the '{name}' parameter in its Method string ('{workspace.Method}'). " +
				"For job workspaces this is stamped by the HordeServer.Checkpoint plugin (check the server logs for enricher errors); " +
				"for conform-only setups, set it explicitly in the stream's workspace 'method' property.");
		}
		return value;
	}

	/// <inheritdoc/>
	public void Dispose()
	{
	}

	/// <inheritdoc/>
	public ILogger GetLogger(ILogger logger) => logger;

	/// <inheritdoc/>
	public async Task SyncAsync(int changeNum, int shelveChangeNum, SyncOptions options, CancellationToken cancellationToken)
	{
		if (shelveChangeNum > 0)
		{
			throw new WorkspaceMaterializationException("Preflight builds (shelved changes) are not supported by the Checkpoint integration yet. Do not set a preflight change for Checkpoint streams.");
		}

		DirectoryReference.CreateDirectory(SyncDir);

		if (options.FakeSync)
		{
			_logger.LogInformation("Fake sync requested for Checkpoint workspace {Identifier}; skipping materialization", Identifier);
			return;
		}

		await EnsureWorkspaceAsync(cancellationToken);

		if (options.RemoveUntracked)
		{
			await _cli.RunAsync(SyncDir, new[] { "clean", "--yes", "--no-progress" }, cancellationToken);
		}

		List<string> pullArgs = new List<string> { "pull", "--no-progress" };
		if (changeNum != IWorkspaceMaterializer.LatestChangeNumber)
		{
			pullArgs.Add("--changelist");
			pullArgs.Add(changeNum.ToString());
		}
		await _cli.RunAsync(SyncDir, pullArgs, cancellationToken);

		_logger.LogInformation("Checkpoint workspace {Identifier} synced to {Change}", Identifier, changeNum == IWorkspaceMaterializer.LatestChangeNumber ? "head" : $"CL {changeNum}");
	}

	/// <inheritdoc/>
	public Task FinalizeAsync(CancellationToken cancellationToken)
	{
		// The workspace is left in place for incremental reuse; conform handles cleanup
		return Task.CompletedTask;
	}

	/// <inheritdoc/>
	public async Task ConformAsync(bool removeUntrackedFiles, CancellationToken cancellationToken)
	{
		DirectoryReference.CreateDirectory(SyncDir);
		await EnsureWorkspaceAsync(cancellationToken);

		if (removeUntrackedFiles)
		{
			await _cli.RunAsync(SyncDir, new[] { "clean", "--yes", "--no-progress" }, cancellationToken);
		}
		await _cli.RunAsync(SyncDir, new[] { "pull", "--no-progress" }, cancellationToken);
	}

	/// <summary>
	/// Logs in (idempotent) and initializes the Checkpoint workspace in SyncDir when missing, and
	/// switches branches when the stream's branch differs from the existing workspace.
	/// </summary>
	async Task EnsureWorkspaceAsync(CancellationToken cancellationToken)
	{
		if (String.IsNullOrEmpty(_token))
		{
			throw new WorkspaceMaterializationException(
				$"No Checkpoint API token available for workspace '{Identifier}'. The server-side enricher stamps job workspaces with a token; " +
				"conform tasks require the CHECKPOINT_API_TOKEN environment variable to be set for the agent service.");
		}

		FileReference workspaceConfigFile = FileReference.Combine(SyncDir, ".checkpoint", "workspace.json");
		if (!FileReference.Exists(workspaceConfigFile))
		{
			// Register the credential with the (ephemeral) daemon. A stable id keeps repeated
			// logins from accumulating duplicate accounts.
			await _cli.RunAsync(SyncDir, new[] { "login", "--endpoint", _serverUrl, "--token", _token, "--id", "horde-agent" }, cancellationToken);

			List<string> initArgs = new List<string> { "init", _repositoryName, "--branch", _branchName };
			if (!String.IsNullOrEmpty(_agentWorkspace.UserName))
			{
				initArgs.Add("--account");
				initArgs.Add(_agentWorkspace.UserName);
			}
			await _cli.RunAsync(SyncDir, initArgs, cancellationToken);
			return;
		}

		// Existing workspace: switch branches if the stream config changed
		try
		{
			using FileStream stream = FileReference.Open(workspaceConfigFile, FileMode.Open, FileAccess.Read, FileShare.Read);
			using JsonDocument document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
			if (document.RootElement.TryGetProperty("branchName", out JsonElement branchElement))
			{
				string? currentBranch = branchElement.GetString();
				if (currentBranch != null && !String.Equals(currentBranch, _branchName, StringComparison.Ordinal))
				{
					_logger.LogInformation("Switching Checkpoint workspace {Identifier} from branch {OldBranch} to {NewBranch}", Identifier, currentBranch, _branchName);
					await _cli.RunAsync(SyncDir, new[] { "switch", _branchName }, cancellationToken);
				}
			}
		}
		catch (Exception ex) when (ex is IOException or JsonException)
		{
			_logger.LogWarning(ex, "Unable to read Checkpoint workspace config at {File}; continuing without branch check", workspaceConfigFile);
		}
	}
}

/// <summary>
/// Factory for <see cref="CheckpointWorkspaceMaterializer"/>
/// </summary>
class CheckpointMaterializerFactory : IWorkspaceMaterializerFactory
{
	readonly IServiceProvider _serviceProvider;

	public CheckpointMaterializerFactory(IServiceProvider serviceProvider) => _serviceProvider = serviceProvider;

	/// <inheritdoc/>
	public Task<IWorkspaceMaterializer?> CreateMaterializerAsync(string name, RpcAgentWorkspace workspaceInfo, DirectoryReference workingDir, bool forAutoSdk, CancellationToken cancellationToken)
	{
		if (!name.Equals(CheckpointWorkspaceMaterializer.TypeName, StringComparison.OrdinalIgnoreCase))
		{
			return Task.FromResult<IWorkspaceMaterializer?>(null);
		}
		if (forAutoSdk)
		{
			throw new WorkspaceMaterializationException("AutoSDK workspaces are not supported by the Checkpoint materializer. Set \"useAutoSdk\": false on the stream's agent workspace types.");
		}

		ILogger<CheckpointWorkspaceMaterializer> logger = _serviceProvider.GetRequiredService<ILogger<CheckpointWorkspaceMaterializer>>();
		return Task.FromResult<IWorkspaceMaterializer?>(new CheckpointWorkspaceMaterializer(workspaceInfo, workingDir, logger));
	}
}
