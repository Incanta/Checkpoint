// Copyright Incanta Games. All Rights Reserved.

using System.Collections.Concurrent;
using Checkpoint.Api;
using Microsoft.Extensions.Options;

namespace HordeServer.VersionControl.Checkpoint
{
	/// <summary>
	/// Resolves Checkpoint cluster/connection configuration into API clients, and caches org/repo
	/// name to repo id lookups. Shared by the commit collections, config source, and enricher.
	/// </summary>
	public sealed class CheckpointConnectionService : IDisposable
	{
		readonly IOptions<CheckpointServerConfig> _serverConfig;
		readonly IOptionsMonitor<CheckpointConfig> _globalConfig;
		readonly HttpClient _httpClient;
		readonly ConcurrentDictionary<string, string> _repoIdCache = new ConcurrentDictionary<string, string>(StringComparer.OrdinalIgnoreCase);

		public CheckpointConnectionService(IOptions<CheckpointServerConfig> serverConfig, IOptionsMonitor<CheckpointConfig> globalConfig)
		{
			_serverConfig = serverConfig;
			_globalConfig = globalConfig;
			_httpClient = new HttpClient(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(15.0) }, disposeHandler: true);
		}

		/// <inheritdoc/>
		public void Dispose()
			=> _httpClient.Dispose();

		/// <summary>
		/// Gets the cluster profile for a Horde cluster name.
		/// </summary>
		public CheckpointClusterConfig GetCluster(string? clusterName)
			=> _globalConfig.CurrentValue.GetCluster(clusterName);

		/// <summary>
		/// Resolves the endpoint and token for a cluster and creates a client for it.
		/// </summary>
		public CheckpointClient CreateClient(string? clusterName)
		{
			CheckpointClusterConfig cluster = GetCluster(clusterName);
			return CreateClientForConnection(cluster.Connection, cluster.ServerUrl, cluster.Token);
		}

		/// <summary>
		/// Creates a client for a connection profile id (used by the config source, where URIs
		/// reference connections directly).
		/// </summary>
		public CheckpointClient CreateClientForConnection(string? connectionId, Uri? endpointOverride = null, string? tokenOverride = null)
		{
			CheckpointConnectionConfig connection = _serverConfig.Value.GetConnection(connectionId);

			CheckpointClientOptions options = new CheckpointClientOptions
			{
				Endpoint = endpointOverride ?? connection.ServerUrl,
				Token = !String.IsNullOrEmpty(tokenOverride) ? tokenOverride : connection.Token,
				TokenEnvVar = connection.TokenEnvVar,
			};
			return new CheckpointClient(_httpClient, options);
		}

		/// <summary>
		/// Resolved endpoint for a cluster, for stamping into agent workspace messages.
		/// </summary>
		public Uri GetEndpoint(string? clusterName)
		{
			CheckpointClusterConfig cluster = GetCluster(clusterName);
			CheckpointConnectionConfig connection = _serverConfig.Value.GetConnection(cluster.Connection);
			CheckpointClientOptions options = new CheckpointClientOptions { Endpoint = cluster.ServerUrl ?? connection.ServerUrl };
			return options.ResolveEndpoint();
		}

		/// <summary>
		/// Resolved token for a cluster, for stamping into agent workspace messages.
		/// </summary>
		public string? GetToken(string? clusterName)
		{
			CheckpointClusterConfig cluster = GetCluster(clusterName);
			CheckpointConnectionConfig connection = _serverConfig.Value.GetConnection(cluster.Connection);
			CheckpointClientOptions options = new CheckpointClientOptions
			{
				Token = !String.IsNullOrEmpty(cluster.Token) ? cluster.Token : connection.Token,
				TokenEnvVar = connection.TokenEnvVar,
			};
			return options.ResolveToken();
		}

		/// <summary>
		/// Service account name configured for a cluster's connection, if any.
		/// </summary>
		public string? GetServiceAccount(string? clusterName)
		{
			CheckpointClusterConfig cluster = GetCluster(clusterName);
			return _serverConfig.Value.GetConnection(cluster.Connection).ServiceAccount;
		}

		/// <summary>
		/// Resolves a repository name ("org/repo") to a Checkpoint repo id, with caching.
		/// </summary>
		public async ValueTask<string> GetRepoIdAsync(CheckpointClient client, string repositoryName, CancellationToken cancellationToken)
		{
			string cacheKey = $"{client.BaseUri}|{repositoryName}";
			if (_repoIdCache.TryGetValue(cacheKey, out string? repoId))
			{
				return repoId;
			}

			(string orgName, string repoName) = ParseRepositoryName(repositoryName);
			repoId = await client.ResolveRepoIdAsync(orgName, repoName, cancellationToken);
			if (repoId == null)
			{
				throw new InvalidOperationException($"Unable to resolve Checkpoint repository '{repositoryName}' on {client.BaseUri}. Check that the repository exists and the service account has access to it.");
			}

			_repoIdCache.TryAdd(cacheKey, repoId);
			return repoId;
		}

		/// <summary>
		/// Splits an "org/repo" repository name.
		/// </summary>
		public static (string OrgName, string RepoName) ParseRepositoryName(string repositoryName)
		{
			int slashIdx = repositoryName.IndexOf('/', StringComparison.Ordinal);
			if (slashIdx <= 0 || slashIdx >= repositoryName.Length - 1)
			{
				throw new InvalidOperationException($"Invalid Checkpoint repository name '{repositoryName}'. Expected the form 'orgName/repoName'.");
			}
			return (repositoryName[..slashIdx], repositoryName[(slashIdx + 1)..]);
		}
	}
}
