// Copyright Incanta Games. All Rights Reserved.

using EpicGames.Horde.Jobs;
using HordeCommon.Rpc.Messages;
using HordeServer.Agents;
using HordeServer.Streams;
using HordeServer.VersionControl.Checkpoint;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace HordeServer.Jobs
{
	/// <summary>
	/// Stamps Checkpoint connection details onto workspace messages for jobs in Checkpoint streams.
	/// The agent-side materializer reads the Method query string (name/server/repo/branch) and uses
	/// Ticket as the API token. Non-Checkpoint streams are left untouched.
	/// </summary>
	public sealed class CheckpointWorkspaceEnricher : IWorkspaceMessageEnricher
	{
		/// <summary>
		/// Materializer name understood by the Checkpoint JobDriver extension.
		/// </summary>
		public const string MaterializerName = "Checkpoint";

		readonly CheckpointConnectionService _connections;
		readonly IOptionsMonitor<BuildConfig> _buildConfig;
		readonly ILogger<CheckpointWorkspaceEnricher> _logger;

		public CheckpointWorkspaceEnricher(CheckpointConnectionService connections, IOptionsMonitor<BuildConfig> buildConfig, ILogger<CheckpointWorkspaceEnricher> logger)
		{
			_connections = connections;
			_buildConfig = buildConfig;
			_logger = logger;
		}

		/// <inheritdoc/>
		public Task EnrichAsync(RpcAgentWorkspace workspace, AgentWorkspaceInfo workspaceInfo, IAgent agent, IJob job, CancellationToken cancellationToken)
		{
			StreamConfig? streamConfig;
			if (!_buildConfig.CurrentValue.TryGetStream(job.StreamId, out streamConfig))
			{
				return Task.CompletedTask;
			}
			if (!String.Equals(streamConfig.VCS, CheckpointVersionControlService.VcsName, StringComparison.OrdinalIgnoreCase))
			{
				return Task.CompletedTask;
			}

			// NOTE: JobTaskSource swallows enricher exceptions, so failures here must be loud in the
			// logs; a silently-unenriched workspace fails much later on the agent with less context.
			try
			{
				string repositoryName = streamConfig.RepositoryName ?? throw new InvalidOperationException($"Stream '{streamConfig.Id}' does not set 'repositoryName'");
				string branchName = String.IsNullOrEmpty(streamConfig.DefaultBranchName) ? "main" : streamConfig.DefaultBranchName;
				Uri endpoint = _connections.GetEndpoint(streamConfig.ClusterName);

				workspace.Method = BuildMethod(workspace.Method, endpoint, repositoryName, branchName);

				string? token = _connections.GetToken(streamConfig.ClusterName);
				if (!String.IsNullOrEmpty(token))
				{
					workspace.Ticket = token;
				}

				string? serviceAccount = _connections.GetServiceAccount(streamConfig.ClusterName);
				if (String.IsNullOrEmpty(workspace.UserName) && !String.IsNullOrEmpty(serviceAccount))
				{
					workspace.UserName = serviceAccount;
				}

				_logger.LogDebug("Enriched workspace {Identifier} for Checkpoint stream {StreamId} (repo: {Repo}, branch: {Branch})", workspace.Identifier, streamConfig.Id, repositoryName, branchName);
			}
			catch (Exception ex)
			{
				_logger.LogError(ex, "Failed to enrich workspace message for Checkpoint stream {StreamId}: {Message}. Jobs for this stream will not be able to sync.", streamConfig.Id, ex.Message);
				throw;
			}

			return Task.CompletedTask;
		}

		/// <summary>
		/// Builds the workspace Method query string, preserving parameters the stream config already
		/// set explicitly (WorkspaceConfig.Method flows through to the base message).
		/// </summary>
		static string BuildMethod(string? existingMethod, Uri endpoint, string repositoryName, string branchName)
		{
			Dictionary<string, string> parameters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
			if (!String.IsNullOrEmpty(existingMethod))
			{
				foreach (string pair in existingMethod.Split('&', StringSplitOptions.RemoveEmptyEntries))
				{
					int eqIdx = pair.IndexOf('=', StringComparison.Ordinal);
					if (eqIdx > 0)
					{
						parameters[Uri.UnescapeDataString(pair[..eqIdx])] = Uri.UnescapeDataString(pair[(eqIdx + 1)..]);
					}
				}
			}

			parameters["name"] = MaterializerName;
			parameters.TryAdd("server", endpoint.ToString());
			parameters.TryAdd("repo", repositoryName);
			parameters.TryAdd("branch", branchName);

			return String.Join('&', parameters.Select(x => $"{Uri.EscapeDataString(x.Key)}={Uri.EscapeDataString(x.Value)}"));
		}
	}
}
